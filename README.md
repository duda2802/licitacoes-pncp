# Licitações OSY — acompanhamento pós-licitação

Site para acompanhar o que acontece **depois** da licitação: quais você ganhou, saldo de contratos/atas,
empenhos recebidos, prazos de entrega, pagamentos a receber e fim de vigência.

## Como usar

Abra o `index.html` no navegador (ou o link do GitHub Pages). Para testar, use **Menu → Carregar dados de exemplo**.

- **Painel** — números gerais, ações pendentes e próximos prazos.
- **Contratos e atas** — cada contrato/ata com as etapas *Recebido → Assinado por nós → Assinado pelo órgão →
  Publicado → Vigente até*, analista responsável, saldo e status. Filtros por status (“Ação nossa pendente”,
  “Aguardando assinatura”, “Vigente”, “Suspenso”…), busca, ordenação e exportação para Excel.
- **Pedidos e empenhos** — cada empenho/OF do recebimento à cobrança: *Recebido → Entregue → NF emitida → Pago*,
  com prazo de entrega e de pagamento.
- **Prazos** — entregas, pagamentos e vigências em ordem de data.
- **PNCP** — importa automaticamente do Portal Nacional de Contratações Públicas (veja abaixo).
- **Empresas e analistas** — cadastre as empresas do grupo (nome + CNPJ) e os analistas. Com mais de uma empresa,
  aparecem os filtros “Todas as empresas / Empresa X”.
- **Documentos** — em cada contrato/ata e em cada empenho dá para anexar arquivos (ata, contrato, publicação,
  nota de empenho, NF, canhoto…), até 25 MB cada. Com login, ficam guardados na conta; sem login, no navegador.

## Onde ficam os dados

No próprio navegador (localStorage). Use **Backup → Exportar** com frequência e **Importar** para levar os dados
para outro computador.

## Publicar

É um site estático: dá para publicar de graça no GitHub Pages (Settings → Pages → branch `main`, pasta raiz).

## Login, usuários e perfis (Supabase)

Com o Supabase configurado, o site pede login e toda a equipe trabalha na **mesma base**. A administradora
cadastra as pessoas pelo próprio site (**Usuários e senha**) e escolhe o perfil de cada uma:

| Perfil | Pode |
|---|---|
| **Administrador** | tudo, inclusive criar/remover usuários, mudar perfis e redefinir senhas |
| **Permissão total** | cadastrar, editar, excluir, anexar documentos e importar do PNCP |
| **Só visualização** | consultar, baixar documentos e exportar para Excel |

Sem configurar, o site funciona sem login (dados só no navegador).

### Configuração (uma vez)

1. Crie uma conta grátis em https://supabase.com e um projeto (região *South America (São Paulo)*).
2. **SQL Editor** → New query → cole o conteúdo de `supabase/schema.sql` → **Run**.
3. **Edge Functions** → *Deploy a new function* → *Via Editor* → nome **`usuarios`** → apague o exemplo, cole o
   conteúdo de `supabase/functions/usuarios/index.ts` → **Deploy**.
4. **Authentication → Sign In / Providers**: desligue **Allow new users to sign up**.
5. **Authentication → URL Configuration**: em **Site URL** coloque `https://duda2802.github.io/licitacoes-pncp/`.
6. **Authentication → Users → Add user → Create new user**: crie a sua conta (e-mail + senha, marque
   *Auto Confirm User*). O primeiro usuário do sistema vira **Administrador** automaticamente.
7. **Project Settings → API Keys**: copie a **Project URL** e a **Publishable key** (ou *anon key*) para `config.js`.

Depois disso, os demais usuários são criados pelo site, em **Usuários e senha**.

A URL e a chave pública podem ficar no código: quem protege os dados são as regras (RLS) do `schema.sql` e a
verificação de administrador na função `usuarios`, que é a única que usa a chave secreta (no servidor do Supabase).
