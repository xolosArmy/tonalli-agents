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
        approver: "human-custodian-primary",
        recordedAt: 1770000020
      };
    }
  };

  const humanApproval = await transport.dispatchApprovalRequest(request, mockWalletPort);
  assert.equal(humanApproval.kind, "human_approval");
  assert.equal(humanApproval.status, "approved");
  assert.equal(humanApproval.approvalId, "appr-wallet-001");
  assert.equal(transport._internal.getCommittedCount(), 1);
});

test("WalletApprovalTransport negative: Wallet response with mismatched requestId is rejected", async () => {
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
        approver: "human-custodian",
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
  // Reservation should have been rolled back
  assert.equal(transport._internal.getPendingCount(), 0);
});

test("WalletApprovalTransport negative: Wallet response recorded after expiry without expired status is rejected", async () => {
  const transport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1000,
    nowEpochSeconds: () => 1770000010
  });
  const request = createValidRequest();

  const mockLatePort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-wallet-001",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "approved",
        approver: "human-custodian",
        recordedAt: 1770000999 // well past expiresAt (1770000300)
      };
    }
  };

  await assert.rejects(
    async () => transport.dispatchApprovalRequest(request, mockLatePort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "RESPONSE_EXPIRED_MISMATCH");
      return true;
    }
  );
  assert.equal(transport._internal.getPendingCount(), 0);
});

test("WalletApprovalTransport port failure triggers reservation rollback", async () => {
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
  // Reservation rolled back: can attempt again
  assert.equal(transport._internal.getPendingCount(), 0);
});

test("WalletApprovalTransport negative: process-local replay rejection", async () => {
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
        approvalId: "appr-wallet-001",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "rejected",
        recordedAt: 1770000020
      };
    }
  };

  await transport.dispatchApprovalRequest(request, mockPort);

  // Attempt to replay the same request in the same process
  await assert.rejects(
    async () => transport.dispatchApprovalRequest(request, mockPort),
    (err: unknown) => {
      assert.ok(err instanceof WalletApprovalTransportError);
      assert.equal(err.code, "REPLAY_DETECTED");
      return true;
    }
  );
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

