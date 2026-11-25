"""Rotina diária das planilhas de licitações (PNCP + Portal de Compras Públicas).

uso:
    python3 rotina/rotina_diaria.py                       # hoje, compara com a última rodada
    python3 rotina/rotina_diaria.py --anterior 2026-11-25 # compara com uma data
    python3 rotina/rotina_diaria.py --reusar              # reaproveita downloads do dia

Gera em planilhas/AAAA-MM-DD/ as 6 planilhas:
    licitacoes_DATA_implementos.xlsx                  (Implementos + Caminhão + implemento)
    licitacoes_DATA_caminhao_implemento_novo_e_usado.xlsx
    licitacoes_DATA_carretinhas.xlsx
    licitacoes_DATA_containers.xlsx
    licitacoes_DATA_compras_planejadas.xlsx
    licitacoes_DATA_galpao_obras.xlsx
e guarda em dados/AAAA-MM-DD/ o que a próxima rodada usa para marcar "Novo hoje"
(contratações, busca do site, itens, chaves de cada planilha).

Passos:
 1. lista COMPLETA de contratações com proposta aberta (5 modalidades), repetindo as
    páginas que falharem;
 2. busca do site do PNCP com TODOS os termos de termos.txt (acha o implemento nos
    itens), repetindo os termos que falharem até completar;
 3. filtros do pncp_implementos.py (implementos, caminhão + implemento, containers,
    obras, PCA);
 4. caminhão usado (compras que aceitam usado/seminovo; nunca leilão);
 5. carretinhas (reboques leves, carretas de barco/lancha/jet/moto);
 6. Portal de Compras Públicas: processos recebendo propostas com os termos que não
    estão no PNCP;
 7. conferência dos editais novos que não entraram (itens com cara de implemento).
"""
import argparse
import json
import os
import pickle
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))
import pncp_implementos as p  # noqa: E402

from openpyxl import Workbook, load_workbook  # noqa: E402
from openpyxl.styles import Alignment, Font, PatternFill  # noqa: E402
from openpyxl.utils import get_column_letter  # noqa: E402

LEILAO = {1, 13}
# variações usadas no lugar de "carroceria" e "prancha" sozinhos, que a busca do site
# quase nunca consegue completar
VARIANTES_SITE = ["semirreboque prancha", "reboque prancha", "caminhão prancha",
                  "carroceria de madeira", "carroceria metálica", "carroceria aberta",
                  "carroceria basculante", "prancha hidráulica"]
TERMOS_CARRETINHA = ["carretinha", "carretinha reboque", "carreta reboque", "reboque para moto",
                     "reboque para motocicleta", "carreta para moto", "carreta para barco",
                     "reboque para barco", "carreta embarcação", "carreta transporte embarcação",
                     "carreta para lancha", "carreta para jet ski", "carreta moto aquática",
                     "reboque rodoviário", "reboque de carga", "carreta rodoviária",
                     "reboque para bote"]
API_PCP = "https://compras.api.portaldecompraspublicas.com.br/v2/licitacao/processos"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def salvar_json(obj, caminho):
    tmp = str(caminho) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, caminho)


def ler_json(caminho, padrao=None):
    try:
        with open(caminho) as f:
            return json.load(f)
    except (OSError, ValueError):
        return padrao


# ---------------------------------------------------------------- 1. download completo
def baixar_modalidade(mod, data_final):
    """Todas as páginas de uma modalidade; páginas que falham são repetidas até 4 vezes."""
    def pagina(n):
        params = {"dataFinal": data_final.strftime("%Y%m%d"), "codigoModalidadeContratacao": mod,
                  "pagina": n, "tamanhoPagina": p.TAMANHO_PAGINA}
        return p.get_json(p.API_URL, params) or {}

    for tent in range(6):
        try:
            primeira = pagina(1)
            break
        except p.ErroAPI:
            time.sleep(30)
    else:
        raise SystemExit(f"modalidade {mod}: a primeira página não respondeu")
    total = primeira.get("totalPaginas") or 1
    dados = {1: primeira.get("data") or []}
    faltam = list(range(2, total + 1))
    for rodada in range(4):
        falhas = []
        with ThreadPoolExecutor(3) as ex:
            for n, res in zip(faltam, ex.map(lambda n: _tenta(pagina, n), faltam)):
                if res is None:
                    falhas.append(n)
                else:
                    dados[n] = res.get("data") or []
        log(f"  {p.MODALIDADES.get(mod, mod)}: {total - len(falhas)}/{total} páginas"
            + (f" (repetindo {len(falhas)})" if falhas else ""))
        faltam = falhas
        if not faltam:
            break
    return [c for n in sorted(dados) for c in dados[n]], faltam


def _tenta(f, *a):
    try:
        return f(*a)
    except p.ErroAPI:
        return None


def baixar_tudo(dados_dir, dias=90):
    data_final = date.today() + timedelta(days=dias)
    mods = [int(m) for m in p.MODALIDADES_PADRAO.split(",")]
    contr, falhas = [], {}
    with ThreadPoolExecutor(len(mods)) as ex:
        for mod, (lista, f) in zip(mods, ex.map(lambda m: baixar_modalidade(m, data_final), mods)):
            contr += lista
            if f:
                falhas[p.MODALIDADES.get(mod, mod)] = f
    salvar_json(contr, dados_dir / "contratacoes.json")
    return contr, falhas


# ---------------------------------------------------------------- 2. busca do site
def buscar_termo_site(termo, paginas=30):
    """(achados, editais, completou) de um termo na busca do site do PNCP."""
    achados, editais = set(), {}
    for pag in range(1, paginas + 1):
        params = {"q": termo, "tipos_documento": "edital", "ordenacao": "-data", "pagina": pag,
                  "tam_pagina": 100, "status": "recebendo_proposta"}
        try:
            d = p.get_json(p.API_BUSCA, params, tentativas=4) or {}
        except p.ErroAPI:
            return achados, editais, False
        itens = d.get("items") or []
        for i in itens:
            k = i.get("numero_controle_pncp")
            if k:
                achados.add(k)
                editais[k] = i
        if len(itens) < 100 or pag * 100 >= (d.get("total") or 0):
            break
    return achados, editais, True


def busca_site(termos, dados_dir, rodadas=5):
    arq_b, arq_e = dados_dir / "busca.json", dados_dir / "busca_editais.json"
    achados = set(ler_json(arq_b, []))
    editais = ler_json(arq_e, {})
    feitos = set(ler_json(dados_dir / "busca_termos_ok.json", []))
    faltam = [t for t in termos if t not in feitos]
    for rodada in range(rodadas):
        if not faltam:
            break
        log(f"  busca do site, rodada {rodada + 1}: {len(faltam)} termos")
        falhas = []
        with ThreadPoolExecutor(3) as ex:
            for t, (a, e, ok) in zip(faltam, ex.map(buscar_termo_site, faltam)):
                achados |= a
                editais.update(e)
                (feitos.add(t) if ok else falhas.append(t))
        # um único processo grava (rodar dois ao mesmo tempo perde resultados)
        salvar_json(sorted(achados), arq_b)
        salvar_json(editais, arq_e)
        salvar_json(sorted(feitos), dados_dir / "busca_termos_ok.json")
        faltam = falhas
        if faltam:
            time.sleep(20)
    return achados, editais, faltam


# ---------------------------------------------------------------- itens com cache
class CacheItens:
    def __init__(self, caminho, anterior=None):
        self.caminho = caminho
        self.dados = {}
        for c in (anterior, caminho):
            if c and Path(c).exists():
                try:
                    self.dados.update(pickle.load(open(c, "rb")))
                except Exception:
                    pass
        self.original = p.buscar_itens

    def buscar(self, compra, tamanho=50):
        k = compra.get("numeroControlePNCP")
        if k in self.dados:
            return self.dados[k]
        its = self.original(compra, tamanho)
        if its is not None:
            self.dados[k] = its
        return its

    def precarregar(self, compras, threads=6):
        falta = [c for c in compras if c.get("numeroControlePNCP") not in self.dados]
        with ThreadPoolExecutor(threads) as ex:
            list(ex.map(self.buscar, falta))
        self.salvar()

    def salvar(self):
        tmp = str(self.caminho) + ".tmp"
        pickle.dump(self.dados, open(tmp, "wb"))
        os.replace(tmp, self.caminho)


# ---------------------------------------------------------------- 4. caminhão usado
RE_USADO = re.compile(
    r"\b(?:usad[oa]s?|seminov[oa]s?|semi novo|novo ou usado|usado ou novo"
    r"|ano (?:de )?(?:fabricacao )?(?:e modelo )?(?:minimo|nao inferior a|igual ou superior a)"
    r"(?: de)? (?:19\d\d|20[01]\d|202[0-4])"
    r"|ano ?/? ?modelo (?:minimo |nao inferior a |igual ou superior a )?(?:de )?(?:19\d\d|20[01]\d|202[0-4])"
    r"|quilometragem maxima|km maxim\w*|maximo de \d[\d.]* ?km"
    r"|transformacao (?:de |do |dos )?caminh\w* usad\w*)")
RE_NEGA_USADO = re.compile(
    r"\b(?:nao (?:sera|serao) (?:aceit|admitid)\w*(?: \w+){0,3} usad"
    r"|vedad\w*(?: \w+){0,4} usad|proibid\w*(?: \w+){0,4} usad|sem uso|nunca usad"
    r"|(?:oleo|pneus?|baterias?|materiais?|equipamentos?|agua) usad)")
RE_CAMINHAO_OBJ = re.compile(r"\bcaminh(?:ao|oes)\b|\bcavalo mecanico\b|\btoco\b|\btruck\b")
RE_FORA_USADO = re.compile(r"\b(?:leil\w*|alienac\w*|trator\w*|agricol\w*|passeio|hatch|sedan"
                           r"|motocicleta\w*|onibus|micro ?onibus|ambulancia\w*|pecas|pneus?)\b")


def caminhao_usado(contr, cache):
    """Compras de caminhão (com ou sem implemento) que aceitam usado/seminovo."""
    agora = datetime.now()
    saida = []
    for c in contr:
        if c.get("modalidadeId") in LEILAO:
            continue
        fim = p.parse_data(c.get("dataEncerramentoProposta"))
        if fim and fim < agora:
            continue
        obj = p.normalizar(c.get("objetoCompra"))
        if p.RE_LOCACAO.search(obj) or p.RE_SERVICO_OBJETO.search(obj) or RE_FORA_USADO.search(obj):
            continue
        textos = [obj]
        its = cache.dados.get(c.get("numeroControlePNCP")) or []
        textos += [p.normalizar(i.get("descricao")) for i in its
                   if RE_CAMINHAO_OBJ.search(p.normalizar(i.get("descricao")))]
        sinal = None
        for t in textos:
            if not RE_CAMINHAO_OBJ.search(t) and t is not obj:
                continue
            m = RE_USADO.search(t)
            if m and not RE_NEGA_USADO.search(t):
                sinal = m.group(0)
                break
        if sinal and RE_CAMINHAO_OBJ.search(" ".join(textos)):
            saida.append({**c, "_sinal_usado": sinal})
    return saida


# ---------------------------------------------------------------- 5. carretinhas
RE_CARRETINHA = re.compile(
    r"\bcarretinhas?\b"
    r"|\b(?:carretas?|reboques?)\b(?: \w+){0,4} (?:transporte|para|p) "
    r"(?:\w+ ){0,3}(?:embarcac|lancha|barco|bote|jet|moto|caiaque|quadriciclo|cavalo|animal"
    r"|bagagem|carga|cargas)"
    r"|^\W*(?:\d+\W*)?(?:carretas?|reboques?) (?:reboque |tipo )?(?:rodoviari\w*|leve|de carga"
    r"|aberta|fechada|furgao|bau)\b"
    r"|^\W*(?:\d+\W*)?(?:carreta|reboque)(?: reboque)?\W*$")
RE_NAO_CARRETINHA = re.compile(
    r"\b(?:semirreboque|semi reboque|prancha|basculante|tanque|pipa|agricol\w*|tratorizad\w*"
    r"|graneleir\w*|forrage\w*|ensiladeira|motocultivador\w*|trator\w*|pecas?|acessorios?"
    r"|motorista|operador|cavalos? mecanicos?|engate$)\b")
RE_OBJ_CARRETINHA = re.compile(r"\b(?:carretinh\w*|carretas?|reboques?)\b")


def eh_carretinha(item):
    cab = " ".join(p.normalizar(item.get("descricao")).split()[:15])
    return (bool(RE_CARRETINHA.search(cab)) and not RE_NAO_CARRETINHA.search(cab)
            and not p.item_de_servico(item))


def carretinhas(contr, cache, achados_carretinha):
    agora_s = datetime.now().isoformat(timespec="minutes")
    cand = [c for c in contr
            if (RE_OBJ_CARRETINHA.search(p.normalizar(c.get("objetoCompra")))
                or c.get("numeroControlePNCP") in achados_carretinha)
            and (c.get("dataEncerramentoProposta") or "") >= agora_s
            and not p.RE_LOCACAO.search(p.normalizar(c.get("objetoCompra")))]
    cache.precarregar(cand)
    linhas, vistos = [], set()
    for c in cand:
        k = c.get("numeroControlePNCP")
        if k in vistos:
            continue
        vistos.add(k)
        sel = [i for i in (cache.dados.get(k) or []) if eh_carretinha(i)]
        if sel:
            linhas.append((c, sel))
    return linhas


# ---------------------------------------------------------------- 6. Portal de Compras Públicas
def _pcp_get(params):
    url = API_PCP + "?" + urllib.parse.urlencode(params)
    for t in range(5):
        try:
            with urllib.request.urlopen(url, timeout=40) as r:
                return json.load(r)
        except Exception:
            time.sleep(2 * (t + 1))
    return None


def portal_compras(termos):
    def um(t):
        res, pag = [], 1
        while True:
            d = _pcp_get({"objeto": t, "pagina": pag, "codigoStatus": 1})
            if d is None:
                return t, res, False
            res += d.get("result") or []
            if not d.get("nextPage") or pag >= 60:
                return t, res, True
            pag += 1
    achados, falhas = {}, []
    with ThreadPoolExecutor(6) as ex:
        for t, res, ok in ex.map(um, termos):
            if not ok:
                falhas.append(t)
            for r in res:
                achados.setdefault(r["codigoLicitacao"], r).setdefault("_termos", []).append(t)
    return achados, falhas


# ---------------------------------------------------------------- 7. conferência
RE_AUDITA = re.compile(
    r"\b(?:cacamba|basculante|tanque|pipa|comboio|melosa|bau|carroceria|prancha|reboque|carreta"
    r"|semirreboque|munck|guindaste|guindauto|poliguindaste|roll ?on|compactador|plataforma"
    r"|cesto aereo|cesta aerea|implemento|container|conteiner|contentor|hidrojato|limpa fossa)\w*")


def conferir_novos(contr, chaves_resultado, chaves_anteriores, cache):
    novos = [c for c in contr if c.get("numeroControlePNCP") not in chaves_anteriores
             and c.get("numeroControlePNCP") not in chaves_resultado
             and p.objeto_de_compra(c.get("objetoCompra"))
             and not p.RE_LOCACAO.search(p.normalizar(c.get("objetoCompra")))]
    cache.precarregar(novos)
    achados = []
    for c in novos:
        for i in cache.dados.get(c.get("numeroControlePNCP")) or []:
            d = " ".join(p.normalizar(i.get("descricao")).split()[:12])
            if RE_AUDITA.search(d) and not p.item_fora(i) and not p.item_de_servico(i):
                achados.append((c, i))
    return len(novos), achados


# ---------------------------------------------------------------- planilhas extras
AZUL = PatternFill("solid", fgColor="1F4E78")
AMARELO = PatternFill("solid", fgColor="FFF2CC")
F_BASE = Font(name="Arial", size=10)
F_CAB = Font(name="Arial", size=10, bold=True, color="FFFFFF")
F_LINK = Font(name="Arial", size=10, color="0563C1", underline="single")


def planilha(ws, colunas, linhas, nota):
    """colunas: (nome, largura); linhas: listas de valores; valor ('LINK', url) vira link."""
    agora = datetime.now()
    for c, (nome, larg) in enumerate(colunas, 1):
        x = ws.cell(1, c, nome)
        x.font, x.fill = F_CAB, AZUL
        x.alignment = Alignment(wrap_text=True, vertical="center")
        ws.column_dimensions[get_column_letter(c)].width = larg
    ws.freeze_panes = "B2"
    for r, valores in enumerate(linhas, 2):
        enc = None
        for c, v in enumerate(valores, 1):
            if isinstance(v, tuple) and v and v[0] == "LINK":
                x = ws.cell(r, c, "abrir" if v[1] else "")
                if v[1]:
                    x.hyperlink = urllib.parse.quote(v[1].strip(), safe=":/?&=%#+@,;~!$'()*-._")
                    x.font = F_LINK
                continue
            if isinstance(v, str):
                v = p.texto_para_excel(v)
            x = ws.cell(r, c, v)
            x.font = F_BASE
            x.alignment = Alignment(wrap_text=colunas[c - 1][1] >= 30, vertical="top")
            if isinstance(v, datetime):
                x.number_format = "dd/mm/yyyy hh:mm"
                enc = enc or v
            elif isinstance(v, float):
                x.number_format = '#,##0.00;-#,##0.00;"-"'
        if enc and (enc - agora).days < 2:
            for c in range(1, len(colunas) + 1):
                ws.cell(r, c).fill = AMARELO
    ws.auto_filter.ref = f"A1:{get_column_letter(len(colunas))}{len(linhas) + 1}"
    x = ws.cell(len(linhas) + 3, 1, nota)
    x.font = Font(name="Arial", size=9, italic=True, color="595959")


def num(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


CATEGORIAS_IMPL = [("Caçamba basculante", r"basculante|cacamba"), ("Tanque / pipa", r"pipa|tanque"),
                   ("Comboio / melosa", r"comboio|melosa"), ("Baú", r"\bbau\b|isoterm|frigorif|refrigerad"),
                   ("Carroceria", r"carroceria"), ("Prancha / plataforma", r"prancha|plataforma|auto socorro|guincho"),
                   ("Munck / guindaste", r"munck|guindaste|guindauto"), ("Cesto aéreo", r"cesto|cesta|elevatori"),
                   ("Coletor / compactador", r"compactador|coletor"), ("Poliguindaste / roll-on", r"poliguindaste|roll ?on"),
                   ("Hidrojato / vácuo", r"hidrojat|vacuo|limpa fossa|succao")]


def categoria_impl(texto):
    t = p.normalizar(texto)
    cats = [n for n, rx in CATEGORIAS_IMPL if re.search(rx, t)]
    return " | ".join(cats) or "Outro"


def salvar_combinado(caminho, descartados, usados, novo_de):
    linhas = []
    vistos = set()
    for c, cond in [(u, "Usado / seminovo aceito") for u in usados] + [(d, "Novo") for d in descartados]:
        k = c.get("numeroControlePNCP")
        if k in vistos:
            continue
        vistos.add(k)
        u = c.get("unidadeOrgao") or {}
        its = c.get("_itens") or []
        linhas.append([
            "NOVO" if novo_de(k) else "", p.parse_data(c.get("dataEncerramentoProposta")),
            cond + (f" ({c['_sinal_usado']})" if c.get("_sinal_usado") else ""),
            categoria_impl(c.get("objetoCompra", "") + " " + " ".join(i.get("descricao", "") for i in its)),
            (c.get("orgaoEntidade") or {}).get("razaoSocial", ""), u.get("municipioNome"), u.get("ufSigla"),
            c.get("modalidadeNome"), num(c.get("valorTotalEstimado")),
            " ".join((c.get("objetoCompra") or "").split()),
            ("LINK", p.link_edital(c)), ("LINK", c.get("linkSistemaOrigem") or ""), k])
    linhas.sort(key=lambda r: (r[1] or datetime.max))
    wb = Workbook()
    ws = wb.active
    ws.title = "Caminhão + implemento"
    planilha(ws, [("Novo hoje", 9), ("Encerra proposta", 17), ("Condição", 22), ("Implemento", 22),
                  ("Órgão", 36), ("Município", 18), ("UF", 5), ("Modalidade", 16),
                  ("Valor estimado (R$)", 16), ("Objeto", 70), ("Edital PNCP", 11),
                  ("Sistema de origem", 11), ("Nº controle PNCP", 27)], linhas,
             "Compra de caminhão com implemento, novo ou usado. 'Usado / seminovo aceito': o edital "
             "aceita usado, seminovo, ano mínimo antigo ou transformação de caminhão usado (nunca "
             "leilão). Linhas em amarelo: encerra em menos de 2 dias.")
    wb.save(caminho)
    return [r[-1] for r in linhas]


def salvar_carretinhas(caminho, linhas, novo_de):
    dados = []
    for c, sel in sorted(linhas, key=lambda r: r[0].get("dataEncerramentoProposta") or ""):
        u = c.get("unidadeOrgao") or {}
        k = c["numeroControlePNCP"]
        dados.append(["NOVO" if novo_de(k) else "", p.parse_data(c.get("dataEncerramentoProposta")),
                      c.get("modalidadeNome"), (c.get("orgaoEntidade") or {}).get("razaoSocial"),
                      u.get("municipioNome"), u.get("ufSigla"), num(c.get("valorTotalEstimado")),
                      round(sum(float(i.get("valorTotal") or 0) for i in sel), 2) or None,
                      p.formatar_itens(sel).replace(" || ", "\n"),
                      " ".join((c.get("objetoCompra") or "").split()), ("LINK", p.link_edital(c)), k])
    wb = Workbook()
    ws = wb.active
    ws.title = "Carretinhas"
    planilha(ws, [("Novo hoje", 9), ("Encerra proposta", 17), ("Modalidade", 16), ("Órgão", 36),
                  ("Município", 18), ("UF", 5), ("Valor estimado (R$)", 16),
                  ("Valor das carretinhas (R$)", 16), ("Itens", 60), ("Objeto", 60),
                  ("Edital PNCP", 11), ("Nº controle PNCP", 27)], dados,
             "Carretinhas e reboques leves (carga, barco, lancha, jet ski, moto). Agrícola, peças e "
             "aluguel ficam de fora. Linhas em amarelo: encerra em menos de 2 dias.")
    wb.save(caminho)
    return [r[-1] for r in dados]


def aba_portal_compras(caminho_impl, so_pcp):
    if not so_pcp:
        return
    wb = load_workbook(caminho_impl)
    ws = wb.create_sheet("Só no Portal de Compras")
    linhas = []
    for r in sorted(so_pcp, key=lambda r: r.get("dataHoraFinalPropostas") or ""):
        u = r.get("unidadeCompradora") or {}
        fim = (r.get("dataHoraFinalPropostas") or "")[:16]
        linhas.append([datetime.fromisoformat(fim) if fim else None, u.get("cidade"), u.get("uf"),
                       (r.get("tipoLicitacao") or {}).get("tipoLicitacao"), r.get("resumo"),
                       ", ".join(r.get("_termos", [])),
                       ("LINK", "https://www.portaldecompraspublicas.com.br/processos" + (r.get("urlReferencia") or ""))])
    planilha(ws, [("Encerra proposta", 17), ("Município", 18), ("UF", 5), ("Modalidade", 18),
                  ("Objeto (resumo)", 80), ("Termos", 30), ("Portal", 9)], linhas,
             "Processos recebendo propostas no Portal de Compras Públicas que ainda não apareceram no "
             "PNCP. Horário em UTC (3 h a mais que Brasília).")
    wb.save(caminho_impl)


# ---------------------------------------------------------------- "Novo hoje"
def chaves_de_xlsx(pasta):
    """Nº de controle PNCP de todas as planilhas de uma pasta (quando não há dados/)."""
    chaves = set()
    for f in Path(pasta).glob("*.xlsx"):
        try:
            wb = load_workbook(f, read_only=True)
        except Exception:
            continue
        for ws in wb.worksheets:
            linhas = ws.iter_rows(values_only=True)
            cab = next(linhas, None) or ()
            if "Nº controle PNCP" not in cab:
                continue
            i = cab.index("Nº controle PNCP")
            chaves |= {r[i] for r in linhas if r and len(r) > i and r[i]}
    return chaves


def ultima_rodada(antes_de):
    datas = sorted(d.name for d in (RAIZ / "planilhas").glob("20*-*-*") if d.name < antes_de)
    datas += sorted(d.name for d in (RAIZ / "dados").glob("20*-*-*") if d.name < antes_de)
    return max(datas) if datas else None


# ---------------------------------------------------------------- principal
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=date.today().isoformat())
    ap.add_argument("--anterior", help="data da rodada anterior (padrão: a última que existir)")
    ap.add_argument("--reusar", action="store_true", help="reaproveita o download e a busca do dia")
    ap.add_argument("--sem-pca", action="store_true")
    ap.add_argument("--sem-portal", action="store_true", help="não consulta o Portal de Compras Públicas")
    args = ap.parse_args()

    dia = args.data
    saida = RAIZ / "planilhas" / dia
    dados = RAIZ / "dados" / dia
    saida.mkdir(parents=True, exist_ok=True)
    dados.mkdir(parents=True, exist_ok=True)
    ant = args.anterior or ultima_rodada(dia)
    dados_ant = RAIZ / "dados" / ant if ant else None
    log(f"Rodada {dia}; anterior: {ant or 'nenhuma'}")

    # chaves da rodada anterior (para "Novo hoje")
    chaves_ant = ler_json(dados_ant / "chaves.json", None) if dados_ant else None
    if chaves_ant is None:
        todas = chaves_de_xlsx(RAIZ / "planilhas" / ant) if ant else set()
        chaves_ant = {"todas": sorted(todas)}
        log(f"  sem dados da rodada anterior; usando as planilhas ({len(todas)} chaves)")
    contr_ant = {c.get("numeroControlePNCP") for c in (ler_json(dados_ant / "contratacoes.json", [])
                                                      if dados_ant else [])}

    def novo_de(lista):
        if lista not in chaves_ant and (lista == "planejadas" or lista == "obras" and not chaves_ant.get("todas")):
            return lambda k: False
        anteriores = set(chaves_ant.get(lista, chaves_ant.get("todas", [])))
        return (lambda k: bool(anteriores) and k not in anteriores)

    # 1. download
    arq = dados / "contratacoes.json"
    if args.reusar and arq.exists():
        contr, falhas_dl = ler_json(arq), {}
    else:
        log("1. Baixando a lista completa do PNCP...")
        contr, falhas_dl = baixar_tudo(dados)
    log(f"   {len(contr)} contratações abertas" + (f"; páginas que falharam: {falhas_dl}" if falhas_dl else ""))

    # 2. busca do site
    termos = p.carregar_termos(p.ARQUIVO_TERMOS)
    termos_site = list(dict.fromkeys(
        [t for _, t, _ in termos if p.normalizar(t) not in ("carroceria", "prancha")]
        + p.TERMOS_BUSCA_SITE + VARIANTES_SITE + TERMOS_CARRETINHA))
    termos_site = [t for t in termos_site if p.normalizar(t) not in ("carroceria", "prancha")]
    log(f"2. Busca do site do PNCP ({len(termos_site)} termos)...")
    achados, editais, falhas_site = busca_site(termos_site, dados)
    p.EDITAIS_DO_SITE.update(editais)
    contr = p.completar_com_site(contr, achados, p.MODALIDADES_PADRAO)
    log(f"   {len(achados)} editais achados; termos sem resposta: {falhas_site or 'nenhum'}")

    # 3. filtros
    cache = CacheItens(dados / "itens.pkl", dados_ant / "itens.pkl" if dados_ant else None)
    p.buscar_itens = cache.buscar
    log("3. Filtrando (itens dos editais)...")
    agora = datetime.now()
    descartados = []
    resultados = list(p.filtrar(contr, termos, agora, False, descartados, achados))
    cache.salvar()
    resultados.sort(key=lambda r: r["encerramento_proposta"] or "")
    obras = sorted(p.filtrar_obras(contr, p.carregar_termos_obras(p.ARQUIVO_TERMOS_OBRAS), agora),
                   key=lambda r: r["encerramento_proposta"] or "")
    containers = [r for r in resultados if p.so_container(r)]
    implementos = [r for r in resultados if not p.so_container(r)]
    # sem itens só de serviço/fora na aba caminhão + implemento
    desc_ok = []
    for d in descartados:
        its = cache.dados.get(d.get("numeroControlePNCP"))
        if its and all(p.item_de_servico(i) or p.item_fora(i) for i in its):
            continue
        desc_ok.append(d)
    descartados = desc_ok

    planejadas = []
    if not args.sem_pca:
        log("   compras planejadas (PCA)...")
        arq_pca = dados / "pca.json"
        planos = ler_json(arq_pca) if args.reusar and arq_pca.exists() else None
        if planos is None:
            planos = []
            for ano in (date.today().year, date.today().year + 1):
                for classe in p.PCA_CLASSES:
                    try:
                        planos += list(p.buscar_pca(ano, classe))
                    except (p.ErroAPI, SystemExit) as e:
                        log(f"   PCA {ano}/{classe} falhou: {e}")
            salvar_json(planos, arq_pca)
        planejadas = list(p.filtrar_pca(planos, termos, date.today().isoformat()))

    # "Novo hoje" nas planilhas do pncp_implementos
    for lista, nome in ((implementos, "implementos"), (containers, "containers"), (obras, "obras")):
        e_novo = novo_de(nome)
        for r in lista:
            r["novo"] = "NOVO" if e_novo(r["numero_controle_pncp"]) else ""
    e_novo_pca = novo_de("planejadas")
    for r in planejadas:
        r["novo"] = "NOVO" if e_novo_pca(r.get("link_pca", "") + r.get("item", "")) else ""
    desc_res = [p.montar_resultado(d, d.get("_encontrados") or p.termos_encontrados(d.get("objetoCompra"), termos),
                                   d.get("_itens") or ()) for d in descartados]
    e_novo_desc = novo_de("caminhao")
    for r in desc_res:
        r["novo"] = "NOVO" if e_novo_desc(r["numero_controle_pncp"]) else ""
    base = saida / f"licitacoes_{dia}.xlsx"
    p.salvar_xlsx(str(base), implementos, desc_res, obras, containers, planejadas)

    # 4. caminhão usado + planilha combinada
    log("4. Caminhão usado...")
    usados = caminhao_usado(contr, cache)
    chaves_comb = salvar_combinado(saida / f"licitacoes_{dia}_caminhao_implemento_novo_e_usado.xlsx",
                                   descartados, usados, novo_de("combinado"))

    # 5. carretinhas
    log("5. Carretinhas...")
    achados_carr = set()
    for t in TERMOS_CARRETINHA:
        a, e, _ = buscar_termo_site(t, paginas=5)
        achados_carr |= a
        p.EDITAIS_DO_SITE.update(e)
    contr_carr = p.completar_com_site(contr, achados_carr, p.MODALIDADES_PADRAO)
    linhas_carr = carretinhas(contr_carr, cache, achados_carr)
    chaves_carr = salvar_carretinhas(saida / f"licitacoes_{dia}_carretinhas.xlsx", linhas_carr,
                                     novo_de("carretinhas"))

    # 6. Portal de Compras Públicas
    so_pcp = []
    if not args.sem_portal:
        log("6. Portal de Compras Públicas...")
        pcp, falhas_pcp = portal_compras(sorted({t for _, t, _ in termos}))
        links = " ".join((c.get("linkSistemaOrigem") or "") for c in contr)
        for cod, r in pcp.items():
            obj = p.normalizar(r.get("resumo"))
            if f"-{cod}" in links or p.RE_LOCACAO.search(obj) or p.RE_SERVICO_OBJETO.search(obj) \
                    or re.search(r"\bcredenciamento\b|prestacao de servic|agricol", obj):
                continue
            so_pcp.append(r)
        aba_portal_compras(f"{saida}/licitacoes_{dia}_implementos.xlsx", so_pcp)
        log(f"   {len(pcp)} processos com os termos; {len(so_pcp)} só no portal; falhas: {falhas_pcp or 'nenhuma'}")

    # 7. conferência dos editais novos
    log("7. Conferindo itens dos editais novos...")
    chaves_res = {r["numero_controle_pncp"] for r in resultados + desc_res} | set(chaves_carr) | set(chaves_comb)
    n_conf, suspeitos = conferir_novos(contr, chaves_res, contr_ant, cache) if contr_ant else (0, [])
    cache.salvar()

    # chaves para a próxima rodada
    salvar_json({"implementos": [r["numero_controle_pncp"] for r in implementos],
                 "containers": [r["numero_controle_pncp"] for r in containers],
                 "obras": [r["numero_controle_pncp"] for r in obras],
                 "planejadas": [r.get("link_pca", "") + r.get("item", "") for r in planejadas],
                 "caminhao": [r["numero_controle_pncp"] for r in desc_res],
                 "combinado": chaves_comb, "carretinhas": chaves_carr}, dados / "chaves.json")

    # resumo
    def n_novos(lst, campo="novo"):
        return sum(1 for r in lst if r.get(campo))
    print(f"\n== Rodada {dia} ==")
    print(f"implementos {len(implementos)} (novos {n_novos(implementos)}) | caminhão+impl {len(desc_res)} "
          f"(novos {n_novos(desc_res)}) | usados {len(usados)} | carretinhas {len(linhas_carr)} | "
          f"containers {len(containers)} (novos {n_novos(containers)}) | obras {len(obras)} "
          f"(novas {n_novos(obras)}) | planejadas {len(planejadas)} | só portal {len(so_pcp)}")
    if falhas_dl or falhas_site:
        print(f"ATENÇÃO, incompleto: páginas {falhas_dl} termos {falhas_site}")
    for titulo, lst in (("IMPLEMENTOS NOVOS", [r for r in implementos if r["novo"]]),
                        ("CAMINHÃO + IMPLEMENTO NOVOS", [r for r in desc_res if r["novo"]]),
                        ("CONTAINERS NOVOS", [r for r in containers if r["novo"]])):
        print(f"\n{titulo}:")
        for r in lst:
            print(f"  {r['encerramento_proposta'][:10]} {r['municipio']}/{r['uf']} {r['modalidade']} "
                  f"R$ {r['valor_estimado']} | {r['objeto'][:120]} | {r['link_edital']}")
    print("\nCAMINHÃO USADO:")
    for u in usados:
        un = u.get("unidadeOrgao") or {}
        print(f"  {(u.get('dataEncerramentoProposta') or '')[:10]} {un.get('municipioNome')}/{un.get('ufSigla')} "
              f"[{u['_sinal_usado']}] | {(u.get('objetoCompra') or '')[:110]} | {p.link_edital(u)}")
    print("\nCARRETINHAS:")
    for c, sel in linhas_carr:
        un = c.get("unidadeOrgao") or {}
        print(f"  {(c.get('dataEncerramentoProposta') or '')[:10]} {un.get('municipioNome')}/{un.get('ufSigla')} "
              f"| {sel[0].get('descricao', '')[:80]} | {p.link_edital(c)}")
    print("\nSÓ NO PORTAL DE COMPRAS:")
    for r in so_pcp:
        u = r.get("unidadeCompradora") or {}
        print(f"  {(r.get('dataHoraFinalPropostas') or '')[:10]} {u.get('cidade')}/{u.get('uf')} | {(r.get('resumo') or '')[:120]}")
    print(f"\nCONFERÊNCIA: {n_conf} editais novos fora das planilhas; itens suspeitos:")
    for c, i in suspeitos:
        un = c.get("unidadeOrgao") or {}
        print(f"  {un.get('municipioNome')}/{un.get('ufSigla')} R$ {i.get('valorTotal')} | "
              f"{(i.get('descricao') or '')[:110]} | {p.link_edital(c)}")
    print(f"\nPlanilhas em {saida}")


if __name__ == "__main__":
    main()
