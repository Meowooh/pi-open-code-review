import { stripVTControlCharacters } from "node:util";
import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiChat } from "./pi-chat.ts";
import { runNative } from "./ocr.ts";
import { modelCompletions, modelKey, selectReviewModel } from "./select-model.ts";

export function parseArgs(args: string) {
  const words = args.trim().split(/\s+/).filter(Boolean).flatMap(w => w.startsWith("--model=") ? ["--model", w.slice(8)] : [w]);
  const seen = new Set<string>();
  const target: string[] = [];
  let model: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const flag = words[i];
    if (seen.has(flag)) throw new Error(`Duplicate ${flag}`);
    seen.add(flag);
    if (flag === "--model") {
      const terms = [];
      while (i + 1 < words.length && !words[i + 1].startsWith("-")) terms.push(words[++i]);
      model = terms.join(" ");
    } else if (["--from", "--to", "--commit"].includes(flag)) {
      const ref = words[++i];
      if (!ref || ref.startsWith("-")) throw new Error(`Missing ref after ${flag}`);
      target.push(flag, ref);
    } else if (flag !== "--preview") throw new Error(`Unknown argument: ${flag}`);
  }
  if (seen.has("--to") && !seen.has("--from")) throw new Error("--to requires --from");
  if (seen.has("--commit") && seen.has("--from")) throw new Error("Use either --commit or --from");
  return { model, target, preview: seen.has("--preview") };
}

type Report = Awaited<ReturnType<typeof runNative>>;
function describe(r: Report, model?: string) {
  const file = r.coverage;
  const selected = file?.selected ?? [];
  const lines = r.status === "preview"
    ? [`OCR 预览 · ${selected.length} 个待审文件（未调用模型）`, ...selected]
    : [`OCR 原生审查 · ${model} · ${r.status}`, file ? `完成 ${file.completed?.length ?? 0}/${selected.length} 个文件，发现 ${r.comments.length} 个问题。` : `覆盖率未知，发现 ${r.comments.length} 个问题。`, ...r.comments.map((c, i) => `${i + 1}. [${c.severity ?? "finding"}] ${c.path}${c.start_line > 0 ? `:${c.start_line}` : ""} — ${c.content}`)];
  return stripVTControlCharacters(lines.join("\n")).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

async function withLoader(ctx: ExtensionCommandContext, label: string, cancel: AbortController, run: () => Promise<Report>) {
  if (ctx.mode !== "tui") return run();
  const result = await ctx.ui.custom<{ value: Report } | { error: unknown }>((tui, theme, _keys, done) => {
    const loader = new BorderedLoader(tui, theme, label);
    loader.onAbort = () => cancel.abort();
    run().then(value => done({ value }), error => done({ error }));
    return loader;
  });
  if ("error" in result) throw result.error;
  return result.value;
}

export default function (pi: ExtensionAPI) {
  let session: ExtensionContext | undefined;
  let active: AbortController | undefined;
  pi.on("session_start", (_event, ctx) => { session = ctx; });
  pi.on("session_shutdown", () => { session = undefined; active?.abort(); });
  pi.registerCommand("open-code-review", {
    description: "Native OCR review [--model QUERY|@alias] [--preview] [--commit REF | --from REF [--to REF]]",
    getArgumentCompletions: prefix => session ? modelCompletions(session, prefix) : null,
    handler: async (args, ctx) => {
      if (active) throw new Error("An OCR review is already running");
      const opts = parseArgs(args);
      const before = ctx.model && modelKey(ctx.model);
      const cancel = new AbortController();
      active = cancel;
      try {
        const model = opts.preview ? undefined : await selectReviewModel(ctx, opts.model);
        if (!opts.preview && !model) return; // User cancelled the picker.
        const level = model && ctx.scopedModels.find(x => modelKey(x.model) === modelKey(model))?.thinkingLevel || ctx.thinkingLevel;
        const chat = model && createPiChat(ctx.modelRegistry, model, level === "off" ? undefined : level);
        const label = `${opts.preview ? "OCR 文件预览" : `OCR · ${chat!.id}`} · ${opts.target.join(" ") || "工作区"}`;
        const result = await withLoader(ctx, label, cancel, () => runNative(ctx.cwd, opts.target, chat, cancel.signal));
        const content = describe(result, chat?.id);
        pi.sendMessage({ customType: "open-code-review", display: true, content, details: {
          ...result, selectedModel: chat?.id, sessionModelBefore: before, sessionModelAfter: ctx.model && modelKey(ctx.model), bridge: chat?.stats,
        } }, { triggerTurn: false });
        if (ctx.mode === "print") console.log(content);
      } finally { active = undefined; }
    },
  });
}
