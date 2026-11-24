import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Finding } from "../src/ocr.ts";
import { findingRows } from "../src/review-finding.ts";

type Palette = Parameters<typeof findingRows>[4];
const plain: Palette = { fg: (_, s) => s, bg: (_, s) => s };
const colors: Partial<Record<Parameters<Palette["fg"]>[0], number>> = { error: 31, warning: 33, muted: 90 };
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const ansi: Palette = {
  fg: (token, text) => colors[token] ? `\x1b[${colors[token]}m${text}\x1b[39m` : text,
  bg: (token, text) => { assert.equal(token, "selectedBg"); return `\x1b[44m${text}\x1b[49m`; },
  bold,
};
const example: Finding = { path: "src/价格.ts", content: "小计错误。原始说明。", severity: "high", start_line: 3, end_line: 5 };

function fits(rows: string[], width: number): void {
  for (const row of rows) assert.ok(visibleWidth(row) <= width, `row exceeds ${width} columns: ${JSON.stringify(row)}`);
}

test("collapsed summary uses the native excerpt, readable severity color, and a right-aligned location", () => {
  for (const [severity, name, color] of [
    ["high", "High", "error"], ["cRiTiCaL", "Critical", "error"], ["medium", "Medium", "warning"],
    ["low", "Low", "muted"], ["note", "note", "muted"],
  ] as const) {
    const rows = findingRows({ ...example, severity, suggestion_code: "Do not show this yet." }, 64, false, false, ansi);
    assert.equal(rows.length, 1);
    assert.equal(visibleWidth(rows[0]), 64);
    assert.ok(rows[0].includes(ansi.fg(color, name === "Critical" ? bold(name) : name)));
    const text = stripVTControlCharacters(rows[0]);
    assert.ok(text.startsWith(`▹ ${name.padEnd(7)} 小计错误。`));
    assert.ok(text.endsWith("src/价格.ts:3–5"));
    assert.doesNotMatch(text, /原始说明|Suggested change|Do not show/);
  }
});

test("selected summary background fills every row, including a clipped location continuation", () => {
  const finding = { ...example, path: `src/${"目录/".repeat(9)}a  b.ts`, content: "A long native excerpt that needs truncation at this width." };
  const width = 22;
  const folded = findingRows(finding, width, true, false, ansi);
  assert.equal(folded.length, 2);
  assert.match(stripVTControlCharacters(folded[1]).trimStart(), /^….*a  b\.ts:3–5$/u);
  const opened = findingRows(finding, width, true, true, ansi);
  const critical = findingRows({ ...example, severity: "critical" }, 64, true, false, ansi);
  assert.ok(critical[0].includes(ansi.fg("error", bold("Critical"))));
  const highlighted = [...folded, ...opened.slice(0, 2), ...critical];
  assert.deepEqual(highlighted.map(visibleWidth), [width, width, width, width, 64]);
  for (const row of highlighted) {
    assert.match(row, /^\x1b\[44m.*\x1b\[49m$/u);
    assert.doesNotMatch(row.slice(5, -5), /\x1b\[(?:0|49)?m/u);
  }
  assert.match(stripVTControlCharacters(opened[0]), /^▾/u);
  assert.doesNotMatch(opened.slice(2).join("\n"), /\x1b\[44m/u);
  // The expanded location is lossless across its wraps, before the native comment.
  const body = opened.slice(2).map(row => stripVTControlCharacters(row).slice(4));
  const commentStart = body.findIndex(row => row.startsWith("A long"));
  assert.equal(body.slice(0, commentStart).join(""), `${finding.path}:3–5`);
  assert.equal(body.slice(commentStart).join(""), finding.content);
  fits(opened, width);
});

test("a location that only fits on a continuation stays exact; line numbers are never inferred", () => {
  const path = "src/较长的  文件.ts";
  const rows = findingRows({ ...example, path, start_line: 0, end_line: 999 }, 22, false, false, plain);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].trimStart(), path);
  assert.equal(visibleWidth(rows[1]), 22);
  const single = findingRows({ ...example, path, start_line: 7, end_line: 7 }, 68, false, false, plain);
  assert.ok(single[0].endsWith(`${path}:7`));
});

test("expansion preserves the native comment, including explicit impact and evidence", () => {
  const content = "Mismatch in subtotal.\n\nImpact: 低估了价格。\nEvidence: `price + quantity`.";
  const rows = findingRows({ ...example, content }, 64, false, true, plain);
  assert.match(rows[0], /^▿ High +Mismatch in subtotal\./u);
  assert.deepEqual(rows.slice(1).map(row => row.slice(4)), content.split("\n"));
});

test("expanded metadata uses the native category, and prose wraps between words without losing spaces", () => {
  const content = "Not a generated title. Multiply them to compute the total in cents.";
  const rows = findingRows({ ...example, content, category: "\x1b[31mbug\x1b[0m" }, 44, false, true, plain);
  const field = rows.findIndex(row => row.trim() === "Category  bug");
  assert.ok(field > 0);
  const body = rows.slice(field + 1).map(row => row.slice(4));
  assert.equal(body.join(""), content);
  assert.ok(body.slice(0, -1).every(row => row.endsWith(" ")));
});

test("wide comparisons align both headings and native lines even when one line wraps", () => {
  const before = "  const 原文 = " + "a".repeat(46) + ";", after = "  const 修正 = 1;";
  const finding = { ...example, existing_code: `${before}\n  return 原文;`, suggestion_code: `${after}\n  return 修正;\n  // 额外一行` };
  const width = 70, rows = findingRows(finding, width, false, true, plain);
  const columns = rows.slice(rows.findIndex(row => row.includes("Existing code")));
  const gap = " │ ", gapPosition = (row: string) => visibleWidth(row.slice(0, row.indexOf(gap)));
  assert.ok(columns.every(row => row.includes(gap) && gapPosition(row) === gapPosition(columns[0])));
  const cells = columns.map(row => row.split(gap));
  assert.deepEqual([cells[0][0].trim(), cells[0][1]], ["Existing code", "Suggested change"]);
  assert.equal(cells[1][1], after);
  assert.equal(cells[2][1], "");
  assert.equal(cells[1][0].slice(4).trimEnd() + cells[2][0].slice(4).trimEnd(), before);
  assert.deepEqual([cells[3][0].slice(4).trimEnd(), cells[3][1]], ["  return 原文;", "  return 修正;"]);
  assert.deepEqual([cells[4][0].trim(), cells[4][1]], ["", "  // 额外一行"]);
  fits(rows, width);
});

test("narrow comparisons stack without losing long indentation, blank lines, or trailing spaces", () => {
  const first = " ".repeat(45) + "const 值 = 👩‍💻;";
  const finding = { ...example, existing_code: `${first}\n\n\treturn 值;  `, suggestion_code: "    return 0;\n" };
  const width = 28, rows = findingRows(finding, width, false, true, plain);
  const oldHeading = rows.findIndex(row => row.trim() === "Existing code");
  const newHeading = rows.findIndex(row => row.trim() === "Suggested change");
  assert.ok(oldHeading >= 0 && newHeading > oldHeading);
  const original = rows.slice(oldHeading + 1, newHeading).map(row => row.slice(4));
  assert.equal(original.slice(0, -2).join(""), first);
  assert.deepEqual(original.slice(-2), ["", "    return 值;  "]);
  assert.deepEqual(rows.slice(newHeading + 1).map(row => row.slice(4)), ["    return 0;", ""]);
  fits(rows, width);
});

test("omits missing metadata and shows only the code blocks actually supplied", () => {
  const finding = { path: "src/a.ts", content: "Native comment.", start_line: 0, end_line: 0 };
  const rows = findingRows(finding, 72, false, true, plain);
  assert.match(rows[0], /^▿ Native comment\. +src\/a\.ts$/u);
  assert.equal(rows.length, 2);
  assert.doesNotMatch(rows.join("\n"), /Impact|Evidence|Existing code|Suggested change/u);
  for (const [field, label, omitted] of [["existing_code", "Existing code", "Suggested change"], ["suggestion_code", "Suggested change", "Existing code"]] as const) {
    const code = `    ${"a".repeat(45)};`;
    const text = findingRows({ ...finding, [field]: code }, 72, false, true, plain).join("\n");
    assert.ok(text.includes(label) && text.includes(code));
    assert.ok(!text.includes(omitted) && !text.includes("│"));
  }
});

test("sanitizes all rendered fields and honors terminal widths down to one column", () => {
  const finding = {
    ...example, path: "\x1b[2J文件/\x1b[31msafe.ts\x1b[0m", severity: "\tcritical\x1b[0m",
    content: "\x1b]8;;https://example.invalid\x07👩‍💻 e\u0301 标题。\x1b]8;;\x07\r\n第二行\x08",
    existing_code: "\t前\u202eloop();\r\n\tconsole.log(\"🧑‍💻\");\x1b[2J",
    suggestion_code: "\x9b2J\t替代(\"é\");\x7f\x00",
  };
  const wide = findingRows(finding, 80, false, true, plain).join("\n");
  for (const text of ["Critical", "文件/safe.ts:3–5", "👩‍💻 e\u0301 标题。", "第二行", "    前loop();", "🧑‍💻", "    替代(\"é\");"]) {
    assert.ok(wide.includes(text), `Missing ${text}`);
  }
  assert.doesNotMatch(wide, /example\.invalid|2J/u);
  for (const width of [1, 2, 3, 4, 5, 8, 12, 17, 23, 48, 64, 79, 103]) {
    for (const selected of [false, true]) for (const expanded of [false, true]) {
      const rows = findingRows(finding, width, selected, expanded, plain);
      assert.ok(rows[0].startsWith(selected ? (expanded ? "▾" : "▸") : (expanded ? "▿" : "▹")));
      fits(rows, width);
      assert.ok(rows.every(row => !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(row)));
    }
  }
  const tiny = { path: "漢", content: "👩‍💻界", start_line: 0, end_line: 0 };
  assert.deepEqual(findingRows(tiny, 2, false, true, plain), ["▿", "漢", "👩‍💻", "界"]);
});
