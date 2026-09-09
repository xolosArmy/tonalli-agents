import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENTIC_CONTRACT_VERSION,
  parseAgentIntentV1,
  parseCaePolicyDecisionV1,
  parseWalletApprovalRequestV1,
  type WalletApprovalRequestV1
} from "@xolosarmy/tonalli-core";
import {
  createWalletApprovalConsumer,
  WalletApprovalConsumerError
} from "../src/wallet/approvalConsumer";

const BASE_TIME = 1_770_000_000;
const VALID_NONCE_BASE = "MDEyMzQ1Njc4OWFiY2RlZg";

function createValidRequest(overrides: {
  amountSats?: string;
  toAddress?: string;
  intentId?: string;
  nonce?: string;
  requestId?: string;
  policyTraceId?: string;
  network?: "xec:mainnet";
  createdAt?: number;
  expiresAt?: number;
  policyExpiresAt?: number;
  requestExpiresAt?: number;
} = {}): WalletApprovalRequestV1 {
  const intentId = overrides.intentId ?? "intent-test-consumer-001";
  const createdAt = overrides.createdAt ?? BASE_TIME;
  const expiresAt = overrides.expiresAt ?? createdAt + 300;
  const policyExpiresAt = overrides.policyExpiresAt ?? createdAt + 120;
  const requestExpiresAt = overrides.requestExpiresAt ?? createdAt + 120;

  const intent = parseAgentIntentV1({
    contractVersion: AGENTIC_CONTRACT_VERSION,
    kind: "agent_intent",
    intentId,
    nonce: overrides.nonce ?? `${VALID_NONCE_BASE}-001`,
    agentId: "agent:xolo-test",
    agentRole: "treasury",
    network: overrides.network ?? "xec:mainnet",
    fromAddress: "ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
    toAddress: overrides.toAddress ?? "ecash:qz2708636sn2hnj09meqnvsa950vsccpm5e064ncw8",
    amountSats: overrides.amountSats ?? "5000",
    reason: "Treasury operational reimbursement",
    memo: "INV-2026-09-09",
    createdAt,
    expiresAt
  });

  const policyDecision = parseCaePolicyDecisionV1({
    contractVersion: AGENTIC_CONTRACT_VERSION,
    kind: "cae_policy_decision",
    decisionId: `decision:${intentId}:001`,
    intentId,
    decision: "needs_human_approval",
    reasonCode: "human_approval_required",
    reason: "Monetary transfer requires human authorization",
    policyTraceId: overrides.policyTraceId ?? "trace:cae:2026-09-09:001",
    policyVersion: "xolosarmy-agentic-cycle-1",
    evaluatedAt: createdAt,
    expiresAt: policyExpiresAt
  });

  return parseWalletApprovalRequestV1({
    contractVersion: AGENTIC_CONTRACT_VERSION,
    kind: "wallet_approval_request",
    purpose: "xec_payment",
    requestId: overrides.requestId ?? "request:test-consumer-001",
    intent,
    policyDecision,
    requestedAt: createdAt,
    expiresAt: requestExpiresAt
  });
}

test("WalletApprovalConsumer default constraints: killSwitch=true blocks requests", () => {
  const consumer = createWalletApprovalConsumer(); // defaults: killSwitch=true, limit=0
  const request = createValidRequest();

  assert.throws(
    () => consumer.validateRequest(request),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "KILL_SWITCH_ACTIVE");
      return true;
    }
  );
});

test("WalletApprovalConsumer default constraints: monetary limit 0 rejects non-zero amounts", () => {
  const consumer = createWalletApprovalConsumer({
    killSwitch: false, // only disable kill switch to test monetary limit default
    now: () => BASE_TIME
  });
  const request = createValidRequest({ amountSats: "100" });

  assert.throws(
    () => consumer.validateRequest(request),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "LIMIT_EXCEEDED");
      return true;
    }
  );
});

test("WalletApprovalConsumer canonical flow: validate, format display, and record human approval", () => {
  const consumer = createWalletApprovalConsumer({
    killSwitch: false,
    maxMonetaryLimitSats: 10_000n,
    now: () => BASE_TIME + 10
  });

  const request = createValidRequest({ amountSats: "5000" });

  // 1. Validation passes
  const validated = consumer.validateRequest(request);
  assert.equal(validated.requestId, request.requestId);

  // 2. Format display presents all required audit fields
  const display = consumer.formatDisplay(validated);
  assert.equal(display.requestId, request.requestId);
  assert.equal(display.intentId, request.intent.intentId);
  assert.equal(display.decisionId, request.policyDecision.decisionId);
  assert.equal(display.network, "xec:mainnet");
  assert.equal(display.amountSats, "5000");
  assert.equal(display.amountXEC, "50.00");
  assert.equal(display.destination, request.intent.toAddress);
  assert.equal(display.fromAddress, request.intent.fromAddress);
  assert.equal(display.reason, "Treasury operational reimbursement");
  assert.equal(display.memo, "INV-2026-09-09");
  assert.equal(display.policyTraceId, "trace:cae:2026-09-09:001");
  assert.equal(display.policyReasonCode, "human_approval_required");
  assert.equal(display.policyVersion, "xolosarmy-agentic-cycle-1");
  assert.equal(display.requestedAt, BASE_TIME);
  assert.equal(display.expiresAt, BASE_TIME + 120);

  // 3. Human records explicit approval
  const humanApproval = consumer.recordHumanDecision(validated, {
    decision: "approved",
    approver: "auditor:human-01",
    reason: "Approved after verifying operational invoice"
  });

  assert.equal(humanApproval.kind, "human_approval");
  assert.equal(humanApproval.status, "approved");
  assert.equal(humanApproval.requestId, request.requestId);
  assert.equal(humanApproval.intentId, request.intent.intentId);
  assert.equal(humanApproval.decisionId, request.policyDecision.decisionId);
  assert.equal(humanApproval.approver, "auditor:human-01");
  assert.equal(humanApproval.recordedAt, BASE_TIME + 10);

  // 4. Invariant: request and approval remain separate, auditable artifacts with NO secrets
  const reqStr = JSON.stringify(validated);
  const appStr = JSON.stringify(humanApproval);

  for (const forbidden of [
    "seed",
    "mnemonic",
    "privateKey",
    "signature",
    "rawTransaction",
    "txid"
  ]) {
    assert.equal(reqStr.includes(forbidden), false, `Request must not contain ${forbidden}`);
    assert.equal(appStr.includes(forbidden), false, `HumanApproval must not contain ${forbidden}`);
  }
});

test("WalletApprovalConsumer negative: tampering between intent and policy decision", () => {
  const consumer = createWalletApprovalConsumer({
    killSwitch: false,
    maxMonetaryLimitSats: 10_000n,
    now: () => BASE_TIME
  });

  const validRequest = createValidRequest();
  // Tamper intentId in policy decision
  const tampered = {
    ...validRequest,
    policyDecision: {
      ...validRequest.policyDecision,
      intentId: "intent-tampered-id"
    }
  };

  assert.throws(
    () => consumer.validateRequest(tampered),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "TAMPERED_REQUEST");
      return true;
    }
  );
});

test("WalletApprovalConsumer negative: tampering with empty policy trace ID", () => {
  const consumer = createWalletApprovalConsumer({
    killSwitch: false,
    maxMonetaryLimitSats: 10_000n,
    now: () => BASE_TIME
  });

  const validRequest = createValidRequest();
  const tampered = {
    ...validRequest,
    policyDecision: {
      ...validRequest.policyDecision,
      policyTraceId: "   "
    }
  };

  assert.throws(
    () => consumer.validateRequest(tampered),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "INVALID_SCHEMA");
      return true;
    }
  );
});

test("WalletApprovalConsumer negative: request expiration", () => {
  const consumer = createWalletApprovalConsumer({
    killSwitch: false,
    maxMonetaryLimitSats: 10_000n,
    now: () => BASE_TIME + 500 // 500 > 120 (requestExpiresAt)
  });

  const request = createValidRequest();

  assert.throws(
    () => consumer.validateRequest(request),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "EXPIRED_REQUEST");
      return true;
    }
  );
});

test("WalletApprovalConsumer negative: human decision recorded after expiration is rejected", () => {
  let currentTime = BASE_TIME + 50;
  const consumer = createWalletApprovalConsumer({
    killSwitch: false,
    maxMonetaryLimitSats: 10_000n,
    now: () => currentTime
  });

  const request = createValidRequest();
  const validated = consumer.validateRequest(request);

  // Fast forward past expiration
  currentTime = BASE_TIME + 200;

  assert.throws(
    () =>
      consumer.recordHumanDecision(validated, {
        decision: "approved",
        approver: "auditor"
      }),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "EXPIRED_REQUEST");
      return true;
    }
  );
});

test("WalletApprovalConsumer negative: replay protection for requestId, intentId, and nonce", () => {
  const consumer = createWalletApprovalConsumer({
    killSwitch: false,
    maxMonetaryLimitSats: 10_000n,
    now: () => BASE_TIME
  });

  const request1 = createValidRequest({
    requestId: "req-replay-1",
    intentId: "intent-replay-1",
    nonce: `${VALID_NONCE_BASE}-001`
  });

  consumer.validateRequest(request1);

  // Attempt duplicate requestId
  const duplicateReq = createValidRequest({
    requestId: "req-replay-1",
    intentId: "intent-replay-2",
    nonce: `${VALID_NONCE_BASE}-002`
  });
  assert.throws(
    () => consumer.validateRequest(duplicateReq),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "REPLAY_DETECTED");
      return true;
    }
  );

  // Attempt duplicate intentId
  const duplicateIntent = createValidRequest({
    requestId: "req-replay-3",
    intentId: "intent-replay-1",
    nonce: `${VALID_NONCE_BASE}-003`
  });
  assert.throws(
    () => consumer.validateRequest(duplicateIntent),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "REPLAY_DETECTED");
      return true;
    }
  );

  // Attempt duplicate nonce
  const duplicateNonce = createValidRequest({
    requestId: "req-replay-4",
    intentId: "intent-replay-4",
    nonce: `${VALID_NONCE_BASE}-001`
  });
  assert.throws(
    () => consumer.validateRequest(duplicateNonce),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "REPLAY_DETECTED");
      return true;
    }
  );
});

test("WalletApprovalConsumer negative: schema errors and invalid kinds", () => {
  const consumer = createWalletApprovalConsumer({
    killSwitch: false,
    maxMonetaryLimitSats: 10_000n,
    now: () => BASE_TIME
  });

  // Malformed / incomplete object
  assert.throws(
    () => consumer.validateRequest({ invalid: "data" }),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "INVALID_SCHEMA");
      return true;
    }
  );

  // Intent created in future relative to consumer now()
  const futureConsumer = createWalletApprovalConsumer({
    killSwitch: false,
    maxMonetaryLimitSats: 10_000n,
    now: () => BASE_TIME - 100 // consumer now() is before createdAt
  });
  const futureIntent = createValidRequest({
    createdAt: BASE_TIME
  });
  assert.throws(
    () => futureConsumer.validateRequest(futureIntent),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "INVALID_SCHEMA");
      return true;
    }
  );
});

test("WalletApprovalConsumer negative: non-needs_human_approval policy decisions rejected", () => {
  const consumer = createWalletApprovalConsumer({
    killSwitch: false,
    maxMonetaryLimitSats: 10_000n,
    now: () => BASE_TIME
  });

  const validRequest = createValidRequest();
  const rejectedRequest = {
    ...validRequest,
    policyDecision: {
      ...validRequest.policyDecision,
      decision: "rejected"
    }
  };

  assert.throws(
    () => consumer.validateRequest(rejectedRequest),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "UNAUTHORIZED_DECISION");
      return true;
    }
  );
});

test("WalletApprovalConsumer negative: network mismatch rejected", () => {
  const consumer = createWalletApprovalConsumer({
    killSwitch: false,
    maxMonetaryLimitSats: 10_000n,
    expectedNetwork: "xec:mainnet",
    now: () => BASE_TIME
  });

  const validRequest = createValidRequest();
  const mismatchedNetwork = {
    ...validRequest,
    intent: {
      ...validRequest.intent,
      network: "xec:testnet"
    }
  };

  assert.throws(
    () => consumer.validateRequest(mismatchedNetwork),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "INVALID_SCHEMA"); // caught by Core schema or network check
      return true;
    }
  );
});

test("WalletApprovalConsumer negative: absent, implicit, or fake human approval rejected", () => {
  const consumer = createWalletApprovalConsumer({
    killSwitch: false,
    maxMonetaryLimitSats: 10_000n,
    now: () => BASE_TIME
  });

  const request = createValidRequest();
  const validated = consumer.validateRequest(request);

  // Absent action
  assert.throws(
    () => consumer.recordHumanDecision(validated, null as any),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "MISSING_HUMAN_APPROVAL");
      return true;
    }
  );

  // Implicit / fake decision
  assert.throws(
    () => consumer.recordHumanDecision(validated, { decision: "automatic" as any }),
    (err: unknown) => {
      assert(err instanceof WalletApprovalConsumerError);
      assert.equal(err.code, "INVALID_HUMAN_ACTION");
      return true;
    }
  );
});

test("WalletApprovalConsumer processApprovalHandoff E2E simulation returns distinct artifacts", () => {
  const consumer = createWalletApprovalConsumer({
    killSwitch: false,
    maxMonetaryLimitSats: 10_000n,
    now: () => BASE_TIME
  });

  const request = createValidRequest();
  const result = consumer.processApprovalHandoff(request, {
    decision: "approved",
    approver: "ops:test-user",
    reason: "E2E REGTEST validation"
  });

  assert.equal(result.simulation, true);
  assert.equal(result.request.requestId, request.requestId);
  assert.equal(result.humanApproval.status, "approved");
  assert.equal(result.display.amountXEC, "50.00");
  assert.notEqual(result.request, result.humanApproval);
});
