/* Login, perfis de acesso e base única da empresa (Supabase).
 *
 * - Só entra quem a administradora cadastrou (cadastro público desligado no Supabase).
 * - Perfis: admin (tudo + usuários), editor (permissão total), leitor (só visualização).
 * - Todos trabalham na mesma base: cada contrato/ata é uma linha da tabela `registros`;
 *   só o que mudou é enviado, e as alterações dos colegas chegam sozinhas.
 * - Cópia local para abrir rápido e não perder nada se cair a internet.
 *
 * Sem SUPABASE_URL/SUPABASE_ANON_KEY em config.js o site funciona sem login (dados só no navegador). */
(() => {
  'use strict';

  const URL_SB = window.SUPABASE_URL;
  const KEY_SB = window.SUPABASE_ANON_KEY;
  const html = document.documentElement;
  if (!URL_SB || !KEY_SB || !window.supabase) { html.classList.add('modo-local'); return; }

  const App = window.App;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = App.esc;
  const REDIRECT = location.origin + location.pathname;
  const PAPEL = { admin: 'Administrador', editor: 'Permissão total', leitor: 'Só visualização' };

  let precisaDefinirSenha = /type=(invite|recovery)/.test(location.hash);

  const sb = window.supabase.createClient(URL_SB, KEY_SB, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });

  let usuario = null;
  let perfil = null;
  let snap = new Map();       // id -> JSON do que está no servidor
  let ultimoVisto = '';       // maior atualizado_em já recebido
  let pendente = false;
  let gravando = false;
  let timerSalvar = null;

  const podeEditar = () => !!perfil && perfil.papel !== 'leitor';
  const ehAdmin = () => perfil?.papel === 'admin';
  window.Auth = { sb, usuario: () => usuario, perfil: () => perfil, podeEditar, ehAdmin };

  // ---------- Telas de login ----------
  function tela(nome) {
    for (const id of ['auth-carregando', 'form-login', 'form-esqueci', 'form-senha']) $('#' + id).hidden = id !== nome;
    msg('');
  }
  function msg(texto, tipo = 'erro') {
    const el = $('#auth-msg');
    el.textContent = texto;
    el.className = 'auth-msg ' + tipo;
    el.hidden = !texto;
  }
  function travar(form, sim) { form.querySelectorAll('button, input, select').forEach((el) => { el.disabled = sim; }); }
  function traduzErro(e) {
    const m = (e && (e.message || e.error_description || e.erro)) || String(e);
    if (/invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
    if (/email not confirmed/i.test(m)) return 'Seu e-mail ainda não foi confirmado.';
    if (/password should be at least|at least \d+ char/i.test(m)) return 'A senha precisa ter pelo menos 8 caracteres.';
    if (/same.*password|different from the old/i.test(m)) return 'A nova senha precisa ser diferente da anterior.';
    if (/rate limit|too many/i.test(m)) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
    if (/expired|invalid.*(token|link)|otp/i.test(m)) return 'Este link expirou ou já foi usado. Peça um novo.';
    if (/failed to fetch|network/i.test(m)) return 'Sem conexão com o servidor. Verifique sua internet.';
    return m;
  }

  // ---------- Sincronização ----------
  function statusSync(texto, tipo = '') {
    const el = $('#sync');
    el.textContent = texto;
    el.className = 'sync ' + tipo;
  }
  const chaveLocal = () => `${App.STORAGE_KEY}:empresa:${usuario.id}`;
  const maxData = (a, b) => (a > b ? a : b);

  function linhasDe(db) {
    const m = new Map([['config', { tipo: 'config', dados: db.config }]]);
    for (const l of db.licitacoes) m.set(l.id, { tipo: 'licitacao', dados: l });
    return m;
  }

  async function carregarTudo() {
    const linhas = [];
    for (let de = 0; ; de += 1000) {
      const { data, error } = await sb.from('registros').select('id, tipo, dados, atualizado_em')
        .eq('excluido', false).order('id').range(de, de + 999);
      if (error) throw error;
      linhas.push(...data);
      if (data.length < 1000) break;
    }
    const db = { licitacoes: [], config: {} };
    snap = new Map();
    ultimoVisto = '';
    for (const r of linhas) {
      if (r.tipo === 'config') db.config = r.dados;
      else if (r.tipo === 'licitacao') db.licitacoes.push(r.dados);
      snap.set(r.id, JSON.stringify(r.dados));
      ultimoVisto = maxData(ultimoVisto, r.atualizado_em);
    }
    return { db, vazio: linhas.length === 0 };
  }

  async function gravar() {
    clearTimeout(timerSalvar);
    if (!usuario || !podeEditar()) { pendente = false; return; }
    if (gravando) { timerSalvar = setTimeout(gravar, 500); return; }
    gravando = true;
    statusSync('Salvando…');
    try {
      const atual = linhasDe(App.db());
      const envio = [];
      const jsons = new Map();
      for (const [id, r] of atual) {
        const s = JSON.stringify(r.dados);
        if (snap.get(id) !== s) { envio.push({ id, tipo: r.tipo, dados: r.dados, excluido: false }); jsons.set(id, s); }
      }
      const removidos = [...snap.keys()].filter((id) => !atual.has(id));
      for (let i = 0; i < envio.length; i += 200) {
        const { data, error } = await sb.from('registros').upsert(envio.slice(i, i + 200)).select('id, atualizado_em');
        if (error) throw error;
        for (const r of data) { snap.set(r.id, jsons.get(r.id)); ultimoVisto = maxData(ultimoVisto, r.atualizado_em); }
      }
      for (let i = 0; i < removidos.length; i += 200) {
        const lote = removidos.slice(i, i + 200);
        const { data, error } = await sb.from('registros').update({ excluido: true }).in('id', lote).select('id, atualizado_em');
        if (error) throw error;
        for (const r of data) ultimoVisto = maxData(ultimoVisto, r.atualizado_em);
        lote.forEach((id) => snap.delete(id));
      }
      pendente = false;
      statusSync('Salvo ✓', 'ok');
    } catch (e) {
      const semPermissao = /row-level|permission/i.test(e.message || '');
      statusSync(semPermissao ? 'Sem permissão para salvar' : 'Não salvou online — tentando de novo', 'erro');
      if (!semPermissao) timerSalvar = setTimeout(gravar, 15000);
    } finally {
      gravando = false;
    }
  }

  App.onSalvar(() => {
    if (!usuario || !podeEditar()) return;
    pendente = true;
    statusSync('Alterações não salvas…');
    clearTimeout(timerSalvar);
    timerSalvar = setTimeout(gravar, 800);
  });

  /** Traz o que os colegas mudaram desde a última vez. */
  async function puxarNovidades() {
    if (!usuario || pendente || gravando || document.querySelector('dialog[open]')) return;
    try {
      const q = sb.from('registros').select('id, tipo, dados, excluido, atualizado_em').order('atualizado_em');
      const { data, error } = ultimoVisto ? await q.gt('atualizado_em', ultimoVisto) : await q;
      if (error || !data?.length || pendente) return;
      const db = App.db();
      for (const r of data) {
        ultimoVisto = maxData(ultimoVisto, r.atualizado_em);
        if (r.tipo === 'config') { if (!r.excluido) db.config = r.dados; snap.set(r.id, JSON.stringify(r.dados)); continue; }
        const i = db.licitacoes.findIndex((l) => l.id === r.id);
        if (r.excluido) { if (i >= 0) db.licitacoes.splice(i, 1); snap.delete(r.id); }
        else { if (i >= 0) db.licitacoes[i] = r.dados; else db.licitacoes.push(r.dados); snap.set(r.id, JSON.stringify(r.dados)); }
      }
      App.usarDados(chaveLocal(), db);
      statusSync('Atualizado ✓', 'ok');
    } catch (e) { /* offline: segue com a cópia local */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') puxarNovidades(); });
  setInterval(puxarNovidades, 60000);

  window.addEventListener('beforeunload', (e) => { if (pendente) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- Entrar / sair ----------
  const iniciaisDe = (nome) => nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

  function aplicarPerfil() {
    const nome = perfil?.nome || usuario.email.split('@')[0];
    const primeiro = nome.split(/\s+/)[0];
    $('#usuario-email').textContent = usuario.email;
    $('#menu-rotulo').textContent = primeiro;
    $('#avatar').textContent = iniciaisDe(nome);
    $('#btn-conta').innerHTML = `<span class="avatar">${esc(iniciaisDe(nome))}</span> ${esc(primeiro)} · ${ehAdmin() ? 'Usuários e senha' : 'Minha conta'}`;
    html.classList.toggle('somente-leitura', !podeEditar());
    html.classList.toggle('admin', ehAdmin());
    App.setSomenteLeitura(!podeEditar());
  }

  async function entrar(user) {
    if (usuario?.id === user.id) { html.classList.add('autenticado'); return; }
    usuario = user;
    tela('auth-carregando');
    $('#auth-carregando').textContent = 'Carregando…';
    try {
      const { data: p, error } = await sb.from('perfis').select('nome, email, papel').eq('user_id', user.id).maybeSingle();
      if (error) throw error;
      if (!p) {
        usuario = null;
        await sb.auth.signOut();
        tela('form-login');
        msg('Seu acesso não está liberado. Fale com a administradora.');
        return;
      }
      perfil = p;
      aplicarPerfil();
      const { db, vazio } = await carregarTudo();
      if (vazio && ehAdmin()) {
        // Primeira vez: oferece levar o que já estava salvo neste navegador.
        let inicial = null;
        try {
          const antigo = JSON.parse(localStorage.getItem(App.STORAGE_KEY) || 'null');
          if (antigo?.licitacoes?.length &&
              confirm(`Encontramos ${antigo.licitacoes.length} contrato(s)/licitação(ões) salvos neste navegador.\n\nLevar para a base da empresa?`)) inicial = antigo;
        } catch (e) { /* ok */ }
        App.usarDados(chaveLocal(), inicial || db);
        if (inicial) { pendente = true; await gravar(); }
      } else {
        App.usarDados(chaveLocal(), db);
      }
      statusSync('Salvo ✓', 'ok');
    } catch (e) {
      if (!perfil) { usuario = null; tela('form-login'); msg(traduzErro(e)); return; }
      App.usarDados(chaveLocal(), null);
      statusSync('Offline — mostrando a última cópia deste navegador', 'erro');
    }
    html.classList.add('autenticado');
  }

  function sairDaTela() {
    usuario = null;
    perfil = null;
    html.classList.remove('autenticado');
    tela('form-login');
  }

  sb.auth.onAuthStateChange((evento, session) => {
    setTimeout(() => {
      if (evento === 'PASSWORD_RECOVERY') precisaDefinirSenha = true;
      if (session?.user && precisaDefinirSenha) {
        $('#senha-email').textContent = session.user.email;
        tela('form-senha');
        return;
      }
      if (session?.user) entrar(session.user);
      else if (evento === 'SIGNED_OUT' || evento === 'INITIAL_SESSION') sairDaTela();
    }, 0);
  });

  if (/error_description=/.test(location.hash)) {
    const p = new URLSearchParams(location.hash.slice(1));
    setTimeout(() => msg(traduzErro({ message: p.get('error_description') || '' })), 50);
    history.replaceState(null, '', REDIRECT);
    precisaDefinirSenha = false;
  }

  // ---------- Formulários de login ----------
  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    travar(f, true);
    msg('');
    const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.senha.value });
    travar(f, false);
    if (error) msg(traduzErro(error));
    else f.senha.value = '';
  });
  $('#link-esqueci').addEventListener('click', (e) => {
    e.preventDefault();
    $('#form-esqueci').email.value = $('#form-login').email.value;
    tela('form-esqueci');
  });
  $('#link-voltar').addEventListener('click', (e) => { e.preventDefault(); tela('form-login'); });
  $('#form-esqueci').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    travar(f, true);
    const { error } = await sb.auth.resetPasswordForEmail(f.email.value.trim(), { redirectTo: REDIRECT });
    travar(f, false);
    if (error) msg(traduzErro(error));
    else msg('Se esse e-mail tiver acesso, você vai receber um link para criar uma nova senha. Se não chegar, peça à administradora para redefinir sua senha.', 'ok');
  });
  $('#form-senha').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.senha.value.length < 8) { msg('A senha precisa ter pelo menos 8 caracteres.'); return; }
    if (f.senha.value !== f.confirmar.value) { msg('As senhas não conferem.'); return; }
    travar(f, true);
    const { data, error } = await sb.auth.updateUser({ password: f.senha.value });
    travar(f, false);
    if (error) { msg(traduzErro(error)); return; }
    precisaDefinirSenha = false;
    history.replaceState(null, '', REDIRECT);
    f.reset();
    entrar(data.user);
    App.toast('Senha definida.');
  });
  $('#link-cancelar-senha').addEventListener('click', (e) => {
    e.preventDefault();
    history.replaceState(null, '', REDIRECT);
    precisaDefinirSenha = false;
    sb.auth.signOut();
    tela('form-login');
  });

  async function sair() {
    if (pendente) await gravar();
    if (pendente && !confirm('Algumas alterações ainda não foram salvas online. Sair mesmo assim?')) return;
    const chave = usuario && chaveLocal();
    await sb.auth.signOut();
    if (chave) { try { localStorage.removeItem(chave); } catch (e) { /* ok */ } }
    location.replace(REDIRECT);
  }
  $('#btn-sair').addEventListener('click', () => { document.querySelector('.menu')?.removeAttribute('open'); sair(); });

  // ---------- Minha conta e usuários ----------
  const dlgConta = $('#dlg-conta');
  let usuariosCache = [];

  async function chamarFuncao(corpo) {
    const { data, error } = await sb.functions.invoke('usuarios', { body: corpo });
    if (error) {
      let m = error.message;
      try { m = (await error.context.json()).erro || m; } catch (e) { /* ok */ }
      if (/Failed to send|not found|404/i.test(m)) m = 'A função “usuarios” ainda não foi criada no Supabase (veja o README).';
      throw new Error(m);
    }
    if (data?.erro) throw new Error(data.erro);
    return data;
  }

  async function carregarUsuarios() {
    const { data, error } = await sb.from('perfis').select('user_id, nome, email, papel, criado_em').order('criado_em');
    if (error) throw error;
    usuariosCache = data;
  }

  function renderConta() {
    const nome = perfil?.nome || usuario.email;
    $('#conta-head').innerHTML = `
      <div class="dh-top">
        <div class="conta-quem"><span class="avatar grande">${esc(iniciaisDe(nome))}</span>
          <div><h2>Minha conta</h2><div class="muted">${esc(nome)} · ${esc(usuario.email)} · ${esc(PAPEL[perfil.papel])}</div></div></div>
        <button type="button" class="x" data-close aria-label="Fechar">✕</button>
      </div>`;
    const lista = $('#conta-usuarios');
    if (!ehAdmin()) { lista.innerHTML = ''; return; }
    lista.innerHTML = usuariosCache.map((u) => {
      const eu = u.user_id === usuario.id;
      return `<li data-uid="${u.user_id}">
        <span class="avatar">${esc(iniciaisDe(u.nome || u.email))}</span>
        <div class="u-info"><strong>${esc(u.nome || '—')}</strong> <span class="muted">${esc(u.email)}</span></div>
        <select class="u-papel" aria-label="Perfil de ${esc(u.nome)}">${Object.entries(PAPEL).map(([k, v]) => `<option value="${k}" ${u.papel === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        ${eu ? '<span class="muted u-voce">você</span>' : `<button type="button" class="btn small" data-u-senha>Redefinir senha</button>
        <button type="button" class="btn small danger" data-u-remover>Remover</button>`}
      </li>`;
    }).join('') || '<li class="muted">Carregando…</li>';
  }

  async function abrirConta() {
    document.querySelector('.menu')?.removeAttribute('open');
    $('#form-minha-senha').reset();
    renderConta();
    if (!dlgConta.open) dlgConta.showModal();
    if (ehAdmin()) {
      try { await carregarUsuarios(); renderConta(); }
      catch (e) { App.toast('Não foi possível carregar os usuários: ' + traduzErro(e)); }
    }
  }
  $('#btn-conta').addEventListener('click', abrirConta);
  $('#btn-conta-menu').addEventListener('click', abrirConta);
  $('#btn-sair-conta').addEventListener('click', sair);

  $('#form-minha-senha').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.nova.value.length < 8) { App.toast('A nova senha precisa ter pelo menos 8 caracteres.'); return; }
    travar(f, true);
    try {
      const { error: e1 } = await sb.auth.signInWithPassword({ email: usuario.email, password: f.atual.value });
      if (e1) throw new Error('A senha atual está incorreta.');
      const { error: e2 } = await sb.auth.updateUser({ password: f.nova.value });
      if (e2) throw e2;
      f.reset();
      App.toast('Senha alterada.');
    } catch (err) {
      App.toast(traduzErro(err));
    } finally { travar(f, false); }
  });

  $('#form-novo-usuario').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const corpo = { acao: 'criar', nome: f.uNome.value.trim(), email: f.uEmail.value.trim(), senha: f.uSenha.value, papel: f.uPapel.value };
    if (!corpo.nome || !corpo.email) { App.toast('Informe nome e e-mail.'); return; }
    if (corpo.senha.length < 8) { App.toast('A senha inicial precisa ter pelo menos 8 caracteres.'); return; }
    travar(f, true);
    try {
      await chamarFuncao(corpo);
      f.reset();
      await carregarUsuarios();
      renderConta();
      App.toast(`Usuário criado. Passe o e-mail e a senha inicial para ${corpo.nome}.`);
    } catch (err) { App.toast(err.message); }
    finally { travar(f, false); }
  });

  dlgConta.addEventListener('change', async (e) => {
    const sel = e.target.closest('.u-papel');
    if (!sel) return;
    const li = sel.closest('[data-uid]');
    const u = usuariosCache.find((x) => x.user_id === li.dataset.uid);
    try {
      await chamarFuncao({ acao: 'papel', user_id: u.user_id, papel: sel.value });
      u.papel = sel.value;
      if (u.user_id === usuario.id) { perfil.papel = sel.value; aplicarPerfil(); renderConta(); }
      App.toast(`${u.nome}: ${PAPEL[sel.value]}.`);
    } catch (err) { sel.value = u.papel; App.toast(err.message); }
  });

  dlgConta.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) { dlgConta.close(); return; }
    const li = e.target.closest('[data-uid]');
    if (!li) return;
    const u = usuariosCache.find((x) => x.user_id === li.dataset.uid);
    if (e.target.closest('[data-u-senha]')) {
      const senha = prompt(`Nova senha para ${u.nome} (mínimo 8 caracteres):`);
      if (senha == null) return;
      if (senha.length < 8) { App.toast('A senha precisa ter pelo menos 8 caracteres.'); return; }
      try { await chamarFuncao({ acao: 'senha', user_id: u.user_id, senha }); App.toast(`Senha de ${u.nome} redefinida. Passe a nova senha para a pessoa.`); }
      catch (err) { App.toast(err.message); }
    }
    if (e.target.closest('[data-u-remover]')) {
      if (!confirm(`Remover o acesso de ${u.nome} (${u.email})?\nOs contratos e empenhos continuam na base.`)) return;
      try { await chamarFuncao({ acao: 'remover', user_id: u.user_id }); await carregarUsuarios(); renderConta(); App.toast('Usuário removido.'); }
      catch (err) { App.toast(err.message); }
    }
  });
  dlgConta.addEventListener('mousedown', (e) => { if (e.target === dlgConta) dlgConta.close(); });

  html.classList.add('com-login');
  tela('auth-carregando');
})();
