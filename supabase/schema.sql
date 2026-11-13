-- Banco de dados do site de licitações.
-- Rode este arquivo uma vez no Supabase: SQL Editor → New query → cole tudo → Run.

-- Uma linha por usuário com todos os dados dele (licitações, empenhos, configurações).
create table if not exists public.licitacoes_dados (
  user_id uuid primary key references auth.users (id) on delete cascade,
  dados jsonb not null default '{"licitacoes": []}'::jsonb,
  atualizado_em timestamptz not null default now()
);

-- Segurança: cada usuário só enxerga e altera a própria linha.
alter table public.licitacoes_dados enable row level security;

drop policy if exists "ler os proprios dados" on public.licitacoes_dados;
create policy "ler os proprios dados" on public.licitacoes_dados
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "criar os proprios dados" on public.licitacoes_dados;
create policy "criar os proprios dados" on public.licitacoes_dados
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "alterar os proprios dados" on public.licitacoes_dados;
create policy "alterar os proprios dados" on public.licitacoes_dados
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.licitacoes_dados from anon;
grant select, insert, update on public.licitacoes_dados to authenticated;
