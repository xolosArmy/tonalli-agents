export type CaeDecision = "approve" | "deny";
export type CaeStatusDetail = "ONLINE" | "RESPONDING" | "OFFLINE";
export type TribunalAgentStatus = "online" | "syncing" | "guarded";
export type ActiveRFCState = "ACTIVE" | "NONE";

export type TribunalAgent = {
  id: string;
  name: string;
  role: string;
  status: TribunalAgentStatus;
  lastPulse: string;
};

export type ActiveRFC = {
  status: ActiveRFCState;
  filename: string | null;
  timestamp: number | null;
  ageMs: number | null;
};

type CaeHealthResponse = {
  ok?: boolean;
  service?: string;
  status?: string;
  dailyLimitSats?: number;
  agentId?: string | null;
  agentRole?: string | null;
  timestamp?: string;
  uptimeMs?: number;
  routes?: string[];
  constitutionalBasis?: string;
  reason?: string;
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

export type TribunalLog = {
  id: string;
  command: string;
  origin: string;
  status: string;
  timestamp: string;
};

const DEFAULT_CAE_API_BASE_URL = "/api/cae";
const HEALTH_PATH = "/v1/health";
const LOGS_PATH = "/v1/logs";
const AGENTS_PATH = "/v1/agents";
const RFC_LATEST_PATH = "/v1/rfc/latest";

function getCaeApiBaseUrl() {
  const configuredBaseUrl = import.meta.env.VITE_CAE_API_BASE_URL;

  if (typeof configuredBaseUrl !== "string" || configuredBaseUrl.trim().length === 0) {
    return DEFAULT_CAE_API_BASE_URL;
  }

  return configuredBaseUrl.replace(/\/$/, "");
}

export function getCaeStatusEndpoint() {
  return `${getCaeApiBaseUrl()}${HEALTH_PATH}`;
}

export function getCaeLogsEndpoint() {
  return `${getCaeApiBaseUrl()}${LOGS_PATH}`;
}

export function getCaeAgentsEndpoint() {
  return `${getCaeApiBaseUrl()}${AGENTS_PATH}`;
}

export function getCaeLatestRfcEndpoint() {
  return `${getCaeApiBaseUrl()}${RFC_LATEST_PATH}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);

  if (!response.ok) {
    throw new Error(`CAE request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

function createEmptyActiveRfc(): ActiveRFC {
  return {
    status: "NONE",
    filename: null,
    timestamp: null,
    ageMs: null
  };
}

function normalizeActiveRfc(payload: unknown): ActiveRFC {
  if (!payload || typeof payload !== "object") {
    return createEmptyActiveRfc();
  }

  const record = payload as Record<string, unknown>;
  const status = record.status === "ACTIVE" ? "ACTIVE" : "NONE";

  return {
    status,
    filename: status === "ACTIVE" && typeof record.filename === "string" ? record.filename : null,
    timestamp: typeof record.timestamp === "number" ? record.timestamp : null,
    ageMs: typeof record.ageMs === "number" ? record.ageMs : null
  };
}

function normalizeHealth(payload: CaeHealthResponse): CaeStatus {
  const statusText = typeof payload.status === "string" ? payload.status.toUpperCase() : "";
  const isLive = payload.ok === true || statusText === "ONLINE";

  return {
    isLive,
    decision: null,
    requestedSats: null,
    dailyLimitSats: typeof payload.dailyLimitSats === "number" ? payload.dailyLimitSats : null,
    agentId: payload.agentId ?? null,
    agentRole: payload.agentRole ?? null,
    timestamp: payload.timestamp ?? null,
    summary:
      (typeof payload.service === "string" ? `${payload.service} ${statusText || "reachable"}` : null) ??
      payload.constitutionalBasis ??
      payload.reason ??
      "CAE reachable, but health returned no summary."
  };
}

export async function fetchCaeStatus(signal?: AbortSignal): Promise<CaeStatus> {
  const payload = await requestJson<CaeHealthResponse>(getCaeStatusEndpoint(), {
    method: "GET",
    signal
  });
  const normalized = normalizeHealth(payload);

  if (!normalized.isLive) {
    throw new Error(payload.reason ?? "CAE returned an unexpected payload.");
  }

  return normalized;
}

export async function checkCaeStatus(signal?: AbortSignal): Promise<CaeLiveStatus> {
  try {
    const payload = await requestJson<CaeHealthResponse>(getCaeStatusEndpoint(), {
      method: "GET",
      signal
    });
    const normalized = normalizeHealth(payload);

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

function formatLogTimestamp(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "sin hora";
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function normalizeLogEntry(entry: unknown, index: number): TribunalLog {
  if (typeof entry === "string") {
    return {
      id: `log-${index}`,
      command: entry,
      origin: "Tribunal real",
      status: "Evento",
      timestamp: "sin hora"
    };
  }

  if (!entry || typeof entry !== "object") {
    return {
      id: `log-${index}`,
      command: "Evento no estructurado",
      origin: "Tribunal real",
      status: "Evento",
      timestamp: "sin hora"
    };
  }

  const record = entry as Record<string, unknown>;
  const command =
    typeof record.summary === "string" ? record.summary :
    typeof record.message === "string" ? record.message :
    typeof record.command === "string" ? record.command :
    typeof record.route === "string" ? record.route :
    "Evento del tribunal";
  const origin =
    typeof record.origin === "string" ? record.origin :
    typeof record.type === "string" ? record.type :
    "Tribunal real";
  const status =
    typeof record.status === "string" ? record.status :
    typeof record.decision === "string" ? record.decision :
    "Evento";
  const id =
    typeof record.id === "string" ? record.id :
    typeof record.traceId === "string" ? record.traceId :
    `log-${index}`;

  return {
    id,
    command,
    origin,
    status,
    timestamp: formatLogTimestamp(record.timestamp)
  };
}

function extractLogEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as Record<string, unknown>;

  if (Array.isArray(record.entries)) {
    return record.entries;
  }

  if (Array.isArray(record.logs)) {
    return record.logs;
  }

  if (Array.isArray(record.items)) {
    return record.items;
  }

  return [];
}

export async function fetchTribunalLogs(signal?: AbortSignal): Promise<TribunalLog[]> {
  const payload = await requestJson<unknown>(getCaeLogsEndpoint(), {
    method: "GET",
    signal
  });

  return extractLogEntries(payload).map(normalizeLogEntry);
}

function formatAgentPulse(value: unknown) {
  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();

    if (trimmed.startsWith("hace ") || trimmed === "sin pulso") {
      return trimmed;
    }

    const parsed = new Date(trimmed);

    if (!Number.isNaN(parsed.getTime())) {
      const elapsedSeconds = Math.max(1, Math.floor((Date.now() - parsed.getTime()) / 1000));

      if (elapsedSeconds < 60) {
        return `hace ${elapsedSeconds} s`;
      }

      const elapsedMinutes = Math.floor(elapsedSeconds / 60);
      if (elapsedMinutes < 60) {
        return `hace ${elapsedMinutes} min`;
      }

      const elapsedHours = Math.floor(elapsedMinutes / 60);
      if (elapsedHours < 24) {
        return `hace ${elapsedHours} h`;
      }

      return `hace ${Math.floor(elapsedHours / 24)} d`;
    }

    return trimmed;
  }

  return "sin pulso";
}

function normalizeAgentStatus(value: unknown, role: unknown): TribunalAgentStatus {
  const normalizedValue = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (normalizedValue === "online" || normalizedValue === "syncing" || normalizedValue === "guarded") {
    return normalizedValue;
  }

  const normalizedRole = typeof role === "string" ? role.trim().toLowerCase() : "";

  if (normalizedRole.includes("treasury") || normalizedRole.includes("custod")) {
    return "guarded";
  }

  if (normalizedRole.includes("sync") || normalizedRole.includes("index")) {
    return "syncing";
  }

  return "online";
}

function humanizeAgentName(value: string) {
  return value
    .replace(/^@[^/]+\//, "")
    .split(/[-_./\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeAgentEntry(entry: unknown, index: number): TribunalAgent {
  if (typeof entry === "string") {
    return {
      id: `agent-${index}`,
      name: humanizeAgentName(entry),
      role: "operator",
      status: "online",
      lastPulse: "sin pulso"
    };
  }

  if (!entry || typeof entry !== "object") {
    return {
      id: `agent-${index}`,
      name: `Citizen ${index + 1}`,
      role: "operator",
      status: "online",
      lastPulse: "sin pulso"
    };
  }

  const record = entry as Record<string, unknown>;
  const rawId =
    typeof record.id === "string" ? record.id :
    typeof record.agentId === "string" ? record.agentId :
    typeof record.slug === "string" ? record.slug :
    typeof record.name === "string" ? record.name :
    `agent-${index}`;
  const rawName =
    typeof record.name === "string" ? record.name :
    typeof record.displayName === "string" ? record.displayName :
    typeof record.agentName === "string" ? record.agentName :
    rawId;
  const role =
    typeof record.role === "string" ? record.role :
    typeof record.agentRole === "string" ? record.agentRole :
    typeof record.title === "string" ? record.title :
    "operator";

  return {
    id: rawId,
    name: humanizeAgentName(rawName),
    role,
    status: normalizeAgentStatus(record.status ?? record.state, role),
    lastPulse: formatAgentPulse(record.lastPulse ?? record.updatedAt ?? record.lastSeenAt ?? record.timestamp)
  };
}

function extractAgentEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as Record<string, unknown>;

  if (Array.isArray(record.agents)) {
    return record.agents;
  }

  if (Array.isArray(record.citizens)) {
    return record.citizens;
  }

  if (Array.isArray(record.items)) {
    return record.items;
  }

  if (Array.isArray(record.data)) {
    return record.data;
  }

  if (record.data && typeof record.data === "object") {
    const dataRecord = record.data as Record<string, unknown>;

    if (Array.isArray(dataRecord.agents)) {
      return dataRecord.agents;
    }

    if (Array.isArray(dataRecord.citizens)) {
      return dataRecord.citizens;
    }
  }

  return [];
}

export async function fetchTribunalAgents(signal?: AbortSignal): Promise<TribunalAgent[]> {
  const payload = await requestJson<unknown>(getCaeAgentsEndpoint(), {
    method: "GET",
    signal
  });

  return extractAgentEntries(payload).map(normalizeAgentEntry);
}

export async function fetchActiveRFC(signal?: AbortSignal): Promise<ActiveRFC> {
  try {
    const payload = await requestJson<unknown>(getCaeLatestRfcEndpoint(), {
      method: "GET",
      signal
    });

    return normalizeActiveRfc(payload);
  } catch {
    return createEmptyActiveRfc();
  }
}
