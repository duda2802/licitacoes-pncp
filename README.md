# Licitações OSY — acompanhamento pós-licitação

Site para acompanhar o que acontece **depois** da licitação: quais você ganhou, saldo de contratos/atas,
empenhos recebidos, prazos de entrega, pagamentos a receber e fim de vigência.

## Como usar

Abra o `index.html` no navegador (não precisa instalar nada). Para testar, use **Backup → Carregar dados de exemplo**.

- **Painel** — números gerais e o que precisa de atenção agora (entregas atrasadas ou vencendo em até 7 dias,
  pagamentos atrasados, contratos/atas terminando em até 60 dias, licitações sem resultado há mais de 15 dias).
- **Licitações** — lista com busca e filtros; clique em uma para ver detalhes e cadastrar empenhos/OFs.
- **Prazos** — todos os vencimentos em ordem de data.
- **PNCP** — importa automaticamente do Portal Nacional de Contratações Públicas (veja abaixo).

## Importar do PNCP

1. Na aba **PNCP**, informe o(s) CNPJ(s) da empresa (um por linha) e clique em **Buscar no PNCP**.
2. O site encontra os contratos, empenhos e AFs publicados em nome da empresa e agrupa por licitação.
3. Marque as licitações e clique em **Importar**. Para cada uma o site traz:
   - órgão, número, modalidade, objeto e data da sessão;
   - ata de registro de preços (número e vigência) ou contrato;
   - itens que você ganhou (quantidade, preço unitário e total) — que viram o “valor ganho”;
   - cada empenho/AF como pedido, com o órgão que pediu, valor, data e prazo de entrega
     (estimado pela vigência do empenho — confira).
4. Rode a busca de novo quando quiser: só o que for novo é importado. No detalhe de uma licitação,
   o botão **↻ PNCP** busca novos empenhos só dela.

**Empenhos antigos:** os recebidos antes da data escolhida entram como já entregues e pagos, para o
histórico não aparecer como atrasado.

**Ganhou e ainda não saiu empenho?** O PNCP só liga o fornecedor à licitação quando sai contrato ou
empenho. Nesse caso, cole o link do edital ou da ata em **Importar por link**.

O PNCP não informa entrega, nota fiscal nem pagamento — isso continua sendo marcado no site.
A API de busca do PNCP às vezes falha; o site tenta de novo sozinho, mas se der erro, tente mais tarde.

Fluxo típico: cadastre a licitação → quando ganhar, marque “Ganha” e preencha contrato/ata, vigência e prazos →
a cada nota de empenho, cadastre o empenho (o prazo de entrega é calculado) → marque “entregue” e depois “pago”.

## Onde ficam os dados

No próprio navegador (localStorage). Use **Backup → Exportar** com frequência e **Importar** para levar os dados
para outro computador.

## Publicar

É um site estático: dá para publicar de graça no GitHub Pages (Settings → Pages → branch `main`, pasta raiz).

## Login (Supabase)

O site pode exigir login. Cada pessoa tem os próprios dados, salvos online na conta dela, e só entra quem
for convidado. Sem configurar, o site funciona sem login (dados só no navegador).

1. Crie uma conta grátis em https://supabase.com e um projeto (região *South America (São Paulo)*).
2. **SQL Editor** → New query → cole o conteúdo de `supabase/schema.sql` → **Run**.
3. **Authentication → Sign In / Providers**: desligue **Allow new users to sign up** (só convidados entram).
4. **Authentication → URL Configuration**: em **Site URL** coloque `https://duda2802.github.io/licitacoes-pncp/`.
5. **Project Settings → API Keys**: copie a **Project URL** e a **Publishable key** (ou *anon key*) para `config.js`.
6. Para dar acesso a alguém: **Authentication → Users → Add user → Send invitation**. A pessoa recebe um
   e-mail, clica no link e cria a senha.

A URL e a chave pública podem ficar no código: quem protege os dados são as regras (RLS) do `schema.sql`.
