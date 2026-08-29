import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ambient runner threads disable Roblox Studio MCP without disabling delegated work", async () => {
  const source = await readFile(new URL("../runner/a2ac-runner.mjs", import.meta.url), "utf8");

  assert.match(source, /ambientCodexConfig=\{mcp_servers:\{Roblox_Studio:\{enabled:false\}\}\}/);
  assert.match(source, /new Codex\(\{codexPathOverride:config\.codexPath,config:ambientCodexConfig,/);
  assert.match(source, /const args = \["exec", "--approve-for-me"/);
  assert.doesNotMatch(source, /const args = \[[^\n]*Roblox_Studio/);
});
