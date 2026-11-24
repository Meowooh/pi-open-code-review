import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

export const MODELS = ["author", "reviewer"];
export const PATH = "pricing.py";
const correct = "    return unit_price_cents * quantity";
const incorrect = "    return unit_price_cents + quantity";
export const BEFORE = `def subtotal_cents(unit_price_cents: int, quantity: int) -> int:
    """Return the subtotal in cents for the given number of units."""
${correct}
`;
export const AFTER = BEFORE.replace(correct, incorrect);
const sourceLines = AFTER.trimEnd().split("\n");
export const BUG_LINE = sourceLines.indexOf(incorrect) + 1;
export const FINDING = "Adding the unit price and quantity gives an incorrect subtotal. Multiply them to compute the total in cents.";
const numberedSource = sourceLines.map((line, i) => `${i + 1}|${line}`).join("\n");

const background = "SMOKE-SUBTOTAL-947: Four 25-cent units must yield a 100-cent subtotal before discounts.";
const intent = `Please review the workspace using @review. Focus on this requirement: ${background} Send the findings back for follow-up.`;
export const AGENT_CASE = {
  command: `/ocr-review ${intent}`,
  tool: "ocr_review",
  // No commit or range selectors: ocr_review defaults to workspace changes.
  args: { model: "@review", background },
  reply: `Review complete: ${PATH}:${BUG_LINE} adds the unit price and quantity instead of multiplying.`,
};

class FixtureError extends Error {}
function expect(condition, message) {
  if (!condition) throw new FixtureError(message);
}

function streamReply(res, model, id, delta, reason) {
  const chunk = { id: `chatcmpl-smoke-${id}`, object: "chat.completion.chunk", created: 1, model };
  const events = [
    { ...chunk, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
    { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: reason }] },
    { ...chunk, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
  ];
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
}

const messageText = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => part.text).join("") : "";

function verifyNativeResult(message) {
  let report;
  try { report = JSON.parse(messageText(message.content)); }
  catch { throw new FixtureError("Author tool result was not unwrapped native OCR JSON"); }
  expect(report?.status === "complete" && typeof report.message === "string" && Array.isArray(report.comments),
    "Author tool result lacked the native status, message or comments");
  const { selected, completed } = report.manifest?.coverage ?? {};
  expect([selected, completed].every((entries) => Array.isArray(entries) && entries.length === 1 && entries[0]?.path === PATH),
    "Author tool result lacked native manifest coverage for the fixture workspace");
  expect(report.comments.some((c) => c?.path === PATH && c.start_line === BUG_LINE && c.end_line === BUG_LINE
    && typeof c.content === "string" && c.content.includes(FINDING)), `Author did not receive the OCR finding at ${PATH}:${BUG_LINE}`);
}

export async function startFixtureProvider({ agent = false } = {}) {
  const apiKey = `fixture-${randomUUID()}`;
  const requests = [];
  const issued = new Map();
  const observedCode = new Map();
  let authorCallId, authorSawResult = false;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${apiKey}`) return res.writeHead(401).end();

    const record = {};
    const id = requests.push(record);
    try {
      let json = "";
      for await (const piece of req.setEncoding("utf8")) {
        json += piece;
        expect(json.length <= 2 ** 20, "Fixture request exceeded the size limit");
      }
      const { model, messages, tools, stream } = JSON.parse(json);
      expect(MODELS.includes(model), "Unexpected physical fixture model ID");
      record.model = model;
      expect(stream === true && Array.isArray(messages), "Expected a streaming Pi chat request");
      const toolNames = tools?.map((tool) => tool.function?.name) ?? [];
      const names = new Set(toolNames);
      const call = (name, args) => {
        const toolId = `call_smoke_${id}`;
        issued.set(toolId, { model, name });
        record.tool = name;
        streamReply(res, model, id, { tool_calls: [
          { index: 0, id: toolId, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ] }, "tool_calls");
        return toolId;
      };
      const result = (name) => messages.findLast((message) => {
        const prior = issued.get(message.tool_call_id);
        return message.role === "tool" && prior?.model === model && prior.name === name;
      });

      if (agent && model === MODELS[0]) {
        expect(!authorSawResult, "Author was invoked again after receiving the review result");
        expect(toolNames.length <= 1 && toolNames.every((name) => name === AGENT_CASE.tool),
          "Author was offered tools other than ocr_review");
        if (!authorCallId) {
          expect(toolNames.length === 1, "Author was not offered ocr_review");
          expect(!messages.some((m) => m.role === "assistant" || m.role === "tool"), "Author did not start a fresh turn");
          // In a fresh session the author gets the command verbatim. Tool instructions belong to the tool.
          const userTexts = messages.filter((m) => m.role === "user").map((m) => messageText(m.content));
          expect(userTexts.length === 1 && userTexts[0] === AGENT_CASE.command,
            "The user message was not the original command");
          expect(tools[0].function.description.includes("/ocr-review"), "Missing command routing in the ocr_review definition");
          record.verifiedIntent = true;
          authorCallId = call(AGENT_CASE.tool, AGENT_CASE.args);
          return;
        }
        const calls = messages.flatMap((m) => m.role === "assistant" ? m.tool_calls ?? [] : []);
        const results = messages.filter((m) => m.role === "tool");
        expect(calls.length === 1 && calls[0].id === authorCallId && calls[0].function?.name === AGENT_CASE.tool
          && results.length === 1 && results[0].tool_call_id === authorCallId,
          "Author did not receive exactly one result for its ocr_review call");
        verifyNativeResult(results[0]);
        record.verifiedReviewResult = true;
        authorSawResult = true;
        return streamReply(res, model, id, { content: AGENT_CASE.reply }, "stop");
      }

      if (agent) expect(authorCallId && !authorSawResult, "Native reviewer ran outside the author tool call");
      if (names.has("approve_all_comments")) {
        expect(messages.some((m) => m.role === "user" && m.content?.includes(FINDING)),
          "OCR's default review filter did not receive the fixture finding");
        return call("approve_all_comments", {});
      }
      if (names.size === 0 && messages.some((m) => m.role === "system"
        && m.content?.includes("You are a code location assistant"))) {
        expect(observedCode.has(model), "OCR requested relocation before returning source evidence");
        return streamReply(res, model, id, { content: "```\n" + observedCode.get(model) + "\n```" }, "stop");
      }

      expect(["file_read", "code_comment", "task_done"].every((name) => names.has(name)),
        "Expected OCR's native review tools");
      const read = result("file_read");
      if (!read) {
        expect(!messages.some((m) => m.role === "assistant" || m.role === "tool"),
          "Native file_read result was not replayed");
        if (agent) {
          expect(messages.some((m) => ["system", "user"].includes(m.role) && messageText(m.content).includes(background)),
            "Native reviewer did not receive the exact review background");
          record.verifiedBackground = true;
        }
        return call("file_read", { file_path: PATH });
      }
      // Match the result of our own call, never source echoed in a prompt.
      const text = read.content;
      const prefix = `${BUG_LINE}|`;
      const existingCode = typeof text === "string" && text.split("\n")
        .find((line) => line.startsWith(prefix))?.slice(prefix.length);
      expect(existingCode === incorrect && text.includes(`File: ${PATH} (`) && text.includes(numberedSource),
        "Native file_read result did not contain the expected numbered source");
      observedCode.set(model, existingCode);
      record.verifiedFileRead = true;
      const comment = result("code_comment");
      if (!comment) {
        expect(!messages.some((m) => m.tool_calls?.some((c) => c.function?.name === "code_comment")),
          "Native code_comment result was not replayed");
        return call("code_comment", { comments: [{
          path: PATH, content: FINDING, existing_code: existingCode, suggestion_code: correct,
          category: "bug", severity: "high",
        }] });
      }
      expect(comment.content?.trim() === "Successfully commented.", "Native code_comment did not acknowledge the finding");
      record.verifiedCodeComment = true;
      return call("task_done", { state: "DONE" });
    } catch (error) {
      record.error = error instanceof FixtureError ? error.message : "Invalid fixture chat request";
      if (!res.destroyed) res.writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: record.error } }));
    }
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey, requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
