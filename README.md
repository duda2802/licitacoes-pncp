# Licitações OSY — acompanhamento pós-licitação

Site para acompanhar o que acontece **depois** da licitação: quais você ganhou, saldo de contratos/atas,
empenhos recebidos, prazos de entrega, pagamentos a receber e fim de vigência.

## Como usar

Abra o `index.html` no navegador (não precisa instalar nada). Para testar, use **Backup → Carregar dados de exemplo**.

- **Painel** — números gerais e o que precisa de atenção agora (entregas atrasadas ou vencendo em até 7 dias,
  pagamentos atrasados, contratos/atas terminando em até 60 dias, licitações sem resultado há mais de 15 dias).
- **Licitações** — lista com busca e filtros; clique em uma para ver detalhes e cadastrar empenhos/OFs.
- **Prazos** — todos os vencimentos em ordem de data.

Fluxo típico: cadastre a licitação → quando ganhar, marque “Ganha” e preencha contrato/ata, vigência e prazos →
a cada nota de empenho, cadastre o empenho (o prazo de entrega é calculado) → marque “entregue” e depois “pago”.

## Onde ficam os dados

No próprio navegador (localStorage). Use **Backup → Exportar** com frequência e **Importar** para levar os dados
para outro computador.

## Publicar

É um site estático: dá para publicar de graça no GitHub Pages (Settings → Pages → branch `main`, pasta raiz).
