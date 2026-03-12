export type CaeDecision = "approve" | "deny";
export type CaeStatusDetail = "ONLINE" | "RESPONDING" | "OFFLINE";

type CaePreflightResponse = {
  ok?: boolean;
  decision?: CaeDecision;
  constitutionalBasis?: string;
  reason?: string;
  requestedSats?: number;
  dailyLimitSats?: number;
  agentId?: string | null;
  agentRole?: string | null;
  timestamp?: string;
};

export type CaeStatus = {
  isLive: boolean;
  decision: CaeDecision | null;
  requestedSats: number | null;
  dailyLimitSats: number | null;
  agentId: string | null;
  agentRole: string | null;
  timestamp: string | null;
  summary: string;
};

export type CaeLiveStatus = {
  online: boolean;
  detail: CaeStatusDetail;
};

const DEFAULT_CAE_API_BASE_URL = "/api/cae";
const PREFLIGHT_PATH = "/v1/preflight/sign";

function getCaeApiBaseUrl() {
  const configuredBaseUrl = import.meta.env.VITE_CAE_API_BASE_URL;

  if (typeof configuredBaseUrl !== "string" || configuredBaseUrl.trim().length === 0) {
    return DEFAULT_CAE_API_BASE_URL;
  }

  return configuredBaseUrl.replace(/\/$/, "");
}

export function getCaeStatusEndpoint() {
  return `${getCaeApiBaseUrl()}${PREFLIGHT_PATH}`;
}

async function requestCaePreflight(signal?: AbortSignal) {
  return fetch(getCaeStatusEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      amountSats: 0,
      source: "tonalli-dashboard"
    }),
    signal
  });
}

function normalizeResponse(payload: CaePreflightResponse): CaeStatus {
  return {
    isLive: typeof payload.decision === "string",
    decision: payload.decision ?? null,
    requestedSats: typeof payload.requestedSats === "number" ? payload.requestedSats : null,
    dailyLimitSats: typeof payload.dailyLimitSats === "number" ? payload.dailyLimitSats : null,
    agentId: payload.agentId ?? null,
    agentRole: payload.agentRole ?? null,
    timestamp: payload.timestamp ?? null,
    summary:
      payload.constitutionalBasis ??
      payload.reason ??
      "CAE reachable, but no policy summary was returned."
  };
}

export async function fetchCaeStatus(signal?: AbortSignal): Promise<CaeStatus> {
  const response = await requestCaePreflight(signal);

  const payload = (await response.json()) as CaePreflightResponse;
  const normalized = normalizeResponse(payload);

  if (!normalized.isLive) {
    throw new Error(payload.reason ?? "CAE returned an unexpected payload.");
  }

  return normalized;
}

export async function checkCaeStatus(signal?: AbortSignal): Promise<CaeLiveStatus> {
  try {
    const response = await requestCaePreflight(signal);
    const payload = (await response.json()) as CaePreflightResponse;
    const normalized = normalizeResponse(payload);

    if (normalized.isLive) {
      return {
        online: true,
        detail: "ONLINE"
      };
    }

    return {
      online: true,
      detail: "RESPONDING"
    };
  } catch (error: unknown) {
    return {
      online: false,
      detail: "OFFLINE"
    };
  }
}
