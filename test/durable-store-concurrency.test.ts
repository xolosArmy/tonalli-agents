import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createSqliteDurableStore,
  DurableStoreError,
  getDeterministicUtcDateString
} from "../src/durableStore";
import {
  createWalletApprovalTransport,
  WalletApprovalTransportError,
  type WalletApprovalTransportPort
} from "../src/wallet/approvalTransport";
import { AGENTIC_CONTRACT_VERSION } from "@xolosarmy/tonalli-core";

const cleanupFiles = (basePath: string) => {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(basePath + ext);
    } catch {}
  }
};

const FROM_ADDRESS = "ecash:qp3wjpa3tjlj042z2wv7hahvd8whzgcwvue2swknmw";
const BASE_SPENDING = {
  agentId: "agent-multi-worker-1",
  fromAddress: FROM_ADDRESS,
  network: "xec:mainnet" as const
};

test("Durable Store Concurrency & ACID Integrity Test Suite", async (t) => {
  const tmpDir = os.tmpdir();
  const dbFile = path.join(tmpDir, `durable-test-${randomUUID()}.db`);

  t.after(() => {
    cleanupFiles(dbFile);
  });

  // 1. Same requestId race
  await t.test("Scenario 1: same requestId race across 2 store clients", async () => {
    const storeA = createSqliteDurableStore({ dbPath: dbFile });
    const storeB = createSqliteDurableStore({ dbPath: dbFile });

    const sharedRequestId = `req-race-${randomUUID()}`;

    const taskA = () =>
      storeA.reserveAuthorization({
        identifiers: {
          requestId: sharedRequestId,
          intentId: `intent-a-${randomUUID()}`,
          intentNonce: `nonce-a-${randomUUID()}`
        },
        spending: BASE_SPENDING,
        amountSats: 10n,
        dailyLimitSats: 1000n,
        requestRequestedAt: 1770000000,
        requestExpiresAt: 1770000300,
        nowEpochSeconds: 1770000005,
        ownerId: "worker-A"
      });

    const taskB = () =>
      storeB.reserveAuthorization({
        identifiers: {
          requestId: sharedRequestId,
          intentId: `intent-b-${randomUUID()}`,
          intentNonce: `nonce-b-${randomUUID()}`
        },
        spending: BASE_SPENDING,
        amountSats: 10n,
        dailyLimitSats: 1000n,
        requestRequestedAt: 1770000000,
        requestExpiresAt: 1770000300,
        nowEpochSeconds: 1770000005,
        ownerId: "worker-B"
      });

    const results = await Promise.allSettled([
      Promise.resolve().then(taskA),
      Promise.resolve().then(taskB)
    ]);

    const successes = results.filter((r) => r.status === "fulfilled");
    const failures = results.filter((r) => r.status === "rejected");

    assert.equal(successes.length, 1, "Exactly one store client must obtain reservation");
    assert.equal(failures.length, 1, "Competing store client must be rejected");

    const err = (failures[0] as PromiseRejectedResult).reason;
    assert.ok(err instanceof DurableStoreError);
    assert.equal(err.code, "REPLAY_DETECTED");

    storeA.close();
    storeB.close();
  });
  // 2. Same intentId race
  await t.test("Scenario 2: same intentId race across 2 store clients", async () => {
    const storeA = createSqliteDurableStore({ dbPath: dbFile });
    const storeB = createSqliteDurableStore({ dbPath: dbFile });

    const sharedIntentId = `intent-race-${randomUUID()}`;

    const taskA = () =>
      storeA.reserveAuthorization({
        identifiers: {
          requestId: `req-a-${randomUUID()}`,
          intentId: sharedIntentId,
          intentNonce: `nonce-a-${randomUUID()}`
        },
        spending: BASE_SPENDING,
        amountSats: 10n,
        dailyLimitSats: 1000n,
        requestRequestedAt: 1770000000,
        requestExpiresAt: 1770000300,
        nowEpochSeconds: 1770000005,
        ownerId: "worker-A"
      });

    const taskB = () =>
      storeB.reserveAuthorization({
        identifiers: {
          requestId: `req-b-${randomUUID()}`,
          intentId: sharedIntentId,
          intentNonce: `nonce-b-${randomUUID()}`
        },
        spending: BASE_SPENDING,
        amountSats: 10n,
        dailyLimitSats: 1000n,
        requestRequestedAt: 1770000000,
        requestExpiresAt: 1770000300,
        nowEpochSeconds: 1770000005,
        ownerId: "worker-B"
      });

    const results = await Promise.allSettled([
      Promise.resolve().then(taskA),
      Promise.resolve().then(taskB)
    ]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const err = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
    assert.equal(err.code, "REPLAY_DETECTED");

    storeA.close();
    storeB.close();
  });

  // 3. Same AgentIntent nonce race
  await t.test("Scenario 3: same AgentIntent nonce race", async () => {
    const storeA = createSqliteDurableStore({ dbPath: dbFile });
    const storeB = createSqliteDurableStore({ dbPath: dbFile });

    const sharedNonce = `nonce-shared-${randomUUID()}`;

    const taskA = () =>
      storeA.reserveAuthorization({
        identifiers: {
          requestId: `req-a-${randomUUID()}`,
          intentId: `intent-a-${randomUUID()}`,
          intentNonce: sharedNonce
        },
        spending: BASE_SPENDING,
        amountSats: 10n,
        dailyLimitSats: 1000n,
        requestRequestedAt: 1770000000,
        requestExpiresAt: 1770000300,
        nowEpochSeconds: 1770000005,
        ownerId: "worker-A"
      });

    const taskB = () =>
      storeB.reserveAuthorization({
        identifiers: {
          requestId: `req-b-${randomUUID()}`,
          intentId: `intent-b-${randomUUID()}`,
          intentNonce: sharedNonce
        },
        spending: BASE_SPENDING,
        amountSats: 10n,
        dailyLimitSats: 1000n,
        requestRequestedAt: 1770000000,
        requestExpiresAt: 1770000300,
        nowEpochSeconds: 1770000005,
        ownerId: "worker-B"
      });

    const results = await Promise.allSettled([
      Promise.resolve().then(taskA),
      Promise.resolve().then(taskB)
    ]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);

    storeA.close();
    storeB.close();
  });

  // 4. Same x402 invoiceHash race
  await t.test("Scenario 4: same x402 invoiceHash race", async () => {
    const storeA = createSqliteDurableStore({ dbPath: dbFile });
    const storeB = createSqliteDurableStore({ dbPath: dbFile });

    const sharedInvoiceHash = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    const taskA = () =>
      storeA.reserveAuthorization({
        identifiers: {
          requestId: `req-a-${randomUUID()}`,
          intentId: `intent-a-${randomUUID()}`,
          intentNonce: `nonce-a-${randomUUID()}`,
          x402InvoiceHash: sharedInvoiceHash
        },
        spending: BASE_SPENDING,
        amountSats: 10n,
        dailyLimitSats: 1000n,
        requestRequestedAt: 1770000000,
        requestExpiresAt: 1770000300,
        nowEpochSeconds: 1770000005,
        ownerId: "worker-A"
      });

    const taskB = () =>
      storeB.reserveAuthorization({
        identifiers: {
          requestId: `req-b-${randomUUID()}`,
          intentId: `intent-b-${randomUUID()}`,
          intentNonce: `nonce-b-${randomUUID()}`,
          x402InvoiceHash: sharedInvoiceHash
        },
        spending: BASE_SPENDING,
        amountSats: 10n,
        dailyLimitSats: 1000n,
        requestRequestedAt: 1770000000,
        requestExpiresAt: 1770000300,
        nowEpochSeconds: 1770000005,
        ownerId: "worker-B"
      });

    const results = await Promise.allSettled([
      Promise.resolve().then(taskA),
      Promise.resolve().then(taskB)
    ]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);

    storeA.close();
    storeB.close();
  });

  // 5. Same x402 nonce race
  await t.test("Scenario 5: same x402 nonce race", async () => {
    const storeA = createSqliteDurableStore({ dbPath: dbFile });
    const storeB = createSqliteDurableStore({ dbPath: dbFile });

    const sharedX402Nonce = "x402-nonce-concurrency-token-001";

    const taskA = () =>
      storeA.reserveAuthorization({
        identifiers: {
          requestId: `req-a-${randomUUID()}`,
          intentId: `intent-a-${randomUUID()}`,
          intentNonce: `nonce-a-${randomUUID()}`,
          x402Nonce: sharedX402Nonce
        },
        spending: BASE_SPENDING,
        amountSats: 10n,
        dailyLimitSats: 1000n,
        requestRequestedAt: 1770000000,
        requestExpiresAt: 1770000300,
        nowEpochSeconds: 1770000005,
        ownerId: "worker-A"
      });

    const taskB = () =>
      storeB.reserveAuthorization({
        identifiers: {
          requestId: `req-b-${randomUUID()}`,
          intentId: `intent-b-${randomUUID()}`,
          intentNonce: `nonce-b-${randomUUID()}`,
          x402Nonce: sharedX402Nonce
        },
        spending: BASE_SPENDING,
        amountSats: 10n,
        dailyLimitSats: 1000n,
        requestRequestedAt: 1770000000,
        requestExpiresAt: 1770000300,
        nowEpochSeconds: 1770000005,
        ownerId: "worker-B"
      });

    const results = await Promise.allSettled([
      Promise.resolve().then(taskA),
      Promise.resolve().then(taskB)
    ]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);

    storeA.close();
    storeB.close();
  });
  // 6. Distinct requests under daily limit
  await t.test("Scenario 6: distinct requests under daily limit both succeed", async () => {
    const storeA = createSqliteDurableStore({ dbPath: dbFile });
    const storeB = createSqliteDurableStore({ dbPath: dbFile });

    const spending = { ...BASE_SPENDING, agentId: `agent-under-limit-${randomUUID()}` };

    const handleA = storeA.reserveAuthorization({
      identifiers: {
        requestId: `req-under-a-${randomUUID()}`,
        intentId: `intent-under-a-${randomUUID()}`,
        intentNonce: `nonce-under-a-${randomUUID()}`
      },
      spending,
      amountSats: 40n,
      dailyLimitSats: 100n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-A"
    });

    const handleB = storeB.reserveAuthorization({
      identifiers: {
        requestId: `req-under-b-${randomUUID()}`,
        intentId: `intent-under-b-${randomUUID()}`,
        intentNonce: `nonce-under-b-${randomUUID()}`
      },
      spending,
      amountSats: 50n,
      dailyLimitSats: 100n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-B"
    });

    assert.ok(handleA.reservationId);
    assert.ok(handleB.reservationId);

    const spendingStats = storeA.getDailySpending(spending, getDeterministicUtcDateString(1770000005), 1770000005);
    assert.equal(spendingStats.reservedSats, 90n);
    assert.equal(spendingStats.committedSats, 0n);
    assert.equal(spendingStats.totalSats, 90n);

    storeA.close();
    storeB.close();
  });

  // 7. Two requests whose combined amount exceeds daily limit
  await t.test("Scenario 7: two concurrent requests exceeding daily limit (60 + 60 > 100)", async () => {
    const storeA = createSqliteDurableStore({ dbPath: dbFile });
    const storeB = createSqliteDurableStore({ dbPath: dbFile });

    const spending = { ...BASE_SPENDING, agentId: `agent-race-limit-${randomUUID()}` };

    const taskA = () =>
      storeA.reserveAuthorization({
        identifiers: {
          requestId: `req-limit-a-${randomUUID()}`,
          intentId: `intent-limit-a-${randomUUID()}`,
          intentNonce: `nonce-limit-a-${randomUUID()}`
        },
        spending,
        amountSats: 60n,
        dailyLimitSats: 100n,
        requestRequestedAt: 1770000000,
        requestExpiresAt: 1770000300,
        nowEpochSeconds: 1770000005,
        ownerId: "worker-A"
      });

    const taskB = () =>
      storeB.reserveAuthorization({
        identifiers: {
          requestId: `req-limit-b-${randomUUID()}`,
          intentId: `intent-limit-b-${randomUUID()}`,
          intentNonce: `nonce-limit-b-${randomUUID()}`
        },
        spending,
        amountSats: 60n,
        dailyLimitSats: 100n,
        requestRequestedAt: 1770000000,
        requestExpiresAt: 1770000300,
        nowEpochSeconds: 1770000005,
        ownerId: "worker-B"
      });

    const results = await Promise.allSettled([
      Promise.resolve().then(taskA),
      Promise.resolve().then(taskB)
    ]);

    const successes = results.filter((r) => r.status === "fulfilled");
    const failures = results.filter((r) => r.status === "rejected");

    assert.equal(successes.length, 1, "Exactly one worker must succeed");
    assert.equal(failures.length, 1, "Competing worker must exceed daily limit");

    const err = (failures[0] as PromiseRejectedResult).reason;
    assert.ok(err instanceof DurableStoreError);
    assert.equal(err.code, "MONETARY_LIMIT_EXCEEDED");

    storeA.close();
    storeB.close();
  });

  // 8. Concurrent reservations exactly equal to daily limit
  await t.test("Scenario 8: concurrent reservations exactly equal to daily limit (50 + 50 = 100)", async () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });
    const spending = { ...BASE_SPENDING, agentId: `agent-exact-limit-${randomUUID()}` };

    const h1 = store.reserveAuthorization({
      identifiers: {
        requestId: `req-exact-1-${randomUUID()}`,
        intentId: `intent-exact-1-${randomUUID()}`,
        intentNonce: `nonce-exact-1-${randomUUID()}`
      },
      spending,
      amountSats: 50n,
      dailyLimitSats: 100n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-1"
    });

    const h2 = store.reserveAuthorization({
      identifiers: {
        requestId: `req-exact-2-${randomUUID()}`,
        intentId: `intent-exact-2-${randomUUID()}`,
        intentNonce: `nonce-exact-2-${randomUUID()}`
      },
      spending,
      amountSats: 50n,
      dailyLimitSats: 100n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-2"
    });

    assert.ok(h1);
    assert.ok(h2);

    assert.throws(
      () =>
        store.reserveAuthorization({
          identifiers: {
            requestId: `req-exact-3-${randomUUID()}`,
            intentId: `intent-exact-3-${randomUUID()}`,
            intentNonce: `nonce-exact-3-${randomUUID()}`
          },
          spending,
          amountSats: 1n,
          dailyLimitSats: 100n,
          requestRequestedAt: 1770000000,
          requestExpiresAt: 1770000300,
          nowEpochSeconds: 1770000005,
          ownerId: "worker-3"
        }),
      (err: unknown) => {
        assert.ok(err instanceof DurableStoreError);
        assert.equal(err.code, "MONETARY_LIMIT_EXCEEDED");
        return true;
      }
    );

    store.close();
  });
  // 9. Commit vs rollback race
  await t.test("Scenario 9: commit vs rollback race", async () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });
    const h = store.reserveAuthorization({
      identifiers: {
        requestId: `req-c-vs-r-${randomUUID()}`,
        intentId: `intent-c-vs-r-${randomUUID()}`,
        intentNonce: `nonce-c-vs-r-${randomUUID()}`
      },
      spending: BASE_SPENDING,
      amountSats: 10n,
      dailyLimitSats: 1000n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-c-r"
    });

    const commitAction = () =>
      store.commitAuthorization({
        reservationId: h.reservationId,
        leaseToken: h.leaseToken,
        nowEpochSeconds: 1770000010,
        approvalStatus: "approved"
      });

    const rollbackAction = () =>
      store.rollbackAuthorization({
        reservationId: h.reservationId,
        leaseToken: h.leaseToken,
        nowEpochSeconds: 1770000010,
        reason: "race_rollback"
      });

    const results = await Promise.allSettled([
      Promise.resolve().then(commitAction),
      Promise.resolve().then(rollbackAction)
    ]);

    const successes = results.filter((r) => r.status === "fulfilled");
    const failures = results.filter((r) => r.status === "rejected");
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);

    store.close();
  });

  // 10. Duplicate commit is idempotent
  await t.test("Scenario 10: duplicate commit idempotency", () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });
    const h = store.reserveAuthorization({
      identifiers: {
        requestId: `req-dup-commit-${randomUUID()}`,
        intentId: `intent-dup-commit-${randomUUID()}`,
        intentNonce: `nonce-dup-commit-${randomUUID()}`
      },
      spending: BASE_SPENDING,
      amountSats: 10n,
      dailyLimitSats: 1000n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-dup-commit"
    });

    store.commitAuthorization({
      reservationId: h.reservationId,
      leaseToken: h.leaseToken,
      nowEpochSeconds: 1770000010
    });

    assert.doesNotThrow(() => {
      store.commitAuthorization({
        reservationId: h.reservationId,
        leaseToken: h.leaseToken,
        nowEpochSeconds: 1770000011
      });
    });

    store.close();
  });

  // 11. Duplicate rollback is idempotent
  await t.test("Scenario 11: duplicate rollback idempotency", () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });
    const h = store.reserveAuthorization({
      identifiers: {
        requestId: `req-dup-rollback-${randomUUID()}`,
        intentId: `intent-dup-rollback-${randomUUID()}`,
        intentNonce: `nonce-dup-rollback-${randomUUID()}`
      },
      spending: BASE_SPENDING,
      amountSats: 10n,
      dailyLimitSats: 1000n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-dup-rollback"
    });

    store.rollbackAuthorization({
      reservationId: h.reservationId,
      leaseToken: h.leaseToken,
      nowEpochSeconds: 1770000010
    });

    assert.doesNotThrow(() => {
      store.rollbackAuthorization({
        reservationId: h.reservationId,
        leaseToken: h.leaseToken,
        nowEpochSeconds: 1770000011
      });
    });

    store.close();
  });

  // 12. Rollback after commit fails closed
  await t.test("Scenario 12: rollback after commit fails closed", () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });
    const h = store.reserveAuthorization({
      identifiers: {
        requestId: `req-rb-after-c-${randomUUID()}`,
        intentId: `intent-rb-after-c-${randomUUID()}`,
        intentNonce: `nonce-rb-after-c-${randomUUID()}`
      },
      spending: BASE_SPENDING,
      amountSats: 10n,
      dailyLimitSats: 1000n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-rb-c"
    });

    store.commitAuthorization({
      reservationId: h.reservationId,
      leaseToken: h.leaseToken,
      nowEpochSeconds: 1770000010
    });

    assert.throws(
      () =>
        store.rollbackAuthorization({
          reservationId: h.reservationId,
          leaseToken: h.leaseToken,
          nowEpochSeconds: 1770000011
        }),
      (err: unknown) => {
        assert.ok(err instanceof DurableStoreError);
        assert.equal(err.code, "RESERVATION_ALREADY_COMMITTED");
        return true;
      }
    );

    store.close();
  });

  // 13. Commit after rollback fails closed
  await t.test("Scenario 13: commit after rollback fails closed", () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });
    const h = store.reserveAuthorization({
      identifiers: {
        requestId: `req-c-after-rb-${randomUUID()}`,
        intentId: `intent-c-after-rb-${randomUUID()}`,
        intentNonce: `nonce-c-after-rb-${randomUUID()}`
      },
      spending: BASE_SPENDING,
      amountSats: 10n,
      dailyLimitSats: 1000n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-c-rb"
    });

    store.rollbackAuthorization({
      reservationId: h.reservationId,
      leaseToken: h.leaseToken,
      nowEpochSeconds: 1770000010
    });

    assert.throws(
      () =>
        store.commitAuthorization({
          reservationId: h.reservationId,
          leaseToken: h.leaseToken,
          nowEpochSeconds: 1770000011
        }),
      (err: unknown) => {
        assert.ok(err instanceof DurableStoreError);
        assert.equal(err.code, "LEASE_SUPERSEDED");
        return true;
      }
    );

    store.close();
  });
  // 14. Stale lease takeover and reclamation
  await t.test("Scenario 14: stale lease reclamation frees budget", () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });
    const spending = { ...BASE_SPENDING, agentId: `agent-stale-${randomUUID()}` };

    const h = store.reserveAuthorization({
      identifiers: {
        requestId: `req-stale-${randomUUID()}`,
        intentId: `intent-stale-${randomUUID()}`,
        intentNonce: `nonce-stale-${randomUUID()}`
      },
      spending,
      amountSats: 80n,
      dailyLimitSats: 100n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-abandoned",
      leaseDurationSeconds: 10
    });

    assert.equal(h.leaseExpiresAt, 1770000015);

    assert.throws(() => {
      store.reserveAuthorization({
        identifiers: {
          requestId: `req-stale-blocked-${randomUUID()}`,
          intentId: `intent-stale-blocked-${randomUUID()}`,
          intentNonce: `nonce-stale-blocked-${randomUUID()}`
        },
        spending,
        amountSats: 30n,
        dailyLimitSats: 100n,
        requestRequestedAt: 1770000000,
        requestExpiresAt: 1770000300,
        nowEpochSeconds: 1770000010,
        ownerId: "worker-2"
      });
    });

    const reclaimed = store.reclaimStaleReservations({ nowEpochSeconds: 1770000016 });
    assert.equal(reclaimed, 1);

    const h2 = store.reserveAuthorization({
      identifiers: {
        requestId: `req-stale-freed-${randomUUID()}`,
        intentId: `intent-stale-freed-${randomUUID()}`,
        intentNonce: `nonce-stale-freed-${randomUUID()}`
      },
      spending,
      amountSats: 50n,
      dailyLimitSats: 100n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000016,
      ownerId: "worker-2"
    });
    assert.ok(h2);

    store.close();
  });

  // 15. Old / fenced owner attempts late commit after lease expiry
  await t.test("Scenario 15: old owner late commit fails closed with LEASE_EXPIRED", () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });

    const h = store.reserveAuthorization({
      identifiers: {
        requestId: `req-late-c-${randomUUID()}`,
        intentId: `intent-late-c-${randomUUID()}`,
        intentNonce: `nonce-late-c-${randomUUID()}`
      },
      spending: BASE_SPENDING,
      amountSats: 10n,
      dailyLimitSats: 1000n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-late",
      leaseDurationSeconds: 10
    });

    assert.throws(
      () =>
        store.commitAuthorization({
          reservationId: h.reservationId,
          leaseToken: h.leaseToken,
          nowEpochSeconds: 1770000020
        }),
      (err: unknown) => {
        assert.ok(err instanceof DurableStoreError);
        assert.equal(err.code, "LEASE_EXPIRED");
        return true;
      }
    );

    store.close();
  });

  // 16. Process restart and replay prevention
  await t.test("Scenario 16: process restart preserves replay prevention across instances", () => {
    const client1 = createSqliteDurableStore({ dbPath: dbFile });
    const sharedRequestId = `req-restart-${randomUUID()}`;
    const sharedIntentId = `intent-restart-${randomUUID()}`;
    const sharedNonce = `nonce-restart-${randomUUID()}`;

    const handle = client1.reserveAuthorization({
      identifiers: {
        requestId: sharedRequestId,
        intentId: sharedIntentId,
        intentNonce: sharedNonce
      },
      spending: BASE_SPENDING,
      amountSats: 10n,
      dailyLimitSats: 1000n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "process-1"
    });
    client1.commitAuthorization({
      reservationId: handle.reservationId,
      leaseToken: handle.leaseToken,
      nowEpochSeconds: 1770000010
    });
    client1.close();

    const client2 = createSqliteDurableStore({ dbPath: dbFile });

    assert.throws(
      () =>
        client2.reserveAuthorization({
          identifiers: {
            requestId: sharedRequestId,
            intentId: `intent-different-${randomUUID()}`,
            intentNonce: `nonce-different-${randomUUID()}`
          },
          spending: BASE_SPENDING,
          amountSats: 10n,
          dailyLimitSats: 1000n,
          requestRequestedAt: 1770000000,
          requestExpiresAt: 1770000300,
          nowEpochSeconds: 1770000015,
          ownerId: "process-2"
        }),
      (err: unknown) => {
        assert.ok(err instanceof DurableStoreError);
        assert.equal(err.code, "REPLAY_DETECTED");
        return true;
      }
    );

    client2.close();
  });
  // 17. DB reopen and replay
  await t.test("Scenario 17: DB reopen preserves spending stats and prevents replay", () => {
    const client1 = createSqliteDurableStore({ dbPath: dbFile });
    const spending = { ...BASE_SPENDING, agentId: `agent-reopen-${randomUUID()}` };

    const h = client1.reserveAuthorization({
      identifiers: {
        requestId: `req-reopen-${randomUUID()}`,
        intentId: `intent-reopen-${randomUUID()}`,
        intentNonce: `nonce-reopen-${randomUUID()}`
      },
      spending,
      amountSats: 75n,
      dailyLimitSats: 100n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-reopen"
    });
    client1.commitAuthorization({
      reservationId: h.reservationId,
      leaseToken: h.leaseToken,
      nowEpochSeconds: 1770000010,
      approvalStatus: "approved"
    });
    client1.close();

    const client2 = createSqliteDurableStore({ dbPath: dbFile });
    const stats = client2.getDailySpending(spending, getDeterministicUtcDateString(1770000005), 1770000010);
    assert.equal(stats.committedSats, 75n);
    assert.equal(stats.totalSats, 75n);

    assert.throws(
      () =>
        client2.reserveAuthorization({
          identifiers: {
            requestId: `req-reopen-over-${randomUUID()}`,
            intentId: `intent-reopen-over-${randomUUID()}`,
            intentNonce: `nonce-reopen-over-${randomUUID()}`
          },
          spending,
          amountSats: 30n,
          dailyLimitSats: 100n,
          requestRequestedAt: 1770000000,
          requestExpiresAt: 1770000300,
          nowEpochSeconds: 1770000015,
          ownerId: "worker-reopen-2"
        }),
      (err: unknown) => {
        assert.ok(err instanceof DurableStoreError);
        assert.equal(err.code, "MONETARY_LIMIT_EXCEEDED");
        return true;
      }
    );

    client2.close();
  });

  // 18. UTC day rollover boundary (23:59:59 to 00:00:00)
  await t.test("Scenario 18: UTC day rollover boundary exactly at 23:59:59 to 00:00:00 UTC", () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });
    const spending = { ...BASE_SPENDING, agentId: `agent-utc-rollover-${randomUUID()}` };

    const tDay1End = 1770076799;
    assert.equal(getDeterministicUtcDateString(tDay1End), "2026-02-02");

    const tDay2Start = 1770076800;
    assert.equal(getDeterministicUtcDateString(tDay2Start), "2026-02-03");

    const hDay1 = store.reserveAuthorization({
      identifiers: {
        requestId: `req-day1-${randomUUID()}`,
        intentId: `intent-day1-${randomUUID()}`,
        intentNonce: `nonce-day1-${randomUUID()}`
      },
      spending,
      amountSats: 100n,
      dailyLimitSats: 100n,
      requestRequestedAt: tDay1End - 10,
      requestExpiresAt: tDay1End + 300,
      nowEpochSeconds: tDay1End,
      ownerId: "worker-utc-1"
    });
    store.commitAuthorization({
      reservationId: hDay1.reservationId,
      leaseToken: hDay1.leaseToken,
      nowEpochSeconds: tDay1End,
      approvalStatus: "approved"
    });

    assert.throws(
      () =>
        store.reserveAuthorization({
          identifiers: {
            requestId: `req-day1-over-${randomUUID()}`,
            intentId: `intent-day1-over-${randomUUID()}`,
            intentNonce: `nonce-day1-over-${randomUUID()}`
          },
          spending,
          amountSats: 1n,
          dailyLimitSats: 100n,
          requestRequestedAt: tDay1End - 10,
          requestExpiresAt: tDay1End + 300,
          nowEpochSeconds: tDay1End,
          ownerId: "worker-utc-1"
        }),
      (err: unknown) => {
        assert.ok(err instanceof DurableStoreError);
        assert.equal(err.code, "MONETARY_LIMIT_EXCEEDED");
        return true;
      }
    );

    const hDay2 = store.reserveAuthorization({
      identifiers: {
        requestId: `req-day2-${randomUUID()}`,
        intentId: `intent-day2-${randomUUID()}`,
        intentNonce: `nonce-day2-${randomUUID()}`
      },
      spending,
      amountSats: 100n,
      dailyLimitSats: 100n,
      requestRequestedAt: tDay2Start,
      requestExpiresAt: tDay2Start + 300,
      nowEpochSeconds: tDay2Start,
      ownerId: "worker-utc-2"
    });
    assert.ok(hDay2);

    store.close();
  });

  // 19. Expiry pruning
  await t.test("Scenario 19: expiry pruning deletes committed records past request_expires_at", () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });

    const h = store.reserveAuthorization({
      identifiers: {
        requestId: `req-prune-${randomUUID()}`,
        intentId: `intent-prune-${randomUUID()}`,
        intentNonce: `nonce-prune-${randomUUID()}`
      },
      spending: BASE_SPENDING,
      amountSats: 10n,
      dailyLimitSats: 1000n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000100,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-prune"
    });
    store.commitAuthorization({
      reservationId: h.reservationId,
      leaseToken: h.leaseToken,
      nowEpochSeconds: 1770000010
    });

    assert.equal(store.pruneExpired({ nowEpochSeconds: 1770000050 }), 0);

    const pruned = store.pruneExpired({ nowEpochSeconds: 1770000101 });
    assert.ok(pruned >= 1);

    store.close();
  });
  // 20. DB unavailable → fail closed
  await t.test("Scenario 20: DB unavailable fails closed with STORE_UNAVAILABLE", async () => {
    const store = createSqliteDurableStore({ dbPath: ":memory:", isSimulation: true });
    store.close();

    assert.throws(
      () =>
        store.reserveAuthorization({
          identifiers: {
            requestId: "req-closed",
            intentId: "intent-closed",
            intentNonce: "nonce-closed"
          },
          spending: BASE_SPENDING,
          amountSats: 10n,
          dailyLimitSats: 1000n,
          requestRequestedAt: 1770000000,
          requestExpiresAt: 1770000300,
          nowEpochSeconds: 1770000005,
          ownerId: "worker-closed"
        }),
      (err: unknown) => {
        assert.ok(err instanceof DurableStoreError);
        assert.equal(err.code, "STORE_UNAVAILABLE");
        return true;
      }
    );

    const transport = createWalletApprovalTransport({
      killSwitch: false,
      dailyLimitSats: 1000,
      durableStore: store,
      nowEpochSeconds: () => 1770000005
    });

    const mockPort: WalletApprovalTransportPort = {
      async sendApprovalRequest() {
        throw new Error("Port should not be called when store is unavailable");
      }
    };

    const validRequest = {
      contractVersion: AGENTIC_CONTRACT_VERSION,
      kind: "wallet_approval_request" as const,
      requestId: "req-store-fail-001",
      purpose: "xec_payment" as const,
      intent: {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "agent_intent" as const,
        intentId: "intent-store-fail-001",
        nonce: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NQ",
        agentId: "agent-fail-1",
        agentRole: "tester",
        fromAddress: FROM_ADDRESS,
        toAddress: "ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2",
        amountSats: "50",
        reason: "Test DB unavailable fail-closed",
        network: "xec:mainnet" as const,
        createdAt: 1770000000,
        expiresAt: 1770000300
      },
      policyDecision: {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "cae_policy_decision" as const,
        decisionId: "dec-fail-001",
        intentId: "intent-store-fail-001",
        decision: "needs_human_approval" as const,
        reasonCode: "test_reason",
        reason: "Security gate requires explicit human confirmation",
        policyTraceId: "trace-fail-001",
        policyVersion: "1.0.0",
        evaluatedAt: 1770000001,
        expiresAt: 1770000300
      },
      requestedAt: 1770000002,
      expiresAt: 1770000300
    };

    await assert.rejects(
      async () => transport.dispatchApprovalRequest(validRequest, mockPort),
      (err: unknown) => {
        assert.ok(err instanceof WalletApprovalTransportError);
        assert.equal(err.code, "STORE_UNAVAILABLE");
        return true;
      }
    );
  });

  // 21. Transaction failure → no partial replay or budget reservation
  await t.test("Scenario 21: transaction failure leaves zero partial replay or budget state", () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });
    const spending = { ...BASE_SPENDING, agentId: `agent-tx-fail-${randomUUID()}` };

    const initialStats = store.getDailySpending(spending, getDeterministicUtcDateString(1770000005), 1770000005);
    assert.equal(initialStats.totalSats, 0n);

    const failedRequestId = `req-tx-abort-${randomUUID()}`;
    const failedIntentId = `intent-tx-abort-${randomUUID()}`;
    const failedNonce = `nonce-tx-abort-${randomUUID()}`;

    assert.throws(
      () =>
        store.reserveAuthorization({
          identifiers: {
            requestId: failedRequestId,
            intentId: failedIntentId,
            intentNonce: failedNonce
          },
          spending,
          amountSats: 150n,
          dailyLimitSats: 100n,
          requestRequestedAt: 1770000000,
          requestExpiresAt: 1770000300,
          nowEpochSeconds: 1770000005,
          ownerId: "worker-tx-fail"
        }),
      (err: unknown) => {
        assert.ok(err instanceof DurableStoreError);
        assert.equal(err.code, "MONETARY_LIMIT_EXCEEDED");
        return true;
      }
    );

    const afterStats = store.getDailySpending(spending, getDeterministicUtcDateString(1770000005), 1770000005);
    assert.equal(afterStats.totalSats, 0n);

    const validRetryHandle = store.reserveAuthorization({
      identifiers: {
        requestId: failedRequestId,
        intentId: failedIntentId,
        intentNonce: failedNonce
      },
      spending,
      amountSats: 50n,
      dailyLimitSats: 100n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-tx-fail"
    });
    assert.ok(validRetryHandle.reservationId);

    store.close();
  });

  // 22. Prove that no partial state is left if transaction aborts
  await t.test("Scenario 22: aborted transaction completely rolls back", () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });

    const statsBefore = store.getStats();

    const existingReqId = `req-conflict-base-${randomUUID()}`;
    store.reserveAuthorization({
      identifiers: {
        requestId: existingReqId,
        intentId: `intent-conflict-base-${randomUUID()}`,
        intentNonce: `nonce-conflict-base-${randomUUID()}`
      },
      spending: BASE_SPENDING,
      amountSats: 10n,
      dailyLimitSats: 1000n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-base"
    });

    const statsAfterFirst = store.getStats();
    assert.equal(statsAfterFirst.pending, statsBefore.pending + 1);

    assert.throws(
      () =>
        store.reserveAuthorization({
          identifiers: {
            requestId: existingReqId,
            intentId: `intent-new-${randomUUID()}`,
            intentNonce: `nonce-new-${randomUUID()}`
          },
          spending: BASE_SPENDING,
          amountSats: 20n,
          dailyLimitSats: 1000n,
          requestRequestedAt: 1770000000,
          requestExpiresAt: 1770000300,
          nowEpochSeconds: 1770000005,
          ownerId: "worker-aborted"
        }),
      (err: unknown) => {
        assert.ok(err instanceof DurableStoreError);
        assert.equal(err.code, "REPLAY_DETECTED");
        return true;
      }
    );

    const statsAfterAbort = store.getStats();
    assert.equal(statsAfterAbort.pending, statsAfterFirst.pending);

    store.close();
  });

  // 23. P1-1 Regression: Daily budget survives pruning of expired requests
  await t.test("Scenario 23: P1-1 daily budget survives pruning of expired requests", () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });
    const spending = {
      agentId: "agent-p1-1",
      fromAddress: FROM_ADDRESS,
      network: "xec:mainnet" as const
    };

    const dayStartEpoch = 1770000000; // 2026-02-02
    const reqExpiresAt = dayStartEpoch + 300; // 5 minutes later

    // Reserve 80 sats under 100 limit
    const handle1 = store.reserveAuthorization({
      identifiers: {
        requestId: `req-p1-1-${randomUUID()}`,
        intentId: `intent-p1-1-${randomUUID()}`,
        intentNonce: `nonce-p1-1-${randomUUID()}`
      },
      spending,
      amountSats: 80n,
      dailyLimitSats: 100n,
      requestRequestedAt: dayStartEpoch,
      requestExpiresAt: reqExpiresAt,
      nowEpochSeconds: dayStartEpoch + 10,
      ownerId: "worker-p1-1"
    });

    // Commit approval of 80 sats
    store.commitAuthorization({
      reservationId: handle1.reservationId,
      leaseToken: handle1.leaseToken,
      approvalStatus: "approved",
      nowEpochSeconds: dayStartEpoch + 20
    });

    // Time advances past request expiration (5 minutes later)
    const afterExpiry = reqExpiresAt + 50;

    // Run pruning: expired request row should be purged
    const pruned = store.pruneExpired(afterExpiry);
    assert.ok(pruned >= 1);

    // Attempt to authorize another 30 sats on the SAME UTC day:
    // real authorized that day is already 80. 80 + 30 = 110 > 100 limit.
    // MUST FAIL closed with MONETARY_LIMIT_EXCEEDED!
    assert.throws(
      () =>
        store.reserveAuthorization({
          identifiers: {
            requestId: `req-p1-1-subsequent-${randomUUID()}`,
            intentId: `intent-p1-1-subsequent-${randomUUID()}`,
            intentNonce: `nonce-p1-1-subsequent-${randomUUID()}`
          },
          spending,
          amountSats: 30n,
          dailyLimitSats: 100n,
          requestRequestedAt: afterExpiry,
          requestExpiresAt: afterExpiry + 300,
          nowEpochSeconds: afterExpiry,
          ownerId: "worker-p1-1"
        }),
      (err: unknown) => {
        assert.ok(err instanceof DurableStoreError);
        assert.equal(err.code, "MONETARY_LIMIT_EXCEEDED");
        return true;
      }
    );

    // However, 20 sats still fits within the 100 limit (80 + 20 = 100)
    const handleFit = store.reserveAuthorization({
      identifiers: {
        requestId: `req-p1-1-fit-${randomUUID()}`,
        intentId: `intent-p1-1-fit-${randomUUID()}`,
        intentNonce: `nonce-p1-1-fit-${randomUUID()}`
      },
      spending,
      amountSats: 20n,
      dailyLimitSats: 100n,
      requestRequestedAt: afterExpiry,
      requestExpiresAt: afterExpiry + 300,
      nowEpochSeconds: afterExpiry,
      ownerId: "worker-p1-1"
    });
    assert.ok(handleFit.reservationId);

    // Now advance clock past UTC midnight (next day: 2026-02-03)
    const nextDayEpoch = 1770000000 + 86400 + 100; // next day
    const nextDayHandle = store.reserveAuthorization({
      identifiers: {
        requestId: `req-p1-1-nextday-${randomUUID()}`,
        intentId: `intent-p1-1-nextday-${randomUUID()}`,
        intentNonce: `nonce-p1-1-nextday-${randomUUID()}`
      },
      spending,
      amountSats: 80n,
      dailyLimitSats: 100n,
      requestRequestedAt: nextDayEpoch,
      requestExpiresAt: nextDayEpoch + 300,
      nowEpochSeconds: nextDayEpoch,
      ownerId: "worker-p1-1"
    });
    assert.ok(nextDayHandle.reservationId);

    store.close();
  });

  // 24. P1-2 Regression: monetaryLimitSats becomes effective cumulative daily limit
  await t.test("Scenario 24: P1-2 monetaryLimitSats establishes cumulative daily ceiling", async () => {
    let clock = 1770000010;
    const transport = createWalletApprovalTransport({
      killSwitch: false,
      monetaryLimitSats: 100, // No dailyLimitSats passed!
      simulationMode: true,
      nowEpochSeconds: () => clock
    });

    const mockPort: WalletApprovalTransportPort = {
      async sendApprovalRequest(req) {
        return {
          contractVersion: AGENTIC_CONTRACT_VERSION,
          kind: "human_approval",
          approvalId: `appr-${randomUUID()}`,
          requestId: req.requestId,
          intentId: req.intent.intentId,
          decisionId: req.policyDecision.decisionId,
          status: "approved",
          approver: req.intent.fromAddress,
          recordedAt: clock
        };
      }
    };

    // First request: 60 sats under 100 limit succeeds
    const req1 = {
      contractVersion: AGENTIC_CONTRACT_VERSION,
      kind: "wallet_approval_request" as const,
      purpose: "xec_payment" as const,
      requestId: `req-lim-1-${randomUUID()}`,
      intent: {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "agent_intent" as const,
        intentId: `intent-lim-1-${randomUUID()}`,
        nonce: `nonce-lim-1-${randomUUID().replace(/-/g, "")}`,
        agentId: "agent-limit-test",
        agentRole: "tester",
        network: "xec:mainnet" as const,
        fromAddress: FROM_ADDRESS,
        toAddress: "ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5",
        amountSats: "60",
        reason: "First payment",
        createdAt: clock,
        expiresAt: clock + 300
      },
      policyDecision: {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "cae_policy_decision" as const,
        decisionId: `cae-lim-1-${randomUUID()}`,
        intentId: `intent-lim-1`,
        decision: "needs_human_approval" as const,
        reasonCode: "CONFIRMATION_REQUIRED",
        reason: "Test",
        policyTraceId: "trace-1",
        policyVersion: "1.0",
        evaluatedAt: clock,
        expiresAt: clock + 300
      },
      requestedAt: clock,
      expiresAt: clock + 300
    };
    req1.policyDecision.intentId = req1.intent.intentId;

    const receipt1 = await transport.dispatchApprovalRequest(req1, mockPort);
    assert.equal(receipt1.status, "approved");

    // Second request: another 60 sats on the SAME day: 60 + 60 = 120 > 100!
    // Must be rejected with MONETARY_LIMIT_EXCEEDED!
    const req2 = {
      contractVersion: AGENTIC_CONTRACT_VERSION,
      kind: "wallet_approval_request" as const,
      purpose: "xec_payment" as const,
      requestId: `req-lim-2-${randomUUID()}`,
      intent: {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "agent_intent" as const,
        intentId: `intent-lim-2-${randomUUID()}`,
        nonce: `nonce-lim-2-${randomUUID().replace(/-/g, "")}`,
        agentId: "agent-limit-test",
        agentRole: "tester",
        network: "xec:mainnet" as const,
        fromAddress: FROM_ADDRESS,
        toAddress: "ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5",
        amountSats: "60",
        reason: "Second payment",
        createdAt: clock,
        expiresAt: clock + 300
      },
      policyDecision: {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "cae_policy_decision" as const,
        decisionId: `cae-lim-2-${randomUUID()}`,
        intentId: `intent-lim-2`,
        decision: "needs_human_approval" as const,
        reasonCode: "CONFIRMATION_REQUIRED",
        reason: "Test",
        policyTraceId: "trace-2",
        policyVersion: "1.0",
        evaluatedAt: clock,
        expiresAt: clock + 300
      },
      requestedAt: clock,
      expiresAt: clock + 300
    };
    req2.policyDecision.intentId = req2.intent.intentId;

    await assert.rejects(
      async () => transport.dispatchApprovalRequest(req2, mockPort),
      (err: unknown) => {
        assert.ok(err instanceof WalletApprovalTransportError);
        assert.equal(err.code, "MONETARY_LIMIT_EXCEEDED");
        return true;
      }
    );
  });

  // 25. P1-3 Regressions: Lease renewal heartbeat & fencing token enforcement
  await t.test("Scenario 25: P1-3 heartbeat renewal and fencing token protection", async () => {
    const store = createSqliteDurableStore({ dbPath: dbFile });

    // 25a: Fencing token increment and rejection of stale generations
    const initialHandle = store.reserveAuthorization({
      identifiers: {
        requestId: `req-fence-${randomUUID()}`,
        intentId: `intent-fence-${randomUUID()}`,
        intentNonce: `nonce-fence-${randomUUID()}`
      },
      spending: BASE_SPENDING,
      amountSats: 10n,
      dailyLimitSats: 1000n,
      requestRequestedAt: 1770000000,
      requestExpiresAt: 1770000300,
      nowEpochSeconds: 1770000005,
      ownerId: "worker-fence",
      leaseDurationSeconds: 10
    });
    assert.equal(initialHandle.fencingToken, 1);

    // Renew lease: fencingToken should increment to 2
    const renewedHandle = store.renewLease({
      reservationId: initialHandle.reservationId,
      leaseToken: initialHandle.leaseToken,
      fencingToken: initialHandle.fencingToken,
      additionalSeconds: 15,
      nowEpochSeconds: 1770000010
    });
    assert.equal(renewedHandle.fencingToken, 2);

    // Stale generation 1 attempts to commit: must fail with LEASE_SUPERSEDED
    assert.throws(
      () =>
        store.commitAuthorization({
          reservationId: initialHandle.reservationId,
          leaseToken: initialHandle.leaseToken,
          fencingToken: initialHandle.fencingToken, // stale fencingToken 0
          approvalStatus: "approved",
          nowEpochSeconds: 1770000015
        }),
      (err: unknown) => {
        assert.ok(err instanceof DurableStoreError);
        assert.equal(err.code, "LEASE_SUPERSEDED");
        return true;
      }
    );

    // Stale generation 0 attempts to rollback: must fail with LEASE_SUPERSEDED
    assert.throws(
      () =>
        store.rollbackAuthorization({
          reservationId: initialHandle.reservationId,
          leaseToken: initialHandle.leaseToken,
          fencingToken: initialHandle.fencingToken, // stale fencingToken 0
          reason: "stale rollback",
          nowEpochSeconds: 1770000015
        }),
      (err: unknown) => {
        assert.ok(err instanceof DurableStoreError);
        assert.equal(err.code, "LEASE_SUPERSEDED");
        return true;
      }
    );

    // Fresh generation 1 commits successfully
    store.commitAuthorization({
      reservationId: renewedHandle.reservationId,
      leaseToken: renewedHandle.leaseToken,
      fencingToken: renewedHandle.fencingToken, // generation 1
      approvalStatus: "approved",
      nowEpochSeconds: 1770000015
    });

    // 25b: Live heartbeat keeps pending reservation alive past initial lease
    let currentNow = 1770000000;
    const heartbeatTransport = createWalletApprovalTransport({
      killSwitch: false,
      monetaryLimitSats: 1000,
      durableStore: store,
      leaseDurationSeconds: 2, // 2s lease
      heartbeatIntervalMs: 50, // heartbeat every 50ms extends lease by 2s
      nowEpochSeconds: () => currentNow
    });

    // Port that advances time past initial 2s lease during human decision
    const slowPort: WalletApprovalTransportPort = {
      async sendApprovalRequest(req) {
        // Heartbeat tick 1 (at 50ms): renews lease at currentNow
        await new Promise((resolve) => setTimeout(resolve, 80));
        // Clock moves forward 1s
        currentNow += 1;
        // Heartbeat tick 2 (at 100ms+): renews lease at currentNow + 1
        await new Promise((resolve) => setTimeout(resolve, 80));
        // Clock moves forward another 1s (total 2s: would have expired without heartbeats!)
        currentNow += 1;
        // Heartbeat tick 3: renews lease at currentNow + 2
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          contractVersion: AGENTIC_CONTRACT_VERSION,
          kind: "human_approval",
          approvalId: `appr-hb-${randomUUID()}`,
          requestId: req.requestId,
          intentId: req.intent.intentId,
          decisionId: req.policyDecision.decisionId,
          status: "approved",
          approver: req.intent.fromAddress,
          recordedAt: currentNow
        };
      }
    };

    const hbRequest = {
      contractVersion: AGENTIC_CONTRACT_VERSION,
      kind: "wallet_approval_request" as const,
      purpose: "xec_payment" as const,
      requestId: `req-hb-${randomUUID()}`,
      intent: {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "agent_intent" as const,
        intentId: `intent-hb-${randomUUID()}`,
        nonce: `nonce-hb-${randomUUID().replace(/-/g, "")}`,
        agentId: "agent-hb-test",
        agentRole: "tester",
        network: "xec:mainnet" as const,
        fromAddress: FROM_ADDRESS,
        toAddress: "ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5",
        amountSats: "25",
        reason: "Heartbeat test",
        createdAt: currentNow,
        expiresAt: currentNow + 300
      },
      policyDecision: {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "cae_policy_decision" as const,
        decisionId: `cae-hb-${randomUUID()}`,
        intentId: `intent-hb`,
        decision: "needs_human_approval" as const,
        reasonCode: "CONFIRMATION_REQUIRED",
        reason: "Test",
        policyTraceId: "trace-hb",
        policyVersion: "1.0",
        evaluatedAt: currentNow,
        expiresAt: currentNow + 300
      },
      requestedAt: currentNow,
      expiresAt: currentNow + 300
    };
    hbRequest.policyDecision.intentId = hbRequest.intent.intentId;

    const hbReceipt = await heartbeatTransport.dispatchApprovalRequest(hbRequest, slowPort);
    assert.equal(hbReceipt.status, "approved");

    store.close();
  });

  // 26. Fail-closed in-memory fallback audit
  await t.test("Scenario 26: In-memory fallback fail-closed enforcement", () => {
    // Save current env and delete TONALLI_SIMULATION for clean test
    const origEnv = process.env.TONALLI_SIMULATION;
    delete process.env.TONALLI_SIMULATION;

    try {
      // 1. Calling createWalletApprovalTransport() without dbPath, durableStore, or simulationMode must throw STORE_UNAVAILABLE
      assert.throws(
        () => createWalletApprovalTransport({}),
        (err: unknown) => {
          assert.ok(err instanceof WalletApprovalTransportError);
          assert.equal(err.code, "STORE_UNAVAILABLE");
          return true;
        }
      );

      // 2. Explicit simulationMode: false must throw STORE_UNAVAILABLE
      assert.throws(
        () => createWalletApprovalTransport({ simulationMode: false }),
        (err: unknown) => {
          assert.ok(err instanceof WalletApprovalTransportError);
          assert.equal(err.code, "STORE_UNAVAILABLE");
          return true;
        }
      );

      // 3. createSqliteDurableStore without isSimulation: true must throw STORE_UNAVAILABLE
      assert.throws(
        () => createSqliteDurableStore({ dbPath: ":memory:" }),
        (err: unknown) => {
          assert.ok(err instanceof DurableStoreError);
          assert.equal(err.code, "STORE_UNAVAILABLE");
          return true;
        }
      );

      // 4. createSqliteDurableStore() with no config must throw STORE_UNAVAILABLE
      assert.throws(
        () => createSqliteDurableStore(),
        (err: unknown) => {
          assert.ok(err instanceof DurableStoreError);
          assert.equal(err.code, "STORE_UNAVAILABLE");
          return true;
        }
      );

      // 5. Explicit simulationMode: true succeeds
      const simTransport = createWalletApprovalTransport({ simulationMode: true });
      assert.ok(simTransport);

      // 6. Explicit isSimulation: true on store succeeds
      const simStore = createSqliteDurableStore({ isSimulation: true });
      assert.ok(simStore);
      simStore.close();

      // 7. Persistent file dbPath succeeds without simulationMode
      const fileStore = createSqliteDurableStore({ dbPath: dbFile });
      assert.ok(fileStore);
      fileStore.close();
    } finally {
      if (origEnv !== undefined) {
        process.env.TONALLI_SIMULATION = origEnv;
      }
    }
  });
});
