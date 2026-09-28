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
# Modalidades consultadas (código PNCP): pregão, concorrência e dispensa.
MODALIDADES = {6: "Pregão eletrônico", 7: "Pregão presencial", 4: "Concorrência eletrônica",
               5: "Concorrência presencial", 8: "Dispensa"}
MODALIDADES_PADRAO = "6,7,4,5,8"
TAMANHO_PAGINA = 50  # máximo aceito pela API

# Arquivo com os termos procurados no objeto, agrupados por categoria.
ARQUIVO_TERMOS = Path(__file__).with_name("termos.txt")
CATEGORIA_EXTRA = "TERMO EXTRA"

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


def palavra_para_regex(palavra):
    """Aceita plural e sufixos: caminhao -> caminhoes, combustivel -> combustiveis."""
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
    sep = r"\s+(?:(?:" + "|".join(PREPOSICOES) + r")\s+)?"
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
    "peca", "pecas", "componente", "componentes", "acessorio", "acessorios",
    "lubrificante", "lubrificantes", "graxa", "exposicao", "concessao",
    "aplicacao", "pneu", "pneus", "camara", "camaras", "combustivel", "combustiveis",
    "oleo", "oleos", "filtro", "filtros", "bateria", "baterias",
    "placa", "placas", "emplacamento", "licenciamento", "fretamento", "frete",
}
COMPRA = {"aquisicao", "aquisicoes", "compra", "compras", "adquirir"}
JANELA = 20


# Termo que é o próprio caminhão ("caminhão pipa") ou genérico ("implementos
# rodoviários") depois de "para"/"no"/"dos" é destino de outra coisa:
# "mangueiras PARA caminhão-pipa", "chave de roda PARA implementos rodoviários".
ANTES_DE_CAMINHAO_DESTINO = {"para", "p", "em", "no", "na", "nos", "nas", "sobre",
                             "a", "ao", "aos"}
ANTES_DE_GENERICO_DESTINO = ANTES_DE_CAMINHAO_DESTINO | {"dos", "das", "do", "da"}
RE_TERMO_GENERICO = re.compile(r"implementos?\b")


def ocorrencia_de_compra(texto_normalizado, inicio):
    """False se o termo que começa em `inicio` é objeto de serviço/peça, não de compra."""
    antes = texto_normalizado[:inicio].split()
    if antes and antes[-1] in ANTES_DE_CAMINHAO_DESTINO and RE_VEICULO.match(texto_normalizado, inicio):
        return False
    if RE_TERMO_GENERICO.match(texto_normalizado, inicio) and antes and (
            antes[-1] in ANTES_DE_GENERICO_DESTINO
            or ({"para", "p"} & set(antes[-3:]) and not COMPRA & set(antes[-3:]))):
        return False  # "... para caminhões e implementos rodoviários"
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


def termos_encontrados(objeto, termos):
    """Lista de (categoria, termo) cujo termo aparece no objeto como coisa comprada."""
    obj = normalizar(objeto)
    return [(cat, termo) for cat, termo, rx in termos
            if any(ocorrencia_de_compra(obj, m.start()) for m in rx.finditer(obj))]


# --- Caminhão junto com o implemento -------------------------------------
# "caminhão"/"veículo" no texto indica que o veículo está sendo comprado,
# exceto quando aparece como destino do implemento: "caçamba PARA caminhão",
# "instalado NO caminhão", "acoplável A caminhão", "chassi DE caminhão",
# "compatível COM caminhão".
RE_VEICULO = re.compile(r"\b(?:caminh(?:ao|oes)|veiculos?|cavalos? mecanicos?"
                        r"|caminhonetes?|camionetes?|picapes?|pick ?ups?"
                        r"|automove(?:l|is)|motocicletas?|onibus|aeronaves?|drones?)\b")
# Trator aparece em quase toda descrição de implemento agrícola ("potência
# mínima trator 75 cv", "acionamento por trator", "farol tipo trator"), então só
# conta como compra quando é o próprio objeto: no início do texto ("Trator
# agrícola 4x4 ..."), depois de "aquisição de"/"fornecimento de", "e", "sendo".
RE_TRATOR = re.compile(r"\b(?:micro ?)?tratore?s?\b|\bmotocultivador(?:es)?\b")
COMPRA_DE = {"aquisicao", "aquisicoes", "fornecimento", "compra"}
ANTES_DE_TRATOR_COMPRADO = COMPRA_DE | {"", "e", "sendo", "novo", "novos", "micro"}
# "a" antes de caminhão/veículo (masculinos) é sempre preposição
DESTINO = {"para", "p", "em", "no", "na", "nos", "nas", "sobre", "sob", "a", "ao", "aos",
           "do", "da", "dos", "das", "ate"}
ARTIGOS = {"o", "os", "um", "uma", "uns", "umas", "seu", "sua", "seus", "suas"}
# "... de caminhão" só é destino depois destas palavras ("chassi de caminhão",
# "plataforma para transporte de veículos", "roçadeira de trator")
ANTES_DE_DESTINO = {"chassi", "chassis", "sobrechassi", "modelo", "modelos", "marca", "marcas",
                    "frota", "cabine", "carroceria", "cacamba", "tanque", "implemento",
                    "implementos", "transporte", "remocao", "reboque", "guincho",
                    "guinchamento", "resgate", "socorro", "recolhimento", "abastecimento",
                    "lavagem", "rocadeira", "rocadeiras", "grade", "arado", "potencia"}
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


def inclui_caminhao(texto):
    """True se o texto indica compra do caminhão (não só do implemento)."""
    t = normalizar(texto)
    if RE_CHASSI_JUNTO.search(t):
        return True
    if RE_VEICULO_DO_ORGAO.search(t):
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
        if anterior == "com" and antes_anterior in ANTES_DE_COM:
            continue
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


def item_de_servico(item):
    """Item de serviço/peça: marcado como serviço no catálogo ou descrição que começa
    com locação, manutenção, peça etc. ("14507-Locação de equipamento ...")."""
    if item.get("materialOuServico") == "S":
        return True
    palavras = [p for p in normalizar(item.get("descricao")).split() if not p.isdigit()]
    return any(p in NAO_E_COMPRA for p in palavras[:3])


# Implemento agrícola não interessa (não é fabricado): carreta agrícola, tanque
# pipa agrícola com reboque, recolhedora de café etc. Esses itens não contam
# mesmo que a descrição use um termo ("carreta agrícola ... caçamba basculante").
RE_AGRICOLA = re.compile(r"\b(?:agricol|tratorizad|tratorad|recolhedor|colhedo|colhedeira"
                         r"|ensiladeira|forrage|carretinha)\w*")
RE_OBJETO_AGRICOLA = re.compile(r"\b(?:agricol|agropecuari|patrulha|forrage|lavoura)\w*")
# no objeto genérico o termo tem de estar no começo do item: "Tanque pipa 8.000 L",
# não "Cortador de piso ... com tanque de água"
PALAVRAS_INICIO_ITEM = 15


def item_agricola(item, objeto):
    """Item que é implemento agrícola: fala em agrícola/tratorizado, ou é uma
    "carreta ..." num objeto agrícola ("carretas agrícolas e reboque prancha")."""
    desc = normalizar(item.get("descricao"))
    if RE_AGRICOLA.search(desc):
        return True
    return desc.startswith(("carreta ", "carretas ")) and bool(
        RE_OBJETO_AGRICOLA.search(normalizar(objeto)))


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
        com_termo = [i for i in itens or [] if termo_no_inicio(i.get("descricao"), termos)]
        nao_agricola = [i for i in com_termo if not item_agricola(i, objeto)]
        if com_termo and not nao_agricola:
            return False, [], "agrícola"
        implemento = [i for i in nao_agricola if not inclui_caminhao(i.get("descricao"))]
        return bool(implemento), implemento or nao_agricola, "itens (objeto genérico)"
    if not itens:  # sem itens: decide só pelo objeto
        if item_agricola({"descricao": objeto}, objeto):
            return False, [], "agrícola"
        aceita = not inclui_caminhao(objeto)
        return aceita, [], "objeto (itens indisponíveis)"
    com_termo = [i for i in itens if termos_encontrados(i.get("descricao"), termos)]
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
        return not inclui_caminhao(objeto), [], "objeto (itens de serviço)"
    uteis = [i for i in materiais if not item_agricola(i, objeto)]
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


def filtrar(itens, termos, agora, incluir_caminhao=False, descartados=None):
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
            if not objeto_generico(item.get("objetoCompra")):
                continue
            aceita, itens_impl, verificacao = avaliar_itens(item, termos, so_com_termo=True)
            if not itens_impl:  # nenhum item usa os termos, ou só itens agrícolas
                continue
            encontrados = list(dict.fromkeys(
                t for i in itens_impl for t in termos_encontrados(i.get("descricao"), termos)))
            if aceita or incluir_caminhao:
                yield montar_resultado(item, encontrados, itens_impl, verificacao)
            elif descartados is not None:
                descartados.append(item)
            continue
        if incluir_caminhao:
            yield montar_resultado(item, encontrados, verificacao="desligada")
            continue
        aceita, itens_impl, verificacao = avaliar_itens(item, termos)
        if aceita:
            yield montar_resultado(item, encontrados, itens_impl, verificacao)
        elif verificacao != "agrícola" and descartados is not None:
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


def salvar_csv(resultados, caminho):
    campos = list(resultados[0].keys()) if resultados else ["orgao"]
    # utf-8-sig + ';' abre direto no Excel em português
    with open(caminho, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=campos, delimiter=";")
        w.writeheader()
        w.writerows(resultados)
    print(f"CSV salvo em {caminho}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dias", type=int, default=60,
                    help="considera propostas que encerram até N dias a partir de hoje (padrão: 60)")
    ap.add_argument("--uf", help="filtra por UF (ex.: SP)")
    ap.add_argument("--modalidades", default=MODALIDADES_PADRAO,
                    help="códigos PNCP separados por vírgula (padrão: 6,7,4,5,8 = pregão e "
                         "concorrência, eletrônicos e presenciais, e dispensa)")
    ap.add_argument("--termos", default=str(ARQUIVO_TERMOS),
                    help="arquivo de termos por categoria (padrão: termos.txt ao lado do script)")
    ap.add_argument("--termo", action="append", default=[],
                    help="termo extra a procurar no objeto, além do arquivo (pode repetir)")
    ap.add_argument("--csv", help="também salva o resultado em CSV")
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

    itens = todas_as_modalidades()
    descartados = []
    resultados = list(filtrar(itens, termos, datetime.now(), args.incluir_caminhao, descartados))
    resultados.sort(key=lambda r: r["encerramento_proposta"] or "")

    imprimir(resultados)
    if descartados:
        print(f"\n{len(descartados)} pregão(ões) descartado(s) por incluir o caminhão "
              f"(use --incluir-caminhao para vê-los).")
    if paginas_falhas:
        print(f"\nATENÇÃO: a API falhou nas páginas {', '.join(paginas_falhas)} "
              f"({TAMANHO_PAGINA} pregões cada), que ficaram de fora. Rode de novo mais tarde.")
    if args.csv:
        salvar_csv(resultados, args.csv)


if __name__ == "__main__":
    main()
