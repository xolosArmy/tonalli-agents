import axios from "axios";
import {
  parseAgentIntentV1,
  parseCaePolicyDecisionV1
} from "@xolosarmy/tonalli-core";
import { env } from "../config/env";
import type { TxIntent, PreflightResponse } from "../types/policy";

const client = axios.create({
  baseURL: env.CAE_PREFLIGHT_URL,
  timeout: env.CAE_REQUEST_TIMEOUT_MS
});

export interface PreflightTransport {
  post(url: string, body: unknown): Promise<{
    data: unknown;
    status: number;
  }>;
}

export class CaeFailClosedError extends Error {
  readonly code = "CAE_FAIL_CLOSED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CaeFailClosedError";
  }
}

export const createPreflightRequester = (
  transport: PreflightTransport = client
) => async (input: TxIntent): Promise<PreflightResponse> => {
  let intent: TxIntent;
  try {
    intent = parseAgentIntentV1(input);
  } catch (error) {
    throw new CaeFailClosedError("CAE request rejected an invalid intent", {
      cause: error
    });
  }

  try {
    const response = await transport.post("", intent);
    if (response.status < 200 || response.status >= 300) {
      throw new CaeFailClosedError("CAE returned a non-success HTTP status");
    }
    const decision = parseCaePolicyDecisionV1(response.data);
    if (decision.intentId !== intent.intentId) {
      throw new CaeFailClosedError("CAE decision does not match the intent");
    }
    return decision;
  } catch (error) {
    if (error instanceof CaeFailClosedError) throw error;
    throw new CaeFailClosedError("CAE request failed closed", { cause: error });
  }
};

export const requestPreflight = createPreflightRequester();
