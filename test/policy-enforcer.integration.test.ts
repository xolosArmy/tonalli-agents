import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const NOW = 1_800_000_000;
const DESTINATION =
  "ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a";
const canonicalIntent = {
  contractVersion: "1.0",
  kind: "agent_intent",
  intentId: "intent:http-integration",
  nonce: "MDEyMzQ1Njc4OWFiY2RlZg",
  agentId: "agent:http",
  agentRole: "tester",
  network: "xec:mainnet",
  fromAddress: "ecash:qzh3lwn68jtn94e8pf059rslfssyrjjyaykjwr0z2a",
  toAddress: DESTINATION,
  amountSats: "100",
  reason: "Exercise the HTTP CAE boundary",
  createdAt: NOW - 10,
  expiresAt: NOW + 300
};

const require = createRequire(import.meta.url);
const { createPolicyEngine } = require("../src/cae/policyEngine.cjs") as {
  createPolicyEngine: (options: Record<string, unknown>) => {
    evaluate: (intent: unknown) => unknown;
  };
};
const { createPolicyServer } = require("../policy-enforcer.js") as {
  createPolicyServer: (engine: unknown) => {
    listen: (
      port: number,
      host: string,
      callback: () => void
    ) => void;
    address: () => { port: number } | string | null;
    close: (callback: (error?: Error) => void) => void;
  };
};

test("HTTP CAE returns canonical decisions and rejects replay and malformed input", async (t) => {
  const engine = createPolicyEngine({
    now: () => NOW,
    killSwitch: false,
    allowedPayTo: [DESTINATION],
    dailyLimitSats: "1000"
  });
  const server = createPolicyServer(engine);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );

  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  const endpoint = `http://127.0.0.1:${(address as { port: number }).port}/v1/preflight/sign`;
  const post = (body: unknown) =>
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

  const first = await post(canonicalIntent);
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { decision: string }).decision, "needs_human_approval");

  const replay = await post(canonicalIntent);
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as {
    decision: string;
    reasonCode: string;
  };
  assert.equal(replayBody.decision, "rejected");
  assert.equal(replayBody.reasonCode, "replay_detected");

  const malformed = await post({ ...canonicalIntent, seed: "forbidden" });
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.json() as {
    kind: string;
    status: string;
    errorCode: string;
  };
  assert.deepEqual(malformedBody, {
    contractVersion: "1.0",
    kind: "cae_error",
    status: "rejected",
    errorCode: "invalid_intent",
    reason: "Intent failed canonical validation"
  });
});
