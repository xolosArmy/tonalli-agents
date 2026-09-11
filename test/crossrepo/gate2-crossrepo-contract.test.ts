/**
 * @file gate2-crossrepo-contract.test.ts
 *
 * CROSS-REPO CONTRACT HARNESS (Gate 2A + Gate 2B)
 *
 * Topology:
 * safeSendXEC -> transport port -> wallet receiver -> presentation snapshot ->
 * human decision -> ledger -> HumanApprovalV1 audit receipt -> safeSendXEC workflow.
 *
 * Governance & Security Boundary Classification:
 * ⚠️ THIS IS A SCHEMA-ONLY MAINNET-SHAPED CONTRACT SIMULATION WITHOUT FINANCIAL AUTHORITY.
 * Core Network Domain v1.1 is in REVIEW; REGTEST network domain is BLOCKED_BY_CORE_NETWORK_DOMAIN.
 *
 * Kill-switch and Limits Disclosure:
 * In production/default state, killSwitch=true and monetaryLimitSats=0 enforce complete freeze.
 * For this controlled pipeline simulation test, killSwitch=false and an explicit monetary limit
 * are injected through a preconfigured transport solely to verify pipeline mechanics.
 * Zero signing, zero keys, zero broadcast.
 */

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
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createWalletApprovalTransport,
  type WalletApprovalTransportPort
} from "../../src/wallet/approvalTransport.js";
import type {
  CaePolicyDecisionV1,
  WalletApprovalRequestV1
} from "@xolosarmy/tonalli-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.RMZ_WALLET_ROOT) {
  throw new Error(
    "RMZ_WALLET_ROOT environment variable is required to execute the cross-repo contract harness. " +
    "Implicit workspace sibling directory fallback is strictly prohibited."
  );
}
const RMZ_WALLET_ROOT = path.resolve(process.env.RMZ_WALLET_ROOT);

async function loadPipelineModules() {
  const encoderUrl = pathToFileURL(
    path.join(RMZ_WALLET_ROOT, "src/features/agentWalletHandoff/encoder.ts")
  ).href;
  const receiverUrl = pathToFileURL(
    path.join(RMZ_WALLET_ROOT, "src/features/agentWalletApprovalReceiver/receiver.ts")
  ).href;
  const testUtilsUrl = pathToFileURL(
    path.join(RMZ_WALLET_ROOT, "src/features/agentWalletApprovalReceiver/testUtils.ts")
  ).href;

  const { encodeAgentWalletHandoffV1 } = await import(encoderUrl);
  const { createAgentWalletApprovalReceiver } = await import(receiverUrl);
  const { InMemoryWalletApprovalLedger, createMockSessionVerifier } = await import(testUtilsUrl);
  const { safeSendXEC } = await import("../../src/wallet/safeSendXEC.js");

  return {
    encodeAgentWalletHandoffV1,
    createAgentWalletApprovalReceiver,
    InMemoryWalletApprovalLedger,
    createMockSessionVerifier,
    safeSendXEC
  };
}

const FROM_ADDRESS = "ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2";
const TO_ADDRESS = "ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5";
const SIMULATION_NOW = 1_800_000_000;
const SIMULATION_EXPIRES_AT = 1_800_000_300;

function createApprovedPolicyDecisionFixture(intentId: string): CaePolicyDecisionV1 {
  return {
    contractVersion: "1.0",
    kind: "cae_policy_decision",
    decisionId: "cae-dec-integrated-001",
    intentId,
    decision: "needs_human_approval",
    reasonCode: "POLICY_HUMAN_REVIEW_REQUIRED",
    reason: "Amount exceeds autonomous execution threshold",
    policyTraceId: "cae-trace-integrated-777",
    policyVersion: "vcae-v1.0.0",
    evaluatedAt: SIMULATION_NOW,
    expiresAt: SIMULATION_EXPIRES_AT
  };
}

test("Cross-Repo Contract Harness: safeSendXEC -> transport port -> wallet receiver -> human approval -> ledger -> audit receipt", async () => {
  const {
    encodeAgentWalletHandoffV1,
    createAgentWalletApprovalReceiver,
    InMemoryWalletApprovalLedger,
    createMockSessionVerifier,
    safeSendXEC
  } = await loadPipelineModules();

  // 1. Initialize Wallet domain components
  const ledger = new InMemoryWalletApprovalLedger();
  const sessionVerifier = createMockSessionVerifier(FROM_ADDRESS, true);
  let idCounter = 1;
  const idGenerator = () => `auto_id_${idCounter++}`;
  const clock = () => SIMULATION_NOW + 10; // 10 seconds into review

  const walletReceiver = createAgentWalletApprovalReceiver({
    ledger,
    sessionVerifier,
    clock,
    idGenerator,
    declaredOrigin: "https://app.tonalli.cash"
  });

  // 2. Build the outbound transport port connecting Agent to Wallet Receiver
  let capturedPresentation: any = null;

  const walletPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(request: WalletApprovalRequestV1) {
      // Encode request to canonical binary handoff bytes
      const handoffBytes = encodeAgentWalletHandoffV1(request);

      // Ingress into Wallet Receiver
      const reviewSession = await walletReceiver.prepareHandoff(handoffBytes);
      capturedPresentation = reviewSession.presentation;

      // Human interaction: approve through verified custodian session
      // Approver is resolved exclusively by sessionVerifier; no { approver } payload passed.
      const humanApproval = await walletReceiver.approveHandle(reviewSession.handle);

      return humanApproval;
    }
  };

  const simulationTransport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1_000_000,
    nowEpochSeconds: () => SIMULATION_NOW
  });

  // 3. Execute safeSendXEC in controlled simulation mode
  const result = await safeSendXEC(
    {
      toAddress: TO_ADDRESS,
      amountSats: 500_000, // 5,000 XEC
      reason: "Treasury rebalance"
    },
    {
      fromAddress: FROM_ADDRESS,
      agentId: "agent-treasury-01",
      agentRole: "treasury",
      now: () => SIMULATION_NOW,
      randomId: () => "integrated-req-001",
      randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
      requestPolicy: async (candidate) =>
        createApprovedPolicyDecisionFixture(candidate.intentId),
      walletApprovalPort: walletPort,
      walletTransport: simulationTransport
    }
  );

  // 4. Verify that execution resulted in human_approval_recorded as a read-only audit receipt
  assert.equal(result.status, "human_approval_recorded");
  assert.equal(result.simulation, true);
  assert.ok(result.walletApprovalRequest);
  assert.ok(result.humanApproval);
  assert.equal(result.humanApproval.status, "approved");
  assert.equal(result.humanApproval.approver, FROM_ADDRESS);
  assert.equal(
    result.humanApproval.requestId,
    result.walletApprovalRequest.requestId
  );

  // 5. Verify workflow stages: signing, broadcast, and confirmation MUST be not_attempted
  assert.equal(result.workflow.signedTransaction?.status, "not_attempted");
  assert.equal(result.workflow.broadcast?.status, "not_attempted");
  assert.equal(result.workflow.confirmation?.status, "not_attempted");

  // 6. Verify zero signing keys, zero transaction hex, zero broadcast txid
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "privateKey",
    "seed",
    "mnemonic",
    "rawTransactionHex",
    "txHex",
    "txid"
  ]) {
    assert.equal(
      serialized.includes(`"${forbidden}"`),
      false,
      `Forbidden signing/broadcast field "${forbidden}" found in result`
    );
  }

  // 7. Verify atomic persistence in Wallet Approval Ledger
  const ledgerRecord = await ledger.get(result.walletApprovalRequest.requestId);
  assert.ok(ledgerRecord, "Ledger record must exist in Wallet Approval Ledger");
  assert.equal(ledgerRecord.status, "approved");
  assert.equal(ledgerRecord.requestId, result.walletApprovalRequest.requestId);
  assert.equal(ledgerRecord.fromAddress, FROM_ADDRESS);
  assert.equal(ledgerRecord.destination, TO_ADDRESS);
  assert.equal(ledgerRecord.amountSats, "500000");
  assert.equal(ledgerRecord.presentationHash, capturedPresentation.presentationHash);
});

test("Cross-Repo Contract Harness Negative: Custodian address mismatch fails closed", async () => {
  const {
    encodeAgentWalletHandoffV1,
    createAgentWalletApprovalReceiver,
    InMemoryWalletApprovalLedger,
    createMockSessionVerifier,
    safeSendXEC
  } = await loadPipelineModules();

  const ledger = new InMemoryWalletApprovalLedger();
  // Custodian session is for a DIFFERENT address
  const sessionVerifier = createMockSessionVerifier(
    "ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
    true
  );

  const walletReceiver = createAgentWalletApprovalReceiver({
    ledger,
    sessionVerifier,
    clock: () => SIMULATION_NOW,
    idGenerator: () => "auto_id_1",
    declaredOrigin: "https://app.tonalli.cash"
  });

  const walletPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(request: WalletApprovalRequestV1) {
      const handoffBytes = encodeAgentWalletHandoffV1(request);
      const reviewSession = await walletReceiver.prepareHandoff(handoffBytes);
      return walletReceiver.approveHandle(reviewSession.handle);
    }
  };

  const simulationTransport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1_000_000,
    nowEpochSeconds: () => SIMULATION_NOW
  });

  await assert.rejects(
    async () => {
      await safeSendXEC(
        {
          toAddress: TO_ADDRESS,
          amountSats: 500_000,
          reason: "Unauthorized attempt"
        },
        {
          fromAddress: FROM_ADDRESS,
          now: () => SIMULATION_NOW,
          randomId: () => "mismatch-req-001",
          randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
          requestPolicy: async (candidate) =>
            createApprovedPolicyDecisionFixture(candidate.intentId),
          walletApprovalPort: walletPort,
          walletTransport: simulationTransport
        }
      );
    },
    /SESSION_ADDRESS_MISMATCH|PORT_DISPATCH_FAILED/
  );
});

test("Cross-Repo Contract Harness Negative: Human rejection records atomically into ledger and halts execution", async () => {
  const {
    encodeAgentWalletHandoffV1,
    createAgentWalletApprovalReceiver,
    InMemoryWalletApprovalLedger,
    createMockSessionVerifier,
    safeSendXEC
  } = await loadPipelineModules();

  const ledger = new InMemoryWalletApprovalLedger();
  const sessionVerifier = createMockSessionVerifier(FROM_ADDRESS, true);
  const walletReceiver = createAgentWalletApprovalReceiver({
    ledger,
    sessionVerifier,
    clock: () => SIMULATION_NOW + 5,
    idGenerator: () => "rej_id_1",
    declaredOrigin: "https://app.tonalli.cash"
  });

  const walletPort: WalletApprovalTransportPort = {
    async sendApprovalRequest(request: WalletApprovalRequestV1) {
      const handoffBytes = encodeAgentWalletHandoffV1(request);
      const reviewSession = await walletReceiver.prepareHandoff(handoffBytes);
      return walletReceiver.rejectHandle(reviewSession.handle, {
        reason: "User denied transaction in UI modal"
      });
    }
  };

  const simulationTransport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1_000_000,
    nowEpochSeconds: () => SIMULATION_NOW
  });

  const result = await safeSendXEC(
    {
      toAddress: TO_ADDRESS,
      amountSats: 500_000,
      reason: "Rejected flow"
    },
    {
      fromAddress: FROM_ADDRESS,
      now: () => SIMULATION_NOW,
      randomId: () => "reject-req-001",
      randomNonce: () => "MDEyMzQ1Njc4OWFiY2RlZg",
      requestPolicy: async (candidate) =>
        createApprovedPolicyDecisionFixture(candidate.intentId),
      walletApprovalPort: walletPort,
      walletTransport: simulationTransport
    }
  );

  assert.equal(result.status, "rejected");
  assert.equal(result.simulation, true);
  assert.ok(result.humanApproval);
  assert.equal(result.humanApproval.status, "rejected");
  assert.equal(result.humanApproval.reason, "User denied transaction in UI modal");
  assert.equal(result.workflow.signedTransaction?.status, "not_attempted");
  assert.equal(result.workflow.broadcast?.status, "not_attempted");

  // Verify rejection is recorded in ledger
  const record = await ledger.get(result.walletApprovalRequest.requestId);
  assert.ok(record);
  assert.equal(record.status, "rejected");
});
