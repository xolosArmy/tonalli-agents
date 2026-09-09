import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootSrc = path.resolve(process.cwd(), "src");
const sdkSrc = path.resolve(process.cwd(), "tonalli-agent-sdk/src");

const CORE_SECURITY_MODULES = [
  "wallet/approvalTransport.ts",
  "wallet/format.ts",
  "config/env.ts",
  "wallet/safeSendXEC.ts",
  "wallet/sessionSigner.ts",
  "wallet/intent.ts",
  "cae/policyGuard.ts",
  "cae/preflightClient.ts"
];

test("Anti-drift: core security and wallet modules in src/ and tonalli-agent-sdk/src/ must be strictly identical", () => {
  for (const rel of CORE_SECURITY_MODULES) {
    const rootPath = path.join(rootSrc, rel);
    const sdkPath = path.join(sdkSrc, rel);
    assert.ok(fs.existsSync(rootPath), `File ${rel} missing from root src/`);
    assert.ok(fs.existsSync(sdkPath), `File ${rel} missing from tonalli-agent-sdk/src/`);

    const rootContent = fs.readFileSync(rootPath, "utf8");
    const sdkContent = fs.readFileSync(sdkPath, "utf8");
    assert.strictEqual(
      rootContent,
      sdkContent,
      `Anti-drift check failed: content of ${rel} differs between root src/ and tonalli-agent-sdk/src/`
    );
  }
});
