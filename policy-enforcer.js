const fs = require('fs');
const http = require('http');
const path = require('path');

loadEnvFiles([
  path.join(__dirname, '.env'),
  path.join(__dirname, 'xolo-treasury-agent', '.env'),
  path.join(__dirname, 'tonalli-agent-sdk', '.env'),
  path.join(__dirname, 'tonalli-cli', '.env'),
]);

const HOST = '127.0.0.1';
const PORT = 8787;
const DAILY_LIMIT_SATS = parsePositiveInteger(process.env.AGENT_DAILY_LIMIT_SATS, 0);
const HEALTH_PATH = '/v1/health';
const LOGS_PATH = '/v1/logs';
const PREFLIGHT_PATH = '/v1/preflight/sign';
const AGENTS_PATH = '/v1/agents';
const RFC_LATEST_PATH = '/v1/rfc/latest';
const MAX_LOG_ENTRIES = 200;

const serverStartedAt = Date.now();
const activityLog = [];

function loadEnvFiles(filePaths) {
  filePaths.forEach((filePath) => {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        return;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
  });
}

function parsePositiveInteger(value, fallbackValue) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackValue;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const values = {};
  const content = fs.readFileSync(filePath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key) {
      values[key] = value;
    }
  });

  return values;
}

function readPackageName(packagePath) {
  try {
    if (!fs.existsSync(packagePath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return typeof parsed.name === 'string' && parsed.name.trim().length > 0 ? parsed.name.trim() : null;
  } catch {
    return null;
  }
}

function humanizeLabel(value, fallbackValue) {
  const rawValue = typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallbackValue;
  return rawValue
    .replace(/^@[^/]+\//, '')
    .split(/[-_./\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferAgentStatus(role, sourceName) {
  const normalizedRole = String(role || '').toLowerCase();
  const normalizedSource = String(sourceName || '').toLowerCase();

  if (normalizedRole.includes('treasury') || normalizedRole.includes('custod')) {
    return 'guarded';
  }

  if (normalizedRole.includes('sdk') || normalizedSource.includes('sdk')) {
    return 'syncing';
  }

  return 'online';
}

function buildRelativePulse(isoTimestamp) {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return 'sin pulso';
  }

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

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `hace ${elapsedDays} d`;
}

function createAgentFromSource(source) {
  const envValues = parseEnvFile(source.envPath);
  const packageName = readPackageName(source.packagePath);

  if (!envValues) {
    return null;
  }

  const envStat = fs.statSync(source.envPath);
  const agentId = envValues.AGENT_ID || source.defaultId || packageName || source.label;
  const role = envValues.AGENT_ROLE || source.defaultRole || 'operator';
  const wallet = envValues.AGENT_WALLET || null;
  const updatedAt = envStat.mtime.toISOString();

  return {
    id: agentId,
    agentId,
    name: humanizeLabel(envValues.AGENT_NAME || agentId, humanizeLabel(packageName || source.label, source.label)),
    role,
    status: inferAgentStatus(role, packageName || source.label),
    lastPulse: buildRelativePulse(updatedAt),
    updatedAt,
    wallet,
    source: packageName || source.label,
    origin: path.relative(__dirname, source.envPath) || source.envPath,
  };
}

function mergeAgentRecords(current, incoming) {
  const mergedSources = new Set([...(current.sources || []), ...(incoming.sources || [])].filter(Boolean));
  const latestUpdatedAt = current.updatedAt > incoming.updatedAt ? current.updatedAt : incoming.updatedAt;

  return {
    id: current.id || incoming.id,
    agentId: current.agentId || incoming.agentId,
    name: current.name || incoming.name,
    role: current.role || incoming.role,
    status: current.status === 'online' ? current.status : incoming.status || current.status,
    lastPulse: buildRelativePulse(latestUpdatedAt),
    updatedAt: latestUpdatedAt,
    wallet: current.wallet || incoming.wallet,
    source: current.source || incoming.source,
    origin: current.origin || incoming.origin,
    sources: Array.from(mergedSources),
  };
}

function scanLocalAgents() {
  const sources = [
    {
      label: 'workspace',
      envPath: path.join(__dirname, '.env'),
      packagePath: path.join(__dirname, 'package.json'),
    },
    {
      label: 'tonalli-cli',
      envPath: path.join(__dirname, 'tonalli-cli', '.env'),
      packagePath: path.join(__dirname, 'tonalli-cli', 'package.json'),
    },
    {
      label: 'tonalli-agent-sdk',
      envPath: path.join(__dirname, 'tonalli-agent-sdk', '.env'),
      packagePath: path.join(__dirname, 'tonalli-agent-sdk', 'package.json'),
    },
    {
      label: 'xolo-treasury-agent',
      envPath: path.join(__dirname, 'xolo-treasury-agent', '.env'),
      packagePath: path.join(__dirname, 'xolo-treasury-agent', 'package.json'),
    },
  ];

  const agentsByKey = new Map();

  sources.forEach((source) => {
    const agent = createAgentFromSource(source);
    if (!agent) {
      return;
    }

    const dedupeKey = agent.agentId || [agent.wallet || '', agent.role || '', agent.source || ''].join('::');
    const existing = agentsByKey.get(dedupeKey);
    const nextAgent = {
      ...agent,
      sources: [agent.source],
    };

    agentsByKey.set(
      dedupeKey,
      existing ? mergeAgentRecords(existing, nextAgent) : nextAgent
    );
  });

  return Array.from(agentsByKey.values())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((agent, index) => ({
      id: agent.id || `agent-${index + 1}`,
      name: agent.name || `Citizen ${index + 1}`,
      role: agent.role || 'operator',
      status: agent.status || 'online',
      lastPulse: agent.lastPulse || 'sin pulso',
      updatedAt: agent.updatedAt || null,
      wallet: agent.wallet || null,
      source: agent.source || null,
      sources: Array.isArray(agent.sources) ? agent.sources : [],
      origin: agent.origin || null,
    }));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function extractRequestedSats(payload) {
  const candidates = [
    payload.amountSats,
    payload.amount,
    payload.sats,
    payload.txSats,
    payload?.tx?.amountSats,
    payload?.tx?.amount,
  ];

  for (const candidate of candidates) {
    const parsed = parsePositiveInteger(candidate, -1);
    if (parsed >= 0) {
      return parsed;
    }
  }

  return null;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function pushLogEntry(entry) {
  activityLog.unshift({
    id: `cae_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  });

  if (activityLog.length > MAX_LOG_ENTRIES) {
    activityLog.length = MAX_LOG_ENTRIES;
  }
}

function parseLimitParam(urlObject) {
  const parsed = parsePositiveInteger(urlObject.searchParams.get('limit'), 20);
  return Math.min(Math.max(parsed, 1), 100);
}

function createHealthPayload() {
  return {
    ok: true,
    service: 'policy-enforcer',
    status: 'ONLINE',
    timestamp: new Date().toISOString(),
    uptimeMs: Date.now() - serverStartedAt,
    dailyLimitSats: DAILY_LIMIT_SATS,
    agentId: process.env.AGENT_ID || null,
    agentRole: process.env.AGENT_ROLE || null,
    routes: [HEALTH_PATH, LOGS_PATH, AGENTS_PATH, RFC_LATEST_PATH, PREFLIGHT_PATH],
  };
}

function createEmptyRfcPayload() {
  return {
    status: 'NONE',
    filename: null,
    timestamp: null,
    ageMs: null,
  };
}

function readLatestRfcDraft() {
  try {
    const draftsDirectory = path.join(__dirname, 'teyolia-agent', 'drafts');

    if (!fs.existsSync(draftsDirectory)) {
      return createEmptyRfcPayload();
    }

    const latestEntry = fs.readdirSync(draftsDirectory)
      .filter((fileName) => fileName.startsWith('rfc-') && fileName.endsWith('.md'))
      .map((fileName) => {
        const filePath = path.join(draftsDirectory, fileName);
        const fileStat = fs.statSync(filePath);

        return {
          filename: fileName,
          timestamp: fileStat.mtimeMs,
        };
      })
      .sort((left, right) => right.timestamp - left.timestamp)[0];

    if (!latestEntry) {
      return createEmptyRfcPayload();
    }

    const ageMs = Date.now() - latestEntry.timestamp;
    if (ageMs >= 86400000) {
      return createEmptyRfcPayload();
    }

    return {
      status: 'ACTIVE',
      filename: latestEntry.filename,
      timestamp: latestEntry.timestamp,
      ageMs,
    };
  } catch {
    return createEmptyRfcPayload();
  }
}

pushLogEntry({
  type: 'system',
  route: 'boot',
  status: 'online',
  summary: 'Policy enforcer started',
  meta: {
    host: HOST,
    port: PORT,
    dailyLimitSats: DAILY_LIMIT_SATS,
  },
});

const server = http.createServer(async (req, res) => {
  const urlObject = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && urlObject.pathname === HEALTH_PATH) {
    sendJson(res, 200, createHealthPayload());
    return;
  }

  if (req.method === 'GET' && urlObject.pathname === LOGS_PATH) {
    sendJson(res, 200, {
      ok: true,
      timestamp: new Date().toISOString(),
      count: Math.min(parseLimitParam(urlObject), activityLog.length),
      entries: activityLog.slice(0, parseLimitParam(urlObject)),
    });
    return;
  }

  if (req.method === 'GET' && urlObject.pathname === AGENTS_PATH) {
    const agents = scanLocalAgents();

    pushLogEntry({
      type: 'agents',
      route: AGENTS_PATH,
      status: 'served',
      summary: `Served ${agents.length} local citizens`,
      meta: {
        count: agents.length,
      },
    });

    sendJson(res, 200, {
      ok: true,
      timestamp: new Date().toISOString(),
      count: agents.length,
      agents,
    });
    return;
  }

  if (req.method === 'GET' && urlObject.pathname === RFC_LATEST_PATH) {
    sendJson(res, 200, readLatestRfcDraft());
    return;
  }

  if (req.method !== 'POST' || urlObject.pathname !== PREFLIGHT_PATH) {
    sendJson(res, 404, {
      ok: false,
      error: 'Not found',
      expected: [`GET ${HEALTH_PATH}`, `GET ${LOGS_PATH}`, `GET ${AGENTS_PATH}`, `GET ${RFC_LATEST_PATH}`, `POST ${PREFLIGHT_PATH}`],
    });
    return;
  }

  try {
    const payload = await readJsonBody(req);
    const requestedSats = extractRequestedSats(payload);

    if (requestedSats === null) {
      pushLogEntry({
        type: 'preflight',
        route: PREFLIGHT_PATH,
        decision: 'deny',
        status: 'invalid',
        summary: 'Missing amount in sats',
        meta: {
          acceptedFields: ['amountSats', 'amount', 'sats', 'txSats', 'tx.amountSats', 'tx.amount'],
        },
      });

      sendJson(res, 400, {
        ok: false,
        decision: 'deny',
        reason: 'Missing amount in sats',
        acceptedFields: ['amountSats', 'amount', 'sats', 'txSats', 'tx.amountSats', 'tx.amount'],
      });
      return;
    }

    const approved = DAILY_LIMIT_SATS > 0 && requestedSats <= DAILY_LIMIT_SATS;
    const responsePayload = {
      ok: approved,
      decision: approved ? 'approve' : 'deny',
      constitutionalBasis: approved
        ? 'Requested amount is within AGENT_DAILY_LIMIT_SATS'
        : 'Requested amount exceeds AGENT_DAILY_LIMIT_SATS',
      requestedSats,
      dailyLimitSats: DAILY_LIMIT_SATS,
      agentId: process.env.AGENT_ID || null,
      agentRole: process.env.AGENT_ROLE || null,
      timestamp: new Date().toISOString(),
    };

    pushLogEntry({
      type: 'preflight',
      route: PREFLIGHT_PATH,
      decision: responsePayload.decision,
      status: approved ? 'approved' : 'denied',
      summary: responsePayload.constitutionalBasis,
      requestedSats,
      dailyLimitSats: DAILY_LIMIT_SATS,
      meta: {
        agentId: responsePayload.agentId,
        agentRole: responsePayload.agentRole,
      },
    });

    sendJson(res, approved ? 200 : 403, responsePayload);
  } catch (error) {
    pushLogEntry({
      type: 'preflight',
      route: PREFLIGHT_PATH,
      decision: 'deny',
      status: 'error',
      summary: error.message,
    });

    sendJson(res, 400, {
      ok: false,
      decision: 'deny',
      reason: error.message,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `CAE listening on http://${HOST}:${PORT}${PREFLIGHT_PATH} with AGENT_DAILY_LIMIT_SATS=${DAILY_LIMIT_SATS}`
  );
});
