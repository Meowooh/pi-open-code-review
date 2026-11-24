import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ReviewReport } from "./ocr.ts";
import { commentLines, findingSeverity, numberedFindingRows, paintSeverity } from "./review-finding.ts";
import { outcome } from "./review-task.ts";
import { findingCount, plainText, reviewSignal } from "./review-widget.ts";

type Palette = Pick<Theme, "fg" | "bold">;

function severityCounts(report: ReviewReport, theme: Palette): string[] {
  const buckets = new Map<string, { severity: ReturnType<typeof findingSeverity>; count: number }>();
  for (const finding of report.comments) {
    const severity = findingSeverity(finding.severity), key = `${severity.order}:${severity.label}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.count++;
    else buckets.set(key, { severity, count: 1 });
  }
  return [...buckets.values()].sort((a, b) => a.severity.order - b.severity.order)
    .map(({ severity, count }) => paintSeverity(severity, `${count} ${severity.label}`, theme));
}

export function receiptHasDetails(report: ReviewReport): boolean {
  return report.comments.length > 0 || !!plainText(report.message ?? "").trim();
}

function summary(report: ReviewReport, expanded: boolean, width: number, theme: Palette): string {
  const [phase, label] = outcome(report.status), count = report.comments.length;
  const [mark, color] = reviewSignal(phase), clickable = receiptHasDetails(report);
  const chevron = expanded ? "▾" : "▸", dot = theme.fg("dim", " · ");
  const glyph = clickable ? theme.fg("accent", chevron) : theme.fg(color, mark);
  const brand = clickable ? theme.fg("accent", `${chevron} OCR`) : glyph + " " + theme.fg("accent", "OCR");
  const state = phase === "completed" ? "" : theme.fg(color, label);
  const total = count ? findingCount(count) : phase === "completed" ? "No findings" : "";
  const countText = total && theme.fg("text", total);
  const info = [state, countText].filter(Boolean).join(dot);
  const base = brand + dot + info, room = width - visibleWidth(base);
  if (room < 0) {
    // Preserve the outcome or finding count rather than clipping it to keep the OCR brand.
    const compact = glyph + " " + info;
    if (visibleWidth(compact) <= width) return compact;
    return visibleWidth(info) <= width ? info : truncateToWidth(state || countText, width, "…");
  }
  if (!count || room === 0) return base;
  const full = [base, ...severityCounts(report, theme)].join(dot);
  return visibleWidth(full) <= width ? full : base;
}

/** Render a static transcript receipt; only the receipt itself has an expansion affordance. */
export function receiptRows(report: ReviewReport, expanded: boolean, width: number, theme: Pick<Theme, "fg" | "bg" | "bold">): string[] {
  width = Math.floor(width);
  if (!Number.isFinite(width) || width < 1) return [];
  const rows = [summary(report, expanded, width, theme)];
  if (!expanded) return rows;

  const message = plainText(report.message ?? "");
  if (message.trim()) {
    rows.push("");
    for (const row of commentLines(message, width)) rows.push(theme.fg("muted", row));
  }
  for (const [i, finding] of report.comments.entries()) {
    rows.push("");
    for (const row of numberedFindingRows(finding, i + 1, width, theme)) rows.push(row);
  }
  return rows;
}
