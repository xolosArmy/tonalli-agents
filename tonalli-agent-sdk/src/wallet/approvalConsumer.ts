import { randomUUID } from "node:crypto";
import {
  AGENTIC_CONTRACT_VERSION,
  humanApprovalV1Schema,
  parseWalletApprovalRequestV1,
  type HumanApprovalV1,
  type WalletApprovalRequestV1
} from "@xolosarmy/tonalli-core";

export type ApprovalConsumerErrorCode =
  | "KILL_SWITCH_ACTIVE"
  | "LIMIT_EXCEEDED"
  | "INVALID_SCHEMA"
  | "TAMPERED_REQUEST"
  | "EXPIRED_REQUEST"
  | "REPLAY_DETECTED"
  | "NETWORK_MISMATCH"
  | "UNAUTHORIZED_DECISION"
  | "MISSING_HUMAN_APPROVAL"
  | "INVALID_HUMAN_ACTION";

export class WalletApprovalConsumerError extends Error {
  public readonly code: ApprovalConsumerErrorCode;

  constructor(code: ApprovalConsumerErrorCode, message: string) {
    super(message);
    this.name = "WalletApprovalConsumerError";
    this.code = code;
  }
}

export interface WalletApprovalDisplayDetails {
  requestId: string;
  intentId: string;
  decisionId: string;
  network: string;
  amountSats: string;
  amountXEC: string;
  fromAddress: string;
  destination: string;
  reason: string;
  memo?: string;
  policyTraceId: string;
  policyReasonCode: string;
  policyVersion: string;
  requestedAt: number;
  requestedAtIso: string;
  expiresAt: number;
  expiresAtIso: string;
  x402Context?: {
    x402Version: number;
    scheme: string;
    network: string;
    invoiceHash: string;
    resourceHash: string;
    amountSats: string;
    payTo: string;
    nonce: string;
    issuedAt: number;
    expiresAt: number;
  };
}

export interface HumanDecisionInput {
  decision: "approved" | "rejected";
  approver?: string;
  reason?: string;
}

export interface ConsumerOptions {
  now?: () => number;
  expectedNetwork?: "xec:mainnet";
  killSwitch?: boolean;
  maxMonetaryLimitSats?: bigint | number;
  randomId?: () => string;
}

export interface HandoffAuditResult {
  request: WalletApprovalRequestV1;
  display: WalletApprovalDisplayDetails;
  humanApproval: HumanApprovalV1;
  simulation: true;
}

export function createWalletApprovalConsumer(options: ConsumerOptions = {}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const expectedNetwork = options.expectedNetwork ?? "xec:mainnet";
  const killSwitch = options.killSwitch ?? true;
  const maxLimitSats =
    options.maxMonetaryLimitSats !== undefined
      ? BigInt(options.maxMonetaryLimitSats)
      : 0n;
  const randomId = options.randomId ?? randomUUID;

  const seenRequestIds = new Set<string>();
  const seenIntentIds = new Set<string>();
  const seenNonces = new Set<string>();

  function validateRequest(rawRequest: unknown): WalletApprovalRequestV1 {
    if (killSwitch) {
      throw new WalletApprovalConsumerError(
        "KILL_SWITCH_ACTIVE",
        "Agentic kill-switch is active; wallet approval consumption is blocked"
      );
    }

    let request: WalletApprovalRequestV1;
    try {
      request = parseWalletApprovalRequestV1(rawRequest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("does not match intent")) {
        throw new WalletApprovalConsumerError("TAMPERED_REQUEST", msg);
      }
      if (msg.includes("require needs_human_approval")) {
        throw new WalletApprovalConsumerError("UNAUTHORIZED_DECISION", msg);
      }
      throw new WalletApprovalConsumerError(
        "INVALID_SCHEMA",
        `Request failed canonical schema validation: ${msg}`
      );
    }

    if (request.contractVersion !== AGENTIC_CONTRACT_VERSION) {
      throw new WalletApprovalConsumerError(
        "INVALID_SCHEMA",
        `Unsupported contract version: ${request.contractVersion}`
      );
    }

    if (request.kind !== "wallet_approval_request" || request.purpose !== "xec_payment") {
      throw new WalletApprovalConsumerError(
        "INVALID_SCHEMA",
        `Unexpected request kind or purpose: ${request.kind}/${request.purpose}`
      );
    }

    if (request.policyDecision.decision !== "needs_human_approval") {
      throw new WalletApprovalConsumerError(
        "UNAUTHORIZED_DECISION",
        `Policy decision is not 'needs_human_approval' (was: ${request.policyDecision.decision})`
      );
    }

    // Integrity check: intent ID binding between intent and policy decision
    if (request.intent.intentId !== request.policyDecision.intentId) {
      throw new WalletApprovalConsumerError(
        "TAMPERED_REQUEST",
        `Intent ID mismatch between intent (${request.intent.intentId}) and policy decision (${request.policyDecision.intentId})`
      );
    }

    // Integrity check: policy trace must be non-empty
    if (!request.policyDecision.policyTraceId || request.policyDecision.policyTraceId.trim() === "") {
      throw new WalletApprovalConsumerError(
        "TAMPERED_REQUEST",
        "Policy trace ID is empty or invalid"
      );
    }

    // Monetary limit check
    let amountSatsBigInt: bigint;
    try {
      amountSatsBigInt = BigInt(request.intent.amountSats);
      if (amountSatsBigInt < 0n) {
        throw new Error("negative amount");
      }
    } catch {
      throw new WalletApprovalConsumerError(
        "INVALID_SCHEMA",
        `Invalid amountSats value: ${request.intent.amountSats}`
      );
    }

    if (amountSatsBigInt > maxLimitSats) {
      throw new WalletApprovalConsumerError(
        "LIMIT_EXCEEDED",
        `Requested amount ${amountSatsBigInt.toString()} sats exceeds authorized limit ${maxLimitSats.toString()} sats`
      );
    }

    // Network matching check
    if (request.intent.network !== expectedNetwork) {
      throw new WalletApprovalConsumerError(
        "NETWORK_MISMATCH",
        `Network mismatch: request specifies ${request.intent.network}, expected ${expectedNetwork}`
      );
    }

    // Temporal validity and expiration checks
    const currentEpoch = now();

    if (currentEpoch < request.intent.createdAt) {
      throw new WalletApprovalConsumerError(
        "INVALID_SCHEMA",
        `Intent creation time is in the future: ${request.intent.createdAt} > ${currentEpoch}`
      );
    }

    if (currentEpoch >= request.expiresAt) {
      throw new WalletApprovalConsumerError(
        "EXPIRED_REQUEST",
        `Wallet approval request has expired: ${currentEpoch} >= ${request.expiresAt}`
      );
    }

    if (currentEpoch >= request.intent.expiresAt) {
      throw new WalletApprovalConsumerError(
        "EXPIRED_REQUEST",
        `Agent intent has expired: ${currentEpoch} >= ${request.intent.expiresAt}`
      );
    }

    if (currentEpoch >= request.policyDecision.expiresAt) {
      throw new WalletApprovalConsumerError(
        "EXPIRED_REQUEST",
        `CAE policy decision has expired: ${currentEpoch} >= ${request.policyDecision.expiresAt}`
      );
    }

    if (request.expiresAt > request.policyDecision.expiresAt || request.expiresAt > request.intent.expiresAt) {
      throw new WalletApprovalConsumerError(
        "TAMPERED_REQUEST",
        "Approval request expiry cannot exceed intent or policy decision expiry"
      );
    }

    // Replay detection check
    if (seenRequestIds.has(request.requestId)) {
      throw new WalletApprovalConsumerError(
        "REPLAY_DETECTED",
        `Request ID ${request.requestId} has already been consumed`
      );
    }

    if (seenIntentIds.has(request.intent.intentId)) {
      throw new WalletApprovalConsumerError(
        "REPLAY_DETECTED",
        `Intent ID ${request.intent.intentId} has already been consumed`
      );
    }

    if (seenNonces.has(request.intent.nonce)) {
      throw new WalletApprovalConsumerError(
        "REPLAY_DETECTED",
        `Intent nonce ${request.intent.nonce} has already been consumed`
      );
    }

    // Mark as consumed
    seenRequestIds.add(request.requestId);
    seenIntentIds.add(request.intent.intentId);
    seenNonces.add(request.intent.nonce);

    return request;
  }

  function formatDisplay(request: WalletApprovalRequestV1): WalletApprovalDisplayDetails {
    const sats = BigInt(request.intent.amountSats);
    const whole = sats / 100n;
    const fraction = sats % 100n;
    const amountXEC = `${whole.toString()}.${fraction.toString().padStart(2, "0")}`;

    return {
      requestId: request.requestId,
      intentId: request.intent.intentId,
      decisionId: request.policyDecision.decisionId,
      network: request.intent.network,
      amountSats: request.intent.amountSats,
      amountXEC,
      fromAddress: request.intent.fromAddress,
      destination: request.intent.toAddress,
      reason: request.intent.reason,
      memo: request.intent.memo,
      policyTraceId: request.policyDecision.policyTraceId,
      policyReasonCode: request.policyDecision.reasonCode,
      policyVersion: request.policyDecision.policyVersion,
      requestedAt: request.requestedAt,
      requestedAtIso: new Date(request.requestedAt * 1000).toISOString(),
      expiresAt: request.expiresAt,
      expiresAtIso: new Date(request.expiresAt * 1000).toISOString(),
      x402Context: request.x402
        ? {
            x402Version: request.x402.x402Version,
            scheme: request.x402.scheme,
            network: request.x402.network,
            invoiceHash: request.x402.invoiceHash,
            resourceHash: request.x402.resourceHash,
            amountSats: request.x402.amountSats,
            payTo: request.x402.payTo,
            nonce: request.x402.nonce,
            issuedAt: request.x402.issuedAt,
            expiresAt: request.x402.expiresAt
          }
        : undefined
    };
  }

  function recordHumanDecision(
    request: WalletApprovalRequestV1,
    action: HumanDecisionInput
  ): HumanApprovalV1 {
    if (!action || typeof action !== "object") {
      throw new WalletApprovalConsumerError(
        "MISSING_HUMAN_APPROVAL",
        "Explicit human action is required; implicit or automatic approval is strictly rejected"
      );
    }

    if (action.decision !== "approved" && action.decision !== "rejected") {
      throw new WalletApprovalConsumerError(
        "INVALID_HUMAN_ACTION",
        `Invalid human decision: expected 'approved' or 'rejected', got '${String((action as any).decision)}'`
      );
    }

    const recordedAt = now();

    if (recordedAt >= request.expiresAt) {
      throw new WalletApprovalConsumerError(
        "EXPIRED_REQUEST",
        `Cannot record human decision: request expired at ${request.expiresAt}, current time is ${recordedAt}`
      );
    }

    return humanApprovalV1Schema.parse({
      contractVersion: AGENTIC_CONTRACT_VERSION,
      kind: "human_approval",
      approvalId: `human-approval:${randomId()}`,
      requestId: request.requestId,
      intentId: request.intent.intentId,
      decisionId: request.policyDecision.decisionId,
      status: action.decision,
      approver: action.approver,
      reason: action.reason,
      recordedAt
    });
  }

  function processApprovalHandoff(
    rawRequest: unknown,
    humanDecision: HumanDecisionInput
  ): HandoffAuditResult {
    const validatedRequest = validateRequest(rawRequest);
    const display = formatDisplay(validatedRequest);
    const approval = recordHumanDecision(validatedRequest, humanDecision);

    return {
      request: validatedRequest,
      display,
      humanApproval: approval,
      simulation: true
    };
  }

  return {
    validateRequest,
    formatDisplay,
    recordHumanDecision,
    processApprovalHandoff,
    snapshot() {
      return Object.freeze({
        killSwitch,
        maxMonetaryLimitSats: maxLimitSats.toString(),
        consumedRequests: seenRequestIds.size,
        consumedIntents: seenIntentIds.size,
        consumedNonces: seenNonces.size
      });
    }
  };
}
