import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import type { ReviewReport } from "./ocr.ts";
import { receiptHasDetails, receiptRows } from "./review-receipt-rows.ts";

/** Pi rebuilds the component on theme/width/global expansion changes. Mouse folds belong to the message. */
export function createReceiptRenderer(globalExpansion: () => boolean | undefined): MessageRenderer<ReviewReport> {
  const folds = new WeakMap<object, { open: boolean; global: boolean }>();
  return (message, { expanded, outputPad }, theme) => {
    const report = message.details;
    if (!report || typeof report.status !== "string" || !Array.isArray(report.comments) || report.status === "preview") return undefined;
    const global = globalExpansion() ?? expanded;
    let fold = folds.get(message);
    if (!fold) {
      // Even when other tool output is expanded, a newly arrived report takes only one row.
      fold = { open: false, global };
      folds.set(message, fold);
    } else if (fold.global !== global) {
      fold.global = global;
      fold.open = global;
    }
    const state = fold;
    const hasDetails = receiptHasDetails(report);
    let cache: { width: number; open: boolean; lines: string[] } | undefined;
    return {
      render(width) {
        const open = state.open && hasDetails;
        if (cache && cache.width === width && cache.open === open) return cache.lines;
        const pad = Math.max(0, Math.min(outputPad, width - 1));
        const prefix = " ".repeat(pad);
        const lines = width > 0 ? receiptRows(report, open, width - pad, theme).map(line => prefix + line) : [];
        cache = { width, open, lines };
        return lines;
      },
      invalidate() { cache = undefined; },
      handleMouse(event) {
        if (!hasDetails || event.y !== 0 || event.button !== "left" || event.shift || event.alt || event.ctrl) return;
        // Pi synthesizes a click only for a handled press. Never request keyboard focus or consume wheel input.
        if (event.type === "press") return { handled: true, render: false };
        if (event.type === "click") {
          state.open = !state.open;
          return { handled: true, render: true };
        }
      },
    };
  };
}
