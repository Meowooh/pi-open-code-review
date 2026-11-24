import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { NativeResult } from "./ocr.ts";
import { oneLine } from "./review-widget.ts";

/** Keep normal reports as OCR JSON. Spill oversized ones, never return a silently cut list of findings. */
export class ReportText {
  private directory?: Promise<string>;
  private writes = new Set<Promise<string>>();
  private closed = false;

  async forModel(report: NativeResult): Promise<string> {
    if (this.closed) throw new Error("The review session has ended.");
    const json = JSON.stringify(report.document);
    if (Buffer.byteLength(json) <= DEFAULT_MAX_BYTES) return json;
    this.directory ??= mkdtemp(join(tmpdir(), "pi-ocr-reports-"));
    const write = this.directory.then(async dir => {
      const path = join(dir, `${randomUUID()}.json`);
      await writeFile(path, json, { mode: 0o600, flag: "wx" });
      const summary = report.status === "preview" ? `${report.coverage?.selected?.length ?? 0} selected files` : `${report.comments.length} findings`;
      const sample = report.comments.slice(0, 3).map(f => `${oneLine(f.path).slice(0, 180)}:${f.start_line || "?"} — ${oneLine(f.content).slice(0, 240)}`);
      return [`OCR ${oneLine(report.status)}: ${summary}. The native JSON exceeds the inline limit.`,
        `Full report (read during this session): ${path}`, ...sample].join("\n");
    });
    this.writes.add(write);
    try { return await write; } finally { this.writes.delete(write); }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled(this.writes);
    const dir = await this.directory?.catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
