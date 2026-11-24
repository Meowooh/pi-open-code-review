import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, InputEvent, RegisteredCommand, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "../src/extension.ts";
import type { ReviewInput, reviewParameters } from "../src/review-input.ts";
import type { runNative, NativeResult, ReviewReport } from "../src/ocr.ts";
import { reviewFleet } from "../src/review-fleet.ts";
import type { reviewWidget } from "../src/review-widget.ts";
import { deferred } from "./deferred.ts";

type Panel = ReturnType<typeof reviewFleet>;
type Widget = ReturnType<typeof reviewWidget>;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function nativeResult(report: ReviewReport): NativeResult {
  return { ...report, document: JSON.parse(JSON.stringify(report)) };
}
const clean = () => nativeResult({ status: "complete", comments: [] });

function interactive(native: typeof runNative, mode: "regular" | "fullscreen" = "regular") {
  const commands = new Map<string, RegisteredCommand["handler"]>();
  const activeTools = ["ocr_review"];
  const publication = deferred<void>();
  const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => unknown>();
  let tool!: ToolDefinition<typeof reviewParameters>;
  const messages: { message: { content: string; customType: string; display: boolean; details?: ReviewReport }; options: { triggerTurn: boolean } }[] = [];
  const prompts: { text: string; options: unknown }[] = [], notices: string[] = [];
  const ui: { widget?: Widget; panel?: Panel; opened: number; overlay?: unknown } = { opened: 0 };
  const pi = {
    registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command.handler),
    on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => Promise<void>) => events.set(name, handler),
    getActiveTools: () => activeTools,
    registerMessageRenderer: (type: string, renderer: unknown) => { assert.equal(type, "open-code-review"); assert.equal(typeof renderer, "function"); },
    registerTool: (t: typeof tool) => { assert.equal(t.name, "ocr_review"); tool = t; },
    sendUserMessage: (text: string, options: unknown) => prompts.push({ text, options }),
    sendMessage: (message: typeof messages[number]["message"], options: typeof messages[number]["options"]) => { messages.push({ message, options }); publication.resolve(); },
  } as unknown as ExtensionAPI;
  const screen = { mode, terminal: { rows: 35, write() {} }, requestRender() {} }, theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (s: string) => s };
  const keys = { matches: (key: string, binding: string) => binding === `tui.select.${key}` };
  const ctx = {
    mode: "tui", model: { id: "author", provider: "fixture" }, scopedModels: [], thinkingLevel: "off", cwd: "/fixture",
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), streamSimple: () => assert.fail("unexpected model call") },
    ui: {
      getToolsExpanded: () => false,
      notify: (text: string) => notices.push(text),
      setWidget: (_: string, make?: (tui: typeof screen, th: typeof theme) => Widget) => { ui.widget?.dispose(); ui.widget = make?.(screen, theme); },
      custom: (make: (tui: typeof screen, th: typeof theme, k: typeof keys, done: () => void) => Panel, options: { overlay: boolean; overlayOptions(): unknown }) => new Promise<void>(resolve => {
        ui.opened++;
        ui.panel = make(screen, theme, keys, () => { ui.panel?.dispose(); ui.panel = undefined; resolve(); });
        ui.overlay = { overlay: options.overlay, overlayOptions: options.overlayOptions() };
      }),
    },
  } as unknown as ExtensionCommandContext;
  registerCommands(pi, native);
  const invoke = (name: string, args = "") => commands.get(name)!(args, ctx);
  const execute = (input: ReviewInput, signal?: AbortSignal) => tool.execute("tool-id", input, signal, undefined,
    Object.assign({ tools: [], executeTool: () => assert.fail("unexpected nested tool call") }, ctx));
  const context = (messages: unknown[]) => events.get("context")!({ messages }, ctx) as { messages: { content: { text: string }[] }[] } | undefined;
  const input = (text: string, source: InputEvent["source"] = "interactive") => events.get("input")!({ type: "input", text, source }, ctx);
  return { ctx, ui, messages, notices, prompts, commands, invoke, execute, activeTools, context, input, published: publication.promise, shutdown: async () => { await events.get("session_shutdown")!({}, ctx); } };
}

test("TUI command returns before OCR settles; only /ocr-fleet opens an overlay; one visible final report reaches the session without triggering a turn", async () => {
  const result = deferred<NativeResult>();
  let signal!: AbortSignal;
  const h = interactive(async (_cwd, _flags, chat, cancel) => { assert.equal(chat?.id, "fixture/reviewer"); signal = cancel; return result.promise; });
  await h.invoke("ocr-review", "--model fixture/reviewer --from main");
  assert.deepEqual([...h.commands.keys()].sort(), ["ocr-fleet", "ocr-review"]);
  assert.equal(h.ui.opened, 0);
  h.input("A question while the review is running");
  assert.match(h.ui.widget!.render(70)[0], /reviewer/);
  await assert.rejects(h.invoke("ocr-review"), /already running/);
  const panel = h.invoke("ocr-fleet");
  assert.match(h.ui.panel!.render(80).join("\n"), /Range  main → HEAD/);
  assert.deepEqual(h.ui.overlay, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" } });
  h.ui.panel!.handleInput("cancel"); await panel;
  assert.equal(signal.aborted, false);
  result.resolve(nativeResult({ status: "complete", comments: [{ path: "price.py", start_line: 3, end_line: 3, content: "Title. Evidence." }] }));
  await flush();
  assert.match(h.ui.widget!.render(80)[0], /✓ OCR  Completed · reviewer · 1 finding/);
  assert.equal(h.ui.opened, 1);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].message.customType, "open-code-review");
  assert.equal(h.messages[0].message.display, true);
  assert.equal(h.messages[0].message.details?.comments[0].path, "price.py");
  assert.equal(h.messages[0].options.triggerTurn, false);
  assert.equal(JSON.parse(h.messages[0].message.content).comments[0].content, "Title. Evidence.");
  const [origin, json] = h.context([{ role: "custom", ...h.messages[0].message }])!.messages[0].content;
  assert.match(origin.text, /data, not a user request/);
  assert.equal(json.text, h.messages[0].message.content);
  assert.equal(h.context([{ role: "user", content: "What did OCR find?" }]), undefined);
  assert.deepEqual([h.prompts, h.notices], [[], []]);
  h.input("Automatic extension input", "extension"); h.input("  ");
  assert.ok(h.ui.widget);
  h.input("Fix the first finding");
  assert.equal(h.ui.widget, undefined);
  const read = h.invoke("ocr-fleet");
  assert.doesNotMatch(h.ui.panel!.render(80).join("\n"), /Evidence/);
  h.ui.panel!.handleInput("confirm"); assert.match(h.ui.panel!.render(80).join("\n"), /Evidence/);
  await h.shutdown(); await read; assert.equal(h.ui.widget, undefined);
});

test("the fullscreen Fleet claims every cell even with no review, and Esc dismisses it", async () => {
  const h = interactive(async () => assert.fail("not reviewing"), "fullscreen");
  const view = h.invoke("ocr-fleet");
  assert.deepEqual(h.ui.overlay, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } });
  assert.equal(h.ui.panel!.render(80).length, 35);
  h.ui.panel!.handleInput("cancel"); await view;
  assert.equal(h.ui.panel, undefined);
});

test("stop is explicit; shutdown aborts a later run and waits for native cleanup without posting stale results", async () => {
  const runs: { signal: AbortSignal; result: ReturnType<typeof deferred<NativeResult>> }[] = [];
  const h = interactive(async (_cwd, _flags, _chat, signal) => { const result = deferred<NativeResult>(); runs.push({ signal, result }); return result.promise; });
  const start = () => h.invoke("ocr-review", "--model fixture/reviewer");
  await start(); const view = h.invoke("ocr-fleet"); h.ui.panel!.handleInput("x");
  assert.ok(runs[0].signal.aborted); assert.match(h.ui.widget!.render(80)[0], /Stopping/);
  h.ui.panel!.handleInput("cancel"); await view;
  await assert.rejects(start(), /already running/);
  runs[0].result.resolve(clean()); await flush();
  assert.match(h.ui.widget!.render(80)[0], /Stopped/);
  await start();
  let cleaned = false; const ending = h.shutdown().then(() => { cleaned = true; });
  assert.ok(runs[1].signal.aborted); await flush(); assert.equal(cleaned, false);
  runs[1].result.resolve(clean()); await ending;
  assert.equal(h.ui.widget, undefined); assert.deepEqual(h.messages, []);
});

test("preview still waits for native selection, never picks a model or replaces the background widget", async () => {
  const result = deferred<NativeResult>();
  const h = interactive(async (_cwd, _flags, chat) => { assert.equal(chat, undefined); return result.promise; });
  let returned = false;
  const preview = h.invoke("ocr-review", "--preview").then(() => { returned = true; }); await flush();
  assert.equal(returned, false); assert.equal(h.ui.widget, undefined); assert.equal(h.ui.opened, 0);
  result.resolve({ status: "preview", coverage: { selected: ["sample.py"] }, comments: [], document: { total_files: 1, files: [{ path: "sample.py", will_review: true }] } }); await preview;
  assert.match(h.notices.join("\n"), /OCR preview.*\nsample.py/); assert.deepEqual(h.messages, []);
});

test("the visible user message is exactly the typed command, including multiline arguments, not tool instructions", async () => {
  const h = interactive(async () => assert.fail("Only the calling agent can start this OCR tool run"));
  const intent = '审计当前代码实现看是否有问题\n重点看退款。';
  await h.invoke("ocr-review", intent);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].text, `/ocr-review ${intent}`);
  assert.deepEqual(h.messages, []);
  assert.deepEqual(h.prompts[0].options, { deliverAs: "followUp", expandPromptTemplates: false });
  assert.equal(h.ui.widget, undefined);
  await assert.rejects(h.invoke("ocr-review", "--not-a-real-flag"), /Unknown argument/);
  h.activeTools.length = 0;
  await assert.rejects(h.invoke("ocr-review", intent), /Enable ocr_review/);
  assert.equal(h.prompts.length, 1);
});

test("an agent gets the native document directly, not an extra session completion; tool and command share the same lock", async () => {
  const result = deferred<NativeResult>();
  const started = deferred<void>();
  const h = interactive(async (_cwd, flags, chat, _signal, progress, background) => {
    assert.deepEqual(flags, ["--commit", "HEAD"]); assert.equal(chat?.id, "fixture/reviewer");
    assert.equal(background?.background, "Refund totals must be exact."); assert.ok(progress);
    started.resolve(); return result.promise;
  });
  const executing = h.execute({ commit: "HEAD", background: "Refund totals must be exact.", model: "fixture/reviewer" });
  await started.promise;
  await assert.rejects(h.invoke("ocr-review"), /already running/);
  const doc = { status: "partial", message: "Some files were skipped.", comments: null, manifest: { terminal_state: "partial" } };
  result.resolve({ status: "partial", comments: [], document: doc });
  const answer = await executing;
  assert.deepEqual(answer.structuredContent, doc);
  assert.deepEqual(answer.content, [{ type: "text", text: JSON.stringify(doc) }]);
  assert.deepEqual(h.messages, []); assert.deepEqual(h.prompts, []); assert.equal(h.ui.opened, 0);
  const view = h.invoke("ocr-fleet");
  assert.match(h.ui.panel!.render(80).join("\n"), /Commit  HEAD/);
  h.ui.panel!.handleInput("cancel"); await view;
});

test("the receipt for a large native report keeps display details out of the inline model text", async () => {
  const longCode = "q".repeat(60_000);
  const finding = { path: "large.ts", start_line: 3, end_line: 3, severity: "medium", content: "Long code sample.", existing_code: longCode };
  const h = interactive(async () => nativeResult({ status: "partial", comments: [finding] }));
  try {
    await h.invoke("ocr-review", "--model fixture/reviewer");
    // The oversized native JSON is written asynchronously before the single receipt is posted.
    await h.published;
    const [{ message, options }] = h.messages;
    assert.ok(message.display); assert.equal(options.triggerTurn, false);
    assert.equal(message.details?.comments[0].existing_code, longCode);
    assert.match(message.content, /Full report \(read during this session\)/);
    const text = h.context([{ role: "custom", ...message }])!.messages[0].content;
    assert.equal(text[1].text, message.content); assert.ok(!text[1].text.includes(longCode));
  } finally { await h.shutdown(); }
});

test("a failed direct review shows a failure receipt, never a clean result or a second model turn", async () => {
  const h = interactive(async () => { throw new Error("OCR executable unavailable"); });
  await h.invoke("ocr-review", "--model fixture/reviewer"); await h.published;
  assert.equal(h.messages.length, 1);
  const [{ message, options }] = h.messages;
  assert.ok(message.display); assert.equal(options.triggerTurn, false);
  assert.equal(message.details?.status, "failed"); assert.match(message.content, /OCR executable unavailable/);
  h.input("Why did the review fail?"); assert.equal(h.ui.widget, undefined);
  assert.equal(h.prompts.length, 0);
  await h.shutdown();
});

test("aborting the agent's tool aborts OCR and leaves no second completion in the session", async () => {
  const started = deferred<void>(), cancel = new AbortController();
  const h = interactive((_cwd, _flags, _chat, signal) => new Promise((_resolve, reject) => {
    started.resolve(); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const executing = h.execute({ model: "fixture/reviewer" }, cancel.signal);
  await started.promise; cancel.abort();
  await assert.rejects(executing, /abort/i);
  assert.match(h.ui.widget!.render(80)[0], /Stopped/); assert.deepEqual(h.messages, []);
});
