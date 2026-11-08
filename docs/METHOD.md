# How the calculator works

All amounts are USD. A month is 30 days. 1 token ≈ 4 characters.

## Traffic

`conversations per month = daily users x conversations per user per day x 30`

Each conversation has `turns` user messages. Each message triggers `agent steps + 1` model calls:
the tool-calling steps, then the final answer.

## Tokens per call

Every call sends:

| Part | Tokens |
|---|---|
| System prompt + tools | `systemTokens` |
| History (message k) | full: `(k-1) x (user + answer)`; window: `min(k-1, N) x (user + answer)`; none: 0 |
| RAG | `chunks x tokensPerChunk` |
| User message | `userTokens` |
| Earlier tool steps in this message | `j x (toolResult + stepOutput)` for step j |

Output per call: `stepOutput` for tool-calling steps, `outputTokens` for the final answer.

## Prices applied

- **Input/output:** listed price (or your override) x 1.10 when a Geographic/in-Region endpoint has a premium.
- **Prompt caching** (if on and the system prompt is at least the model's minimum): the system prompt is
  written once per conversation (5-minute cache) at `cacheWrite x input` and read on every other call
  at `cacheRead x input`.
- **Batch:** the batch share of traffic pays 50%, and can't use the cache.
- **Retries:** every token cost x `(1 + retry rate)`.
- **Guardrails:** each check is billed in whole text units of up to 1,000 characters, rounded up
  (240 characters = 1 unit, 5,600 = 6), input and output separately, x the sum of the enabled policy
  prices per 1,000 units. Scope "user": the user message and the final answer, once per message.
  Scope "full": everything sent and received, on every model call (agent steps included).
- **S3 Vectors** is usage-based: the amount you enter, or a $5/month starting estimate while it is 0.
- **Knowledge base:** the vector store's monthly amount, plus embeddings for the corpus
  (x re-indexing runs) and for every user question.
- **Logging:** `all tokens x 4 bytes x 1.3 (JSON overhead) / 10^9 x price per GB`.

## The multiplier

`naive = (userTokens x input price + outputTokens x output price) x turns x conversations`:
the pricing-page estimate. `multiplier = real / naive`.

## Savings ideas

Each idea changes one setting (history window of 4, prompt caching, 3 chunks, 300-token answers,
2 agent steps, Guardrails on user input only, S3 Vectors, Global endpoint, 30% batch, the next cheaper
model) and re-runs the whole estimate. Ideas saving less than 1% are hidden; the rest are sorted by
dollars saved.

## Not modelled

Provisioned throughput, reserved tiers, long-context surcharges (noted per model), image/audio/video
inputs, reasoning-token budgets, AgentCore, Flows, Data Automation, re-ranking, data transfer, and tax.
