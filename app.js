/* Gestão de Contratos e Empenhos — Grupo OSY.
 * Contratos/atas (da assinatura ao fim da vigência) e pedidos/empenhos (do recebimento ao pagamento).
 * Sem login: dados no navegador. Com login (auth.js): cópia local por usuário + nuvem. */
(() => {
  'use strict';

  const STORAGE_KEY = 'licitacoes-pncp:v1';
  const UI_KEY = 'licitacoes-pncp:ui';
  const ALERTA_ENTREGA_DIAS = 7;
  const ALERTA_VIGENCIA_DIAS = 90;
  const PRAZO_PAGAMENTO_PADRAO = 30;
  const COBRAR_ASSINATURA_DIAS = 10;

  // ---------- Estado ----------
  let storageKey = STORAGE_KEY;
  let db = carregar();
  const saveHooks = [];
  const renderHooks = [];
  const ui = carregarUI();
  let somenteLeitura = false; // perfil "Só visualização" (definido pelo auth.js)
  function travarCampos(form) {
    for (const el of form.elements) {
      if (el.matches('input, select, textarea') && !el.closest('.anexos')) el.disabled = somenteLeitura;
    }
  }

  function carregar() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const data = JSON.parse(raw);
        if (Array.isArray(data.licitacoes)) return normalizar(data);
      }
    } catch (e) { /* storage indisponível */ }
    return normalizar({ licitacoes: [] });
  }

  /** Garante a estrutura atual (e converte dados de versões anteriores). */
  function normalizar(data) {
    data.config = { empresas: [], analistas: [], ...(data.config || {}) };
    const cfg = data.config;
    if (Array.isArray(cfg.cnpjs)) { // versão antiga: só CNPJs
      for (const c of cfg.cnpjs) {
        if (!cfg.empresas.some((e) => e.cnpj === c)) cfg.empresas.push({ id: uid(), nome: '', cnpj: c });
      }
      delete cfg.cnpjs;
    }
    for (const l of data.licitacoes) {
      l.pedidos ||= [];
      l.anexos ||= [];
      for (const p of l.pedidos) p.anexos ||= [];
      if (!l.etapas) {
        // Registros antigos: se já tinham vigência, consideramos assinado e publicado.
        const d = l.vigenciaInicio || '';
        l.etapas = l.resultado === 'ganha' && d ? { recebido: d, assinadoNos: d, assinadoOrgao: d, publicado: d } : {};
      }
      if (l.empresaId === undefined) l.empresaId = cfg.empresas.length === 1 ? cfg.empresas[0].id : '';
      l.analista ||= '';
      l.situacao ||= '';
    }
    return data;
  }

  function salvar(rerender = true) {
    try { localStorage.setItem(storageKey, JSON.stringify(db)); }
    catch (e) { if (!saveHooks.length) toast('Não foi possível salvar no navegador. Exporte um backup!'); }
    saveHooks.forEach((fn) => fn(db));
    if (rerender) render();
  }
  function usarDados(chave, dados) {
    storageKey = chave;
    db = dados ? normalizar(dados) : carregar();
    try { localStorage.setItem(storageKey, JSON.stringify(db)); } catch (e) { /* ok */ }
    render();
  }

  function carregarUI() {
    const base = { view: 'painel', empresa: '', pillC: 'andamento', pillP: 'andamento', pillZ: '', ordemC: 'urgente', ordemP: 'urgente' };
    try { return { ...base, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') }; } catch (e) { return base; }
  }
  function salvarUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* ok */ } }

  // ---------- Utilidades ----------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtMoeda = (v) => brl.format(Number(v) || 0);
  const soDigitos = (s) => String(s || '').replace(/\D/g, '');
  const fmtCnpj = (c) => String(c || '').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

  function parseMoeda(s) {
    if (s == null || s === '') return 0;
    if (typeof s === 'number') return s;
    let t = String(s).replace(/[^\d,.-]/g, '');
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(t);
    return isNaN(n) ? 0 : n;
  }
  const moedaInput = (v) => (v ? Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');

  function hoje() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function parseData(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function toISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const hojeISO = () => toISO(hoje());
  function addDias(iso, dias) {
    const d = parseData(iso);
    if (!d || dias === '' || dias == null || isNaN(dias)) return null;
    d.setDate(d.getDate() + Number(dias));
    return toISO(d);
  }
  const diasAte = (iso) => Math.round((parseData(iso) - hoje()) / 86400000);
  const fmtData = (iso) => (iso ? parseData(iso).toLocaleDateString('pt-BR') : '—');
  function textoDias(n) {
    if (n === 0) return 'hoje';
    if (n === 1) return 'amanhã';
    if (n === -1) return 'ontem';
    return n > 0 ? `em ${n} dias` : `há ${-n} dias`;
  }
  const plural = (n, s, p) => `${n} ${n === 1 ? s : (p || s + 's')}`;
  const fmtTamanho = (b) => (b > 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 3000);
  }

  // ---------- Regras de negócio ----------
  const empresaDe = (l) => db.config.empresas.find((e) => e.id === l.empresaId);
  const nomeEmpresa = (e) => (e ? e.nome || fmtCnpj(e.cnpj) : '');
  const INSTRUMENTO = { ata: 'Ata de RP', contrato: 'Contrato', empenho: 'Empenho / OF' };
  const INSTRUMENTO_LONGO = { ata: 'Ata de Registro de Preços', contrato: 'Contrato', empenho: 'Empenho / OF' };
  const docNumero = (l) => l.numeroInstrumento || l.numero || '—';

  function vencimentoEntrega(lic, p) {
    const prazo = p.prazoDias !== '' && p.prazoDias != null ? p.prazoDias : lic.prazoEntregaDias;
    return addDias(p.dataRecebimento, prazo);
  }
  function vencimentoPagamento(lic, p) {
    const base = p.dataNF || p.dataEntrega;
    if (!base) return null;
    const prazo = lic.prazoPagamentoDias !== '' && lic.prazoPagamentoDias != null ? lic.prazoPagamentoDias : PRAZO_PAGAMENTO_PADRAO;
    return addDias(base, prazo);
  }

  /** Situação de um pedido: {etapa, rotulo, classe, acao?, venc?} */
  function situacaoPedido(lic, p) {
    if (p.dataPagamento) return { etapa: 'pago', rotulo: 'Pago', classe: 'ok' };
    if (p.dataEntrega) {
      if (!p.nf) return { etapa: 'faturar', rotulo: 'Entregue — emitir NF', classe: 'warn', acao: 'Emitir a nota fiscal e cobrar' };
      const venc = vencimentoPagamento(lic, p);
      const d = venc ? diasAte(venc) : null;
      if (d != null && d < 0) return { etapa: 'receber', rotulo: `Pagamento atrasado ${-d}d`, classe: 'danger', acao: 'Cobrar o pagamento', venc, atraso: true };
      return { etapa: 'receber', rotulo: 'Aguardando pagamento', classe: 'info', venc };
    }
    const venc = vencimentoEntrega(lic, p);
    if (!venc) return { etapa: 'entregar', rotulo: 'A entregar', classe: 'warn', acao: 'Entregar (sem prazo informado)' };
    const d = diasAte(venc);
    if (d < 0) return { etapa: 'entregar', rotulo: `Entrega atrasada ${-d}d`, classe: 'danger', acao: 'Entregar — prazo vencido', venc, atraso: true };
    if (d <= ALERTA_ENTREGA_DIAS) return { etapa: 'entregar', rotulo: `Entregar ${textoDias(d)}`, classe: 'warn', acao: `Entregar até ${fmtData(venc)}`, venc };
    return { etapa: 'entregar', rotulo: `Entregar até ${fmtData(venc)}`, classe: 'info', venc };
  }

  const totalPedidos = (l) => (l.pedidos || []).reduce((s, p) => s + (Number(p.valor) || 0), 0);
  const saldo = (l) => (Number(l.valor) || 0) - totalPedidos(l);
  const precisaAssinatura = (l) => l.instrumento !== 'empenho';

  /** Status do contrato/ata e lista de ações nossas pendentes. */
  function statusContrato(l) {
    const acoes = [];
    if (l.resultado === 'aguardando') {
      if (l.dataSessao && diasAte(l.dataSessao) < -15) acoes.push({ texto: 'Atualizar o resultado da licitação', nivel: 'warn' });
      return { chave: 'aguardando_resultado', rotulo: 'Aguardando resultado', classe: 'info', acoes };
    }
    if (l.resultado === 'perdida') return { chave: 'perdida', rotulo: 'Perdida', classe: '', acoes };

    const e = l.etapas || {};
    let st;
    if (l.situacao === 'rescindido') st = { chave: 'rescindido', rotulo: 'Rescindido / cancelado', classe: 'danger' };
    else if (l.situacao === 'suspenso') st = { chave: 'suspenso', rotulo: 'Suspenso', classe: 'warn' };
    else if (l.vigenciaFim && diasAte(l.vigenciaFim) < 0) st = { chave: 'encerrado', rotulo: 'Encerrado', classe: '' };
    else if (precisaAssinatura(l) && !e.assinadoNos) {
      st = { chave: 'aguardando_assinatura', rotulo: 'Aguardando assinatura', classe: 'warn' };
      acoes.push({ texto: 'Assinar e devolver ao órgão', nivel: e.recebido && diasAte(e.recebido) < -5 ? 'danger' : 'warn' });
    } else if (precisaAssinatura(l) && !e.assinadoOrgao) {
      st = { chave: 'aguardando_orgao', rotulo: 'Aguardando o órgão assinar', classe: 'info' };
      if (diasAte(e.assinadoNos) < -COBRAR_ASSINATURA_DIAS) acoes.push({ texto: 'Cobrar a assinatura do órgão', nivel: 'warn' });
    } else if (precisaAssinatura(l) && !e.publicado) {
      st = { chave: 'assinado', rotulo: 'Assinado', classe: 'info' };
    } else st = { chave: 'vigente', rotulo: 'Vigente', classe: 'ok' };

    const ativo = !['encerrado', 'rescindido'].includes(st.chave);
    if (ativo && !l.analista) acoes.push({ texto: 'Definir o analista responsável', nivel: 'warn' });
    if (st.chave === 'vigente' && l.vigenciaFim) {
      const d = diasAte(l.vigenciaFim);
      if (d <= ALERTA_VIGENCIA_DIAS) acoes.push({ texto: `Vigência termina ${textoDias(d)} — avaliar aditivo`, nivel: d <= 30 ? 'danger' : 'warn' });
    }
    if (st.chave === 'vigente' && !l.vigenciaFim && precisaAssinatura(l)) acoes.push({ texto: 'Informar a vigência', nivel: 'warn' });
    let atrasadas = 0, faturar = 0, cobrar = 0;
    for (const p of l.pedidos) {
      const s = situacaoPedido(l, p);
      if (s.etapa === 'entregar' && s.atraso) atrasadas++;
      else if (s.etapa === 'faturar') faturar++;
      else if (s.etapa === 'receber' && s.atraso) cobrar++;
    }
    if (atrasadas) acoes.push({ texto: `${plural(atrasadas, 'entrega atrasada', 'entregas atrasadas')}`, nivel: 'danger' });
    if (faturar) acoes.push({ texto: `${plural(faturar, 'nota fiscal a emitir', 'notas fiscais a emitir')}`, nivel: 'warn' });
    if (cobrar) acoes.push({ texto: `${plural(cobrar, 'pagamento atrasado', 'pagamentos atrasados')}`, nivel: 'danger' });
    return { ...st, acoes };
  }
  const emAndamento = (s) => !['encerrado', 'rescindido', 'perdida', 'aguardando_resultado'].includes(s.chave);
  const urgencia = (s) => (s.acoes.some((a) => a.nivel === 'danger') ? 2 : s.acoes.length ? 1 : 0);

  // ---------- Seleção por empresa ----------
  const licsDaEmpresa = () => db.licitacoes.filter((l) => !ui.empresa || l.empresaId === ui.empresa);
  function todosPedidos(lics = licsDaEmpresa()) {
    const out = [];
    for (const l of lics) {
      if (l.resultado !== 'ganha') continue;
      for (const p of l.pedidos) out.push({ l, p, s: situacaoPedido(l, p) });
    }
    return out;
  }

  /** Todos os prazos (entregas, pagamentos, vigências). */
  function todosPrazos() {
    const out = [];
    for (const l of licsDaEmpresa()) {
      if (l.resultado !== 'ganha') continue;
      const st = statusContrato(l);
      for (const p of l.pedidos) {
        const s = situacaoPedido(l, p);
        const base = { licId: l.id, pedidoId: p.id, orgao: p.orgao || l.orgao, valor: p.valor };
        out.push({
          ...base, tipo: 'entrega', data: vencimentoEntrega(l, p), descricao: `Entrega do empenho ${p.numero}`,
          concluido: !!p.dataEntrega, situacao: p.dataEntrega ? { rotulo: `Entregue ${fmtData(p.dataEntrega)}`, classe: 'ok' } : s,
        });
        if (p.dataEntrega) {
          out.push({
            ...base, tipo: 'pagamento', data: vencimentoPagamento(l, p), descricao: `Pagamento do empenho ${p.numero}${p.nf ? ' (NF ' + p.nf + ')' : ''}`,
            concluido: !!p.dataPagamento, situacao: p.dataPagamento ? { rotulo: `Pago ${fmtData(p.dataPagamento)}`, classe: 'ok' } : s,
          });
        }
      }
      if (l.vigenciaFim && st.chave !== 'rescindido') {
        const d = diasAte(l.vigenciaFim);
        out.push({
          licId: l.id, tipo: 'vigencia', data: l.vigenciaFim, orgao: l.orgao, valor: saldo(l),
          descricao: `Fim da vigência — ${INSTRUMENTO[l.instrumento] || ''} ${docNumero(l)}`, concluido: d < 0,
          situacao: d < 0 ? { rotulo: 'Encerrada', classe: '' } : { rotulo: `Termina ${textoDias(d)}`, classe: d <= ALERTA_VIGENCIA_DIAS ? 'warn' : 'ok' },
        });
      }
    }
    return out.sort((a, b) => (a.data || '9999').localeCompare(b.data || '9999'));
  }

  // ---------- Render geral ----------
  function render() {
    renderHooks.forEach((fn) => fn());
    preencherSelects();
    renderChips();
    renderTabs();
    renderPainel();
    renderContratos();
    renderPedidos();
    renderPrazos();
    const dc = $('#dlg-contrato');
    if (dc.open && dc.dataset.id) { renderContratoHead(); renderSecPedidos(); renderSecItens(); renderAnexosContrato(); }
  }

  function renderChips() {
    const emp = db.config.empresas;
    const box = $('#chips-empresas');
    if (!emp.length) { box.hidden = true; return; }
    box.hidden = false;
    if (ui.empresa && !emp.some((e) => e.id === ui.empresa)) ui.empresa = '';
    const resumo = (lics) => {
      const c = lics.filter((l) => emAndamento(statusContrato(l))).length;
      const p = todosPedidos(lics).filter((x) => x.s.etapa !== 'pago').length;
      return `${plural(c, 'contrato')} · ${plural(p, 'pedido')} em andamento`;
    };
    const chip = (id, nome, lics) => `<button class="chip ${ui.empresa === id ? 'active' : ''}" data-empresa="${id}">
      <strong>${esc(nome)}</strong><span>${resumo(lics)}</span></button>`;
    box.innerHTML = chip('', 'Todas as empresas', db.licitacoes) +
      emp.map((e) => chip(e.id, nomeEmpresa(e), db.licitacoes.filter((l) => l.empresaId === e.id))).join('');
  }

  function renderTabs() {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === ui.view));
    $$('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + ui.view));
    const lics = licsDaEmpresa();
    const sts = lics.map(statusContrato);
    $('#tab-s-contratos').textContent = `${sts.filter(emAndamento).length} em andamento`;
    $('#tab-s-pedidos').textContent = `${todosPedidos().filter((x) => x.s.etapa !== 'pago').length} em andamento`;
    const semana = todosPrazos().filter((p) => !p.concluido && p.data && diasAte(p.data) <= 7).length;
    $('#tab-s-prazos').textContent = `${semana} nos próximos 7 dias`;
    const acoes = sts.reduce((n, s) => n + (s.acoes.length ? 1 : 0), 0);
    $('#tab-s-painel').textContent = acoes ? `${acoes} com ação pendente` : 'tudo em dia';
  }

  const kpi = (label, value, sub, classe = '') => `<div class="card kpi ${classe}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;

  // ---------- Painel ----------
  function renderPainel() {
    const lics = licsDaEmpresa();
    const ativos = lics.filter((l) => emAndamento(statusContrato(l)));
    const peds = todosPedidos(lics);
    const saldoTotal = ativos.reduce((s, l) => s + Math.max(0, saldo(l)), 0);
    const aEntregar = peds.filter((x) => x.s.etapa === 'entregar');
    const aReceber = peds.filter((x) => x.s.etapa === 'receber' || x.s.etapa === 'faturar');
    const recebido = peds.filter((x) => x.s.etapa === 'pago').reduce((s, x) => s + (Number(x.p.valor) || 0), 0);
    const comAcao = lics.filter((l) => statusContrato(l).acoes.length);
    $('#kpis-painel').innerHTML = [
      kpi('Contratos e atas em andamento', ativos.length, plural(lics.filter((l) => l.resultado === 'ganha').length, 'licitação ganha', 'licitações ganhas')),
      kpi('Ação nossa pendente', comAcao.length, comAcao.length ? 'contratos/atas precisam de atenção' : 'tudo em dia', comAcao.length ? 'kpi-warn' : ''),
      kpi('Saldo a executar', fmtMoeda(saldoTotal), 'em contratos/atas ativos'),
      kpi('Pedidos a entregar', aEntregar.length, `${aEntregar.filter((x) => x.s.atraso).length} atrasados`, aEntregar.some((x) => x.s.atraso) ? 'kpi-danger' : ''),
      kpi('A receber', fmtMoeda(aReceber.reduce((s, x) => s + (Number(x.p.valor) || 0), 0)), `${plural(aReceber.length, 'pedido')} entregues`),
      kpi('Recebido', fmtMoeda(recebido), 'pagamentos confirmados'),
    ].join('');

    const itens = [];
    for (const l of lics) {
      const st = statusContrato(l);
      for (const a of st.acoes) itens.push({ l, a });
    }
    itens.sort((x, y) => (y.a.nivel === 'danger') - (x.a.nivel === 'danger'));
    const LIMITE = 8;
    const li = ({ l, a }) => `<li data-lic="${l.id}">
      <span class="badge ${a.nivel}">${a.nivel === 'danger' ? 'Urgente' : 'Pendente'}</span>
      <div class="a-body"><div class="a-title">${esc(a.texto)}</div>
      <div class="a-sub">${esc(INSTRUMENTO[l.instrumento] || 'Licitação')} ${esc(docNumero(l))} · ${esc(l.orgao)}</div></div></li>`;
    $('#alertas').innerHTML = itens.slice(0, LIMITE).map(li).join('') +
      (itens.length > LIMITE ? `<li class="ver-mais" data-ir="contratos" data-pill="acao">+ ${itens.length - LIMITE} — ver em Contratos →</li>` : '') ||
      `<li class="none">${lics.length ? 'Nada pendente. 🎉' : 'Comece em “＋ Novo contrato / ata” ou importe da aba PNCP.'}</li>`;

    const prox = todosPrazos().filter((p) => !p.concluido && p.data && diasAte(p.data) >= 0).slice(0, 7);
    $('#proximos').innerHTML = prox.map((p) => `<li data-lic="${p.licId}" ${p.pedidoId ? `data-pedido="${p.pedidoId}"` : ''}>
      <span class="badge ${p.situacao.classe}">${esc(textoDias(diasAte(p.data)))}</span>
      <div class="a-body"><div class="a-title">${esc(p.descricao)}</div>
      <div class="a-sub">${esc(p.orgao)} · ${fmtData(p.data)}${p.valor ? ' · ' + fmtMoeda(p.valor) : ''}</div></div></li>`).join('') ||
      '<li class="none">Nenhum prazo futuro.</li>';
  }

  // ---------- Contratos ----------
  const PILLS_C = [
    ['andamento', 'Em andamento', (s) => emAndamento(s)],
    ['acao', 'Ação nossa pendente', (s) => s.acoes.length > 0],
    ['assinatura', 'Aguardando assinatura', (s) => s.chave === 'aguardando_assinatura' || s.chave === 'aguardando_orgao'],
    ['assinado', 'Assinado', (s) => s.chave === 'assinado'],
    ['vigente', 'Vigente', (s) => s.chave === 'vigente'],
    ['suspenso', 'Suspenso', (s) => s.chave === 'suspenso'],
    ['encerrado', 'Encerrado', (s) => s.chave === 'encerrado'],
    ['rescindido', 'Rescindido / cancelado', (s) => s.chave === 'rescindido'],
    ['resultado', 'Aguardando resultado', (s) => s.chave === 'aguardando_resultado'],
    ['perdida', 'Perdidas', (s) => s.chave === 'perdida'],
    ['todos', 'Todos', () => true],
  ];

  function listaContratos() {
    const busca = $('#busca-contratos').value.trim().toLowerCase();
    const pill = PILLS_C.find((p) => p[0] === ui.pillC) || PILLS_C[0];
    const lista = licsDaEmpresa().map((l) => ({ l, s: statusContrato(l) }))
      .filter(({ s }) => pill[2](s))
      .filter(({ l }) => !busca || [l.orgao, l.numero, l.numeroInstrumento, l.objeto, l.processo, l.analista, nomeEmpresa(empresaDe(l)),
        ...(l.itens || []).map((i) => i.descricao)].join(' ').toLowerCase().includes(busca));
    const ordem = {
      urgente: (a, b) => urgencia(b.s) - urgencia(a.s) || (a.l.vigenciaFim || '9999').localeCompare(b.l.vigenciaFim || '9999'),
      vigencia: (a, b) => (a.l.vigenciaFim || '9999').localeCompare(b.l.vigenciaFim || '9999'),
      recente: (a, b) => (b.l.etapas?.recebido || b.l.dataSessao || '').localeCompare(a.l.etapas?.recebido || a.l.dataSessao || ''),
      saldo: (a, b) => saldo(b.l) - saldo(a.l),
      orgao: (a, b) => a.l.orgao.localeCompare(b.l.orgao, 'pt-BR'),
    }[ui.ordemC] || (() => 0);
    return lista.sort(ordem);
  }

  function renderContratos() {
    const lics = licsDaEmpresa();
    const sts = lics.map((l) => ({ l, s: statusContrato(l) }));
    const aguard = sts.filter((x) => x.s.chave === 'aguardando_assinatura' || x.s.chave === 'aguardando_orgao');
    const atrasadas = aguard.filter((x) => x.s.acoes.some((a) => a.nivel === 'danger' || /Cobrar/.test(a.texto))).length;
    const vig = sts.filter((x) => x.s.chave === 'vigente');
    const terminando = vig.filter((x) => x.l.vigenciaFim && diasAte(x.l.vigenciaFim) <= ALERTA_VIGENCIA_DIAS);
    const enc = sts.filter((x) => x.s.chave === 'encerrado');
    const naoExec = enc.reduce((s, x) => s + Math.max(0, saldo(x.l)), 0);
    const prox = terminando.map((x) => diasAte(x.l.vigenciaFim)).sort((a, b) => a - b)[0];
    $('#kpis-contratos').innerHTML = [
      kpi('Aguardando assinatura', aguard.length, atrasadas ? `${atrasadas} com prazo passando` : 'Nenhum prazo vencido', atrasadas ? 'kpi-warn' : ''),
      kpi('Vigentes', vig.length, `${fmtMoeda(vig.reduce((s, x) => s + Math.max(0, saldo(x.l)), 0))} de saldo a executar`),
      kpi(`Vigência termina em ${ALERTA_VIGENCIA_DIAS} dias`, terminando.length, terminando.length ? `a próxima ${textoDias(prox)}` : 'Nenhum vencimento próximo', terminando.length ? 'kpi-warn' : ''),
      kpi('Vigência encerrada', enc.length, naoExec ? `${fmtMoeda(naoExec)} de saldo não executado` : 'Tudo em dia'),
    ].join('');

    $('#pills-contratos').innerHTML = PILLS_C.map(([k, rot, fn]) =>
      `<button class="pill ${ui.pillC === k ? 'active' : ''}" data-pill-c="${k}">${rot} <b>${sts.filter((x) => fn(x.s)).length}</b></button>`).join('');
    $('#ordem-contratos').value = ui.ordemC;

    const lista = listaContratos();
    const variasEmpresas = db.config.empresas.length > 1 && !ui.empresa;
    $('#tabela-contratos tbody').innerHTML = lista.map(({ l, s }) => {
      const ganha = l.resultado === 'ganha';
      const total = Number(l.valor) || 0;
      const exec = totalPedidos(l);
      const pct = total ? Math.min(100, Math.round((exec / total) * 100)) : 0;
      const u = urgencia(s);
      return `<tr class="clickable urg-${u}" data-lic="${l.id}">
        <td><div class="doc-tipo">${esc(ganha ? INSTRUMENTO[l.instrumento] || 'Contrato' : 'Licitação')}</div><div class="mono doc-num">${esc(docNumero(l))}</div>${l.anexos?.length ? `<div class="muted small">📎 ${l.anexos.length}</div>` : ''}</td>
        <td><strong class="orgao">${esc(l.orgao)}</strong>
          <div class="muted clamp1">${esc(l.numero)}${l.objeto ? ' — ' + esc(l.objeto) : ''}</div>
          ${variasEmpresas && empresaDe(l) ? `<div class="emp-tag">${esc(nomeEmpresa(empresaDe(l)))}</div>` : ''}</td>
        <td>${l.analista ? esc(l.analista) : ganha ? '<span class="badge warn">Indefinido</span>' : '<span class="muted">—</span>'}</td>
        <td class="mono nowrap">${l.vigenciaInicio || l.vigenciaFim ? `${fmtData(l.vigenciaInicio)} a<br>${fmtData(l.vigenciaFim)}` : '<span class="muted">—</span>'}</td>
        <td>${ganha && total ? `<div class="mono">${fmtMoeda(saldo(l))}</div><div class="progress"><span style="width:${pct}%"></span></div>
          <div class="muted small">${pct}% executado de ${fmtMoeda(total)}</div>` : '<span class="muted">—</span>'}</td>
        <td><span class="status ${s.classe}">${esc(s.rotulo)}</span>
          ${s.acoes.length ? `<div class="acao ${s.acoes[0].nivel}">⚠ ${esc(s.acoes[0].texto)}${s.acoes.length > 1 ? ` <span class="mais">+${s.acoes.length - 1}</span>` : ''}</div>` : ''}</td>
      </tr>`;
    }).join('');
    const vazio = $('#vazio-contratos');
    vazio.hidden = lista.length > 0;
    vazio.innerHTML = lics.length ? 'Nenhum contrato com esses filtros.' : 'Nenhum contrato ainda. Use <strong>＋ Novo contrato / ata</strong> ou importe da aba <strong>PNCP</strong>.';
    $('#tabela-contratos').parentElement.hidden = !lista.length;
  }

  // ---------- Pedidos ----------
  const PILLS_P = [
    ['andamento', 'Em andamento', (x) => x.s.etapa !== 'pago'],
    ['acao', 'Ação nossa pendente', (x) => !!x.s.acao],
    ['entregar', 'A entregar', (x) => x.s.etapa === 'entregar'],
    ['atrasados', 'Atrasados', (x) => !!x.s.atraso],
    ['faturar', 'Emitir NF', (x) => x.s.etapa === 'faturar'],
    ['receber', 'Aguardando pagamento', (x) => x.s.etapa === 'receber'],
    ['pago', 'Pagos', (x) => x.s.etapa === 'pago'],
    ['todos', 'Todos', () => true],
  ];
  const urgP = (x) => (x.s.atraso ? 3 : x.s.acao ? 2 : x.s.etapa === 'pago' ? 0 : 1);

  function listaPedidos() {
    const busca = $('#busca-pedidos').value.trim().toLowerCase();
    const pill = PILLS_P.find((p) => p[0] === ui.pillP) || PILLS_P[0];
    const lista = todosPedidos().filter(pill[2])
      .filter(({ l, p }) => !busca || [p.numero, p.orgao, l.orgao, p.nf, p.descricao, l.numeroInstrumento, l.numero].join(' ').toLowerCase().includes(busca));
    const venc = (x) => x.s.venc || '9999';
    const ordem = {
      urgente: (a, b) => urgP(b) - urgP(a) || venc(a).localeCompare(venc(b)),
      recente: (a, b) => (b.p.dataRecebimento || '').localeCompare(a.p.dataRecebimento || ''),
      valor: (a, b) => (Number(b.p.valor) || 0) - (Number(a.p.valor) || 0),
      orgao: (a, b) => (a.p.orgao || a.l.orgao).localeCompare(b.p.orgao || b.l.orgao, 'pt-BR'),
    }[ui.ordemP] || (() => 0);
    return lista.sort(ordem);
  }

  function renderPedidos() {
    const peds = todosPedidos();
    const ent = peds.filter((x) => x.s.etapa === 'entregar');
    const fat = peds.filter((x) => x.s.etapa === 'faturar');
    const rec = peds.filter((x) => x.s.etapa === 'receber');
    const soma = (arr) => arr.reduce((s, x) => s + (Number(x.p.valor) || 0), 0);
    const ult30 = peds.filter((x) => x.p.dataPagamento && diasAte(x.p.dataPagamento) >= -30);
    $('#kpis-pedidos').innerHTML = [
      kpi('A entregar', ent.length, `${ent.filter((x) => x.s.atraso).length} atrasados · ${fmtMoeda(soma(ent))}`, ent.some((x) => x.s.atraso) ? 'kpi-danger' : ''),
      kpi('Emitir nota fiscal', fat.length, fat.length ? `${fmtMoeda(soma(fat))} entregues sem NF` : 'Nada a faturar', fat.length ? 'kpi-warn' : ''),
      kpi('Aguardando pagamento', fmtMoeda(soma(rec)), `${plural(rec.length, 'pedido')} · ${rec.filter((x) => x.s.atraso).length} atrasados`, rec.some((x) => x.s.atraso) ? 'kpi-danger' : ''),
      kpi('Recebido em 30 dias', fmtMoeda(soma(ult30)), plural(ult30.length, 'pagamento')),
    ].join('');
    $('#pills-pedidos').innerHTML = PILLS_P.map(([k, rot, fn]) =>
      `<button class="pill ${ui.pillP === k ? 'active' : ''}" data-pill-p="${k}">${rot} <b>${peds.filter(fn).length}</b></button>`).join('');
    $('#ordem-pedidos').value = ui.ordemP;

    const lista = listaPedidos();
    const LIM = 300;
    $('#tabela-pedidos tbody').innerHTML = lista.slice(0, LIM).map((x) => {
      const { l, p, s } = x;
      return `<tr class="clickable urg-${s.atraso ? 2 : s.acao ? 1 : 0}" data-lic="${l.id}" data-pedido="${p.id}">
        <td><div class="mono doc-num">${esc(p.numero)}</div>${p.nf ? `<div class="muted small">NF ${esc(p.nf)}</div>` : ''}${p.anexos?.length ? `<div class="muted small">📎 ${p.anexos.length}</div>` : ''}</td>
        <td><strong class="orgao">${esc(p.orgao || l.orgao)}</strong>${p.descricao ? `<div class="muted clamp1">${esc(p.descricao)}</div>` : ''}</td>
        <td><div class="mono small">${esc(INSTRUMENTO[l.instrumento] || '')} ${esc(docNumero(l))}</div><div class="muted small clamp1">${esc(l.orgao)}</div></td>
        <td class="mono nowrap">${fmtData(p.dataRecebimento)}</td>
        <td class="mono nowrap">${p.dataEntrega ? `<span class="muted">entregue ${fmtData(p.dataEntrega)}</span>` : fmtData(vencimentoEntrega(l, p))}</td>
        <td class="num mono">${fmtMoeda(p.valor)}</td>
        <td><span class="status ${s.classe}">${esc(s.rotulo)}</span></td>
      </tr>`;
    }).join('') + (lista.length > LIM ? `<tr><td colspan="7" class="muted">Mostrando ${LIM} de ${lista.length}. Use a busca ou os filtros para encontrar os demais.</td></tr>` : '');
    const vazio = $('#vazio-pedidos');
    vazio.hidden = lista.length > 0;
    vazio.textContent = peds.length ? 'Nenhum pedido com esses filtros.' : 'Nenhum empenho ainda. Abra um contrato/ata e use “＋ Novo empenho”, ou importe da aba PNCP.';
    $('#tabela-pedidos').parentElement.hidden = !lista.length;
  }

  // ---------- Prazos ----------
  const PILLS_Z = [['', 'Todos'], ['entrega', 'Entregas'], ['pagamento', 'Pagamentos'], ['vigencia', 'Vigências']];
  function renderPrazos() {
    const conc = $('#f-prazo-concluidos').checked;
    const todos = todosPrazos().filter((p) => conc || !p.concluido);
    $('#pills-prazos').innerHTML = PILLS_Z.map(([k, rot]) =>
      `<button class="pill ${ui.pillZ === k ? 'active' : ''}" data-pill-z="${k}">${rot} <b>${todos.filter((p) => !k || p.tipo === k).length}</b></button>`).join('');
    const lista = todos.filter((p) => !ui.pillZ || p.tipo === ui.pillZ);
    const TIPO = { entrega: 'Entrega', pagamento: 'Pagamento', vigencia: 'Vigência' };
    $('#tabela-prazos tbody').innerHTML = lista.slice(0, 400).map((p) => `
      <tr class="clickable" data-lic="${p.licId}" ${p.pedidoId ? `data-pedido="${p.pedidoId}"` : ''}>
        <td class="mono nowrap"><strong>${fmtData(p.data)}</strong>${p.data && !p.concluido ? `<div class="muted small">${textoDias(diasAte(p.data))}</div>` : ''}</td>
        <td>${TIPO[p.tipo]}</td><td>${esc(p.descricao)}</td><td>${esc(p.orgao)}</td>
        <td class="num mono">${p.valor ? fmtMoeda(p.valor) : '—'}</td>
        <td><span class="status ${p.situacao.classe}">${esc(p.situacao.rotulo)}</span></td>
      </tr>`).join('');
    $('#vazio-prazos').hidden = lista.length > 0;
    $('#tabela-prazos').parentElement.hidden = !lista.length;
  }

  // ---------- Formulários (leitura/escrita genérica) ----------
  function preencherSelects() {
    const emp = db.config.empresas;
    for (const sel of $$('select[data-empresas]')) {
      const v = sel.value;
      sel.innerHTML = (emp.length ? '' : '<option value="">— Cadastre as empresas em “Empresas e analistas” —</option>') +
        emp.map((e) => `<option value="${e.id}">${esc(nomeEmpresa(e))}${e.nome && e.cnpj ? ' — CNPJ ' + fmtCnpj(e.cnpj) : ''}</option>`).join('');
      if (v) sel.value = v;
    }
    for (const sel of $$('select[data-analistas]')) {
      const v = sel.value;
      const nomes = [...db.config.analistas];
      if (v && !nomes.includes(v)) nomes.push(v);
      sel.innerHTML = '<option value="">Selecione o analista</option>' + nomes.map((n) => `<option>${esc(n)}</option>`).join('');
      sel.value = v;
    }
  }
  function escreverForm(form, obj) {
    for (const el of form.elements) {
      if (!el.name) continue;
      const [a, b] = el.name.split('.');
      let v = b ? obj[a]?.[b] : obj[a];
      if (el.name === 'valor') v = moedaInput(v);
      if (el.tagName === 'SELECT' && v && ![...el.options].some((o) => o.value === v)) {
        el.insertAdjacentHTML('beforeend', `<option>${esc(v)}</option>`);
      }
      el.value = v ?? '';
    }
  }
  function lerForm(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      const [a, b] = el.name.split('.');
      const v = el.name === 'valor' ? parseMoeda(el.value) : el.value.trim();
      if (b) (out[a] ||= {})[b] = v; else out[a] = v;
    }
    return out;
  }
  function numerarSecoes(root) {
    let n = 0;
    for (const s of $$('.sec', root)) {
      if (s.hidden || s.classList.contains('vazia')) continue;
      const el = $('.sec-n', s);
      if (el) el.textContent = ++n;
    }
  }

  // ---------- Painel lateral: contrato / ata ----------
  const dlgC = $('#dlg-contrato');
  const formC = $('#form-contrato');
  let sujoC = false;
  const licAtual = () => db.licitacoes.find((l) => l.id === dlgC.dataset.id);

  function abrirContrato(id = null) {
    const lic = id ? db.licitacoes.find((l) => l.id === id) : null;
    if (id && !lic) return;
    dlgC.dataset.id = lic ? lic.id : '';
    preencherSelects();
    formC.reset();
    const base = lic || {
      resultado: 'ganha', instrumento: 'ata', modalidade: 'Pregão eletrônico',
      empresaId: ui.empresa || db.config.empresas[0]?.id || '', etapas: { recebido: hojeISO() },
    };
    escreverForm(formC, base);
    travarCampos(formC);
    sujoC = false;
    atualizarVisibilidadeC();
    renderContratoHead();
    renderSecItens();
    renderSecPedidos();
    renderAnexosContrato();
    $('#btn-excluir-contrato').hidden = !lic;
    $('#btn-salvar-contrato').textContent = lic ? 'Salvar alterações' : 'Lançar contrato / ata';
    if (!dlgC.open) dlgC.showModal();
    $('.drawer-body', dlgC).scrollTop = 0;
    numerarSecoes(dlgC);
  }

  function atualizarVisibilidadeC() {
    const ganha = formC.resultado.value === 'ganha';
    const existe = !!dlgC.dataset.id;
    for (const s of $$('.so-ganha', dlgC)) s.hidden = !ganha;
    for (const s of $$('.so-existente', dlgC)) s.hidden = !ganha || !existe;
    numerarSecoes(dlgC);
  }

  function rascunhoC() {
    const lic = licAtual();
    const f = lerForm(formC);
    return { ...(lic || { pedidos: [], itens: [], anexos: [] }), ...f, etapas: { ...(lic?.etapas || {}), ...f.etapas } };
  }

  function renderContratoHead() {
    const r = rascunhoC();
    const novo = !dlgC.dataset.id;
    const st = statusContrato(r);
    const e = r.etapas || {};
    const emp = db.config.empresas.find((x) => x.id === r.empresaId);
    const ganha = r.resultado === 'ganha';
    const passos = precisaAssinatura(r) ? [
      ['recebido', 'Recebido', e.recebido], ['assinadoNos', 'Assinado por nós', e.assinadoNos],
      ['assinadoOrgao', 'Assinado pelo órgão', e.assinadoOrgao], ['publicado', 'Publicado', e.publicado],
      ['vigencia', 'Vigente até', r.vigenciaFim],
    ] : [['recebido', 'Recebido', e.recebido], ['vigencia', 'Vigente até', r.vigenciaFim]];
    const proximo = passos.find(([k, , v]) => !v && k !== 'vigencia');
    $('#contrato-head').innerHTML = `
      <div class="dh-top">
        <div>
          ${emp ? `<div class="dh-emp">■ ${esc(nomeEmpresa(emp))}</div>` : ''}
          <div class="muted">${esc(ganha ? INSTRUMENTO_LONGO[r.instrumento] || '' : 'Licitação')}</div>
          <h2>${novo ? 'Novo contrato / ata' : esc(docNumero(r)) + ' <span class="dh-orgao">' + esc(r.orgao) + '</span>'}</h2>
        </div>
        <button type="button" class="x" data-close aria-label="Fechar">✕</button>
      </div>
      <div class="dh-resumo">
        <div><div class="k">Status</div><span class="status ${st.classe}">${esc(st.rotulo)}</span></div>
        <div><div class="k">Analista</div><div class="v">${esc(r.analista) || '—'}</div></div>
        ${ganha ? `<div><div class="k">Valor total</div><div class="v mono">${fmtMoeda(r.valor)}</div></div>
        <div><div class="k">Empenhado</div><div class="v mono">${fmtMoeda(totalPedidos(r))}</div></div>
        <div><div class="k">Saldo</div><div class="v mono">${fmtMoeda(saldo(r))}</div></div>` : ''}
      </div>
      ${ganha ? `<ol class="passos">${passos.map(([k, rot, v]) => `
        <li class="${v ? 'feito' : ''} ${proximo && proximo[0] === k ? 'proximo' : ''}">
          ${!v && k !== 'vigencia' && !somenteLeitura ? `<button type="button" class="passo-btn" data-passo="${k}" title="Marcar como feito hoje">${rot}</button>` : `<span class="passo-rot">${rot}</span>`}
          <span class="mono passo-data">${v ? fmtData(v) : '—'}</span>
        </li>`).join('')}</ol>` : ''}
      ${st.acoes.length ? `<div class="dh-acoes">${st.acoes.map((a) => `<span class="acao ${a.nivel}">⚠ ${esc(a.texto)}</span>`).join('')}</div>` : ''}
      ${ganha && proximo && !somenteLeitura ? `<button type="button" class="btn small" data-passo="${proximo[0]}">✓ Marcar “${proximo[1]}” como feito hoje</button>` : ''}`;
  }

  function renderSecItens() {
    const sec = $('#sec-itens');
    const lic = licAtual();
    const itens = lic?.itens || [];
    if (!itens.length) { sec.innerHTML = ''; sec.classList.add('vazia'); numerarSecoes(dlgC); return; }
    sec.classList.remove('vazia');
    sec.innerHTML = `<div class="sec-head"><h3><span class="sec-n"></span> Itens ganhos (${itens.length})</h3><span class="muted">via PNCP</span></div>
      <div class="table-wrap"><table class="table compact">
        <thead><tr><th>Item</th><th>Descrição</th><th class="num">Qtd.</th><th class="num">Unit.</th><th class="num">Total</th></tr></thead>
        <tbody>${itens.map((it) => `<tr><td class="mono">${it.numero}</td><td><div class="clamp">${esc(it.descricao)}</div></td>
          <td class="num mono">${Number(it.quantidade).toLocaleString('pt-BR')} <span class="muted small">${esc(it.unidade || '')}</span></td>
          <td class="num mono">${fmtMoeda(it.valorUnit)}</td><td class="num mono">${fmtMoeda(it.valorTotal)}</td></tr>`).join('')}</tbody>
      </table></div>`;
    numerarSecoes(dlgC);
  }

  function renderSecPedidos() {
    const sec = $('#sec-pedidos');
    const lic = licAtual();
    if (!lic) { sec.innerHTML = ''; return; }
    const peds = [...lic.pedidos].sort((a, b) => (b.dataRecebimento || '').localeCompare(a.dataRecebimento || ''));
    sec.innerHTML = `<div class="sec-head"><h3><span class="sec-n"></span> Pedidos e empenhos (${peds.length})</h3>
        <button type="button" class="btn primary small so-editor" data-novo-pedido>＋ Novo empenho</button></div>
      ${peds.length ? `<div class="table-wrap"><table class="table compact">
        <thead><tr><th>Empenho / OF</th><th>Recebido</th><th>Entregar até</th><th class="num">Valor</th><th>Status</th></tr></thead>
        <tbody>${peds.map((p) => { const s = situacaoPedido(lic, p); return `<tr class="clickable" data-abrir-pedido="${p.id}">
          <td><span class="mono">${esc(p.numero)}</span>${p.orgao ? `<div class="muted small clamp1">${esc(p.orgao)}</div>` : ''}</td>
          <td class="mono">${fmtData(p.dataRecebimento)}</td><td class="mono">${fmtData(vencimentoEntrega(lic, p))}</td>
          <td class="num mono">${fmtMoeda(p.valor)}</td><td><span class="status ${s.classe}">${esc(s.rotulo)}</span></td></tr>`; }).join('')}</tbody>
      </table></div>` : '<p class="muted">Nenhum empenho ainda. Quando o órgão mandar a nota de empenho ou ordem de fornecimento, registre aqui para controlar entrega e pagamento.</p>'}`;
    numerarSecoes(dlgC);
  }

  function renderAnexosContrato() {
    renderAnexos($('[data-anexos="contrato"]', dlgC), licAtual(), 'contrato');
  }

  formC.addEventListener('input', (e) => {
    if (e.target.closest('.anexos')) return;
    sujoC = true;
    if (e.target.name === 'resultado' || e.target.name === 'instrumento') atualizarVisibilidadeC();
    renderContratoHead();
  });
  formC.addEventListener('change', (e) => {
    if (e.target.closest('.anexos')) return;
    sujoC = true;
    renderContratoHead();
  });

  dlgC.addEventListener('click', (e) => {
    const passo = e.target.closest('[data-passo]');
    if (passo && !somenteLeitura) {
      const k = passo.dataset.passo;
      const campo = formC.elements['etapas.' + k];
      if (campo && !campo.value) { campo.value = hojeISO(); sujoC = true; renderContratoHead(); toast('Data preenchida com hoje. Clique em Salvar para confirmar.'); }
      return;
    }
    if (e.target.closest('[data-novo-pedido]')) { abrirPedido(dlgC.dataset.id, null); return; }
    const ap = e.target.closest('[data-abrir-pedido]');
    if (ap) abrirPedido(dlgC.dataset.id, ap.dataset.abrirPedido);
  });

  formC.addEventListener('submit', (e) => {
    e.preventDefault();
    if (somenteLeitura) return;
    const f = lerForm(formC);
    if (!f.orgao || !f.numero) { toast('Preencha o órgão e o nº da licitação.'); (f.orgao ? formC.numero : formC.orgao).focus(); return; }
    if (db.config.empresas.length && !f.empresaId) { toast('Escolha a empresa.'); return; }
    if (f.vigenciaInicio && f.vigenciaFim && f.vigenciaFim < f.vigenciaInicio) { toast('O fim da vigência está antes do início.'); return; }
    let lic = licAtual();
    const novo = !lic;
    if (lic) Object.assign(lic, f, { etapas: { ...lic.etapas, ...f.etapas } });
    else { lic = { id: uid(), pedidos: [], itens: [], anexos: [], pncp: null, ...f }; db.licitacoes.push(lic); }
    sujoC = false;
    salvar();
    if (novo) {
      abrirContrato(lic.id);
      toast('Contrato lançado. Agora você pode anexar documentos e registrar empenhos.');
    } else {
      toast('Alterações salvas.');
    }
  });

  function fecharContrato() {
    if (sujoC && !confirm('Há alterações não salvas. Descartar?')) return;
    sujoC = false;
    dlgC.close();
  }
  dlgC.addEventListener('cancel', (e) => { e.preventDefault(); fecharContrato(); });

  $('#btn-excluir-contrato').addEventListener('click', () => {
    const lic = licAtual();
    if (somenteLeitura || !lic || !confirm(`Excluir ${docNumero(lic)} (${lic.orgao}) com todos os empenhos e documentos?`)) return;
    const anexos = [...lic.anexos, ...lic.pedidos.flatMap((p) => p.anexos || [])];
    db.licitacoes = db.licitacoes.filter((l) => l !== lic);
    sujoC = false;
    dlgC.close();
    salvar();
    for (const a of anexos) window.Arquivos?.excluir(a).catch(() => {});
    toast('Excluído.');
  });

  // ---------- Painel lateral: pedido / empenho ----------
  const dlgP = $('#dlg-pedido');
  const formP = $('#form-pedido');
  let ctxP = null; // {lic, p}
  let sujoP = false;

  function abrirPedido(licId, pedidoId) {
    const lic = db.licitacoes.find((l) => l.id === licId);
    if (!lic) return;
    const p = pedidoId ? lic.pedidos.find((x) => x.id === pedidoId) : null;
    ctxP = { lic, p };
    formP.reset();
    escreverForm(formP, p || { dataRecebimento: hojeISO(), prazoDias: lic.prazoEntregaDias || '' });
    travarCampos(formP);
    sujoP = false;
    $('#btn-excluir-pedido').hidden = !p;
    $('#btn-salvar-pedido').textContent = p ? 'Salvar alterações' : 'Registrar empenho';
    renderPedidoHead();
    renderAnexos($('[data-anexos="pedido"]', dlgP), p, 'pedido');
    if (!dlgP.open) dlgP.showModal();
    $('.drawer-body', dlgP).scrollTop = 0;
  }

  function renderPedidoHead() {
    const { lic, p } = ctxP;
    const r = { ...(p || {}), ...lerForm(formP) };
    const s = situacaoPedido(lic, r);
    const emp = empresaDe(lic);
    const passos = [['dataRecebimento', 'Recebido', r.dataRecebimento], ['dataEntrega', 'Entregue', r.dataEntrega],
      ['dataNF', 'NF emitida', r.dataNF], ['dataPagamento', 'Pago', r.dataPagamento]];
    const proximo = passos.find(([, , v]) => !v);
    const vp = vencimentoPagamento(lic, r);
    $('#pedido-head').innerHTML = `
      <div class="dh-top">
        <div>
          ${emp ? `<div class="dh-emp">■ ${esc(nomeEmpresa(emp))}</div>` : ''}
          <div class="muted">${esc(INSTRUMENTO[lic.instrumento] || '')} ${esc(docNumero(lic))} · ${esc(lic.orgao)}</div>
          <h2>${p ? 'Empenho <span class="mono">' + esc(p.numero) + '</span>' : 'Novo empenho / OF'}</h2>
        </div>
        <button type="button" class="x" data-close aria-label="Fechar">✕</button>
      </div>
      <div class="dh-resumo">
        <div><div class="k">Status</div><span class="status ${s.classe}">${esc(s.rotulo)}</span></div>
        <div><div class="k">Valor</div><div class="v mono">${fmtMoeda(r.valor)}</div></div>
        <div><div class="k">Entregar até</div><div class="v mono">${fmtData(vencimentoEntrega(lic, r))}</div></div>
        <div><div class="k">Pagamento previsto</div><div class="v mono">${fmtData(vp)}</div></div>
      </div>
      <ol class="passos">${passos.map(([k, rot, v]) => `<li class="${v ? 'feito' : ''} ${proximo && proximo[0] === k ? 'proximo' : ''}">
        ${v || somenteLeitura ? `<span class="passo-rot">${rot}</span>` : `<button type="button" class="passo-btn" data-passo-p="${k}" title="Marcar como feito hoje">${rot}</button>`}
        <span class="mono passo-data">${v ? fmtData(v) : '—'}</span></li>`).join('')}</ol>
      ${s.acao ? `<div class="dh-acoes"><span class="acao ${s.classe === 'danger' ? 'danger' : 'warn'}">⚠ ${esc(s.acao)}</span></div>` : ''}
      ${proximo && proximo[0] !== 'dataRecebimento' && !somenteLeitura ? `<button type="button" class="btn small" data-passo-p="${proximo[0]}">✓ Marcar “${proximo[1]}” como feito hoje</button>` : ''}`;
  }

  formP.addEventListener('input', (e) => { if (e.target.closest('.anexos')) return; sujoP = true; renderPedidoHead(); });
  dlgP.addEventListener('click', (e) => {
    const b = e.target.closest('[data-passo-p]');
    if (!b || somenteLeitura) return;
    const campo = formP.elements[b.dataset.passoP];
    if (campo && !campo.value) {
      campo.value = hojeISO();
      sujoP = true;
      renderPedidoHead();
      if (b.dataset.passoP === 'dataNF' && !formP.nf.value) { formP.nf.focus(); toast('Informe o número da nota fiscal e salve.'); }
      else toast('Data preenchida com hoje. Clique em Salvar para confirmar.');
    }
  });

  formP.addEventListener('submit', (e) => {
    e.preventDefault();
    if (somenteLeitura) return;
    const f = lerForm(formP);
    if (!f.numero || !f.dataRecebimento) { toast('Preencha o nº do empenho e a data de recebimento.'); return; }
    if (f.dataNF && !f.nf) { toast('Informe o número da nota fiscal.'); formP.nf.focus(); return; }
    const { lic, p } = ctxP;
    if (p) Object.assign(p, f);
    else {
      const novo = { id: uid(), anexos: [], ...f };
      lic.pedidos.push(novo);
      ctxP.p = novo;
    }
    sujoP = false;
    salvar();
    if (!p) {
      abrirPedido(lic.id, ctxP.p.id);
      toast(saldo(lic) < 0 ? 'Empenho registrado. Atenção: os empenhos já passam do valor do contrato.' : 'Empenho registrado. Você pode anexar a nota de empenho abaixo.');
    } else toast('Alterações salvas.');
  });

  function fecharPedido() {
    if (sujoP && !confirm('Há alterações não salvas neste empenho. Descartar?')) return;
    sujoP = false;
    dlgP.close();
  }
  dlgP.addEventListener('cancel', (e) => { e.preventDefault(); fecharPedido(); });

  $('#btn-excluir-pedido').addEventListener('click', () => {
    const { lic, p } = ctxP;
    if (somenteLeitura || !p || !confirm(`Excluir o empenho ${p.numero} e seus documentos?`)) return;
    lic.pedidos = lic.pedidos.filter((x) => x !== p);
    for (const a of p.anexos || []) window.Arquivos?.excluir(a).catch(() => {});
    sujoP = false;
    dlgP.close();
    salvar();
    toast('Empenho excluído.');
  });

  // ---------- Documentos anexos ----------
  const CATEGORIAS = {
    contrato: ['Ata de registro de preços', 'Contrato', 'Publicação', 'Termo aditivo', 'Edital', 'Proposta', 'Outro'],
    pedido: ['Nota de empenho', 'Ordem de fornecimento', 'Nota fiscal', 'Canhoto / comprovante de entrega', 'Comprovante de pagamento', 'Outro'],
  };
  const ICONE = (m = '', n = '') => (/pdf/.test(m) || /\.pdf$/i.test(n) ? '📄' : /image/.test(m) ? '🖼️' : /sheet|excel|csv/.test(m) || /\.(xlsx?|csv)$/i.test(n) ? '📊' : /word|doc/.test(m) ? '📝' : '📎');
  const MAX_MB = 25;

  function renderAnexos(box, dono, tipo) {
    box._dono = dono;
    if (!dono) {
      box.innerHTML = `<p class="muted">${tipo === 'contrato' ? 'Lance o contrato/ata' : 'Registre o empenho'} para poder anexar documentos.</p>`;
      return;
    }
    const lista = dono.anexos || [];
    const onde = window.Arquivos?.onde() === 'nuvem' ? 'guardados na sua conta' : 'guardados neste navegador';
    box.innerHTML = `
      ${lista.length ? `<ul class="anexo-lista">${lista.map((a) => `<li>
        <span class="anexo-ico">${ICONE(a.mime, a.nome)}</span>
        <div class="anexo-info"><button type="button" class="link anexo-nome" data-anexo-abrir="${a.id}">${esc(a.nome)}</button>
          <div class="muted small">${esc(a.categoria)} · ${fmtTamanho(a.tamanho || 0)} · ${fmtData(a.data)}</div></div>
        <button type="button" class="btn small" data-anexo-baixar="${a.id}">Baixar</button>
        <button type="button" class="btn small danger so-editor" data-anexo-excluir="${a.id}" aria-label="Excluir">✕</button>
      </li>`).join('')}</ul>` : (somenteLeitura ? '<p class="muted">Nenhum documento anexado.</p>' : '')}
      <div class="dropzone so-editor">
        <select class="anexo-cat" aria-label="Tipo de documento">${CATEGORIAS[tipo].map((c) => `<option>${c}</option>`).join('')}</select>
        <label class="btn small">Escolher arquivo<input type="file" class="anexo-input" multiple hidden></label>
        <span class="muted small">ou arraste aqui · até ${MAX_MB} MB · ${onde}</span>
      </div>`;
  }

  async function enviarArquivos(box, files) {
    const dono = box._dono;
    if (!dono || !window.Arquivos || somenteLeitura) return;
    const cat = $('.anexo-cat', box)?.value || 'Outro';
    for (const file of files) {
      if (file.size > MAX_MB * 1048576) { toast(`${file.name}: maior que ${MAX_MB} MB.`); continue; }
      const anexo = { id: uid(), nome: file.name, categoria: cat, tamanho: file.size, mime: file.type, data: hojeISO() };
      toast(`Enviando ${file.name}…`);
      try {
        Object.assign(anexo, await window.Arquivos.salvar(anexo, file));
        (dono.anexos ||= []).push(anexo);
        salvar(false);
        toast('Documento anexado.');
      } catch (e) {
        toast(`Não foi possível anexar ${file.name}: ${e.message}`);
      }
    }
    refreshAnexos(box);
  }
  function refreshAnexos(box) {
    renderAnexos(box, box._dono, box.dataset.anexos);
    render();
  }
  const acharAnexo = (box, id) => (box._dono?.anexos || []).find((a) => a.id === id);

  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('anexo-input')) {
      const box = e.target.closest('.anexos');
      enviarArquivos(box, [...e.target.files]);
      e.target.value = '';
    }
  });
  document.addEventListener('dragover', (e) => {
    const dz = e.target.closest?.('.dropzone');
    if (dz) { e.preventDefault(); dz.classList.add('over'); }
  });
  document.addEventListener('dragleave', (e) => e.target.closest?.('.dropzone')?.classList.remove('over'));
  document.addEventListener('drop', (e) => {
    const dz = e.target.closest?.('.dropzone');
    if (!dz) return;
    e.preventDefault();
    dz.classList.remove('over');
    enviarArquivos(dz.closest('.anexos'), [...e.dataTransfer.files]);
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-anexo-abrir], [data-anexo-baixar], [data-anexo-excluir]');
    if (!btn) return;
    const box = btn.closest('.anexos');
    const id = btn.dataset.anexoAbrir || btn.dataset.anexoBaixar || btn.dataset.anexoExcluir;
    const a = acharAnexo(box, id);
    if (!a) return;
    if (btn.dataset.anexoExcluir) {
      if (somenteLeitura || !confirm(`Excluir o documento “${a.nome}”?`)) return;
      try { await window.Arquivos.excluir(a); } catch (err) { /* segue removendo da lista */ }
      box._dono.anexos = box._dono.anexos.filter((x) => x !== a);
      salvar(false);
      refreshAnexos(box);
      toast('Documento excluído.');
      return;
    }
    const abrir = !!btn.dataset.anexoAbrir;
    const janela = abrir ? window.open('', '_blank') : null; // abre já, para o navegador não bloquear
    try {
      const blob = await window.Arquivos.abrir(a);
      const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: a.mime || 'application/octet-stream' }));
      if (janela) janela.location = url;
      else {
        const link = document.createElement('a');
        link.href = url; link.download = a.nome; link.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      janela?.close();
      toast(`Não foi possível abrir: ${err.message}`);
    }
  });

  // ---------- Empresas e analistas ----------
  const dlgE = $('#dlg-empresas');
  function renderEmpresas() {
    const cfg = db.config;
    $('#lista-empresas').innerHTML = cfg.empresas.map((e) => `<div class="edit-row" data-emp="${e.id}">
      <input value="${esc(e.nome)}" data-campo="nome" placeholder="Razão social (em branco = nome do PNCP)" autocomplete="off" ${somenteLeitura ? 'disabled' : ''}>
      <input value="${esc(fmtCnpj(e.cnpj))}" data-campo="cnpj" placeholder="CNPJ" inputmode="numeric" autocomplete="off" ${somenteLeitura ? 'disabled' : ''}>
      <button class="btn small danger so-editor" data-rem-emp="${e.id}" aria-label="Remover">✕</button></div>`).join('') || '<p class="muted small">Nenhuma empresa cadastrada.</p>';
    $('#lista-analistas').innerHTML = cfg.analistas.map((n, i) => `<div class="edit-row">
      <input value="${esc(n)}" data-analista="${i}" ${somenteLeitura ? 'disabled' : ''}><button class="btn small danger so-editor" data-rem-ana="${i}" aria-label="Remover">✕</button></div>`).join('') || '<p class="muted small">Nenhum analista cadastrado.</p>';
  }
  function abrirEmpresas() { renderEmpresas(); dlgE.showModal(); }
  $('#btn-empresas').addEventListener('click', abrirEmpresas);
  $('#btn-empresas-menu').addEventListener('click', () => { $('.menu').removeAttribute('open'); abrirEmpresas(); });

  $('#form-add-empresa').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const cnpj = soDigitos(f.empresaCnpj.value);
    if (cnpj.length !== 14) { toast('CNPJ precisa ter 14 dígitos.'); return; }
    if (db.config.empresas.some((x) => x.cnpj === cnpj)) { toast('Esse CNPJ já está cadastrado.'); return; }
    const emp = { id: uid(), nome: f.empresaRazao.value.trim(), cnpj };
    db.config.empresas.push(emp);
    if (db.config.empresas.length === 1) for (const l of db.licitacoes) if (!l.empresaId) l.empresaId = emp.id;
    f.reset();
    salvar();
    renderEmpresas();
  });
  $('#form-add-analista').addEventListener('submit', (e) => {
    e.preventDefault();
    const nome = e.target.analistaNome.value.trim();
    if (!nome || db.config.analistas.includes(nome)) return;
    db.config.analistas.push(nome);
    e.target.reset();
    salvar();
    renderEmpresas();
  });
  dlgE.addEventListener('change', (e) => {
    if (somenteLeitura) return;
    const row = e.target.closest('[data-emp]');
    if (row) {
      const emp = db.config.empresas.find((x) => x.id === row.dataset.emp);
      if (e.target.dataset.campo === 'cnpj') {
        const c = soDigitos(e.target.value);
        if (c.length !== 14) { toast('CNPJ precisa ter 14 dígitos.'); e.target.value = fmtCnpj(emp.cnpj); return; }
        emp.cnpj = c;
      } else emp.nome = e.target.value.trim();
      salvar();
      return;
    }
    if (e.target.dataset.analista !== undefined) {
      const i = +e.target.dataset.analista;
      const antigo = db.config.analistas[i];
      const novo = e.target.value.trim();
      if (!novo) return;
      db.config.analistas[i] = novo;
      for (const l of db.licitacoes) if (l.analista === antigo) l.analista = novo;
      salvar();
    }
  });
  dlgE.addEventListener('click', (e) => {
    if (somenteLeitura) return;
    const re = e.target.closest('[data-rem-emp]');
    if (re) {
      const emp = db.config.empresas.find((x) => x.id === re.dataset.remEmp);
      const n = db.licitacoes.filter((l) => l.empresaId === emp.id).length;
      if (!confirm(`Remover ${nomeEmpresa(emp)}?${n ? `\n${n} contrato(s) ficarão sem empresa.` : ''}`)) return;
      db.config.empresas = db.config.empresas.filter((x) => x !== emp);
      for (const l of db.licitacoes) if (l.empresaId === emp.id) l.empresaId = '';
      salvar(); renderEmpresas();
    }
    const ra = e.target.closest('[data-rem-ana]');
    if (ra) { db.config.analistas.splice(+ra.dataset.remAna, 1); salvar(); renderEmpresas(); }
  });

  // ---------- Exportar para Excel ----------
  const numBR = (v) => (Number(v) || 0).toFixed(2).replace('.', ',');
  function linhasExport(tipo) {
    if (tipo === 'contratos') {
      const cab = ['Empresa', 'Tipo', 'Nº contrato/ata', 'Órgão', 'CNPJ do órgão', 'Licitação', 'Processo', 'Objeto', 'Analista', 'Status',
        'Ação pendente', 'Assinado por nós', 'Assinado pelo órgão', 'Publicado', 'Vigência início', 'Vigência fim', 'Valor total', 'Empenhado', 'Saldo'];
      return [cab, ...listaContratos().map(({ l, s }) => [nomeEmpresa(empresaDe(l)), INSTRUMENTO[l.instrumento] || '', l.numeroInstrumento, l.orgao,
        fmtCnpj(l.orgaoCnpj), l.numero, l.processo, l.objeto, l.analista, s.rotulo, s.acoes.map((a) => a.texto).join('; '),
        fmtData(l.etapas?.assinadoNos), fmtData(l.etapas?.assinadoOrgao), fmtData(l.etapas?.publicado),
        fmtData(l.vigenciaInicio), fmtData(l.vigenciaFim), numBR(l.valor), numBR(totalPedidos(l)), numBR(saldo(l))])];
    }
    const cab = ['Empresa', 'Empenho/OF', 'Órgão', 'Contrato/ata', 'Licitação', 'Recebido', 'Entregar até', 'Entregue', 'NF', 'NF emitida', 'Pago', 'Valor', 'Status'];
    return [cab, ...listaPedidos().map(({ l, p, s }) => [nomeEmpresa(empresaDe(l)), p.numero, p.orgao || l.orgao, docNumero(l), l.numero,
      fmtData(p.dataRecebimento), fmtData(vencimentoEntrega(l, p)), fmtData(p.dataEntrega), p.nf, fmtData(p.dataNF), fmtData(p.dataPagamento), numBR(p.valor), s.rotulo])];
  }
  const limpaCel = (v) => String(v ?? '').replace(/^—$/, '').replace(/[\t\r\n]+/g, ' ');
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copiar], [data-baixar]');
    if (!btn) return;
    const tipo = btn.dataset.copiar || btn.dataset.baixar;
    const linhas = linhasExport(tipo);
    if (btn.dataset.copiar) {
      const tsv = linhas.map((r) => r.map(limpaCel).join('\t')).join('\n');
      try { await navigator.clipboard.writeText(tsv); toast(`${linhas.length - 1} linhas copiadas. Cole no Excel (Ctrl+V).`); }
      catch (err) { toast('Não foi possível copiar. Use “Baixar planilha”.'); }
    } else {
      const csv = '﻿' + linhas.map((r) => r.map((v) => `"${limpaCel(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = `${tipo}-${hojeISO()}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  });

  // ---------- Navegação e eventos gerais ----------
  function mostrarView(v) { ui.view = v; salvarUI(); renderTabs(); }
  $$('.tab').forEach((t) => t.addEventListener('click', () => mostrarView(t.dataset.view)));

  document.addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) {
      const d = close.closest('dialog');
      if (d === dlgC) fecharContrato(); else if (d === dlgP) fecharPedido(); else d?.close();
      return;
    }
    const chip = e.target.closest('[data-empresa]');
    if (chip) { ui.empresa = chip.dataset.empresa; salvarUI(); render(); return; }
    const pc = e.target.closest('[data-pill-c]');
    if (pc) { ui.pillC = pc.dataset.pillC; salvarUI(); renderContratos(); return; }
    const pp = e.target.closest('[data-pill-p]');
    if (pp) { ui.pillP = pp.dataset.pillP; salvarUI(); renderPedidos(); return; }
    const pz = e.target.closest('[data-pill-z]');
    if (pz) { ui.pillZ = pz.dataset.pillZ; salvarUI(); renderPrazos(); return; }
    const ir = e.target.closest('[data-ir]');
    if (ir) { if (ir.dataset.pill) ui.pillC = ir.dataset.pill; mostrarView(ir.dataset.ir); renderContratos(); return; }
    const row = e.target.closest('[data-lic]');
    if (row && !e.target.closest('dialog') && !e.target.closest('a')) {
      if (row.dataset.pedido) abrirPedido(row.dataset.lic, row.dataset.pedido);
      else abrirContrato(row.dataset.lic);
    }
  });
  // Fecha o painel ao clicar fora dele
  for (const d of [dlgC, dlgP]) d.addEventListener('mousedown', (e) => { if (e.target === d) (d === dlgC ? fecharContrato : fecharPedido)(); });

  $('#busca-contratos').addEventListener('input', renderContratos);
  $('#busca-pedidos').addEventListener('input', renderPedidos);
  $('#ordem-contratos').addEventListener('change', (e) => { ui.ordemC = e.target.value; salvarUI(); renderContratos(); });
  $('#ordem-pedidos').addEventListener('change', (e) => { ui.ordemP = e.target.value; salvarUI(); renderPedidos(); });
  $('#f-prazo-concluidos').addEventListener('change', renderPrazos);
  $('#btn-novo').addEventListener('click', () => abrirContrato(null));

  // ---------- Backup ----------
  const fecharMenu = () => $('.menu').removeAttribute('open');
  $('#btn-exportar').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `licitacoes-backup-${hojeISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    fecharMenu();
    toast('Backup exportado (os arquivos anexados não vão no backup).');
  });
  /** Junta um arquivo importado aos dados atuais (não apaga nada).
   *  Empresas: casadas pelo CNPJ. Contratos: pelo id ou pelo par CNPJ do órgão + nº do contrato/ata. */
  function juntarDados(data) {
    const entrada = normalizar(JSON.parse(JSON.stringify(data)));
    const cfg = db.config;
    const mapaEmp = {};
    let empresas = 0;
    for (const e of entrada.config.empresas) {
      const existente = cfg.empresas.find((x) => x.cnpj && x.cnpj === e.cnpj);
      if (existente) { mapaEmp[e.id] = existente.id; if (!existente.nome && e.nome) existente.nome = e.nome; }
      else { cfg.empresas.push(e); mapaEmp[e.id] = e.id; empresas++; }
    }
    for (const a of entrada.config.analistas) if (!cfg.analistas.includes(a)) cfg.analistas.push(a);
    let novos = 0, atualizados = 0;
    const chave = (l) => (l.orgaoCnpj && l.numeroInstrumento ? soDigitos(l.orgaoCnpj) + '|' + l.numeroInstrumento.trim().toUpperCase() : null);
    for (const l of entrada.licitacoes) {
      if (l.empresaId) l.empresaId = mapaEmp[l.empresaId] || l.empresaId;
      if (!l.empresaId && cfg.empresas.length === 1) l.empresaId = cfg.empresas[0].id;
      const atual = db.licitacoes.find((x) => x.id === l.id) || (chave(l) && db.licitacoes.find((x) => chave(x) === chave(l)));
      if (!atual) { db.licitacoes.push(l); novos++; continue; }
      // Atualiza só os campos preenchidos no arquivo; mantém empenhos, documentos e o que já foi feito
      for (const [k, v] of Object.entries(l)) {
        if (['id', 'pedidos', 'anexos', 'etapas'].includes(k)) continue;
        if (v !== '' && v != null && !(Array.isArray(v) && !v.length)) atual[k] = v;
      }
      atual.etapas = { ...(l.etapas || {}), ...Object.fromEntries(Object.entries(atual.etapas || {}).filter(([, v]) => v)) };
      const ids = new Set(atual.pedidos.map((p) => p.id));
      for (const p of l.pedidos || []) if (!ids.has(p.id)) atual.pedidos.push(p);
      atualizados++;
    }
    return { novos, atualizados, empresas };
  }

  $('#inp-importar').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    fecharMenu();
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.licitacoes)) throw new Error('formato');
      const r = juntarDados(data);
      salvar();
      toast(`Importado: ${r.novos} novo(s), ${r.atualizados} atualizado(s)${r.empresas ? `, ${r.empresas} empresa(s) nova(s)` : ''}.`);
    } catch (err) { toast('Arquivo inválido.'); }
  });
  $('#btn-limpar').addEventListener('click', () => {
    fecharMenu();
    if (!confirm('Apagar TODOS os contratos e empenhos? Exporte um backup antes se quiser guardar.')) return;
    db = normalizar({ licitacoes: [], config: db.config });
    salvar();
  });

  $('#btn-exemplo').addEventListener('click', () => {
    fecharMenu();
    if (db.licitacoes.length && !confirm('Adicionar dados de exemplo aos seus dados atuais?')) return;
    const d = (n) => toISO(new Date(hoje().getTime() + n * 86400000));
    const cfg = db.config;
    if (!cfg.empresas.length) cfg.empresas.push({ id: uid(), nome: 'EMPRESA EXEMPLO A LTDA', cnpj: '00000000000191' }, { id: uid(), nome: 'EMPRESA EXEMPLO B LTDA', cnpj: '00000000000272' });
    if (!cfg.analistas.length) cfg.analistas.push('Maria', 'João');
    const [eA, eB] = [cfg.empresas[0].id, (cfg.empresas[1] || cfg.empresas[0]).id];
    const ped = (o) => ({ id: uid(), anexos: [], descricao: '', orgao: '', dataEntrega: '', nf: '', dataNF: '', dataPagamento: '', obs: '', ...o });
    db.licitacoes.push(
      {
        id: uid(), empresaId: eA, analista: 'Maria', orgao: 'PREFEITURA MUNICIPAL DE EXEMPLO', orgaoCnpj: '', uasg: '', numero: 'PE 045/2026', processo: '1234/2026',
        modalidade: 'Pregão eletrônico', objeto: 'Material de expediente', dataSessao: d(-120), resultado: 'ganha', valor: 84500, link: '',
        instrumento: 'ata', numeroInstrumento: 'ARP 112/2026', vigenciaInicio: d(-100), vigenciaFim: d(265), situacao: '',
        etapas: { recebido: d(-108), assinadoNos: d(-106), assinadoOrgao: d(-101), publicado: d(-100) },
        prazoEntregaDias: '15', prazoPagamentoDias: '30', contato: 'Fiscal: Ana', obs: '', anexos: [], itens: [],
        pedidos: [
          ped({ numero: '2026NE000321', valor: 12300, dataRecebimento: d(-60), prazoDias: '15', descricao: 'Papel A4 e canetas', dataEntrega: d(-50), nf: '1520', dataNF: d(-50), dataPagamento: d(-22) }),
          ped({ numero: '2026NE000488', valor: 9800, dataRecebimento: d(-30), prazoDias: '15', descricao: 'Toners', dataEntrega: d(-18), nf: '1588', dataNF: d(-18) }),
          ped({ numero: '2026NE000590', valor: 4100, dataRecebimento: d(-12), prazoDias: '15', descricao: 'Grampeadores', dataEntrega: d(-2) }),
          ped({ numero: '2026NE000612', valor: 15400, dataRecebimento: d(-10), prazoDias: '15', descricao: 'Pastas e arquivos' }),
        ],
      },
      {
        id: uid(), empresaId: eB, analista: 'João', orgao: 'SECRETARIA ESTADUAL DE SAÚDE', orgaoCnpj: '', uasg: '', numero: 'PE 210/2026', processo: '',
        modalidade: 'Pregão eletrônico', objeto: 'Luvas de procedimento', dataSessao: d(-200), resultado: 'ganha', valor: 230000, link: '',
        instrumento: 'contrato', numeroInstrumento: 'CT 77/2026', vigenciaInicio: d(-180), vigenciaFim: d(40), situacao: '',
        etapas: { recebido: d(-185), assinadoNos: d(-184), assinadoOrgao: d(-181), publicado: d(-180) },
        prazoEntregaDias: '10', prazoPagamentoDias: '30', contato: '', obs: 'Verificar interesse em aditivo de prazo.', anexos: [], itens: [],
        pedidos: [ped({ numero: 'OF 09/2026', valor: 46000, dataRecebimento: d(-14), prazoDias: '10', descricao: '2.000 caixas' })],
      },
      {
        id: uid(), empresaId: eA, analista: '', orgao: 'MUNICÍPIO DE POUSO ALTO', orgaoCnpj: '', uasg: '', numero: 'PE 22/2026', processo: '',
        modalidade: 'Pregão eletrônico', objeto: 'Comboio de abastecimento', dataSessao: d(-20), resultado: 'ganha', valor: 179000, link: '',
        instrumento: 'contrato', numeroInstrumento: 'CT 58/2026', vigenciaInicio: '', vigenciaFim: '', situacao: '',
        etapas: { recebido: d(-3) }, prazoEntregaDias: '60', prazoPagamentoDias: '30', contato: '', obs: '', anexos: [], itens: [], pedidos: [],
      },
      {
        id: uid(), empresaId: eB, analista: 'Maria', orgao: 'UNIVERSIDADE FEDERAL EXEMPLO', numero: 'PE 18/2026', modalidade: 'Pregão eletrônico',
        objeto: 'Mobiliário de escritório', dataSessao: d(-25), resultado: 'aguardando', valor: 0, pedidos: [], anexos: [], etapas: {}, situacao: '',
      },
    );
    db = normalizar(db);
    salvar();
    toast('Dados de exemplo carregados.');
  });

  // ---------- API para os outros módulos ----------
  window.App = {
    db: () => db, salvar, uid, esc, toast,
    abrirContrato, abrirDetalhe: abrirContrato, abrirPedido,
    fmtMoeda, fmtData, fmtCnpj, parseData, toISO, hoje, soDigitos,
    onRender: (fn) => renderHooks.push(fn),
    onSalvar: (fn) => saveHooks.push(fn),
    setSomenteLeitura: (v) => { somenteLeitura = !!v; if (somenteLeitura && ui.view === 'pncp') ui.view = 'painel'; render(); },
    somenteLeitura: () => somenteLeitura,
    usarDados, STORAGE_KEY,
  };

  render();
})();
