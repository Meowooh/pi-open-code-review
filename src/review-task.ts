import type { Finding, ReviewReport } from "./ocr.ts";
import type { ReviewScope } from "./review-input.ts";

export type ReviewProgress = { activity: string; candidates?: readonly Finding[] };
export type ReviewPhase = "running" | "stopping" | "stopped" | "completed" | "partial" | "skipped" | "failed";

export const REVIEW_TICK_MS = 200;

export function outcome(status: string): [ReviewPhase, string] {
  switch (status) {
    case "complete": case "success": return ["completed", "Completed"];
    case "partial": case "completed_with_errors": return ["partial", "Partial review"];
    case "completed_with_warnings": return ["partial", "Completed with warnings"];
    case "skipped": return ["skipped", "Skipped"];
    default: return ["failed", "Failed"];
  }
}

/** One session-local TUI run. The viewer subscribes to the run; closing it never owns cancellation. */
export class ReviewTask {
  readonly model: string;
  readonly scope?: ReviewScope;
  readonly startedAt = Date.now();
  endedAt?: number;
  phase: ReviewPhase = "running";
  activity = "Starting review";
  findings: readonly Finding[] = [];
  report?: ReviewReport;
  error?: string;
  private cancel: AbortController;
  private listeners = new Set<() => void>();

  constructor(model: string, cancel: AbortController, scope?: ReviewScope) {
    this.model = model;
    this.scope = scope;
    this.cancel = cancel;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private refresh() { for (const listener of this.listeners) listener(); }

  stop() {
    if (this.phase !== "running") return;
    this.phase = "stopping";
    this.activity = "Stopping";
    this.cancel.abort();
    this.refresh();
  }

  async run<T extends ReviewReport>(execute: (onProgress: (event: ReviewProgress) => void) => Promise<T>): Promise<T | undefined> {
    const tick = setInterval(() => this.refresh(), REVIEW_TICK_MS);
    tick.unref();
    try {
      const report = await execute(({ activity, candidates }) => {
        if (this.cancel.signal.aborted || this.phase !== "running") return;
        this.activity = activity;
        if (candidates) this.findings = candidates;
        this.refresh();
      });
      this.cancel.signal.throwIfAborted();
      this.report = report;
      // Reconcile, don't append: OCR filters and relocates candidate comments before writing its report.
      this.findings = report.comments;
      [this.phase, this.activity] = outcome(report.status);
      if (this.phase === "failed") this.error = report.message || `OCR status: ${report.status}`;
      return report;
    } catch (error) {
      if (this.cancel.signal.aborted) {
        this.phase = "stopped";
        this.activity = "Stopped";
      } else {
        this.phase = "failed";
        this.activity = "Failed";
        this.error = error instanceof Error ? error.message : "OCR review failed";
      }
    } finally {
      clearInterval(tick);
      this.endedAt = Date.now();
      this.refresh();
    }
  }
}
