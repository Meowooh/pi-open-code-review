import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { modelCompletions, modelKey, selectReviewModel } from "../src/select-model.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		provider, id, name: id, api: "openai-completions", baseUrl: "https://example.invalid",
		input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const sonnet = model("anthropic", "claude-sonnet");
const sonnetLatest = model("anthropic", "claude-sonnet-latest");
const router = model("openrouter", "anthropic/claude-sonnet");

function context({
	current = sonnet,
	mode = "print",
	scoped = [],
	available = [sonnet, sonnetLatest, router],
	choose = () => assert.fail("The picker should not open"),
}: {
	current?: Model<Api> | null;
	mode?: ExtensionCommandContext["mode"];
	scoped?: Model<Api>[];
	available?: Model<Api>[];
	choose?: (keys: string[]) => string | undefined;
} = {}): ExtensionCommandContext {
	return {
		model: current ?? undefined,
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		scopedModels: scoped.map((model) => ({ model })),
		modelRegistry: {
			getAvailable: () => available,
			find: (provider: string, id: string) => available.find((m) => m.provider === provider && m.id === id),
		},
		ui: { select: async (_: string, keys: string[]) => choose(keys) },
	} as unknown as ExtensionCommandContext;
}

function mockConfig(t: TestContext, contents?: string): void {
	const filename = join(getAgentDir(), "open-code-review.json");
	t.mock.method(fs, "readFile", async (path: string, encoding: string) => {
		assert.equal(path, filename);
		assert.equal(encoding, "utf8");
		if (contents === undefined) throw Object.assign(new Error("Config absent"), { code: "ENOENT" });
		return contents;
	});
}

test("uses the current model for an omitted default or an explicit current", async (t) => {
	mockConfig(t);
	const ctx = context();
	assert.equal(await selectReviewModel(ctx, undefined), sonnet);
	assert.equal(await selectReviewModel(ctx, "current"), sonnet);
	await assert.rejects(selectReviewModel(context({ current: null }), "current"), /No current Pi model/);
	for (const query of [" ", "/", "zzzzz"]) {
		await assert.rejects(selectReviewModel(ctx, query), /No review models match/);
	}
});

test("defaults and aliases resolve an exact reference with slashes in the model ID", async (t) => {
	mockConfig(t, JSON.stringify({ defaultModel: "@review", aliases: { review: modelKey(router) } }));
	const ctx = context({ scoped: [sonnet] });
	assert.equal(modelKey(router), "openrouter/anthropic/claude-sonnet");
	assert.equal(await selectReviewModel(ctx, undefined), router);
	assert.equal(await selectReviewModel(ctx, "@review"), router);
	await assert.rejects(selectReviewModel(ctx, "@toString"), /unknown alias/);
	assert.equal(ctx.model, sonnet);
});

test("an invalid configured reference never falls back to a proxy, fuzzy match, or current", async (t) => {
	mockConfig(t, JSON.stringify({
		defaultModel: "anthropic/claude-sonnet",
		aliases: { partial: "anthropic/claude-son" },
	}));
	const ctx = context({ available: [router, sonnetLatest] });
	await assert.rejects(selectReviewModel(ctx, undefined), /defaultModel.*exact registered provider\/id/);
	await assert.rejects(selectReviewModel(ctx, "@partial"), /alias.*exact registered provider\/id/);
	await assert.rejects(selectReviewModel(ctx, "anthropic/claude-sonnet"), /Unknown provider\/id/);
});

test("invalid JSON is reported without echoing its contents; exact CLI lookup still works", async (t) => {
	mockConfig(t, '{"defaultModel": "secret-marker", invalid}');
	await assert.rejects(selectReviewModel(context(), undefined), (error: Error) => {
		assert.match(error.message, /Invalid JSON in open-code-review\.json/);
		assert.doesNotMatch(error.message, /secret-marker/);
		return true;
	});
	assert.equal(await selectReviewModel(context(), modelKey(sonnet)), sonnet);
});

test("matches exact CLI IDs first, then fuzzy searches the scoped or available list", async () => {
	assert.equal(await selectReviewModel(context(), "claude-sonnet"), sonnet);
	assert.equal(await selectReviewModel(context({ scoped: [router] }), modelKey(sonnet)), sonnet);
	assert.equal(await selectReviewModel(context({ scoped: [router] }), "cld-snt"), router);
	assert.equal(await selectReviewModel(context({ available: [sonnetLatest] }), "cld-snt"), sonnetLatest);
});

test("ambiguous CLI matches list candidates outside TUI and prompt in ranked order in TUI", async () => {
	const exactDuplicate = model("mirror", sonnet.id);
	const available = [sonnet, sonnetLatest, exactDuplicate];
	await assert.rejects(selectReviewModel(context({ mode: "rpc", available }), sonnet.id), {
		message: `Ambiguous --model; specify one of: ${modelKey(sonnet)}, ${modelKey(exactDuplicate)}.`,
	});

	const datedSonnet = model("anthropic", "dated-claude-sonnet");
	const ctx = context({
		mode: "tui", available: [datedSonnet, sonnet],
		choose: (keys) => {
			assert.deepEqual(keys, [modelKey(sonnet), modelKey(datedSonnet)]);
			return modelKey(datedSonnet);
		},
	});
	assert.equal(await selectReviewModel(ctx, "claude-son"), datedSonnet);
});

test("an empty argument opens the picker only in TUI; cancellation alone returns undefined", async () => {
	await assert.rejects(selectReviewModel(context({ mode: "rpc" }), ""), /requires TUI/);
	await assert.rejects(selectReviewModel(context({ mode: "tui", available: [] }), ""), /No review models/);
	const ctx = context({
		mode: "tui", scoped: [router], choose: (keys) => {
			assert.deepEqual(keys, [modelKey(router)]);
			return undefined;
		},
	});
	assert.equal(await selectReviewModel(ctx, ""), undefined);
});

test("Pi replaces the full argument prefix for flag and candidate completions", async (t) => {
	mockConfig(t, JSON.stringify({ aliases: { review: modelKey(router) } }));
	const ctx = context({ scoped: [sonnet] });
	const autocomplete = new CombinedAutocompleteProvider([
		{ name: "review", getArgumentCompletions: (prefix) => modelCompletions(ctx, prefix) },
	], "/", null);
	for (const [line, output] of [
		["/review --mo", "/review --model "],
		["/review --model cld-snt", `/review --model ${modelKey(sonnet)}`],
		["/review --model rev", "/review --model @review"],
		["/review --model cur", "/review --model current"],
		["/review --from main --model cld-snt", `/review --from main --model ${modelKey(sonnet)}`],
	]) {
		const suggestions = await autocomplete.getSuggestions([line!], 0, line!.length, { signal: new AbortController().signal });
		assert.ok(suggestions?.items[0]);
		assert.deepEqual(autocomplete.applyCompletion([line!], 0, line!.length, suggestions.items[0], suggestions.prefix).lines, [output]);
	}
	assert.equal((await modelCompletions(ctx, "--model @rev"))?.[0]?.value, "--model @review");
	assert.equal((await modelCompletions(ctx, "--model=cld-snt"))?.[0]?.value, `--model ${modelKey(sonnet)}`);
	assert.equal(await modelCompletions(ctx, "--unknown"), null);
});
