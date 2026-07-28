// Hermetic tests for the sandbox spawn recipe (the pure part). The actual
// lifecycle (boot, readiness, teardown) is exercised by the live
// `daml-fuzz run --sandbox` path — it spawns the SDK and can't run in CI.

import assert from "node:assert/strict";
import { test } from "node:test";
import { delimiter, join } from "node:path";
import { sandboxCommand } from "../src/sandbox.ts";

const PORT_DIR = join("tmp", "ports");

test("recipe: ports, port files, and DAR are all present", () => {
  const r = sandboxCommand({ dar: "a.dar", ledgerPort: 7011, jsonPort: 7575 }, PORT_DIR);
  const flat = r.args ? [r.command, ...r.args].join(" ") : r.command;
  for (const part of [
    "sandbox",
    "--dar a.dar",
    "--port 7011",
    "--json-api-port 7575",
    `--port-file ${join(PORT_DIR, "ledger.port")}`,
    `--json-api-port-file ${join(PORT_DIR, "json.port")}`,
  ]) {
    assert.ok(flat.includes(part), `missing ${part} in: ${flat}`);
  }
});

test("recipe: defaults are 6865 / 7575", () => {
  const r = sandboxCommand({ dar: "a.dar" }, PORT_DIR);
  const flat = r.args ? [r.command, ...r.args].join(" ") : r.command;
  assert.ok(flat.includes("--port 6865"));
  assert.ok(flat.includes("--json-api-port 7575"));
});

test("recipe: javaHome prepends bin to the child's EXISTING path variable", () => {
  const r = sandboxCommand({ dar: "a.dar", javaHome: join("E:", "jdk") }, PORT_DIR);
  // On Windows the key is "Path" — the recipe must extend that one, not
  // mint a second "PATH" that shadows it with a JDK-only value.
  const keys = Object.keys(r.env).filter((k) => k.toUpperCase() === "PATH");
  assert.equal(keys.length, 1, `duplicate path keys: ${keys}`);
  const merged = r.env[keys[0]]!;
  assert.ok(merged.startsWith(join("E:", "jdk", "bin") + delimiter));
  assert.ok(merged.length > join("E:", "jdk", "bin").length + 1, "original PATH lost");
  // The parent process env must be untouched.
  assert.ok(!(process.env.PATH ?? "").startsWith(join("E:", "jdk", "bin")));
});

test("recipe: win32 gets one pre-quoted shell string, POSIX gets argv", () => {
  const dir = join("C:", "port dir"); // space forces quoting
  const r = sandboxCommand({ dar: "my contracts.dar" }, dir);
  if (process.platform === "win32") {
    assert.equal(r.args, null);
    assert.ok(r.command.includes('"my contracts.dar"'), r.command);
    assert.ok(r.command.includes(`"${join(dir, "json.port")}"`), r.command);
  } else {
    assert.ok(Array.isArray(r.args));
    assert.equal(r.command, "daml");
    assert.ok(r.args!.includes("my contracts.dar")); // argv needs no quoting
  }
});
