/* Configuração do login (Supabase).
 * Preencha com os dados do seu projeto em: Supabase → Project Settings → API Keys.
 * Estes valores são públicos por natureza (ficam visíveis no navegador); quem protege os dados
 * são as regras de segurança (RLS) criadas pelo arquivo supabase/schema.sql.
 * Deixe em branco para usar o site sem login (dados só no navegador). */
window.SUPABASE_URL = '';
window.SUPABASE_ANON_KEY = '';

// Esconde o site até o login (evita mostrar a tela por um instante antes de pedir a senha).
if (window.SUPABASE_URL && window.SUPABASE_ANON_KEY) document.documentElement.classList.add('com-login');
