import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENTIC_CONTRACT_VERSION,
  type HumanApprovalV1,
  type WalletApprovalRequestV1
} from "@xolosarmy/tonalli-core";
import {
  createWalletApprovalTransport,
  WalletApprovalTransportError,
  type WalletApprovalTransportPort
} from "../src/wallet/approvalTransport";
import { formatSatsToExactXEC } from "../src/wallet/format";

const BASE_VALID_INTENT = {
  contractVersion: AGENTIC_CONTRACT_VERSION,
  kind: "agent_intent" as const,
  intentId: "intent-sec-test-001",
  nonce: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NQ",
  agentId: "agent-security-auditor-1",
  agentRole: "security_auditor",
  network: "xec:mainnet" as const,
  fromAddress: "ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2",
  toAddress: "ecash:qp3wjpa3tjlj042z2wv7hahvd8whzgcwvue2swknmw",
  amountSats: "500",
  reason: "Audit fee settlement test",
  memo: "Security test memo",
  createdAt: 1770000000,
  expiresAt: 1770000300
};

const BASE_VALID_POLICY_DECISION = {
  contractVersion: AGENTIC_CONTRACT_VERSION,
  kind: "cae_policy_decision" as const,
  decisionId: "cae-dec-sec-001",
  intentId: "intent-sec-test-001",
  decision: "needs_human_approval" as const,
  reasonCode: "HUMAN_CONFIRMATION_REQUIRED",
  reason: "Security gate requires explicit human confirmation",
  policyTraceId: "trace-audit-sec-001",
  policyVersion: "constitution-2026-v1.0",
  evaluatedAt: 1770000001,
  expiresAt: 1770000300
};

function createValidRequest(overrides?: Partial<WalletApprovalRequestV1>): WalletApprovalRequestV1 {
  return {
    contractVersion: AGENTIC_CONTRACT_VERSION,
    kind: "wallet_approval_request",
    requestId: "req-sec-test-001",
    purpose: "xec_payment",
    intent: { ...BASE_VALID_INTENT },
    policyDecision: { ...BASE_VALID_POLICY_DECISION },
    requestedAt: 1770000002,
    expiresAt: 1770000300,
    ...overrides
  };
}

test("Robust env boolean & integer parsing avoids z.coerce.boolean flaws", async () => {
  process.env.CHRONIK_URL = "http://127.0.0.1:1";
  process.env.CAE_PREFLIGHT_URL = "http://127.0.0.1:1";
  process.env.CAE_REQUEST_TIMEOUT_MS = "100";
  process.env.AGENT_ID = "test-agent";
  process.env.AGENT_ROLE = "test";
  process.env.AGENT_WALLET = "ecash:qzh3lwn68jtn94e8pf059rslfssyrjjyaykjwr0z2a";
  process.env.AGENT_DAILY_LIMIT_SATS = "1000";
  process.env.AGENT_INTENT_TTL_SECONDS = "300";

  const { parseEnvBoolean, parseEnvNonnegativeInt } = await import("../src/config/env");

  assert.equal(parseEnvBoolean("false"), false);
  assert.equal(parseEnvBoolean("0"), false);
  assert.equal(parseEnvBoolean("FALSE"), false);
  assert.equal(parseEnvBoolean("true"), true);
  assert.equal(parseEnvBoolean("1"), true);
  assert.equal(parseEnvBoolean(undefined, true), true);
  assert.equal(parseEnvBoolean("", true), true);

  assert.equal(parseEnvNonnegativeInt("0"), 0);
  assert.equal(parseEnvNonnegativeInt("500"), 500);
  assert.equal(parseEnvNonnegativeInt(undefined, 0), 0);
  assert.equal(parseEnvNonnegativeInt("invalid", 0), 0);
});

test("WalletApprovalTransport default: killSwitch=true blocks outbound requests", () => {
  const transport = createWalletApprovalTransport();
  const request = createValidRequest();

  assert.throws(
    () => transport.validateOutboundRequest(request),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "KILL_SWITCH_ACTIVE");
      return true;
    }
  );
});

test("WalletApprovalTransport default: monetary limit 0 rejects non-zero amounts", () => {
  const transport = createWalletApprovalTransport({ killSwitch: false });
  const request = createValidRequest({
    intent: { ...BASE_VALID_INTENT, amountSats: "100" }
  });

  assert.throws(
    () => transport.validateOutboundRequest(request),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "MONETARY_LIMIT_EXCEEDED");
      return true;
    }
  );
});

test("WalletApprovalTransport canonical flow: validate outbound, format display, and dispatch via Wallet port", async () => {
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1000,
    nowEpochSeconds: () => 1770000010
  });
  const request = createValidRequest();

  const validated = transport.validateOutboundRequest(request);
  assert.equal(validated.requestId, request.requestId);

  const display = transport.formatAuditDisplay(validated);
  assert.equal(display.requestId, request.requestId);
  assert.equal(display.amountSats, "500");
  assert.equal(display.amountXEC, "5.00 XEC");
  assert.equal(display.network, "xec:mainnet");
  assert.equal(display.policyTraceId, "trace-audit-sec-001");

  // Wallet-owned port returns separate HumanApprovalV1 artifact
  const mockWalletPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-wallet-001",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "approved",
        approver: req.intent.fromAddress,
        recordedAt: 1770000020
      };
    }
  };

  const humanApproval = await transport.dispatchApprovalRequest(request, mockWalletPort);
  assert.equal(humanApproval.kind, "human_approval");
  assert.equal(humanApproval.status, "approved");
  assert.equal(humanApproval.approvalId, "appr-wallet-001");
  assert.equal(humanApproval.approver, request.intent.fromAddress);
});

test("WalletApprovalTransport negative: Wallet response with mismatched requestId is rejected and reservation rolled back", async () => {
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1000,
    nowEpochSeconds: () => 1770000010
  });
  const request = createValidRequest();

  const mockTamperedPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-wallet-001",
        requestId: "tampered-request-id",
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "approved",
        approver: req.intent.fromAddress,
        recordedAt: 1770000020
      };
    }
  };

  await assert.rejects(
    async () => transport.dispatchApprovalRequest(request, mockTamperedPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "RESPONSE_BINDING_MISMATCH");
      return true;
    }
  );

  // Black-box: failure rolled back reservation, so retrying same request succeeds
  const mockValidPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-wallet-valid",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "approved",
        approver: req.intent.fromAddress,
        recordedAt: 1770000020
      };
    }
  };
  const recovered = await transport.dispatchApprovalRequest(request, mockValidPort);
  assert.equal(recovered.status, "approved");
});

test("WalletApprovalTransport negative: approved response with mismatched approver is rejected", async () => {
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1000,
    nowEpochSeconds: () => 1770000010
  });
  const request = createValidRequest();

  const mockWrongApproverPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-wallet-wrong-approver",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "approved",
        approver: "ecash:qp3wjpa3tjlj042z2wv7hahvd8whzgcwvue2swknmw", // wrong address
        recordedAt: 1770000020
      };
    }
  };

  await assert.rejects(
    async () => transport.dispatchApprovalRequest(request, mockWrongApproverPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "RESPONSE_BINDING_MISMATCH");
      assert.match(err.message, /does not match intent fromAddress/);
      return true;
    }
  );
});

test("WalletApprovalTransport negative: response recorded at or after expiresAt without expired status is rejected", async () => {
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1000,
    nowEpochSeconds: () => 1770000010
  });
  const request = createValidRequest({ expiresAt: 1770000200 }); // request.expiresAt < intent.expiresAt (300)

  // Case 1: recordedAt === request.expiresAt exactly for approved status
  const mockBoundaryPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-wallet-boundary",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "approved",
        approver: req.intent.fromAddress,
        recordedAt: 1770000200 // exactly at request.expiresAt
      };
    }
  };

  await assert.rejects(
    async () => transport.dispatchApprovalRequest(request, mockBoundaryPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "RESPONSE_EXPIRED_MISMATCH");
      return true;
    }
  );

  // Case 2: recordedAt > request.expiresAt for rejected status (within workflow window)
  const request2 = createValidRequest({ requestId: "req-sec-test-002", expiresAt: 1770000200 });
  const mockLateRejectedPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-wallet-late-reject",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "rejected",
        recordedAt: 1770000250 // after request.expiresAt, before intent.expiresAt
      };
    }
  };

  await assert.rejects(
    async () => transport.dispatchApprovalRequest(request2, mockLateRejectedPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "RESPONSE_EXPIRED_MISMATCH");
      return true;
    }
  );

  // Case 3: status === "expired" with recordedAt >= request.expiresAt succeeds within workflow window
  const request3 = createValidRequest({ requestId: "req-sec-test-003", expiresAt: 1770000200 });
  const mockValidExpiredPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-wallet-valid-expire",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "expired",
        recordedAt: 1770000250 // after request.expiresAt, before intent.expiresAt
      };
    }
  };

  const expiredReceipt = await transport.dispatchApprovalRequest(request3, mockValidExpiredPort);
  assert.equal(expiredReceipt.status, "expired");
});

test("WalletApprovalTransport black-box: port failure releases reservation allowing retry", async () => {
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1000,
    nowEpochSeconds: () => 1770000010
  });
  const request = createValidRequest();

  const failingPort: WalletApprovalTransportPort = {
    async sendApprovalRequest() {
      throw new Error("Wallet connection refused");
    }
  };

  await assert.rejects(
    async () => transport.dispatchApprovalRequest(request, failingPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "PORT_DISPATCH_FAILED");
      return true;
    }
  );

  // Black-box verification: reservation was rolled back, so retrying the exact same
  // request with a functioning port succeeds without REPLAY_DETECTED.
  const functioningPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-wallet-retry",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "approved",
        approver: req.intent.fromAddress,
        recordedAt: 1770000020
      };
    }
  };

  const receipt = await transport.dispatchApprovalRequest(request, functioningPort);
  assert.equal(receipt.status, "approved");
});

test("WalletApprovalTransport black-box: valid response commits reservation, repeat dispatch fails closed", async () => {
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1000,
    nowEpochSeconds: () => 1770000010
  });
  const request = createValidRequest();

  const mockPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-wallet-commit",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "rejected",
        recordedAt: 1770000020
      };
    }
  };

  await transport.dispatchApprovalRequest(request, mockPort);

  // Black-box: repeat dispatch of committed request must fail closed
  await assert.rejects(
    async () => transport.dispatchApprovalRequest(request, mockPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "REPLAY_DETECTED");
      return true;
    }
  );
});

test("WalletApprovalTransport black-box: pending duplicate dispatch fails closed", async () => {
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1000,
    nowEpochSeconds: () => 1770000010
  });
  const request = createValidRequest();

  let finishDispatch!: (receipt: HumanApprovalV1) => void;
  const slowPort: WalletApprovalTransportPort = {
    sendApprovalRequest(req) {
      return new Promise((resolve) => {
        finishDispatch = (receipt) => resolve(receipt);
      });
    }
  };

  // Start in-flight dispatch
  const inFlightPromise = transport.dispatchApprovalRequest(request, slowPort);

  // Duplicate while in-flight must fail closed with REPLAY_DETECTED
  await assert.rejects(
    async () => transport.dispatchApprovalRequest(request, slowPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "REPLAY_DETECTED");
      return true;
    }
  );

  // Finish first dispatch
  finishDispatch({
    contractVersion: AGENTIC_CONTRACT_VERSION,
    kind: "human_approval",
    approvalId: "appr-slow-001",
    requestId: request.requestId,
    intentId: request.intent.intentId,
    decisionId: request.policyDecision.decisionId,
    status: "approved",
    approver: request.intent.fromAddress,
    recordedAt: 1770000020
  });

  const receipt = await inFlightPromise;
  assert.equal(receipt.status, "approved");
});

test("WalletApprovalTransport negative: policy decision tampering and expiration", () => {
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1000,
    nowEpochSeconds: () => 1770000010
  });

  // Empty trace ID: fails schema validation
  const emptyTrace = createValidRequest();
  (emptyTrace.policyDecision as any).policyTraceId = "";
  assert.throws(
    () => transport.validateOutboundRequest(emptyTrace),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "INVALID_REQUEST_SCHEMA");
      return true;
    }
  );

  // Expired request
  const expiredReq = createValidRequest();
  (expiredReq as any).expiresAt = 1770000005; // now is 1770000010
  assert.throws(
    () => transport.validateOutboundRequest(expiredReq),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "REQUEST_EXPIRED");
      return true;
    }
  );
});

test("Agents boundary assertion: Agents does not possess approval authority", () => {
  const transport = createWalletApprovalTransport();
  // Ensure that approval recording or generation does not exist on transport
  assert.equal((transport as any).recordHumanDecision, undefined);
  assert.equal((transport as any).processApprovalHandoff, undefined);
  assert.equal((transport as any).createHumanApproval, undefined);
  assert.equal((transport as any).ApprovalRecordCapability, undefined);
  assert.equal((transport as any).WalletLocalApprovalBinding, undefined);
});

test("Exact BigInt monetary formatting vectors without Number precision loss", () => {
  // Test vectors specified by program security gate:
  // 1
  assert.equal(formatSatsToExactXEC("1"), "0.01 XEC");
  // 99
  assert.equal(formatSatsToExactXEC("99"), "0.99 XEC");
  // 100
  assert.equal(formatSatsToExactXEC("100"), "1.00 XEC");
  // 5000
  assert.equal(formatSatsToExactXEC("5000"), "50.00 XEC");
  // Leading fraction zero
  assert.equal(formatSatsToExactXEC("105"), "1.05 XEC");
  assert.equal(formatSatsToExactXEC("1005"), "10.05 XEC");

  // Number.MAX_SAFE_INTEGER = 9007199254740991
  assert.equal(formatSatsToExactXEC("9007199254740991"), "90071992547409.91 XEC");
  // Number.MAX_SAFE_INTEGER + 1 = 9007199254740992 (loses precision in double float)
  assert.equal(formatSatsToExactXEC("9007199254740992"), "90071992547409.92 XEC");

  // Core Golden Vector B3: 40 digits
  const b3 = "1234567890123456789012345678901234567890";
  assert.equal(
    formatSatsToExactXEC(b3),
    "12345678901234567890123456789012345678.90 XEC"
  );
});

test("formatAuditDisplay displays byte-exact XEC amount even for huge integers", () => {
  const transport = createWalletApprovalTransport();
  const req = createValidRequest({
    intent: {
      ...BASE_VALID_INTENT,
      amountSats: "9007199254740992"
    }
  });

  const display = transport.formatAuditDisplay(req);
  assert.equal(display.amountSats, "9007199254740992");
  assert.equal(display.amountXEC, "90071992547409.92 XEC");
});

test("WalletApprovalTransport P2-1: Clock fail-closed on invalid nowEpochSeconds values", async () => {
  const invalidClockValues = [
    { label: "NaN", value: NaN },
    { label: "Infinity", value: Infinity },
    { label: "-Infinity", value: -Infinity },
    { label: "negative value", value: -1 },
    { label: "float", value: 1770000010.5 },
    { label: "Number.MAX_SAFE_INTEGER + 1", value: Number.MAX_SAFE_INTEGER + 1 }
  ];

  const validReq = createValidRequest();
  const dummyPort: WalletApprovalTransportPort = {
    async sendApprovalRequest() {
      throw new Error("Should not be called");
    }
  };

  for (const { label, value } of invalidClockValues) {
    const transport = createWalletApprovalTransport({
      killSwitch: false,
      monetaryLimitSats: 1000,
      nowEpochSeconds: () => value
    });

    // validateOutboundRequest must fail closed with INVALID_CLOCK
    assert.throws(
      () => transport.validateOutboundRequest(validReq),
      (err: unknown) => {
        assert.ok(err instanceof WalletApprovalTransportError, `Expected WalletApprovalTransportError for ${label}`);
        assert.equal(err.code, "INVALID_CLOCK", `Expected INVALID_CLOCK for ${label}, got ${err.code}`);
        return true;
      },
      `Should have thrown INVALID_CLOCK for clock=${label}`
    );

    // dispatchApprovalRequest must fail closed with INVALID_CLOCK
    await assert.rejects(
      async () => transport.dispatchApprovalRequest(validReq, dummyPort),
      (err: unknown) => {
        assert.ok(err instanceof WalletApprovalTransportError, `Expected WalletApprovalTransportError for ${label}`);
        assert.equal(err.code, "INVALID_CLOCK", `Expected INVALID_CLOCK for ${label}, got ${err.code}`);
        return true;
      },
      `Should have rejected with INVALID_CLOCK for clock=${label}`
    );
  }
});

test("WalletApprovalTransport P2-3: Replay retention bounded - replay before expiry blocked, expired entry purged", async () => {
  let currentClock = 1770000010;
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1000,
    nowEpochSeconds: () => currentClock
  });

  const request = createValidRequest({
    requestId: "req-p23-single",
    requestedAt: 1770000000,
    expiresAt: 1770000100
  });

  const mockPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-p23-single",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "approved",
        approver: req.intent.fromAddress,
        recordedAt: currentClock
      };
    }
  };

  // Initial dispatch succeeds and commits reservation
  const receipt = await transport.dispatchApprovalRequest(request, mockPort);
  assert.equal(receipt.status, "approved");
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 1 });

  // Replay before expiry (currentClock = 1770000050 < expiresAt = 1770000100) must be blocked
  currentClock = 1770000050;
  await assert.rejects(
    async () => transport.dispatchApprovalRequest(request, mockPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "REPLAY_DETECTED");
      return true;
    }
  );
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 1 });

  // Advance clock beyond expiry (currentClock = 1770000105 >= expiresAt = 1770000100)
  currentClock = 1770000105;
  const pruned = transport.pruneExpired();
  assert.equal(pruned, 1, "Expired entry should be pruned");
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 0 });
});

test("WalletApprovalTransport P2-3: Multiple expired entries are purged deterministically", async () => {
  let currentClock = 1770000010;
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 10000,
    nowEpochSeconds: () => currentClock
  });

  const makeReq = (id: string, exp: number) => {
    const intentId = `intent-multi-${id}-012345`;
    return createValidRequest({
      requestId: `req-multi-${id}`,
      intent: {
        ...BASE_VALID_INTENT,
        intentId,
        nonce: `nonce-multi-${id}-012345678901`,
        expiresAt: exp
      },
      policyDecision: {
        ...BASE_VALID_POLICY_DECISION,
        intentId,
        expiresAt: exp
      },
      requestedAt: 1770000000,
      expiresAt: exp
    });
  };

  const req1 = makeReq("1", 1770000100);
  const req2 = makeReq("2", 1770000200);
  const req3 = makeReq("3", 1770000300);

  const makePort = (id: string): WalletApprovalTransportPort => ({
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: `appr-${id}`,
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "approved",
        approver: req.intent.fromAddress,
        recordedAt: currentClock
      };
    }
  });

  await transport.dispatchApprovalRequest(req1, makePort("1"));
  await transport.dispatchApprovalRequest(req2, makePort("2"));
  await transport.dispatchApprovalRequest(req3, makePort("3"));

  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 3 });

  // Advance clock to 1770000250 (req1 and req2 are expired, req3 expires at 300)
  currentClock = 1770000250;
  const prunedFirst = transport.pruneExpired();
  assert.equal(prunedFirst, 2, "req1 and req2 should be pruned");
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 1 });

  // Advance clock to 1770000350 (req3 is expired)
  currentClock = 1770000350;
  const prunedSecond = transport.pruneExpired();
  assert.equal(prunedSecond, 1, "req3 should be pruned");
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 0 });
});

test("WalletApprovalTransport P2-3: Pending reservations are not purged while active", async () => {
  let currentClock = 1770000010;
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1000,
    nowEpochSeconds: () => currentClock
  });

  const request = createValidRequest({
    requestId: "req-p23-pending",
    requestedAt: 1770000000,
    expiresAt: 1770000100
  });

  let resolveDispatch!: (receipt: HumanApprovalV1) => void;
  const slowPort: WalletApprovalTransportPort = {
    sendApprovalRequest(req) {
      return new Promise((resolve) => {
        resolveDispatch = (receipt) => resolve(receipt);
      });
    }
  };

  const inFlightPromise = transport.dispatchApprovalRequest(request, slowPort);

  // While in flight, pending = 1, committed = 0
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 1, committed: 0 });

  // Advance clock and trigger pruning: pending reservation must NOT be purged
  currentClock = 1770000050;
  const pruned = transport.pruneExpired();
  assert.equal(pruned, 0);
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 1, committed: 0 });

  // Duplicate dispatch while pending must still be blocked
  await assert.rejects(
    async () => transport.dispatchApprovalRequest(request, slowPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "REPLAY_DETECTED");
      return true;
    }
  );

  // Complete in-flight dispatch
  resolveDispatch({
    contractVersion: AGENTIC_CONTRACT_VERSION,
    kind: "human_approval",
    approvalId: "appr-p23-pending-done",
    requestId: request.requestId,
    intentId: request.intent.intentId,
    decisionId: request.policyDecision.decisionId,
    status: "approved",
    approver: request.intent.fromAddress,
    recordedAt: currentClock
  });

  await inFlightPromise;
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 1 });
});

test("WalletApprovalTransport P2-3: Dispatch failure rolls back pending reservation cleanly", async () => {
  let currentClock = 1770000010;
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1000,
    nowEpochSeconds: () => currentClock
  });

  const request = createValidRequest({
    requestId: "req-p23-rollback",
    requestedAt: 1770000000,
    expiresAt: 1770000100
  });

  const failingPort: WalletApprovalTransportPort = {
    async sendApprovalRequest() {
      throw new Error("Simulated network/RPC error");
    }
  };

  await assert.rejects(
    async () => transport.dispatchApprovalRequest(request, failingPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "PORT_DISPATCH_FAILED");
      return true;
    }
  );

  // Pending reservation rolled back, committed is 0
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 0 });

  // Retry with working port succeeds
  const workingPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-p23-retry",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "approved",
        approver: req.intent.fromAddress,
        recordedAt: currentClock
      };
    }
  };

  const receipt = await transport.dispatchApprovalRequest(request, workingPort);
  assert.equal(receipt.status, "approved");
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 1 });
});

test("WalletApprovalTransport Gate 2A P2: canonical workflow window boundary enforcement", async () => {
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1000,
    nowEpochSeconds: () => 1770000010
  });

  // Base request values: requestedAt: 1770000002, expiresAt: 1770000300, intent.expiresAt: 1770000300, policyDecision.expiresAt: 1770000300

  // 1. recordedAt === intent.expiresAt (boundary: exactly at expiry cannot form canonical AgenticWorkflowV1)
  const reqExactIntentExpiry = createValidRequest({
    requestId: "req-p2-bound-001",
    intent: { ...BASE_VALID_INTENT, intentId: "intent-p2-bound-001", nonce: "cDItbm9uY2UtdmFsLTAwMDAwMDAwMDE" },
    policyDecision: { ...BASE_VALID_POLICY_DECISION, intentId: "intent-p2-bound-001" }
  });
  const exactIntentPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-p2-001",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "expired",
        recordedAt: req.intent.expiresAt // 1770000300
      };
    }
  };
  await assert.rejects(
    async () => transport.dispatchApprovalRequest(reqExactIntentExpiry, exactIntentPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "RESPONSE_OUTSIDE_WORKFLOW_WINDOW");
      return true;
    }
  );
  // Replay invariant: pending reservation rolled back, committed entry not created
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 0 });

  // 1b. Replay invariant: late-expired rejection did NOT burn requestId, intentId, or nonce.
  // Immediate retry of the same request with a valid in-window receipt must succeed and commit cleanly.
  const retryPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-p2-001-retry",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "approved",
        approver: req.intent.fromAddress,
        recordedAt: req.intent.expiresAt - 1 // 1770000299 (in-window)
      };
    }
  };
  const retryReceipt = await transport.dispatchApprovalRequest(reqExactIntentExpiry, retryPort);
  assert.equal(retryReceipt.status, "approved");
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 1 });

  // 2. recordedAt > intent.expiresAt
  const reqAfterIntentExpiry = createValidRequest({
    requestId: "req-p2-bound-002",
    intent: { ...BASE_VALID_INTENT, intentId: "intent-p2-bound-002", nonce: "cDItbm9uY2UtdmFsLTAwMDAwMDAwMDI" },
    policyDecision: { ...BASE_VALID_POLICY_DECISION, intentId: "intent-p2-bound-002" }
  });
  const afterIntentPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-p2-002",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "expired",
        recordedAt: req.intent.expiresAt + 1 // 1770000301
      };
    }
  };
  await assert.rejects(
    async () => transport.dispatchApprovalRequest(reqAfterIntentExpiry, afterIntentPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "RESPONSE_OUTSIDE_WORKFLOW_WINDOW");
      return true;
    }
  );
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 1 });

  // 3. recordedAt === policyDecision.expiresAt (when policyDecision.expiresAt is earlier than intent.expiresAt)
  const reqPolicyExpiry = createValidRequest({
    requestId: "req-p2-bound-003",
    intent: { ...BASE_VALID_INTENT, intentId: "intent-p2-bound-003", nonce: "cDItbm9uY2UtdmFsLTAwMDAwMDAwMDM", expiresAt: 1770000500 },
    policyDecision: { ...BASE_VALID_POLICY_DECISION, intentId: "intent-p2-bound-003", expiresAt: 1770000250 },
    expiresAt: 1770000250
  });
  const exactPolicyPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-p2-003",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "expired",
        recordedAt: req.policyDecision.expiresAt // 1770000250 (recordedAt === policyDecision.expiresAt < intent.expiresAt)
      };
    }
  };
  await assert.rejects(
    async () => transport.dispatchApprovalRequest(reqPolicyExpiry, exactPolicyPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "RESPONSE_OUTSIDE_WORKFLOW_WINDOW");
      return true;
    }
  );
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 1 });

  // 4. Late-expired receipt: status === "expired" and recordedAt well beyond boundary
  const reqLateExpired = createValidRequest({
    requestId: "req-p2-bound-004",
    intent: { ...BASE_VALID_INTENT, intentId: "intent-p2-bound-004", nonce: "cDItbm9uY2UtdmFsLTAwMDAwMDAwMDQ" },
    policyDecision: { ...BASE_VALID_POLICY_DECISION, intentId: "intent-p2-bound-004" }
  });
  const lateExpiredPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-p2-004",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "expired",
        recordedAt: 1770000450 // > 1770000300
      };
    }
  };
  await assert.rejects(
    async () => transport.dispatchApprovalRequest(reqLateExpired, lateExpiredPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "RESPONSE_OUTSIDE_WORKFLOW_WINDOW");
      return true;
    }
  );
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 1 });

  // 5. Valid approved receipt just before the boundary (expiry - 1) to avoid an off-by-one
  const reqValidApprovedBeforeLimit = createValidRequest({
    requestId: "req-p2-bound-005",
    intent: { ...BASE_VALID_INTENT, intentId: "intent-p2-bound-005", nonce: "cDItbm9uY2UtdmFsLTAwMDAwMDAwMDU", expiresAt: 1770000300 },
    policyDecision: { ...BASE_VALID_POLICY_DECISION, intentId: "intent-p2-bound-005", expiresAt: 1770000300 },
    expiresAt: 1770000300
  });
  const validApprovedPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-p2-005",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "approved",
        approver: req.intent.fromAddress,
        recordedAt: req.intent.expiresAt - 1 // 1770000299 (expiry - 1)
      };
    }
  };
  const validApprovedReceipt = await transport.dispatchApprovalRequest(
    reqValidApprovedBeforeLimit,
    validApprovedPort
  );
  assert.equal(validApprovedReceipt.status, "approved");
  assert.equal(validApprovedReceipt.recordedAt, 1770000299);
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 2 });

  // 6. Valid expired receipt just before the boundary (expiry - 1):
  // When request.expiresAt < intent.expiresAt (e.g. 200 vs 300), receipt recordedAt 299 is expired relative to request,
  // but strictly before intent.expiresAt (300), so it is representable by Core agenticWorkflowV1Schema
  const reqValidExpiredBeforeLimit = createValidRequest({
    requestId: "req-p2-bound-006",
    intent: { ...BASE_VALID_INTENT, intentId: "intent-p2-bound-006", nonce: "cDItbm9uY2UtdmFsLTAwMDAwMDAwMDY", expiresAt: 1770000300 },
    policyDecision: { ...BASE_VALID_POLICY_DECISION, intentId: "intent-p2-bound-006", expiresAt: 1770000300 },
    expiresAt: 1770000200
  });
  const validExpiredPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-p2-006",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "expired",
        recordedAt: req.intent.expiresAt - 1 // 1770000299 (expiry - 1)
      };
    }
  };
  const validExpiredReceipt = await transport.dispatchApprovalRequest(
    reqValidExpiredBeforeLimit,
    validExpiredPort
  );
  assert.equal(validExpiredReceipt.status, "expired");
  assert.equal(validExpiredReceipt.recordedAt, 1770000299);
  assert.deepEqual(transport.getReplayCacheStats(), { pending: 0, committed: 3 });
});



