import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Finding, ReviewReport } from "../src/ocr.ts";
import { receiptRows } from "../src/review-receipt-rows.ts";

type Palette = Parameters<typeof receiptRows>[3];
const plain: Palette = { fg: (_, s) => s, bg: () => assert.fail("Receipts do not use a background"), bold: s => s };
const tagged: Palette = { ...plain, fg: (token, s) => "[" + token + ":" + s + "]", bold: s => "[bold:" + s + "]" };
const finding: Finding = { path: "src/item.ts", content: "Native finding.", start_line: 3, end_line: 5 };
function review(...severities: Finding["severity"][]): ReviewReport {
  return { status: "complete", comments: severities.map(severity => ({ ...finding, severity })) };
}

test("a collapsed receipt is a single line with counted severities in rank order and themed by token", () => {
  const report = review("medium", "HIGH", "LoW", "hIgH", "mEDium", "CRITICAL");
  assert.deepEqual(receiptRows(report, false, 80, plain), ["▸ OCR · 6 findings · 1 Critical · 2 High · 2 Medium · 1 Low"]);
  const segments = [
    "[accent:▸ OCR]", "[text:6 findings]", "[error:[bold:1 Critical]]",
    "[error:2 High]", "[warning:2 Medium]", "[muted:1 Low]",
  ];
  assert.deepEqual(receiptRows(report, false, 200, tagged), [segments.join("[dim: · ]")]);
});

test("absent severity is Unrated, and unknown labels retain their own text and counts", () => {
  const report = review(undefined, "Notice", "notice", "Notice", "  \x1b[2J\t ", "Unusual");
  const rows = receiptRows(report, true, 200, tagged);
  assert.equal(rows[0], [
    "[accent:▾ OCR]", "[text:6 findings]", "[muted:2 Notice]", "[muted:1 notice]", "[muted:1 Unusual]", "[dim:2 Unrated]",
  ].join("[dim: · ]"));
  assert.deepEqual(receiptRows(review("unrated", undefined), false, 80, plain), ["▸ OCR · 2 findings · 2 Unrated"]);
  const headings = rows.filter(row => row.startsWith("[text:")).map(row => row.split("[dim: · ]")[0]);
  assert.deepEqual(headings, [
    "[text:1.] [dim:Unrated]", "[text:2.] [muted:Notice]", "[text:3.] [muted:notice]",
    "[text:4.] [muted:Notice]", "[text:5.] [dim:Unrated]", "[text:6.] [muted:Unusual]",
  ]);
});

test("only clean empty results say No findings; non-success keeps the outcome and expands its message", () => {
  for (const status of ["complete", "success"]) {
    const report = { status, comments: [] };
    assert.deepEqual(receiptRows(report, false, 60, plain), ["✓ OCR · No findings"]);
    assert.deepEqual(receiptRows(report, true, 60, plain), ["✓ OCR · No findings"]);
  }
  for (const [status, label] of [
    ["partial", "Partial review"], ["completed_with_errors", "Partial review"],
    ["completed_with_warnings", "Completed with warnings"], ["failed", "Failed"], ["skipped", "Skipped"],
  ]) {
    const report = { status, comments: [], message: "\x1b[2JFirst note.\r\nMore details.\x00" };
    assert.deepEqual(receiptRows(report, false, 60, plain), ["▸ OCR · " + label]);
    assert.deepEqual(receiptRows(report, false, visibleWidth(label), plain), [label]);
    assert.deepEqual(receiptRows(report, true, 60, plain), ["▾ OCR · " + label, "", "First note.", "More details."]);
  }
  const partial = { ...review("high"), status: "partial" };
  assert.deepEqual(receiptRows(partial, false, 60, plain), ["▸ OCR · Partial review · 1 finding · 1 High"]);
});

test("narrow rows lose the entire breakdown before clipping the total and never overflow with Unicode", () => {
  const unicode = {
    ...finding, severity: "\x1b[2J未分類 👩‍💻\u202e", path: "\x1b[?25l目录/👩‍💻.ts",
    category: "\x1b[31m正確性\x1b[0m", content: "\x1b]8;;https://example.invalid\x07👨‍👩‍👦 e\u0301 の計算。\x1b]8;;\x07\r\n证据\u202e",
    existing_code: "\t原文 = 👩‍💻;\x9b2J", suggestion_code: "    修正 = 🧑‍💻;",
  };
  const report = { status: "complete", comments: [unicode], message: "\x1b[31m说明 👩‍💻\x1b[0m" };
  const base = "▸ OCR · 1 finding", full = base + " · 1 未分類 👩‍💻";
  assert.deepEqual(receiptRows(report, false, visibleWidth(full), plain), [full]);
  assert.deepEqual(receiptRows(report, false, visibleWidth(full) - 1, plain), [base]);
  assert.deepEqual(receiptRows(report, false, visibleWidth(base), plain), [base]);
  assert.deepEqual(receiptRows(report, false, visibleWidth(base) - 1, plain), ["▸ 1 finding"]);
  assert.deepEqual(receiptRows(report, false, 9, plain), ["1 finding"]);

  const expanded = receiptRows(report, true, 90, plain).join("\n");
  for (const text of ["说明 👩‍💻", "未分類 👩‍💻", "目录/👩‍💻.ts:3–5", "正確性", "👨‍👩‍👦 e\u0301 の計算。", "证据", "    原文 = 👩‍💻;", "    修正 = 🧑‍💻;"]) {
    assert.ok(expanded.includes(text), "Missing " + text);
  }
  for (const width of [1, 2, 3, 5, 8, 14, 17, 22, 30, 60, 90]) for (const open of [false, true]) {
    const rows = receiptRows(report, open, width, plain);
    assert.ok(rows.every(row => visibleWidth(row) <= width), "Rows must fit " + width + " columns");
    for (const row of rows) {
      assert.doesNotMatch(row, /\x1b\[(2J|\?25l|31m)|\x1b\]8|example\.invalid|2J/u);
      assert.doesNotMatch(stripVTControlCharacters(row), /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u);
    }
  }
  for (const width of [0, -1, NaN, Infinity]) assert.deepEqual(receiptRows(report, true, width, plain), []);
});

test("expanded receipt follows OCR order, with numbered native comments and comparisons", () => {
  const report: ReviewReport = {
    status: "complete",
    comments: [
      {
        ...finding, severity: "medium", path: "src/z.ts", start_line: 11, end_line: 13, category: "Logic",
        content: "Incorrect total.\n\nAll the native evidence.",
        existing_code: "  const total = price + count;\n\n  return total;  ",
        suggestion_code: "  const total = price * count;\n  return total;",
      },
      { ...finding, severity: "cRiTiCaL", path: "src/a.ts", start_line: 2, end_line: 2, content: "The second comment." },
    ],
  };
  const rows = receiptRows(report, true, 48, plain);
  assert.deepEqual(rows.filter(row => /^\d+\. /u.test(row)), ["1. Medium · src/z.ts:11–13", "2. Critical · src/a.ts:2"]);
  assert.deepEqual(rows.slice(3, -3), [
    "    Category  Logic", "    Incorrect total.", "    ", "    All the native evidence.", "",
    "    Existing code", "      const total = price + count;", "    ", "      return total;  ",
    "    Suggested change", "      const total = price * count;", "      return total;",
  ]);
  assert.equal(rows.at(-1), "    The second comment.");
  assert.doesNotMatch(rows.slice(1).join("\n"), /[▸▾▹▿]/u);
  assert.ok(receiptRows(report, true, 160, tagged).some(row => row.startsWith("[text:2.] [error:[bold:Critical]]")));
});
