import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = [
  "src",
  "tonalli-agent-sdk/src",
  "tonalli-cli/src",
  "examples",
  "policy-enforcer.js",
];
const allowedExtensions = new Set([".cjs", ".js", ".mjs", ".ts"]);
const definitions = JSON.parse(
  await readFile(new URL("./security-forbidden-patterns.json", import.meta.url), "utf8"),
);
const patterns = definitions.map(({ id, pattern }) => ({
  id,
  expression: new RegExp(pattern, "m"),
}));

async function collect(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) {
    return allowedExtensions.has(extname(path)) ? [path] : [];
  }

  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(child)));
    } else if (entry.isFile() && allowedExtensions.has(extname(entry.name))) {
      files.push(child);
    }
  }
  return files;
}

const files = (await Promise.all(roots.map(collect))).flat().sort();
const failures = [];

for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const { id, expression } of patterns) {
    if (expression.test(content)) {
      failures.push(`${file}: ${id} (${expression.source})`);
    }
  }
}

if (failures.length > 0) {
  console.error("Forbidden security patterns found:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Forbidden-pattern scan passed: ${files.length} runtime files, ${patterns.length} patterns.`,
);
