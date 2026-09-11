/**
 * @file sqliteStore.ts
 *
 * ACID SQLite Reference Adapter for Durable Authorization State
 *
 * Concurrency & Integrity Model:
 * - Backed by native Node.js DatabaseSync (node:sqlite).
 * - WAL mode (PRAGMA journal_mode = WAL) enabled for non-blocking concurrent readers.
 * - Explicit write transactions using BEGIN IMMEDIATE to serialize concurrent reservations
 *   and prevent deadlocks / lock starvation.
 * - Enforces database-level UNIQUE partial indexes across active identifiers
 *   (requestId, intentId, intentNonce, x402InvoiceHash, x402Nonce).
 * - Transactional cumulative daily accounting per (agentId, fromAddress, network, utcDate).
 * - Lease ownership model with leaseTokens, fencingTokens, and deterministic stale reclamation.
 * - Fail-closed: DB locks beyond busyTimeout, IO errors, or corruption reject authorization.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DurableStoreError } from "./errors";
import {
  formatSpendingKey,
  getDeterministicUtcDateString,
  type CommitAuthorizationInput,
  type DailySpendingStats,
  type DurableAuthorizationStore,
  type DurableReplayIdentifiers,
  type DurableReservationHandle,
  type DurableSpendingIdentity,
  type DurableStoreStats,
  type PruneExpiredInput,
  type ReclaimStaleReservationsInput,
  type RenewLeaseInput,
  type ReserveAuthorizationInput
} from "./types";

export interface SqliteStoreConfig {
  /**
   * Path to SQLite file on disk, or ":memory:" for in-process memory instance.
   */
  dbPath?: string;
  /**
   * Timeout in milliseconds to wait for busy locks. Defaults to 5000ms.
   */
  busyTimeoutMs?: number;
  /**
   * Default lease duration in seconds for pending reservations. Defaults to 60s.
   */
  defaultLeaseDurationSeconds?: number;
  /**
   * Flag indicating this instance is explicitly an in-memory simulation.
   */
  isSimulation?: boolean;
}

/**
 * Fail-closed validation for fencingToken:
 * Must be a positive safe integer (> 0).
 * Throws LEASE_SUPERSEDED if missing, undefined, NaN, infinite, non-integer, unsafe, or <= 0.
 */
function validateFencingToken(fencingToken: unknown): number {
  if (
    typeof fencingToken !== "number" ||
    Number.isNaN(fencingToken) ||
    !Number.isFinite(fencingToken) ||
    !Number.isInteger(fencingToken) ||
    !Number.isSafeInteger(fencingToken) ||
    fencingToken <= 0
  ) {
    throw new DurableStoreError(
      "LEASE_SUPERSEDED",
      `Invalid or missing fencing token: expected positive safe integer, received ${String(fencingToken)}`
    );
  }
  return fencingToken;
}

export class SqliteDurableAuthorizationStore implements DurableAuthorizationStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly busyTimeoutMs: number;
  private readonly defaultLeaseDurationSeconds: number;
  private isClosed: boolean = false;

  constructor(config: SqliteStoreConfig = {}) {
    const isExplicitSimulation = config.isSimulation === true;
    const isMemoryPath = !config.dbPath || config.dbPath === ":memory:";

    if (isMemoryPath && !isExplicitSimulation) {
      throw new DurableStoreError(
        "STORE_UNAVAILABLE",
        "In-memory SQLite storage (:memory:) is strictly prohibited in production. Explicit isSimulation: true is required."
      );
    }

    this.dbPath = config.dbPath ?? ":memory:";
    this.busyTimeoutMs = config.busyTimeoutMs ?? 5000;
    this.defaultLeaseDurationSeconds = config.defaultLeaseDurationSeconds ?? 60;

    try {
      this.db = new DatabaseSync(this.dbPath);
      this.initializeDatabase();
    } catch (err) {
      if (err instanceof DurableStoreError) throw err;
      throw new DurableStoreError(
        "STORE_UNAVAILABLE",
        `Failed to initialize SQLite authorization store at '${this.dbPath}': ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  private initializeDatabase(): void {
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
      this.db.exec("PRAGMA synchronous = NORMAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS authorization_reservations (
          reservation_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          intent_id TEXT NOT NULL,
          intent_nonce TEXT NOT NULL,
          x402_invoice_hash TEXT,
          x402_nonce TEXT,
          agent_id TEXT NOT NULL,
          from_address TEXT NOT NULL,
          network TEXT NOT NULL,
          utc_date TEXT NOT NULL,
          amount_sats TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('PENDING', 'COMMITTED', 'ROLLED_BACK', 'EXPIRED')),
          approval_status TEXT CHECK(approval_status IN ('approved', 'rejected', 'expired')),
          owner_id TEXT NOT NULL,
          lease_token TEXT NOT NULL,
          fencing_token INTEGER NOT NULL,
          lease_expires_at INTEGER NOT NULL,
          request_requested_at INTEGER NOT NULL,
          request_expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          rollback_reason TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_res_request_id
          ON authorization_reservations(request_id)
          WHERE state IN ('PENDING', 'COMMITTED');

        CREATE UNIQUE INDEX IF NOT EXISTS uq_res_intent_id
          ON authorization_reservations(intent_id)
          WHERE state IN ('PENDING', 'COMMITTED');

        CREATE UNIQUE INDEX IF NOT EXISTS uq_res_intent_nonce
          ON authorization_reservations(intent_nonce)
          WHERE state IN ('PENDING', 'COMMITTED');

        CREATE UNIQUE INDEX IF NOT EXISTS uq_res_x402_invoice_hash
          ON authorization_reservations(x402_invoice_hash)
          WHERE x402_invoice_hash IS NOT NULL AND state IN ('PENDING', 'COMMITTED');

        CREATE UNIQUE INDEX IF NOT EXISTS uq_res_x402_nonce
          ON authorization_reservations(x402_nonce)
          WHERE x402_nonce IS NOT NULL AND state IN ('PENDING', 'COMMITTED');

        CREATE INDEX IF NOT EXISTS idx_res_spending
          ON authorization_reservations(agent_id, from_address, network, utc_date, state, lease_expires_at);

        CREATE INDEX IF NOT EXISTS idx_res_stale
          ON authorization_reservations(state, lease_expires_at);

        CREATE INDEX IF NOT EXISTS idx_res_expiry
          ON authorization_reservations(state, request_expires_at);

        CREATE TABLE IF NOT EXISTS authorization_daily_spending (
          spending_key TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          from_address TEXT NOT NULL,
          network TEXT NOT NULL,
          utc_date TEXT NOT NULL,
          committed_sats TEXT NOT NULL,
          day_end_epoch INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_daily_spending_prune
          ON authorization_daily_spending(day_end_epoch);
      `);
    } catch (err) {
      throw new DurableStoreError(
        "SCHEMA_ERROR",
        `Failed to run database schema migrations: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  private ensureOpen(): void {
    if (this.isClosed) {
      throw new DurableStoreError(
        "STORE_UNAVAILABLE",
        "Durable authorization store is closed. All operations fail closed."
      );
    }
  }

  private mapSqliteError(err: unknown, defaultCode: "STORE_UNAVAILABLE" | "REPLAY_DETECTED" = "STORE_UNAVAILABLE"): DurableStoreError {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE constraint failed")) {
      return new DurableStoreError(
        "REPLAY_DETECTED",
        `Durable replay constraint violation: ${msg}`,
        err
      );
    }
    if (msg.includes("database is locked") || msg.includes("busy")) {
      return new DurableStoreError(
        "STORE_UNAVAILABLE",
        `Database lock contention exceeded timeout (${this.busyTimeoutMs}ms): ${msg}`,
        err
      );
    }
    return new DurableStoreError(defaultCode, msg, err);
  }

  /**
   * Atomically validates replay identities and cumulative daily budget,
   * then reserves replay identities and monetary budget under BEGIN IMMEDIATE.
   */
  reserveAuthorization(input: ReserveAuthorizationInput): DurableReservationHandle {
    this.ensureOpen();

    const now = input.nowEpochSeconds;
    if (
      typeof now !== "number" ||
      !Number.isFinite(now) ||
      !Number.isInteger(now) ||
      now < 0
    ) {
      throw new DurableStoreError("INVALID_CLOCK", `Invalid nowEpochSeconds: ${now}`);
    }

    const amountSats = BigInt(input.amountSats);
    if (amountSats < 0n) {
      throw new DurableStoreError("MONETARY_LIMIT_EXCEEDED", `Negative amountSats is invalid: ${amountSats}`);
    }

    const utcDate = getDeterministicUtcDateString(now);

    const leaseDuration = Math.max(
      1,
      input.leaseDurationSeconds ?? this.defaultLeaseDurationSeconds
    );
    const leaseExpiresAt = now + leaseDuration;

    try {
      this.db.exec("BEGIN IMMEDIATE;");
    } catch (err) {
      throw this.mapSqliteError(err, "STORE_UNAVAILABLE");
    }

    try {
      // Step 1: Reclaim any stale pending reservations for this specific request or globally if expired
      this.db.prepare(`
        UPDATE authorization_reservations
        SET state = 'EXPIRED', updated_at = ?
        WHERE state = 'PENDING' AND lease_expires_at <= ?;
      `).run(now, now);

      // Step 2: Validate that replay identifiers are not pending or committed
      const conflictCheck = this.db.prepare(`
        SELECT reservation_id, state, request_id, intent_id, intent_nonce, x402_invoice_hash, x402_nonce
        FROM authorization_reservations
        WHERE (
          request_id = ? OR
          intent_id = ? OR
          intent_nonce = ? OR
          (? IS NOT NULL AND x402_invoice_hash = ?) OR
          (? IS NOT NULL AND x402_nonce = ?)
        ) AND state IN ('PENDING', 'COMMITTED')
        LIMIT 1;
      `).get(
        input.identifiers.requestId,
        input.identifiers.intentId,
        input.identifiers.intentNonce,
        input.identifiers.x402InvoiceHash ?? null,
        input.identifiers.x402InvoiceHash ?? null,
        input.identifiers.x402Nonce ?? null,
        input.identifiers.x402Nonce ?? null
      ) as Record<string, any> | undefined;

      if (conflictCheck) {
        throw new DurableStoreError(
          "REPLAY_DETECTED",
          `Replay detected in state '${conflictCheck.state}' for identifier: ` +
          `requestId=${conflictCheck.request_id}, intentId=${conflictCheck.intent_id}, nonce=${conflictCheck.intent_nonce}`
        );
      }

      // Step 3: Transactionally check cumulative daily spending if configured
      // Key binds: agentId, fromAddress, network, and utcDate
      if (input.dailyLimitSats !== undefined) {
        const dailyLimitSats = BigInt(input.dailyLimitSats);
        const spendingKey = formatSpendingKey(
          input.spending.agentId,
          input.spending.fromAddress,
          input.spending.network,
          utcDate
        );

        // Committed spending is durably preserved in authorization_daily_spending through end of UTC day
        const committedRow = this.db.prepare(`
          SELECT committed_sats
          FROM authorization_daily_spending
          WHERE spending_key = ?;
        `).get(spendingKey) as { committed_sats: string } | undefined;

        const currentCommittedSats = committedRow ? BigInt(committedRow.committed_sats) : 0n;

        // Pending reservations currently active and unexpired
        const pendingRows = this.db.prepare(`
          SELECT amount_sats
          FROM authorization_reservations
          WHERE agent_id = ?
            AND from_address = ?
            AND network = ?
            AND utc_date = ?
            AND state = 'PENDING'
            AND lease_expires_at > ?;
        `).all(
          input.spending.agentId,
          input.spending.fromAddress,
          input.spending.network,
          utcDate,
          now
        ) as Array<{ amount_sats: string }>;

        let currentPendingTotal = 0n;
        for (const row of pendingRows) {
          currentPendingTotal += BigInt(row.amount_sats);
        }

        if (currentCommittedSats + currentPendingTotal + amountSats > dailyLimitSats) {
          throw new DurableStoreError(
            "MONETARY_LIMIT_EXCEEDED",
            `Cumulative daily authorization limit exceeded for spending key '${spendingKey}': current committed=${currentCommittedSats} sats, active reserved=${currentPendingTotal} sats, requested=${amountSats} sats, dailyLimit=${dailyLimitSats} sats`
          );
        }
      }

      // Step 4: Atomically reserve replay identities & monetary budget
      const reservationId = randomUUID();
      const leaseToken = randomUUID();
      const fencingToken = 1;

      this.db.prepare(`
        INSERT INTO authorization_reservations (
          reservation_id,
          request_id,
          intent_id,
          intent_nonce,
          x402_invoice_hash,
          x402_nonce,
          agent_id,
          from_address,
          network,
          utc_date,
          amount_sats,
          state,
          approval_status,
          owner_id,
          lease_token,
          fencing_token,
          lease_expires_at,
          request_requested_at,
          request_expires_at,
          created_at,
          updated_at
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, 'PENDING',
          NULL,
          ?, ?, ?, ?,
          ?, ?, ?, ?
        );
      `).run(
        reservationId,
        input.identifiers.requestId,
        input.identifiers.intentId,
        input.identifiers.intentNonce,
        input.identifiers.x402InvoiceHash ?? null,
        input.identifiers.x402Nonce ?? null,
        input.spending.agentId,
        input.spending.fromAddress,
        input.spending.network,
        utcDate,
        amountSats.toString(),
        input.ownerId,
        leaseToken,
        fencingToken,
        leaseExpiresAt,
        input.requestRequestedAt,
        input.requestExpiresAt,
        now,
        now
      );

      this.db.exec("COMMIT;");

      return {
        reservationId,
        leaseToken,
        fencingToken,
        leaseExpiresAt,
        identifiers: input.identifiers,
        amountSats
      };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      if (err instanceof DurableStoreError) {
        throw err;
      }
      throw this.mapSqliteError(err);
    }
  }

  /**
   * Idempotently and ownership-safely commits a reservation upon valid HumanApprovalV1 receipt.
   * If approvalStatus === 'approved': commits the authorized budget.
   * If approvalStatus !== 'approved': commits replay protection and releases the daily budget (amount_sats set to 0).
   */
  commitAuthorization(input: CommitAuthorizationInput): void {
    this.ensureOpen();
    const fencingToken = validateFencingToken(input.fencingToken);
    const now = input.nowEpochSeconds;
    const approvalStatus = input.approvalStatus ?? "approved";

    try {
      this.db.exec("BEGIN IMMEDIATE;");
    } catch (err) {
      throw this.mapSqliteError(err, "STORE_UNAVAILABLE");
    }

    try {
      const record = this.db.prepare(`
        SELECT *
        FROM authorization_reservations
        WHERE reservation_id = ?;
      `).get(input.reservationId) as Record<string, any> | undefined;

      if (!record) {
        throw new DurableStoreError(
          "RESERVATION_NOT_FOUND",
          `Reservation '${input.reservationId}' not found`
        );
      }

      // Mandatory ownership and fencing generation verification:
      // leaseToken alone MUST NEVER authorize a state transition or idempotent success.
      if (record.lease_token !== input.leaseToken) {
        throw new DurableStoreError(
          "LEASE_SUPERSEDED",
          `Commit rejected: lease token mismatch for reservation '${input.reservationId}'`
        );
      }

      if (Number(record.fencing_token) !== fencingToken) {
        throw new DurableStoreError(
          "LEASE_SUPERSEDED",
          `Commit rejected: fencing token generation mismatch for reservation '${input.reservationId}'. Expected ${record.fencing_token}, received ${fencingToken}`
        );
      }

      // Idempotent commit: ONLY allowed if caller holds the matching leaseToken AND the exact current fencing_token
      if (record.state === "COMMITTED") {
        this.db.exec("COMMIT;");
        return;
      }

      if (record.state === "ROLLED_BACK") {
        throw new DurableStoreError(
          "LEASE_SUPERSEDED",
          `Commit rejected: reservation '${input.reservationId}' was already rolled back`
        );
      }

      if (record.state === "EXPIRED") {
        throw new DurableStoreError(
          "LEASE_EXPIRED",
          `Commit rejected: reservation '${input.reservationId}' lease expired and was reclaimed`
        );
      }

      if (record.state !== "PENDING") {
        throw new DurableStoreError(
          "LEASE_SUPERSEDED",
          `Commit rejected: reservation '${input.reservationId}' is in unexpected state '${record.state}'`
        );
      }

      if (now >= record.lease_expires_at) {
        // Lease has expired before commit could be recorded
        this.db.prepare(`
          UPDATE authorization_reservations
          SET state = 'EXPIRED', updated_at = ?
          WHERE reservation_id = ?;
        `).run(now, input.reservationId);
        this.db.exec("COMMIT;");
        throw new DurableStoreError(
          "LEASE_EXPIRED",
          `Commit rejected: reservation lease for '${input.reservationId}' expired at ${record.lease_expires_at}, current time is ${now}`
        );
      }

      // Valid commit transition
      if (approvalStatus === "approved") {
        this.db.prepare(`
          UPDATE authorization_reservations
          SET state = 'COMMITTED', approval_status = 'approved', updated_at = ?
          WHERE reservation_id = ?;
        `).run(now, input.reservationId);

        const dayEndEpoch = Math.floor(Date.parse(record.utc_date + "T00:00:00.000Z") / 1000) + 86400;
        const spendingKey = formatSpendingKey(
          record.agent_id,
          record.from_address,
          record.network,
          record.utc_date
        );

        const existingDaily = this.db.prepare(`
          SELECT committed_sats FROM authorization_daily_spending WHERE spending_key = ?;
        `).get(spendingKey) as { committed_sats: string } | undefined;

        if (existingDaily) {
          const newCommitted = (BigInt(existingDaily.committed_sats) + BigInt(record.amount_sats)).toString();
          this.db.prepare(`
            UPDATE authorization_daily_spending
            SET committed_sats = ?, updated_at = ?
            WHERE spending_key = ?;
          `).run(newCommitted, now, spendingKey);
        } else {
          this.db.prepare(`
            INSERT INTO authorization_daily_spending (
              spending_key, agent_id, from_address, network, utc_date,
              committed_sats, day_end_epoch, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
          `).run(
            spendingKey,
            record.agent_id,
            record.from_address,
            record.network,
            record.utc_date,
            record.amount_sats,
            dayEndEpoch,
            now,
            now
          );
        }
      } else {
        // Human rejected or expired: commit replay protection, release budget
        this.db.prepare(`
          UPDATE authorization_reservations
          SET state = 'COMMITTED', approval_status = ?, amount_sats = '0', updated_at = ?
          WHERE reservation_id = ?;
        `).run(approvalStatus, now, input.reservationId);
      }

      this.db.exec("COMMIT;");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      if (err instanceof DurableStoreError) {
        throw err;
      }
      throw this.mapSqliteError(err);
    }
  }

  /**
   * Idempotently rolls back a pending reservation, releasing its reserved budget.
   */
  rollbackAuthorization(input: RollbackAuthorizationInput): void {
    this.ensureOpen();
    const fencingToken = validateFencingToken(input.fencingToken);
    const now = input.nowEpochSeconds;

    try {
      this.db.exec("BEGIN IMMEDIATE;");
    } catch (err) {
      throw this.mapSqliteError(err, "STORE_UNAVAILABLE");
    }

    try {
      const record = this.db.prepare(`
        SELECT reservation_id, state, lease_token, fencing_token
        FROM authorization_reservations
        WHERE reservation_id = ?;
      `).get(input.reservationId) as Record<string, any> | undefined;

      if (!record) {
        throw new DurableStoreError(
          "RESERVATION_NOT_FOUND",
          `Reservation '${input.reservationId}' not found`
        );
      }

      // Mandatory ownership and fencing generation verification:
      // leaseToken alone MUST NEVER authorize a state transition or idempotent success.
      if (record.lease_token !== input.leaseToken) {
        throw new DurableStoreError(
          "LEASE_SUPERSEDED",
          `Rollback rejected: lease token mismatch for reservation '${input.reservationId}'`
        );
      }

      if (Number(record.fencing_token) !== fencingToken) {
        throw new DurableStoreError(
          "LEASE_SUPERSEDED",
          `Rollback rejected: fencing token generation mismatch for reservation '${input.reservationId}'. Expected ${record.fencing_token}, received ${fencingToken}`
        );
      }

      // Idempotent rollback: ONLY allowed if caller holds the matching leaseToken AND the exact current fencing_token
      if (record.state === "ROLLED_BACK") {
        this.db.exec("COMMIT;");
        return;
      }

      if (record.state === "COMMITTED") {
        throw new DurableStoreError(
          "RESERVATION_ALREADY_COMMITTED",
          `Rollback rejected: reservation '${input.reservationId}' has already been committed`
        );
      }

      if (record.state === "EXPIRED") {
        // Already expired, releasing budget is already done
        this.db.exec("COMMIT;");
        return;
      }

      if (record.state === "PENDING") {
        this.db.prepare(`
          UPDATE authorization_reservations
          SET state = 'ROLLED_BACK', rollback_reason = ?, updated_at = ?
          WHERE reservation_id = ?;
        `).run(input.reason ?? null, now, input.reservationId);

        this.db.exec("COMMIT;");
        return;
      }

      throw new DurableStoreError(
        "LEASE_SUPERSEDED",
        `Rollback rejected: reservation in unexpected state '${record.state}'`
      );
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      if (err instanceof DurableStoreError) {
        throw err;
      }
      throw this.mapSqliteError(err);
    }
  }

  /**
   * Renews lease duration for an active reservation.
   */
  renewLease(input: RenewLeaseInput): DurableReservationHandle {
    this.ensureOpen();
    const fencingToken = validateFencingToken(input.fencingToken);
    const now = input.nowEpochSeconds;

    try {
      this.db.exec("BEGIN IMMEDIATE;");
    } catch (err) {
      throw this.mapSqliteError(err, "STORE_UNAVAILABLE");
    }

    try {
      const record = this.db.prepare(`
        SELECT *
        FROM authorization_reservations
        WHERE reservation_id = ?;
      `).get(input.reservationId) as Record<string, any> | undefined;

      if (!record) {
        throw new DurableStoreError("RESERVATION_NOT_FOUND", `Reservation '${input.reservationId}' not found`);
      }

      if (record.state !== "PENDING") {
        throw new DurableStoreError("LEASE_SUPERSEDED", `Cannot renew lease for reservation in state '${record.state}'`);
      }

      // Mandatory ownership and fencing generation verification:
      if (record.lease_token !== input.leaseToken) {
        throw new DurableStoreError("LEASE_SUPERSEDED", `Lease token mismatch on renewal for '${input.reservationId}'`);
      }

      if (Number(record.fencing_token) !== fencingToken) {
        throw new DurableStoreError(
          "LEASE_SUPERSEDED",
          `Renewal rejected: fencing token generation mismatch for reservation '${input.reservationId}'. Expected ${record.fencing_token}, received ${fencingToken}`
        );
      }

      if (now >= record.lease_expires_at) {
        this.db.prepare(`
          UPDATE authorization_reservations
          SET state = 'EXPIRED', updated_at = ?
          WHERE reservation_id = ?;
        `).run(now, input.reservationId);
        this.db.exec("COMMIT;");
        throw new DurableStoreError("LEASE_EXPIRED", `Lease already expired at ${record.lease_expires_at}`);
      }

      const newLeaseExpiresAt = now + input.additionalSeconds;
      const newFencingToken = Number(record.fencing_token) + 1;

      this.db.prepare(`
        UPDATE authorization_reservations
        SET lease_expires_at = ?, fencing_token = ?, updated_at = ?
        WHERE reservation_id = ?;
      `).run(newLeaseExpiresAt, newFencingToken, now, input.reservationId);

      this.db.exec("COMMIT;");

      return {
        reservationId: record.reservation_id,
        leaseToken: record.lease_token,
        fencingToken: newFencingToken,
        leaseExpiresAt: newLeaseExpiresAt,
        identifiers: {
          requestId: record.request_id,
          intentId: record.intent_id,
          intentNonce: record.intent_nonce,
          ...(record.x402_invoice_hash ? { x402InvoiceHash: record.x402_invoice_hash } : {}),
          ...(record.x402_nonce ? { x402Nonce: record.x402_nonce } : {})
        },
        amountSats: BigInt(record.amount_sats)
      };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      if (err instanceof DurableStoreError) {
        throw err;
      }
      throw this.mapSqliteError(err);
    }
  }

  /**
   * Reclaims abandoned pending reservations whose leases have expired (nowEpochSeconds >= leaseExpiresAt).
   */
  reclaimStaleReservations(input: ReclaimStaleReservationsInput): number {
    this.ensureOpen();
    const now = input.nowEpochSeconds;

    try {
      this.db.exec("BEGIN IMMEDIATE;");
    } catch (err) {
      throw this.mapSqliteError(err, "STORE_UNAVAILABLE");
    }

    try {
      const result = this.db.prepare(`
        UPDATE authorization_reservations
        SET state = 'EXPIRED', updated_at = ?
        WHERE state = 'PENDING' AND lease_expires_at <= ?;
      `).run(now, now);

      this.db.exec("COMMIT;");
      return Number(result.changes);
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw this.mapSqliteError(err);
    }
  }

  /**
   * Transactionally prunes expired records whose canonical validity window has elapsed.
   */
  pruneExpired(input: PruneExpiredInput | number): number {
    this.ensureOpen();
    const now = typeof input === "number" ? input : input.nowEpochSeconds;
    const retentionSeconds = typeof input === "number" ? 86400 : (input.retentionSeconds ?? 86400); // 24 hour retention for terminal records
    const terminalRetentionCutoff = now - retentionSeconds;

    try {
      this.db.exec("BEGIN IMMEDIATE;");
    } catch (err) {
      throw this.mapSqliteError(err, "STORE_UNAVAILABLE");
    }

    try {
      const result = this.db.prepare(`
        DELETE FROM authorization_reservations
        WHERE (state = 'COMMITTED' AND request_expires_at <= ?)
           OR (state IN ('ROLLED_BACK', 'EXPIRED') AND updated_at <= ?);
      `).run(now, terminalRetentionCutoff);

      this.db.prepare(`
        DELETE FROM authorization_daily_spending
        WHERE day_end_epoch <= ?;
      `).run(terminalRetentionCutoff);

      this.db.exec("COMMIT;");
      return Number(result.changes);
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw this.mapSqliteError(err);
    }
  }

  /**
   * Reads cumulative daily spending breakdown for a specific spending identity on a UTC day.
   */
  getDailySpending(
    spending: DurableSpendingIdentity,
    utcDate: string,
    nowEpochSeconds: number
  ): DailySpendingStats {
    this.ensureOpen();

    const spendingKey = formatSpendingKey(spending.agentId, spending.fromAddress, spending.network, utcDate);
    const committedRow = this.db.prepare(`
      SELECT committed_sats
      FROM authorization_daily_spending
      WHERE spending_key = ?;
    `).get(spendingKey) as { committed_sats: string } | undefined;

    const committedSats = committedRow ? BigInt(committedRow.committed_sats) : 0n;

    const pendingRows = this.db.prepare(`
      SELECT amount_sats
      FROM authorization_reservations
      WHERE agent_id = ?
        AND from_address = ?
        AND network = ?
        AND utc_date = ?
        AND state = 'PENDING'
        AND lease_expires_at > ?;
    `).all(
      spending.agentId,
      spending.fromAddress,
      spending.network,
      utcDate,
      nowEpochSeconds
    ) as Array<{ amount_sats: string }>;

    let reservedSats = 0n;
    for (const row of pendingRows) {
      reservedSats += BigInt(row.amount_sats);
    }

    return {
      committedSats,
      reservedSats,
      totalSats: committedSats + reservedSats
    };
  }

  /**
   * Returns current counts across states.
   */
  getStats(): DurableStoreStats {
    this.ensureOpen();

    const rows = this.db.prepare(`
      SELECT state, COUNT(*) as cnt
      FROM authorization_reservations
      GROUP BY state;
    `).all() as Array<{ state: string; cnt: number | bigint }>;

    let pending = 0;
    let committed = 0;
    let rolledBack = 0;
    let expired = 0;

    for (const r of rows) {
      const count = Number(r.cnt);
      if (r.state === "PENDING") pending = count;
      else if (r.state === "COMMITTED") committed = count;
      else if (r.state === "ROLLED_BACK") rolledBack = count;
      else if (r.state === "EXPIRED") expired = count;
    }

    return { pending, committed, rolledBack, expired };
  }

  /**
   * Closes store connections.
   */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    try {
      this.db.close();
    } catch {}
  }
}

export function createSqliteDurableStore(
  config: SqliteStoreConfig = {}
): SqliteDurableAuthorizationStore {
  return new SqliteDurableAuthorizationStore(config);
}
