process.env.CHRONIK_URL = "http://127.0.0.1:1";
process.env.CAE_PREFLIGHT_URL = "http://127.0.0.1:1";
process.env.CAE_REQUEST_TIMEOUT_MS = "100";
process.env.AGENT_ID = "test-agent";
process.env.AGENT_ROLE = "test";
process.env.AGENT_WALLET = "ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2";
process.env.AGENT_DAILY_LIMIT_SATS = "1000000";
process.env.AGENT_INTENT_TTL_SECONDS = "300";
process.env.TONALLI_SIMULATION = "true";

import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENTIC_CONTRACT_VERSION,
  type CaePolicyDecisionV1,
  type HumanApprovalV1,
  type WalletApprovalRequestV1
} from "@xolosarmy/tonalli-core";
import type { WalletApprovalTransportPort } from "../src/wallet/approvalTransport";

const FROM_ADDRESS = "ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2";
const TO_ADDRESS = "ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5";
const SIMULATION_NOW = 1_800_000_000;
const SIMULATION_EXPIRES_AT = 1_800_000_300;

function createNeedsApprovalPolicyDecision(intentId: string): CaePolicyDecisionV1 {
  return {
    contractVersion: AGENTIC_CONTRACT_VERSION,
    kind: "cae_policy_decision",
    decisionId: "cae-dec-approval-test",
    intentId,
    decision: "needs_human_approval",
    reasonCode: "POLICY_HUMAN_REVIEW_REQUIRED",
    reason: "Amount requires explicit human confirmation",
    policyTraceId: "cae-trace-approval-test-001",
    policyVersion: "constitution-2026-v1.0",
    evaluatedAt: SIMULATION_NOW,
    expiresAt: SIMULATION_EXPIRES_AT
  };
}

function createLocalContractualMockPort(
  status: "approved" | "rejected" | "expired"
) {
  return {
    async sendApprovalRequest(request: WalletApprovalRequestV1): Promise<HumanApprovalV1> {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: `mock-appr-${request.requestId}`,
        requestId: request.requestId,
        intentId: request.intent.intentId,
        decisionId: request.policyDecision.decisionId,
        status,
        ...(status === "approved" ? { approver: request.intent.fromAddress } : {}),
        ...(status === "rejected" ? { reason: "Operator denied transfer" } : {}),
        recordedAt: SIMULATION_NOW + 5
      };
    }
  };
}

test("Gate 2A Test 1: Port without transport fails closed with MISSING_WALLET_TRANSPORT", async () => {
  const { safeSendXEC } = await import("../src/wallet/safeSendXEC");
  const mockPort = createLocalContractualMockPort("approved");

  await assert.rejects(
    async () => {
      await safeSendXEC(
        {
          toAddress: TO_ADDRESS,
          amountSats: 50_000,
          reason: "No transport test"
        },
        {
          fromAddress: FROM_ADDRESS,
          now: () => SIMULATION_NOW,
          randomId: () => "req-no-transport-001",
          randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
          requestPolicy: async (candidate) =>
            createNeedsApprovalPolicyDecision(candidate.intentId),
          walletApprovalPort: mockPort
          // walletTransport intentionally omitted
        }
      );
    },
    (err: any) => {
      assert.equal(err.name, "WalletApprovalTransportError");
      assert.equal(err.code, "MISSING_WALLET_TRANSPORT");
      return true;
    }
  );
});

test("Gate 2A Test 2: Default transport blocks request via KILL_SWITCH_ACTIVE", async () => {
  const { safeSendXEC } = await import("../src/wallet/safeSendXEC");
  const { createWalletApprovalTransport } = await import("../src/wallet/approvalTransport");
  const mockPort = createLocalContractualMockPort("approved");
  const defaultTransport = createWalletApprovalTransport(); // killSwitch: true by default

  await assert.rejects(
    async () => {
      await safeSendXEC(
        {
          toAddress: TO_ADDRESS,
          amountSats: 50_000,
          reason: "Kill-switch default test"
        },
        {
          fromAddress: FROM_ADDRESS,
          now: () => SIMULATION_NOW,
          randomId: () => "req-kill-switch-001",
          randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
          requestPolicy: async (candidate) =>
            createNeedsApprovalPolicyDecision(candidate.intentId),
          walletApprovalPort: mockPort,
          walletTransport: defaultTransport
        }
      );
    },
    (err: any) => {
      assert.equal(err.name, "WalletApprovalTransportError");
      assert.equal(err.code, "KILL_SWITCH_ACTIVE");
      return true;
    }
  );
});

test("Gate 2A Test 3: Default monetary limit (0) rejects non-zero amount with MONETARY_LIMIT_EXCEEDED", async () => {
  const { safeSendXEC } = await import("../src/wallet/safeSendXEC");
  const { createWalletApprovalTransport } = await import("../src/wallet/approvalTransport");
  const mockPort = createLocalContractualMockPort("approved");
  // killSwitch disabled for test, but monetary limit left at default 0
  const zeroLimitTransport = createWalletApprovalTransport({
    killSwitch: false,
    nowEpochSeconds: () => SIMULATION_NOW
  });

  await assert.rejects(
    async () => {
      await safeSendXEC(
        {
          toAddress: TO_ADDRESS,
          amountSats: 50_000,
          reason: "Zero limit test"
        },
        {
          fromAddress: FROM_ADDRESS,
          now: () => SIMULATION_NOW,
          randomId: () => "req-zero-limit-001",
          randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
          requestPolicy: async (candidate) =>
            createNeedsApprovalPolicyDecision(candidate.intentId),
          walletApprovalPort: mockPort,
          walletTransport: zeroLimitTransport
        }
      );
    },
    (err: any) => {
      assert.equal(err.name, "WalletApprovalTransportError");
      assert.equal(err.code, "MONETARY_LIMIT_EXCEEDED");
      return true;
    }
  );
});

test("Gate 2A Test 4: Explicit test composition allows simulation and records human approval receipt", async () => {
  const { safeSendXEC } = await import("../src/wallet/safeSendXEC");
  const { createWalletApprovalTransport } = await import("../src/wallet/approvalTransport");
  const mockPort = createLocalContractualMockPort("approved");
  const simulationTransport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1_000_000,
    nowEpochSeconds: () => SIMULATION_NOW
  });

  const result = await safeSendXEC(
    {
      toAddress: TO_ADDRESS,
      amountSats: 50_000,
      reason: "Simulated payment"
    },
    {
      fromAddress: FROM_ADDRESS,
      now: () => SIMULATION_NOW,
      randomId: () => "req-sim-001",
      randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
      requestPolicy: async (candidate) =>
        createNeedsApprovalPolicyDecision(candidate.intentId),
      walletApprovalPort: mockPort,
      walletTransport: simulationTransport
    }
  );

  // Semantics: human approval is recorded as an audit receipt
  assert.equal(result.status, "human_approval_recorded");
  assert.equal(result.simulation, true);
  assert.ok(result.humanApproval);
  assert.equal(result.humanApproval.status, "approved");
  assert.equal(result.humanApproval.approver, FROM_ADDRESS);

  // Signing, broadcast, confirmation MUST remain strictly not_attempted
  assert.equal(result.workflow.signedTransaction?.status, "not_attempted");
  assert.equal(result.workflow.broadcast?.status, "not_attempted");
  assert.equal(result.workflow.confirmation?.status, "not_attempted");
});

test("Gate 2A Post-decision Semantics: Terminal rejection produces terminal rejected status", async () => {
  const { safeSendXEC } = await import("../src/wallet/safeSendXEC");
  const { createWalletApprovalTransport } = await import("../src/wallet/approvalTransport");
  const mockRejectPort = createLocalContractualMockPort("rejected");
  const simulationTransport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1_000_000,
    nowEpochSeconds: () => SIMULATION_NOW
  });

  const result = await safeSendXEC(
    {
      toAddress: TO_ADDRESS,
      amountSats: 50_000,
      reason: "Rejected payment simulation"
    },
    {
      fromAddress: FROM_ADDRESS,
      now: () => SIMULATION_NOW,
      randomId: () => "req-reject-001",
      randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
      requestPolicy: async (candidate) =>
        createNeedsApprovalPolicyDecision(candidate.intentId),
      walletApprovalPort: mockRejectPort,
      walletTransport: simulationTransport
    }
  );

  // Semantics: rejected is terminal
  assert.equal(result.status, "rejected");
  assert.equal(result.simulation, true);
  assert.ok(result.humanApproval);
  assert.equal(result.humanApproval.status, "rejected");
  assert.equal(result.humanApproval.reason, "Operator denied transfer");

  assert.equal(result.workflow.signedTransaction?.status, "not_attempted");
  assert.equal(result.workflow.broadcast?.status, "not_attempted");
  assert.equal(result.workflow.confirmation?.status, "not_attempted");
});

test("Gate 2A Post-decision Semantics: Terminal expiration produces terminal expired status", async () => {
  const { safeSendXEC } = await import("../src/wallet/safeSendXEC");
  const { createWalletApprovalTransport } = await import("../src/wallet/approvalTransport");
  const mockExpirePort = createLocalContractualMockPort("expired");
  const simulationTransport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1_000_000,
    nowEpochSeconds: () => SIMULATION_NOW
  });

  const result = await safeSendXEC(
    {
      toAddress: TO_ADDRESS,
      amountSats: 50_000,
      reason: "Expired payment simulation"
    },
    {
      fromAddress: FROM_ADDRESS,
      now: () => SIMULATION_NOW,
      randomId: () => "req-expire-001",
      randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
      requestPolicy: async (candidate) =>
        createNeedsApprovalPolicyDecision(candidate.intentId),
      walletApprovalPort: mockExpirePort,
      walletTransport: simulationTransport
    }
  );

  assert.equal(result.status, "expired");
  assert.equal(result.simulation, true);
  assert.ok(result.humanApproval);
  assert.equal(result.humanApproval.status, "expired");

  assert.equal(result.workflow.signedTransaction?.status, "not_attempted");
  assert.equal(result.workflow.broadcast?.status, "not_attempted");
  assert.equal(result.workflow.confirmation?.status, "not_attempted");
});

test("Gate 2A Post-decision Semantics: Pending human action (no port) produces needs_human_approval", async () => {
  const { safeSendXEC } = await import("../src/wallet/safeSendXEC");
  const result = await safeSendXEC(
    {
      toAddress: TO_ADDRESS,
      amountSats: 50_000,
      reason: "Pending action simulation"
    },
    {
      fromAddress: FROM_ADDRESS,
      now: () => SIMULATION_NOW,
      randomId: () => "req-pending-001",
      randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
      requestPolicy: async (candidate) =>
        createNeedsApprovalPolicyDecision(candidate.intentId)
      // No port provided: awaiting human review
    }
  );

  assert.equal(result.status, "needs_human_approval");
  assert.equal(result.simulation, true);
  assert.equal("humanApproval" in result, false);

  assert.equal(result.workflow.signedTransaction?.status, "not_attempted");
  assert.equal(result.workflow.broadcast?.status, "not_attempted");
  assert.equal(result.workflow.confirmation?.status, "not_attempted");
});

test("Gate 2A P2-2: Event ordering - POLICY_NEEDS_HUMAN_APPROVAL is emitted before awaiting wallet port", async () => {
  const { safeSendXEC } = await import("../src/wallet/safeSendXEC");
  const { createWalletApprovalTransport } = await import("../src/wallet/approvalTransport");
  const { onEvent, Topics } = await import("../src/events/bus");

  let eventEmittedBeforePortResolve = false;
  let eventPayload: any = null;

  onEvent(Topics.POLICY_NEEDS_HUMAN_APPROVAL, (payload: any) => {
    eventPayload = payload;
  });

  let resolvePort!: (receipt: HumanApprovalV1) => void;
  const slowPort = {
    sendApprovalRequest(request: WalletApprovalRequestV1): Promise<HumanApprovalV1> {
      // At this moment, POLICY_NEEDS_HUMAN_APPROVAL must already have been emitted!
      eventEmittedBeforePortResolve = eventPayload !== null && eventPayload.requestId === request.requestId;
      return new Promise((resolve) => {
        resolvePort = () => {
          resolve({
            contractVersion: AGENTIC_CONTRACT_VERSION,
            kind: "human_approval",
            approvalId: `appr-order-${request.requestId}`,
            requestId: request.requestId,
            intentId: request.intent.intentId,
            decisionId: request.policyDecision.decisionId,
            status: "approved",
            approver: request.intent.fromAddress,
            recordedAt: SIMULATION_NOW + 10
          });
        };
      });
    }
  };

  const simulationTransport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1_000_000,
    nowEpochSeconds: () => SIMULATION_NOW
  });

  const sendPromise = safeSendXEC(
    {
      toAddress: TO_ADDRESS,
      amountSats: 50_000,
      reason: "Event ordering test"
    },
    {
      fromAddress: FROM_ADDRESS,
      now: () => SIMULATION_NOW,
      randomId: () => "req-order-001",
      randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
      requestPolicy: async (candidate) =>
        createNeedsApprovalPolicyDecision(candidate.intentId),
      walletApprovalPort: slowPort,
      walletTransport: simulationTransport
    }
  );

  // Yield to allow event loop to run up to the port await
  await new Promise((r) => setTimeout(r, 10));

  // Verify that the event was emitted while port is still pending
  assert.ok(eventPayload, "POLICY_NEEDS_HUMAN_APPROVAL must be emitted while awaiting port");
  assert.equal(eventPayload.requestId, "wallet-request:req-order-001");
  assert.equal(eventEmittedBeforePortResolve, true, "Port observed event emission prior to resolving");

  // Now resolve the port
  resolvePort(null as any);
  const result = await sendPromise;
  assert.equal(result.status, "human_approval_recorded");
});

test("Gate 2A P2-2: Error classification - transport failures emit WALLET_APPROVAL_TRANSPORT_FAILED, not POLICY_REJECTED", async () => {
  const { safeSendXEC } = await import("../src/wallet/safeSendXEC");
  const { createWalletApprovalTransport } = await import("../src/wallet/approvalTransport");
  const { onEvent, Topics } = await import("../src/events/bus");

  const emittedEvents: Array<{ topic: string; payload: any }> = [];
  onEvent(Topics.POLICY_REJECTED, (payload) => {
    emittedEvents.push({ topic: Topics.POLICY_REJECTED, payload });
  });
  onEvent(Topics.WALLET_APPROVAL_TRANSPORT_FAILED, (payload) => {
    emittedEvents.push({ topic: Topics.WALLET_APPROVAL_TRANSPORT_FAILED, payload });
  });

  const failingPort = {
    async sendApprovalRequest(): Promise<HumanApprovalV1> {
      throw new Error("Port RPC connection refused");
    }
  };

  const simulationTransport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1_000_000,
    nowEpochSeconds: () => SIMULATION_NOW
  });

  // Test 1: Port dispatch failure throws WalletApprovalTransportError
  emittedEvents.length = 0;
  await assert.rejects(
    async () => {
      await safeSendXEC(
        {
          toAddress: TO_ADDRESS,
          amountSats: 50_000,
          reason: "Transport error test"
        },
        {
          fromAddress: FROM_ADDRESS,
          now: () => SIMULATION_NOW,
          randomId: () => "req-fail-001",
          randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
          requestPolicy: async (candidate) =>
            createNeedsApprovalPolicyDecision(candidate.intentId),
          walletApprovalPort: failingPort,
          walletTransport: simulationTransport
        }
      );
    },
    (err: any) => {
      assert.equal(err.name, "WalletApprovalTransportError");
      assert.equal(err.code, "PORT_DISPATCH_FAILED");
      return true;
    }
  );

  // Must have emitted WALLET_APPROVAL_TRANSPORT_FAILED, and NOT POLICY_REJECTED
  assert.equal(
    emittedEvents.some((e) => e.topic === Topics.WALLET_APPROVAL_TRANSPORT_FAILED),
    true,
    "Must emit WALLET_APPROVAL_TRANSPORT_FAILED"
  );
  assert.equal(
    emittedEvents.some((e) => e.topic === Topics.POLICY_REJECTED),
    false,
    "Must NOT emit POLICY_REJECTED on transport failure"
  );

  // Test 2: Missing transport throws WalletApprovalTransportError
  emittedEvents.length = 0;
  await assert.rejects(
    async () => {
      await safeSendXEC(
        {
          toAddress: TO_ADDRESS,
          amountSats: 50_000,
          reason: "Missing transport test"
        },
        {
          fromAddress: FROM_ADDRESS,
          now: () => SIMULATION_NOW,
          randomId: () => "req-fail-002",
          randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
          requestPolicy: async (candidate) =>
            createNeedsApprovalPolicyDecision(candidate.intentId),
          walletApprovalPort: failingPort
          // walletTransport missing
        }
      );
    },
    (err: any) => {
      assert.equal(err.name, "WalletApprovalTransportError");
      assert.equal(err.code, "MISSING_WALLET_TRANSPORT");
      return true;
    }
  );

  assert.equal(
    emittedEvents.some((e) => e.topic === Topics.WALLET_APPROVAL_TRANSPORT_FAILED),
    true,
    "Must emit WALLET_APPROVAL_TRANSPORT_FAILED for missing transport"
  );
  assert.equal(
    emittedEvents.some((e) => e.topic === Topics.POLICY_REJECTED),
    false,
    "Must NOT emit POLICY_REJECTED on missing transport"
  );

  // Test 3: CAE rejection emits POLICY_REJECTED, not WALLET_APPROVAL_TRANSPORT_FAILED
  emittedEvents.length = 0;
  const rejectedResult = await safeSendXEC(
    {
      toAddress: TO_ADDRESS,
      amountSats: 50_000,
      reason: "CAE rejection test"
    },
    {
      fromAddress: FROM_ADDRESS,
      now: () => SIMULATION_NOW,
      randomId: () => "req-fail-003",
      randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
      requestPolicy: async (candidate) => ({
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "cae_policy_decision",
        decisionId: "cae-dec-reject-001",
        intentId: candidate.intentId,
        decision: "rejected",
        reasonCode: "POLICY_SANCTIONED_DESTINATION",
        reason: "Destination is prohibited by policy",
        policyTraceId: "cae-trace-reject-001",
        policyVersion: "constitution-2026-v1.0",
        evaluatedAt: SIMULATION_NOW,
        expiresAt: SIMULATION_EXPIRES_AT
      })
    }
  );
  assert.equal(rejectedResult.status, "rejected");
  assert.equal(
    emittedEvents.some((e) => e.topic === Topics.POLICY_REJECTED),
    true,
    "Must emit POLICY_REJECTED for CAE policy rejection"
  );
  assert.equal(
    emittedEvents.some((e) => e.topic === Topics.WALLET_APPROVAL_TRANSPORT_FAILED),
    false,
    "Must NOT emit WALLET_APPROVAL_TRANSPORT_FAILED on CAE policy rejection"
  );

  // Test 4: Human rejection does NOT emit POLICY_REJECTED
  emittedEvents.length = 0;
  const mockRejectPort = createLocalContractualMockPort("rejected");
  const humanRejectResult = await safeSendXEC(
    {
      toAddress: TO_ADDRESS,
      amountSats: 50_000,
      reason: "Human rejection test"
    },
    {
      fromAddress: FROM_ADDRESS,
      now: () => SIMULATION_NOW,
      randomId: () => "req-fail-004",
      randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
      requestPolicy: async (candidate) =>
        createNeedsApprovalPolicyDecision(candidate.intentId),
      walletApprovalPort: mockRejectPort,
      walletTransport: simulationTransport
    }
  );
  assert.equal(humanRejectResult.status, "rejected");
  assert.equal(humanRejectResult.humanApproval?.status, "rejected");
  assert.equal(
    emittedEvents.some((e) => e.topic === Topics.POLICY_REJECTED),
    false,
    "Human rejection must NOT emit POLICY_REJECTED (it is recorded human rejection, not CAE rejection)"
  );
});

test("Gate 2A P2: Late-expired HumanApproval receipt seam - fail-closed before commitReservation", async () => {
  const { safeSendXEC } = await import("../src/wallet/safeSendXEC");
  const {
    createWalletApprovalTransport,
    WalletApprovalTransportError
  } = await import("../src/wallet/approvalTransport");
  const { onEvent, Topics } = await import("../src/events/bus");

  const emittedEvents: Array<{ topic: string; payload: unknown }> = [];
  onEvent(Topics.WALLET_APPROVAL_TRANSPORT_FAILED, (payload) => {
    emittedEvents.push({ topic: Topics.WALLET_APPROVAL_TRANSPORT_FAILED, payload });
  });
  onEvent(Topics.POLICY_REJECTED, (payload) => {
    emittedEvents.push({ topic: Topics.POLICY_REJECTED, payload });
  });
  onEvent(Topics.POLICY_NEEDS_HUMAN_APPROVAL, (payload) => {
    emittedEvents.push({ topic: Topics.POLICY_NEEDS_HUMAN_APPROVAL, payload });
  });

  const customTransport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1_000_000,
    nowEpochSeconds: () => SIMULATION_NOW
  });

  // Mock port that returns a late-expired HumanApprovalV1 receipt (status: "expired", recordedAt: SIMULATION_EXPIRES_AT)
  // where recordedAt is at the intent/policy expiry boundary
  const lateExpiredPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-late-expired-001",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "expired",
        recordedAt: req.intent.expiresAt // recordedAt === intent.expiresAt (late-expired boundary)
      };
    }
  };

  emittedEvents.length = 0;

  // 1. CAE returns needs_human_approval
  // 2. safeSendXEC creates WalletApprovalRequest
  // 3. Wallet returns HumanApprovalV1 with status: "expired"
  // 4. recordedAt is set at or after intent/policy expiry
  // 5. Operation must fail with WalletApprovalTransportError
  await assert.rejects(
    async () => {
      await safeSendXEC(
        {
          toAddress: TO_ADDRESS,
          amountSats: 50_000,
          reason: "Late-expired receipt reproduction test"
        },
        {
          fromAddress: FROM_ADDRESS,
          now: () => SIMULATION_NOW,
          randomId: () => "req-late-exp-001",
          randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
          requestPolicy: async (candidate) =>
            createNeedsApprovalPolicyDecision(candidate.intentId),
          walletApprovalPort: lateExpiredPort,
          walletTransport: customTransport
        }
      );
    },
    (err: unknown) => {
      assert.ok(
        err instanceof WalletApprovalTransportError ||
        (err instanceof Error && err.name === "WalletApprovalTransportError"),
        "Must be a WalletApprovalTransportError"
      );
      assert.equal((err as any).code, "RESPONSE_OUTSIDE_WORKFLOW_WINDOW");
      return true;
    }
  );

  // 6. Must emit WALLET_APPROVAL_TRANSPORT_FAILED
  const transportFailedEvent = emittedEvents.find(
    (e) => e.topic === Topics.WALLET_APPROVAL_TRANSPORT_FAILED
  );
  assert.ok(transportFailedEvent, "Must emit WALLET_APPROVAL_TRANSPORT_FAILED");
  assert.equal((transportFailedEvent.payload as any)?.code, "RESPONSE_OUTSIDE_WORKFLOW_WINDOW");

  // 7. Must NOT emit POLICY_REJECTED
  assert.equal(
    emittedEvents.some((e) => e.topic === Topics.POLICY_REJECTED),
    false,
    "Must NOT emit POLICY_REJECTED on late-expired receipt transport error"
  );

  // 8. Replay state must have rolled back and not committed: pending=0, committed=0
  const replayStats = customTransport.getReplayCacheStats();
  assert.equal(replayStats.pending, 0, "Pending reservations must be 0 after rollback");
  assert.equal(replayStats.committed, 0, "Committed entries must be 0 (must not commit invalid receipt)");

  // 9. Replay invariant: request was NOT burned. A subsequent dispatch with valid in-window receipt succeeds
  const validInWindowPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(req) {
      return {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "human_approval",
        approvalId: "appr-valid-retry-001",
        requestId: req.requestId,
        intentId: req.intent.intentId,
        decisionId: req.policyDecision.decisionId,
        status: "approved",
        approver: req.intent.fromAddress,
        recordedAt: req.intent.expiresAt - 1 // strictly before expiry
      };
    }
  };

  const retryResult = await safeSendXEC(
    {
      toAddress: TO_ADDRESS,
      amountSats: 50_000,
      reason: "Retry after late-expired rollback"
    },
    {
      fromAddress: FROM_ADDRESS,
      now: () => SIMULATION_NOW,
      randomId: () => "req-late-exp-001", // same requestId
      randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg", // same nonce
      requestPolicy: async (candidate) =>
        createNeedsApprovalPolicyDecision(candidate.intentId),
      walletApprovalPort: validInWindowPort,
      walletTransport: customTransport
    }
  );

  assert.equal(retryResult.status, "human_approval_recorded");
  const finalReplayStats = customTransport.getReplayCacheStats();
  assert.equal(finalReplayStats.pending, 0);
  assert.equal(finalReplayStats.committed, 1, "Successful retry now commits reservation");
});


