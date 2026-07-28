import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.CHRONIK_URL = "http://127.0.0.1:1";
process.env.CAE_PREFLIGHT_URL = "http://127.0.0.1:1";
process.env.CAE_REQUEST_TIMEOUT_MS = "100";
process.env.AGENT_ID = "test-agent";
process.env.AGENT_ROLE = "test";
process.env.AGENT_WALLET = "ecash:qzh3lwn68jtn94e8pf059rslfssyrjjyaykjwr0z2a";
process.env.AGENT_DAILY_LIMIT_SATS = "1000";
process.env.AGENT_INTENT_TTL_SECONDS = "300";

const intent = {
  contractVersion: "1.0" as const,
  kind: "agent_intent" as const,
  intentId: "intent:test",
  nonce: "MDEyMzQ1Njc4OWFiY2RlZg",
  agentId: "test-agent",
  agentRole: "test",
  network: "xec:mainnet" as const,
  fromAddress: "ecash:qzh3lwn68jtn94e8pf059rslfssyrjjyaykjwr0z2a",
  toAddress: "ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
  amountSats: "100",
  reason: "cycle 1 safety test",
  createdAt: 1_800_000_000,
  expiresAt: 1_800_000_300
};

const assertNoTransactionArtifact = (value: unknown) => {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes("txid"), false);
  assert.equal(serialized.includes("txHex"), false);
  assert.equal(serialized.includes("rawTx"), false);
};

test("root session signer returns an explicit non-executable state", async () => {
  const { signApprovedIntent } = await import("../src/wallet/sessionSigner");
  const result = await signApprovedIntent(intent);

  assert.deepEqual(result, {
    status: "not_implemented",
    simulation: true,
    reason: "wallet_signing_not_implemented"
  });
  assertNoTransactionArtifact(result);
});

test("publishable SDK session signer returns no transaction artifact", async () => {
  const { signApprovedIntent } = await import(
    "../tonalli-agent-sdk/src/wallet/sessionSigner"
  );
  const result = await signApprovedIntent(intent);

  assert.equal(result.status, "not_implemented");
  assert.equal(result.simulation, true);
  assertNoTransactionArtifact(result);
});

test("tracked CommonJS signer artifact is also non-executable", async () => {
  const require = createRequire(import.meta.url);
  const { signApprovedIntent } = require(
    "../tonalli-agent-sdk/src/wallet/sessionSigner.js"
  ) as {
    signApprovedIntent: (candidate: typeof intent) => Promise<unknown>;
  };
  const result = await signApprovedIntent(intent);

  assert.deepEqual(result, {
    status: "not_implemented",
    simulation: true,
    reason: "wallet_signing_not_implemented"
  });
  assertNoTransactionArtifact(result);
});

test("safeSendXEC never reports execution success", async () => {
  const { safeSendXEC } = await import("../src/wallet/safeSendXEC");
  const result = await safeSendXEC({
    toAddress: intent.toAddress,
    amountSats: Number(intent.amountSats),
    reason: intent.reason
  }, {
    now: () => intent.createdAt,
    randomId: () => "test",
    randomNonce: () => intent.nonce,
    requestPolicy: async (candidate) => ({
      contractVersion: "1.0",
      kind: "cae_policy_decision",
      decisionId: "decision:test",
      intentId: candidate.intentId,
      decision: "approved",
      reasonCode: "test-approved",
      reason: "Valid decision fixture",
      policyTraceId: "trace:test",
      policyVersion: "test",
      evaluatedAt: intent.createdAt,
      expiresAt: intent.expiresAt
    })
  });

  assert.equal(result.status, "not_implemented");
  assert.equal(result.simulation, true);
  assert.equal(result.workflow.signedTransaction?.status, "not_implemented");
  assert.equal(result.workflow.broadcast?.status, "not_attempted");
  assert.equal(result.workflow.confirmation?.status, "not_attempted");
  assert.equal("success" in result, false);
  assertNoTransactionArtifact(result);
});

test("human approval request is a separate public handoff with no signing material", async () => {
  const { safeSendXEC } = await import("../src/wallet/safeSendXEC");
  const result = await safeSendXEC({
    toAddress: intent.toAddress,
    amountSats: Number(intent.amountSats),
    reason: intent.reason
  }, {
    now: () => intent.createdAt,
    randomId: () => "human-test",
    randomNonce: () => intent.nonce,
    requestPolicy: async (candidate) => ({
      contractVersion: "1.0",
      kind: "cae_policy_decision",
      decisionId: "decision:human-test",
      intentId: candidate.intentId,
      decision: "needs_human_approval",
      reasonCode: "human_approval_required",
      reason: "Explicit human custody is required",
      policyTraceId: "trace:human-test",
      policyVersion: "test",
      evaluatedAt: intent.createdAt,
      expiresAt: intent.expiresAt
    })
  });

  assert.equal(result.status, "needs_human_approval");
  assert.equal(result.simulation, true);
  assert.equal(result.walletApprovalRequest.kind, "wallet_approval_request");
  assert.equal(result.walletApprovalRequest.intent.amountSats, intent.amountSats);
  assert.equal(result.workflow.signedTransaction?.status, "not_attempted");
  assert.equal(result.workflow.broadcast?.status, "not_attempted");
  assert.equal(result.workflow.confirmation?.status, "not_attempted");

  const serialized = JSON.stringify(result.walletApprovalRequest);
  for (const forbidden of [
    "seed",
    "mnemonic",
    "privateKey",
    "signature",
    "rawTransaction"
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assertNoTransactionArtifact(result);
});
