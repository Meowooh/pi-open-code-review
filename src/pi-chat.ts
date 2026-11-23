import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

// The text-only, non-streaming Chat Completions subset sent by OCR 1.14.2.
// The *upstream* Pi provider can still use streaming, OAuth, and its own protocol.
type WireCall = { id: string; type: "function"; function: { name: string; arguments: string } };
interface ChatRequest {
  model: string;
  stream?: boolean;
  messages: { role: string; content?: string | null; tool_calls?: WireCall[]; tool_call_id?: string }[];
  tools?: { type: string; function: { name: string; description?: string; parameters: object } }[];
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  max_completion_tokens?: number;
  max_tokens?: number;
}
const emptyUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export function createPiChat(registry: Pick<ModelRegistry, "streamSimple">, model: Model<Api>, reasoning?: SimpleStreamOptions["reasoning"]) {
  const id = `${model.provider}/${model.id}`;
  const stats = { requests: 0, answeredBy: [] as string[], toolCalls: Object.create(null) as Record<string, number>, toolResults: Object.create(null) as Record<string, number> };
  // OCR replays Chat messages; Codex/Anthropic may need the *original* signed Pi
  // blocks and native call IDs on the next request. Keep them in this run only.
  const history = new Map<string, { answer: AssistantMessage; call: ToolCall; ids: string[]; returned: boolean }>();
  async function complete(req: ChatRequest, signal: AbortSignal) {
    if (req.model !== id || req.stream || !Array.isArray(req.messages)) throw new Error("Expected a non-streaming OCR request for the selected model");
    if (req.tool_choice !== undefined && !["auto", "none", "required"].includes(req.tool_choice)) throw new Error("Unsupported tool_choice");
    signal.throwIfAborted();
    const timestamp = Date.now();
    const context: Context = { messages: [], tools: req.tools?.map(t => {
      if (t.type !== "function" || !t.function?.name || !t.function.parameters) throw new Error("Expected OCR function schema");
      return { name: t.function.name, description: t.function.description ?? "", parameters: t.function.parameters };
    }) };
    for (const [i, m] of req.messages.entries()) {
      const content = m.content ?? "";
      if (typeof content !== "string") throw new Error("Only OCR text messages are supported");
      if (m.role === "system" && i === 0) context.systemPrompt = content;
      else if (m.role === "system" || m.role === "user") context.messages.push({ role: m.role, content, timestamp });
      else if (m.role === "assistant" && m.tool_calls?.length) {
        const calls = m.tool_calls;
        const saved = history.get(calls[0].id);
        if (!saved || saved.ids.length !== calls.length || calls.some((c, j) => c.id !== saved.ids[j])) throw new Error("Unrecognized OCR tool-call history");
        context.messages.push(saved.answer);
      } else if (m.role === "assistant") {
        context.messages.push({ role: "assistant", content: [{ type: "text", text: content }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: emptyUsage, timestamp });
      } else if (m.role === "tool") {
        const saved = history.get(m.tool_call_id ?? "");
        if (!saved) throw new Error("Unrecognized OCR tool result ID");
        const name = saved.call.name;
        if (!saved.returned) { stats.toolResults[name] = (stats.toolResults[name] ?? 0) + 1; saved.returned = true; }
        context.messages.push({ role: "toolResult", toolCallId: saved.call.id, toolName: name, content: [{ type: "text", text: content }], isError: false, timestamp });
      } else throw new Error(`Unsupported OCR message role: ${m.role}`);
    }
    const limit = req.max_completion_tokens ?? req.max_tokens;
    const options: SimpleStreamOptions = { signal, reasoning, maxRetries: 0, maxTokens: limit && model.maxTokens > 0 ? Math.min(limit, model.maxTokens) : limit };
    // Subscription Codex endpoints do not consistently accept sampling overrides.
    if (model.api !== "openai-codex-responses" && req.temperature !== undefined) options.temperature = req.temperature;
    if (req.tool_choice === "required") {
      // 1.6.0's provider-neutral toolChoice is only 'auto' | 'none'. Never
      // silently downgrade a required OCR call. onPayload sees the routed API.
      options.onPayload = (payload, physical) => {
        if (typeof payload === "object" && payload && ["openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(physical.api)) return { ...payload, tool_choice: "required" };
        throw new Error(`Required tool choice not verified for ${physical.api} in this spike`);
      };
    } else options.toolChoice = req.tool_choice;
    stats.requests++;
    const answer = await registry.streamSimple(model, context, options).result();
    signal.throwIfAborted();
    if (!["stop", "length", "toolUse"].includes(answer.stopReason)) throw new Error(`Pi ${id}: ${answer.errorMessage?.slice(0, 400) || answer.stopReason}`);
    const physical = `${answer.provider}/${answer.model}`;
    if (!stats.answeredBy.includes(physical)) stats.answeredBy.push(physical);
    const calls = answer.content.filter(c => c.type === "toolCall");
    if (req.tool_choice === "required" && !calls.length) throw new Error("Pi provider did not return the required tool call");
    const ids = calls.map(() => `call_${randomUUID().replaceAll("-", "")}`);
    const tool_calls: WireCall[] = calls.map((call, i) => {
      if (call.argumentsError) throw new Error(`Invalid arguments returned for ${call.name}`);
      history.set(ids[i], { answer, call, ids, returned: false });
      stats.toolCalls[call.name] = (stats.toolCalls[call.name] ?? 0) + 1;
      return { id: ids[i], type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
    });
    const content = answer.content.filter(c => c.type === "text").map(c => c.text).join("");
    const u = answer.usage;
    return {
      id: `chatcmpl-${randomUUID()}`, object: "chat.completion", created: Math.floor(timestamp / 1000), model: id,
      choices: [{ index: 0, message: { role: "assistant", content: content || (calls.length ? null : ""), ...(calls.length ? { tool_calls } : {}) }, finish_reason: answer.stopReason === "length" ? "length" : calls.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: u.input + u.cacheRead + u.cacheWrite, completion_tokens: u.output, total_tokens: u.totalTokens, prompt_tokens_details: { cached_tokens: u.cacheRead } },
    };
  }
  return { id, stats, complete };
}
export type PiChat = ReturnType<typeof createPiChat>;
