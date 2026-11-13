/* Integração com o PNCP (Portal Nacional de Contratações Públicas).
 *
 * Como funciona:
 *  1. Busca no PNCP os contratos/empenhos em que o fornecedor é um dos seus CNPJs
 *     (API de busca do portal, a mesma usada em pncp.gov.br).
 *  2. Agrupa por licitação de origem (numero_contratacao).
 *  3. Ao importar, completa com os dados da licitação, da ata de registro de preços
 *     e dos itens que você ganhou (resultado por item).
 *
 * Todas as APIs usadas são públicas e aceitam chamadas do navegador (CORS liberado). */
(() => {
  'use strict';

  const API = 'https://pncp.gov.br/api';
  const APP_URL = 'https://pncp.gov.br/app';
  const App = window.App;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = App.esc;

  // Tipos de "contrato" no PNCP que, para o fornecedor, são pedidos de fornecimento.
  // 7 = Empenho, 8 = Outros (AF/OF), 12 = Carta contrato
  const TIPOS_PEDIDO = new Set([7, 8, 12]);

  // ---------- Rede ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let cancelado = false;

  async function getJSON(url, tentativas = 5) {
    let ultimoErro;
    for (let i = 0; i < tentativas; i++) {
      if (cancelado) throw new Error('cancelado');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      try {
        const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (r.status === 204 || r.status === 404) return null;
        if (r.ok) return await r.json();
        ultimoErro = new Error(`PNCP respondeu ${r.status}`);
        if (r.status < 500 && r.status !== 429) throw ultimoErro;
      } catch (e) {
        ultimoErro = e;
        if (e.message && e.message.startsWith('PNCP respondeu 4')) throw e;
      } finally {
        clearTimeout(timer);
      }
      await sleep(500 * 2 ** i);
    }
    throw ultimoErro || new Error('Falha ao consultar o PNCP');
  }

  /** Executa fn em paralelo (n por vez). */
  async function pool(lista, n, fn) {
    const out = new Array(lista.length);
    let idx = 0;
    await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => {
      while (idx < lista.length) {
        const i = idx++;
        out[i] = await fn(lista[i], i);
      }
    }));
    return out;
  }

  // ---------- Identificadores do PNCP ----------
  const soDigitos = (s) => String(s || '').replace(/\D/g, '');

  /** "12075748000132-1-000155/2025" -> {cnpj, ano, seq} */
  function parseCompra(id) {
    const m = /^(\d{14})-\d+-(\d+)\/(\d{4})$/.exec(id || '');
    return m ? { cnpj: m[1], seq: +m[2], ano: +m[3] } : null;
  }
  /** "12075748000132-1-000155/2025-000006" -> {cnpj, ano, seq, seqAta} */
  function parseAta(id) {
    const m = /^(\d{14})-\d+-(\d+)\/(\d{4})-(\d+)$/.exec(id || '');
    return m ? { cnpj: m[1], seq: +m[2], ano: +m[3], seqAta: +m[4] } : null;
  }
  const linkCompra = (c) => `${APP_URL}/editais/${c.cnpj}/${c.ano}/${c.seq}`;

  /** Normaliza um contrato vindo da busca ou do detalhe. */
  function normalizarBusca(i) {
    return {
      id: i.numero_controle_pncp,
      compra: i.numero_contratacao || null,
      tipoId: Number(i.tipo_contrato_id),
      tipoNome: i.tipo_contrato_nome,
      numero: i.numero_contrato_empenho || i.title,
      valor: Number(i.valor_global) || 0,
      assinatura: i.data_assinatura || (i.createdAt || '').slice(0, 10),
      vigIni: i.data_inicio_vigencia,
      vigFim: i.data_fim_vigencia,
      orgao: i.orgao_nome,
      orgaoCnpj: i.orgao_cnpj,
      objeto: i.description || '',
      fornecedor: soDigitos(i.fornecedor_ni),
      fornecedorNome: i.fornecedor_nome || '',
      link: i.item_url ? APP_URL + i.item_url : '',
      modalidade: i.modalidade_licitacao_nome,
      cancelado: !!i.cancelado,
    };
  }
  function normalizarDetalhe(d) {
    const [cnpj, , seqAno] = (d.numeroControlePNCP || '').split('-');
    const [seq, ano] = (seqAno || '').split('/');
    return {
      id: d.numeroControlePNCP,
      compra: d.numeroControlePncpCompra || null,
      ata: d.numeroControlePncpAta || null,
      tipoId: Number(d.tipoContrato?.id),
      tipoNome: d.tipoContrato?.nome,
      numero: d.numeroContratoEmpenho,
      valor: Number(d.valorGlobal) || 0,
      assinatura: d.dataAssinatura,
      vigIni: d.dataVigenciaInicio,
      vigFim: d.dataVigenciaFim,
      orgao: d.orgaoEntidade?.razaoSocial,
      orgaoCnpj: d.orgaoEntidade?.cnpj,
      objeto: d.objetoContrato || '',
      fornecedor: soDigitos(d.niFornecedor),
      link: cnpj ? `${APP_URL}/contratos/${cnpj}/${Number(ano)}/${Number(seq)}` : '',
      cancelado: false,
    };
  }

  // ---------- Consultas ----------
  /** Contratos/empenhos de um fornecedor, do mais recente para o mais antigo, até a data `desde`. */
  async function buscarContratosFornecedor(cnpj, desde, progresso) {
    const tam = 100;
    const out = [];
    for (let pagina = 1; ; pagina++) {
      const url = `${API}/search/?q=${cnpj}&tipos_documento=contrato&ordenacao=-data&pagina=${pagina}&tam_pagina=${tam}&status=todos`;
      const r = await getJSON(url, 8);
      const itens = r?.items || [];
      let passouData = false;
      for (const i of itens) {
        const c = normalizarBusca(i);
        if (c.assinatura && c.assinatura < desde) { passouData = true; continue; }
        if (c.fornecedor === cnpj && !c.cancelado) out.push(c);
      }
      progresso?.(`CNPJ ${App.fmtCnpj(cnpj)}: ${out.length} contratos/empenhos encontrados…`);
      if (!itens.length || passouData || pagina * tam >= (r.total || 0)) break;
    }
    return out;
  }

  const getCompra = (c) => getJSON(`${API}/consulta/v1/orgaos/${c.cnpj}/compras/${c.ano}/${c.seq}`);
  const getAta = (a) => getJSON(`${API}/pncp/v1/orgaos/${a.cnpj}/compras/${a.ano}/${a.seq}/atas/${a.seqAta}`);
  const getContratoDetalhe = (cnpj, ano, seq) => getJSON(`${API}/pncp/v1/orgaos/${cnpj}/contratos/${ano}/${seq}`);

  /** Itens da licitação que foram homologados para algum dos CNPJs. */
  async function buscarItensGanhos(c, cnpjs, progresso) {
    const itens = [];
    for (let pagina = 1; pagina < 50; pagina++) {
      const r = await getJSON(`${API}/pncp/v1/orgaos/${c.cnpj}/compras/${c.ano}/${c.seq}/itens?pagina=${pagina}&tamanhoPagina=100`);
      if (!r || !r.length) break;
      itens.push(...r);
      if (r.length < 100) break;
    }
    const comResultado = itens.filter((i) => i.temResultado);
    let feitos = 0;
    const ganhos = [];
    await pool(comResultado, 6, async (item) => {
      const res = await getJSON(`${API}/pncp/v1/orgaos/${c.cnpj}/compras/${c.ano}/${c.seq}/itens/${item.numeroItem}/resultados`).catch(() => null);
      for (const r of res || []) {
        if (r.dataCancelamento || !cnpjs.includes(soDigitos(r.niFornecedor))) continue;
        ganhos.push({
          numero: item.numeroItem,
          descricao: item.descricao,
          unidade: item.unidadeMedida,
          quantidade: Number(r.quantidadeHomologada) || 0,
          valorUnit: Number(r.valorUnitarioHomologado) || 0,
          valorTotal: Number(r.valorTotalHomologado) || 0,
        });
      }
      feitos++;
      if (feitos % 5 === 0 || feitos === comResultado.length) progresso?.(`itens ${feitos}/${comResultado.length}`);
    });
    return ganhos.sort((a, b) => a.numero - b.numero);
  }

  // ---------- Conversão para o modelo do site ----------
  function mapModalidade(nome = '') {
    const n = nome.toLowerCase();
    if (n.includes('pregão') && n.includes('eletr')) return 'Pregão eletrônico';
    if (n.includes('pregão')) return 'Pregão presencial';
    if (n.includes('concorr')) return 'Concorrência';
    if (n.includes('dispensa')) return 'Dispensa';
    if (n.includes('inexig')) return 'Inexigibilidade';
    return 'Outra';
  }
  const diffDias = (a, b) => Math.round((App.parseData(b) - App.parseData(a)) / 86400000);

  function idsConhecidos() {
    const s = new Set();
    for (const l of App.db().licitacoes) {
      if (l.pncp?.contrato) s.add(l.pncp.contrato);
      for (const p of l.pedidos || []) if (p.pncp) s.add(p.pncp);
    }
    return s;
  }
  const licPorCompra = (key) => App.db().licitacoes.find((l) => l.pncp?.compra === key);

  function contratoParaPedido(lic, c, opcoes = {}) {
    let prazo = '';
    if (c.assinatura && c.vigFim) {
      const d = diffDias(c.assinatura, c.vigFim);
      if (d > 0 && d <= 180) prazo = String(d); // vigência curta de empenho/AF ≈ prazo de entrega
    }
    const p = {
      id: App.uid(),
      numero: c.numero || c.id,
      valor: c.valor,
      dataRecebimento: c.assinatura || '',
      prazoDias: prazo,
      descricao: c.objeto && c.objeto !== lic.objeto ? c.objeto.slice(0, 160) : '',
      orgao: c.orgao && c.orgao !== lic.orgao ? c.orgao : '',
      dataEntrega: '', nf: '', dataNF: '', dataPagamento: '', obs: '', anexos: [],
      pncp: c.id,
      link: c.link,
    };
    if (opcoes.concluidosAte && p.dataRecebimento && p.dataRecebimento < opcoes.concluidosAte) {
      const venc = prazo ? App.toISO(new Date(App.parseData(p.dataRecebimento).getTime() + prazo * 86400000)) : p.dataRecebimento;
      p.dataEntrega = venc;
      p.dataPagamento = venc;
      p.obs = 'Marcado como concluído na importação do PNCP.';
    }
    return p;
  }

  /** Cria/atualiza uma licitação a partir de um grupo do PNCP. Retorna {lic, novos}. */
  async function importarGrupo(grupo, opcoes, progresso) {
    const cnpjs = cnpjsEmpresas();
    const conhecidos = idsConhecidos();
    const novos = grupo.contratos.filter((c) => !conhecidos.has(c.id));
    const compraId = grupo.key.startsWith('avulso:') ? null : grupo.key;
    const c = parseCompra(compraId);
    let lic = compraId ? licPorCompra(compraId) : null;
    const criada = !lic;

    if (!lic) {
      const base = grupo.contratos[0] || {};
      lic = {
        id: App.uid(), pedidos: [], anexos: [], resultado: 'ganha', analista: '', situacao: '', etapas: {},
        empresaId: empresaPorCnpj(base.fornecedor)?.id || '', orgaoCnpj: '', uasg: '', processo: '',
        orgao: base.orgao || '', numero: base.numero || '', modalidade: mapModalidade(base.modalidade),
        objeto: base.objeto || '', dataSessao: '', valor: 0, link: base.link || '',
        instrumento: '', numeroInstrumento: '', vigenciaInicio: '', vigenciaFim: '',
        prazoEntregaDias: '', prazoPagamentoDias: '', contato: '', obs: '',
        pncp: { compra: compraId },
      };
      if (c) {
        progresso?.('dados da licitação…');
        const compra = await getCompra(c).catch(() => null);
        if (compra) {
          lic.orgao = compra.orgaoEntidade?.razaoSocial || lic.orgao;
          const num = compra.numeroCompra || '';
          lic.numero = num.includes('/') ? num : `${num}/${compra.anoCompra}`;
          lic.modalidade = mapModalidade(compra.modalidadeNome);
          lic.objeto = compra.objetoCompra || lic.objeto;
          lic.dataSessao = (compra.dataAberturaProposta || '').slice(0, 10);
          lic.pncp.srp = !!compra.srp;
          lic.processo = compra.processo || '';
          lic.orgaoCnpj = compra.orgaoEntidade?.cnpj || '';
          lic.uasg = compra.unidadeOrgao?.codigoUnidade || '';
        }
        lic.link = linkCompra(c);
      }
    }

    // Ata de registro de preços (descoberta pelo detalhe de um dos contratos)
    let ataId = grupo.ata || lic.pncp?.ata || null;
    if (!ataId && c && !lic.numeroInstrumento && grupo.contratos.length) {
      const ref = grupo.contratos[0];
      const m = /^(\d{14})-\d+-(\d+)\/(\d{4})$/.exec(ref.id || '');
      if (m) {
        const det = await getContratoDetalhe(m[1], m[3], +m[2]).catch(() => null);
        ataId = det?.numeroControlePncpAta || null;
      }
    }
    if (ataId && !lic.numeroInstrumento) {
      progresso?.('ata de registro de preços…');
      const ata = await getAta(parseAta(ataId)).catch(() => null);
      if (ata) {
        lic.instrumento = 'ata';
        lic.numeroInstrumento = ata.numeroAtaRegistroPreco || '';
        lic.vigenciaInicio = ata.dataVigenciaInicio || '';
        lic.vigenciaFim = ata.dataVigenciaFim || '';
        lic.pncp.ata = ataId;
        // Ata publicada no PNCP: já foi assinada pelas duas partes.
        const d = ata.dataAssinatura || ata.dataVigenciaInicio || '';
        let pub = (ata.dataPublicacaoPncp || '').slice(0, 10) || d;
        if (d && pub < d) pub = d;
        lic.etapas = { recebido: lic.etapas?.recebido || d, assinadoNos: lic.etapas?.assinadoNos || d, assinadoOrgao: lic.etapas?.assinadoOrgao || d, publicado: lic.etapas?.publicado || pub };
      }
    }

    // Contratos e empenhos
    for (const ct of novos.sort((a, b) => (a.assinatura || '').localeCompare(b.assinatura || ''))) {
      const ehPedido = TIPOS_PEDIDO.has(ct.tipoId) || lic.instrumento === 'ata' || !!lic.numeroInstrumento;
      if (ehPedido) {
        lic.pedidos.push(contratoParaPedido(lic, ct, opcoes));
      } else {
        lic.instrumento = 'contrato';
        lic.numeroInstrumento = ct.numero || '';
        lic.vigenciaInicio = ct.vigIni || '';
        lic.vigenciaFim = ct.vigFim || '';
        if (!lic.valor) lic.valor = ct.valor;
        lic.pncp.contrato = ct.id;
        if (!lic.link) lic.link = ct.link;
        const d = ct.assinatura || ct.vigIni || '';
        lic.etapas = { recebido: d, assinadoNos: d, assinadoOrgao: d, publicado: d, ...Object.fromEntries(Object.entries(lic.etapas || {}).filter(([, v]) => v)) };
      }
    }
    if (!lic.instrumento) lic.instrumento = 'empenho';
    if (!lic.empresaId) lic.empresaId = empresaPorCnpj(grupo.contratos[0]?.fornecedor)?.id || (App.db().config.empresas.length === 1 ? App.db().config.empresas[0].id : '');

    // Itens ganhos (define o valor ganho em atas)
    if (opcoes.itens && c && !lic.itens) {
      progresso?.('itens ganhos…');
      try {
        lic.itens = await buscarItensGanhos(c, cnpjs, (m) => progresso?.(m));
        const total = lic.itens.reduce((s, i) => s + i.valorTotal, 0);
        if (total && (lic.instrumento !== 'contrato' || !lic.valor)) lic.valor = total;
      } catch (e) {
        if (e.message === 'cancelado') throw e;
      }
    }

    if (!lic.valor) lic.valor = lic.pedidos.reduce((s, p) => s + (Number(p.valor) || 0), 0);
    if (!lic.prazoEntregaDias) {
      const prazos = lic.pedidos.map((p) => p.prazoDias).filter(Boolean);
      if (prazos.length) lic.prazoEntregaDias = moda(prazos);
    }
    lic.pncp.atualizado = new Date().toISOString();

    if (criada) App.db().licitacoes.push(lic);
    return { lic, novos: novos.length, criada };
  }
  function moda(arr) {
    const c = {};
    for (const x of arr) c[x] = (c[x] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
  }

  // ---------- Interface ----------
  let grupos = [];
  const status = (msg, tipo = '') => {
    const el = $('#pncp-status');
    el.hidden = !msg;
    el.className = 'pncp-status ' + tipo;
    el.textContent = msg || '';
  };
  const ocupado = (sim) => {
    $('#pncp-buscar').disabled = sim;
    $('#pncp-importar').disabled = sim;
    $('#pncp-link-btn').disabled = sim;
    $('#pncp-cancelar').hidden = !sim;
    cancelado = false;
  };

  const cnpjsEmpresas = () => App.db().config.empresas.map((e) => e.cnpj).filter((c) => c && c.length === 14);
  const empresaPorCnpj = (c) => App.db().config.empresas.find((e) => e.cnpj === c);
  function lerCnpjs() { return cnpjsEmpresas(); }
  function renderEmpresasPncp() {
    const emp = App.db().config.empresas;
    $('#pncp-empresas').innerHTML = emp.length
      ? `<div class="muted small">Empresas que serão buscadas:</div><div class="tags">${emp.map((e) => `<span class="tag">${esc(e.nome || 'Sem nome')} <span class="mono">${App.fmtCnpj(e.cnpj)}</span></span>`).join('')}</div>
         <button type="button" class="link" data-editar-empresas>Editar empresas</button>`
      : `<p class="pncp-aviso">Cadastre o CNPJ das empresas do grupo para buscar no PNCP. <button type="button" class="btn small primary" data-editar-empresas>Cadastrar empresas</button></p>`;
  }

  function lerOpcoes() {
    const concluidosAte = $('#pncp-concluidos').value || '';
    App.db().config.concluidosAte = concluidosAte;
    return { itens: $('#pncp-itens').checked, concluidosAte };
  }

  function preencherConfig() {
    const cfg = App.db().config;
    renderEmpresasPncp();
    if (!$('#pncp-desde').value) {
      const d = App.hoje();
      d.setMonth(d.getMonth() - 18);
      $('#pncp-desde').value = App.toISO(d);
    }
    if (!$('#pncp-concluidos').dataset.init) {
      $('#pncp-concluidos').dataset.init = '1';
      if (cfg.concluidosAte !== undefined) $('#pncp-concluidos').value = cfg.concluidosAte;
      else { const d = App.hoje(); d.setDate(d.getDate() - 60); $('#pncp-concluidos').value = App.toISO(d); }
    }
    $('#pncp-ultima').textContent = cfg.ultimaSync
      ? `Última busca: ${new Date(cfg.ultimaSync).toLocaleString('pt-BR')}`
      : 'Ainda não buscou no PNCP.';
  }

  async function buscar() {
    const cnpjs = lerCnpjs();
    if (!cnpjs) return;
    if (!cnpjs.length) { status('Cadastre pelo menos uma empresa com CNPJ (botão “Empresas e analistas”).', 'erro'); return; }
    const desde = $('#pncp-desde').value || '2000-01-01';
    ocupado(true);
    grupos = [];
    renderGrupos();
    try {
      const todos = [];
      for (const cnpj of cnpjs) todos.push(...await buscarContratosFornecedor(cnpj, desde, (m) => status(m)));
      // Completa o nome das empresas cadastradas só com CNPJ
      for (const emp of App.db().config.empresas) {
        if (!emp.nome) emp.nome = todos.find((c) => c.fornecedor === emp.cnpj && c.fornecedorNome)?.fornecedorNome || '';
      }
      const mapa = new Map();
      for (const ct of todos) {
        const key = ct.compra || 'avulso:' + ct.id;
        if (!mapa.has(key)) mapa.set(key, { key, contratos: [] });
        mapa.get(key).contratos.push(ct);
      }
      const conhecidos = idsConhecidos();
      grupos = [...mapa.values()].map((g) => {
        g.lic = g.key.startsWith('avulso:') ? null : licPorCompra(g.key);
        g.novos = g.contratos.filter((c) => !conhecidos.has(c.id)).length;
        g.total = g.contratos.reduce((s, c) => s + c.valor, 0);
        g.ultima = g.contratos.reduce((m, c) => (c.assinatura > m ? c.assinatura : m), '');
        g.sel = g.novos > 0;
        return g;
      }).sort((a, b) => b.ultima.localeCompare(a.ultima));
      App.db().config.ultimaSync = new Date().toISOString();
      App.salvar(false);
      preencherConfig();
      const novos = grupos.filter((g) => g.novos).length;
      status(todos.length
        ? `${todos.length} contratos/empenhos em ${grupos.length} licitações. ${novos ? novos + ' com novidades.' : 'Tudo já está importado.'}`
        : 'Nenhum contrato ou empenho encontrado para esses CNPJs no período.', todos.length ? 'ok' : '');
    } catch (e) {
      status(e.message === 'cancelado' ? 'Busca cancelada.' : `Não foi possível consultar o PNCP agora (${e.message}). Tente novamente em alguns minutos.`, 'erro');
    } finally {
      ocupado(false);
      renderGrupos();
    }
  }

  function renderGrupos() {
    const tbody = $('#pncp-tabela tbody');
    $('#pncp-resultados').hidden = !grupos.length;
    tbody.innerHTML = grupos.map((g, i) => {
      const c = g.contratos[0];
      const comp = parseCompra(g.key);
      const orgaos = new Set(g.contratos.map((x) => x.orgao)).size;
      const estado = g.lic
        ? (g.novos ? `<span class="badge warn">+${g.novos} novo${g.novos > 1 ? 's' : ''}</span>` : '<span class="badge ok">Importada</span>')
        : '<span class="badge info">Nova</span>';
      return `<tr>
        <td><input type="checkbox" data-i="${i}" ${g.sel ? 'checked' : ''} ${g.novos ? '' : 'disabled'} aria-label="Selecionar"></td>
        <td><strong>${esc(g.lic?.orgao || c.orgao)}</strong>${!g.lic && orgaos > 1 ? ` <span class="muted">+ ${orgaos - 1} órgão${orgaos > 2 ? 's' : ''}</span>` : ''}
          <div class="muted">${g.lic ? esc(g.lic.numero) : comp ? `Compra ${comp.seq}/${comp.ano}` : esc(c.tipoNome || 'Contrato')}${comp ? ` · <a href="${linkCompra(comp)}" target="_blank" rel="noopener">PNCP ↗</a>` : ''}</div></td>
        <td>${esc((g.lic?.objeto || c.objeto || '').slice(0, 140))}</td>
        <td class="num">${g.contratos.length}</td>
        <td class="num">${App.fmtMoeda(g.total)}</td>
        <td>${App.fmtData(g.ultima)}</td>
        <td>${estado}</td>
      </tr>`;
    }).join('');
    atualizarBotaoImportar();
  }
  function atualizarBotaoImportar() {
    const n = grupos.filter((g) => g.sel && g.novos).length;
    $('#pncp-importar').textContent = n ? `Importar ${n} selecionada${n > 1 ? 's' : ''}` : 'Importar selecionadas';
    $('#pncp-importar').disabled = !n;
    const todos = $('#pncp-todos');
    const habilit = grupos.filter((g) => g.novos);
    todos.checked = habilit.length > 0 && habilit.every((g) => g.sel);
  }

  async function importarSelecionados() {
    const sel = grupos.filter((g) => g.sel && g.novos);
    if (!sel.length) return;
    ocupado(true);
    const opcoes = lerOpcoes();
    let criadas = 0, pedidos = 0, falhas = 0;
    try {
      for (const [n, g] of sel.entries()) {
        const pref = `Importando ${n + 1}/${sel.length} — ${g.lic?.orgao || g.contratos[0].orgao}: `;
        try {
          const r = await importarGrupo(g, opcoes, (m) => status(pref + m));
          if (r.criada) criadas++;
          pedidos += r.novos;
          App.salvar(false);
        } catch (e) {
          if (e.message === 'cancelado') throw e;
          falhas++;
        }
      }
      status(`Pronto: ${criadas} licitações novas e ${pedidos} contratos/empenhos importados${falhas ? `; ${falhas} com erro (tente de novo)` : ''}. Confira prazos de entrega e pagamento em cada uma.`, falhas ? 'erro' : 'ok');
    } catch (e) {
      status('Importação cancelada. O que já foi importado ficou salvo.', 'erro');
    } finally {
      // recalcula estado dos grupos
      const conhecidos = idsConhecidos();
      for (const g of grupos) {
        g.lic = g.key.startsWith('avulso:') ? App.db().licitacoes.find((l) => l.pedidos?.some((p) => p.pncp === g.contratos[0].id) || l.pncp?.contrato === g.contratos[0].id) : licPorCompra(g.key);
        g.novos = g.contratos.filter((c) => !conhecidos.has(c.id)).length;
        g.sel = false;
      }
      ocupado(false);
      App.salvar();
      renderGrupos();
    }
  }

  /** Importa a partir de um link do PNCP (edital, ata ou contrato). */
  async function importarLink() {
    const url = $('#pncp-link').value.trim();
    const cnpjs = lerCnpjs();
    if (!cnpjs) return;
    let m;
    let grupo = null;
    ocupado(true);
    try {
      if ((m = /\/editais\/(\d{14})\/(\d{4})\/(\d+)/.exec(url))) {
        grupo = { key: `${m[1]}-1-${m[3].padStart(6, '0')}/${m[2]}`, contratos: [] };
      } else if ((m = /\/atas\/(\d{14})\/(\d{4})\/(\d+)\/(\d+)/.exec(url))) {
        const key = `${m[1]}-1-${m[3].padStart(6, '0')}/${m[2]}`;
        grupo = { key, contratos: [], ata: `${key}-${m[4].padStart(6, '0')}` };
      } else if ((m = /\/contratos\/(\d{14})\/(\d{4})\/(\d+)/.exec(url))) {
        status('Lendo contrato…');
        const det = await getContratoDetalhe(m[1], m[2], m[3]);
        if (!det) throw new Error('Contrato não encontrado no PNCP');
        const ct = normalizarDetalhe(det);
        grupo = { key: ct.compra || 'avulso:' + ct.id, contratos: [ct], ata: ct.ata };
      } else {
        status('Cole um link do PNCP de edital (…/app/editais/…), ata (…/app/atas/…) ou contrato (…/app/contratos/…).', 'erro');
        return;
      }
      if (!cnpjs.length && $('#pncp-itens').checked) status('Dica: cadastre o CNPJ das empresas para o site identificar os itens ganhos.');
      const r = await importarGrupo(grupo, { ...lerOpcoes(), itens: $('#pncp-itens').checked && cnpjs.length > 0 }, (msg) => status('Importando: ' + msg));
      App.salvar();
      $('#pncp-link').value = '';
      status(r.criada ? `Licitação importada: ${r.lic.orgao} — ${r.lic.numero}.` : `Licitação atualizada: ${r.lic.orgao} — ${r.lic.numero}.`, 'ok');
      App.abrirDetalhe(r.lic.id);
    } catch (e) {
      status(e.message === 'cancelado' ? 'Cancelado.' : `Não foi possível importar (${e.message}).`, 'erro');
    } finally {
      ocupado(false);
    }
  }

  /** Atualiza uma licitação já importada (novos empenhos). Usado no detalhe. */
  async function atualizarLicitacao(lic) {
    const cnpjs = cnpjsEmpresas();
    if (!lic.pncp?.compra || !cnpjs.length) return;
    App.toast('Buscando novidades no PNCP…');
    try {
      const desde = lic.dataSessao || '2000-01-01';
      const todos = [];
      for (const cnpj of cnpjs) todos.push(...await buscarContratosFornecedor(cnpj, desde));
      const contratos = todos.filter((c) => c.compra === lic.pncp.compra);
      const r = await importarGrupo({ key: lic.pncp.compra, contratos }, { itens: !lic.itens, concluidosAte: App.db().config.concluidosAte || '' });
      App.salvar();
      App.toast(r.novos ? `${r.novos} novo(s) empenho(s) importado(s).` : 'Nenhuma novidade no PNCP.');
    } catch (e) {
      App.toast('Não foi possível consultar o PNCP agora.');
    }
  }

  // ---------- Eventos ----------
  $('#pncp-buscar').addEventListener('click', buscar);
  $('#pncp-importar').addEventListener('click', importarSelecionados);
  $('#pncp-link-btn').addEventListener('click', importarLink);
  $('#pncp-link').addEventListener('keydown', (e) => { if (e.key === 'Enter') importarLink(); });
  $('#pncp-cancelar').addEventListener('click', () => { cancelado = true; });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-editar-empresas]')) $('#btn-empresas').click(); });
  $('#pncp-tabela').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-i]');
    if (cb) { grupos[cb.dataset.i].sel = cb.checked; atualizarBotaoImportar(); }
  });
  $('#pncp-todos').addEventListener('change', (e) => {
    for (const g of grupos) if (g.novos) g.sel = e.target.checked;
    renderGrupos();
  });

  preencherConfig();
  App.onRender(preencherConfig);
  window.PNCP = { atualizarLicitacao, parseCompra };
})();
