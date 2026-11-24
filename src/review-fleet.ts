import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type OverlayOptions, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Finding } from "./ocr.ts";
import { findingRows } from "./review-finding.ts";
import type { ReviewTask } from "./review-task.ts";
import { oneLine, plainText, statusLine } from "./review-widget.ts";

const regularHeightPct = 70;
const title = "open-code-review fleet";
type FleetTheme = Pick<Theme, "fg" | "bg" | "bold">;
type Screen = Pick<TUI, "mode" | "requestRender"> & { terminal: Pick<TUI["terminal"], "rows" | "write"> };

export function fleetOverlayOptions(mode: TUI["mode"]): OverlayOptions {
  // Fullscreen mouse dispatch hit-tests the rendered rectangle, not keyboard focus.
  return mode === "fullscreen" ? { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 }
    : { anchor: "center", width: "90%", maxHeight: `${regularHeightPct}%` };
}

/** Regular pi delivers raw terminal input instead of normalized mouse events. */
function regularWheelDelta(data: string): number {
  const sgr = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
  const button = sgr ? Number(sgr[1]) : data.length === 6 && data.startsWith("\x1b[M") ? data.charCodeAt(3) - 32 : 0;
  switch (button & ~28) { // Ignore Shift, Alt and Ctrl, not horizontal wheel or other buttons.
    case 64: return -1;
    case 65: return 1;
    default: return 0;
  }
}

function reportNote(task?: ReviewTask): { badge?: string; message?: string } {
  if (!task) return { message: "No review in this session." };
  const hasFindings = task.findings.length > 0;
  switch (task.phase) {
    case "completed": return { badge: "Final report", message: hasFindings ? undefined : "No findings." };
    case "running": return hasFindings ? { badge: "Pending verification" } : { message: "No findings yet." };
    case "stopping": return hasFindings ? { badge: "Unverified" } : { message: "Waiting for OCR to stop." };
    case "skipped": return { badge: "Skipped", message: task.report?.message || "No files selected for review." };
    default:
      if (task.report) return { badge: "Incomplete report", message: task.error || task.report.message };
      return { badge: hasFindings ? "Unverified" : undefined, message: [task.error, "No final report."].filter(Boolean).join("\n") };
  }
}

function metadata(task: ReviewTask | undefined, width: number, theme: FleetTheme): string[] {
  const groups = [], scope = task?.scope, files = task?.report?.coverage;
  const field = (name: string, value: string) => theme.fg("dim", name) + "  " + value;
  if (scope) groups.push("commit" in scope ? field("Commit", oneLine(scope.commit)) : field("Range", `${oneLine(scope.from)} → ${oneLine(scope.to)}`));
  if (files?.selected && files.completed) {
    const total = files.selected.length;
    groups.push(field("Coverage", `${files.completed.length}/${total} ${total === 1 ? "file" : "files"} reviewed`));
  }
  if (!groups.length) return [];
  const line = groups.join("    ");
  return visibleWidth(line) <= width ? [line] : groups.flatMap(s => wrapTextWithAnsi(s, width));
}

function spaced(left: string, right: string, width: number): string | undefined {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 2 ? left + " ".repeat(gap) + right : undefined;
}

function controls(width: number, findings: boolean, scroll: boolean, stop: boolean, theme: FleetTheme) {
  const left = [findings && "↑↓ Select   Enter Toggle", scroll && "PgUp/PgDn Scroll"].filter(Boolean).join("   ");
  const right = stop ? "x Stop   Esc Close" : "Esc Close";
  const compact = [findings && "↑↓  Enter", scroll && "PgUp/Dn"].filter(Boolean).join("  ");
  return theme.fg("muted", spaced(left, right, width) ?? spaced(compact, right, width) ?? (width >= right.length ? right : stop ? "x  Esc" : "Esc"));
}

/** Expansion, selection and scrolling belong to this opening of Fleet, not to the review. */
export function reviewFleet(task: ReviewTask | undefined, tui: Screen, theme: FleetTheme, keys: Pick<KeybindingsManager, "matches">, done: () => void) {
  const expanded = new WeakSet<Finding>(), empty: readonly Finding[] = [];
  let cache: { width: number; items: readonly Finding[]; phase?: string; selected: number; rows: string[]; focus: number } | undefined;
  const fullscreen = tui.mode === "fullscreen";
  let selected = 0, top = 0, page = 0, maxTop = 0, reveal = false;
  const unsubscribe = task?.subscribe(() => tui.requestRender());

  function scrollBy(delta: number) {
    reveal = false;
    const next = Math.max(0, Math.min(maxTop, top + delta));
    if (next === top) return false;
    top = next;
    return true;
  }

  // Regular pi leaves mouse tracking off, so otherwise the terminal scrolls its own history.
  // Borrow it only while Fleet has focus. Fullscreen pi manages its own terminal modes.
  let focused = false, disposed = false;
  const releaseMouse = () => tui.terminal.write("\x1b[?1000l\x1b[?1006l");
  function setFocus(value: boolean) {
    if (disposed || value === focused) return;
    focused = value;
    if (fullscreen) return;
    if (value) {
      process.once("exit", releaseMouse);
      tui.terminal.write("\x1b[?1006h\x1b[?1000h");
    } else {
      process.off("exit", releaseMouse);
      releaseMouse();
    }
  }

  // Rebuild on new findings, terminal state, resize or interaction, not on spinner frames.
  function body(width: number, items: readonly Finding[]) {
    if (cache && cache.width === width && cache.items === items && cache.phase === task?.phase && cache.selected === selected) return cache;
    const rows = metadata(task, width, theme);
    rows.push(theme.fg("borderMuted", "─".repeat(width)));
    const { badge, message } = reportNote(task);
    const heading = theme.bold("Findings") + (items.length ? theme.fg("muted", ` · ${items.length}`) : "");
    const tag = badge && theme.fg("muted", badge);
    if (tag) {
      const both = spaced(heading, tag, width);
      if (both) rows.push(both); else rows.push(heading, tag);
    } else rows.push(heading);
    if (message) for (const s of wrapTextWithAnsi(plainText(message), width)) rows.push(theme.fg("muted", s));
    let focus = 0;
    for (const [i, finding] of items.entries()) {
      if (i === selected) focus = rows.length;
      for (const row of findingRows(finding, width, i === selected, expanded.has(finding), theme)) rows.push(row);
    }
    return cache = { width, items, phase: task?.phase, selected, rows, focus };
  }

  return {
    get focused() { return focused; }, set focused(value: boolean) { setFocus(value); },
    invalidate() { cache = undefined; },
    dispose() { setFocus(false); disposed = true; unsubscribe?.(); },
    handleMouse(event: TuiMouseEvent) {
      // Even a wheel at the end of the report must not fall through to pi's transcript.
      return { handled: true, render: !disposed && event.type === "wheel" && scrollBy(event.wheelDelta ?? 0) };
    },
    handleInput(data: string) {
      if (!fullscreen && focused) {
        const delta = regularWheelDelta(data);
        if (delta) { if (scrollBy(delta)) tui.requestRender(); return; }
      }
      const items = task?.findings ?? empty;
      if (keys.matches(data, "tui.select.cancel")) { done(); return; }
      if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
        selected = Math.min(Math.max(0, items.length - 1), Math.max(0, selected + (keys.matches(data, "tui.select.up") ? -1 : 1)));
        reveal = true;
      } else if (keys.matches(data, "tui.select.confirm")) {
        const f = items[selected];
        if (!f) return;
        if (expanded.has(f)) expanded.delete(f); else expanded.add(f);
        cache = undefined;
        reveal = true;
      } else if (keys.matches(data, "tui.select.pageUp")) scrollBy(-page);
      else if (keys.matches(data, "tui.select.pageDown")) scrollBy(page);
      else if (matchesKey(data, "x") && task?.phase === "running") task.stop();
      else return;
      tui.requestRender();
    },
    render(width: number): string[] {
      if (width < 1) return [];
      const height = Math.max(1, fullscreen ? tui.terminal.rows : Math.floor(tui.terminal.rows * regularHeightPct / 100));
      const framed = !fullscreen && width >= 5 && height >= 6;
      const inset = framed ? 2 : width >= 3 ? 1 : 0, inner = width - 2 * inset;
      const border = (s: string) => theme.fg("border", s);
      const left = framed ? border("│ ") : " ".repeat(inset), right = framed ? border(" │") : left;
      const line = (s: string) => left + truncateToWidth(s, inner, "…", true) + right;
      const rule = (left: string, right: string) => border(left + "─".repeat(width - 2) + right);
      const caption = truncateToWidth(title, inner, "…");
      const header = framed ? [rule("╭", "╮")] : [];
      if (height >= 2) header.push(line(" ".repeat(Math.floor((inner - visibleWidth(caption)) / 2)) + theme.bold(caption)));
      if (task && height >= 4) header.push(line(statusLine(task, inner, theme, "fleet")));
      page = height - header.length - 1 - Number(framed); // controls, then optional bottom border
      const items = task?.findings ?? empty;
      selected = Math.min(selected, Math.max(0, items.length - 1));
      const { rows, focus } = body(inner, items);
      if (reveal && (focus < top || focus >= top + page - 1)) top = focus;
      reveal = false;
      maxTop = page > 0 ? Math.max(0, rows.length - page) : 0;
      top = Math.max(0, Math.min(top, maxTop));
      const visible = rows.slice(top, top + page).map(line);
      const blank = line("");
      while (visible.length < page) visible.push(blank);
      const footer = line(controls(inner, !!items.length, maxTop > 0, task?.phase === "running", theme));
      return [...header, ...visible, footer, ...(framed ? [rule("╰", "╯")] : [])];
    },
  };
}
