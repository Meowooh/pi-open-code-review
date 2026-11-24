import assert from "node:assert/strict";
import test from "node:test";
import { deferred } from "./deferred.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type Finding, type ReviewReport } from "../src/ocr.ts";
import { REVIEW_TICK_MS, ReviewTask, type ReviewProgress } from "../src/review-task.ts";
import { type Palette, reviewWidget, statusLine, toolStatus } from "../src/review-widget.ts";

const plain: Palette = { fg: (_, text) => text };
const finding: Finding = { path: "文件.ts", content: "An issue", start_line: 0, end_line: 0 };

test("the widget observes real candidates; the final report replaces them rather than counting them twice", async () => {
  const job = new ReviewTask("fixture/review-model", new AbortController());
  let renders = 0;
  const widget = reviewWidget(job, { requestRender: () => renders++ }, plain);
  let progress!: (update: ReviewProgress) => void;
  const result = deferred<ReviewReport>();
  const done = job.run(update => { progress = update; return result.promise; });
  assert.doesNotMatch(widget.render(80)[0], /findings?|requests/i);
  progress({ activity: "Verifying findings", candidates: [finding, { ...finding, path: "other.ts" }] });
  assert.match(widget.render(80)[0], /^│ [\u2800-\u28ff] OCR  Verifying findings · review-model · 2 pending/);
  assert.equal(renders, 1);
  widget.dispose();
  result.resolve({ status: "complete", comments: [{ ...finding, start_line: 2, end_line: 3 }] });
  await done;
  assert.equal(renders, 1);
  assert.equal(job.findings.length, 1);
  assert.equal(job.findings[0].start_line, 2);
  assert.equal(job.phase, "completed");
  assert.ok(job.endedAt);
  assert.match(widget.render(80)[0], /^│ ✓ OCR  Completed · review-model · 1 finding · \d+s$/);
  const noTime = widget.render(visibleWidth("│ ✓ OCR  Completed · review-model · 1 finding"))[0];
  assert.match(noTime, /Completed · review-model · 1 finding$/);
  for (const width of [12, 20, 34, 48, 80]) {
    const line = statusLine(job, width, plain);
    assert.ok(visibleWidth(line) <= width);
    assert.match(line, /review-model/);
    assert.doesNotMatch(line, /requests|R1|workspace|\/review/);
  }
});

test("stopping ignores late progress and does not report success even when OCR wins the exit race", async () => {
  const cancel = new AbortController(), job = new ReviewTask("test/reviewer", cancel);
  const result = deferred<ReviewReport>();
  let progress!: (update: ReviewProgress) => void;
  const done = job.run(update => { progress = update; return result.promise; });
  job.stop(); job.stop();
  assert.ok(cancel.signal.aborted);
  progress({ activity: "Late event", candidates: [finding] });
  assert.equal(job.activity, "Stopping");
  assert.match(statusLine(job, 80, plain), /^│ ◌ OCR  Stopping/);
  result.resolve({ status: "complete", comments: [finding] });
  await done;
  assert.equal(job.phase, "stopped");
  assert.equal(job.report, undefined);
  assert.match(statusLine(job, 80, plain), /^│ ■ OCR  Stopped/);
  assert.deepEqual(job.findings, []);
});

test("a failed run retains its diagnostic; a partial result is not a clean review", async () => {
  const job = new ReviewTask("test/reviewer", new AbortController());
  await job.run(async () => { throw new Error("native CLI unavailable"); });
  assert.equal(job.phase, "failed");
  assert.match(job.error!, /unavailable/);
  const partial = new ReviewTask("test/reviewer", new AbortController());
  await partial.run(async () => ({ status: "partial", comments: [] }));
  assert.equal(partial.phase, "partial");
  assert.match(statusLine(job, 80, plain), /^│ ! OCR  Failed/);
  assert.match(statusLine(partial, 80, plain), /^│ △ OCR  Partial review/);
});

test("spinner advances during review only; receipts distinguish skipped, partial, failed and preview", async t => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const task = new ReviewTask("fixture/reviewer", new AbortController());
  const line = () => statusLine(task, 80, plain);
  const start = line(); now += REVIEW_TICK_MS;
  assert.notEqual(line(), start);
  await task.run(async () => ({ status: "skipped", comments: [] }));
  const end = line(); now += 2_000;
  assert.equal(line(), end);
  assert.match(end, /^│ ↷ OCR  Skipped/);
  assert.equal(toolStatus("preview", undefined, 0, plain), "◇ OCR  Preview");
  assert.match(toolStatus("complete", "fixture/reviewer", 2, plain), /^✓ OCR  Completed · reviewer · 2 findings$/);
  assert.match(toolStatus("completed_with_errors", "fixture/reviewer", 0, plain), /^△ OCR  Partial review/);
  assert.match(toolStatus("failed", "fixture/reviewer", 0, plain), /^! OCR  Failed/);
});
