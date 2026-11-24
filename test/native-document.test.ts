import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { runNative } from "../src/ocr.ts";
import { createPiChat } from "../src/pi-chat.ts";

const posixOnly = { skip: process.platform === "win32" };
const signal = new AbortController().signal;
const preview = { total_files: 0, files: null };
const stubChat = () => createPiChat({ streamSimple: () => assert.fail("unexpected model call") }, { provider: "fixture", id: "reviewer" } as Model<Api>);

type Capture = {
  args: string[]; home: string; homeMode: number; hasBridge: boolean;
  background?: { path: string; mode: number; text: string };
};

async function stubOcr(t: TestContext, output: string, linger = false) {
  const dir = await mkdtemp(join(tmpdir(), "ocr-document-test-"));
  const cwd = join(dir, "checkout");
  const temp = join(dir, "private homes");
  const capture = join(dir, "capture.json");
  const { TMPDIR, PATH } = process.env;
  t.after(async () => {
    for (const [key, value] of Object.entries({ TMPDIR, PATH })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  await Promise.all([mkdir(cwd), mkdir(temp)]);
  await writeFile(join(dir, "ocr"), `#!/usr/bin/env node
const { readFileSync, statSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const at = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const file = at("--background-file");
const home = process.env.HOME;
const token = process.env.OCR_LLM_TOKEN;
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args, home, homeMode: statSync(home).mode & 0o777, hasBridge: !!token,
  background: file && { path: file, mode: statSync(file).mode & 0o777, text: readFileSync(file, "utf8") },
}));
process.stdout.write("private stdout is not a report");
process.stderr.write("private stderr is not a report");
writeFileSync(at("--output"), ${JSON.stringify(output)}.replaceAll("__BRIDGE_TOKEN__", token || ""));
if (${linger}) setInterval(() => {}, 60_000);
`, { mode: 0o700 });
  process.env.TMPDIR = temp;
  process.env.PATH = [dir, dirname(process.execPath), PATH].filter(Boolean).join(delimiter);
  return { dir, cwd, temp, capture, captured: async (): Promise<Capture> => JSON.parse(await readFile(capture, "utf8")) };
}

test("review keeps native fields, with only public comments in the Fleet summary", posixOnly, async t => {
  const comment = {
    path: "src/example.ts", start_line: 31, end_line: 33, content: "Handle the empty input.",
    severity: "high", category: "bug", existing_code: "return items[0].id", suggestion_code: "return items[0]?.id",
  };
  const manifest = {
    schema_version: "ocr.run-manifest/v1", terminal_state: "complete", input: { mode: "range" },
    coverage: { selected: [{ path: comment.path, item_id: "stable-id" }], completed: [{ path: comment.path, item_id: "stable-id" }] },
  };
  const document = {
    status: "complete", message: "Native report message.", manifest, summary: { total_tokens: 22 },
    comments: [{ ...comment, extra: { link: "finding-link" } }], extra_metadata: [{ value: 42 }],
    tool_calls: { failure_details: [{ tool_name: "code_comment", arguments: "[redacted]", error: "[redacted]" }] },
    echoed_credential: "[redacted]",
  };
  const fixture = await stubOcr(t, JSON.stringify({
    ...document, thinking: "private top-level thought", echoed_credential: "__BRIDGE_TOKEN__",
    comments: [{ ...document.comments[0], thinking: "private comment thought" }],
    extra_metadata: [{ value: 42, thinking: "private nested thought" }],
    tool_calls: { failure_details: [{ tool_name: "code_comment", arguments: '{"thinking":"private serialized thought"}', error: "echoed raw prompt" }] },
  }));
  const background = "Review against private requirement marker: $(printf test).\nLeave quoted text alone.";
  const result = await runNative(fixture.cwd, ["--from", "main", "--to", "topic"], stubChat(), signal, undefined, { background: ` \n${background}\n ` });
  assert.deepEqual(result, {
    status: document.status, message: document.message, comments: [comment], document,
    coverage: { selected: [comment.path], completed: [comment.path] },
  });
  const { args, home, homeMode, background: staged, hasBridge } = await fixture.captured();
  assert.equal(homeMode, 0o700);
  assert.equal(hasBridge, true);
  assert.deepEqual(staged, { path: join(home, "background.md"), mode: 0o600, text: background });
  assert.deepEqual(args, [
    "review", "--repo", fixture.cwd, "--format", "json", "--output", join(home, "result.json"), "--audience", "agent",
    "--from", "main", "--to", "topic", "--background-file", staged!.path,
    "--concurrency", "1", "--effort", "low", "--timeout", "3", "--max-tokens-budget", "120000",
  ]);
  assert.doesNotMatch(args.join(" "), /private requirement marker/);
  assert.deepEqual(await readdir(fixture.temp), []);
});

test("native null comments stay null in the document", posixOnly, async t => {
  const document = { status: "skipped", message: "No supported files changed.", comments: null, tool_calls: null };
  const fixture = await stubOcr(t, JSON.stringify(document));
  const result = await runNative(fixture.cwd, [], stubChat(), signal);
  assert.equal(result.status, document.status);
  assert.deepEqual(result.comments, []);
  assert.deepEqual(result.document, document);
  assert.equal((await fixture.captured()).background, undefined);
  assert.deepEqual(await readdir(fixture.temp), []);
});

test("preview preserves file metadata and snapshots a normalized checkout Markdown path", posixOnly, async t => {
  const document = {
    total_files: 2, total_insertions: 4, total_deletions: 6, reviewable_count: 1, excluded_count: 1,
    files: [
      { path: "a.ts", status: "modified", insertions: 4, deletions: 5, will_review: true },
      { path: "b.png", status: "deleted", insertions: 0, deletions: 1, will_review: false, exclude_reason: "binary" },
    ],
  };
  const fixture = await stubOcr(t, JSON.stringify(document));
  await mkdir(join(fixture.cwd, "docs"));
  const name = "Review notes.MARKDOWN";
  const source = join(fixture.cwd, "docs", name);
  const text = `\r\n \u200b${"🙂".repeat(8000)}\r\n`;
  await writeFile(source, text);
  await symlink("docs", join(fixture.cwd, "docs-link"));
  for (const backgroundFile of [` @./docs-link/${name} `, `@${await realpath(source)}`]) {
    const result = await runNative(fixture.cwd, ["--commit", "HEAD"], undefined, signal, undefined, { backgroundFile });
    assert.deepEqual(result, {
      status: "preview", message: "No model request made.", coverage: { selected: ["a.ts"], excluded: ["b.png"] }, comments: [], document,
    });
    const { args, home, background, hasBridge } = await fixture.captured();
    assert.equal(hasBridge, false);
    assert.deepEqual(background, { path: join(home, "background.md"), mode: 0o600, text });
    assert.ok(args.includes("--preview"));
    assert.ok(!args.includes(source));
    assert.equal(await readFile(source, "utf8"), text);
    assert.deepEqual(await readdir(fixture.temp), []);
  }
});

test("invalid background paths and content fail before OCR starts and leave no home", posixOnly, async t => {
  const fixture = await stubOcr(t, JSON.stringify(preview));
  const { cwd, dir } = fixture;
  const sibling = join(dir, "checkout-sibling");
  await mkdir(sibling);
  await writeFile(join(sibling, "secret.md"), "Private outside checkout");
  await symlink(join(sibling, "secret.md"), join(cwd, "outside.md"));
  await symlink(sibling, join(cwd, "outside"));
  await mkdir(join(cwd, "folder.md"));
  await writeFile(join(cwd, "plain.txt"), "Not a Markdown file");
  await writeFile(join(cwd, "large.md"), "ok");
  await truncate(join(cwd, "large.md"), 1024 * 1024 + 1);
  await writeFile(join(cwd, "long.md"), "🙂".repeat(8001));
  await writeFile(join(cwd, "invalid.md"), Buffer.from([0xff]));
  const checked: [Parameters<typeof runNative>[5], RegExp][] = [
    [{ background: "Requirements", backgroundFile: "missing.md" }, /not both/],
    [{ backgroundFile: "@../checkout-sibling/secret.md" }, /inside the checkout/],
    [{ backgroundFile: join(sibling, "secret.md") }, /inside the checkout/],
    [{ backgroundFile: "outside.md" }, /inside the checkout/],
    [{ backgroundFile: "@outside/secret.md" }, /inside the checkout/],
    [{ backgroundFile: "folder.md" }, /regular .md or .markdown file/],
    [{ backgroundFile: "missing.md" }, /existing regular/],
    [{ backgroundFile: "plain.txt" }, /regular .md or .markdown file/],
    [{ backgroundFile: "@" }, /regular .md or .markdown file/],
    [{ backgroundFile: "large.md" }, /1 MiB/],
    [{ backgroundFile: "long.md" }, /8000 characters/],
    [{ backgroundFile: "invalid.md" }, /UTF-8 Markdown/],
    [{ background: "x".repeat(8001) }, /8000 characters/],
    [{ background: "text <ocr_user_background>" }, /reserved delimiter/],
  ];
  for (const [context, message] of checked) {
    await assert.rejects(runNative(cwd, [], undefined, signal, undefined, context), message);
    assert.deepEqual(await readdir(fixture.temp), []);
    await assert.rejects(readFile(fixture.capture), { code: "ENOENT" });
  }
});

test("abort while OCR is running removes the staged background and home", posixOnly, async t => {
  const fixture = await stubOcr(t, JSON.stringify(preview), true);
  const cancel = new AbortController();
  const reason = new Error("abort review fixture");
  const spawned = (async () => {
    for await (const event of watch(fixture.dir, { signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(5000)]) })) {
      if (event.filename === "capture.json") return;
    }
  })();
  const review = runNative(fixture.cwd, [], undefined, cancel.signal, undefined, { background: "Abort cleanup marker" });
  try {
    await Promise.race([spawned, review.then(() => assert.fail("OCR should still be running"))]);
    const [home] = await readdir(fixture.temp);
    assert.equal(await readFile(join(fixture.temp, home, "background.md"), "utf8"), "Abort cleanup marker");
  } finally {
    cancel.abort(reason);
    await assert.rejects(review, error => error === reason);
  }
  assert.deepEqual(await readdir(fixture.temp), []);
});

test("invalid native JSON is an error without the raw content and removes the staged background", posixOnly, async t => {
  const fixture = await stubOcr(t, "RAW_INVALID_PRIVATE_DATA");
  await assert.rejects(runNative(fixture.cwd, [], undefined, signal, undefined, { background: "Cleanup marker" }), (error: Error) => {
    assert.match(error.message, /Invalid JSON in native OCR report/);
    assert.doesNotMatch(error.message, /RAW_INVALID_PRIVATE_DATA/);
    return true;
  });
  assert.deepEqual(await readdir(fixture.temp), []);
});
