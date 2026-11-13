// Função "usuarios" (Supabase Edge Function): gerenciamento de usuários pela administradora.
// Roda no servidor do Supabase, onde fica a chave secreta — por isso o site não precisa dela.
// Só aceita chamadas de quem está logado E tem perfil "admin".
//
// Ações (POST JSON):
//   { acao: 'criar',   nome, email, senha, papel }
//   { acao: 'papel',   user_id, papel }
//   { acao: 'senha',   user_id, senha }      -- redefine a senha de alguém
//   { acao: 'remover', user_id }
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const PAPEIS = ['admin', 'editor', 'leitor'];

function resposta(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

function traduzir(msg = '') {
  if (/already been registered|already exists/i.test(msg)) return 'Já existe um usuário com esse e-mail.';
  if (/password/i.test(msg) && /least|short|weak/i.test(msg)) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (/invalid.*email|email.*invalid/i.test(msg)) return 'E-mail inválido.';
  return msg || 'Erro inesperado.';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return resposta({ erro: 'Método não permitido.' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const chave = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')!;
    const admin = createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false } });

    // Quem está chamando?
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: quem, error: erroQuem } = await admin.auth.getUser(token);
    if (erroQuem || !quem?.user) return resposta({ erro: 'Sessão inválida. Entre novamente.' }, 401);
    const eu = quem.user;

    const { data: meuPerfil } = await admin.from('perfis').select('papel').eq('user_id', eu.id).maybeSingle();
    if (meuPerfil?.papel !== 'admin') return resposta({ erro: 'Só administradores podem gerenciar usuários.' }, 403);

    const corpo = await req.json().catch(() => ({}));
    const { acao } = corpo;

    const contarAdmins = async () => {
      const { count } = await admin.from('perfis').select('user_id', { count: 'exact', head: true }).eq('papel', 'admin');
      return count ?? 0;
    };

    if (acao === 'criar') {
      const nome = String(corpo.nome ?? '').trim();
      const email = String(corpo.email ?? '').trim().toLowerCase();
      const senha = String(corpo.senha ?? '');
      const papel = String(corpo.papel ?? 'leitor');
      if (!nome || !email) return resposta({ erro: 'Informe nome e e-mail.' }, 400);
      if (senha.length < 8) return resposta({ erro: 'A senha inicial precisa ter pelo menos 8 caracteres.' }, 400);
      if (!PAPEIS.includes(papel)) return resposta({ erro: 'Perfil inválido.' }, 400);
      const { data, error } = await admin.auth.admin.createUser({
        email, password: senha, email_confirm: true,
        user_metadata: { nome }, app_metadata: { papel },
      });
      if (error || !data.user) return resposta({ erro: traduzir(error?.message) }, 400);
      await admin.from('perfis').upsert({ user_id: data.user.id, email, nome, papel });
      return resposta({ ok: true, user_id: data.user.id });
    }

    const alvo = String(corpo.user_id ?? '');
    if (!alvo) return resposta({ erro: 'Usuário não informado.' }, 400);

    if (acao === 'papel') {
      const papel = String(corpo.papel ?? '');
      if (!PAPEIS.includes(papel)) return resposta({ erro: 'Perfil inválido.' }, 400);
      if (alvo === eu.id && papel !== 'admin' && (await contarAdmins()) <= 1) {
        return resposta({ erro: 'Você é a única administradora. Defina outra pessoa como administradora antes.' }, 400);
      }
      const { error } = await admin.from('perfis').update({ papel }).eq('user_id', alvo);
      if (error) return resposta({ erro: error.message }, 400);
      await admin.auth.admin.updateUserById(alvo, { app_metadata: { papel } });
      return resposta({ ok: true });
    }

    if (acao === 'senha') {
      const senha = String(corpo.senha ?? '');
      if (senha.length < 8) return resposta({ erro: 'A senha precisa ter pelo menos 8 caracteres.' }, 400);
      const { error } = await admin.auth.admin.updateUserById(alvo, { password: senha });
      if (error) return resposta({ erro: traduzir(error.message) }, 400);
      return resposta({ ok: true });
    }

    if (acao === 'remover') {
      if (alvo === eu.id) return resposta({ erro: 'Você não pode remover a si mesma.' }, 400);
      const { error } = await admin.auth.admin.deleteUser(alvo);
      if (error) return resposta({ erro: error.message }, 400);
      await admin.from('perfis').delete().eq('user_id', alvo);
      return resposta({ ok: true });
    }

    return resposta({ erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return resposta({ erro: String((e as Error)?.message ?? e) }, 500);
  }
});
