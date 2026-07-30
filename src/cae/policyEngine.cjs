const {
  AGENTIC_CONTRACT_VERSION,
  parseAgentIntentV1,
  parseCaePolicyDecisionV1,
} = require("@xolosarmy/tonalli-core");

const DEFAULT_POLICY_VERSION = "xolosarmy-agentic-cycle-1";

class InvalidAgentIntentError extends Error {
  constructor(options) {
    super("Agent intent failed canonical validation", options);
    this.name = "InvalidAgentIntentError";
    this.code = "CAE_INVALID_INTENT";
  }
}

function readNonNegativeInteger(value, field) {
  let parsed;
  try {
    parsed = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  if (parsed < 0n) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function readEpoch(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative epoch second`);
  }
  return value;
}

function stablePart(value) {
  return String(value).replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 96);
}

function createPolicyEngine(options = {}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const dailyLimitSats = readNonNegativeInteger(
    options.dailyLimitSats ?? 0,
    "dailyLimitSats",
  );
  const decisionTtlSeconds = Number(options.decisionTtlSeconds ?? 60);
  if (!Number.isSafeInteger(decisionTtlSeconds) || decisionTtlSeconds <= 0) {
    throw new RangeError("decisionTtlSeconds must be a positive safe integer");
  }
  const allowedPayTo = new Set(options.allowedPayTo ?? []);
  const killSwitch = options.killSwitch ?? true;
  if (typeof killSwitch !== "boolean") {
    throw new TypeError("killSwitch must be boolean");
  }
  const policyVersion = options.policyVersion ?? DEFAULT_POLICY_VERSION;
  const seenIntentIds = new Set();
  const seenNonces = new Set();
  const reservedByAgentDay = new Map();

  const buildDecision = (intent, decision, reasonCode, reason, evaluatedAt) => {
    const traceSuffix = `${stablePart(intent.intentId)}:${evaluatedAt}`;
    return parseCaePolicyDecisionV1({
      contractVersion: AGENTIC_CONTRACT_VERSION,
      kind: "cae_policy_decision",
      decisionId: `decision:${traceSuffix}:${decision}`,
      intentId: intent.intentId,
      decision,
      reasonCode,
      reason,
      policyTraceId: `trace:${traceSuffix}`,
      policyVersion,
      evaluatedAt,
      expiresAt:
        intent.expiresAt > evaluatedAt
          ? Math.min(intent.expiresAt, evaluatedAt + decisionTtlSeconds)
          : evaluatedAt + 1,
    });
  };

  const evaluate = (input) => {
    let intent;
    try {
      intent = parseAgentIntentV1(input);
    } catch (error) {
      throw new InvalidAgentIntentError({ cause: error });
    }

    const evaluatedAt = readEpoch(now(), "now");
    const reject = (reasonCode, reason) =>
      buildDecision(intent, "rejected", reasonCode, reason, evaluatedAt);

    if (evaluatedAt < intent.createdAt) {
      return reject("intent_not_yet_valid", "Intent creation time is in the future");
    }
    if (evaluatedAt >= intent.expiresAt) {
      return reject("intent_expired", "Intent has expired");
    }
    if (killSwitch) {
      return reject("kill_switch_active", "Agentic money kill-switch is active");
    }
    if (!allowedPayTo.has(intent.toAddress)) {
      return reject(
        "destination_not_allowlisted",
        "Destination is not in the agent payment allowlist",
      );
    }
    if (dailyLimitSats === 0n) {
      return reject("daily_limit_disabled", "Agent daily limit is disabled");
    }
    if (seenIntentIds.has(intent.intentId) || seenNonces.has(intent.nonce)) {
      return reject("replay_detected", "Intent ID or nonce has already been evaluated");
    }

    const amountSats = readNonNegativeInteger(intent.amountSats, "amountSats");
    const day = Math.floor(evaluatedAt / 86_400);
    const reservationKey = `${intent.agentId}:${day}`;
    const reserved = reservedByAgentDay.get(reservationKey) ?? 0n;
    if (reserved + amountSats > dailyLimitSats) {
      return reject(
        "cumulative_limit_exceeded",
        "Intent would exceed the cumulative daily agent limit",
      );
    }

    seenIntentIds.add(intent.intentId);
    seenNonces.add(intent.nonce);
    reservedByAgentDay.set(reservationKey, reserved + amountSats);

    return buildDecision(
      intent,
      "needs_human_approval",
      "human_approval_required",
      "Cycle 1 requires explicit human approval for every monetary intent",
      evaluatedAt,
    );
  };

  return {
    evaluate,
    snapshot() {
      return Object.freeze({
        killSwitch,
        dailyLimitSats: dailyLimitSats.toString(),
        allowlistSize: allowedPayTo.size,
        replayEntries: seenIntentIds.size,
        reservations: Object.freeze(
          Object.fromEntries(
            [...reservedByAgentDay.entries()].map(([key, value]) => [
              key,
              value.toString(),
            ]),
          ),
        ),
      });
    },
  };
}

module.exports = {
  DEFAULT_POLICY_VERSION,
  InvalidAgentIntentError,
  createPolicyEngine,
};
