#!/usr/bin/env python3
"""
Consulta a API pública do PNCP e lista pregões eletrônicos com propostas
abertas cujo objeto contenha algum dos termos de termos.txt (implementos
rodoviários: tanques, coletores, caçambas, poliguindastes, plataformas etc.).

Descarta o que é compra do caminhão junto com o implemento: os itens de cada
pregão são conferidos um a um e o pregão só entra se tiver ao menos um item
que seja só o implemento (ex.: lote de "caçamba basculante para caminhão").

Endpoint: GET https://pncp.gov.br/api/consulta/v1/contratacoes/proposta
Manual:   https://pncp.gov.br/api/consulta/swagger-ui/index.html

Uso:
    python pncp_implementos.py                  # próximos 60 dias, todo o Brasil
    python pncp_implementos.py --uf MG --dias 30
    python pncp_implementos.py --csv resultado.csv
    python pncp_implementos.py --termos outro_arquivo.txt
    python pncp_implementos.py --incluir-caminhao   # não descarta caminhão + implemento
"""

import argparse
import csv
import http.client
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

API_URL = "https://pncp.gov.br/api/consulta/v1/contratacoes/proposta"
API_ITENS = "https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens"
# Busca do site do PNCP: procura também no texto dos itens. Acha os editais de objeto
# genérico ("aquisição de caminhões", "material de limpeza") em que o implemento ou o
# container só aparece nos itens.
API_BUSCA = "https://pncp.gov.br/api/search/"
TERMOS_BUSCA_SITE = [
    "basculante", "pipa", "poliguindaste", "prancha", "carroceria", "baú", "semirreboque",
    "semi-reboque", "implemento", "munck", "cesto aéreo", "coletor compactador",
    "comboio", "melosa", "auto socorro", "cesta aérea", "cesto elevatório",
    "plataforma aérea", "lança elevatória", "linha viva", "container", "contêiner", "conteiner",
    "contentor", "hidrojato", "limpa fossa", "isotérmico", "rodotrem", "graneleiro"]
# Modalidades consultadas (código PNCP): pregão, concorrência e dispensa.
MODALIDADES = {6: "Pregão eletrônico", 7: "Pregão presencial", 4: "Concorrência eletrônica",
               5: "Concorrência presencial", 8: "Dispensa"}
MODALIDADES_PADRAO = "6,7,4,5,8"
TAMANHO_PAGINA = 50  # máximo aceito pela API

# Arquivo com os termos procurados no objeto, agrupados por categoria.
ARQUIVO_TERMOS = Path(__file__).with_name("termos.txt")
# Termos de obras / estruturas (galpão, terraplenagem, pavimentação...), com abas próprias.
ARQUIVO_TERMOS_OBRAS = Path(__file__).with_name("termos_obras.txt")
CATEGORIA_EXTRA = "TERMO EXTRA"
# categorias de termos.txt que começam assim vão para a aba "Containers" (--xlsx)
CATEGORIA_CONTAINER = "CONTAINER"

# Entre as palavras de um termo aceita-se uma destas preposições (ou nenhuma):
# "tanque de água" casa "tanque para água", "tanque d'água" e "tanque água";
# "tipo" também: "reboque prancha" casa "reboque tipo prancha".
PREPOSICOES = ["de", "do", "da", "dos", "das", "d", "a", "em", "no", "na",
               "nos", "nas", "sobre", "para", "p", "tipo"]

RE_CATEGORIA = re.compile(r"^=+\s*CATEGORIA\s*:\s*(.+?)\s*=*$", re.IGNORECASE)


def normalizar(texto):
    """Minúsculas, sem acentos e pontuação vira espaço: "Tanque-D'Água" -> "tanque d agua"."""
    sem_acento = unicodedata.normalize("NFKD", texto or "")
    sem_acento = "".join(c for c in sem_acento if not unicodedata.combining(c)).lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", sem_acento).split())


# prefixos que valem só como palavra inteira: "semi reboque" não casa "semirrígido, reboque"
PALAVRAS_EXATAS = {"semi"}


def palavra_para_regex(palavra):
    """Aceita plural e sufixos: caminhao -> caminhoes, combustivel -> combustiveis."""
    if palavra in PALAVRAS_EXATAS:
        return re.escape(palavra) + r"\b"
    if palavra.endswith("ao"):
        raiz = re.escape(palavra[:-2]) + "(?:ao|oes|aes)"
    elif len(palavra) > 3 and palavra[-1] == "l" and palavra[-2] in "aeiou":
        raiz = re.escape(palavra[:-1]) + "(?:l|is)"
    else:
        raiz = re.escape(palavra)
    return raiz + r"\w*"


def termo_para_regex(termo):
    """'tanque vacuo' casa com 'Tanques de Vácuo', 'tanque-vácuo' etc."""
    palavras = normalizar(termo).split()
    # preposições do termo viram opcionais ("em chassi" casa "no chassi")
    palavras = [p for p in palavras if p not in PREPOSICOES] or palavras
    # até duas: "carroceria do tipo sider" casa "carroceria sider"
    sep = r"\s+(?:(?:" + "|".join(PREPOSICOES) + r")\s+){0,2}"
    return re.compile(r"\b" + sep.join(palavra_para_regex(p) for p in palavras))


def carregar_termos(caminho):
    """Lê termos.txt -> lista de (categoria, termo, regex)."""
    termos, vistos = [], set()
    categoria = "SEM CATEGORIA"
    with open(caminho, encoding="utf-8") as f:
        for linha in f:
            linha = linha.strip()
            if not linha or linha.startswith("#"):
                continue
            m = RE_CATEGORIA.match(linha)
            if m:
                categoria = m.group(1)
                continue
            chave = (categoria, normalizar(linha))
            if chave not in vistos:  # "roll-on roll-off" == "roll on roll off"
                vistos.add(chave)
                termos.append((categoria, linha, termo_para_regex(linha)))
    if not termos:
        raise SystemExit(f"Nenhum termo encontrado em {caminho}")
    return termos


# O termo não conta quando vem logo depois de uma palavra de serviço, locação,
# manutenção ou peças: "locação de caminhão pipa", "manutenção de roçadeiras",
# "peças para implementos agrícolas", "Aplicação: Roçadeira" (peça no CATMAT).
# Olha as JANELA palavras antes do termo, da mais próxima para a mais distante;
# uma palavra de compra ("aquisição de roçadeiras") encerra a busca.
NAO_E_COMPRA = {
    "locacao", "locacoes", "aluguel", "servico", "servicos", "prestacao", "prestados",
    "manutencao", "manutencoes", "reparo", "reparos", "conserto", "consertos", "revisao",
    "reforma", "reformas",
    "peca", "pecas", "componente", "componentes", "acessorio", "acessorios",
    "lubrificante", "lubrificantes", "graxa", "exposicao", "concessao",
    "aplicacao", "pneu", "pneus", "camara", "camaras", "combustivel", "combustiveis",
    "oleo", "oleos", "filtro", "filtros", "bateria", "baterias",
    "placa", "placas", "emplacamento", "licenciamento", "fretamento", "frete",
    "adesivo", "adesivos", "etiqueta", "etiquetas",
    "treinamento", "treinamentos", "curso", "cursos", "capacitacao",
    "desinfeccao", "higienizacao", "desengorduramento", "seguro", "seguros", "apolice", "apolices",
}
COMPRA = {"aquisicao", "aquisicoes", "compra", "compras", "adquirir"}
JANELA = 20


# Termo que é o próprio caminhão ("caminhão pipa") ou genérico ("implementos
# rodoviários") depois de "para"/"no"/"dos" é destino de outra coisa:
# "mangueiras PARA caminhão-pipa", "chave de roda PARA implementos rodoviários".
ANTES_DE_CAMINHAO_DESTINO = {"para", "p", "em", "no", "na", "nos", "nas", "sobre",
                             "a", "ao", "aos", "por"}
ANTES_DE_GENERICO_DESTINO = ANTES_DE_CAMINHAO_DESTINO | {"dos", "das", "do", "da"}
LUGAR_DE_CONTAINER = {"area", "areas", "patio", "patios", "terminal", "terminais", "deposito"}
RE_TERMO_GENERICO = re.compile(r"(?:implementos?|containers?|conteiner(?:es)?|contentor(?:es)?)\b")


FORNECE = {"fornecer", "fornecimento", "fornecidos", "fornecidas"}
RE_SERVICO_COM = re.compile(
    r"\b(?:prestacao de )?servicos? (?:com|de locacao)\b"
    # "contratação de empresa para limpeza de bocas de lobo através de caminhão com
    # equipamento hidrojato": contrata o serviço (não "para fornecimento/aquisição")
    r"|\bcontratacao de empresa (?:especializada )?(?:para|em|na|no) (?:a |o )?"
    r"(?!aquisic|fornec|compra|entrega)\w+")


def ocorrencia_de_compra(texto_normalizado, inicio):
    """False se o termo que começa em `inicio` é objeto de serviço/peça, não de compra."""
    antes = texto_normalizado[:inicio].split()
    sem_artigo = [p for p in antes[-3:] if p not in ARTIGOS]
    if sem_artigo and sem_artigo[-1] in ANTES_DE_CAMINHAO_DESTINO and RE_VEICULO.match(
            texto_normalizado, inicio):
        return False
    if RE_TERMO_GENERICO.match(texto_normalizado, inicio) and antes and (
            antes[-1] in ANTES_DE_GENERICO_DESTINO
            or ({"para", "p"} & set(antes[-3:]) and not COMPRA & set(antes[-3:]))):
        return False  # "... para caminhões e implementos rodoviários"
    if RE_TERMO_GENERICO.match(texto_normalizado, inicio) and len(antes) > 1 and (
            antes[-1] in ("de", "para") and antes[-2] in LUGAR_DE_CONTAINER):
        return False  # "obras na área de contêineres", "pátio de containers"
    # "fornecimento de água potável por meio de caminhão-pipa": é o meio, não a compra
    if antes[-2:] in (["meio", "de"], ["atraves", "de"]):
        return False
    # "basculamento em caminhões equipados com sistema lifter": é o caminhão de coleta,
    # não o que se compra (o contentor)
    if antes[-2:] == ["com", "sistema"] and texto_normalizado.startswith("lifter", inicio):
        return False
    # "botão compatível com o veículo caminhão basculante": peça para o veículo
    if {"compativel", "compativeis"} & set(antes[-4:]):
        return False
    # "fornecimento de bebedouros, contêineres e aramado em regime de comodato"
    if "comodato" in texto_normalizado[inicio:].split()[:10]:
        return False
    # "prestação de serviços com retroescavadeira, ..., caminhão-pipa": lista longa
    # de equipamentos do serviço, que passa da janela de palavras
    servico = None
    for servico in RE_SERVICO_COM.finditer(texto_normalizado, 0, inicio):
        pass
    if servico and not (COMPRA | FORNECE) & set(texto_normalizado[servico.end():inicio].split()):
        return False
    janela = antes[-JANELA:]
    for k in range(len(janela) - 1, -1, -1):
        palavra = janela[k]
        if palavra in COMPRA:
            return True
        if palavra in NAO_E_COMPRA:
            # "trator de pneus" é tipo de trator, não compra de pneus
            if palavra == "pneus" and k >= 2 and janela[k - 1] == "de" and janela[k - 2] in (
                    "trator", "tratores", "agricola", "carregadeira", "retroescavadeira"):
                continue
            return False
        # "horas/máquinas", "locação por hora" é serviço; "zero horas" é máquina nova
        if palavra in ("hora", "horas") and (k == 0 or janela[k - 1] != "zero"):
            return False
    return True


# Objeto genérico ("aquisição de máquinas e equipamentos", "patrulha mecanizada",
# "equipamentos agrícolas"): o implemento costuma aparecer só nos itens. Nesses
# pregões os itens são conferidos, e o pregão entra se algum item usar um termo.
RE_GATILHO = re.compile(
    r"\b(?:maquinas?|maquinarios?|patrulhas? (?:mecanizad|agricol)|mecanizacao"
    r"|equipamentos? (?:agricola|rodoviari|pesad|para (?:a )?agricultura|urbanos)"
    r"|implementos?|agricultura familiar|veiculos? e equipamentos"
    r"|equipamentos? e veiculos)\w*")
RE_COMPRA_OBJETO = re.compile(r"\b(?:aquisic|compra|fornecimento|registro de preco)")


def objeto_generico(objeto):
    """True se o objeto é compra genérica de máquinas/equipamentos (ver RE_GATILHO)."""
    obj = normalizar(objeto)
    return bool(RE_COMPRA_OBJETO.search(obj)) and any(
        ocorrencia_de_compra(obj, m.start()) for m in RE_GATILHO.finditer(obj))


# Busca do site: o objeto tem de ser compra ("aquisição de veículos", "material de
# limpeza"), não serviço, obra, peças, locação nem brinquedo/livro.
RE_OBJETO_DE_COMPRA = re.compile(r"\b(?:aquisic|compra|fornecimento|registro de preco)|^\W*(?:veiculos?|caminho(?:es|ao))\b")
RE_OBJETO_NAO_COMPRA = re.compile(
    r"\b(?:servicos?|execuc|obras?|engenharia|pecas|manutenc|transporte|locac|aluguel"
    r"|contratacao de empresas?(?: \w+){0,2} para (?!(?:o |a |futura |eventual |e )*(?:fornecimento|aquisic))|brinquedos?|pedagogic|didatic|ludic|livros?"
    r"|agua potavel|lavagem)\w*")


# "fornecimento de peças, componentes ... para máquinas": não é compra do implemento
RE_PECAS = re.compile(r"\bpecas\b")
# a partir daqui o objeto só nomeia quem pede ("demandas da Secretaria de Obras e
# Serviços"), o que não diz se é compra
RE_QUEM_PEDE = re.compile(r"\b(?:secretari|departament|diretori|demandas?|orgaos? demandantes"
                          r"|fundo municipal|setor|destinad)\w*")


def objeto_de_compra(objeto):
    """True se o objeto é compra de bens (critério da busca do site, ver TERMOS_BUSCA_SITE)."""
    obj = RE_QUEM_PEDE.split(normalizar(objeto), 1)[0]
    return bool(RE_OBJETO_DE_COMPRA.search(obj)) and not RE_OBJETO_NAO_COMPRA.search(obj)


def termos_encontrados(objeto, termos):
    """Lista de (categoria, termo) cujo termo aparece no objeto como coisa comprada."""
    obj = normalizar(objeto)
    return [(cat, termo) for cat, termo, rx in termos
            if any(ocorrencia_de_compra(obj, m.start()) for m in rx.finditer(obj))]


# --- Obras / estruturas ----------------------------------------------------
# Aqui serviço conta (obra é serviço de engenharia) e não há regra de caminhão.
# Termo marcado com "~" em termos_obras.txt é genérico ("escola", "execução",
# "reforma", "cobertura"): só conta se o objeto também for de obra/engenharia.
RE_CONTEXTO_OBRA = re.compile(
    r"\b(?:(?<!mao de )obras?|engenharia|empreitada|pavimenta\w*|terraplen\w*|terraplan\w*"
    r"|alvenaria|galpa\w*|edificac\w*|projeto executivo|construcao (?:d[aeo]s?|e)"
    r"|reforma (?:d[aeo]s?|e|geral|predial|com)|servicos? de (?:reforma|construcao|ampliacao)"
    r"|ampliacao e reforma|estruturas? metalicas?|cobertura metalica)\b")


# Compra de material ("aquisição de tampões para rede de esgoto", "materiais
# hidráulicos para obras") não é obra: aí só valem os termos específicos da primeira
# categoria de termos_obras.txt (galpão, estrutura metálica, telhas termoacústicas...).
RE_AQUISICAO = re.compile(r"\b(?:aquisic\w*|compras?|fornecimento parcelado)\b")
RE_SERVICO_OBRA = re.compile(
    r"\b(?:execuc\w*|servicos?|(?<!mao de )obras?|empreitada|instalac\w*|montagem"
    r"|construc\w* d[aeo]s?|reforma d[aeo]s?|implantac\w*)\b")
# reforma/manutenção de coisas que não são edificação: aí os termos genéricos não contam
RE_NAO_E_EDIFICACAO = re.compile(
    r"\b(?:reforma\w*|recuperac\w*|manutenc\w*(?: preventiva e corretiva)?|conserto\w*)"
    r" (?:d[aeo]s? |em )?(?:pneu|estofad|moveis|mobiliario|cadeira|veicul|frota|bateria|motor"
    r"|equipamento|maquina|aparelho|ar condicionado|elevador|computador|impressora)\w*")
# locação de estrutura para evento, aluguel de galpão: não é obra
NAO_E_OBRA = {"locacao", "locacoes", "aluguel", "alugueis"}


def compra_de_material(objeto_normalizado):
    return bool(RE_AQUISICAO.search(objeto_normalizado)) and not RE_SERVICO_OBRA.search(
        objeto_normalizado)


def carregar_termos_obras(caminho):
    """Lê termos_obras.txt -> lista de (categoria, termo, regex, generico)."""
    termos, vistos = [], set()
    categoria = "SEM CATEGORIA"
    with open(caminho, encoding="utf-8") as f:
        for linha in f:
            linha = linha.strip()
            if not linha or linha.startswith("#"):
                continue
            m = RE_CATEGORIA.match(linha)
            if m:
                categoria = m.group(1)
                continue
            generico = linha.startswith("~")
            linha = linha.lstrip("~").strip()
            chave = (categoria, normalizar(linha))
            if chave not in vistos:  # "galpão" == "galpao"
                vistos.add(chave)
                termos.append((categoria, linha, termo_para_regex(linha), generico))
    return termos


def obras_encontradas(objeto, termos_obras):
    """Lista de (categoria, termo) de obras no objeto; genéricos só com contexto de obra."""
    obj = normalizar(objeto)
    contexto = bool(RE_CONTEXTO_OBRA.search(obj)) and not RE_NAO_E_EDIFICACAO.search(obj)
    material = compra_de_material(obj)
    primeira = termos_obras[0][0] if termos_obras else None

    def vale(m):  # "locação de estrutura metálica" não conta
        return not NAO_E_OBRA & set(obj[:m.start()].split()[-6:])

    return [(cat, termo) for cat, termo, rx, generico in termos_obras
            if (contexto or not generico) and not (material and (generico or cat != primeira))
            and any(vale(m) for m in rx.finditer(obj))]


# --- Caminhão junto com o implemento -------------------------------------
# "caminhão"/"veículo" no texto indica que o veículo está sendo comprado,
# exceto quando aparece como destino do implemento: "caçamba PARA caminhão",
# "instalado NO caminhão", "acoplável A caminhão", "chassi DE caminhão",
# "compatível COM caminhão".
RE_VEICULO = re.compile(r"\b(?:caminh(?:ao|oes)|veiculos?|cavalos? mecanicos?"
                        r"|caminhonetes?|camionetes?|picapes?|pick ?ups?"
                        r"|automove(?:l|is)|motocicletas?|onibus)\b")
# Trator aparece em quase toda descrição de implemento agrícola ("potência
# mínima trator 75 cv", "acionamento por trator", "farol tipo trator"), então só
# conta como compra quando é o próprio objeto: no início do texto ("Trator
# agrícola 4x4 ..."), depois de "aquisição de"/"fornecimento de", "e", "sendo".
RE_TRATOR = re.compile(r"\b(?:micro ?)?tratore?s?\b|\bmotocultivador(?:es)?\b")
COMPRA_DE = {"aquisicao", "aquisicoes", "fornecimento", "compra"}
# drone/aeronave: só no início ou depois de aquisição/kit ("carreta para transportar
# o drone" é destino)
RE_DRONE = re.compile(r"\b(?:aeronaves?|drones?)\b")
ANTES_DE_DRONE_COMPRADO = COMPRA_DE | {"", "kit", "por"}
ANTES_DE_TRATOR_COMPRADO = COMPRA_DE | {"", "e", "sendo", "novo", "novos", "micro"}
# "a" antes de caminhão/veículo (masculinos) é sempre preposição
DESTINO = {"para", "p", "em", "no", "na", "nos", "nas", "sobre", "sob", "a", "ao", "aos",
           "do", "da", "dos", "das", "ate", "por"}
ARTIGOS = {"o", "os", "um", "uma", "uns", "umas", "seu", "sua", "seus", "suas"}
# "... de caminhão" só é destino depois destas palavras ("chassi de caminhão",
# "plataforma para transporte de veículos", "roçadeira de trator")
ANTES_DE_DESTINO = {"chassi", "chassis", "sobrechassi", "modelo", "modelos", "marca", "marcas",
                    "frota", "cabine", "carroceria", "cacamba", "tanque", "implemento",
                    "implementos", "transporte", "remocao", "reboque", "guincho",
                    "guinchamento", "resgate", "socorro", "acesso", "recolhimento", "abastecimento",
                    "lavagem", "rocadeira", "rocadeiras", "grade", "arado", "potencia"}
IMPLEMENTO_SEM_PREPOSICAO = {"carroceria", "carrocerias", "cacamba", "cacambas", "bau", "baus",
                             "implemento", "implementos"}
# "... com caminhão" só é destino depois destas ("compatível com trator")
ANTES_DE_COM = {"compativel", "compativeis", "compatibilidade", "adaptavel", "adaptaveis",
                "acoplavel", "acoplaveis", "uso", "utilizacao", "engate"}
# chassi do caminhão fornecido junto: "com chassi de caminhão", "chassi
# cabinado", "chassi 0 km". "Carreta com chassi reforçado" é o chassi do
# próprio implemento e não conta.
RE_CHASSI_JUNTO = re.compile(
    r"\b(?:com|incluindo|inclusive|mais) (?:o |um )?chassis? (?:de |do )?caminh"
    r"|\bchassis? (?:de caminh(?:ao|oes) )?(?:cabinad|com cabine|novo|0 ?km|zero)")
# o caminhão já é do órgão: "chassi de caminhão fornecido pela Administração
# (Caminhão VW ...)", "caminhão pertencente ao Município", "de propriedade da Prefeitura"
RE_VEICULO_DO_ORGAO = re.compile(
    r"\b(?:fornecid|cedid|disponibilizad)[oa]s? pel[oa]s? "
    r"(?:administracao|prefeitura|municipio|contratante|orgao|secretaria)"
    r"|\bpertencentes? (?:a|ao) (?:administracao|prefeitura|municipio|contratante|orgao|secretaria)"
    r"|\bde propriedade d[oa]s? (?:administracao|prefeitura|municipio|contratante|orgao|secretaria)")


# lista de veículos que é destino: "transporte de veículos leves, médios, caminhões
# e máquinas", "rampas para acesso de veículo pequenos, médios, caminhões"
PALAVRAS_LISTA_VEICULOS = {"e", "ou", "veiculo", "veiculos", "leves", "medios", "pequenos",
                           "pesados", "grandes", "carros", "automoveis", "motos",
                           "motocicletas", "maquinas", "caminhoes", "caminhao",
                           "caminhonetes", "utilitarios", "onibus"}


def lista_de_destino(antes):
    """True se as palavras antes do veículo são uma lista que começa num destino."""
    j = len(antes) - 1
    while j >= 0 and antes[j] in PALAVRAS_LISTA_VEICULOS:
        j -= 1
    if j < 0 or j == len(antes) - 1:
        return False
    return antes[j] in DESTINO or (antes[j] == "de" and j > 0 and antes[j - 1] in ANTES_DE_DESTINO)


def inclui_caminhao(texto):
    """True se o texto indica compra do caminhão (não só do implemento)."""
    t = normalizar(texto)
    if RE_CHASSI_JUNTO.search(t):
        return True
    # "caminhão fornecido pela Prefeitura" (não "layout fornecido pela contratante")
    if any(RE_VEICULO.search(t[max(0, m.start() - 60):m.start()])
           for m in RE_VEICULO_DO_ORGAO.finditer(t)):
        return False
    fim_destino = None  # fim da última menção que era destino
    for m in RE_VEICULO.finditer(t):
        # "para caminhonete/pickup": a segunda palavra herda o destino da primeira
        if fim_destino is not None and m.start() == fim_destino + 1:
            fim_destino = m.end()
            continue
        fim_destino = m.end()
        antes = [p for p in t[:m.start()].split() if p not in ARTIGOS]
        anterior = antes[-1] if antes else ""
        antes_anterior = antes[-2] if len(antes) > 1 else ""
        if anterior in DESTINO:
            continue
        if anterior == "de" and antes_anterior in ANTES_DE_DESTINO:
            continue
        # nome do catálogo sem preposição: "Carroceria Madeira Caminhão", "Baú Caminhão"
        if anterior in IMPLEMENTO_SEM_PREPOSICAO or (
                antes_anterior in IMPLEMENTO_SEM_PREPOSICAO and anterior not in ("com", "e", "ou", "sendo")):
            continue
        if anterior == "com" and antes_anterior in ANTES_DE_COM:
            continue
        if lista_de_destino(antes):
            continue
        return True
    for m in RE_DRONE.finditer(t):
        antes = [p for p in t[:m.start()].split() if p not in ARTIGOS and not p.isdigit()]
        anterior = antes[-1] if antes else ""
        if anterior == "de" and len(antes) > 1 and antes[-2] in COMPRA_DE:
            return True
        if anterior in ANTES_DE_DRONE_COMPRADO:
            return True
    for m in RE_TRATOR.finditer(t):
        antes = [p for p in t[:m.start()].split() if p not in ARTIGOS and not p.isdigit()]
        anterior = antes[-1] if antes else ""
        if anterior == "de":  # "aquisição de trator" sim, "potência de trator" não
            if len(antes) > 1 and antes[-2] in COMPRA_DE:
                return True
        elif anterior in ANTES_DE_TRATOR_COMPRADO:
            return True
    return False


class ErroAPI(Exception):
    pass


def get_json(url, params, tentativas=7):
    """GET com retentativas (a API do PNCP oscila bastante e limita o ritmo com 429)."""
    url = url + "?" + urllib.parse.urlencode(params)
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                if resp.status == 204:  # sem conteúdo
                    return None
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, http.client.HTTPException, ConnectionError,
                TimeoutError, json.JSONDecodeError) as exc:
            if isinstance(exc, urllib.error.HTTPError) and exc.code < 500 and exc.code != 429:
                corpo = exc.read().decode("utf-8", "replace")
                raise ErroAPI(f"Erro {exc.code} da API em {url}: {corpo}") from exc
            if i == tentativas - 1:
                break
            espera = min(2 ** (i + 1), 60)
            if isinstance(exc, urllib.error.HTTPError) and exc.code == 429:
                # respeita o Retry-After da API (em segundos), se vier
                retry_after = exc.headers.get("Retry-After", "")
                espera = max(espera, int(retry_after) if retry_after.isdigit() else 30)
            print(f"  falha ({exc}); nova tentativa em {espera}s...", file=sys.stderr)
            time.sleep(espera)
    raise ErroAPI(f"Não foi possível consultar {url}")


def buscar_contratacoes(data_final, uf=None, paginas_falhas=None, modalidade=6):
    """Itera por todas as páginas de contratações com proposta aberta.

    Se uma página (exceto a primeira) falhar mesmo depois das retentativas, ela é
    pulada e anotada em `paginas_falhas`, para não perder o resto da consulta.
    """
    pagina, total_paginas = 1, 0
    while True:
        params = {
            "dataFinal": data_final.strftime("%Y%m%d"),
            "codigoModalidadeContratacao": modalidade,
            "pagina": pagina,
            "tamanhoPagina": TAMANHO_PAGINA,
        }
        if uf:
            params["uf"] = uf.upper()
        try:
            dados = get_json(API_URL, params) or {}
        except ErroAPI as exc:
            if pagina == 1 or paginas_falhas is None:
                raise SystemExit(str(exc)) from exc
            print(f"  página {pagina}/{total_paginas} falhou e foi pulada", file=sys.stderr)
            paginas_falhas.append(f"{MODALIDADES.get(modalidade, modalidade)} p.{pagina}")
            if pagina >= total_paginas:
                break
            pagina += 1
            continue
        total_paginas = dados.get("totalPaginas") or 0
        print(f"  página {pagina}/{total_paginas}", file=sys.stderr)
        yield from dados.get("data") or []
        if pagina >= total_paginas:
            break
        pagina += 1


def buscar_itens(compra, tamanho=50):
    """Itens da contratação, ou None se a API de itens falhar."""
    orgao = compra.get("orgaoEntidade") or {}
    cnpj, ano, seq = orgao.get("cnpj"), compra.get("anoCompra"), compra.get("sequencialCompra")
    if not (cnpj and ano and seq):
        return None
    url = API_ITENS.format(cnpj=cnpj, ano=ano, seq=seq)
    itens, vistos, pagina = [], set(), 1
    try:
        while True:
            lote = get_json(url, {"pagina": pagina, "tamanhoPagina": tamanho}) or []
            novos = [i for i in lote if i.get("numeroItem") not in vistos]
            vistos.update(i.get("numeroItem") for i in novos)
            itens += novos
            # para quando a página vem incompleta ou repetida (API sem paginação)
            if len(lote) < tamanho or not novos:
                return itens
            pagina += 1
    except ErroAPI as exc:
        print(f"  itens indisponíveis ({exc})", file=sys.stderr)
        return None


def buscar_no_site(termos=TERMOS_BUSCA_SITE, paginas=30):
    """numeroControlePNCP dos editais com proposta aberta que a busca do site do PNCP
    acha pelos termos (no objeto ou nos itens). Termo que falhar é pulado."""
    achados = set()
    for termo in termos:
        for pagina in range(1, paginas + 1):
            params = {"q": termo, "tipos_documento": "edital", "ordenacao": "-data",
                      "pagina": pagina, "tam_pagina": 100, "status": "recebendo_proposta"}
            try:
                dados = get_json(API_BUSCA, params) or {}
            except ErroAPI as exc:
                print(f"  busca do site falhou para '{termo}' ({exc})", file=sys.stderr)
                break
            itens = dados.get("items") or []
            achados.update(i.get("numero_controle_pncp") for i in itens)
            if len(itens) < 100 or pagina * 100 >= (dados.get("total") or 0):
                break
    achados.discard(None)
    return achados


RE_LOCACAO = re.compile(r"\b(?:locac\w*|aluguel|alugueis|comodato|concessao)\b")
RE_SERVICO_OBJETO = re.compile(r"^(?:\w+ ){0,6}(?:transporte|coleta|servicos?|prestacao)\b")


RE_ATRIBUTO = re.compile(r"\b\w+\s*:", re.UNICODE)


def item_de_servico(item):
    """Item de serviço/peça: marcado como serviço no catálogo ou descrição que começa
    com locação, manutenção, peça etc. ("14507-Locação de equipamento ...")."""
    if item.get("materialOuServico") == "S":
        return True
    # nome de atributo do catálogo não conta: "Caminhão Carga potência motor: 130,
    # combustível: diesel" é o caminhão, não compra de combustível
    texto = RE_ATRIBUTO.sub(" ", item.get("descricao") or "")
    palavras = [p for p in normalizar(texto).split() if not p.isdigit()]
    # "Veículo de serviço administrativo de carga" é o tipo do veículo
    nao_compra = [p for k, p in enumerate(palavras[:6]) if p in NAO_E_COMPRA and not (
        k >= 2 and palavras[k - 1] == "de" and RE_VEICULO.fullmatch(palavras[k - 2]))]
    return (bool(nao_compra)
            or bool(RE_LOCACAO.search(" ".join(palavras[:12]))))


# Implemento agrícola não interessa (não é fabricado): carreta agrícola, tanque
# pipa agrícola com reboque, recolhedora de café etc. Esses itens não contam
# mesmo que a descrição use um termo ("carreta agrícola ... caçamba basculante").
RE_AGRICOLA = re.compile(r"\b(?:agricol|tratorizad|tratorad|recolhedor|colhedo|colhedeira"
                         r"|ensiladeira|forrage|carretinha|calcario|adubo|fertilizant)\w*")
# Fora do escopo por outro motivo: container de esterilização/laboratório, de TI.
RE_FORA_DO_ESCOPO = re.compile(
    r"\b(?:esteriliza|cirurgic|hospitala|laborator|amostra|kubernetes|docker|openshift"
    r"|bote|botes|embarcac|lancha|nautic|nitrogenio|criogenic)\w*")
# objeto de instrumental médico/odontológico: "caixa tipo container" ali não conta
RE_OBJETO_FORA_DO_ESCOPO = re.compile(
    r"\b(?:instrumenta\w*|cirurgic\w*|esteriliza\w*|odontolog\w*)")
# itens de objeto genérico que usam um termo sem ser implemento: brinquedo ("caminhão
# basculante de plástico"), caixa organizadora "tipo container", produto "em container",
# spray de pimenta (espargidor), e van/picape/ambulância com "carroceria baú/aberta"
RE_ITEM_FORA = re.compile(
    r"\b(?:brinquedos?|infantil|miniatura|plastico resistente)\b"
    r"|\bcaminh\w* (?:\w+ ){0,4}de plastico"
    r"|transporte (?:com|em|por) caminh")
# no nome do item (primeiras palavras), não na especificação ("caixa de chorume")
RE_ITEM_FORA_NOME = re.compile(
    r"\b(?:caixas?|hipoclorito|agua sanitaria|desinfetante|pimenta|livros?|balancas?"
    r"|domestico|garfos?|plugues?|defensivos?|spray|marmibox|torneiras?|sacos?|big bag|aspirador\w*|mangueiras?|radio)\b"
    r"|^\W*reservatorios?\b|\btanques? (?:\w+ ){0,4}polietileno")
# volume em ml: utensílio ("passadeira a vapor com tanque de água de 240 ml")
RE_ITEM_ML = re.compile(r"\b\d+ ?ml\b")
# recipiente pequeno ("container plástico com alça 20 litros"), nas primeiras palavras
RE_ITEM_PEQUENO = re.compile(r"\b\d{1,2} ?(?:litros?|l|lts?)\b")
# objeto pequeno medido em centímetros ("tanque aço inox ... 50 x 40 x 22 cm" é cuba;
# lixeira de 120 L já passa de 90 cm de altura)
RE_ITEM_EM_CM = re.compile(r"\b(\d{1,3}) x (\d{1,3})(?: x (\d{1,3}))? ?cm\b")
MEDIDA_MAXIMA_ITEM_PEQUENO_CM = 70


def item_pequeno_em_cm(texto):
    m = RE_ITEM_EM_CM.search(texto)
    return bool(m) and max(int(g) for g in m.groups() if g) < MEDIDA_MAXIMA_ITEM_PEQUENO_CM
RE_ITEM_OUTRO_VEICULO = re.compile(
    r"^(?:\W*\d+\W*)?(?:veiculo (?:automotor )?(?:tipo )?)?(?:vans?|pick ?ups?|picapes?|caminhonetes?|ambulancias?|furgonetas?)\b"
    r"|^(?:\W*\d+\W*)?veiculo (?:tipo )?furgao\b")


def item_fora(item):
    desc = normalizar(item.get("descricao"))
    palavras = desc.split()
    return bool(RE_ITEM_FORA.search(" ".join(palavras[:20]))
                or RE_ITEM_FORA_NOME.search(" ".join(palavras[:8]))
                or RE_ITEM_OUTRO_VEICULO.search(desc)
                or RE_ITEM_PEQUENO.search(" ".join(palavras[:10]))
                or item_pequeno_em_cm(" ".join(palavras[:20]))
                or RE_ITEM_ML.search(" ".join(palavras[:25])))


RE_OBJETO_AGRICOLA = re.compile(r"\b(?:agricol|agropecuari|patrulha|forrage|lavoura)\w*")
# no objeto genérico o termo tem de estar no começo do item: "Tanque pipa 8.000 L",
# não "Cortador de piso ... com tanque de água"
PALAVRAS_INICIO_ITEM = 15


# Exceção: carreta/reboque/tanque agrícola acima deste valor unitário entra.
VALOR_MINIMO_CARRETA_AGRICOLA = 100_000
RE_CARRETA = re.compile(r"\b(?:carret|reboque|semirreboque|tanque)\w*")


def valor_unitario(item):
    """Valor unitário estimado do item (ou total/quantidade), 0 se não informado."""
    unit = item.get("valorUnitarioEstimado")
    if unit:
        return float(unit)
    total, qtd = item.get("valorTotal") or 0, item.get("quantidade") or 1
    return float(total) / float(qtd) if qtd else float(total)


def item_agricola(item, objeto):
    """Item que é implemento agrícola: fala em agrícola/tratorizado, ou é uma
    "carreta ..." num objeto agrícola ("carretas agrícolas e reboque prancha").
    Carreta/reboque/tanque agrícola acima de VALOR_MINIMO_CARRETA_AGRICOLA não
    conta como agrícola (entra no resultado)."""
    desc = normalizar(item.get("descricao"))
    if RE_FORA_DO_ESCOPO.search(desc) or RE_OBJETO_FORA_DO_ESCOPO.search(normalizar(objeto)):
        return True
    agricola = bool(RE_AGRICOLA.search(desc)) or (
        desc.startswith(("carreta ", "carretas "))
        and bool(RE_OBJETO_AGRICOLA.search(normalizar(objeto))))
    if not agricola:
        return False
    carreta = RE_CARRETA.search(" ".join(desc.split()[:8]))
    return not (carreta and valor_unitario(item) > VALOR_MINIMO_CARRETA_AGRICOLA)


def termo_no_inicio(texto, termos):
    """True se algum termo aparece (como compra) nas primeiras palavras do texto."""
    t = normalizar(texto)
    limite = len(" ".join(t.split()[:PALAVRAS_INICIO_ITEM]))
    return any(m.start() < limite and ocorrencia_de_compra(t, m.start())
               for _, _, rx in termos for m in rx.finditer(t))


def avaliar_itens(compra, termos, so_com_termo=False):
    """Decide se o pregão tem implemento sem caminhão.

    Retorna (aceita, itens_de_interesse, verificacao). Com `so_com_termo` (objeto
    genérico) só valem itens que começam com algum termo. verificacao "agrícola"
    quer dizer que os itens com termo são todos implemento agrícola.
    """
    objeto = compra.get("objetoCompra")
    itens = buscar_itens(compra)
    if so_com_termo:
        com_termo = [i for i in itens or [] if termo_no_inicio(i.get("descricao"), termos)
                     and not item_de_servico(i) and not item_fora(i)]
        nao_agricola = [i for i in com_termo if not item_agricola(i, objeto)]
        if com_termo and not nao_agricola:
            return False, [], "agrícola"
        implemento = [i for i in nao_agricola if not inclui_caminhao(i.get("descricao"))]
        return bool(implemento), implemento or nao_agricola, "itens (objeto genérico)"
    if not itens:  # sem itens: decide só pelo objeto
        if item_agricola({"descricao": objeto, "valorTotal": compra.get("valorTotalEstimado")}, objeto):
            return False, [], "agrícola"
        aceita = not inclui_caminhao(objeto)
        return aceita, [], "objeto (itens indisponíveis)"
    com_termo = [i for i in itens if termos_encontrados(i.get("descricao"), termos)
                 and not item_de_servico(i)]
    if com_termo:
        nao_agricola = [i for i in com_termo if not item_agricola(i, objeto)]
        if not nao_agricola:
            return False, [], "agrícola"
        implemento = [i for i in nao_agricola if not inclui_caminhao(i.get("descricao"))]
        return bool(implemento), implemento, "itens"
    # descrições dos itens não usam os termos (ex.: objeto "caminhão pipa e kit de
    # combate", itens "Caminhão hidrojato", "Kit de combate para caminhonete"): entram
    # os itens de material que não são veículo nem agrícolas
    materiais = [i for i in itens if not item_de_servico(i)]
    if not materiais:  # só itens de serviço no catálogo: decide pelo objeto
        obj = normalizar(objeto)
        if RE_LOCACAO.search(obj) or (RE_SERVICO_OBJETO.search(obj) and not RE_AQUISICAO.search(obj)):
            # locação/concessão/transporte/coleta: contrata o serviço, não compra
            return False, [], "locação"
        return not inclui_caminhao(objeto), [], "objeto (itens de serviço)"
    uteis = [i for i in materiais if not item_agricola(i, objeto)]
    if RE_OBJETO_AGRICOLA.search(normalizar(objeto)):
        # objeto agrícola: só entra carreta/reboque/tanque (que passou do valor mínimo)
        uteis = [i for i in uteis if RE_CARRETA.search(
            " ".join(normalizar(i.get("descricao")).split()[:8]))]
    if not uteis:
        return False, [], "agrícola"
    sem_veiculo = [i for i in uteis if not inclui_caminhao(i.get("descricao"))]
    return bool(sem_veiculo), sem_veiculo, "itens (sem termo)"


def parse_data(valor):
    if not valor:
        return None
    try:
        return datetime.fromisoformat(valor.replace("Z", ""))
    except ValueError:
        return None


def link_edital(item):
    """Página do edital no PNCP (arquivos, itens e link para o sistema de origem)."""
    orgao = item.get("orgaoEntidade") or {}
    cnpj, ano, seq = orgao.get("cnpj"), item.get("anoCompra"), item.get("sequencialCompra")
    if cnpj and ano and seq:
        return f"https://pncp.gov.br/app/editais/{cnpj}/{ano}/{seq}"
    return item.get("linkSistemaOrigem") or ""


def formatar_valor(valor):
    if valor in (None, ""):
        return "não informado"
    s = f"{float(valor):,.2f}"
    return "R$ " + s.replace(",", "X").replace(".", ",").replace("X", ".")


def formatar_itens(itens):
    partes = []
    for i in itens:
        desc = " ".join((i.get("descricao") or "").split())[:120]
        partes.append(f"item {i.get('numeroItem')}: {desc} "
                      f"({formatar_valor(i.get('valorTotal'))})")
    return " || ".join(partes)


def montar_resultado(item, encontrados, itens_implemento=(), verificacao=""):
    orgao = item.get("orgaoEntidade") or {}
    unidade = item.get("unidadeOrgao") or {}
    categorias = list(dict.fromkeys(cat for cat, _ in encontrados))
    return {
        "categoria": " | ".join(categorias),
        "orgao": orgao.get("razaoSocial", ""),
        "unidade": unidade.get("nomeUnidade", ""),
        "modalidade": item.get("modalidadeNome", ""),
        "municipio": unidade.get("municipioNome", ""),
        "uf": unidade.get("ufSigla", ""),
        "valor_estimado": item.get("valorTotalEstimado"),
        "valor_itens_implemento": (sum(i.get("valorTotal") or 0 for i in itens_implemento)
                                   if itens_implemento else None),
        "itens_implemento": formatar_itens(itens_implemento),
        "verificacao_caminhao": verificacao,
        "encerramento_proposta": item.get("dataEncerramentoProposta", ""),
        "objeto": " ".join((item.get("objetoCompra") or "").split()),
        "termos": ", ".join(termo for _, termo in encontrados),
        "link_edital": link_edital(item),
        "link_sistema_origem": item.get("linkSistemaOrigem") or "",
        "numero_controle_pncp": item.get("numeroControlePNCP", ""),
    }


RE_PICAPE = re.compile(r"\b(?:caminhonete\w*|camionete\w*|picapes?|pick ?ups?)\b")
RE_CAMINHAO = re.compile(r"\bcaminh(?:ao|oes)\b")


def fora_da_aba_caminhao(objeto, encontrados):
    """Compra de veículo que não interessa na aba "Caminhão + implemento": van/picape
    só com "carroceria" ("caminhonete cabine simples, carroceria aberta") e trator
    agrícola ("trator agrícola ... kit de combate com tanque de água")."""
    obj = normalizar(objeto)
    if RE_ITEM_OUTRO_VEICULO.search(obj):
        return True
    if RE_CAMINHAO.search(obj):
        return False
    if RE_PICAPE.search(obj) and all("carroceria" in t for _, t in encontrados):
        return True
    return bool(RE_TRATOR.search(obj) and RE_AGRICOLA.search(obj))


def filtrar(itens, termos, agora, incluir_caminhao=False, descartados=None,
            achados_site=frozenset()):
    """`achados_site`: editais que a busca do site achou pelos itens (buscar_no_site);
    se o objeto for compra, os itens são conferidos como num objeto genérico."""
    vistos = set()
    for item in itens:
        chave = item.get("numeroControlePNCP")
        if chave in vistos:
            continue
        vistos.add(chave)
        # garante que a proposta ainda está aberta
        fim = parse_data(item.get("dataEncerramentoProposta"))
        if fim and fim < agora:
            continue
        encontrados = termos_encontrados(item.get("objetoCompra"), termos)
        if not encontrados:
            objeto = item.get("objetoCompra")
            if RE_PECAS.search(" ".join(normalizar(objeto).split()[:12])) or not (
                    objeto_generico(objeto)
                    or (chave in achados_site and objeto_de_compra(objeto))):
                continue
            aceita, itens_impl, verificacao = avaliar_itens(item, termos, so_com_termo=True)
            if not itens_impl:  # nenhum item usa os termos, ou só itens agrícolas
                continue
            encontrados = list(dict.fromkeys(
                t for i in itens_impl for t in termos_encontrados(i.get("descricao"), termos)))
            if aceita or incluir_caminhao:
                yield montar_resultado(item, encontrados, itens_impl, verificacao)
            elif descartados is not None:
                descartados.append({**item, "_encontrados": encontrados, "_itens": itens_impl})
            continue
        if incluir_caminhao:
            yield montar_resultado(item, encontrados, verificacao="desligada")
            continue
        aceita, itens_impl, verificacao = avaliar_itens(item, termos)
        if aceita:
            yield montar_resultado(item, encontrados, itens_impl, verificacao)
        elif (verificacao not in ("agrícola", "locação") and descartados is not None
              and not fora_da_aba_caminhao(item.get("objetoCompra"), encontrados)):
            descartados.append(item)


def imprimir(resultados):
    if not resultados:
        print("Nenhuma contratação encontrada com os termos informados.")
        return
    for i, r in enumerate(resultados, 1):
        fim = parse_data(r["encerramento_proposta"])
        fim_txt = fim.strftime("%d/%m/%Y %H:%M") if fim else r["encerramento_proposta"]
        print(f"\n[{i}] {r['orgao']}")
        print(f"    Categoria:   {r['categoria']}")
        print(f"    Modalidade:  {r['modalidade']}")
        if r["unidade"]:
            print(f"    Unidade:     {r['unidade']}")
        print(f"    Local:       {r['municipio']}/{r['uf']}")
        print(f"    Valor est.:  {formatar_valor(r['valor_estimado'])}")
        if r["itens_implemento"]:
            print(f"    Itens impl.: {formatar_valor(r['valor_itens_implemento'])} em "
                  f"{r['itens_implemento'].count(' || ') + 1} item(ns)")
            for linha in r["itens_implemento"].split(" || "):
                print(f"      - {linha}")
        print(f"    Encerra em:  {fim_txt}")
        if r["verificacao_caminhao"].startswith("objeto"):
            print("    Atenção:     itens não conferidos; confira no edital se inclui o caminhão")
        print(f"    Termos:      {r['termos']}")
        print(f"    Objeto:      {r['objeto'][:300]}")
        print(f"    Edital:      {r['link_edital']}")
        if r["link_sistema_origem"]:
            print(f"    Sist. origem: {r['link_sistema_origem']}")
    print(f"\nTotal: {len(resultados)} contratação(ões).")
    por_categoria = {}
    for r in resultados:
        for cat in r["categoria"].split(" | "):
            por_categoria[cat] = por_categoria.get(cat, 0) + 1
    for cat, n in sorted(por_categoria.items(), key=lambda x: -x[1]):
        print(f"  {n:4d}  {cat}")


# --- Compras planejadas (PCA) -----------------------------------------------
# O Plano de Contratações Anual traz o que cada órgão pretende comprar, com valor e
# data desejada, antes de o edital sair. É consultado por classe do catálogo.
API_PCA = "https://pncp.gov.br/api/consulta/v1/pca/"
PCA_CLASSES = {"2330": "REBOQUES", "2510": "COMPONENTES DE CARROCERIA", "2320": "VEÍCULOS SOBRE RODAS"}


def buscar_pca(ano, classe):
    """Planos (PCA) de um ano e classe do catálogo; cada plano traz seus itens."""
    pagina = 1
    while True:
        try:
            dados = get_json(API_PCA, {"anoPca": ano, "codigoClassificacaoSuperior": classe,
                                       "pagina": pagina, "tamanhoPagina": 50}) or {}
        except ErroAPI as exc:
            print(f"  PCA {classe}/{ano} página {pagina} falhou: {exc}", file=sys.stderr)
            return
        total = dados.get("totalPaginas") or 0
        print(f"  PCA {classe}/{ano} página {pagina}/{total}", file=sys.stderr)
        yield from dados.get("data") or []
        if pagina >= total:
            return
        pagina += 1


def filtrar_pca(planos, termos, hoje):
    """Itens planejados de implemento (mesmos termos e regras), com data desejada >= hoje."""
    vistos = set()
    for plano in planos:
        for item in plano.get("itens") or []:
            if (item.get("dataDesejada") or "9999") < hoje:
                continue
            texto = " | ".join(filter(None, [item.get("pdmDescricao"), item.get("descricaoItem"),
                                             item.get("grupoContratacaoNome")]))
            encontrados = termos_encontrados(texto, termos)
            if not encontrados or item_de_servico({"descricao": texto}) or item_fora(
                    {"descricao": texto}) or item_agricola(
                    {"descricao": texto, "valorUnitarioEstimado": item.get("valorUnitario")}, ""):
                continue
            chave = (plano.get("idPcaPncp"), item.get("numeroItem"))
            if chave in vistos:
                continue
            vistos.add(chave)
            cnpj, _, resto = (plano.get("idPcaPncp") or "").partition("-0-")
            seq, _, ano = resto.partition("/")
            yield {
                "data_desejada": item.get("dataDesejada") or "",
                "com_caminhao": "sim" if inclui_caminhao(texto) else "",
                "categoria": " | ".join(dict.fromkeys(c for c, _ in encontrados)),
                "orgao": plano.get("orgaoEntidadeRazaoSocial") or "",
                "unidade": plano.get("nomeUnidade") or "",
                "item": item.get("pdmDescricao") or "",
                "descricao": " ".join((item.get("descricaoItem") or "").split()),
                "grupo": item.get("grupoContratacaoNome") or "",
                "quantidade": item.get("quantidadeEstimada"),
                "valor_total": item.get("valorTotal"),
                "ano_pca": plano.get("anoPca"),
                "termos": ", ".join(t for _, t in encontrados),
                "link_pca": (f"https://pncp.gov.br/app/pca/{cnpj}/{ano}/{int(seq)}"
                             if cnpj and seq.isdigit() and ano else ""),
            }


def filtrar_obras(contratacoes, termos_obras, agora):
    """Contratações de obra/estrutura (termos_obras.txt), cada uma com sua aba."""
    vistos = set()
    categorias = list(dict.fromkeys(cat for cat, *_ in termos_obras))
    for c in contratacoes:
        chave = c.get("numeroControlePNCP")
        if chave in vistos:
            continue
        vistos.add(chave)
        fim = parse_data(c.get("dataEncerramentoProposta"))
        if fim and fim < agora:
            continue
        encontrados = obras_encontradas(c.get("objetoCompra"), termos_obras)
        if encontrados:
            r = montar_resultado(c, encontrados, verificacao="objeto")
            # aba = primeira categoria encontrada, na ordem de termos_obras.txt
            r["aba"] = min((cat for cat, _ in encontrados), key=categorias.index)
            r["ordem_aba"] = categorias.index(r["aba"])
            yield r


def texto_para_excel(v):
    """Tira o que o Excel rejeita: caracteres de controle e os C1 (0x80-0x9F) que vêm
    de texto Windows-1252 mal convertido no PNCP ("\x96" vira "–")."""
    def c1(m):
        try:
            return bytes([ord(m.group(0))]).decode("cp1252")
        except UnicodeDecodeError:
            return " "
    v = re.sub(r"[\x80-\x9f]", c1, v)
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffe\uffff]", " ", v)


def salvar_xlsx(caminho, implementos, descartados, obras, containers=(), planejadas=()):
    """Três planilhas Excel separadas, uma por filtro: <base>_implementos.xlsx
    (implementos + descartados com veículo), <base>_containers.xlsx e
    <base>_galpao_obras.xlsx (uma aba, grupo na coluna). Requer openpyxl."""
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter
    except ImportError:
        raise SystemExit("Para --xlsx instale o openpyxl: pip install openpyxl")
    base = Font(name="Arial", size=10)
    cab = Font(name="Arial", size=10, bold=True, color="FFFFFF")
    link = Font(name="Arial", size=10, color="0563C1", underline="single")
    fundo_cab = PatternFill("solid", fgColor="1F4E78")
    amarelo = PatternFill("solid", fgColor="FFF2CC")
    agora = datetime.now()

    def num(v):
        try:
            return float(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None

    def aba(wb, titulo, colunas, linhas, nota):
        # nome de aba: até 31 caracteres, sem / \\ ? * [ ] :
        ws = wb.create_sheet(re.sub(r"[/\\?*\[\]:]", "-", titulo)[:31])
        for c, (nome, largura, _) in enumerate(colunas, 1):
            x = ws.cell(1, c, nome)
            x.font, x.fill = cab, fundo_cab
            x.alignment = Alignment(wrap_text=True, vertical="center")
            ws.column_dimensions[get_column_letter(c)].width = largura
        ws.row_dimensions[1].height = 30
        ws.freeze_panes = "B2"
        for i, r in enumerate(linhas, 2):
            fim = parse_data(r.get("encerramento_proposta"))
            for c, (nome, largura, campo) in enumerate(colunas, 1):
                v = campo(r)
                if isinstance(v, str):  # textos do PNCP às vezes trazem caracteres de controle
                    v = texto_para_excel(v)
                x = ws.cell(i, c, v)
                x.font = base
                x.alignment = Alignment(wrap_text=largura >= 30, vertical="top")
                if isinstance(v, datetime):
                    x.number_format = "dd/mm/yyyy hh:mm"
                elif isinstance(v, float):
                    x.number_format = '#,##0.00;-#,##0.00;"-"'
                elif nome.startswith(("Edital", "Sistema", "Plano")) and v:
                    # Excel recusa link com espaço, [ ] e afins: codifica o que não é seguro
                    url = urllib.parse.quote(v.strip(), safe=":/?&=%#+@,;~!$'()*-._")
                    x.value, x.hyperlink, x.font = "abrir", url, link
            if fim and (fim - agora).days < 2:
                for c in range(1, len(colunas) + 1):
                    ws.cell(i, c).fill = amarelo
        ws.auto_filter.ref = f"A1:{get_column_letter(len(colunas))}{len(linhas) + 1}"
        x = ws.cell(len(linhas) + 3, 1, nota)
        x.font = Font(name="Arial", size=9, italic=True, color="595959")

    # coluna "Novo hoje" só aparece se os resultados vierem marcados (chave "novo")
    novo = ([("Novo hoje", 9, lambda r: r.get("novo", ""))]
            if any("novo" in r for r in list(implementos) + list(descartados) + list(obras)
                   + list(containers)) else [])
    comuns_ini = novo + [("Encerra proposta", 17, lambda r: parse_data(r["encerramento_proposta"])),
                  ("Modalidade", 16, lambda r: r["modalidade"]),
                  ("Categoria", 26, lambda r: r["categoria"]),
                  ("Órgão", 36, lambda r: r["orgao"]),
                  ("Município", 18, lambda r: r["municipio"]),
                  ("UF", 5, lambda r: r["uf"]),
                  ("Valor estimado (R$)", 16, lambda r: num(r["valor_estimado"]))]
    comuns_fim = [("Objeto", 70, lambda r: r["objeto"]),
                  ("Termos encontrados", 30, lambda r: r["termos"]),
                  ("Edital PNCP", 11, lambda r: r["link_edital"].strip()),
                  ("Sistema de origem", 11, lambda r: r["link_sistema_origem"].strip()),
                  ("Nº controle PNCP", 27, lambda r: r["numero_controle_pncp"])]
    colunas_itens = [
        ("Valor dos itens (R$)", 16, lambda r: num(r["valor_itens_implemento"])),
        ("Itens", 70, lambda r: r["itens_implemento"].replace(" || ", "\n")),
        ("Conferência", 20, lambda r: r["verificacao_caminhao"])]
    prefixo = str(caminho)[:-5] if str(caminho).lower().endswith(".xlsx") else str(caminho)
    arquivos = []

    def salvar(sufixo, abas):
        wb = Workbook()
        wb.remove(wb.active)
        for args in abas:
            aba(wb, *args)
        nome = f"{prefixo}_{sufixo}.xlsx"
        wb.save(nome)
        arquivos.append(nome)

    salvar("implementos", [
        ("Implementos", comuns_ini + colunas_itens + comuns_fim, implementos,
         "Implementos rodoviários sem o veículo. Linhas em amarelo: proposta encerra em menos "
         "de 2 dias. Valor 0 ou vazio: sigiloso."),
        ("Caminhão + implemento", comuns_ini + comuns_fim, descartados,
         "O órgão compra o caminhão já com o implemento (baú, prancha, caçamba, pipa...): quem vence costuma ser a concessionária, que compra o implemento de um fabricante.")])
    if planejadas:
        salvar("compras_planejadas", [("Compras planejadas (PCA)", [
            ("Novo hoje", 9, lambda r: r.get("novo", "")),
            ("Data desejada", 13, lambda r: "/".join(reversed(r["data_desejada"].split("-")))),
            ("Com caminhão", 9, lambda r: r["com_caminhao"]),
            ("Categoria", 26, lambda r: r["categoria"]),
            ("Órgão", 36, lambda r: r["orgao"]),
            ("Unidade", 30, lambda r: r["unidade"]),
            ("Item", 26, lambda r: r["item"]),
            ("Descrição", 60, lambda r: r["descricao"]),
            ("Grupo da contratação", 40, lambda r: r["grupo"]),
            ("Quantidade", 10, lambda r: num(r["quantidade"])),
            ("Valor total (R$)", 16, lambda r: num(r["valor_total"])),
            ("Ano do plano", 8, lambda r: r["ano_pca"]),
            ("Termos encontrados", 30, lambda r: r["termos"]),
            ("Plano no PNCP", 11, lambda r: r["link_pca"])],
         sorted(planejadas, key=lambda r: r["data_desejada"]),
         "Plano de Contratações Anual (PCA): o que os órgãos planejam comprar, antes de o edital "
         "sair. 'Data desejada' é a previsão do órgão; o edital pode sair antes ou depois. "
         "Link abre o plano do órgão no PNCP.")])
    salvar("containers", [
        ("Containers", comuns_ini + colunas_itens + comuns_fim, containers,
         "Compra de container/contentor (lixo, PEAD, metálico...). Locação e serviço ficam de "
         "fora. Linhas em amarelo: proposta encerra em menos de 2 dias.")])
    obras = sorted(obras, key=lambda r: (r["ordem_aba"], r["encerramento_proposta"] or ""))
    salvar("galpao_obras", [
        ("Galpão e obras", [("Grupo", 24, lambda r: r["aba"])] + comuns_ini + comuns_fim, obras,
         "Obras/estruturas, em ordem de grupo (galpão/estrutura metálica primeiro) e de "
         "encerramento. Filtre pela coluna Grupo. Linhas em amarelo: encerra em menos de 2 dias.")])
    for nome in arquivos:
        print(f"Planilha salva em {nome}", file=sys.stderr)


def so_container(resultado):
    """Resultado cujas categorias são todas de container (vai para a planilha de containers)."""
    return all(c.startswith(CATEGORIA_CONTAINER) for c in resultado["categoria"].split(" | "))


def salvar_csv(resultados, caminho):
    campos = list(resultados[0].keys()) if resultados else ["orgao"]
    # utf-8-sig + ';' abre direto no Excel em português
    with open(caminho, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=campos, delimiter=";")
        w.writeheader()
        w.writerows({k: texto_para_excel(v) if isinstance(v, str) else v for k, v in r.items()}
                    for r in resultados)
    print(f"CSV salvo em {caminho}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dias", type=int, default=90,
                    help="considera propostas que encerram até N dias a partir de hoje (padrão: 90)")
    ap.add_argument("--uf", help="filtra por UF (ex.: SP)")
    ap.add_argument("--modalidades", default=MODALIDADES_PADRAO,
                    help="códigos PNCP separados por vírgula (padrão: 6,7,4,5,8 = pregão e "
                         "concorrência, eletrônicos e presenciais, e dispensa)")
    ap.add_argument("--termos", default=str(ARQUIVO_TERMOS),
                    help="arquivo de termos por categoria (padrão: termos.txt ao lado do script)")
    ap.add_argument("--termo", action="append", default=[],
                    help="termo extra a procurar no objeto, além do arquivo (pode repetir)")
    ap.add_argument("--termos-obras", default=str(ARQUIVO_TERMOS_OBRAS),
                    help="arquivo de termos de obras/estruturas (padrão: termos_obras.txt)")
    ap.add_argument("--sem-pca", action="store_true",
                    help="não consulta as compras planejadas (PCA) deste ano e do próximo")
    ap.add_argument("--sem-obras", action="store_true",
                    help="não procura obras/estruturas, só implementos")
    ap.add_argument("--csv", help="também salva CSV: <nome>_implementos.csv, "
                                  "<nome>_containers.csv e <nome>_galpao_obras.csv")
    ap.add_argument("--xlsx", help="salva 3 planilhas Excel: <nome>_implementos.xlsx, "
                                   "<nome>_containers.xlsx e <nome>_galpao_obras.xlsx (requer openpyxl)")
    ap.add_argument("--sem-busca-site", action="store_true",
                    help="não usa a busca do site do PNCP (que acha o implemento nos itens)")
    ap.add_argument("--incluir-caminhao", action="store_true",
                    help="não descarta pregões que compram o caminhão junto com o implemento")
    args = ap.parse_args()

    termos = carregar_termos(args.termos)
    termos += [(CATEGORIA_EXTRA, t, termo_para_regex(t)) for t in args.termo]
    print(f"{len(termos)} termos carregados de {args.termos}", file=sys.stderr)
    data_final = date.today() + timedelta(days=args.dias)

    modalidades = [int(m) for m in args.modalidades.split(",") if m.strip()]
    paginas_falhas = []

    def todas_as_modalidades():
        for mod in modalidades:
            print(f"Consultando {MODALIDADES.get(mod, mod)} com proposta aberta até "
                  f"{data_final:%d/%m/%Y}{' em ' + args.uf.upper() if args.uf else ''}...",
                  file=sys.stderr)
            yield from buscar_contratacoes(data_final, args.uf, paginas_falhas, mod)

    contratacoes = list(todas_as_modalidades())
    achados_site = set()
    if not args.sem_busca_site:
        print("Consultando a busca do site do PNCP (termos nos itens)...", file=sys.stderr)
        achados_site = buscar_no_site()
    agora = datetime.now()
    descartados = []
    resultados = list(filtrar(contratacoes, termos, agora, args.incluir_caminhao, descartados,
                              achados_site))
    resultados.sort(key=lambda r: r["encerramento_proposta"] or "")
    obras = []
    if not args.sem_obras and Path(args.termos_obras).exists():
        obras = sorted(filtrar_obras(contratacoes, carregar_termos_obras(args.termos_obras), agora),
                       key=lambda r: r["encerramento_proposta"] or "")

    containers = [r for r in resultados if so_container(r)]
    resultados = [r for r in resultados if not so_container(r)]

    imprimir(resultados)
    if descartados:
        print(f"\n{len(descartados)} pregão(ões) descartado(s) por incluir o caminhão "
              f"(use --incluir-caminhao para vê-los).")
    if paginas_falhas:
        print(f"\nATENÇÃO: a API falhou nas páginas {', '.join(paginas_falhas)} "
              f"({TAMANHO_PAGINA} pregões cada), que ficaram de fora. Rode de novo mais tarde.")
    if containers:
        print(f"\nContainers: {len(containers)} contratação(ões) (lista completa com --xlsx ou --csv)")
    if obras:
        print(f"\nGalpão/obras: {len(obras)} contratação(ões) "
              f"(lista completa com --xlsx ou --csv):")
        por_aba = {}
        for r in obras:
            por_aba[r["aba"]] = por_aba.get(r["aba"], 0) + 1
        for nome, n in por_aba.items():
            print(f"  {n:5d}  {nome}")
    if args.csv:
        base = str(Path(args.csv).with_suffix(""))
        salvar_csv(resultados, f"{base}_implementos.csv")
        if containers:
            salvar_csv(containers, f"{base}_containers.csv")
        if obras:
            salvar_csv(obras, f"{base}_galpao_obras.csv")
    planejadas = []
    if not args.sem_pca:
        print("Consultando compras planejadas (PCA)...", file=sys.stderr)
        planos = (pl for ano in (date.today().year, date.today().year + 1)
                  for classe in PCA_CLASSES for pl in buscar_pca(ano, classe))
        planejadas = list(filtrar_pca(planos, termos, date.today().isoformat()))
        print(f"\nCompras planejadas (PCA): {len(planejadas)} item(ns) de implemento "
              f"(lista completa com --xlsx ou --csv)")
        if args.csv:
            salvar_csv(planejadas, str(Path(args.csv).with_suffix("")) + "_planejadas.csv")
    if args.xlsx:
        salvar_xlsx(args.xlsx, resultados,
                    [montar_resultado(d, d.get("_encontrados")
                                      or termos_encontrados(d.get("objetoCompra"), termos),
                                      d.get("_itens") or ())
                     for d in descartados], obras, containers, planejadas)


if __name__ == "__main__":
    main()
