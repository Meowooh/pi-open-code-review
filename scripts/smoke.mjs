import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AFTER, BEFORE, BUG_LINE, COMMAND_ONLY, FINDING, MODELS, PATH, startFixtureProvider } from "./fixture-provider.mjs";

const extensionRoot = fileURLToPath(new URL("../", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixture-provider.mjs", import.meta.url));
const evidenceTools = ["file_read", "file_read_diff", "code_search", "file_find"];
const fixtureTools = ["file_read", "code_comment", "task_done", "approve_all_comments"];
const contract = "pricing-cases.md";
const caseId = "SUBTOTAL-417";
const usage = "Usage: node scripts/smoke.mjs [--live <author-provider/id> <review-provider/id>]";

class SmokeError extends Error {}
function expect(condition, message) {
  if (!condition) throw new SmokeError(message);
}

function run(binary, args, { cwd, env, signal: interrupted }, timeout = 15_000) {
  const signal = AbortSignal.any([interrupted, AbortSignal.timeout(timeout)]);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const posix = process.platform !== "win32";
    const child = spawn(binary, args, { cwd, env, detached: posix, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "", failure, force;
    const kill = (sig) => {
      if (!child.pid) return;
      try {
        if (posix) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (error) {
        if (error.code !== "ESRCH") child.kill(sig);
      }
    };
    const stop = (message) => {
      if (failure) return;
      failure = new SmokeError(message);
      kill("SIGTERM");
      force = setTimeout(() => kill("SIGKILL"), 3_000);
    };
    const abort = () => stop(interrupted.aborted ? "Interrupted" : `${binary} timed out`);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (piece) => {
      if (failure) return;
      stdout += piece;
      if (stdout.length > 2 ** 21) stop(`${binary} output exceeded the size limit`);
    });
    child.on("error", (error) => { failure ??= new SmokeError(`Could not start ${binary} (${error.code ?? "spawn error"})`); });
    child.on("close", (code, killedBy) => {
      signal.removeEventListener("abort", abort);
      clearTimeout(force);
      if (failure) {
        kill("SIGKILL");
        reject(failure);
      } else if (code !== 0) reject(new SmokeError(`${binary} exited with ${code ?? killedBy} (raw diagnostics suppressed)`));
      else resolve(stdout);
    });
  });
}

const only = (xs, value) => Array.isArray(xs) && xs.length === 1 && xs[0] === value;
const countMap = (map) => map && typeof map === "object" && !Array.isArray(map)
  && Object.entries(map).every(([key, n]) => /^[a-z][a-z0-9_]{0,63}$/.test(key) && Number.isSafeInteger(n) && n > 0);

function evidence(stdout, author, reviewer, exchanges) {
  const reports = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { throw new SmokeError("Pi stdout was not JSONL"); }
    expect(event?.type !== "agent_start", "Pi ran an ordinary session-agent turn");
    if (event?.type === "message_end" && event.message?.customType === "open-code-review") reports.push(event.message.details);
  }
  expect(reports.length === 1 && reports[0], "Expected one open-code-review message_end with details");
  const { status, selectedModel, sessionModelBefore, sessionModelAfter, coverage, comments, bridge } = reports[0];
  expect(selectedModel === reviewer, "Review selected the wrong model");
  expect(sessionModelBefore === author && sessionModelAfter === author, "Session did not retain the author model");
  expect(status === "complete", "Native OCR status was not complete");
  expect(only(coverage?.selected, PATH) && only(coverage.completed, PATH), `Native OCR did not select and complete only ${PATH}`);
  const finding = Array.isArray(comments) && comments.find((c) => c?.path === PATH
    && Number.isInteger(c.start_line) && c.start_line > 0 && c.start_line <= BUG_LINE
    && Number.isInteger(c.end_line) && c.end_line >= BUG_LINE
    && typeof c.content === "string" && c.content.trim()
    && (!exchanges || (c.start_line === BUG_LINE && c.end_line === BUG_LINE && c.content.includes(FINDING))));
  expect(finding, `No OCR finding at ${PATH}:${BUG_LINE}`);

  expect(Number.isSafeInteger(bridge?.requests) && bridge.requests > 0 && only(bridge.answeredBy, reviewer),
    "Bridge did not report requests answered by the review model");
  const { requests, answeredBy, toolCalls, toolResults } = bridge;
  expect(countMap(toolCalls) && countMap(toolResults), "Bridge did not report native tool counters");
  const roundtrips = evidenceTools.filter((tool) => toolCalls[tool] > 0 && toolResults[tool] > 0);
  expect(roundtrips.length > 0, `No native evidence-tool roundtrip (observed calls: ${Object.keys(toolCalls).join(", ")}; results: ${Object.keys(toolResults).join(", ")})`);
  if (!exchanges) {
    expect(roundtrips.includes("file_read"), "Live model did not receive a native file_read result");
    expect(finding.content.includes(caseId) || /\b822\b/.test(finding.content), "Finding did not cite evidence from the unchanged pricing case");
  }
  let fixture;
  if (exchanges) {
    const models = [...new Set(exchanges.map((r) => r.model))];
    const responses = exchanges.flatMap((r) => r.tool ? [r.tool] : []);
    expect(exchanges.length === requests && only(models, reviewer.slice("fixture/".length)),
      "Fixture server observed a different physical model or request count");
    expect(fixtureTools.every((tool) => responses.includes(tool) && toolCalls[tool] > 0),
      "Fixture did not complete the native review and default filter rounds");
    const verifiedFileRead = exchanges.some((r) => r.verifiedFileRead);
    expect(verifiedFileRead && roundtrips.includes("file_read") && toolResults.code_comment > 0
      && exchanges.some((r) => r.verifiedCodeComment), "Fixture did not verify the native file_read and code_comment results");
    fixture = { requests: exchanges.length, models, responses, verifiedFileRead };
  }
  const { path, start_line, end_line } = finding;
  return { status, selectedModel, sessionModelBefore, sessionModelAfter,
    coverage: { selected: coverage.selected, completed: coverage.completed }, finding: { path, start_line, end_line, ...(!exchanges && { content: finding.content.slice(0, 650) }) },
    bridge: { requests, answeredBy, toolCalls, toolResults }, roundtrips, fixture };
}

async function review(label, author, reviewer, command, options, fixture) {
  const args = ["--offline", "--no-session", "--no-extensions", "--no-tools", "--no-context-files", "--no-skills",
    "--no-prompt-templates", "--no-approve", "-e", extensionRoot, "--mode", "json", "--model", author];
  const live = !fixture;
  if (live) args.push("-e", fixturePath, `--${COMMAND_ONLY}=true`, "--thinking", "low");
  const offset = fixture?.requests.length;
  const newRequests = () => fixture?.requests.slice(offset);
  const fixtureError = () => newRequests()?.find((r) => r.error)?.error;
  try {
    const stdout = await run("pi", [...args, command], options, live ? 360_000 : 60_000);
    const error = fixtureError();
    expect(!error, error);
    console.log(JSON.stringify({ run: label, ...evidence(stdout, author, reviewer, newRequests()) }));
  } catch (error) {
    const reason = fixtureError() ?? (error instanceof SmokeError ? error.message : "Unexpected review error");
    throw new SmokeError(`${label}: ${reason}`);
  }
}

async function main(args) {
  if (only(args, "--help") || only(args, "-h")) return console.log(usage);
  const live = args[0] === "--live";
  const qualified = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.:/@+-]*$/i;
  expect(!args.length || (live && args.length === 3 && args.slice(1).every((arg) => qualified.test(arg))), usage);

  const interrupt = new AbortController();
  const stop = () => interrupt.abort(new SmokeError("Interrupted"));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let root, fixture;
  try {
    root = await mkdtemp(join(await realpath(tmpdir()), "pi-ocr-smoke-"));
    const cwd = join(root, "repo"), home = join(root, "home"), agentDir = join(home, ".pi", "agent");
    await mkdir(cwd, { mode: 0o700 });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const commonEnv = {
      PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), TMPDIR: root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0",
      OCR_NO_UPDATE: "1", OCR_ENABLE_TELEMETRY: "0", OCR_RAW_LOGGING: "0",
    };
    const clean = { cwd, signal: interrupt.signal, env: { ...commonEnv, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"),
      PI_CODING_AGENT_DIR: agentDir, LC_ALL: "C" } };
    expect((await run("pi", ["--offline", "--version"], clean)).trim() === "1.6.0", "Expected installed Pi 1.6.0");
    expect(/^open-code-review v1\.14\.2(?:\s|$)/.test(await run("ocr", ["--version"], clean)), "Expected installed OCR v1.14.2");
    const git = (...args) => run("git", args, clean);
    await git("init", "-q", "--template=", "-b", "main");
    await writeFile(join(cwd, PATH), BEFORE);
    await git("add", "--", PATH);
    if (live) {
      // OCR initially shows the entire diff. Give this smoke test an actual reason
      // to read unchanged context; do not alter the extension or its prompts.
      await writeFile(join(cwd, contract), `# Accepted pricing cases\n\n${caseId}: If a unit costs 137 cents and six units are ordered, the subtotal must be 822 cents.\n`);
      await mkdir(join(cwd, ".opencodereview"));
      await writeFile(join(cwd, ".opencodereview/rule.json"), JSON.stringify({ rules: [{
        path: PATH, merge_system_rule: true,
        rule: `For a subtotal change you must use file_read to look up the approved example in ${contract} before deciding whether this change is correct. If the new implementation violates the example, include its case ID, actual result and expected result in your finding.`,
      }] }));
      await git("add", "--", contract, ".opencodereview/rule.json");
    }
    await git("-c", "user.name=OCR Smoke", "-c", "user.email=ocr-smoke@example.invalid",
      "commit", "-q", "--no-gpg-sign", "-m", "Seed pricing fixture");
    await writeFile(join(cwd, PATH), AFTER);
    expect(await git("status", "--porcelain") === ` M ${PATH}\n`, "Fixture is not a single unstaged change");

    if (live) {
      const [, author, reviewer] = args;
      expect(author !== reviewer, "Use different author and review model IDs to verify the override");
      const env = { ...process.env, ...commonEnv };
      for (const key of Object.keys(process.env)) {
        if (/^(?:GIT_|OCR_)/.test(key) && !Object.hasOwn(commonEnv, key)) delete env[key];
      }
      await review("live", author, reviewer, `/open-code-review --model ${reviewer}`, { ...clean, env });
    } else {
      fixture = await startFixtureProvider();
      const writeConfig = (name, value) => writeFile(join(agentDir, name), JSON.stringify(value), { mode: 0o600 });
      const [author, reviewer] = MODELS.map((id) => `fixture/${id}`);
      await writeConfig("models.json", { providers: { fixture: {
        baseUrl: fixture.baseUrl, apiKey: fixture.apiKey, api: "openai-completions", models: MODELS.map((id) => ({ id })),
      } } });
      await writeConfig("open-code-review.json", { defaultModel: "current", aliases: { review: reviewer } });
      // An existing OCR provider wins over OCR_LLM_* if the child HOME leaks.
      const ocrDir = join(home, ".opencodereview");
      await mkdir(ocrDir, { recursive: true });
      const oldConfig = JSON.stringify({ provider: "openai", providers: { openai: {
        url: "http://127.0.0.1:1/v1", api_key: "fixture-only", model: "must-not-be-used",
      } } });
      const oldPath = join(ocrDir, "config.json");
      await writeFile(oldPath, oldConfig, { mode: 0o600 });
      await review("default", author, author, "/open-code-review", clean, fixture);
      await review("alias", author, reviewer, "/open-code-review --model @review", clean, fixture);
      expect(await readFile(oldPath, "utf8") === oldConfig, "Existing OCR provider config was changed");
    }
  } finally {
    try {
      try { await fixture?.close(); } finally { if (root) await rm(root, { recursive: true, force: true }); }
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`Smoke failed: ${error instanceof SmokeError ? error.message : "setup or cleanup error (raw diagnostics suppressed)"}`);
  process.exitCode = 1;
}
