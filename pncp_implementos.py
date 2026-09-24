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
MODALIDADE_PREGAO_ELETRONICO = 6
TAMANHO_PAGINA = 50  # máximo aceito pela API

# Arquivo com os termos procurados no objeto, agrupados por categoria.
ARQUIVO_TERMOS = Path(__file__).with_name("termos.txt")
CATEGORIA_EXTRA = "TERMO EXTRA"

# Entre as palavras de um termo aceita-se uma destas preposições (ou nenhuma):
# "tanque de água" casa "tanque para água", "tanque d'água" e "tanque água".
PREPOSICOES = ["de", "do", "da", "dos", "das", "d", "a", "em", "no", "na",
               "nos", "nas", "sobre", "para", "p"]

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


def termos_encontrados(objeto, termos):
    """Lista de (categoria, termo) cujo termo aparece no objeto."""
    obj = normalizar(objeto)
    return [(cat, termo) for cat, termo, rx in termos if rx.search(obj)]


# --- Caminhão junto com o implemento -------------------------------------
# "caminhão"/"veículo" no texto indica que o caminhão está sendo comprado,
# exceto quando aparece como destino do implemento: "caçamba PARA caminhão",
# "instalado NO caminhão", "tomada de força DO caminhão", "chassi DE caminhão".
RE_VEICULO = re.compile(r"\b(?:caminh(?:ao|oes)|veiculos?|cavalos? mecanicos?)\b")
DESTINO = {"para", "p", "em", "no", "na", "nos", "nas", "sobre", "sob", "ao", "aos",
           "do", "da", "dos", "das", "ate"}
ARTIGOS = {"o", "a", "os", "as", "um", "uma", "uns", "umas", "seu", "sua", "seus", "suas"}
# "... de caminhão" só é destino depois destas palavras ("chassi de caminhão")
ANTES_DE_DESTINO = {"chassi", "chassis", "modelo", "modelos", "marca", "marcas",
                    "frota", "cabine", "carroceria"}
# chassi fornecido junto: "com chassi", "chassi cabinado", "chassi 0 km"
RE_CHASSI_JUNTO = re.compile(
    r"\b(?:com|incluindo|inclusive|mais|e) (?:o |um )?chassis?\b"
    r"|\bchassis? (?:cabinad|com cabine|novo|0 ?km|zero)")


def inclui_caminhao(texto):
    """True se o texto indica compra do caminhão (não só do implemento)."""
    t = normalizar(texto)
    if RE_CHASSI_JUNTO.search(t):
        return True
    for m in RE_VEICULO.finditer(t):
        antes = [p for p in t[:m.start()].split() if p not in ARTIGOS]
        anterior = antes[-1] if antes else ""
        if anterior in DESTINO:
            continue
        if anterior == "de" and len(antes) > 1 and antes[-2] in ANTES_DE_DESTINO:
            continue
        return True
    return False


class ErroAPI(Exception):
    pass


def get_json(url, params, tentativas=4):
    """GET com retentativas (a API do PNCP oscila bastante)."""
    url = url + "?" + urllib.parse.urlencode(params)
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                if resp.status == 204:  # sem conteúdo
                    return None
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if isinstance(exc, urllib.error.HTTPError) and exc.code < 500 and exc.code != 429:
                corpo = exc.read().decode("utf-8", "replace")
                raise ErroAPI(f"Erro {exc.code} da API em {url}: {corpo}") from exc
            espera = 2 ** (i + 1)
            print(f"  falha ({exc}); nova tentativa em {espera}s...", file=sys.stderr)
            time.sleep(espera)
    raise ErroAPI(f"Não foi possível consultar {url}")


def buscar_contratacoes(data_final, uf=None):
    """Itera por todas as páginas de contratações com proposta aberta."""
    pagina = 1
    while True:
        params = {
            "dataFinal": data_final.strftime("%Y%m%d"),
            "codigoModalidadeContratacao": MODALIDADE_PREGAO_ELETRONICO,
            "pagina": pagina,
            "tamanhoPagina": TAMANHO_PAGINA,
        }
        if uf:
            params["uf"] = uf.upper()
        try:
            dados = get_json(API_URL, params) or {}
        except ErroAPI as exc:
            raise SystemExit(str(exc)) from exc
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


def avaliar_itens(compra, termos):
    """Decide se o pregão tem implemento sem caminhão.

    Retorna (aceita, itens_de_interesse, verificacao).
    """
    itens = buscar_itens(compra)
    if not itens:  # sem itens: decide só pelo objeto
        aceita = not inclui_caminhao(compra.get("objetoCompra"))
        return aceita, [], "objeto (itens indisponíveis)"
    com_termo = [i for i in itens if termos_encontrados(i.get("descricao"), termos)]
    implemento = [i for i in com_termo if not inclui_caminhao(i.get("descricao"))]
    if implemento:
        return True, implemento, "itens"
    if not com_termo and not any(inclui_caminhao(i.get("descricao")) for i in itens):
        # descrições dos itens não usam os termos, mas nenhum item é caminhão
        return not inclui_caminhao(compra.get("objetoCompra")), [], "itens (sem termo)"
    return False, [], "itens"


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
            continue
        if incluir_caminhao:
            yield montar_resultado(item, encontrados, verificacao="desligada")
            continue
        aceita, itens_impl, verificacao = avaliar_itens(item, termos)
        if aceita:
            yield montar_resultado(item, encontrados, itens_impl, verificacao)
        elif descartados is not None:
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

    print(f"Consultando pregões eletrônicos com proposta aberta até "
          f"{data_final:%d/%m/%Y}{' em ' + args.uf.upper() if args.uf else ''}...", file=sys.stderr)
    itens = buscar_contratacoes(data_final, args.uf)
    descartados = []
    resultados = list(filtrar(itens, termos, datetime.now(), args.incluir_caminhao, descartados))
    resultados.sort(key=lambda r: r["encerramento_proposta"] or "")

    imprimir(resultados)
    if descartados:
        print(f"\n{len(descartados)} pregão(ões) descartado(s) por incluir o caminhão "
              f"(use --incluir-caminhao para vê-los).")
    if args.csv:
        salvar_csv(resultados, args.csv)


if __name__ == "__main__":
    main()
