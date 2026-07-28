import { randomBytes, randomUUID } from "node:crypto";
import {
  AGENTIC_CONTRACT_VERSION,
  parseAgentIntentV1,
  type AgentIntentV1
} from "@xolosarmy/tonalli-core";
import { env } from "../config/env";

export interface AgentPaymentIntentInput {
  toAddress: string;
  amountSats: number;
  reason: string;
  memo?: string;
}

export interface IntentFactoryOptions {
  now?: () => number;
  randomId?: () => string;
  randomNonce?: () => string;
}

export const createAgentPaymentIntent = (
  input: AgentPaymentIntentInput,
  options: IntentFactoryOptions = {}
): AgentIntentV1 => {
  if (!Number.isSafeInteger(input.amountSats) || input.amountSats <= 0) {
    throw new TypeError("amountSats must be a positive safe integer");
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const createdAt = now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new RangeError("now must return a non-negative epoch second");
  }
  const randomId = options.randomId ?? randomUUID;
  const randomNonce =
    options.randomNonce ?? (() => randomBytes(16).toString("base64url"));

  return parseAgentIntentV1({
    contractVersion: AGENTIC_CONTRACT_VERSION,
    kind: "agent_intent",
    intentId: `intent:${randomId()}`,
    nonce: randomNonce(),
    agentId: env.AGENT_ID,
    agentRole: env.AGENT_ROLE,
    network: "xec:mainnet",
    fromAddress: env.AGENT_WALLET,
    toAddress: input.toAddress,
    amountSats: String(input.amountSats),
    reason: input.reason,
    ...(input.memo === undefined ? {} : { memo: input.memo }),
    createdAt,
    expiresAt: createdAt + env.AGENT_INTENT_TTL_SECONDS
  });
};
