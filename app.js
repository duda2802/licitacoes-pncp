/* Minhas Licitações — acompanhamento pós-licitação.
 * Dados ficam no localStorage do navegador; use Backup > Exportar para guardar uma cópia. */
(() => {
  'use strict';

  const STORAGE_KEY = 'licitacoes-pncp:v1';
  const ALERTA_VIGENCIA_DIAS = 60;
  const ALERTA_ENTREGA_DIAS = 7;
  const PRAZO_PAGAMENTO_PADRAO = 30;

  // ---------- Estado ----------
  let db = carregar();

  function carregar() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (Array.isArray(data.licitacoes)) return normalizar(data);
      }
    } catch (e) { /* storage indisponível */ }
    return normalizar({ licitacoes: [] });
  }
  function normalizar(data) {
    data.config = { cnpjs: [], ...(data.config || {}) };
    return data;
  }
  function salvar(rerender = true) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); }
    catch (e) { toast('Não foi possível salvar no navegador. Exporte um backup!'); }
    if (rerender) render();
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- Utilidades ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtMoeda = (v) => brl.format(Number(v) || 0);

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

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- Regras de negócio ----------
  function vencimentoEntrega(lic, p) {
    const prazo = p.prazoDias !== '' && p.prazoDias != null ? p.prazoDias : lic.prazoEntregaDias;
    return addDias(p.dataRecebimento, prazo);
  }
  function vencimentoPagamento(lic, p) {
    if (!p.dataEntrega) return null;
    const prazo = lic.prazoPagamentoDias !== '' && lic.prazoPagamentoDias != null ? lic.prazoPagamentoDias : PRAZO_PAGAMENTO_PADRAO;
    return addDias(p.dataEntrega, prazo);
  }

  /** Situação de um pedido/empenho: {etapa, rotulo, classe, dias} */
  function situacaoPedido(lic, p) {
    if (p.dataPagamento) return { etapa: 'pago', rotulo: 'Pago', classe: 'ok' };
    if (p.dataEntrega) {
      const venc = vencimentoPagamento(lic, p);
      const d = venc ? diasAte(venc) : null;
      if (d != null && d < 0) return { etapa: 'pagamento', rotulo: `Pagamento atrasado ${-d}d`, classe: 'danger', dias: d, venc };
      return { etapa: 'pagamento', rotulo: 'Aguardando pagamento', classe: 'info', dias: d, venc };
    }
    const venc = vencimentoEntrega(lic, p);
    if (!venc) return { etapa: 'entrega', rotulo: 'Entregar (sem prazo)', classe: 'warn' };
    const d = diasAte(venc);
    if (d < 0) return { etapa: 'entrega', rotulo: `Entrega atrasada ${-d}d`, classe: 'danger', dias: d, venc };
    if (d <= ALERTA_ENTREGA_DIAS) return { etapa: 'entrega', rotulo: `Entregar ${textoDias(d)}`, classe: 'warn', dias: d, venc };
    return { etapa: 'entrega', rotulo: `Entregar até ${fmtData(venc)}`, classe: 'info', dias: d, venc };
  }

  function situacaoVigencia(lic) {
    if (lic.resultado !== 'ganha' || !lic.vigenciaFim) return null;
    const d = diasAte(lic.vigenciaFim);
    if (d < 0) return { chave: 'encerrada', rotulo: 'Encerrada', classe: '', dias: d };
    if (d <= ALERTA_VIGENCIA_DIAS) return { chave: 'vencendo', rotulo: `Termina ${textoDias(d)}`, classe: 'warn', dias: d };
    return { chave: 'vigente', rotulo: `${d} dias restantes`, classe: 'ok', dias: d };
  }

  const totalPedidos = (lic) => (lic.pedidos || []).reduce((s, p) => s + (Number(p.valor) || 0), 0);
  const saldo = (lic) => (Number(lic.valor) || 0) - totalPedidos(lic);

  const RESULTADO = {
    ganha: { rotulo: 'Ganha', classe: 'ok' },
    aguardando: { rotulo: 'Aguardando', classe: 'info' },
    perdida: { rotulo: 'Perdida', classe: '' },
  };
  const INSTRUMENTO = { ata: 'Ata RP', contrato: 'Contrato', empenho: 'Empenho/OF' };

  /** Lista de todos os prazos (entregas, pagamentos, vigências). */
  function todosPrazos() {
    const out = [];
    for (const lic of db.licitacoes) {
      if (lic.resultado !== 'ganha') continue;
      for (const p of lic.pedidos || []) {
        const s = situacaoPedido(lic, p);
        const base = { licId: lic.id, pedidoId: p.id, orgao: p.orgao || lic.orgao, valor: p.valor };
        const desc = p.descricao && !p.pncp ? ' — ' + p.descricao : '';
        const venc = vencimentoEntrega(lic, p);
        out.push({
          ...base, tipo: 'entrega', data: venc,
          descricao: `Entrega do empenho ${p.numero}${desc}`,
          concluido: !!p.dataEntrega,
          situacao: p.dataEntrega ? { rotulo: `Entregue ${fmtData(p.dataEntrega)}`, classe: 'ok' } : s,
        });
        if (p.dataEntrega) {
          out.push({
            ...base, tipo: 'pagamento', data: vencimentoPagamento(lic, p),
            descricao: `Pagamento do empenho ${p.numero}${p.nf ? ' (NF ' + p.nf + ')' : ''}`,
            concluido: !!p.dataPagamento,
            situacao: p.dataPagamento ? { rotulo: `Pago ${fmtData(p.dataPagamento)}`, classe: 'ok' } : s,
          });
        }
      }
      const v = situacaoVigencia(lic);
      if (v) {
        out.push({
          licId: lic.id, tipo: 'vigencia', data: lic.vigenciaFim, orgao: lic.orgao, valor: saldo(lic),
          descricao: `Fim da vigência — ${INSTRUMENTO[lic.instrumento] || ''} ${lic.numeroInstrumento || lic.numero}`.trim(),
          concluido: v.chave === 'encerrada',
          situacao: v,
        });
      }
    }
    return out.sort((a, b) => (a.data || '9999').localeCompare(b.data || '9999'));
  }

  // ---------- Render ----------
  const renderHooks = [];
  function render() {
    renderHooks.forEach((fn) => fn());
    renderPainel();
    renderLicitacoes();
    renderPrazos();
    const aberta = $('#dlg-detalhe').open && $('#dlg-detalhe').dataset.id;
    if (aberta) abrirDetalhe(aberta);
  }

  function renderPainel() {
    const lics = db.licitacoes;
    const ganhas = lics.filter((l) => l.resultado === 'ganha');
    const decididas = lics.filter((l) => l.resultado !== 'aguardando').length;
    const valorGanho = ganhas.reduce((s, l) => s + (Number(l.valor) || 0), 0);
    let aReceber = 0, recebido = 0, saldoAtas = 0, entregasPend = 0;
    for (const l of ganhas) {
      const vig = situacaoVigencia(l);
      if (!vig || vig.chave !== 'encerrada') saldoAtas += Math.max(0, saldo(l));
      for (const p of l.pedidos || []) {
        if (p.dataPagamento) recebido += Number(p.valor) || 0;
        else if (p.dataEntrega) aReceber += Number(p.valor) || 0;
        else entregasPend++;
      }
    }
    const taxa = decididas ? Math.round((ganhas.length / decididas) * 100) : 0;
    const kpis = [
      { label: 'Licitações ganhas', value: ganhas.length, sub: decididas ? `${taxa}% de êxito (${decididas} com resultado)` : 'nenhuma com resultado ainda' },
      { label: 'Valor ganho', value: fmtMoeda(valorGanho), sub: 'soma das adjudicações' },
      { label: 'Saldo a ser pedido', value: fmtMoeda(saldoAtas), sub: 'contratos/atas vigentes' },
      { label: 'Entregas pendentes', value: entregasPend, sub: 'empenhos ainda não entregues' },
      { label: 'A receber', value: fmtMoeda(aReceber), sub: 'entregue, aguardando pagamento' },
      { label: 'Recebido', value: fmtMoeda(recebido), sub: 'pagamentos confirmados' },
    ];
    $('#kpis').innerHTML = kpis.map((k) => `
      <div class="card kpi"><div class="label">${esc(k.label)}</div><div class="value">${esc(k.value)}</div><div class="sub">${esc(k.sub)}</div></div>`).join('');

    const prazos = todosPrazos().filter((p) => !p.concluido);
    const urgentes = prazos.filter((p) => {
      if (p.tipo === 'vigencia') return p.situacao.chave === 'vencendo';
      return p.situacao.classe === 'danger' || p.situacao.classe === 'warn';
    });
    const proximos = prazos.filter((p) => !urgentes.includes(p) && p.data && diasAte(p.data) >= 0).slice(0, 6);

    // Licitações aguardando resultado há muito tempo também viram alerta
    const semResultado = lics.filter((l) => l.resultado === 'aguardando' && l.dataSessao && diasAte(l.dataSessao) < -15);

    const itemPrazo = (p) => `
      <li data-lic="${p.licId}">
        <span class="badge ${p.situacao.classe}">${esc(p.situacao.rotulo)}</span>
        <div class="a-body">
          <div class="a-title">${esc(p.descricao)}</div>
          <div class="a-sub">${esc(p.orgao)} · ${fmtData(p.data)}${p.valor ? ' · ' + fmtMoeda(p.valor) : ''}</div>
        </div>
      </li>`;
    const itemSemRes = (l) => `
      <li data-lic="${l.id}">
        <span class="badge">Sem resultado</span>
        <div class="a-body">
          <div class="a-title">${esc(l.numero)} — atualize o resultado</div>
          <div class="a-sub">${esc(l.orgao)} · sessão em ${fmtData(l.dataSessao)}</div>
        </div>
      </li>`;

    const LIMITE = 8;
    const todosAlertas = [...urgentes.map(itemPrazo), ...semResultado.map(itemSemRes)];
    const mais = todosAlertas.length - LIMITE;
    const alertasHtml = todosAlertas.slice(0, LIMITE).join('') +
      (mais > 0 ? `<li class="ver-mais" data-ir="prazos">+ ${mais} outro${mais > 1 ? 's' : ''} — ver todos em Prazos →</li>` : '');
    $('#alertas').innerHTML = alertasHtml || '<li class="none">Nada urgente. 🎉</li>';
    $('#proximos').innerHTML = proximos.map(itemPrazo).join('') ||
      `<li class="none">${lics.length ? 'Nenhum prazo futuro cadastrado.' : 'Importe suas licitações na aba PNCP, cadastre em “+ Nova licitação” ou carregue dados de exemplo no menu Backup.'}</li>`;
  }

  function pendenciasLic(lic) {
    if (lic.resultado !== 'ganha') return '';
    const cont = { danger: 0, warn: 0, entregar: 0, receber: 0 };
    for (const p of lic.pedidos || []) {
      const s = situacaoPedido(lic, p);
      if (s.classe === 'danger') cont.danger++;
      else if (s.etapa === 'entrega') cont.entregar++;
      else if (s.etapa === 'pagamento') cont.receber++;
    }
    const b = [];
    if (cont.danger) b.push(`<span class="badge danger">${cont.danger} atrasado${cont.danger > 1 ? 's' : ''}</span>`);
    if (cont.entregar) b.push(`<span class="badge warn">${cont.entregar} a entregar</span>`);
    if (cont.receber) b.push(`<span class="badge info">${cont.receber} a receber</span>`);
    return b.join(' ') || '<span class="muted">—</span>';
  }

  function renderLicitacoes() {
    const busca = $('#f-busca').value.trim().toLowerCase();
    const fr = $('#f-resultado').value;
    const fs = $('#f-situacao').value;
    const lista = db.licitacoes
      .filter((l) => !fr || l.resultado === fr)
      .filter((l) => !fs || situacaoVigencia(l)?.chave === fs)
      .filter((l) => !busca || [l.orgao, l.numero, l.objeto, l.numeroInstrumento].join(' ').toLowerCase().includes(busca))
      .sort((a, b) => (b.dataSessao || '').localeCompare(a.dataSessao || ''));

    $('#tabela-licitacoes tbody').innerHTML = lista.map((l) => {
      const r = RESULTADO[l.resultado] || RESULTADO.aguardando;
      const v = situacaoVigencia(l);
      const ganha = l.resultado === 'ganha';
      return `
        <tr class="clickable" data-lic="${l.id}">
          <td><strong>${esc(l.orgao)}</strong><div class="muted">${esc(l.numero)}${l.dataSessao ? ' · ' + fmtData(l.dataSessao) : ''}</div></td>
          <td>${esc(l.objeto) || '<span class="muted">—</span>'}</td>
          <td><span class="badge ${r.classe}">${r.rotulo}</span></td>
          <td class="num">${ganha ? fmtMoeda(l.valor) : '<span class="muted">—</span>'}</td>
          <td class="num">${ganha ? fmtMoeda(saldo(l)) : '<span class="muted">—</span>'}</td>
          <td>${v ? `<span class="badge ${v.classe}">${esc(v.rotulo)}</span><div class="muted">até ${fmtData(l.vigenciaFim)}</div>` : '<span class="muted">—</span>'}</td>
          <td>${pendenciasLic(l)}</td>
        </tr>`;
    }).join('');

    const vazio = $('#vazio-licitacoes');
    vazio.hidden = lista.length > 0;
    vazio.textContent = db.licitacoes.length ? 'Nenhuma licitação encontrada com esses filtros.' : 'Nenhuma licitação cadastrada ainda.';
    $('#tabela-licitacoes').parentElement.hidden = lista.length === 0;
  }

  function renderPrazos() {
    const tipo = $('#f-prazo-tipo').value;
    const conc = $('#f-prazo-concluidos').checked;
    const lista = todosPrazos().filter((p) => (!tipo || p.tipo === tipo) && (conc || !p.concluido));
    const TIPO = { entrega: 'Entrega', pagamento: 'Pagamento', vigencia: 'Vigência' };
    $('#tabela-prazos tbody').innerHTML = lista.map((p) => `
      <tr class="clickable" data-lic="${p.licId}">
        <td><strong>${fmtData(p.data)}</strong>${p.data && !p.concluido ? `<div class="muted">${textoDias(diasAte(p.data))}</div>` : ''}</td>
        <td>${TIPO[p.tipo]}</td>
        <td>${esc(p.descricao)}</td>
        <td>${esc(p.orgao)}</td>
        <td class="num">${p.valor ? fmtMoeda(p.valor) : '—'}</td>
        <td><span class="badge ${p.situacao.classe}">${esc(p.situacao.rotulo)}</span></td>
      </tr>`).join('');
    $('#vazio-prazos').hidden = lista.length > 0;
    $('#tabela-prazos').parentElement.hidden = lista.length === 0;
  }

  // ---------- Detalhe ----------
  function abrirDetalhe(id) {
    const lic = db.licitacoes.find((l) => l.id === id);
    const dlg = $('#dlg-detalhe');
    if (!lic) { dlg.close(); return; }
    dlg.dataset.id = id;
    const r = RESULTADO[lic.resultado] || RESULTADO.aguardando;
    const v = situacaoVigencia(lic);
    const ganha = lic.resultado === 'ganha';
    const pedido = totalPedidos(lic);
    const pct = lic.valor ? Math.min(100, Math.round((pedido / lic.valor) * 100)) : 0;
    const pedidos = [...(lic.pedidos || [])].sort((a, b) => (b.dataRecebimento || '').localeCompare(a.dataRecebimento || ''));

    $('#detalhe-conteudo').innerHTML = `
      <div class="det-head">
        <div>
          <h2>${esc(lic.orgao)}</h2>
          <div class="muted">${esc(lic.numero)} · ${esc(lic.modalidade || '')}${lic.dataSessao ? ' · sessão em ' + fmtData(lic.dataSessao) : ''}</div>
          ${lic.objeto ? `<p>${esc(lic.objeto)}</p>` : ''}
          <span class="badge ${r.classe}">${r.rotulo}</span>
          ${v ? `<span class="badge ${v.classe}">Vigência: ${esc(v.rotulo)}</span>` : ''}
          ${lic.link ? ` <a href="${esc(lic.link)}" target="_blank" rel="noopener">Abrir no portal ↗</a>` : ''}
        </div>
        <div style="display:flex;gap:.5rem">
          ${lic.pncp?.compra ? '<button class="btn" data-acao="pncp-atualizar" title="Buscar novos empenhos no PNCP">↻ PNCP</button>' : ''}
          <button class="btn" data-acao="editar">Editar</button>
          <button class="btn" data-close>Fechar</button>
        </div>
      </div>
      ${ganha ? `
      <div class="det-grid">
        <div><div class="k">Valor ganho</div><div class="v">${fmtMoeda(lic.valor)}</div></div>
        <div><div class="k">Já pedido (${pct}%)</div><div class="v">${fmtMoeda(pedido)}</div><div class="progress"><span style="width:${pct}%"></span></div></div>
        <div><div class="k">Saldo</div><div class="v">${fmtMoeda(saldo(lic))}</div></div>
        <div><div class="k">${esc(INSTRUMENTO[lic.instrumento] || 'Instrumento')}</div><div class="v">${esc(lic.numeroInstrumento) || '—'}</div></div>
        <div><div class="k">Vigência</div><div class="v">${fmtData(lic.vigenciaInicio)} a ${fmtData(lic.vigenciaFim)}</div></div>
        <div><div class="k">Prazos padrão</div><div class="v">Entrega ${lic.prazoEntregaDias || '—'}d · Pagto ${lic.prazoPagamentoDias || PRAZO_PAGAMENTO_PADRAO}d</div></div>
        ${lic.contato ? `<div><div class="k">Contato</div><div class="v">${esc(lic.contato)}</div></div>` : ''}
      </div>
      <div class="section-head">
        <h3>Pedidos / empenhos (${pedidos.length})</h3>
        <button class="btn primary small" data-acao="novo-pedido">+ Novo empenho</button>
      </div>
      ${pedidos.length ? `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Empenho / OF</th><th>Recebido</th><th>Entregar até</th><th>Entregue</th><th>Pago</th><th class="num">Valor</th><th>Situação</th><th></th></tr></thead>
        <tbody>${pedidos.map((p) => {
          const s = situacaoPedido(lic, p);
          return `<tr>
            <td><strong>${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.numero)}</a>` : esc(p.numero)}</strong>${p.orgao ? `<div class="muted clamp1" title="${esc(p.orgao)}">${esc(p.orgao)}</div>` : ''}${p.descricao ? `<div class="muted clamp1" title="${esc(p.descricao)}">${esc(p.descricao)}</div>` : ''}</td>
            <td>${fmtData(p.dataRecebimento)}</td>
            <td>${fmtData(vencimentoEntrega(lic, p))}</td>
            <td>${p.dataEntrega ? fmtData(p.dataEntrega) + (p.nf ? `<div class="muted">NF ${esc(p.nf)}</div>` : '') : `<button class="btn small" data-acao="entregar" data-pedido="${p.id}">Marcar entregue</button>`}</td>
            <td>${p.dataPagamento ? fmtData(p.dataPagamento) : (p.dataEntrega ? `<button class="btn small" data-acao="pagar" data-pedido="${p.id}">Marcar pago</button>` : '—')}</td>
            <td class="num">${fmtMoeda(p.valor)}</td>
            <td><span class="badge ${s.classe}">${esc(s.rotulo)}</span></td>
            <td><button class="btn small" data-acao="editar-pedido" data-pedido="${p.id}">Editar</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : '<p class="muted">Nenhum empenho recebido ainda. Quando o órgão enviar a nota de empenho ou ordem de fornecimento, cadastre aqui para controlar o prazo de entrega.</p>'}
      ${lic.itens?.length ? `
      <div class="section-head"><h3>Itens ganhos (${lic.itens.length})</h3><span class="badge info">via PNCP</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Item</th><th>Descrição</th><th class="num">Qtd.</th><th class="num">Valor unit.</th><th class="num">Total</th></tr></thead>
        <tbody>${lic.itens.map((it) => `<tr>
          <td>${it.numero}</td>
          <td><div class="clamp">${esc(it.descricao)}</div></td>
          <td class="num">${Number(it.quantidade).toLocaleString('pt-BR')} <span class="muted">${esc(it.unidade || '')}</span></td>
          <td class="num">${fmtMoeda(it.valorUnit)}</td>
          <td class="num">${fmtMoeda(it.valorTotal)}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : ''}
      ` : `<p class="muted">${lic.resultado === 'aguardando' ? 'Quando sair o resultado, edite a licitação e marque como “Ganha” para controlar contrato, empenhos, entregas e pagamentos.' : 'Licitação perdida.'}</p>`}
      ${lic.obs ? `<h3>Observações</h3><p style="white-space:pre-wrap">${esc(lic.obs)}</p>` : ''}
    `;
    if (!dlg.open) dlg.showModal();
  }

  $('#dlg-detalhe').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-acao]');
    if (!btn) return;
    const lic = db.licitacoes.find((l) => l.id === $('#dlg-detalhe').dataset.id);
    if (!lic) return;
    const acao = btn.dataset.acao;
    const p = lic.pedidos?.find((x) => x.id === btn.dataset.pedido);
    if (acao === 'editar') abrirFormLicitacao(lic);
    else if (acao === 'pncp-atualizar') window.PNCP?.atualizarLicitacao(lic);
    else if (acao === 'novo-pedido') abrirFormPedido(lic);
    else if (acao === 'editar-pedido') abrirFormPedido(lic, p);
    else if (acao === 'entregar' && p) { p.dataEntrega = toISO(hoje()); salvar(); toast('Entrega registrada hoje. Edite para ajustar a data ou incluir a NF.'); }
    else if (acao === 'pagar' && p) { p.dataPagamento = toISO(hoje()); salvar(); toast('Pagamento registrado.'); }
  });

  // ---------- Formulários ----------
  const formLic = $('#form-licitacao');
  const dlgLic = $('#dlg-licitacao');
  let editandoLic = null;

  function toggleGanha() {
    $('.so-ganha', formLic).hidden = formLic.resultado.value !== 'ganha';
  }
  formLic.resultado.addEventListener('change', toggleGanha);

  function abrirFormLicitacao(lic = null) {
    editandoLic = lic;
    formLic.reset();
    $('#dlg-licitacao-titulo').textContent = lic ? 'Editar licitação' : 'Nova licitação';
    $('#btn-excluir-licitacao').hidden = !lic;
    if (lic) {
      for (const el of formLic.elements) {
        if (!el.name || !(el.name in lic)) continue;
        el.value = el.name === 'valor' ? moedaInput(lic.valor) : (lic[el.name] ?? '');
      }
    }
    toggleGanha();
    dlgLic.showModal();
  }

  formLic.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(formLic));
    data.valor = parseMoeda(data.valor);
    if (data.vigenciaInicio && data.vigenciaFim && data.vigenciaFim < data.vigenciaInicio) {
      toast('O fim da vigência é antes do início.');
      return;
    }
    if (editandoLic) Object.assign(editandoLic, data);
    else db.licitacoes.push({ id: uid(), pedidos: [], ...data });
    dlgLic.close();
    salvar();
    toast('Licitação salva.');
  });

  $('#btn-excluir-licitacao').addEventListener('click', () => {
    if (!editandoLic || !confirm(`Excluir a licitação ${editandoLic.numero} e todos os seus empenhos?`)) return;
    db.licitacoes = db.licitacoes.filter((l) => l !== editandoLic);
    dlgLic.close();
    $('#dlg-detalhe').close();
    salvar();
    toast('Licitação excluída.');
  });

  const formPed = $('#form-pedido');
  const dlgPed = $('#dlg-pedido');
  let pedCtx = null;

  function abrirFormPedido(lic, p = null) {
    pedCtx = { lic, p };
    formPed.reset();
    $('#dlg-pedido-titulo').textContent = p ? `Editar empenho ${p.numero}` : 'Novo pedido / empenho';
    $('#btn-excluir-pedido').hidden = !p;
    if (p) {
      for (const el of formPed.elements) {
        if (!el.name || !(el.name in p)) continue;
        el.value = el.name === 'valor' ? moedaInput(p.valor) : (p[el.name] ?? '');
      }
    } else {
      formPed.dataRecebimento.value = toISO(hoje());
      formPed.prazoDias.value = lic.prazoEntregaDias || '';
    }
    dlgPed.showModal();
  }

  formPed.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(formPed));
    data.valor = parseMoeda(data.valor);
    const { lic, p } = pedCtx;
    if (p) Object.assign(p, data);
    else (lic.pedidos ||= []).push({ id: uid(), ...data });
    dlgPed.close();
    salvar();
    if (!p && saldo(lic) < 0) toast('Atenção: os empenhos já ultrapassam o valor ganho.');
    else toast('Empenho salvo.');
  });

  $('#btn-excluir-pedido').addEventListener('click', () => {
    const { lic, p } = pedCtx;
    if (!p || !confirm(`Excluir o empenho ${p.numero}?`)) return;
    lic.pedidos = lic.pedidos.filter((x) => x !== p);
    dlgPed.close();
    salvar();
  });

  // ---------- Navegação e eventos gerais ----------
  $$('.tab').forEach((t) => t.addEventListener('click', () => mostrarView(t.dataset.view)));
  function mostrarView(v) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
    $$('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
    try { localStorage.setItem(STORAGE_KEY + ':view', v); } catch (e) { /* ok */ }
  }
  try { const v = localStorage.getItem(STORAGE_KEY + ':view'); if (v && $('#view-' + v)) mostrarView(v); } catch (e) { /* ok */ }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { e.target.closest('dialog')?.close(); return; }
    const ir = e.target.closest('[data-ir]');
    if (ir) { mostrarView(ir.dataset.ir); return; }
    const row = e.target.closest('[data-lic]');
    if (row && !e.target.closest('dialog')) abrirDetalhe(row.dataset.lic);
  });

  ['#f-busca', '#f-resultado', '#f-situacao'].forEach((s) => $(s).addEventListener('input', renderLicitacoes));
  ['#f-prazo-tipo', '#f-prazo-concluidos'].forEach((s) => $(s).addEventListener('input', renderPrazos));
  $('#btn-nova').addEventListener('click', () => abrirFormLicitacao());

  // ---------- Backup ----------
  const fecharMenu = () => $('.menu').removeAttribute('open');

  $('#btn-exportar').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `licitacoes-backup-${toISO(hoje())}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    fecharMenu();
  });

  $('#inp-importar').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    fecharMenu();
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.licitacoes)) throw new Error('formato');
      if (db.licitacoes.length && !confirm('Substituir os dados atuais pelos do arquivo?')) return;
      db = normalizar(data);
      salvar();
      toast(`${db.licitacoes.length} licitações importadas.`);
    } catch (err) {
      toast('Arquivo inválido.');
    }
  });

  $('#btn-limpar').addEventListener('click', () => {
    fecharMenu();
    if (!confirm('Apagar TODAS as licitações deste navegador? Exporte um backup antes se quiser guardar.')) return;
    db = normalizar({ licitacoes: [], config: db.config });
    salvar();
  });

  $('#btn-exemplo').addEventListener('click', () => {
    fecharMenu();
    if (db.licitacoes.length && !confirm('Adicionar dados de exemplo aos seus dados atuais?')) return;
    const d = (n) => toISO(new Date(hoje().getTime() + n * 86400000));
    db.licitacoes.push(
      {
        id: uid(), orgao: 'Prefeitura Municipal de Exemplo', numero: 'PE 045/2026', modalidade: 'Pregão eletrônico',
        objeto: 'Material de expediente', dataSessao: d(-120), resultado: 'ganha', valor: 84500, link: '',
        instrumento: 'ata', numeroInstrumento: 'ARP 112/2026', vigenciaInicio: d(-100), vigenciaFim: d(265),
        prazoEntregaDias: '15', prazoPagamentoDias: '30', contato: 'Fiscal: Ana — (11) 0000-0000', obs: '',
        pedidos: [
          { id: uid(), numero: '2026NE000321', valor: 12300, dataRecebimento: d(-60), prazoDias: '15', descricao: 'Papel A4 e canetas', dataEntrega: d(-50), nf: '1520', dataPagamento: d(-22), obs: '' },
          { id: uid(), numero: '2026NE000488', valor: 9800, dataRecebimento: d(-30), prazoDias: '15', descricao: 'Toners', dataEntrega: d(-18), nf: '1588', dataPagamento: '', obs: '' },
          { id: uid(), numero: '2026NE000612', valor: 15400, dataRecebimento: d(-10), prazoDias: '15', descricao: 'Pastas e arquivos', dataEntrega: '', nf: '', dataPagamento: '', obs: '' },
        ],
      },
      {
        id: uid(), orgao: 'Secretaria Estadual de Saúde', numero: 'PE 210/2026', modalidade: 'Pregão eletrônico',
        objeto: 'Luvas de procedimento', dataSessao: d(-200), resultado: 'ganha', valor: 230000, link: '',
        instrumento: 'contrato', numeroInstrumento: 'CT 77/2026', vigenciaInicio: d(-180), vigenciaFim: d(40),
        prazoEntregaDias: '10', prazoPagamentoDias: '30', contato: '', obs: 'Verificar interesse em aditivo de prazo.',
        pedidos: [
          { id: uid(), numero: 'OF 09/2026', valor: 46000, dataRecebimento: d(-14), prazoDias: '10', descricao: '2.000 caixas', dataEntrega: '', nf: '', dataPagamento: '', obs: '' },
        ],
      },
      {
        id: uid(), orgao: 'Universidade Federal Exemplo', numero: 'PE 18/2026', modalidade: 'Pregão eletrônico',
        objeto: 'Mobiliário de escritório', dataSessao: d(-25), resultado: 'aguardando', valor: 0, pedidos: [],
      },
      {
        id: uid(), orgao: 'Câmara Municipal', numero: 'DL 03/2026', modalidade: 'Dispensa',
        objeto: 'Café e açúcar', dataSessao: d(-70), resultado: 'perdida', valor: 0, pedidos: [],
      },
    );
    salvar();
    toast('Dados de exemplo carregados.');
  });

  const fmtCnpj = (c) => String(c).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

  // API usada pelo módulo do PNCP (pncp.js)
  window.App = {
    db: () => db, salvar, uid, esc, toast, abrirDetalhe,
    fmtMoeda, fmtData, fmtCnpj, parseData, toISO, hoje,
    onRender: (fn) => renderHooks.push(fn),
  };

  render();
})();
