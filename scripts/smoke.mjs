import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AFTER, AGENT_CASE, BEFORE, BUG_LINE, FINDING, MODELS, PATH, startFixtureProvider } from "./fixture-provider.mjs";

const extensionRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureTools = ["file_read", "code_comment", "task_done", "approve_all_comments"];
const usage = "Usage: npm run smoke";

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

function readEvents(stdout) {
  return stdout.split("\n").filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line); } catch { throw new SmokeError("Pi stdout was not JSONL"); }
  });
}

const endMessages = (events) => events.filter((event) => event?.type === "message_end").map((event) => event.message);
const fixtureModel = (model) => model.slice("fixture/".length);

function fixtureEvidence(exchanges, reviewer) {
  const models = [...new Set(exchanges.map((r) => r.model))];
  const responses = exchanges.flatMap((r) => r.tool ? [r.tool] : []);
  expect(only(models, fixtureModel(reviewer)), "Fixture server observed the wrong physical review model");
  expect(fixtureTools.every((tool) => responses.includes(tool)),
    "Fixture did not complete the native review and default filter rounds");
  const verifiedFileRead = exchanges.some((r) => r.verifiedFileRead);
  expect(verifiedFileRead && exchanges.some((r) => r.verifiedCodeComment),
    "Fixture did not verify the native file_read and code_comment results");
  return { requests: exchanges.length, models, responses, verifiedFileRead };
}

function directEvidence(stdout, author, reviewer, exchanges) {
  const events = readEvents(stdout);
  const messages = endMessages(events);
  expect(!events.some((e) => ["agent_start", "turn_start", "tool_execution_start", "tool_execution_end"].includes(e?.type))
    && !messages.some((m) => m?.role === "assistant" || m?.role === "toolResult"),
    "Pi ran a session-agent turn or tool loop for a direct command");
  const reports = messages.filter((m) => m?.customType === "open-code-review").map((m) => m.details);
  expect(reports.length === 1 && reports[0], "Expected one open-code-review message_end with details");
  const { status, selectedModel, sessionModelBefore, sessionModelAfter, coverage, comments, bridge } = reports[0];
  expect(selectedModel === reviewer, "Review selected the wrong model");
  expect(sessionModelBefore === author && sessionModelAfter === author, "Session did not retain the author model");
  expect(status === "complete", "Native OCR status was not complete");
  expect(only(coverage?.selected, PATH) && only(coverage.completed, PATH), `Native OCR did not select and complete only ${PATH}`);
  const finding = Array.isArray(comments) && comments.find((c) => c?.path === PATH
    && c.start_line === BUG_LINE && c.end_line === BUG_LINE
    && typeof c.content === "string" && c.content.includes(FINDING));
  expect(finding, `No OCR finding at ${PATH}:${BUG_LINE}`);

  expect(Number.isSafeInteger(bridge?.requests) && bridge.requests > 0 && only(bridge.answeredBy, reviewer),
    "Bridge did not report requests answered by the review model");
  const { requests, answeredBy, toolCalls, toolResults } = bridge;
  expect(countMap(toolCalls) && countMap(toolResults), "Bridge did not report native tool counters");
  const fixture = fixtureEvidence(exchanges, reviewer);
  expect(fixture.requests === requests, "Bridge and fixture disagree on the number of review requests");
  expect(fixtureTools.every((tool) => toolCalls[tool] > 0), "Bridge did not observe all native review and filter tool calls");
  expect(toolResults.file_read > 0 && toolResults.code_comment > 0,
    "Bridge did not observe the native file_read and code_comment results");
  const { path, start_line, end_line } = finding;
  return { status, selectedModel, sessionModelBefore, sessionModelAfter,
    coverage: { selected: coverage.selected, completed: coverage.completed }, finding: { path, start_line, end_line },
    bridge: { requests, answeredBy, toolCalls, toolResults }, fixture };
}

function agentEvidence(stdout, author, reviewer, exchanges) {
  const events = readEvents(stdout);
  const messages = endMessages(events);
  const eventType = (type) => events.filter((event) => event?.type === type);
  expect(eventType("agent_start").length === 1 && eventType("agent_end").length === 1, "Expected one completed author agent loop");
  // In JSON mode the command handler starts the turn with this entry. A raw slash-command fallthrough
  // would have role "user" instead. Assert that the recorded message contains only user-authored text.
  const inputs = messages.filter((m) => m?.role === "user" || m?.customType === "open-code-review-request");
  expect(inputs.length === 1 && inputs[0].customType === "open-code-review-request"
    && inputs[0].content === AGENT_CASE.command && inputs[0].display === true, "Incorrect visible review request");
  expect(!messages.some((m) => m?.customType === "open-code-review"),
    "Agent tool emitted a duplicate open-code-review completion message");

  const turns = messages.filter((m) => m?.role === "assistant");
  expect(turns.length === 2 && turns.every((m) => `${m.provider}/${m.model}` === author),
    "Expected a tool call and a final reply from the author model");
  const [firstTurn, finalTurn] = turns;
  const calls = turns.flatMap((m) => m.content.filter((part) => part.type === "toolCall"));
  const [call] = calls;
  expect(calls.length === 1 && firstTurn.content.includes(call) && call.name === AGENT_CASE.tool,
    "Expected exactly one author tool call to ocr_review");
  const input = call.arguments;
  expect(input?.model === AGENT_CASE.args.model && input.background === AGENT_CASE.args.background
    && ["commit", "from", "to"].every((key) => !Object.hasOwn(input, key)),
    "Author tool call did not use workspace scope, the expected model alias and background");
  const results = messages.filter((m) => m?.role === "toolResult");
  expect(results.length === 1 && results[0].toolCallId === call.id && results[0].toolName === call.name && results[0].isError === false,
    "Expected exactly one successful result for the author tool call");
  for (const type of ["tool_execution_start", "tool_execution_end"]) {
    const executions = eventType(type);
    expect(executions.length === 1 && executions[0].toolCallId === call.id && executions[0].toolName === call.name,
      "Pi did not execute the author tool exactly once");
  }
  const finalText = finalTurn.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  expect(finalTurn.stopReason === "stop" && finalText === AGENT_CASE.reply, "Author did not finish with the expected review summary");

  const first = exchanges[0], last = exchanges.at(-1);
  expect(first?.model === fixtureModel(author) && first.tool === AGENT_CASE.tool && first.verifiedIntent
    && last?.model === fixtureModel(author) && last.verifiedReviewResult && !last.tool,
    "Expected the author to see the intent, call the tool and receive the native report");
  const reviewExchanges = exchanges.slice(1, -1);
  const native = fixtureEvidence(reviewExchanges, reviewer);
  expect(native.responses.length === fixtureTools.length, "Expected one set of native reviewer tool calls");
  const verifiedBackground = reviewExchanges.some((r) => r.verifiedBackground);
  expect(verifiedBackground, "Fixture did not verify the background in the native reviewer prompt");
  return {
    status: "complete",
    author: { model: author, requests: 2, tool: call.name, toolCalls: calls.length, toolResults: results.length, finalText },
    reviewer: { model: reviewer, ...native, verifiedBackground },
    finding: { path: PATH, start_line: BUG_LINE, end_line: BUG_LINE },
  };
}

async function review(label, author, reviewer, command, options, fixture, { agent = false } = {}) {
  const args = ["--offline", "--no-session", "--no-extensions", "--no-tools", "--no-context-files", "--no-skills",
    "--no-prompt-templates", "--no-approve", "-e", extensionRoot, "--mode", "json", "--model", author];
  if (agent) args.push("--tools", AGENT_CASE.tool);
  const offset = fixture.requests.length;
  const newRequests = () => fixture.requests.slice(offset);
  const fixtureError = () => newRequests().find((r) => r.error)?.error;
  try {
    const stdout = await run("pi", [...args, command], options, 60_000);
    const error = fixtureError();
    expect(!error, error);
    const evidence = agent ? agentEvidence : directEvidence;
    console.log(JSON.stringify({ run: label, ...evidence(stdout, author, reviewer, newRequests()) }));
  } catch (error) {
    const reason = fixtureError() ?? (error instanceof SmokeError ? error.message : "Unexpected review error");
    throw new SmokeError(`${label}: ${reason}`);
  }
}

async function main(args) {
  if (only(args, "--help") || only(args, "-h")) return console.log(usage);
  expect(args.length === 0, `Unexpected arguments. ${usage}`);

  const interrupt = new AbortController();
  const stop = () => interrupt.abort(new SmokeError("Interrupted"));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let root;
  try {
    root = await mkdtemp(join(await realpath(tmpdir()), "pi-ocr-smoke-"));
    const cwd = join(root, "repo"), home = join(root, "home"), agentDir = join(home, ".pi", "agent");
    await mkdir(cwd, { mode: 0o700 });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const clean = {
      cwd, signal: interrupt.signal, env: {
        PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), TMPDIR: root,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0",
        OCR_NO_UPDATE: "1", OCR_ENABLE_TELEMETRY: "0", OCR_RAW_LOGGING: "0",
        HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"),
        PI_CODING_AGENT_DIR: agentDir, LC_ALL: "C",
      },
    };
    expect((await run("pi", ["--offline", "--version"], clean)).trim() === "1.6.0", "Expected installed Pi 1.6.0");
    expect(/^open-code-review v1\.14\.2(?:\s|$)/.test(await run("ocr", ["--version"], clean)), "Expected installed OCR v1.14.2");
    const git = (...args) => run("git", args, clean);
    await git("init", "-q", "--template=", "-b", "main");
    await writeFile(join(cwd, PATH), BEFORE);
    await git("add", "--", PATH);
    await git("-c", "user.name=OCR Smoke", "-c", "user.email=ocr-smoke@example.invalid",
      "commit", "-q", "--no-gpg-sign", "-m", "Seed pricing fixture");
    await writeFile(join(cwd, PATH), AFTER);
    expect(await git("status", "--porcelain") === ` M ${PATH}\n`, "Fixture is not a single unstaged change");

    const writeConfig = (name, value) => writeFile(join(agentDir, name), JSON.stringify(value), { mode: 0o600 });
    const withFixture = async (config, action) => {
      const fixture = await startFixtureProvider(config);
      try {
        await writeConfig("models.json", { providers: { fixture: {
          baseUrl: fixture.baseUrl, apiKey: fixture.apiKey, api: "openai-completions", models: MODELS.map((id) => ({ id })),
        } } });
        await action(fixture);
      } finally { await fixture.close(); }
    };
    const [author, reviewer] = MODELS.map((id) => `fixture/${id}`);
    await writeConfig("open-code-review.json", { defaultModel: "current", aliases: { review: reviewer } });
    // An existing OCR provider wins over OCR_LLM_* if the child HOME leaks.
    const ocrDir = join(home, ".opencodereview");
    await mkdir(ocrDir, { recursive: true });
    const oldConfig = JSON.stringify({ provider: "openai", providers: { openai: {
      url: "http://127.0.0.1:1/v1", api_key: "fixture-only", model: "must-not-be-used",
    } } });
    const oldPath = join(ocrDir, "config.json");
    await writeFile(oldPath, oldConfig, { mode: 0o600 });
    await withFixture({}, async (fixture) => {
      await review("default", author, author, "/ocr-review", clean, fixture);
      await review("alias", author, reviewer, "/ocr-review --model @review", clean, fixture);
    });
    // Keep author tool history and model activity separate from the direct review cases.
    await withFixture({ agent: true }, (fixture) =>
      review("agent-tool", author, reviewer, AGENT_CASE.command, clean, fixture, { agent: true }));
    expect(await readFile(oldPath, "utf8") === oldConfig, "Existing OCR provider config was changed");
  } finally {
    try {
      if (root) await rm(root, { recursive: true, force: true });
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
