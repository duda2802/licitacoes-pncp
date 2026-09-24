#!/usr/bin/env python3
"""
Consulta a API pública do PNCP e lista pregões eletrônicos com propostas
abertas cujo objeto contenha algum dos termos de termos.txt (implementos
rodoviários: tanques, coletores, caçambas, poliguindastes, plataformas etc.).

Endpoint: GET https://pncp.gov.br/api/consulta/v1/contratacoes/proposta
Manual:   https://pncp.gov.br/api/consulta/swagger-ui/index.html

Uso:
    python pncp_implementos.py                  # próximos 60 dias, todo o Brasil
    python pncp_implementos.py --uf MG --dias 30
    python pncp_implementos.py --csv resultado.csv
    python pncp_implementos.py --termos outro_arquivo.txt
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


def get_json(params, tentativas=4):
    """GET com retentativas (a API do PNCP oscila bastante)."""
    url = API_URL + "?" + urllib.parse.urlencode(params)
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                if resp.status == 204:  # sem conteúdo
                    return {"data": [], "totalPaginas": 0}
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if isinstance(exc, urllib.error.HTTPError) and exc.code < 500 and exc.code != 429:
                corpo = exc.read().decode("utf-8", "replace")
                raise SystemExit(f"Erro {exc.code} da API: {corpo}") from exc
            espera = 2 ** (i + 1)
            print(f"  falha ({exc}); nova tentativa em {espera}s...", file=sys.stderr)
            time.sleep(espera)
    raise SystemExit(f"Não foi possível consultar {url}")


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
        dados = get_json(params)
        total_paginas = dados.get("totalPaginas") or 0
        print(f"  página {pagina}/{total_paginas}", file=sys.stderr)
        yield from dados.get("data") or []
        if pagina >= total_paginas:
            break
        pagina += 1


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


def montar_resultado(item, encontrados):
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
        "encerramento_proposta": item.get("dataEncerramentoProposta", ""),
        "objeto": " ".join((item.get("objetoCompra") or "").split()),
        "termos": ", ".join(termo for _, termo in encontrados),
        "link_edital": link_edital(item),
        "link_sistema_origem": item.get("linkSistemaOrigem") or "",
        "numero_controle_pncp": item.get("numeroControlePNCP", ""),
    }


def filtrar(itens, termos, agora):
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
        if encontrados:
            yield montar_resultado(item, encontrados)


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
        print(f"    Encerra em:  {fim_txt}")
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
    args = ap.parse_args()

    termos = carregar_termos(args.termos)
    termos += [(CATEGORIA_EXTRA, t, termo_para_regex(t)) for t in args.termo]
    print(f"{len(termos)} termos carregados de {args.termos}", file=sys.stderr)
    data_final = date.today() + timedelta(days=args.dias)

    print(f"Consultando pregões eletrônicos com proposta aberta até "
          f"{data_final:%d/%m/%Y}{' em ' + args.uf.upper() if args.uf else ''}...", file=sys.stderr)
    itens = buscar_contratacoes(data_final, args.uf)
    resultados = list(filtrar(itens, termos, datetime.now()))
    resultados.sort(key=lambda r: r["encerramento_proposta"] or "")

    imprimir(resultados)
    if args.csv:
        salvar_csv(resultados, args.csv)


if __name__ == "__main__":
    main()
