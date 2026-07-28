import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const NOW = 1_800_000_000;
const FROM = "ecash:qzh3lwn68jtn94e8pf059rslfssyrjjyaykjwr0z2a";
const ALLOWED = "ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a";
const BLOCKED = "ecash:qq9h6k0v3p7q2c8pn8f5t9m6wg0ljr42hvf4cey8d7";

const canonicalIntent = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: "1.0",
  kind: "agent_intent",
  intentId: "intent:policy-1",
  nonce: "MDEyMzQ1Njc4OWFiY2RlZg",
  agentId: "agent:test",
  agentRole: "tester",
  network: "xec:mainnet",
  fromAddress: FROM,
  toAddress: ALLOWED,
  amountSats: "100",
  reason: "Exercise cycle 1 policy",
  createdAt: NOW - 10,
  expiresAt: NOW + 300,
  ...overrides
});

const require = createRequire(import.meta.url);
const {
  InvalidAgentIntentError,
  createPolicyEngine
} = require("../src/cae/policyEngine.cjs") as {
  InvalidAgentIntentError: new () => Error;
  createPolicyEngine: (options?: Record<string, unknown>) => {
    evaluate: (intent: unknown) => {
      decision: string;
      reasonCode: string;
      intentId: string;
    };
    snapshot: () => {
      reservations: Record<string, string>;
    };
  };
};

const enabledEngine = (overrides: Record<string, unknown> = {}) =>
  createPolicyEngine({
    now: () => NOW,
    killSwitch: false,
    allowedPayTo: [ALLOWED],
    dailyLimitSats: "1000",
    ...overrides
  });

test("eligible canonical intent requires human approval", () => {
  const engine = enabledEngine();
  const decision = engine.evaluate(canonicalIntent());

  assert.equal(decision.decision, "needs_human_approval");
  assert.equal(decision.reasonCode, "human_approval_required");
  assert.equal(decision.intentId, "intent:policy-1");
  assert.deepEqual(engine.snapshot().reservations, {
    [`agent:test:${Math.floor(NOW / 86_400)}`]: "100"
  });
});

test("replayed intent ID or nonce is rejected", () => {
  const engine = enabledEngine();
  engine.evaluate(canonicalIntent());

  const repeatedId = engine.evaluate(canonicalIntent());
  const repeatedNonce = engine.evaluate(
    canonicalIntent({
      intentId: "intent:policy-2"
    })
  );

  assert.equal(repeatedId.reasonCode, "replay_detected");
  assert.equal(repeatedNonce.reasonCode, "replay_detected");
});

test("expired intent is rejected", () => {
  const decision = enabledEngine().evaluate(
    canonicalIntent({
      createdAt: NOW - 30,
      expiresAt: NOW
    })
  );

  assert.equal(decision.decision, "rejected");
  assert.equal(decision.reasonCode, "intent_expired");
});

test("destination outside allowlist is rejected", () => {
  const decision = enabledEngine().evaluate(
    canonicalIntent({ toAddress: BLOCKED })
  );

  assert.equal(decision.decision, "rejected");
  assert.equal(decision.reasonCode, "destination_not_allowlisted");
});

test("cumulative daily limit reserves previous accepted intents", () => {
  const engine = enabledEngine({ dailyLimitSats: "1000" });
  const first = engine.evaluate(
    canonicalIntent({ intentId: "intent:first", amountSats: "600" })
  );
  const second = engine.evaluate(
    canonicalIntent({
      intentId: "intent:second",
      nonce: "YWJjZGVmZ2hpamtsbW5vcA",
      amountSats: "401"
    })
  );

  assert.equal(first.decision, "needs_human_approval");
  assert.equal(second.decision, "rejected");
  assert.equal(second.reasonCode, "cumulative_limit_exceeded");
});

test("kill-switch rejects every otherwise eligible intent", () => {
  const decision = enabledEngine({ killSwitch: true }).evaluate(
    canonicalIntent()
  );

  assert.equal(decision.decision, "rejected");
  assert.equal(decision.reasonCode, "kill_switch_active");
});

test("invalid intent structure fails instead of producing a policy decision", () => {
  assert.throws(
    () => enabledEngine().evaluate(canonicalIntent({ privateKey: "forbidden" })),
    InvalidAgentIntentError
  );
});
