import { test } from "node:test";
import assert from "node:assert/strict";
import { winQuote, winCommandLine } from "../src/winshell.ts";

test("winshell: every argument is double-quoted", () => {
  assert.equal(winQuote("daml"), '"daml"');
  assert.equal(winQuote("C:\\My Files\\a.dar"), '"C:\\My Files\\a.dar"');
});

test("winshell: cmd operators stay inside the quotes", () => {
  for (const s of ["a&calc.dar", "a|b.dar", "a>b.dar", "a^b.dar", "C:\\Program Files (x86)\\y.dar"]) {
    assert.equal(winQuote(s), `"${s}"`);
  }
});

test("winshell: characters cmd still expands are refused", () => {
  for (const s of ['a".dar', "%PATH%.dar", "a!b.dar", "a\nb.dar", "a\rb.dar"]) {
    assert.throws(() => winQuote(s), /refusing to pass/);
  }
});

test("winshell: trailing backslash cannot escape the closing quote", () => {
  assert.equal(winQuote("C:\\dir\\"), '"C:\\dir\\\\"');
});

test("winshell: command line joins quoted parts", () => {
  assert.equal(winCommandLine("daml", ["damlc", "inspect", "x y.dar"]), '"daml" "damlc" "inspect" "x y.dar"');
});
