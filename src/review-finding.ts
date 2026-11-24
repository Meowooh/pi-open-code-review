import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { Finding } from "./ocr.ts";
import { oneLine, plainText } from "./review-widget.ts";

type Foreground = Pick<Theme, "fg">;
type SeverityTheme = Foreground & Partial<Pick<Theme, "bold">>;
type Severity = { label: string; color: ThemeColor; order: number; bold?: true };
const ratedSeverities = [
  { label: "Critical", color: "error", bold: true },
  { label: "High", color: "error" },
  { label: "Medium", color: "warning" },
  { label: "Low", color: "muted" },
] as const;
const unratedSeverity: Severity = { label: "Unrated", color: "dim", order: ratedSeverities.length + 1 };
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const existingLabel = "Existing code", suggestedLabel = "Suggested change";
const divider = " │ ", minCodeColumns = 26;

export function findingSeverity(value?: string): Severity {
  const label = oneLine(value ?? "");
  const lower = label.toLowerCase();
  if (!label || lower === "unrated") return unratedSeverity;
  const order = ratedSeverities.findIndex(level => level.label.toLowerCase() === lower);
  return order >= 0 ? { ...ratedSeverities[order], order } : { label, color: "muted", order: ratedSeverities.length };
}

export function paintSeverity(severity: Severity, text: string, theme: SeverityTheme): string {
  return theme.fg(severity.color, severity.bold ? (theme.bold?.(text) ?? text) : text);
}

function location(f: Finding): string {
  // Unlike prose, spaces within a path are meaningful.
  const path = plainText(f.path).replace(/\n/g, " ");
  if (!path || !Number.isInteger(f.start_line) || f.start_line < 1) return path;
  const range = Number.isInteger(f.end_line) && f.end_line > f.start_line ? `–${f.end_line}` : "";
  return `${path}:${f.start_line}${range}`;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function excerpt(text: string, width: number): string {
  // Clip before theming; an SGR reset in the row would clear the selection background.
  return visibleWidth(text) <= width ? text : sliceByColumn(text, 0, width - 1, true) + "…";
}

function summaryLeft(title: string, severity: Severity | undefined, width: number, selected: boolean, expanded: boolean, theme: SeverityTheme): string {
  // The system theme may leave selectedBg transparent. Keep a non-color cursor in that case too.
  const chevron = selected ? (expanded ? "▾" : "▸") : (expanded ? "▿" : "▹");
  let left = theme.fg(selected ? "accent" : "muted", chevron), room = width - 1;
  if (severity && room > 1) {
    const label = excerpt(severity.label, room - 1);
    const column = Math.min(room - 1, Math.max(visibleWidth(label), room >= 26 ? 7 : 0));
    left += " " + pad(paintSeverity(severity, label, theme), column);
    room -= 1 + column;
  }
  if (room > 1) left += " " + excerpt(title, room - 1);
  return left;
}

/** Hard-wrap without dropping spaces, blank lines or indentation. */
function wrapLine(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) return [line];
  const rows: string[] = [];
  if (/^[ -~]+$/.test(line)) {
    for (let i = 0; i < line.length; i += width) rows.push(line.slice(i, i + width));
    return rows;
  }
  let row = "", used = 0;
  for (const { segment } of graphemes.segment(line)) {
    const cells = visibleWidth(segment);
    // A wide grapheme cannot be displayed in a one-column view.
    const fits = cells <= width, size = fits ? cells : 1;
    if (used + size > width) { rows.push(row); row = ""; used = 0; }
    row += fits ? segment : "…";
    used += size;
  }
  rows.push(row);
  return rows;
}

function* wrapLines(text: string, width: number): Generator<string> {
  for (const line of text.split("\n")) yield* wrapLine(line, width);
}

// Prefer word boundaries in sanitized prose, without dropping original spaces. Keep code on hard wraps.
export function* commentLines(text: string, width: number): Generator<string> {
  for (const line of text.split("\n")) {
    if (visibleWidth(line) <= width) { yield line; continue; }
    let row = "", used = 0;
    for (const [word] of line.matchAll(/[^ ]+ *| +/g)) {
      const size = visibleWidth(word);
      if (row && used + size > width) { yield row; row = ""; used = 0; }
      if (size > width) {
        const parts = wrapLine(word, width);
        for (let i = 0; i < parts.length - 1; i++) yield parts[i];
        row = parts[parts.length - 1]; used = visibleWidth(row);
      } else { row += word; used += size; }
    }
    yield row;
  }
}

function* codeRows(before: string, after: string, width: number, theme: Foreground): Generator<string> {
  const gap = visibleWidth(divider), leftWidth = Math.floor((width - gap) / 2);
  if (!before || !after || leftWidth < minCodeColumns) {
    for (const [label, code, color] of [[existingLabel, before, "toolDiffRemoved"], [suggestedLabel, after, "toolDiffAdded"]] as const) {
      if (!code) continue;
      for (const part of wrapLine(label, width)) yield theme.fg("muted", part);
      for (const part of wrapLines(code, width)) yield theme.fg(color, part);
    }
    return;
  }

  const rightWidth = width - gap - leftWidth, border = theme.fg("borderMuted", divider);
  const pair = (left: string, right: string) => pad(left, leftWidth) + border + right;
  yield pair(theme.fg("muted", existingLabel), theme.fg("muted", suggestedLabel));
  const left = before.split("\n"), right = after.split("\n");
  // Align the starts of native lines even if one side takes extra rows to wrap.
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = wrapLine(left[i] ?? "", leftWidth), b = wrapLine(right[i] ?? "", rightWidth);
    for (let j = 0; j < Math.max(a.length, b.length); j++) {
      yield pair(theme.fg("toolDiffRemoved", a[j] ?? ""), theme.fg("toolDiffAdded", b[j] ?? ""));
    }
  }
}

function* detailRows(f: Finding, content: string, path: string, width: number, theme: Foreground): Generator<string> {
  const indent = " ".repeat(Math.min(4, Math.max(0, width - suggestedLabel.length)));
  const room = width - indent.length;
  if (path) for (const part of wrapLines(path, room)) yield indent + theme.fg("muted", part);
  const category = oneLine(f.category ?? "");
  if (category) for (const part of commentLines(`Category  ${category}`, room)) yield indent + theme.fg("dim", part);
  if (content) for (const part of commentLines(content, room)) yield indent + part;
  const before = plainText(f.existing_code ?? ""), after = plainText(f.suggestion_code ?? "");
  if (before || after) {
    yield "";
    for (const row of codeRows(before, after, room, theme)) yield indent + row;
  }
}

/** Render one finding within the Fleet's content area (border excluded). */
export function findingRows(f: Finding, width: number, selected: boolean, expanded: boolean, theme: SeverityTheme & Pick<Theme, "bg">): string[] {
  width = Math.floor(width);
  if (!Number.isFinite(width) || width < 1) return [];
  const content = plainText(f.content);
  // OCR supplies one comment, not a separate title, impact, or evidence.
  const first = oneLine(content.trimStart().split("\n", 1)[0]);
  const title = first.match(/^.*?(?:[.!?](?=\s|$)|[。！？])/u)?.[0] || first || "Finding";
  const path = location(f), label = oneLine(f.severity ?? "");
  // Keep unlabeled Fleet rows in their original layout; the receipt shows an explicit Unrated bucket.
  const severity = label ? findingSeverity(label) : undefined;
  const pathWidth = visibleWidth(path), leftRoom = width - pathWidth - 2;
  const prefix = 2 + (severity ? visibleWidth(severity.label) + 3 : 0);
  // Move the location to a continuation before it crowds out the title.
  const inline = path.length > 0 && leftRoom >= prefix + Math.min(10, visibleWidth(title));
  const clippedPath = pathWidth > width;
  const left = summaryLeft(title, severity, inline ? leftRoom : width, selected, expanded, theme);
  let rows = [inline ? pad(left, leftRoom) + "  " + theme.fg("muted", path) : left];
  if (path && !inline) {
    const tail = clippedPath ? "…" + sliceByColumn(path, pathWidth - width + 1, width - 1, true) : path;
    rows.push(" ".repeat(width - visibleWidth(tail)) + theme.fg("muted", tail));
  }
  if (selected) rows = rows.map(row => theme.bg("selectedBg", pad(row, width)));
  if (expanded) for (const row of detailRows(f, content, clippedPath ? path : "", width, theme)) rows.push(row);
  return rows;
}

/** Use the native details without Fleet's selection or per-finding toggle. */
export function* numberedFindingRows(f: Finding, number: number, width: number, theme: SeverityTheme): Generator<string> {
  const severity = findingSeverity(f.severity), ordinal = `${number}.`, path = location(f);
  const heading = `${ordinal} ${severity.label}`, dot = " · ";
  const inline = Boolean(path) && visibleWidth(heading + dot + path) <= width;
  if (visibleWidth(heading) <= width) {
    const row = theme.fg("text", ordinal) + " " + paintSeverity(severity, severity.label, theme);
    yield inline ? row + theme.fg("dim", dot) + theme.fg("muted", path) : row;
  } else {
    for (const part of wrapLine(ordinal, width)) yield theme.fg("text", part);
    for (const part of wrapLine(severity.label, width)) yield paintSeverity(severity, part, theme);
  }
  yield* detailRows(f, plainText(f.content), inline ? "" : path, width, theme);
}
