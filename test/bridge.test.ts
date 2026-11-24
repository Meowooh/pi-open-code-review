import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { createPiChat } from "../src/pi-chat.ts";
import { listenForOcr, childEnvironment } from "../src/ocr.ts";
import type { ReviewProgress } from "../src/review-task.ts";

const model: Model<"openai-codex-responses"> = { api: "openai-codex-responses", id: "reviewer", provider: "fixture", name: "Reviewer", baseUrl: "https://invalid.example", reasoning: true, input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const answer: AssistantMessage = { role: "assistant", api: model.api, model: model.id, provider: model.provider, timestamp: 0, stopReason: "toolUse", usage: { ...model.cost, totalTokens: 0, cost: { ...model.cost, total: 0 } }, content: [
  { type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque-test-signature" },
  { type: "toolCall", id: "call_one|fc_item_one", name: "file_read", arguments: { file_path: "example.py" } },
] };
const prompt = [{ role: "system", content: "OCR instructions" }, { role: "user", content: "Review the diff" }];

test("round trip: OCR owns tools; preserve Pi-native IDs and signed history without sending it to OCR", async () => {
  const contexts: Context[] = [];
  const chat = createPiChat({ streamSimple: (m, context, options) => {
    assert.equal(m, model);
    assert.ok(options?.signal);
    contexts.push(context);
    const stream = createAssistantMessageEventStream();
    stream.end(contexts.length === 1 ? answer : { ...answer, content: [{ type: "text", text: "done" }], stopReason: "stop" });
    return stream;
  } }, model);
  const signal = new AbortController().signal;
  const first = await chat.complete({ model: chat.id, messages: prompt, tools: [{ type: "function", function: { name: "file_read", parameters: { type: "object" } } }] }, signal);
  const wire = first.choices[0].message;
  const id = wire.tool_calls![0].id;
  assert.notEqual(id, "call_one|fc_item_one");
  assert.doesNotMatch(JSON.stringify(first), /opaque-test-signature/);
  assert.deepEqual(contexts[0].tools?.map(t => t.name), ["file_read"]);
  assert.equal(contexts[0].systemPrompt, "OCR instructions");
  const second = { model: chat.id, messages: [...prompt, wire, { role: "tool", tool_call_id: id, content: "untracked example data" }] };
  await chat.complete(second, signal);
  assert.equal(contexts[1].messages[1], answer);
  assert.deepEqual(contexts[1].messages.map(m => m.role), ["user", "assistant", "toolResult"]);
  const result = contexts[1].messages.at(-1)!;
  assert.equal(result.role, "toolResult");
  assert.equal(result.toolCallId, "call_one|fc_item_one");
  await chat.complete(second, signal); // OCR can replay a turn or retry.
  assert.equal(chat.stats.toolResults.file_read, 1);
  assert.deepEqual(chat.stats.answeredBy, [chat.id]);
});

test("count only acknowledged code_comment batches, once per wire ID; don't expose private fields or guess locations", async () => {
  const updates: ReviewProgress[] = [];
  const stream = () => {
    const s = createAssistantMessageEventStream();
    s.end({ ...answer, content: [{ type: "toolCall", id: "native_id", name: "code_comment", arguments: { comments: [
      { path: "a.ts", content: "Fix total.", start_line: 999, thinking: "private reasoning", suggestion_code: "multiply()" },
      { path: "b.ts", content: "Fix tax." }, { content: "Missing location" },
    ] } }] });
    return s;
  };
  const chat = createPiChat({ streamSimple: stream }, model).withProgress(u => updates.push(u));
  const signal = new AbortController().signal;
  const first = await chat.complete({ model: chat.id, messages: prompt }, signal);
  assert.ok(updates.some(u => u.activity === "Submitting findings"));
  assert.ok(!updates.some(u => u.candidates));
  const resultOf = (answer: typeof first, content: string) => {
    const wire = answer.choices[0].message;
    return chat.complete({ model: chat.id, messages: [...prompt, wire, { role: "tool", tool_call_id: wire.tool_calls![0].id, content }] }, signal);
  };
  const second = await resultOf(first, "Error: no comments filed");
  assert.ok(!updates.some(u => u.candidates));
  await resultOf(second, "Successfully commented."); await resultOf(second, "Successfully commented.");
  const batches = updates.flatMap(u => u.candidates ? [u.candidates] : []);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(c => [c.path, c.start_line]), [["a.ts", 0], ["b.ts", 0]]);
  assert.equal(batches[0][0].suggestion_code, "multiply()");
  assert.doesNotMatch(JSON.stringify(batches), /private reasoning|999/);
});

test("the local bridge rejects foreign clients, routes and models without contacting a provider", async () => {
  const chat = createPiChat({ streamSimple: () => { throw new Error("unexpected provider request"); } }, model);
  const bridge = await listenForOcr(chat, new AbortController().signal);
  try {
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:[0-9]+\/v1$/);
    assert.equal((await fetch(bridge.url + "/chat/completions", { method: "POST" })).status, 401);
    const options = { method: "POST", headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ model: "wrong", messages: prompt }) };
    assert.equal((await fetch(bridge.url + "/other", options)).status, 404);
    assert.equal((await fetch(bridge.url + "/chat/completions", options)).status, 400);
    assert.equal(chat.stats.requests, 0);
  } finally { await bridge.close(); }
  await assert.rejects(fetch(bridge.url + "/chat/completions"));
});

test("the child gets only run-local credentials and its own home", () => {
  const env = childEnvironment("/private/spike", { model: "fixture/reviewer", url: "http://127.0.0.1:1234/v1", token: "once" });
  assert.equal(env.HOME, "/private/spike");
  assert.equal(env.OCR_LLM_TOKEN, "once");
  assert.equal(env.OCR_LLM_PROTOCOL, "openai");
  for (const key of ["OPENAI_API_KEY", "PI_CODING_AGENT_DIR", "OCR_LLM_EXTRA_HEADERS", "OTEL_EXPORTER_OTLP_ENDPOINT", "GITHUB_TOKEN", "HTTP_PROXY", "NODE_OPTIONS"]) assert.equal(key in env, false);
});
