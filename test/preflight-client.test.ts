import assert from "node:assert/strict";
import test from "node:test";

process.env.CHRONIK_URL = "http://127.0.0.1:1";
process.env.CAE_PREFLIGHT_URL = "http://127.0.0.1:1";
process.env.CAE_REQUEST_TIMEOUT_MS = "100";
process.env.AGENT_ID = "test-agent";
process.env.AGENT_ROLE = "test";
process.env.AGENT_WALLET = "ecash:qzh3lwn68jtn94e8pf059rslfssyrjjyaykjwr0z2a";
process.env.AGENT_DAILY_LIMIT_SATS = "1000";
process.env.AGENT_INTENT_TTL_SECONDS = "300";

const NOW = 1_800_000_000;
const intent = {
  contractVersion: "1.0" as const,
  kind: "agent_intent" as const,
  intentId: "intent:preflight",
  nonce: "MDEyMzQ1Njc4OWFiY2RlZg",
  agentId: "agent:test",
  agentRole: "tester",
  network: "xec:mainnet" as const,
  fromAddress: "ecash:qzh3lwn68jtn94e8pf059rslfssyrjjyaykjwr0z2a",
  toAddress: "ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
  amountSats: "100",
  reason: "Exercise the fail-closed client",
  createdAt: NOW - 10,
  expiresAt: NOW + 300
};

const decision = (
  value: "approved" | "rejected" | "needs_human_approval"
) => ({
  contractVersion: "1.0",
  kind: "cae_policy_decision",
  decisionId: `decision:${value}`,
  intentId: intent.intentId,
  decision: value,
  reasonCode: `fixture:${value}`,
  reason: `Valid ${value} fixture`,
  policyTraceId: `trace:${value}`,
  policyVersion: "test",
  evaluatedAt: NOW,
  expiresAt: NOW + 60
});

test("all three canonical CAE decisions are accepted", async () => {
  const { createPreflightRequester } = await import(
    "../src/cae/preflightClient"
  );

  for (const value of [
    "approved",
    "rejected",
    "needs_human_approval"
  ] as const) {
    const requester = createPreflightRequester({
      post: async () => ({ status: 200, data: decision(value) })
    });
    const response = await requester(intent);
    assert.equal(response.decision, value);
  }
});

test("unknown, absent, incompatible, malformed, and mismatched decisions fail closed", async () => {
  const { CaeFailClosedError, createPreflightRequester } = await import(
    "../src/cae/preflightClient"
  );
  const invalidResponses = [
    { ...decision("approved"), decision: "allow" },
    undefined,
    { ...decision("approved"), contractVersion: "2.0" },
    { ...decision("approved"), reason: "" },
    { ...decision("approved"), intentId: "intent:other" }
  ];

  for (const data of invalidResponses) {
    const requester = createPreflightRequester({
      post: async () => ({ status: 200, data })
    });
    await assert.rejects(
      requester(intent),
      (error: unknown) => error instanceof CaeFailClosedError
    );
  }
});

test("network errors and non-2xx responses fail closed", async () => {
  const { CaeFailClosedError, createPreflightRequester } = await import(
    "../src/cae/preflightClient"
  );
  const networkFailure = createPreflightRequester({
    post: async () => {
      throw new Error("network unavailable");
    }
  });
  const statusFailure = createPreflightRequester({
    post: async () => ({ status: 503, data: decision("approved") })
  });

  await assert.rejects(
    networkFailure(intent),
    (error: unknown) => error instanceof CaeFailClosedError
  );
  await assert.rejects(
    statusFailure(intent),
    (error: unknown) => error instanceof CaeFailClosedError
  );
});

test("expired and not-yet-valid policy decisions fail closed at the guard", async () => {
  const { CaeFailClosedError } = await import("../src/cae/preflightClient");
  const { enforcePreflight } = await import("../src/cae/policyGuard");
  const expired = {
    ...decision("approved"),
    evaluatedAt: NOW - 120,
    expiresAt: NOW - 60
  };
  const future = {
    ...decision("approved"),
    evaluatedAt: NOW + 10,
    expiresAt: NOW + 60
  };

  for (const candidate of [expired, future]) {
    await assert.rejects(
      enforcePreflight(intent, async () => candidate, () => NOW),
      (error: unknown) => error instanceof CaeFailClosedError
    );
  }
});
