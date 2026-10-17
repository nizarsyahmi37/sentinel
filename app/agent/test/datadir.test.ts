import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultDataDir } from "../src/sentinelRuntime.js";

test("data dir: writable cwd is used, read-only cwd falls back to temp", () => {
  const ok = mkdtempSync(path.join(tmpdir(), "dd-ok-"));
  assert.equal(defaultDataDir(ok, "/x"), path.join(ok, ".sentinel-data"));
  const ro = mkdtempSync(path.join(tmpdir(), "dd-ro-"));
  chmodSync(ro, 0o500);
  if (process.getuid?.() === 0) return; // root ignores permissions
  assert.equal(defaultDataDir(ro, "/x"), path.join("/x", "sentinel-data"));
});
