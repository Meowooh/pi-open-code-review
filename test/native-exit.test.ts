import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { runNative } from "../src/ocr.ts";
import { createPiChat } from "../src/pi-chat.ts";

test("a progress sink preserves native partial or failed reports on exit 1, never success", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocr-exit-test-")), original = process.env.PATH;
  const chat = createPiChat({ streamSimple: () => assert.fail("unexpected model call") }, { provider: "fixture", id: "reviewer" } as Model<Api>);
  const signal = new AbortController().signal;
  const progress = () => {};
  try {
    process.env.PATH = original ? dir + delimiter + original : dir;
    for (const status of ["partial", "failed", "completed_with_errors", "success"]) {
      const comments = status === "partial" ? [{ path: "sample.py", content: "One file was reviewed.", start_line: 1, end_line: 1 }] : null;
      const document = { status, message: "Native review message.", comments };
      await writeFile(join(dir, "ocr"), `#!/bin/sh
while [ "$1" != "--output" ]; do shift; done
printf '%s' '${JSON.stringify(document)}' > "$2"
printf '%s\\n' '{' '  "prompt": "private stderr usage dump"' '}' 'incomplete coverage' >&2
exit 1
`, { mode: 0o700 });
      const exitDiagnostic = (error: Error) => {
        assert.match(error.message, /incomplete coverage/);
        assert.doesNotMatch(error.message, /private stderr usage dump/);
        return true;
      };
      await assert.rejects(runNative(dir, [], chat, signal), exitDiagnostic); // Existing strict contract.
      if (status === "success") {
        await assert.rejects(runNative(dir, [], chat, signal, progress), exitDiagnostic);
      } else {
        const report = await runNative(dir, [], chat, signal, progress);
        assert.equal(report.status, status);
        assert.deepEqual(report.comments.map(comment => comment.path), comments?.map(comment => comment.path) ?? []);
        assert.deepEqual(report.document, document);
      }
    }
    await writeFile(join(dir, "ocr"), "#!/bin/sh\necho 'missing repository' >&2\nexit 1\n");
    await assert.rejects(runNative(dir, [], chat, signal, progress), /missing repository/);
  } finally {
    if (original === undefined) delete process.env.PATH; else process.env.PATH = original;
    await rm(dir, { recursive: true, force: true });
  }
});
