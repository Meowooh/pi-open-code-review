import { stripVTControlCharacters } from "node:util";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { outcome, REVIEW_TICK_MS, type ReviewPhase, type ReviewTask } from "./review-task.ts";

// Paths, findings, diagnostics and model IDs are data, not terminal instructions.
export function plainText(text: string): string {
  return stripVTControlCharacters(text.replace(/\r\n/g, "\n")).replace(/\t/g, "    ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
export const oneLine = (text: string) => plainText(text).replace(/\s+/gu, " ").trim();
export const findingCount = (n: number) => `${n} finding${n === 1 ? "" : "s"}`;
export type Palette = Pick<Theme, "fg">;

const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const signals = {
  completed: ["✓", "success"], partial: ["△", "warning"], skipped: ["↷", "muted"],
  stopping: ["◌", "warning"], stopped: ["■", "muted"], failed: ["!", "error"],
} as const;
export function reviewSignal(phase: ReviewPhase, elapsedMs = 0): readonly [string, ThemeColor] {
  return phase === "running" ? [spinner[Math.floor(elapsedMs / REVIEW_TICK_MS) % spinner.length], "accent"] : signals[phase];
}
const modelName = (id: string) => oneLine(id.slice(id.indexOf("/") + 1));

/** The tool receipt uses the same terminal states as the widget, but has no live timer. */
export function toolStatus(status: string, id: string | undefined, count: number, theme: Palette): string {
  if (status === "preview") return theme.fg("muted", "◇ OCR  Preview");
  const [phase, activity] = outcome(status), [mark, color] = reviewSignal(phase);
  return [theme.fg(color, `${mark} OCR  ${activity}`), id && modelName(id), count ? findingCount(count) : undefined].filter(Boolean).join(" · ");
}

/** One status vocabulary; only the editor row needs a rail, brand and count. Fleet owns its own heading. */
export function statusLine(task: ReviewTask, width: number, theme: Palette, view: "widget" | "fleet" = "widget"): string {
  const ms = Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt);
  const [mark, color] = reviewSignal(task.phase, ms);
  const dot = theme.fg("dim", " · "), glyph = theme.fg(color, mark);
  const widget = view === "widget";
  const rail = widget ? theme.fg(color, "│ ") : "";
  const lead = widget ? `${rail}${glyph} OCR  ` : `${glyph} `;
  const model = theme.fg("text", modelName(task.model));
  const n = task.findings.length;
  const label = task.report ? findingCount(n) : `${n} ${task.phase === "running" ? "pending" : "unverified"}`;
  const count = widget && n ? dot + theme.fg("warning", label) : "";
  const suffix = dot + model + count;
  const activity = oneLine(task.activity);
  const time = theme.fg("dim", `${Math.floor(ms / 1000)}s`);
  const line = lead + theme.fg(color, activity) + suffix;
  const spare = width - visibleWidth(line + time);
  if (spare >= 3) return line + (widget ? dot : " ".repeat(spare)) + time;
  if (visibleWidth(line) <= width) return line;
  const room = width - visibleWidth(lead + suffix);
  if (room >= 5) return lead + theme.fg(color, truncateToWidth(activity, room, "…")) + suffix;
  for (const small of [lead + model + count, `${rail}${glyph} ${model}${count}`, `${rail}${glyph} ${model}`]) {
    if (visibleWidth(small) <= width) return small;
  }
  return truncateToWidth(model, width, "…");
}

export function reviewWidget(task: ReviewTask, tui: Pick<TUI, "requestRender">, theme: Palette) {
  const unsubscribe = task.subscribe(() => tui.requestRender());
  return { render: (width: number) => [statusLine(task, width, theme)], invalidate() {}, dispose: unsubscribe };
}
