import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { ReportText } from "../src/report-text.ts";

test("the agent gets native JSON for small reviews and a complete private, session-scoped file for large ones", async () => {
  const store = new ReportText();
  const document = { status: "complete", comments: null, manifest: { terminal_state: "complete" } };
  const report = { status: "complete", comments: [], document };
  let path: string | undefined;
  try {
    assert.deepEqual(JSON.parse(await store.forModel(report)), document);
    const large = { ...document, message: "x".repeat(51 * 1024) };
    const msg = await store.forModel({ ...report, document: large });
    assert.ok(Buffer.byteLength(msg) < 2 * 1024);
    const match = msg.match(/Full report \(read during this session\): (.+\.json)/);
    assert.ok(match);
    path = match[1];
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), large);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await store.close(); }
  await assert.rejects(stat(path!), { code: "ENOENT" });
  await assert.rejects(store.forModel(report), /session has ended/);
});
