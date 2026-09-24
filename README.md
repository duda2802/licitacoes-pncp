# licitacoes-pncp

Script `pncp_implementos.py`: consulta a API pública do PNCP
(`/api/consulta/v1/contratacoes/proposta`) e lista **pregões eletrônicos**
(`codigoModalidadeContratacao=6`) com **propostas abertas** cujo objeto contenha:

tanque pipa · implemento agrícola · carreta agrícola · roçadeira · terraceador ·
tanque vácuo · instalação em chassi

A busca ignora acentos e maiúsculas e aceita plural, hífen e preposições
(ex.: "Tanques-Pipa", "tanque de vácuo", "instalação no chassi").

Para cada contratação mostra: órgão, município/UF, valor estimado, data de
encerramento da proposta e link do edital no PNCP (mais o link do sistema de origem).

## Uso

Requer Python 3.8+ e nenhuma dependência externa.

```bash
python pncp_implementos.py                      # propostas que encerram nos próximos 60 dias
python pncp_implementos.py --uf MG --dias 30    # só MG, próximos 30 dias
python pncp_implementos.py --termo "caminhão pipa" --termo "grade aradora"
python pncp_implementos.py --csv resultado.csv  # também salva CSV (abre no Excel)
```

Sem `--uf` o script percorre todas as páginas do Brasil inteiro (50 por página),
o que pode levar alguns minutos, porque a API do PNCP é lenta.
