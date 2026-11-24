import test from "node:test";
import assert from "node:assert/strict";
import { getKeybindings, type Terminal, TuiAltScreen, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { type Finding } from "../src/ocr.ts";
import { fleetOverlayOptions, reviewFleet } from "../src/review-fleet.ts";
import { ReviewTask } from "../src/review-task.ts";

function viewport(mode: "regular" | "fullscreen", rows = 35) {
  const writes: string[] = [];
  return { mode, terminal: { rows, write: (s: string) => { writes.push(s); } }, writes, requestRender() {} };
}
const screen = viewport("regular");
const theme: Parameters<typeof reviewFleet>[2] = { fg: (_, s) => s, bg: (_, s) => s, bold: s => s };
function open(task?: ReviewTask, onClose = () => {}, tui = screen) {
  return reviewFleet(task, tui, theme, { matches: (key, binding) => binding === `tui.select.${key}` }, onClose);
}
const f: Finding = { path: "a.ts", content: "Incorrect total. More evidence from the report.", severity: "high", start_line: 3, end_line: 4, suggestion_code: "return price * count;" };

test("all findings start collapsed on every open; only Enter toggles the selected row", async () => {
  const task = new ReviewTask("test/reviewer", new AbortController());
  await task.run(async () => ({ status: "complete", comments: [f, { ...f, path: "b.ts", content: "Second finding.", suggestion_code: "second fix" }] }));
  let closed = false;
  const panel = open(task, () => { closed = true; });
  const text = () => panel.render(85).join("\n");
  assert.match(text(), /▸.*high.*Incorrect total\..*a\.ts:3–4/iu);
  assert.match(text(), /▹.*high.*Second finding\..*b\.ts:3–4/iu);
  assert.doesNotMatch(text(), /Suggested change|More evidence/);
  panel.handleInput("down");
  assert.match(text(), /▸.*Second finding/);
  panel.handleInput("confirm");
  assert.match(text(), /second fix/);
  assert.doesNotMatch(text(), /More evidence/);
  panel.handleInput("cancel"); panel.dispose();
  assert.equal(closed, true);
  const next = open(task);
  assert.doesNotMatch(next.render(85).join("\n"), /second fix|Suggested change|▾/);
  next.dispose();
});

test("empty, clean and unverified results are distinct; Esc does not stop a running review", async () => {
  assert.match(open().render(80).join("\n"), /No review in this session/);
  const job = new ReviewTask("fixture/author", new AbortController());
  const panel = open(job);
  assert.match(panel.render(80).join("\n"), /No findings yet/);
  panel.handleInput("cancel"); assert.equal(job.phase, "running");
  await job.run(async progress => {
    progress({ activity: "Verifying findings", candidates: [f] });
    assert.match(panel.render(80).join("\n"), /Pending verification/);
    return { status: "complete", comments: [] };
  });
  assert.match(panel.render(80).join("\n"), /Final report[\s\S]+No findings\./);
  assert.doesNotMatch(panel.render(80).join("\n"), /0 findings|Incorrect total|x Stop/);
  panel.dispose();
});

test("the centered title precedes the activity and model, explicit scope, native coverage and findings", async () => {
  const job = new ReviewTask("fixture/model-for-this-review", new AbortController(), { from: "main", to: "topic/结算" });
  const panel = open(job);
  const title = "open-code-review fleet";
  for (const width of [80, 81]) {
    const header = panel.render(width).find(s => s.includes(title))!;
    const left = header.indexOf(title), right = width - left - title.length;
    assert.ok(Math.abs(left - right) <= 1);
  }
  assert.doesNotMatch(panel.render(72).join("\n"), /Coverage|Workspace|±|\bOCR\b|0 pending/);
  const partial = { status: "partial", coverage: { selected: ["a.ts", "b.ts"], completed: ["a.ts"] }, message: "b.ts timed out.", comments: [f] };
  await job.run(async update => {
    update({ activity: "Reading a.ts", candidates: [{ ...f, start_line: 0, end_line: 0 }] });
    const pending = panel.render(80).join("\n");
    assert.match(pending, /Reading a\.ts · model-for-this-review/);
    assert.match(pending, /Pending verification/);
    assert.doesNotMatch(pending, /a\.ts:\d|Coverage|files reviewed/);
    return partial;
  });
  const lines = panel.render(80);
  const positions = [title, "△ Partial review · model-for-this-review", "Range  main → topic/结算", "Findings · 1", "a.ts:3–4"]
    .map(s => lines.findIndex(line => line.includes(s)));
  assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])));
  assert.match(lines.join("\n"), /Coverage  1\/2 files reviewed/);
  assert.match(lines.join("\n"), /Incomplete report[\s\S]+b\.ts timed out/);
  assert.doesNotMatch(lines.join("\n"), /Final report|x Stop|±/);
  panel.dispose();
});

test("large/wide findings fit the viewport, sanitize controls, and can be read past the first page", async () => {
  const job = new ReviewTask("fixture/author", new AbortController());
  await job.run(async () => ({ status: "complete", comments: [{ ...f, path: "例/".repeat(20) + "a.ts", content: "标题\n" + "行🌾\n".repeat(70) + "\x1b[2JEND", suggestion_code: undefined }] }));
  const panel = open(job); panel.handleInput("confirm");
  for (const width of [5, 12, 28, 67]) {
    const lines = panel.render(width);
    assert.equal(lines.length, Math.floor(screen.terminal.rows * 0.7));
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.doesNotMatch(lines.join("\n"), /\x1b\[2J/); // The layout library can emit SGR resets.
  }
  for (let i = 0; i < 20; i++) panel.handleInput("pageDown");
  const end = panel.render(67).join("\n");
  assert.match(end, /END/);
  assert.doesNotMatch(end, /\x1b\[2J/);
  panel.dispose();
});

async function longReport() {
  const job = new ReviewTask("fixture/reviewer", new AbortController());
  await job.run(async () => ({ status: "complete", comments: [{ ...f, content: Array.from({ length: 90 }, (_, i) => `Evidence ${i}.`).join("\n") }] }));
  return job;
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode}: header and footer stay put across expansion and resize, without a divider below the report`, async () => {
    const tui = viewport(mode, 36), panel = open(await longReport(), undefined, tui);
    for (const rows of [36, 17, 6, 4, 2, 1, 40]) {
      tui.terminal.rows = rows;
      const height = mode === "fullscreen" ? rows : Math.max(1, Math.floor(rows * 0.7));
      for (const width of [80, 5, 2]) {
        const before = panel.render(width);
        panel.handleInput("confirm");
        const after = panel.render(width);
        assert.equal(before.length, height); assert.equal(after.length, height);
        assert.equal(before[0], after[0]);
        assert.ok(after.every(s => visibleWidth(s) === width));
        assert.ok(!after.some(s => s.startsWith("├")));
        if (width === 80) {
          const footer = after.findIndex(s => s.includes("Esc Close"));
          assert.equal(footer, height - (mode === "regular" && height >= 6 ? 2 : 1));
          assert.equal(before.findIndex(s => s.includes("Esc Close")), footer);
          if (height >= 10) assert.doesNotMatch(after[footer - 1], /─{3,}/);
        }
        panel.handleInput("confirm");
      }
    }
    panel.dispose();
  });
}

test("fullscreen consumes pointer input even at the scroll limits; only the report moves", async () => {
  const tui = viewport("fullscreen", 15), panel = open(await longReport(), undefined, tui);
  const mouse = (type: TuiMouseEvent["type"], wheelDelta = 0) => panel.handleMouse({ type, wheelDelta, button: "none", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 15, shift: false, alt: false, ctrl: false });
  panel.focused = true;
  const collapsed = panel.render(80);
  assert.equal(mouse("wheel", 1).handled, true);
  assert.deepEqual(panel.render(80), collapsed);
  panel.handleInput("confirm");
  const start = panel.render(80);
  assert.equal(mouse("wheel", 300).handled, true);
  const end = panel.render(80);
  assert.match(end.join("\n"), /Evidence 89\./); assert.equal(start[0], end[0]); assert.equal(start.at(-1), end.at(-1));
  assert.equal(mouse("wheel", 1).handled, true); assert.deepEqual(panel.render(80), end);
  assert.equal(mouse("wheel", -300).handled, true); assert.deepEqual(panel.render(80), start);
  for (const type of ["press", "click", "drag", "release", "move"] as const) assert.equal(mouse(type).handled, true);
  panel.dispose(); assert.deepEqual(tui.writes, []); // Pi owns fullscreen mouse modes.
});

test("pi's fullscreen dispatcher keeps a scrolled transcript at its exact offset until Fleet closes", () => {
  let input!: (data: string) => void;
  const noop = () => {};
  const terminal: Terminal = {
    columns: 80, rows: 17, kittyProtocolActive: false, start(onInput) { input = onInput; },
    stop: noop, async drainInput() {}, write: noop, moveBy: noop, hideCursor: noop, showCursor: noop, clearLine: noop,
    clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop, setProgramStatus: noop,
  };
  const tui = new TuiAltScreen(terminal);
  tui.addChild({ render: () => Array.from({ length: 120 }, (_, i) => `chat ${i}`), invalidate: noop });
  tui.start();
  try {
    tui.renderNow(); tui.scrollBy(-20); tui.renderNow();
    const offset = tui.viewportTop;
    assert.ok(offset > 0 && !tui.isFollowingOutput);
    const panel = reviewFleet(undefined, tui, theme, getKeybindings(), () => { tui.hideOverlay(); panel.dispose(); });
    const handle = tui.showOverlay(panel, fleetOverlayOptions(tui.mode));
    tui.renderNow();
    assert.deepEqual(handle.getBounds(), { row: 0, col: 0, width: 80, height: 17 });
    for (const data of ["\x1b[<64;1;1M", "\x1b[<65;80;17M", "\x1b[5~", "\x1b[6~"]) {
      input(data); tui.renderNow(); assert.equal(tui.viewportTop, offset);
    }
    input("\x1b"); tui.renderNow(); assert.ok(!tui.hasOverlay()); assert.equal(tui.viewportTop, offset);
    input("\x1b[<64;1;1M"); assert.ok(tui.viewportTop < offset);
  } finally { tui.stop(); }
});

test("regular captures the terminal wheel only while focused and releases it on blur or disposal", async () => {
  const tui = viewport("regular", 18), panel = open(await longReport(), undefined, tui);
  assert.deepEqual(tui.writes, []);
  panel.focused = true; panel.focused = true;
  const enabled = tui.writes.join(""); assert.match(enabled, /\x1b\[\?1000h/); assert.match(enabled, /\x1b\[\?1006h/);
  panel.handleInput("confirm"); const first = panel.render(80);
  panel.handleInput("\x1b[<65;1;1M"); assert.notDeepEqual(panel.render(80), first);
  panel.handleInput("\x1b[<64;80;18M"); assert.deepEqual(panel.render(80), first);
  // Some terminals send the legacy six-byte packet rather than SGR.
  panel.handleInput("\x1b[M" + String.fromCharCode(65 + 32, 33, 33)); assert.notDeepEqual(panel.render(80), first);
  panel.handleInput("\x1b[M" + String.fromCharCode(64 + 32, 33, 33)); assert.deepEqual(panel.render(80), first);
  panel.focused = false;
  const released = tui.writes.join("").slice(enabled.length); assert.match(released, /\x1b\[\?1000l/); assert.match(released, /\x1b\[\?1006l/);
  panel.focused = true; panel.dispose(); panel.dispose();
  assert.equal(tui.writes.join(""), (enabled + released).repeat(2));
});
