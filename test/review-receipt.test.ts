import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ReviewReport } from "../src/ocr.ts";
import { createReceiptRenderer } from "../src/review-receipt.ts";

const palette: Pick<Theme, "fg" | "bg" | "bold"> = { fg: (_, s) => s, bg: (_, s) => s, bold: s => s };
const options = { expanded: false, outputPad: 1, keyText: () => "", keyHint: () => "" };
const report: ReviewReport = { status: "complete", comments: [
  { path: "amount.ts", start_line: 2, end_line: 2, severity: "high", content: "Incorrect subtotal. Multiply the values." },
] };
const message = (details = report) => ({ role: "custom" as const, customType: "open-code-review", display: true,
  // A spilled model payload is not a UI backing store. No path should be accessed or displayed by the renderer.
  content: "Full report (read during this session): /not-a-file", details, timestamp: 1 });
const pointer = (type: TuiMouseEvent["type"], y = 0): TuiMouseEvent => ({
  type, button: "left", x: 2, y, screenX: 2, screenY: y, width: 80, height: 4, shift: false, alt: false, ctrl: false,
});

test("a receipt initially folds even if other output is expanded; a click applies to this header only", () => {
  let global = true;
  const renderer = createReceiptRenderer(() => global), a = message(), b = message();
  const make = (m = a) => renderer(m, { ...options, expanded: global }, palette as Theme)!;
  const one = make(), two = make(b);
  assert.equal(one.render(80).length, 1); assert.equal(two.render(80).length, 1);
  assert.match(one.render(80)[0], /1 finding.*1 High/);
  for (const e of [pointer("wheel"), pointer("press", 1), { ...pointer("press"), shift: true }]) {
    assert.equal(one.handleMouse?.(e), undefined);
  }
  assert.deepEqual(one.handleMouse?.(pointer("press")), { handled: true, render: false });
  assert.deepEqual(one.handleMouse?.(pointer("click")), { handled: true, render: true });
  assert.match(one.render(80).join("\n"), /amount\.ts:2/);
  assert.doesNotMatch(one.render(80).join("\n"), /not-a-file/);
  assert.equal(two.render(80).length, 1);
  // Recreating a child (as pi does on theme changes) preserves an individual mouse fold.
  assert.match(make().render(80).join("\n"), /Multiply the values/);
  global = false; assert.equal(make().render(80).length, 1);
  global = true; assert.match(make().render(80).join("\n"), /amount\.ts:2/);
  make().handleMouse?.(pointer("click")); assert.equal(make().render(80).length, 1);
});

test("a clean receipt with nothing to expand does not take pointer input or editor focus", () => {
  const renderer = createReceiptRenderer(() => false);
  const component = renderer(message({ status: "complete", comments: [] }), options, palette as Theme)!;
  assert.match(component.render(50)[0], /No findings/);
  assert.equal(component.handleMouse?.(pointer("press")), undefined);
  assert.equal(component.handleMouse?.(pointer("click")), undefined);
});
