# Automação Pasta Azul Pro — Pré-pedidos MÓVEL (Info2B)

Extensão Chrome (Manifest V3) que localiza e transforma automaticamente os
pré-pedidos do setor **MÓVEL** em `https://app.info2b.com.br/`.

## Regras absolutas

Em ordem de prioridade:

1. **Nunca** transformar um pedido com status **CANCELADO**.
2. **Nunca** processar um pedido cujo TIPO não seja exatamente **Móvel**.
3. **Nunca** abrir ou processar um pedido diferente do que foi selecionado.
4. **Nunca** processar o mesmo código duas vezes.
5. A progressão da fila é controlada pelo **número do Info**, comparado como número.

## Instalação

1. `chrome://extensions` → ative o **Modo do desenvolvedor**.
2. **Carregar sem compactação** → selecione esta pasta.
3. Abra a página de **PRÉ-PEDIDOS**, clique no ícone da extensão e em **Iniciar Automação**.

## Configurações (popup)

| Campo | Padrão | Para que serve |
|---|---|---|
| Intervalo de atualização (ms) | `1000` | Intervalo **mínimo** entre duas atualizações da fila. Menor = mais rápido; maior = menos carga no Info2B. |
| Tempo limite de validação (ms) | `8000` | Espera máxima pelo status e pelos botões antes de abortar o pedido (nunca transforma no timeout). |
| Exigir status definido | desligado | Ligado, bloqueia pedidos cujo status atual esteja "Não informado". |

O bloco **Progresso da fila** mostra o estado atual, o último código processado
ou bloqueado e os totais. **Zerar progresso da fila** faz a extensão voltar a
considerar códigos antigos (use quando o marcador ficar alto demais).

## Fluxo (máquina de estados)

```
PROCURANDO_PEDIDO → VALIDANDO_LINHA → ABRINDO_ACOMPANHAMENTO → VALIDANDO_PEDIDO
   → VALIDANDO_STATUS → TRANSFORMANDO → CONFIRMANDO → CONCLUIDO → RETORNANDO_FILA
   → ATUALIZANDO_FILA → PROCURANDO_PEDIDO
```

Desvios: `BLOQUEADO` (CANCELADO ou status ilegível), `AGUARDANDO_NOVO_CODIGO`
(nenhum código maior que o último) e `AGUARDANDO_PAGINA` (fora do fluxo).

### Validação dupla

* **Na fila:** tipo exatamente `Móvel`, código extraído da linha, ícone clicado
  pertencente **àquela linha** (`href` com o código → ícone de pasta → 2º ícone).
* **No acompanhamento:** código da URL + código e tipo do título + leitura do
  campo "Status Personalizado Atual" daquele pedido. A autorização é revalidada
  imediatamente antes de clicar em **Transformar em Pedido** e de novo antes do
  **Sim**.

### Progressão

`ultimoCodigo` = maior código já transformado **ou** bloqueado. O próximo alvo é
sempre o **menor código Móvel estritamente maior** que ele. Se não existir, a
extensão apenas atualiza a fila (respeitando o intervalo) e espera surgir um
código maior — nunca volta para um código antigo.

## Testes

Os 7 cenários obrigatórios rodam contra um simulador do DOM do Info2B (jsdom):

```bash
npm install
npm test
```

Cobertura: CANCELADO na fila e no acompanhamento, tipos diferentes de Móvel,
ordem e ausência de duplicidade, fila sem código maior, CANCELADO em outra
linha, status lento, botão disponível antes da validação, os quatro formatos de
ícone da linha, navegação após confirmar, "Exigir status definido" e parada
imediata da automação.
