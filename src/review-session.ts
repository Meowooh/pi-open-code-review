import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runNative, type NativeResult } from "./ocr.ts";
import { createPiChat } from "./pi-chat.ts";
import { explicitScope, type ReviewOptions } from "./review-input.ts";
import { ReviewTask } from "./review-task.ts";
import { reviewWidget } from "./review-widget.ts";
import { modelKey, selectReviewModel } from "./select-model.ts";

const widgetKey = "open-code-review";

/** One launch path for commands and tools. The caller owns result delivery, not the Fleet viewer. */
export class SessionReviews {
  private native: typeof runNative;
  private active?: { cancel: AbortController; done?: Promise<NativeResult> };
  private lifetime = new AbortController();
  latest?: ReviewTask;
  private widgetVisible = false;

  constructor(native: typeof runNative) { this.native = native; }
  get busy() { return !!this.active; }
  get closed() { return this.lifetime.signal.aborted; }

  dismissFinishedWidget(ctx: ExtensionContext) {
    if (!this.widgetVisible || ctx.mode !== "tui" || this.latest?.endedAt === undefined) return;
    ctx.ui.setWidget(widgetKey, undefined);
    this.widgetVisible = false;
    // Keep latest: Fleet and the inline receipt outlive the transient editor row.
  }

  async start(ctx: ExtensionContext, opts: ReviewOptions, origin: "command" | "tool", caller?: AbortSignal) {
    if (this.busy) throw new Error("An OCR review is already running");
    const parent = caller ? AbortSignal.any([this.lifetime.signal, caller]) : this.lifetime.signal;
    parent.throwIfAborted();
    const cancel = new AbortController(), signal = cancel.signal;
    const abort = () => cancel.abort(parent.reason);
    parent.addEventListener("abort", abort, { once: true });
    const job: NonNullable<typeof this.active> = { cancel };
    this.active = job;
    const release = () => {
      parent.removeEventListener("abort", abort);
      if (this.active === job) this.active = undefined;
    };
    try {
      const model = opts.preview ? undefined : await selectReviewModel(ctx, opts.model, signal, origin === "command" && ctx.mode === "tui");
      signal.throwIfAborted();
      if (!opts.preview && !model) { release(); return; } // Cancelled the explicit model picker.
      const level = model && ctx.scopedModels.find(x => modelKey(x.model) === modelKey(model))?.thinkingLevel || ctx.thinkingLevel;
      const chat = model && createPiChat(ctx.modelRegistry, model, level === "off" ? undefined : level);
      const execute = (progress?: Parameters<typeof runNative>[4]) => this.native(ctx.cwd, opts.target, chat, signal, progress,
        { background: opts.background, backgroundFile: opts.backgroundFile });
      if (chat && ctx.mode === "tui") {
        const task = new ReviewTask(chat.id, cancel, explicitScope(opts.target));
        ctx.ui.setWidget(widgetKey, (tui, theme) => reviewWidget(task, tui, theme), { placement: "aboveEditor" });
        this.latest = task;
        this.widgetVisible = true;
        job.done = task.run(execute).then(result => {
          signal.throwIfAborted();
          if (!result) throw new Error(task.error || "OCR produced no report");
          return result;
        });
      } else {
        // Agent tools retain a published partial report even when native OCR exits nonzero.
        job.done = execute(origin === "tool" && !opts.preview ? () => {} : undefined);
      }
      void job.done.then(release, release);
      return { done: job.done, signal, chat };
    } catch (error) { release(); throw error; }
  }

  async close(ctx: ExtensionContext) {
    this.lifetime.abort();
    this.latest = undefined;
    if (this.widgetVisible && ctx.mode === "tui") ctx.ui.setWidget(widgetKey, undefined);
    this.widgetVisible = false;
    await this.active?.done?.catch(() => {});
  }
}
