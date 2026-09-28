# licitacoes-pncp

Script `pncp_implementos.py`: consulta a API pública do PNCP
(`/api/consulta/v1/contratacoes/proposta`) e lista **pregões, concorrências e
dispensas** com **propostas abertas** cujo objeto contenha algum termo do arquivo `termos.txt` (implementos
rodoviários da Brazil Implementos). Implementos agrícolas (roçadeira, carreta
agrícola, grade, plantadeira, rolo faca, distribuidor de adubo...) ficam de fora:
não são fabricados. Além de não estarem nos termos, um item que fala em agrícola/
tratorizado, ou uma "carreta ..." num objeto agrícola, não conta mesmo que use um
termo ("carreta agrícola ... caçamba basculante", "tanque pipa agrícola com
reboque"). Ver `RE_AGRICOLA` no script.

Objetos genéricos ("aquisição de máquinas e equipamentos", "patrulha mecanizada",
"equipamentos agrícolas") também são conferidos: o script abre os itens e o
pregão entra se algum item usar um termo ("Tanque pipa 8.000 L"). Os padrões
que disparam essa conferência estão em `RE_GATILHO` no script.

Para cada contratação mostra: **categoria**, modalidade, órgão, município/UF, valor estimado,
data de encerramento da proposta, termos encontrados e link do edital no PNCP
(mais o link do sistema de origem).

## Só o implemento, sem o caminhão

Pregões que compram o caminhão junto com o implemento ("caminhão pipa",
"caminhão basculante com caçamba", "tanque sobre chassi cabinado 0 km") são
descartados. Como muitos pregões têm vários lotes, o script confere **item por
item** (API `/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens`): se houver
ao menos um item que seja só o implemento, o pregão entra e esses itens aparecem
no resultado, com o valor deles.

O mesmo vale para caminhonete/picape e trator ("trator **com** tanque pipa" em um
único item é compra do trator).

"Caminhão" como destino do implemento não descarta: "caçamba **para** caminhão",
"instalado **no** caminhão", "acoplável **a** trator", "chassi **de** caminhão",
"sobrechassi de caminhão", "compatível **com** caminhão", "transporte **de** veículos",
e "caminhão fornecido pela Administração / pertencente ao Município".

Se nenhum item usa os termos (objeto "caminhão pipa e kit de combate a incêndio",
itens "Caminhão hidrojato", "Kit de combate para caminhonete"), entram os itens que
não são veículo.

## Serviço, locação, manutenção e peças não contam

O termo só vale quando o objeto é a compra do implemento. Se, nas 20 palavras
antes do termo, a palavra mais próxima de serviço/locação/manutenção/peças vier
antes de uma palavra de compra, o termo é ignorado: "locação de caminhão pipa",
"prestação de serviços de caminhão munck", "peças para manutenção dos implementos
agrícolas", "fornecimento de água potável em caminhão pipa" (serviço) ficam de fora;
"aquisição de peças ... bem como a aquisição de roçadeiras novas" entra.
A lista de palavras está em `NAO_E_COMPRA` no script.

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

Evite termos soltos e genéricos ("tanque", "plataforma", "caçamba", "basculante",
"prancha", "roçadeira", "coletor de lixo"): trazem portão basculante, prancha de
madeira, roçadeira costal, lixeira etc. "tipo" entre as palavras também é aceito
("reboque prancha" acha "reboque tipo prancha").

## Uso

Requer Python 3.8+ e nenhuma dependência externa.

```bash
python pncp_implementos.py                      # propostas que encerram nos próximos 60 dias, Brasil todo
python pncp_implementos.py --uf GO --dias 30    # só GO, próximos 30 dias
python pncp_implementos.py --csv resultado.csv  # também salva CSV (abre no Excel)
python pncp_implementos.py --termo "carroceria graneleira"   # termo extra, só nesta execução
python pncp_implementos.py --termos outro.txt   # usa outro arquivo de termos
python pncp_implementos.py --incluir-caminhao   # não descarta caminhão + implemento
python pncp_implementos.py --modalidades 6      # só pregão eletrônico (padrão: 6,7,4,5,8)
```

Modalidades (código PNCP): 6 pregão eletrônico, 7 pregão presencial,
4 concorrência eletrônica, 5 concorrência presencial, 8 dispensa.

Cada pregão encontrado gera uma consulta extra (itens), então a execução fica
um pouco mais lenta. Sem `--uf` o script percorre todas as páginas do Brasil inteiro (50 por página),
o que pode levar alguns minutos, porque a API do PNCP é lenta.
