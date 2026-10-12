import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const manifest = JSON.parse(fs.readFileSync("openclaw.plugin.json", "utf8"));

const CATEGORIES = new Set([
  "channels", "models", "agent-runtimes", "memory", "context", "voice", "web", "computer-use", "media",
  "security", "integrations", "developer-tools", "infrastructure", "documents-files", "inbox-collaboration",
  "productivity", "scheduling", "finance-payments", "sales-marketing", "data-analytics", "agent-orchestration",
  "research", "other",
]);

test("package metadata declares the plugin entry point", () => {
  assert.equal(pkg.name, "openclaw-claude-quota-resume");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.openclaw.extensions, ["./dist/index.js"]);
  assert.equal(pkg.main, "./dist/index.js");
  assert.equal(pkg.type, "module");
});

test("compatibility and build metadata follow the documented format", () => {
  const { compat, build } = pkg.openclaw;
  assert.match(compat.pluginApi, /^>=\d{4}\.\d+\.\d+/, "pluginApi is a semver range");
  assert.match(compat.minGatewayVersion, /^\d{4}\.\d+\.\d+/, "minGatewayVersion is a bare version, not a range");
  assert.match(build.openclawVersion, /^\d{4}\.\d+\.\d+/);
  assert.match(build.pluginSdkVersion, /^\d{4}\.\d+\.\d+/);
  assert.match(pkg.peerDependencies.openclaw, /^>=\d{4}\.\d+\.\d+/);
  assert.equal(`>=${compat.minGatewayVersion}`, pkg.peerDependencies.openclaw, "peer range and minimum Gateway agree");
});

test("manifest identity and version match the package", () => {
  assert.equal(manifest.id, "claude-quota-resume");
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.name && manifest.description);
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.equal(manifest.activation.onStartup, true);
});

test("manifest declares exactly one valid catalog category", () => {
  assert.equal(manifest.categories.length, 1);
  assert.ok(CATEGORIES.has(manifest.categories[0]), manifest.categories[0]);
});

test("every documented config option is in the manifest schema, with sane bounds", () => {
  const props = manifest.configSchema.properties;
  for (const key of ["statePath", "initialRetryMs", "maxAttempts"]) assert.ok(props[key], key);
  assert.ok(props.initialRetryMs.minimum >= 1000 && props.initialRetryMs.maximum <= 3_600_000);
  assert.ok(props.maxAttempts.minimum >= 1 && props.maxAttempts.maximum <= 1000);
});

test("the published file list contains the runtime and excludes sources, tests and local state", () => {
  assert.deepEqual([...pkg.files].sort(), ["CHANGELOG.md", "LICENSE", "README.md", "dist/index.js", "openclaw.plugin.json"]);
  for (const bad of ["test", "src", "queue.json", ".env", "node_modules"]) {
    assert.ok(!pkg.files.some((f) => f === bad || f.startsWith(`${bad}/`)), bad);
  }
});

test("runtime dependencies are not bundled into the published package metadata", () => {
  assert.equal(pkg.dependencies, undefined, "all code is bundled; the host provides openclaw");
});

test("the engines range matches the OpenClaw runtime requirement", () => {
  assert.equal(pkg.engines.node, ">=24.16.0 <25 || >=26.1.0");
});

test("compiled plugin entry point exists and is a bundle, not a re-export of TypeScript", () => {
  const file = pkg.openclaw.extensions[0];
  assert.ok(fs.existsSync(file));
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!/from\s+["']\.\/src\//.test(text), "no relative imports left in the bundle");
  assert.match(text, /openclaw\/plugin-sdk\/plugin-entry/, "SDK stays external");
  assert.match(text, /claude-quota-resume/);
});
