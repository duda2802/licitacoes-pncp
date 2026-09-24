# licitacoes-pncp

Script `pncp_implementos.py`: consulta a API pública do PNCP
(`/api/consulta/v1/contratacoes/proposta`) e lista **pregões eletrônicos**
(`codigoModalidadeContratacao=6`) com **propostas abertas** cujo objeto contenha
algum termo do arquivo `termos.txt` (implementos rodoviários da Brazil Implementos).

Para cada contratação mostra: **categoria**, órgão, município/UF, valor estimado,
data de encerramento da proposta, termos encontrados e link do edital no PNCP
(mais o link do sistema de origem).

## Só o implemento, sem o caminhão

Pregões que compram o caminhão junto com o implemento ("caminhão pipa",
"caminhão basculante com caçamba", "tanque sobre chassi cabinado 0 km") são
descartados. Como muitos pregões têm vários lotes, o script confere **item por
item** (API `/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens`): se houver
ao menos um item que seja só o implemento, o pregão entra e esses itens aparecem
no resultado, com o valor deles.

"Caminhão" como destino do implemento não descarta: "caçamba **para** caminhão",
"instalado **no** caminhão", "acoplado **ao** caminhão", "chassi **de** caminhão".

Se a API de itens falhar, a decisão é feita só pelo objeto e o resultado vem com
um aviso para conferir no edital. Para ver também os pregões descartados, use
`--incluir-caminhao`.

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
python pncp_implementos.py --incluir-caminhao   # não descarta caminhão + implemento
```

Cada pregão encontrado gera uma consulta extra (itens), então a execução fica
um pouco mais lenta. Sem `--uf` o script percorre todas as páginas do Brasil inteiro (50 por página),
o que pode levar alguns minutos, porque a API do PNCP é lenta.
