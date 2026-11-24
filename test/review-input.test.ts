import test from "node:test";
import assert from "node:assert/strict";
import { explicitScope, parseArgs, toolOptions, type ReviewInput } from "../src/review-input.ts";

test("only explicit review scope flags reach OCR", () => {
  assert.deepEqual(parseArgs("--model alpha beta --from main --to topic"), { model: "alpha beta", target: ["--from", "main", "--to", "topic"], preview: false });
  assert.deepEqual(parseArgs("--preview"), { model: undefined, target: [], preview: true });
  assert.equal(parseArgs("--model").model, "");
  assert.equal(parseArgs("--model=@review").model, "@review");
  for (const s of ["--provider other", "--commit --model", "--to branch", "--from main --commit HEAD", "--model a --model b"]) assert.throws(() => parseArgs(s));
});

test("ocr_review takes native scope fields, not flags disguised as business context", () => {
  assert.deepEqual(toolOptions({}).target, []);
  assert.deepEqual(toolOptions({ from: "main", to: "feature/tax", exclude: "vendor/**,dist/**" }).target,
    ["--from", "main", "--to", "feature/tax", "--exclude", "vendor/**,dist/**"]);
  const text = "Validate USD rounding.\nUse 1¢ as a fixture. --commit other is not a flag here.";
  assert.equal(toolOptions({ commit: "HEAD", background: text }).background, text);
  for (const invalid of [{ from: "main" }, { to: "HEAD" }, { commit: "HEAD", from: "main", to: "next" },
    { commit: "--resume" }, { from: "main", to: "" }, { background: "note", backgroundFile: "note.md" }, { model: "  " }] satisfies ReviewInput[]) {
    assert.throws(() => toolOptions(invalid));
  }
});

test("the Fleet shows only explicit selectors, including a direct range's implicit HEAD", () => {
  assert.deepEqual(explicitScope(parseArgs("--from main").target), { from: "main", to: "HEAD" });
  assert.deepEqual(explicitScope(toolOptions({ from: "base", to: "topic" }).target), { from: "base", to: "topic" });
  assert.deepEqual(explicitScope(toolOptions({ commit: "HEAD~2" }).target), { commit: "HEAD~2" });
  assert.equal(explicitScope(toolOptions({ exclude: "--commit", background: "Review --from main" }).target), undefined);
});

test("direct background flags pass through without invoking the session agent", () => {
  assert.deepEqual(parseArgs('--commit HEAD --background "Review refund totals" --model @review'), {
    target: ["--commit", "HEAD"], model: "@review", preview: false, background: "Review refund totals",
  });
  assert.equal(parseArgs("--preview --background-file docs/refund policy.md").backgroundFile, "docs/refund policy.md");
  const quoted = parseArgs('--background "Discuss --commit HEAD and\n- tax boundaries"');
  assert.equal(quoted.background, "Discuss --commit HEAD and\n- tax boundaries");
  assert.deepEqual(quoted.target, []);
  assert.throws(() => parseArgs('--background "not closed'), /Unclosed quote/);
  assert.throws(() => parseArgs("--background"), /Missing value/);
  assert.throws(() => parseArgs("--background yes --background-file x.md"), /not both/);
});
