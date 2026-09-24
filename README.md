# licitacoes-pncp

Script `pncp_implementos.py`: consulta a API pública do PNCP
(`/api/consulta/v1/contratacoes/proposta`) e lista **pregões eletrônicos**
(`codigoModalidadeContratacao=6`) com **propostas abertas** cujo objeto contenha
algum termo do arquivo `termos.txt` (implementos rodoviários da Brazil Implementos).

Para cada contratação mostra: **categoria**, órgão, município/UF, valor estimado,
data de encerramento da proposta, termos encontrados e link do edital no PNCP
(mais o link do sistema de origem).

## Termos (`termos.txt`)

Um termo por linha, agrupados por categoria. Edite à vontade, sem mexer no código:

```
=== CATEGORIA: TANQUE DE ÁGUA / PIPA ===
tanque pipa
caminhão pipa
# linhas com # são comentários
```

A busca ignora acentos, maiúsculas, plural (inclusive "caminhões", "combustíveis"),
hífen e apóstrofo, e aceita uma preposição entre as palavras
("tanque de água" também acha "tanque para água" e "tanque d'água").
Se um pregão casar com termos de mais de uma categoria, todas aparecem na coluna
`categoria`, separadas por ` | `.

Evite termos soltos e genéricos ("tanque", "plataforma", "caçamba"): trazem
muita coisa sem relação com os produtos.

## Uso

Requer Python 3.8+ e nenhuma dependência externa.

```bash
python pncp_implementos.py                      # propostas que encerram nos próximos 60 dias, Brasil todo
python pncp_implementos.py --uf GO --dias 30    # só GO, próximos 30 dias
python pncp_implementos.py --csv resultado.csv  # também salva CSV (abre no Excel)
python pncp_implementos.py --termo "grade aradora"   # termo extra, só nesta execução
python pncp_implementos.py --termos outro.txt   # usa outro arquivo de termos
```

Sem `--uf` o script percorre todas as páginas do Brasil inteiro (50 por página),
o que pode levar alguns minutos, porque a API do PNCP é lenta.
