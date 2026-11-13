/* Login e armazenamento online (Supabase).
 *
 * - Só entra quem foi convidado (cadastro público desligado no Supabase).
 * - Cada usuário tem os próprios dados, numa linha da tabela `licitacoes_dados`,
 *   protegida por RLS: ninguém lê nem altera os dados de outra pessoa.
 * - Mantém uma cópia local por usuário, para abrir rápido e não perder nada se cair a internet.
 *
 * Sem SUPABASE_URL/SUPABASE_ANON_KEY em config.js o site funciona sem login (dados só no navegador). */
(() => {
  'use strict';

  const URL_SB = window.SUPABASE_URL;
  const KEY_SB = window.SUPABASE_ANON_KEY;
  const html = document.documentElement;
  if (!URL_SB || !KEY_SB || !window.supabase) { html.classList.add('modo-local'); return; }

  const App = window.App;
  const TABELA = 'licitacoes_dados';
  const $ = (s) => document.querySelector(s);
  const REDIRECT = location.origin + location.pathname;

  // Link de convite / redefinição de senha chega com #...type=invite|recovery
  let precisaDefinirSenha = /type=(invite|recovery)/.test(location.hash);

  const sb = window.supabase.createClient(URL_SB, KEY_SB, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });

  let usuario = null;
  let ultimoRemoto = null; // atualizado_em da última versão lida/gravada
  let pendente = false;
  let timerSalvar = null;

  // ---------- Telas ----------
  function tela(nome) {
    for (const id of ['auth-carregando', 'form-login', 'form-esqueci', 'form-senha']) {
      $('#' + id).hidden = id !== nome;
    }
    msg('');
  }
  function msg(texto, tipo = 'erro') {
    const el = $('#auth-msg');
    el.textContent = texto;
    el.className = 'auth-msg ' + tipo;
    el.hidden = !texto;
  }
  function travar(form, sim) {
    form.querySelectorAll('button, input').forEach((el) => { el.disabled = sim; });
  }
  function traduzErro(e) {
    const m = (e && (e.message || e.error_description)) || String(e);
    if (/invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
    if (/email not confirmed/i.test(m)) return 'Seu e-mail ainda não foi confirmado. Use o link do convite.';
    if (/password should be at least/i.test(m)) return 'A senha precisa ter pelo menos 8 caracteres.';
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

  async function lerRemoto() {
    const { data, error } = await sb.from(TABELA).select('dados, atualizado_em').eq('user_id', usuario.id).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function gravarRemoto() {
    if (!usuario) return;
    clearTimeout(timerSalvar);
    statusSync('Salvando…');
    const agora = new Date().toISOString();
    const { error } = await sb.from(TABELA).upsert({ user_id: usuario.id, dados: App.db(), atualizado_em: agora });
    if (error) {
      statusSync('Não salvou online — tentando de novo', 'erro');
      timerSalvar = setTimeout(gravarRemoto, 15000);
      return;
    }
    ultimoRemoto = agora;
    pendente = false;
    statusSync('Salvo ✓', 'ok');
  }

  App.onSalvar(() => {
    if (!usuario) return;
    pendente = true;
    statusSync('Alterações não salvas…');
    clearTimeout(timerSalvar);
    timerSalvar = setTimeout(gravarRemoto, 800);
  });

  window.addEventListener('beforeunload', (e) => {
    if (pendente) { e.preventDefault(); e.returnValue = ''; }
  });

  // Ao voltar para a aba, traz alterações feitas em outro computador/celular.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !usuario || pendente) return;
    try {
      const r = await lerRemoto();
      if (r && ultimoRemoto && r.atualizado_em > ultimoRemoto) {
        ultimoRemoto = r.atualizado_em;
        App.usarDados(chaveLocal(), r.dados);
        statusSync('Atualizado ✓', 'ok');
      }
    } catch (e) { /* offline: segue com a cópia local */ }
  });

  const chaveLocal = () => `${App.STORAGE_KEY}:u:${usuario.id}`;
  // Usado pelo módulo de documentos (arquivos.js)
  window.Auth = { sb, usuario: () => usuario };

  async function entrar(user) {
    if (usuario?.id === user.id) { html.classList.add('autenticado'); return; }
    usuario = user;
    $('#usuario-email').textContent = user.email;
    const nome = (user.user_metadata?.nome || user.email.split('@')[0]).replace(/[._-]+/g, ' ');
    $('#menu-rotulo').textContent = nome.charAt(0).toUpperCase() + nome.slice(1);
    $('#avatar').textContent = nome.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
    tela('auth-carregando');
    $('#auth-carregando').textContent = 'Carregando seus dados…';
    try {
      const r = await lerRemoto();
      if (r) {
        ultimoRemoto = r.atualizado_em;
        App.usarDados(chaveLocal(), r.dados);
        statusSync('Salvo ✓', 'ok');
      } else {
        // Primeira vez: oferece levar os dados que já estavam neste navegador.
        let inicial = null;
        try {
          const antigo = JSON.parse(localStorage.getItem(App.STORAGE_KEY) || 'null');
          if (antigo?.licitacoes?.length &&
              confirm(`Encontramos ${antigo.licitacoes.length} licitação(ões) salvas neste navegador.\n\nLevar para a sua conta?`)) {
            inicial = antigo;
          }
        } catch (e) { /* ok */ }
        App.usarDados(chaveLocal(), inicial || { licitacoes: [] });
        await gravarRemoto();
      }
    } catch (e) {
      // Sem internet: abre com a cópia local deste usuário (se houver).
      App.usarDados(chaveLocal(), null);
      statusSync('Offline — salvo só neste navegador', 'erro');
    }
    html.classList.add('autenticado');
  }

  function sairDaTela() {
    usuario = null;
    html.classList.remove('autenticado');
    tela('form-login');
  }

  sb.auth.onAuthStateChange((evento, session) => {
    // Não chamar o Supabase direto dentro do callback (recomendação da biblioteca).
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

  // Link inválido/expirado chega como #error=...
  if (/error_description=/.test(location.hash)) {
    const p = new URLSearchParams(location.hash.slice(1));
    setTimeout(() => msg(traduzErro({ message: p.get('error_description') || '' })), 50);
    history.replaceState(null, '', REDIRECT);
    precisaDefinirSenha = false;
  }

  // ---------- Formulários ----------
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
    else msg('Se esse e-mail tiver acesso, você vai receber um link para criar uma nova senha.', 'ok');
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
    App.toast('Senha definida. Bem-vindo(a)!');
  });

  $('#btn-sair').addEventListener('click', async () => {
    document.querySelector('.menu')?.removeAttribute('open');
    if (pendente) await gravarRemoto();
    if (pendente && !confirm('Algumas alterações ainda não foram salvas online. Sair mesmo assim?')) return;
    const chave = usuario && chaveLocal();
    await sb.auth.signOut();
    if (chave) { try { localStorage.removeItem(chave); } catch (e) { /* ok */ } }
    location.replace(REDIRECT);
  });

  $('#btn-trocar-senha').addEventListener('click', () => {
    document.querySelector('.menu')?.removeAttribute('open');
    $('#senha-email').textContent = usuario?.email || '';
    html.classList.remove('autenticado');
    tela('form-senha');
  });
  $('#link-cancelar-senha').addEventListener('click', (e) => {
    e.preventDefault();
    if (usuario) { html.classList.add('autenticado'); }
    else { history.replaceState(null, '', REDIRECT); precisaDefinirSenha = false; sb.auth.signOut(); tela('form-login'); }
  });

  html.classList.add('com-login');
  tela('auth-carregando');
})();
