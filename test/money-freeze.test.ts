import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.CHRONIK_URL = "http://127.0.0.1:1";
process.env.CAE_PREFLIGHT_URL = "http://127.0.0.1:1";
process.env.AGENT_ID = "test-agent";
process.env.AGENT_ROLE = "test";
process.env.AGENT_WALLET = "ecash:qtest";
process.env.AGENT_DAILY_LIMIT_SATS = "1000";

const intent = {
  agentId: "test-agent",
  agentRole: "test",
  fromAddress: "ecash:qfrom",
  toAddress: "ecash:qto",
  amountSats: 100,
  reason: "cycle 1 safety test",
  timestamp: "2026-07-28T00:00:00.000Z"
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
    amountSats: intent.amountSats,
    reason: intent.reason
  });

  assert.equal(result.status, "not_implemented");
  assert.equal(result.simulation, true);
  assert.equal(result.humanApproval.status, "required");
  assert.equal(result.signedTransaction.status, "not_implemented");
  assert.equal(result.broadcast.status, "not_attempted");
  assert.equal(result.confirmation.status, "not_attempted");
  assert.equal("success" in result, false);
  assertNoTransactionArtifact(result);
});
