import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const SCRIPT_PATH = path.resolve(process.cwd(), "scripts/gate2-crossrepo.sh");

test("Gate 2A P2-4: scripts/gate2-crossrepo.sh rejects missing SHA arguments", () => {
  const result = spawnSync("bash", [SCRIPT_PATH], {
    encoding: "utf8",
    env: { ...process.env, AGENTS_SHA: "", WALLET_SHA: "" }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test("Gate 2A P2-4: scripts/gate2-crossrepo.sh rejects invalid non-hex or malformed SHA", () => {
  // Test invalid character 'G'
  const invalidCharResult = spawnSync(
    "bash",
    [SCRIPT_PATH, "9826424C125C37273BE9E82FA461DA4880F825BG", "6ce09d3679fb01286d8ef77df3fe1fdc08244858"],
    { encoding: "utf8" }
  );
  assert.equal(invalidCharResult.status, 1);
  assert.match(invalidCharResult.stderr, /ERROR: AGENTS_SHA must be an exact 40-character hexadecimal commit SHA/);

  // Test short length (39 chars)
  const shortResult = spawnSync(
    "bash",
    [SCRIPT_PATH, "9826424c125c37273be9e82fa461da4880f825b", "6ce09d3679fb01286d8ef77df3fe1fdc08244858"],
    { encoding: "utf8" }
  );
  assert.equal(shortResult.status, 1);
  assert.match(shortResult.stderr, /ERROR: AGENTS_SHA must be an exact 40-character hexadecimal commit SHA/);

  // Test invalid WALLET_SHA
  const invalidWalletResult = spawnSync(
    "bash",
    [SCRIPT_PATH, "9826424C125C37273BE9E82FA461DA4880F825BC", "not-a-valid-sha"],
    { encoding: "utf8" }
  );
  assert.equal(invalidWalletResult.status, 1);
  assert.match(invalidWalletResult.stderr, /ERROR: WALLET_SHA must be an exact 40-character hexadecimal commit SHA/);
});

test("Gate 2A P2-4: scripts/gate2-crossrepo.sh accepts and normalizes uppercase and mixed-case SHAs", () => {
  const uppercaseAgentsSha = "9826424C125C37273BE9E82FA461DA4880F825BC";
  const uppercaseWalletSha = "6CE09D3679FB01286D8EF77DF3FE1FDC08244858";

  // Run script up through parameter validation and normalization
  // We supply a non-existent repo URL so it will fail at git clone, but AFTER validation and normalization pass
  const result = spawnSync(
    "bash",
    [
      SCRIPT_PATH,
      uppercaseAgentsSha,
      uppercaseWalletSha,
      "/dev/null/nonexistent-agents-repo",
      "/dev/null/nonexistent-wallet-repo"
    ],
    {
      encoding: "utf8",
      env: { ...process.env, NODE_AUTH_TOKEN: "mock-token-for-test" }
    }
  );

  // It should NOT fail with SHA validation error
  assert.doesNotMatch(result.stderr, /ERROR: AGENTS_SHA must be an exact 40-character/);
  assert.doesNotMatch(result.stderr, /ERROR: WALLET_SHA must be an exact 40-character/);

  // Check stdout to confirm normalized lowercase SHAs were printed in harness header
  assert.match(result.stdout, /tonalli-agents target SHA:\s+9826424c125c37273be9e82fa461da4880f825bc/);
  assert.match(result.stdout, /RMZWallet target SHA:\s+6ce09d3679fb01286d8ef77df3fe1fdc08244858/);
});
