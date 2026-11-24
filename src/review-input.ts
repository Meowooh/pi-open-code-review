import { Type, type Static } from "typebox";

const optional = (description: string) => Type.Optional(Type.String({ minLength: 1, description }));
export const reviewParameters = Type.Object({
  commit: optional("Review one commit against its parent. Do not use with from or to."),
  from: optional("Base ref for a range. Set to as well."),
  to: optional("Target ref for a range. Use HEAD for the current branch tip."),
  background: optional("Requirements or review focus for OCR. Do not include instructions for actions after the review."),
  backgroundFile: optional("Markdown file in this checkout with review requirements. Do not combine with background."),
  exclude: optional("Comma-separated gitignore-style patterns to exclude."),
  model: optional("Pi review model: provider/id, @alias, current, or a unique model query. Omit to use the configured default."),
  preview: Type.Optional(Type.Boolean({ description: "List files without running the review model." })),
}, { additionalProperties: false });
export type ReviewInput = Static<typeof reviewParameters>;

export interface ReviewOptions {
  target: string[]; model?: string; preview: boolean; background?: string; backgroundFile?: string;
}

export type ReviewScope = { commit: string } | { from: string; to: string };

/** Read only scope flag/value pairs from the validated native argv, never the background or an exclude value. */
export function explicitScope(target: readonly string[]): ReviewScope | undefined {
  let from: string | undefined, to: string | undefined;
  for (let i = 0; i < target.length; i += 2) {
    if (target[i] === "--commit") return { commit: target[i + 1] };
    if (target[i] === "--from") from = target[i + 1];
    if (target[i] === "--to") to = target[i + 1];
  }
  return from ? { from, to: to ?? "HEAD" } : undefined;
}

export function toolOptions(input: ReviewInput): ReviewOptions {
  const target: string[] = [];
  if (input.commit !== undefined && (input.from !== undefined || input.to !== undefined)) throw new Error("Use commit or a from/to range, not both.");
  if ((input.from === undefined) !== (input.to === undefined)) throw new Error("Set both from and to. Use to: HEAD for the current branch.");
  for (const key of ["commit", "from", "to", "exclude"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!value.trim() || value.includes("\0") || (key !== "exclude" && value.startsWith("-"))) throw new Error(`Invalid ${key}.`);
    target.push(`--${key}`, value);
  }
  if (input.background !== undefined && input.backgroundFile !== undefined) throw new Error("Use background or backgroundFile, not both.");
  if (input.model !== undefined && !input.model.trim()) throw new Error("Omit model or specify a review model.");
  return { target, model: input.model, preview: input.preview ?? false, background: input.background, backgroundFile: input.backgroundFile };
}

// Quoted flag values can include whitespace and literal flag names. This is not a shell.
function flagWords(args: string): { value: string; quoted?: boolean }[] {
  const words = [];
  const word = /\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/gy;
  const source = args.trim();
  while (word.lastIndex < source.length) {
    const match = word.exec(source);
    if (!match) throw new Error("Invalid review arguments");
    const quoted = match[1] ?? match[2];
    if (quoted !== undefined) {
      if (word.lastIndex < source.length && !/\s/.test(source[word.lastIndex])) throw new Error("Expected whitespace after a quoted value");
      words.push({ value: quoted, quoted: true });
    } else {
      const value = match[3];
      if (/^["']/.test(value)) throw new Error("Unclosed quote in review arguments");
      if (value.startsWith("--model=")) words.push({ value: "--model" }, { value: value.slice(8) });
      else words.push({ value });
    }
  }
  return words;
}

export function parseArgs(args: string) {
  const words = flagWords(args);
  const seen = new Set<string>();
  const target: string[] = [];
  let model: string | undefined;
  const context: Pick<ReviewOptions, "background" | "backgroundFile"> = {};
  for (let i = 0; i < words.length; i++) {
    const flag = words[i].value;
    if (seen.has(flag)) throw new Error(`Duplicate ${flag}`);
    seen.add(flag);
    if (["--model", "--background", "--background-file"].includes(flag)) {
      const terms = [];
      while (i + 1 < words.length && (words[i + 1].quoted || !words[i + 1].value.startsWith("-"))) terms.push(words[++i].value);
      const value = terms.join(" ");
      if (flag === "--model") model = value;
      else if (!value) throw new Error(`Missing value after ${flag}`);
      else context[flag === "--background" ? "background" : "backgroundFile"] = value;
    } else if (["--from", "--to", "--commit"].includes(flag)) {
      const ref = words[++i]?.value;
      if (!ref || ref.startsWith("-")) throw new Error(`Missing ref after ${flag}`);
      target.push(flag, ref);
    } else if (flag !== "--preview") throw new Error(`Unknown argument: ${flag}`);
  }
  if (seen.has("--to") && !seen.has("--from")) throw new Error("--to requires --from");
  if (seen.has("--commit") && seen.has("--from")) throw new Error("Use either --commit or --from");
  if (context.background && context.backgroundFile) throw new Error("Use --background or --background-file, not both.");
  return { model, target, preview: seen.has("--preview"), ...context };
}
