import { parseCaePolicyDecisionV1 } from "@xolosarmy/tonalli-core";
import { requestPreflight } from "./preflightClient";
import { CaeFailClosedError } from "./preflightClient";
import type { TxIntent, PreflightResponse } from "../types/policy";

export type PreflightRequester = (
  intent: TxIntent
) => Promise<PreflightResponse>;

export type PreflightClock = () => number;

export async function enforcePreflight(
  intent: TxIntent,
  requester: PreflightRequester = requestPreflight,
  now: PreflightClock = () => Math.floor(Date.now() / 1000)
): Promise<PreflightResponse> {
  const checkedAt = now();
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) {
    throw new CaeFailClosedError("CAE guard received an invalid clock value");
  }
  if (checkedAt < intent.createdAt || checkedAt >= intent.expiresAt) {
    throw new CaeFailClosedError("Agent intent is outside its validity window");
  }

  let response: PreflightResponse;
  try {
    response = parseCaePolicyDecisionV1(await requester(intent));
  } catch (error) {
    throw new CaeFailClosedError("CAE returned an invalid policy decision", {
      cause: error
    });
  }
  if (response.intentId !== intent.intentId) {
    throw new CaeFailClosedError("CAE decision does not match the guarded intent");
  }
  if (
    checkedAt < response.evaluatedAt ||
    checkedAt >= response.expiresAt
  ) {
    throw new CaeFailClosedError("CAE decision is outside its validity window");
  }

  switch (response.decision) {
    case "approved":
    case "rejected":
    case "needs_human_approval":
      return response;
    default: {
      const _exhaustive: never = response.decision;
      throw new CaeFailClosedError(
        `Unknown CAE decision: ${String(_exhaustive)}`
      );
    }
  }
}
