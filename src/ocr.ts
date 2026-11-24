import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { PiChat } from "./pi-chat.ts";
import type { ReviewProgress } from "./review-task.ts";

const MB = 1024 * 1024;

export async function listenForOcr(chat: Pick<PiChat, "complete">, signal: AbortSignal) {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    const reply = (status: number, json: unknown) => {
      if (!res.destroyed) res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(json));
    };
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return reply(404, {});
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, {});
    const disconnect = new AbortController();
    res.once("close", () => { if (!res.writableEnded) disconnect.abort(); });
    try {
      const buffers: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 8 * MB) return reply(413, { error: { message: "OCR request exceeds 8 MiB" } });
        buffers.push(part);
      }
      const payload = JSON.parse(Buffer.concat(buffers).toString("utf8"));
      const answer = await chat.complete(payload, AbortSignal.any([signal, disconnect.signal]));
      reply(200, answer);
    } catch (e) {
      // A bad request or provider failure should stop OCR, not prompt it to retry
      // a 500 several times at the user's expense.
      reply(400, { error: { message: e instanceof Error ? e.message.slice(0, 512) : "Pi bridge request failed" } });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, token, close: () => new Promise<void>((resolve, reject) => {
    server.close(e => e ? reject(e) : resolve());
    server.closeAllConnections();
  }) };
}

export function childEnvironment(home: string, endpoint?: { url: string; token: string; model: string }): NodeJS.ProcessEnv {
  // Deliberate allowlist. In particular: no provider credentials, Git overrides,
  // runtime injection, OTEL exporters, proxies or inherited OCR_LLM_* headers.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home,
    LANG: "C", NO_COLOR: "1", OCR_NO_UPDATE: "1", OCR_ENABLE_TELEMETRY: "0", GIT_TERMINAL_PROMPT: "0",
  };
  if (process.platform === "win32") env.SystemRoot = process.env.SystemRoot;
  if (endpoint) Object.assign(env, { OCR_LLM_URL: endpoint.url, OCR_LLM_TOKEN: endpoint.token, OCR_LLM_PROTOCOL: "openai", OCR_LLM_MODEL: endpoint.model });
  return env;
}

class NativeExitError extends Error {}

function withoutBridgeToken(text: string, token?: string) {
  return token ? text.replaceAll(token, "[redacted]") : text;
}

function execute(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const posix = process.platform !== "win32";
    const child = spawn("ocr", args, { cwd, env, stdio: ["ignore", "ignore", "pipe"], detached: posix, shell: false });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", s => { stderr = (stderr + s).slice(-2000); });
    const kill = (s: NodeJS.Signals) => {
      if (!child.pid) return;
      try { if (posix) process.kill(-child.pid, s); else child.kill(s); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    };
    let force: NodeJS.Timeout | undefined;
    const onAbort = () => { kill("SIGTERM"); force = setTimeout(() => kill("SIGKILL"), 1500); force.unref(); };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.once("close", (code, killedBy) => {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(force);
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else {
        // OCR can write a structured usage dump with raw tool arguments before its text error.
        const usageEnd = stderr.lastIndexOf("\n}");
        const diagnostic = withoutBridgeToken((usageEnd < 0 ? stderr : stderr.slice(usageEnd + 2)).trim(), env.OCR_LLM_TOKEN);
        reject(new NativeExitError(`ocr review (${code ?? killedBy}): ${diagnostic || "no diagnostic"}`));
      }
    });
  });
}

type NativeContext = { background?: string; backgroundFile?: string };

function checkBackgroundSize(bytes: number) {
  if (bytes > MB) throw new Error("OCR background file exceeds 1 MiB");
}

function checkBackgroundContent(text: string) {
  // Validate against OCR's limit on sanitized Unicode code points, not JS code units.
  const cleaned = text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Cf}]/gu, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) throw new Error("OCR background is empty after Markdown sanitization");
  if (/<\/?ocr_user_background>/.test(cleaned)) throw new Error("OCR background contains a reserved delimiter");
  if (cleaned.length > 8000 && [...cleaned].length > 8000) throw new Error("OCR background exceeds 8000 characters after Markdown sanitization");
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function readBackground(cwd: string, input: string, signal: AbortSignal) {
  const name = input.trim().replace(/^@/, "");
  const isMarkdown = (path: string) => [".md", ".markdown"].includes(extname(path).toLowerCase());
  const invalidFile = () => new Error("backgroundFile must name an existing regular .md or .markdown file");
  if (!isMarkdown(name) || name.includes("\0")) throw invalidFile();
  const checkout = resolve(cwd);
  const root = await realpath(checkout);
  const requested = resolve(checkout, name);
  if (!inside(checkout, requested) && !inside(root, requested)) throw new Error("backgroundFile must stay inside the checkout");
  const path = await realpath(requested).catch(() => { throw invalidFile(); });
  if (!inside(root, path)) throw new Error("backgroundFile must stay inside the checkout");
  if (!isMarkdown(path)) throw invalidFile();
  const before = await lstat(path);
  if (!before.isFile()) throw invalidFile();
  checkBackgroundSize(before.size);
  signal.throwIfAborted();

  // Snapshot the checked file; do not send OCR back to the original path. On
  // POSIX, don't follow a substituted leaf symlink or block on a substituted FIFO.
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const file = await open(path, flags);
  try {
    const info = await file.stat();
    const changed = () => new Error("backgroundFile changed during validation");
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || await realpath(path) !== path) throw changed();
    checkBackgroundSize(info.size);
    const bytes = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) throw changed();
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

async function prepareBackground(cwd: string, home: string, signal: AbortSignal,
  { background, backgroundFile }: NativeContext = {}) {
  if (background !== undefined && backgroundFile !== undefined) throw new Error("Use either background or backgroundFile, not both");
  const data = backgroundFile === undefined ? background?.trim() : await readBackground(cwd, backgroundFile, signal);
  if (!data) return;
  checkBackgroundSize(Buffer.byteLength(data));
  let text: string;
  try { text = typeof data === "string" ? data : new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { throw new Error("backgroundFile must contain UTF-8 Markdown"); }
  checkBackgroundContent(text);
  const path = join(home, "background.md");
  await writeFile(path, data, { flag: "wx", mode: 0o600, signal });
  return path;
}

function parseNativeDocument(text: string, token?: string) {
  let document;
  try {
    document = JSON.parse(text, (key, value) => key === "thinking" ? undefined :
      typeof value === "string" ? withoutBridgeToken(value, token) : value);
  } catch { throw new Error("Invalid JSON in native OCR report"); }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Unrecognized native OCR report");
  const failures = document.tool_calls?.failure_details;
  if (Array.isArray(failures)) for (const failure of failures) {
    // OCR can store reasoning, prompt excerpts or secrets in serialized tool
    // arguments and can echo those arguments in the failure's error string.
    if (failure?.arguments) failure.arguments = "[redacted]";
    if (failure?.error) failure.error = "[redacted]";
  }
  return document;
}

export async function runNative(cwd: string, targetFlags: string[], chat: PiChat | undefined, cancel: AbortSignal,
  onProgress?: (event: ReviewProgress) => void, context?: NativeContext): Promise<NativeResult> {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([cancel, lifetime.signal, AbortSignal.timeout(5 * 60_000)]);
  signal.throwIfAborted();
  const home = await mkdtemp(join(tmpdir(), "pi-ocr-"));
  let bridge: Awaited<ReturnType<typeof listenForOcr>> | undefined;
  try {
    signal.throwIfAborted();
    const backgroundPath = await prepareBackground(cwd, home, signal, context);
    signal.throwIfAborted();
    if (chat) bridge = await listenForOcr(onProgress ? chat.withProgress(onProgress) : chat, signal);
    const env = childEnvironment(home, bridge && chat ? { url: bridge.url, token: bridge.token, model: chat.id } : undefined);
    const out = join(home, "result.json");
    const args = ["review", "--repo", cwd, "--format", "json", "--output", out, "--audience", "agent", ...targetFlags];
    if (backgroundPath) args.push("--background-file", backgroundPath);
    if (!chat) args.push("--preview");
    else args.push("--concurrency", "1", "--effort", "low", "--timeout", "3", "--max-tokens-budget", "120000");
    onProgress?.({ activity: "Reviewing changes" });
    let exitError: NativeExitError | undefined;
    try { await execute(args, cwd, env, signal); }
    catch (e) {
      // OCR can publish a valid partial/failed manifest and *then* exit nonzero.
      if (!onProgress || !chat || signal.aborted || !(e instanceof NativeExitError)) throw e;
      exitError = e;
    }
    signal.throwIfAborted();
    onProgress?.({ activity: "Reading report" });
    try {
      if ((await stat(out)).size > 8 * MB) throw new Error("OCR report exceeds 8 MiB");
      const json = await readFile(out, { encoding: "utf8", signal });
      signal.throwIfAborted();
      const document = parseNativeDocument(json, bridge?.token);
      const report = chat ? summarizeReview(document) : summarizePreview(document);
      if (exitError && !["partial", "failed", "completed_with_errors"].includes(report.status)) throw exitError;
      return { ...report, document };
    } catch (e) {
      signal.throwIfAborted();
      throw exitError ?? e;
    }
  } finally {
    lifetime.abort();
    try { await bridge?.close(); } finally { await rm(home, { recursive: true, force: true }); }
  }
}

export interface Finding {
  path: string; content: string; start_line: number; end_line: number;
  severity?: string; category?: string; existing_code?: string; suggestion_code?: string;
}
export interface ReviewReport {
  status: string; message?: string; coverage?: Record<string, string[]>; comments: Finding[];
}
export type NativeResult = ReviewReport & { document: JsonObject };
type Entry = { path: string };
interface Report { status: string; comments: Finding[] | null; manifest?: { coverage: Record<string, Entry[]> }; message?: string }
function summarizeReview(r: Report): ReviewReport {
  if (typeof r.status !== "string" || (r.comments !== null && !Array.isArray(r.comments))) throw new Error("Unrecognized native OCR report");
  const raw = r.manifest?.coverage;
  const coverage = raw ? Object.fromEntries(Object.entries(raw).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.map(x => x.path)])) : undefined;
  const comments = (r.comments ?? []).map(({ path, start_line, end_line, content, severity, category, existing_code, suggestion_code }) =>
    ({ path, start_line, end_line, content, severity, category, existing_code, suggestion_code }));
  return { status: r.status, message: r.message, coverage, comments };
}
function summarizePreview(r: { files?: { path: string; will_review: boolean }[] | null; total_files: number }) {
  if (!Number.isInteger(r.total_files) || (r.total_files > 0 && !Array.isArray(r.files))) throw new Error("Unrecognized OCR preview");
  const files = r.files ?? [];
  return { status: "preview", message: "No model request made.", coverage: { selected: files.filter(x => x.will_review).map(x => x.path), excluded: files.filter(x => !x.will_review).map(x => x.path) } as Record<string, string[]>, comments: [] as Finding[] };
}
