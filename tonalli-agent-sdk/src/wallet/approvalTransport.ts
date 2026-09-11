/**
 * @file approvalTransport.ts
 *
 * CANONICAL AGENT-SIDE WALLET APPROVAL OUTBOUND TRANSPORT (Gate 2A)
 *
 * Authority Boundary:
 * - Agents PRODUCE and TRANSPORT WalletApprovalRequestV1 envelopes.
 * - Agents VALIDATE that outbound envelopes satisfy Core schemas and local guard constraints.
 * - Agents INVOKE an explicit outbound WalletApprovalTransportPort toward Wallet.
 * - Agents RECEIVE subsequent HumanApprovalV1 responses issued by Wallet and validate bindings.
 * - Agents CANNOT create HumanApprovalV1, generate approvalId, accept human decisions directly,
 *   represent Wallet UI, or execute/sign/broadcast transactions.
 *
 * Network Domain Status:
 * BLOCKED_BY_CORE_NETWORK_DOMAIN
 * In tonalli-core v1.0, agentIntentV1Schema and x402ApprovalContextV1Schema constrain `network`
 * exclusively to `z.literal("xec:mainnet")`. No canonical regtest network identifier is admitted.
 * All testing with `xec:mainnet` envelopes is strictly:
 *   "schema-only mainnet-shaped simulation"
 * under AGENTIC_KILL_SWITCH=true and AGENT_DAILY_LIMIT_SATS=0 without signing or real funds.
 *
 * Hardened Receipt & Audit Boundary:
 * - HumanApprovalV1 is strictly an auditable receipt/audit artifact, NEVER a signing authorization
 *   or portable execution capability.
 * - Agents NEVER receives WalletLocalApprovalBinding nor ApprovalRecordCapability.
 * - A mock port that returns `approved` does NOT enable financial execution.
 */

import {
  AGENTIC_CONTRACT_VERSION,
  humanApprovalV1Schema,
  parseWalletApprovalRequestV1,
  type HumanApprovalV1,
  type WalletApprovalRequestV1
} from "@xolosarmy/tonalli-core";
import { formatSatsToExactXEC } from "./format";

export const parseHumanApprovalV1 = (value: unknown): HumanApprovalV1 =>
  humanApprovalV1Schema.parse(value);

export type WalletApprovalTransportErrorCode =
  | "KILL_SWITCH_ACTIVE"
  | "MONETARY_LIMIT_EXCEEDED"
  | "MISSING_WALLET_TRANSPORT"
  | "INVALID_REQUEST_SCHEMA"
  | "INVALID_CONTRACT_VERSION"
  | "INVALID_KIND"
  | "INVALID_PURPOSE"
  | "POLICY_DECISION_MISMATCH"
  | "POLICY_DECISION_NOT_HUMAN_APPROVAL"
  | "EMPTY_POLICY_TRACE"
  | "REQUEST_EXPIRED"
  | "REQUEST_NOT_YET_VALID"
  | "REPLAY_DETECTED"
  | "PORT_DISPATCH_FAILED"
  | "INVALID_RESPONSE_SCHEMA"
  | "RESPONSE_BINDING_MISMATCH"
  | "RESPONSE_EXPIRED_MISMATCH"
  | "INVALID_CLOCK";

export class WalletApprovalTransportError extends Error {
  readonly code: WalletApprovalTransportErrorCode;
  readonly details?: unknown;

  constructor(
    code: WalletApprovalTransportErrorCode,
    message: string,
    details?: unknown
  ) {
    super(`[WalletApprovalTransport] ${code}: ${message}`);
    this.name = "WalletApprovalTransportError";
    this.code = code;
    this.details = details;
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof Error &&
      instance.name === "WalletApprovalTransportError" &&
      typeof (instance as any).code === "string"
    );
  }
}

/**
 * Outbound transport port toward the Wallet domain.
 * Must be implemented by the transport layer connecting Agents to RMZWallet.
 */
export interface WalletApprovalTransportPort {
  sendApprovalRequest(request: WalletApprovalRequestV1): Promise<HumanApprovalV1>;
}

export interface WalletApprovalTransportConfig {
  /**
   * Enforce agentic kill-switch. Defaults to true (fail-closed).
   */
  killSwitch?: boolean;
  /**
   * Maximum allowed monetary limit in satoshis. Defaults to 0 (all spend blocked).
   */
  monetaryLimitSats?: number | bigint;
  /**
   * Injectable clock provider for deterministic testing. Defaults to Date.now() / 1000.
   */
  nowEpochSeconds?: () => number;
}

export interface WalletApprovalAuditDisplay {
  requestId: string;
  intentId: string;
  decisionId: string;
  agentId: string;
  agentRole: string;
  amountSats: string;
  amountXEC: string;
  fromAddress: string;
  destination: string;
  reason: string;
  memo?: string;
  network: "xec:mainnet";
  policyTraceId: string;
  policyReasonCode: string;
  policyVersion: string;
  requestedAtIso: string;
  expiresAtIso: string;
}

export interface WalletApprovalTransport {
  readonly validateOutboundRequest: (requestInput: unknown) => WalletApprovalRequestV1;
  readonly formatAuditDisplay: (request: WalletApprovalRequestV1) => WalletApprovalAuditDisplay;
  readonly dispatchApprovalRequest: (
    requestInput: unknown,
    port: WalletApprovalTransportPort
  ) => Promise<HumanApprovalV1>;
  readonly pruneExpired: () => number;
  readonly getReplayCacheStats: () => { pending: number; committed: number };
}

/**
 * Creates an outbound transport client for dispatching canonical WalletApprovalRequestV1
 * envelopes from Agents to Wallet without assuming approval authority.
 */
export function createWalletApprovalTransport(
  config: WalletApprovalTransportConfig = {}
): WalletApprovalTransport {
  const killSwitch = config.killSwitch ?? true;
  const monetaryLimitSats = BigInt(config.monetaryLimitSats ?? 0);
  const getNow = config.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1000));

  function getValidNowEpochSeconds(): number {
    const now = getNow();
    if (
      typeof now !== "number" ||
      !Number.isFinite(now) ||
      !Number.isInteger(now) ||
      !Number.isSafeInteger(now) ||
      now < 0
    ) {
      throw new WalletApprovalTransportError(
        "INVALID_CLOCK",
        `Invalid clock value produced by nowEpochSeconds: ${now}. Expected non-negative safe integer.`
      );
    }
    return now;
  }

  /**
   * BOUNDED IN-MEMORY REPLAY CACHE (NON-DURABLE FALLBACK)
   *
   * CRITICAL SECURITY BOUNDARY NOTE:
   * This in-memory cache bounds heap memory growth in long-running processes by
   * pruning committed entries whose canonical validity window (expiresAt) has elapsed.
   *
   * WARNING: This retention is STRICTLY PROCESS-LOCAL AND VOLATILE.
   * It does NOT provide durable replay protection across restarts, multi-instance
   * deployments, horizontal scaling, or real-funds settlement. Durable replay
   * protection and atomic state transitions must be enforced by the shared
   * transactional CAE store and the Wallet-owned authorization ledger.
   */
  interface CommittedReplayEntry {
    readonly requestId: string;
    readonly intentId: string;
    readonly nonce: string;
    readonly expiresAt: number;
  }

  const pendingReservations = new Map<
    string,
    { intentId: string; nonce: string; expiresAt: number }
  >();
  const committedEntries = new Map<string, CommittedReplayEntry>();
  const committedIntentIndex = new Map<string, string>();
  const committedNonceIndex = new Map<string, string>();

  function pruneExpiredEntries(currentEpoch: number): number {
    let prunedCount = 0;
    for (const [requestId, entry] of committedEntries.entries()) {
      if (entry.expiresAt <= currentEpoch) {
        committedEntries.delete(requestId);
        committedIntentIndex.delete(entry.intentId);
        committedNonceIndex.delete(entry.nonce);
        prunedCount++;
      }
    }
    return prunedCount;
  }

  function reserveRequest(
    requestId: string,
    intentId: string,
    nonce: string,
    expiresAt: number,
    now: number
  ): void {
    pruneExpiredEntries(now);

    if (
      committedEntries.has(requestId) ||
      committedIntentIndex.has(intentId) ||
      committedNonceIndex.has(nonce)
    ) {
      throw new WalletApprovalTransportError(
        "REPLAY_DETECTED",
        `Outbound request identifier or nonce has already been committed in this process`
      );
    }
    for (const [pReqId, pVal] of pendingReservations.entries()) {
      if (pReqId === requestId || pVal.intentId === intentId || pVal.nonce === nonce) {
        throw new WalletApprovalTransportError(
          "REPLAY_DETECTED",
          `Outbound request identifier or nonce is already pending dispatch in this process`
        );
      }
    }
    pendingReservations.set(requestId, { intentId, nonce, expiresAt });
  }

  function commitReservation(requestId: string): void {
    const reserved = pendingReservations.get(requestId);
    if (reserved) {
      pendingReservations.delete(requestId);
      committedEntries.set(requestId, {
        requestId,
        intentId: reserved.intentId,
        nonce: reserved.nonce,
        expiresAt: reserved.expiresAt
      });
      committedIntentIndex.set(reserved.intentId, requestId);
      committedNonceIndex.set(reserved.nonce, requestId);
    }
  }

  function rollbackReservation(requestId: string): void {
    pendingReservations.delete(requestId);
  }

  /**
   * Validates that an outbound request matches Core schema, active policies,
   * temporal bounds, and local safety invariants.
   */
  function validateOutboundRequest(input: unknown): WalletApprovalRequestV1 {
    if (killSwitch) {
      throw new WalletApprovalTransportError(
        "KILL_SWITCH_ACTIVE",
        "Agentic kill switch is active (default). Outbound wallet approval requests are blocked."
      );
    }

    let parsed: WalletApprovalRequestV1;
    try {
      parsed = parseWalletApprovalRequestV1(input);
    } catch (err) {
      throw new WalletApprovalTransportError(
        "INVALID_REQUEST_SCHEMA",
        "Payload does not satisfy canonical WalletApprovalRequestV1 schema",
        err
      );
    }

    if (parsed.contractVersion !== AGENTIC_CONTRACT_VERSION) {
      throw new WalletApprovalTransportError(
        "INVALID_CONTRACT_VERSION",
        `Expected contractVersion ${AGENTIC_CONTRACT_VERSION}, got ${parsed.contractVersion}`
      );
    }

    if (parsed.kind !== "wallet_approval_request") {
      throw new WalletApprovalTransportError(
        "INVALID_KIND",
        `Expected kind wallet_approval_request, got ${parsed.kind}`
      );
    }

    if (parsed.purpose !== "xec_payment") {
      throw new WalletApprovalTransportError(
        "INVALID_PURPOSE",
        `Expected purpose xec_payment, got ${parsed.purpose}`
      );
    }

    if (parsed.policyDecision.decision !== "needs_human_approval") {
      throw new WalletApprovalTransportError(
        "POLICY_DECISION_NOT_HUMAN_APPROVAL",
        `Approval request requires policy decision needs_human_approval, got ${parsed.policyDecision.decision}`
      );
    }

    if (parsed.policyDecision.intentId !== parsed.intent.intentId) {
      throw new WalletApprovalTransportError(
        "POLICY_DECISION_MISMATCH",
        `Policy decision intentId (${parsed.policyDecision.intentId}) does not match intent (${parsed.intent.intentId})`
      );
    }

    if (!parsed.policyDecision.policyTraceId || parsed.policyDecision.policyTraceId.trim() === "") {
      throw new WalletApprovalTransportError(
        "EMPTY_POLICY_TRACE",
        "Policy decision trace ID cannot be empty"
      );
    }

    const intentSats = BigInt(parsed.intent.amountSats);
    if (intentSats > monetaryLimitSats) {
      throw new WalletApprovalTransportError(
        "MONETARY_LIMIT_EXCEEDED",
        `Requested amount (${parsed.intent.amountSats} sats) exceeds agent monetary limit (${monetaryLimitSats} sats)`
      );
    }

    const now = getValidNowEpochSeconds();
    if (parsed.requestedAt > now + 60) {
      throw new WalletApprovalTransportError(
        "REQUEST_NOT_YET_VALID",
        `Request requestedAt (${parsed.requestedAt}) is in the future compared to current time (${now})`
      );
    }

    if (parsed.expiresAt <= now) {
      throw new WalletApprovalTransportError(
        "REQUEST_EXPIRED",
        `Request expired at ${parsed.expiresAt}, current time is ${now}`
      );
    }

    return parsed;
  }

  /**
   * Formats outbound request for read-only audit and user inspection.
   */
  function formatAuditDisplay(request: WalletApprovalRequestV1): WalletApprovalAuditDisplay {
    const amountXEC = formatSatsToExactXEC(request.intent.amountSats);
    return {
      requestId: request.requestId,
      intentId: request.intent.intentId,
      decisionId: request.policyDecision.decisionId,
      agentId: request.intent.agentId,
      agentRole: request.intent.agentRole,
      amountSats: request.intent.amountSats,
      amountXEC,
      fromAddress: request.intent.fromAddress,
      destination: request.intent.toAddress,
      reason: request.intent.reason,
      memo: request.intent.memo,
      network: request.intent.network,
      policyTraceId: request.policyDecision.policyTraceId,
      policyReasonCode: request.policyDecision.reasonCode,
      policyVersion: request.policyDecision.policyVersion,
      requestedAtIso: new Date(request.requestedAt * 1000).toISOString(),
      expiresAtIso: new Date(request.expiresAt * 1000).toISOString()
    };
  }

  /**
   * Dispatches a canonical request to the Wallet port and verifies the resulting
   * HumanApprovalV1 artifact without assuming local approval authority.
   */
  async function dispatchApprovalRequest(
    requestInput: unknown,
    port: WalletApprovalTransportPort
  ): Promise<HumanApprovalV1> {
    const validatedRequest = validateOutboundRequest(requestInput);
    const now = getValidNowEpochSeconds();

    reserveRequest(
      validatedRequest.requestId,
      validatedRequest.intent.intentId,
      validatedRequest.intent.nonce,
      validatedRequest.expiresAt,
      now
    );

    let walletResponse: unknown;
    try {
      walletResponse = await port.sendApprovalRequest(validatedRequest);
    } catch (err) {
      rollbackReservation(validatedRequest.requestId);
      throw new WalletApprovalTransportError(
        "PORT_DISPATCH_FAILED",
        `Wallet transport port failed to dispatch request: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    let parsedResponse: HumanApprovalV1;
    try {
      parsedResponse = parseHumanApprovalV1(walletResponse);
    } catch (err) {
      rollbackReservation(validatedRequest.requestId);
      throw new WalletApprovalTransportError(
        "INVALID_RESPONSE_SCHEMA",
        "Wallet response is not a valid HumanApprovalV1 artifact",
        err
      );
    }

    if (parsedResponse.contractVersion !== AGENTIC_CONTRACT_VERSION) {
      rollbackReservation(validatedRequest.requestId);
      throw new WalletApprovalTransportError(
        "RESPONSE_BINDING_MISMATCH",
        `Wallet response contractVersion (${parsedResponse.contractVersion}) does not match expected (${AGENTIC_CONTRACT_VERSION})`
      );
    }

    if (parsedResponse.requestId !== validatedRequest.requestId) {
      rollbackReservation(validatedRequest.requestId);
      throw new WalletApprovalTransportError(
        "RESPONSE_BINDING_MISMATCH",
        `Wallet response requestId (${parsedResponse.requestId}) does not match outbound request (${validatedRequest.requestId})`
      );
    }

    if (parsedResponse.intentId !== validatedRequest.intent.intentId) {
      rollbackReservation(validatedRequest.requestId);
      throw new WalletApprovalTransportError(
        "RESPONSE_BINDING_MISMATCH",
        `Wallet response intentId (${parsedResponse.intentId}) does not match outbound intent (${validatedRequest.intent.intentId})`
      );
    }

    if (parsedResponse.decisionId !== validatedRequest.policyDecision.decisionId) {
      rollbackReservation(validatedRequest.requestId);
      throw new WalletApprovalTransportError(
        "RESPONSE_BINDING_MISMATCH",
        `Wallet response decisionId (${parsedResponse.decisionId}) does not match outbound policy decision (${validatedRequest.policyDecision.decisionId})`
      );
    }

    if (parsedResponse.recordedAt < validatedRequest.requestedAt) {
      rollbackReservation(validatedRequest.requestId);
      throw new WalletApprovalTransportError(
        "RESPONSE_BINDING_MISMATCH",
        `Wallet response recordedAt (${parsedResponse.recordedAt}) cannot precede requestedAt (${validatedRequest.requestedAt})`
      );
    }

    if (parsedResponse.status === "approved") {
      if (!parsedResponse.approver || parsedResponse.approver !== validatedRequest.intent.fromAddress) {
        rollbackReservation(validatedRequest.requestId);
        throw new WalletApprovalTransportError(
          "RESPONSE_BINDING_MISMATCH",
          `Approved response approver (${parsedResponse.approver ?? "undefined"}) does not match intent fromAddress (${validatedRequest.intent.fromAddress})`
        );
      }
    }

    if (
      parsedResponse.recordedAt >= validatedRequest.expiresAt &&
      parsedResponse.status !== "expired"
    ) {
      rollbackReservation(validatedRequest.requestId);
      throw new WalletApprovalTransportError(
        "RESPONSE_EXPIRED_MISMATCH",
        `Wallet response recorded at or after request expiry (${validatedRequest.expiresAt}) must have status 'expired', got '${parsedResponse.status}'`
      );
    }

    commitReservation(validatedRequest.requestId);
    return parsedResponse;
  }

  return {
    validateOutboundRequest,
    formatAuditDisplay,
    dispatchApprovalRequest,
    pruneExpired: () => pruneExpiredEntries(getValidNowEpochSeconds()),
    getReplayCacheStats: () => ({
      pending: pendingReservations.size,
      committed: committedEntries.size
    })
  };
}
