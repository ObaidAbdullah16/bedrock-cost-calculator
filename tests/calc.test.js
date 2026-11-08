// Run: node --test   (finds tests/*.test.js)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PRICES = require("../site/prices.js");
const C = require("../site/calc.js");

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

// A tiny, hand-checkable setup: 1 user, 1 conversation a day, 1 turn, nothing extra.
const simple = {
  model: "nova-micro", users: 1, conversationsPerUser: 1, turns: 1,
  systemTokens: 0, userTokens: 1000, outputTokens: 1000, history: "none",
  ragChunks: 0, agentSteps: 0, retryRate: 0, caching: false, vectorStore: "none", logging: false
};

test("one question and one answer cost exactly the pricing-page maths", () => {
  const r = C.estimate(simple, PRICES);
  const m = PRICES.models.find((x) => x.id === "nova-micro");
  const perConv = (1000 * m.input + 1000 * m.output) / 1e6;
  close(r.monthly, perConv * 30);
  close(r.naiveMonthly, r.monthly);
  close(r.multiplier, 1);
});

test("full chat history grows input quadratically with the number of turns", () => {
  const t = C.conversationTokens(C.normalise({ ...simple, turns: 5, history: "full" }));
  // turn k re-sends (k-1) earlier pairs of 2,000 tokens: 0+1+2+3+4 = 10 pairs
  assert.equal(t.history, 10 * 2000);
  const w = C.conversationTokens(C.normalise({ ...simple, turns: 5, history: "window", historyWindow: 2 }));
  assert.equal(w.history, (0 + 1 + 2 + 2 + 2) * 2000);
});

test("agent steps re-send the context and accumulate tool results", () => {
  const t = C.conversationTokens(C.normalise({ ...simple, systemTokens: 100, agentSteps: 2, toolResultTokens: 50, stepOutputTokens: 10 }));
  assert.equal(t.calls, 3);
  assert.equal(t.system, 300);
  assert.equal(t.tools, (0 + 1 + 2) * 60);
  assert.equal(t.output, 10 + 10 + 1000);
});

test("prompt caching makes the system prompt cheaper, only above the model's minimum", () => {
  const base = { ...simple, model: "claude-sonnet-4-6", systemTokens: 3000, turns: 6 };
  const off = C.estimate(base, PRICES).breakdown.system;
  const on = C.estimate({ ...base, caching: true }, PRICES).breakdown.system;
  assert.ok(on < off * 0.3, `caching should cut the system prompt cost a lot (${on} vs ${off})`);
  const small = C.estimate({ ...base, systemTokens: 500, caching: true }, PRICES);
  assert.equal(small.cached, false, "500 tokens is below Sonnet 4.6's 1,024-token minimum");
});

test("batch halves token costs only for models that support batch", () => {
  const full = C.estimate({ ...simple, model: "nova-lite" }, PRICES).monthly;
  close(C.estimate({ ...simple, model: "nova-lite", batchShare: 1 }, PRICES).monthly, full / 2);
  const noBatch = C.estimate({ ...simple, model: "mistral-large-3" }, PRICES).monthly;
  close(C.estimate({ ...simple, model: "mistral-large-3", batchShare: 1 }, PRICES).monthly, noBatch);
});

test("geographic endpoints add 10% only where the model has a premium", () => {
  const g = C.estimate({ ...simple, model: "claude-haiku-5-5" }, PRICES).monthly;
  close(C.estimate({ ...simple, model: "claude-haiku-5-5", endpoint: "geo" }, PRICES).monthly, g * 1.1);
  const n = C.estimate({ ...simple, model: "nova-micro" }, PRICES).monthly;
  close(C.estimate({ ...simple, model: "nova-micro", endpoint: "geo" }, PRICES).monthly, n);
});

test("guardrails are billed per 1,000 characters and policy, and scope matters", () => {
  const withG = { ...simple, guardrails: { contentFilters: true, pii: true } };
  const r = C.estimate(withG, PRICES);
  // (1000 + 1000 tokens) * 4 chars = 8,000 chars = 8 units; $0.25 per 1,000 units
  close(r.breakdown.guardrails, 8 * 0.25 / 1000 * 30);
  const big = { ...withG, systemTokens: 2000, ragChunks: 5, chunkTokens: 400 };
  assert.ok(C.estimate({ ...big, guardrailScope: "full" }, PRICES).breakdown.guardrails >
            2.5 * C.estimate({ ...big, guardrailScope: "user" }, PRICES).breakdown.guardrails);
});

test("guardrails round every check up to whole text units, input and answer separately", () => {
  // 60 tokens = 240 characters = 1 unit; 350 tokens = 1,400 characters = 2 units. 6 turns = 18 units,
  // not ceil(6 x 410 x 4 / 1000) = 10 as a per-conversation total would say.
  const r = C.estimate({ ...simple, turns: 6, userTokens: 60, outputTokens: 350, guardrails: { contentFilters: true } }, PRICES);
  close(r.breakdown.guardrails, 18 * 0.15 / 1000 * 30);
  // "full" scope checks every call: turn 2 sends 0 + 410 history + 60 = 470 tokens = 1,880 chars = 2 units.
  const t = C.conversationTokens(C.normalise({ ...simple, turns: 2, userTokens: 60, outputTokens: 350, history: "full" }), 4);
  assert.equal(t.guardUnitsFull, (1 + 2) + (2 + 2));
});

test("S3 Vectors uses its starting estimate until you enter an amount", () => {
  close(C.estimate({ ...simple, vectorStore: "s3vectors" }, PRICES).breakdown.vectorStore, 5);
  close(C.estimate({ ...simple, vectorStore: "custom" }, PRICES).breakdown.vectorStore, 0);
});

test("retries, vector store, embeddings and logging are included", () => {
  const r = C.estimate({ ...simple, retryRate: 0.1, vectorStore: "opensearchClassic", ragChunks: 2, chunkTokens: 100, logging: true }, PRICES);
  close(r.breakdown.vectorStore, 350.40);
  assert.ok(r.breakdown.embeddings > 0);
  assert.ok(r.breakdown.logging > 0);
  assert.ok(r.retriesCost > 0);
  const custom = C.estimate({ ...simple, vectorStore: "s3vectors", vectorStoreCustom: 12 }, PRICES);
  close(custom.breakdown.vectorStore, 12);
});

test("price overrides replace the built-in prices", () => {
  const r = C.estimate({ ...simple, priceOverrides: { "nova-micro": { input: 1, output: 2 } } }, PRICES);
  close(r.monthly, (1000 * 1 + 1000 * 2) / 1e6 * 30);
});

test("bad input never produces NaN", () => {
  const r = C.estimate({ users: "abc", turns: -5, retryRate: 9, model: "does-not-exist" }, PRICES);
  assert.ok(Number.isFinite(r.monthly));
  assert.equal(r.settings.turns, C.DEFAULTS.turns);
  assert.equal(r.settings.retryRate, 1);
});

test("every preset shows a realistic multiplier and useful savings ideas", () => {
  for (const [name, p] of Object.entries(C.PRESETS)) {
    const r = C.estimate(p.values, PRICES);
    assert.ok(r.monthly > 0 && r.multiplier >= 1, name);
    const s = C.savings(p.values, PRICES);
    for (let i = 1; i < s.ideas.length; i++) assert.ok(s.ideas[i - 1].saves >= s.ideas[i].saves, "sorted");
    for (const idea of s.ideas) assert.ok(idea.monthly < s.base, `${name}/${idea.id} must save money`);
  }
  const ids = C.savings(C.PRESETS.support.values, PRICES).ideas.map((i) => i.id);
  assert.ok(ids.includes("guardscope") && ids.includes("vectors") && ids.includes("rag"));
});

test("share links round-trip and reject garbage", () => {
  const s = C.encodeState(C.PRESETS.agent.values);
  assert.match(s, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(C.decodeState(s), C.normalise(C.PRESETS.agent.values));
  assert.equal(C.decodeState("%%%not-base64"), null);
});

test("price data is complete and sane", () => {
  assert.match(PRICES.checked, /^\d{4}-\d{2}-\d{2}$/);
  const ids = new Set();
  for (const m of PRICES.models) {
    assert.ok(!ids.has(m.id), `duplicate ${m.id}`);
    ids.add(m.id);
    assert.ok(m.input > 0 && m.output > 0 && m.output >= m.input, m.id);
    if (m.cacheRead !== null) assert.ok(m.cacheRead > 0 && m.cacheRead < 1 && m.cacheMin > 0, m.id);
  }
  assert.ok(ids.has(C.DEFAULTS.model));
});
