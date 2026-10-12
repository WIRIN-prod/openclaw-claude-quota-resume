import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const manifest = JSON.parse(fs.readFileSync("openclaw.plugin.json", "utf8"));

test("package metadata declares the plugin entry point", () => {
  assert.equal(pkg.name, "openclaw-claude-quota-resume");
  assert.ok(pkg.license === "MIT");
  assert.ok(pkg.openclaw.extensions.includes("./dist/index.js"));
});

test("ClawHub compatibility and build metadata exist", () => {
  assert.ok(pkg.openclaw.compat.pluginApi);
  assert.ok(pkg.openclaw.compat.minGatewayVersion);
  assert.ok(pkg.openclaw.build.openclawVersion);
  assert.ok(pkg.openclaw.build.pluginSdkVersion);
});

test("manifest identity matches the package purpose", () => {
  assert.equal(manifest.id, "claude-quota-resume");
  assert.ok(manifest.name);
  assert.ok(manifest.description);
  assert.ok(manifest.configSchema);
});

test("compiled plugin entry point exists", () => {
  assert.ok(fs.existsSync(pkg.openclaw.extensions[0]));
});
