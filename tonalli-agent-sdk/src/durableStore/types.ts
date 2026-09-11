/**
 * @file types.ts
 *
 * Abstract Transactional Authorization / CAE State Store Contract
 *
 * Authority & Governance Boundary:
 * - Authoritative coordination boundary for:
 *   - Replay prevention (requestId, intentId, intentNonce, x402InvoiceHash, x402Nonce);
 *   - Atomic concurrent reservation exclusion across independent processes;
 *   - Cumulative daily authorization limit accounting (committed + active reserved + requested <= dailyLimit);
 *   - Lease ownership, fencing tokens, and safe stale-reservation reclamation;
 *   - Safe process restart, DB reopening, and deterministic UTC rollover;
 *   - Transactional, fail-closed isolation under ACID storage backends.
 *
 * Classification:
 * - Authorization-only. Represents authorized budget before signing/settlement.
 * - ZERO transaction construction, ZERO private keys, ZERO signing, ZERO Chronik broadcast, ZERO settlement.
 */

export type ReservationState = "PENDING" | "COMMITTED" | "ROLLED_BACK" | "EXPIRED";
export type ApprovalStatus = "approved" | "rejected" | "expired";

export interface DurableReplayIdentifiers {
  readonly requestId: string;
  readonly intentId: string;
  readonly intentNonce: string;
  readonly x402InvoiceHash?: string;
  readonly x402Nonce?: string;
}

export interface DurableSpendingIdentity {
  readonly agentId: string;
  readonly fromAddress: string;
  readonly network: "xec:mainnet";
}

export interface ReserveAuthorizationInput {
  readonly identifiers: DurableReplayIdentifiers;
  readonly spending: DurableSpendingIdentity;
  readonly amountSats: bigint;
  readonly dailyLimitSats?: bigint;
  readonly requestRequestedAt: number;
  readonly requestExpiresAt: number;
  readonly nowEpochSeconds: number;
  readonly ownerId: string;
  readonly leaseDurationSeconds?: number;
}

export interface DurableReservationHandle {
  readonly reservationId: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: number;
  readonly identifiers: DurableReplayIdentifiers;
  readonly amountSats: bigint;
}

export interface CommitAuthorizationInput {
  readonly reservationId: string;
  readonly leaseToken: string;
  readonly fencingToken?: number;
  readonly nowEpochSeconds: number;
  readonly approvalStatus?: ApprovalStatus;
}

export interface RollbackAuthorizationInput {
  readonly reservationId: string;
  readonly leaseToken: string;
  readonly fencingToken?: number;
  readonly nowEpochSeconds: number;
  readonly reason?: string;
}

export interface ReclaimStaleReservationsInput {
  readonly nowEpochSeconds: number;
}

export interface PruneExpiredInput {
  readonly nowEpochSeconds: number;
  readonly retentionSeconds?: number;
}

export interface RenewLeaseInput {
  readonly reservationId: string;
  readonly leaseToken: string;
  readonly fencingToken?: number;
  readonly additionalSeconds: number;
  readonly nowEpochSeconds: number;
}

export interface DurableStoreStats {
  readonly pending: number;
  readonly committed: number;
  readonly rolledBack: number;
  readonly expired: number;
}

export interface DailySpendingStats {
  readonly committedSats: bigint;
  readonly reservedSats: bigint;
  readonly totalSats: bigint;
}

export interface StoredReservationRecord {
  readonly reservationId: string;
  readonly requestId: string;
  readonly intentId: string;
  readonly intentNonce: string;
  readonly x402InvoiceHash: string | null;
  readonly x402Nonce: string | null;
  readonly agentId: string;
  readonly fromAddress: string;
  readonly network: string;
  readonly utcDate: string;
  readonly amountSats: string;
  readonly state: ReservationState;
  readonly approvalStatus: ApprovalStatus | null;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: number;
  readonly requestRequestedAt: number;
  readonly requestExpiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly rollbackReason: string | null;
}

/**
 * Explicit storage contract owned by tonalli-agents.
 * Any ACID storage backend (SQLite WAL, PostgreSQL, etc.) must implement this contract.
 */
export interface DurableAuthorizationStore {
  /**
   * Atomically in ONE transaction:
   * 1. Validates that replay identifiers are not pending or committed;
   * 2. Validates cumulative daily budget if configured (committed + active reserved + requested <= dailyLimit);
   * 3. Reserves replay identities under database unique constraints;
   * 4. Reserves monetary budget;
   * 5. Returns an opaque reservation handle with lease token and fencing token.
   */
  reserveAuthorization(
    input: ReserveAuthorizationInput
  ): Promise<DurableReservationHandle> | DurableReservationHandle;

  /**
   * Idempotently commits an active reservation owned by the lease handle.
   * If approvalStatus is 'approved', commits the authorized budget.
   * If approvalStatus is 'rejected' or 'expired', commits the replay identity to prevent re-dispatch
   * while releasing the reserved daily budget.
   * Fails closed if the lease has expired, been superseded, or was rolled back.
   */
  commitAuthorization(
    input: CommitAuthorizationInput
  ): Promise<void> | void;

  /**
   * Idempotently rolls back an active reservation and releases its reserved budget.
   * Fails closed if the reservation is already committed or if lease token is invalid.
   */
  rollbackAuthorization(
    input: RollbackAuthorizationInput
  ): Promise<void> | void;

  /**
   * Extends the lease duration of an active pending reservation held by the owner.
   */
  renewLease?(
    input: RenewLeaseInput
  ): Promise<DurableReservationHandle> | DurableReservationHandle;

  /**
   * Reclaims abandoned pending reservations whose leases have expired (nowEpochSeconds >= leaseExpiresAt),
   * transitioning them to EXPIRED and releasing their reserved budget.
   */
  reclaimStaleReservations(
    input: ReclaimStaleReservationsInput
  ): Promise<number> | number;

  /**
   * Transactionally prunes expired records whose canonical validity window has elapsed.
   */
  pruneExpired(
    input: PruneExpiredInput
  ): Promise<number> | number;

  /**
   * Returns cumulative daily spending breakdown for a given spending identity on a UTC day.
   */
  getDailySpending(
    spending: DurableSpendingIdentity,
    utcDate: string,
    nowEpochSeconds: number
  ): Promise<DailySpendingStats> | DailySpendingStats;

  /**
   * Returns current counts across reservation states.
   */
  getStats(): Promise<DurableStoreStats> | DurableStoreStats;

  /**
   * Closes store connections cleanly.
   */
  close(): Promise<void> | void;
}

/**
 * Returns deterministic UTC calendar date string "YYYY-MM-DD" from unix epoch seconds.
 * Strictly independent of host timezone.
 */
export function getDeterministicUtcDateString(epochSeconds: number): string {
  if (
    typeof epochSeconds !== "number" ||
    !Number.isFinite(epochSeconds) ||
    !Number.isInteger(epochSeconds) ||
    epochSeconds < 0
  ) {
    throw new Error(`Invalid epochSeconds for UTC date conversion: ${epochSeconds}`);
  }
  const date = new Date(epochSeconds * 1000);
  return date.toISOString().slice(0, 10);
}

/**
 * Formats canonical accounting key for cumulative daily spending.
 * Binds agentId, funding address, network domain, and UTC calendar date.
 */
export function formatSpendingKey(
  agentId: string,
  fromAddress: string,
  network: string,
  utcDate: string
): string {
  return `${agentId}:${fromAddress}:${network}:${utcDate}`;
}
