/**
 * @file approvalTransport.ts
 *
 * CANONICAL AGENT-SIDE WALLET APPROVAL OUTBOUND TRANSPORT (Gate 2A & Durable CAE State)
 *
 * Authority Boundary:
 * - Agents PRODUCE and TRANSPORT WalletApprovalRequestV1 envelopes.
 * - Agents VALIDATE that outbound envelopes satisfy Core schemas and local guard constraints.
 * - Agents INVOKE an explicit outbound WalletApprovalTransportPort toward Wallet.
 * - Agents RECEIVE subsequent HumanApprovalV1 responses issued by Wallet and validate bindings.
 * - Agents CANNOT create HumanApprovalV1, generate approvalId, accept human decisions directly,
 *   represent Wallet UI, or execute/sign/broadcast transactions.
 *
 * Authoritative Durable Coordination Boundary:
 * - Backed by an ACID DurableAuthorizationStore (SQLite WAL reference adapter or distributed backend).
 * - Multi-instance and cross-process safety: replay prevention, nonce uniqueness, atomic concurrent
 *   reservation exclusion, cumulative daily authorization limits, and lease-fencing recovery
 *   are all enforced at the durable store layer under database constraints.
 * - No correctness guarantee relies on process-local JavaScript Maps or Sets.
 * - Fail-closed: if the durable store is unavailable, locked, corrupt, or uncertain,
 *   authorization fails closed immediately. Zero silent fallback to volatile state in durable mode.
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
 * - Agents NEVER receive WalletLocalApprovalBinding nor ApprovalRecordCapability.
 * - A mock port that returns `approved` does NOT enable financial execution.
 */

import { randomUUID } from "node:crypto";
import {
  AGENTIC_CONTRACT_VERSION,
  humanApprovalV1Schema,
  parseWalletApprovalRequestV1,
  type HumanApprovalV1,
  type WalletApprovalRequestV1
} from "@xolosarmy/tonalli-core";
import { formatSatsToExactXEC } from "./format";
import {
  createSqliteDurableStore,
  DurableStoreError,
  formatSpendingKey,
  getDeterministicUtcDateString,
  type DailySpendingStats,
  type DurableAuthorizationStore,
  type DurableReplayIdentifiers,
  type DurableReservationHandle,
  type DurableSpendingIdentity
} from "../durableStore";

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
  | "RESPONSE_OUTSIDE_WORKFLOW_WINDOW"
  | "INVALID_CLOCK"
  | "STORE_UNAVAILABLE"
  | "LEASE_EXPIRED"
  | "LEASE_SUPERSEDED";

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
   * Alias for cumulative daily limit in satoshis. Defaults to monetaryLimitSats ?? 0.
   */
  dailyLimitSats?: number | bigint;
  /**
   * Injectable clock provider for deterministic testing. Defaults to Date.now() / 1000.
   */
  nowEpochSeconds?: () => number;
  /**
   * Authoritative durable authorization store.
   * If omitted, an in-process SQLite store (:memory:) is created for local testing/simulation.
   */
  durableStore?: DurableAuthorizationStore;
  /**
   * Path to SQLite database file on disk if durableStore is not directly supplied.
   */
  dbPath?: string;
  /**
   * Worker/instance identity for reservation lease ownership. Defaults to auto-generated UUID.
   */
  ownerId?: string;
  /**
   * Lease duration in seconds for pending reservations before stale recovery. Defaults to 60s.
   */
  leaseDurationSeconds?: number;
  /**
   * Explicit flag indicating in-memory development or simulation mode.
   */
  simulationMode?: boolean;
  /**
   * Alias for simulationMode.
   */
  isSimulation?: boolean;
  /**
   * Heartbeat renewal interval in milliseconds while awaiting human approval.
   */
  heartbeatIntervalMs?: number;
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
  readonly pruneExpired: () => number | Promise<number>;
  readonly getReplayCacheStats: () => { pending: number; committed: number } | Promise<{ pending: number; committed: number }>;
  readonly getDailySpending?: (
    spending: DurableSpendingIdentity,
    utcDate?: string
  ) => DailySpendingStats | Promise<DailySpendingStats>;
  readonly durableStore?: DurableAuthorizationStore;
}

/**
 * Creates an outbound transport client for dispatching canonical WalletApprovalRequestV1
 * envelopes from Agents to Wallet with authoritative durable CAE state.
 */
export function createWalletApprovalTransport(
  config: WalletApprovalTransportConfig = {}
): WalletApprovalTransport {
  const killSwitch = config.killSwitch ?? true;

  // P1-2: monetaryLimitSats and dailyLimitSats resolution:
  // effectivePerRequestLimit = monetaryLimitSats ?? dailyLimitSats ?? 0
  // effectiveDailyLimit = dailyLimitSats ?? monetaryLimitSats ?? 0
  const effectivePerRequestLimit = config.monetaryLimitSats !== undefined
    ? BigInt(config.monetaryLimitSats)
    : config.dailyLimitSats !== undefined
      ? BigInt(config.dailyLimitSats)
      : 0n;

  const effectiveDailyLimit = config.dailyLimitSats !== undefined
    ? BigInt(config.dailyLimitSats)
    : config.monetaryLimitSats !== undefined
      ? BigInt(config.monetaryLimitSats)
      : 0n;

  const getNow = config.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1000));
  const ownerId = config.ownerId ?? `worker-${randomUUID()}`;
  const leaseDurationSeconds = config.leaseDurationSeconds ?? 60;
  const heartbeatIntervalMs = config.heartbeatIntervalMs;

  const isSimulation =
    config.simulationMode === true ||
    (config as any).isSimulation === true ||
    process.env.TONALLI_SIMULATION === "true";

  // Fail-closed in-memory fallback audit:
  // If neither durableStore nor persistent dbPath is supplied:
  // fail closed unless simulationMode === true.
  if (!config.durableStore && (!config.dbPath || config.dbPath === ":memory:")) {
    if (!isSimulation) {
      throw new WalletApprovalTransportError(
        "STORE_UNAVAILABLE",
        "A persistent dbPath or authoritative durableStore instance is required. In-memory storage (:memory:) is strictly prohibited unless simulationMode: true is explicitly configured."
      );
    }
  }

  // Authoritative durable state store: SQLite reference adapter by default
  const durableStore: DurableAuthorizationStore =
    config.durableStore ??
    createSqliteDurableStore({
      dbPath: config.dbPath ?? ":memory:",
      isSimulation
    });

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
    if (intentSats > effectivePerRequestLimit) {
      throw new WalletApprovalTransportError(
        "MONETARY_LIMIT_EXCEEDED",
        `Requested amount (${parsed.intent.amountSats} sats) exceeds agent monetary limit (${effectivePerRequestLimit} sats)`
      );
    }
    if (intentSats > effectiveDailyLimit) {
      throw new WalletApprovalTransportError(
        "MONETARY_LIMIT_EXCEEDED",
        `Requested amount (${parsed.intent.amountSats} sats) exceeds agent daily limit (${effectiveDailyLimit} sats)`
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
   * HumanApprovalV1 artifact under durable ACID reservation and fencing.
   */
  async function dispatchApprovalRequest(
    requestInput: unknown,
    port: WalletApprovalTransportPort
  ): Promise<HumanApprovalV1> {
    const validatedRequest = validateOutboundRequest(requestInput);
    const now = getValidNowEpochSeconds();

    // Replay identities to coordinate durably
    const replayIdentifiers: DurableReplayIdentifiers = {
      requestId: validatedRequest.requestId,
      intentId: validatedRequest.intent.intentId,
      intentNonce: validatedRequest.intent.nonce,
      ...(validatedRequest.x402?.invoiceHash ? { x402InvoiceHash: validatedRequest.x402.invoiceHash } : {}),
      ...(validatedRequest.x402?.nonce ? { x402Nonce: validatedRequest.x402.nonce } : {})
    };

    const spendingIdentity: DurableSpendingIdentity = {
      agentId: validatedRequest.intent.agentId,
      fromAddress: validatedRequest.intent.fromAddress,
      network: validatedRequest.intent.network
    };

    // Atomically reserve replay identities AND cumulative daily monetary budget
    let reservationHandle: DurableReservationHandle;
    try {
      reservationHandle = await durableStore.reserveAuthorization({
        identifiers: replayIdentifiers,
        spending: spendingIdentity,
        amountSats: BigInt(validatedRequest.intent.amountSats),
        dailyLimitSats: effectiveDailyLimit,
        requestRequestedAt: validatedRequest.requestedAt,
        requestExpiresAt: validatedRequest.expiresAt,
        nowEpochSeconds: now,
        ownerId,
        leaseDurationSeconds
      });
    } catch (err) {
      if (err instanceof DurableStoreError) {
        if (err.code === "REPLAY_DETECTED") {
          throw new WalletApprovalTransportError(
            "REPLAY_DETECTED",
            `Outbound request identifier or nonce has already been committed or is pending dispatch: ${err.message}`,
            err
          );
        }
        if (err.code === "MONETARY_LIMIT_EXCEEDED") {
          throw new WalletApprovalTransportError(
            "MONETARY_LIMIT_EXCEEDED",
            `Requested amount exceeds cumulative daily limit: ${err.message}`,
            err
          );
        }
        if (err.code === "INVALID_CLOCK") {
          throw new WalletApprovalTransportError(
            "INVALID_CLOCK",
            err.message,
            err
          );
        }
        throw new WalletApprovalTransportError(
          "STORE_UNAVAILABLE",
          `Durable state operation failed: ${err.message}`,
          err
        );
      }
      throw new WalletApprovalTransportError(
        "STORE_UNAVAILABLE",
        `Durable state store threw unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    let currentHandle = reservationHandle;

    // Helper to safely roll back and fail closed
    const rollbackAndFail = async (
      code: WalletApprovalTransportErrorCode,
      message: string,
      details?: unknown
    ): Promise<never> => {
      try {
        await durableStore.rollbackAuthorization({
          reservationId: currentHandle.reservationId,
          leaseToken: currentHandle.leaseToken,
          fencingToken: currentHandle.fencingToken,
          nowEpochSeconds: getValidNowEpochSeconds(),
          reason: code
        });
      } catch (rollbackErr) {
        // Rollback failure is logged/attached to details
      }
      throw new WalletApprovalTransportError(code, message, details);
    };

    // Canonical workflow boundary: human review and lease renewal cannot extend beyond this
    const canonicalWorkflowExpiry = Math.min(
      validatedRequest.expiresAt,
      validatedRequest.intent.expiresAt,
      validatedRequest.policyDecision.expiresAt
    );

    // Heartbeat lease renewal while awaiting Wallet port response
    // Bounds renewal to canonical workflow validity window
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatStopped = false;

    const stopHeartbeat = () => {
      heartbeatStopped = true;
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const intervalMs = heartbeatIntervalMs ?? Math.max(500, Math.floor((leaseDurationSeconds * 1000) / 2));

    const renewLeaseHeartbeat = async () => {
      if (heartbeatStopped) return;
      const currentNow = getValidNowEpochSeconds();
      if (currentNow >= canonicalWorkflowExpiry) {
        stopHeartbeat();
        return;
      }

      const remainingWorkflowSeconds = canonicalWorkflowExpiry - currentNow;
      const additionalSeconds = Math.min(leaseDurationSeconds, remainingWorkflowSeconds);
      if (additionalSeconds <= 0) {
        stopHeartbeat();
        return;
      }

      try {
        if (typeof durableStore.renewLease === "function") {
          const renewed = await durableStore.renewLease({
            reservationId: currentHandle.reservationId,
            leaseToken: currentHandle.leaseToken,
            fencingToken: currentHandle.fencingToken,
            additionalSeconds,
            nowEpochSeconds: currentNow
          });
          currentHandle = renewed;
        }
      } catch {
        // If renewal fails (e.g. lease superseded or expired), stop further heartbeat
        stopHeartbeat();
      }
    };

    heartbeatTimer = setInterval(() => {
      void renewLeaseHeartbeat();
    }, intervalMs);
    heartbeatTimer.unref();

    let walletResponse: unknown;
    try {
      walletResponse = await port.sendApprovalRequest(validatedRequest);
    } catch (err) {
      stopHeartbeat();
      return rollbackAndFail(
        "PORT_DISPATCH_FAILED",
        `Wallet transport port failed to dispatch request: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    } finally {
      stopHeartbeat();
    }

    let parsedResponse: HumanApprovalV1;
    try {
      parsedResponse = parseHumanApprovalV1(walletResponse);
    } catch (err) {
      return rollbackAndFail(
        "INVALID_RESPONSE_SCHEMA",
        "Wallet response is not a valid HumanApprovalV1 artifact",
        err
      );
    }

    if (parsedResponse.contractVersion !== AGENTIC_CONTRACT_VERSION) {
      return rollbackAndFail(
        "RESPONSE_BINDING_MISMATCH",
        `Wallet response contractVersion (${parsedResponse.contractVersion}) does not match expected (${AGENTIC_CONTRACT_VERSION})`
      );
    }

    if (parsedResponse.requestId !== validatedRequest.requestId) {
      return rollbackAndFail(
        "RESPONSE_BINDING_MISMATCH",
        `Wallet response requestId (${parsedResponse.requestId}) does not match outbound request (${validatedRequest.requestId})`
      );
    }

    if (parsedResponse.intentId !== validatedRequest.intent.intentId) {
      return rollbackAndFail(
        "RESPONSE_BINDING_MISMATCH",
        `Wallet response intentId (${parsedResponse.intentId}) does not match outbound intent (${validatedRequest.intent.intentId})`
      );
    }

    if (parsedResponse.decisionId !== validatedRequest.policyDecision.decisionId) {
      return rollbackAndFail(
        "RESPONSE_BINDING_MISMATCH",
        `Wallet response decisionId (${parsedResponse.decisionId}) does not match outbound policy decision (${validatedRequest.policyDecision.decisionId})`
      );
    }

    if (parsedResponse.recordedAt < validatedRequest.requestedAt) {
      return rollbackAndFail(
        "RESPONSE_BINDING_MISMATCH",
        `Wallet response recordedAt (${parsedResponse.recordedAt}) cannot precede requestedAt (${validatedRequest.requestedAt})`
      );
    }

    if (parsedResponse.status === "approved") {
      if (!parsedResponse.approver || parsedResponse.approver !== validatedRequest.intent.fromAddress) {
        return rollbackAndFail(
          "RESPONSE_BINDING_MISMATCH",
          `Approved response approver (${parsedResponse.approver ?? "undefined"}) does not match intent fromAddress (${validatedRequest.intent.fromAddress})`
        );
      }
    }

    if (
      parsedResponse.recordedAt >= validatedRequest.intent.expiresAt ||
      parsedResponse.recordedAt >= validatedRequest.policyDecision.expiresAt
    ) {
      return rollbackAndFail(
        "RESPONSE_OUTSIDE_WORKFLOW_WINDOW",
        `Wallet response recordedAt (${parsedResponse.recordedAt}) exceeds canonical workflow validity window (intent.expiresAt=${validatedRequest.intent.expiresAt}, policyDecision.expiresAt=${validatedRequest.policyDecision.expiresAt}, boundary=${canonicalWorkflowExpiry}). Receipt cannot form a canonical AgenticWorkflowV1.`
      );
    }

    if (
      parsedResponse.recordedAt >= validatedRequest.expiresAt &&
      parsedResponse.status !== "expired"
    ) {
      return rollbackAndFail(
        "RESPONSE_EXPIRED_MISMATCH",
        `Wallet response recorded at or after request expiry (${validatedRequest.expiresAt}) must have status 'expired', got '${parsedResponse.status}'`
      );
    }

    // Terminal commit transition:
    // If approved: commits authorized budget.
    // If rejected/expired: locks replay identity to prevent re-dispatch while releasing budget.
    try {
      await durableStore.commitAuthorization({
        reservationId: currentHandle.reservationId,
        leaseToken: currentHandle.leaseToken,
        fencingToken: currentHandle.fencingToken,
        nowEpochSeconds: getValidNowEpochSeconds(),
        approvalStatus: parsedResponse.status
      });
    } catch (err) {
      if (err instanceof DurableStoreError) {
        if (err.code === "LEASE_EXPIRED") {
          throw new WalletApprovalTransportError(
            "LEASE_EXPIRED",
            `Reservation lease expired before commit could complete: ${err.message}`,
            err
          );
        }
        if (err.code === "LEASE_SUPERSEDED") {
          throw new WalletApprovalTransportError(
            "LEASE_SUPERSEDED",
            `Reservation lease was superseded or invalidated: ${err.message}`,
            err
          );
        }
      }
      throw new WalletApprovalTransportError(
        "STORE_UNAVAILABLE",
        `Failed to commit reservation in durable store: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    return parsedResponse;
  }

  return {
    validateOutboundRequest,
    formatAuditDisplay,
    dispatchApprovalRequest,
    pruneExpired: () => {
      const now = getValidNowEpochSeconds();
      return durableStore.pruneExpired({ nowEpochSeconds: now });
    },
    getReplayCacheStats: () => {
      const stats = durableStore.getStats();
      if (stats instanceof Promise) {
        return stats.then((s) => ({ pending: s.pending, committed: s.committed }));
      }
      return {
        pending: stats.pending,
        committed: stats.committed
      };
    },
    getDailySpending: (spending: DurableSpendingIdentity, utcDate?: string) => {
      const now = getValidNowEpochSeconds();
      const date = utcDate ?? getDeterministicUtcDateString(now);
      return durableStore.getDailySpending(spending, date, now);
    },
    durableStore
  };
}
