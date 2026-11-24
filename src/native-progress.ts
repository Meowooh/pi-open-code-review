import type { ToolCall } from "@earendil-works/pi-ai";
import type { Finding } from "./ocr.ts";
import type { ReviewProgress } from "./review-task.ts";

type ToolTurn = Pick<ToolCall, "name" | "arguments">;
export type ProgressSink = (progress: ReviewProgress) => void;

/** One observer per bridge/run. We expose known tool activities, not prompts, raw tool output or model reasoning. */
export function nativeProgress(emit: ProgressSink) {
  let candidates: Finding[] = [];
  return {
    requested(names: string[]) {
      emit({ activity: names.includes("approve_all_comments") ? "Verifying findings" : "Reviewing changes" });
    },
    calling({ name, arguments: args }: ToolTurn) {
      const path = typeof args.file_path === "string" ? args.file_path : undefined;
      const activities: Record<string, string> = {
        file_read: path ? `Reading ${path}` : "Reading file", file_read_diff: path ? `Inspecting ${path}` : "Inspecting diff",
        code_search: "Searching code", file_find: "Finding files", code_comment: "Submitting findings",
        task_done: "Finishing review task", approve_all_comments: "Verifying findings",
      };
      if (Object.hasOwn(activities, name)) emit({ activity: activities[name] });
    },
    // Called once per *wire call ID* when OCR replays its result, never just because the model proposed a finding.
    returned(call: ToolTurn, content: string) {
      if (call.name !== "code_comment" || content.trim() !== "Successfully commented.") return;
      const raw = call.arguments.comments;
      if (!Array.isArray(raw)) return; // OCR can repair malformed batches; only its final report can describe those reliably.
      const batch: Finding[] = [];
      for (const item of raw) {
        if (!item || typeof item !== "object" || typeof item.path !== "string" || !item.path.trim() || typeof item.content !== "string" || !item.content.trim()) continue;
        const str = (s: unknown) => typeof s === "string" ? s : undefined;
        batch.push({ path: item.path, content: item.content, start_line: 0, end_line: 0,
          severity: str(item.severity), category: str(item.category), existing_code: str(item.existing_code), suggestion_code: str(item.suggestion_code) });
      }
      if (!batch.length) return;
      candidates = candidates.concat(batch);
      emit({ activity: "Reviewing changes", candidates });
    },
  };
}
