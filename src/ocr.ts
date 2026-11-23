import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiChat } from "./pi-chat.ts";

const MB = 1024 * 1024;

export async function listenForOcr(chat: PiChat, signal: AbortSignal) {
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
      else reject(new Error(`ocr review (${code ?? killedBy}): ${stderr.trim() || "no diagnostic"}`));
    });
  });
}

export async function runNative(cwd: string, targetFlags: string[], chat: PiChat | undefined, cancel: AbortSignal) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([cancel, lifetime.signal, AbortSignal.timeout(5 * 60_000)]);
  const home = await mkdtemp(join(tmpdir(), "pi-ocr-"));
  let bridge: Awaited<ReturnType<typeof listenForOcr>> | undefined;
  try {
    if (chat) bridge = await listenForOcr(chat, signal);
    const env = childEnvironment(home, bridge && chat ? { url: bridge.url, token: bridge.token, model: chat.id } : undefined);
    const out = join(home, "result.json");
    const args = ["review", "--repo", cwd, "--format", "json", "--output", out, "--audience", "agent", ...targetFlags];
    if (!chat) args.push("--preview");
    else args.push("--concurrency", "1", "--effort", "low", "--timeout", "3", "--max-tokens-budget", "120000");
    await execute(args, cwd, env, signal);
    if ((await stat(out)).size > 8 * MB) throw new Error("OCR report exceeds 8 MiB");
    const result = JSON.parse(await readFile(out, "utf8"));
    return chat ? summarizeReview(result) : summarizePreview(result);
  } finally {
    lifetime.abort();
    try { await bridge?.close(); } finally { await rm(home, { recursive: true, force: true }); }
  }
}

type Finding = { path: string; content: string; start_line: number; end_line: number; severity?: string; category?: string };
type Entry = { path: string };
interface Report { status: string; comments: Finding[]; manifest?: { coverage: Record<string, Entry[]> }; message?: string }
function summarizeReview(r: Report) {
  if (typeof r.status !== "string" || !Array.isArray(r.comments)) throw new Error("Unrecognized native OCR report");
  const raw = r.manifest?.coverage;
  const coverage = raw ? Object.fromEntries(Object.entries(raw).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.map(x => x.path)])) : undefined;
  const comments = r.comments.map(({ path, start_line, end_line, content, severity, category }) => ({ path, start_line, end_line, content, severity, category }));
  return { status: r.status, message: r.message, coverage, comments };
}
function summarizePreview(r: { files?: { path: string; will_review: boolean }[] | null; total_files: number }) {
  if (!Number.isInteger(r.total_files) || (r.total_files > 0 && !Array.isArray(r.files))) throw new Error("Unrecognized OCR preview");
  const files = r.files ?? [];
  return { status: "preview", message: "No model request made.", coverage: { selected: files.filter(x => x.will_review).map(x => x.path), excluded: files.filter(x => !x.will_review).map(x => x.path) } as Record<string, string[]>, comments: [] as Finding[] };
}
