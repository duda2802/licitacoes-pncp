-- Banco de dados do site de Contratos e Empenhos (base única da empresa, com perfis de acesso).
-- Rode este arquivo uma vez no Supabase: SQL Editor → New query → cole tudo → Run.
-- Pode rodar de novo sem problema (não apaga dados).

-- ============ Perfis de acesso ============
-- admin  = Administrador (tudo, inclusive gerenciar usuários)
-- editor = Permissão total (tudo, menos gerenciar usuários)
-- leitor = Só visualização
create table if not exists public.perfis (
  user_id uuid primary key references auth.users (id) on delete cascade,
  nome text not null default '',
  email text not null default '',
  papel text not null default 'leitor' check (papel in ('admin', 'editor', 'leitor')),
  criado_em timestamptz not null default now()
);
alter table public.perfis enable row level security;

-- Papel de quem está logado (usado nas regras abaixo)
create or replace function public.meu_papel() returns text
language sql stable security definer set search_path = public
as $$ select papel from public.perfis where user_id = auth.uid() $$;
revoke all on function public.meu_papel() from public, anon;
grant execute on function public.meu_papel() to authenticated;

drop policy if exists "perfis: membros leem" on public.perfis;
create policy "perfis: membros leem" on public.perfis
  for select to authenticated
  using (public.meu_papel() is not null);
-- Criar/alterar/remover perfis só pela função "usuarios" (que usa a chave secreta no servidor).
revoke all on public.perfis from anon;
grant select on public.perfis to authenticated;

-- Todo usuário novo ganha um perfil. O PRIMEIRO usuário do sistema vira Administrador.
create or replace function public.novo_usuario() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.perfis (user_id, email, nome, papel)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(nullif(new.raw_user_meta_data ->> 'nome', ''), split_part(coalesce(new.email, ''), '@', 1)),
    case when not exists (select 1 from public.perfis) then 'admin'
         else coalesce(nullif(new.raw_app_meta_data ->> 'papel', ''), 'leitor') end
  )
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists ao_criar_usuario on auth.users;
create trigger ao_criar_usuario after insert on auth.users
  for each row execute function public.novo_usuario();

-- Se você já tinha criado seu usuário antes de rodar este arquivo, ele vira o Administrador.
insert into public.perfis (user_id, email, nome, papel)
select id, coalesce(email, ''), split_part(coalesce(email, ''), '@', 1), 'admin'
from auth.users
where not exists (select 1 from public.perfis)
order by created_at
limit 1;

-- ============ Dados (contratos/atas com seus empenhos, e configurações) ============
create table if not exists public.registros (
  id text primary key,
  tipo text not null,                 -- 'licitacao' ou 'config'
  dados jsonb not null,
  excluido boolean not null default false,
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid
);
create index if not exists registros_atualizado_em on public.registros (atualizado_em);
alter table public.registros enable row level security;

-- Data/hora e autor sempre definidos pelo servidor
create or replace function public.registros_carimbo() returns trigger
language plpgsql as $$
begin
  new.atualizado_em := now();
  new.atualizado_por := auth.uid();
  return new;
end $$;
drop trigger if exists registros_carimbo on public.registros;
create trigger registros_carimbo before insert or update on public.registros
  for each row execute function public.registros_carimbo();

drop policy if exists "registros: membros leem" on public.registros;
create policy "registros: membros leem" on public.registros
  for select to authenticated
  using (public.meu_papel() is not null);

drop policy if exists "registros: editores criam" on public.registros;
create policy "registros: editores criam" on public.registros
  for insert to authenticated
  with check (public.meu_papel() in ('admin', 'editor'));

drop policy if exists "registros: editores alteram" on public.registros;
create policy "registros: editores alteram" on public.registros
  for update to authenticated
  using (public.meu_papel() in ('admin', 'editor'))
  with check (public.meu_papel() in ('admin', 'editor'));

revoke all on public.registros from anon;
grant select, insert, update on public.registros to authenticated;

-- ============ Documentos anexados (bucket privado) ============
insert into storage.buckets (id, name, public, file_size_limit)
values ('documentos', 'documentos', false, 26214400)
on conflict (id) do nothing;

drop policy if exists "documentos: membros leem" on storage.objects;
create policy "documentos: membros leem" on storage.objects
  for select to authenticated
  using (bucket_id = 'documentos' and public.meu_papel() is not null);

drop policy if exists "documentos: editores enviam" on storage.objects;
create policy "documentos: editores enviam" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documentos' and public.meu_papel() in ('admin', 'editor'));

drop policy if exists "documentos: editores apagam" on storage.objects;
create policy "documentos: editores apagam" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documentos' and public.meu_papel() in ('admin', 'editor'));
