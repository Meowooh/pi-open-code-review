import fs from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";

const CONFIG_FILE = "open-code-review.json";
const MODEL_FLAG = "--model";

type ReviewConfig = { defaultModel: string; aliases: Map<string, string> };

export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelRef(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1;
}

async function readConfig(): Promise<ReviewConfig> {
	const aliases = new Map<string, string>();
	let text: string;
	try {
		text = await fs.readFile(join(getAgentDir(), CONFIG_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { defaultModel: "current", aliases };
		throw new Error(`Could not read ${CONFIG_FILE} in the Pi agent directory.`);
	}

	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch {
		throw new Error(`Invalid JSON in ${CONFIG_FILE}.`);
	}
	if (!isRecord(config)) throw new Error(`${CONFIG_FILE} must contain a JSON object.`);

	const defaultModel = config.defaultModel === undefined ? "current" : config.defaultModel;
	if (
		typeof defaultModel !== "string" ||
		(defaultModel !== "current" && !/^@.+$/.test(defaultModel) && !isModelRef(defaultModel))
	) {
		throw new Error(`${CONFIG_FILE}: defaultModel must be current, @alias, or provider/id.`);
	}
	if (config.aliases !== undefined) {
		const message = `${CONFIG_FILE}: aliases must map names to exact provider/id references.`;
		if (!isRecord(config.aliases)) throw new Error(message);
		for (const [name, ref] of Object.entries(config.aliases)) {
			if (!name || !isModelRef(ref)) throw new Error(message);
			aliases.set(name, ref);
		}
	}
	return { defaultModel, aliases };
}

function findExact(registry: ExtensionContext["modelRegistry"], ref: string): Model<Api> | undefined {
	if (!isModelRef(ref)) return undefined;
	const slash = ref.indexOf("/");
	return registry.find(ref.slice(0, slash), ref.slice(slash + 1));
}

function candidates(ctx: ExtensionContext): Model<Api>[] {
	const scoped = ctx.scopedModels;
	return scoped.length ? scoped.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
}

function fuzzyModels(models: Model<Api>[], query: string): Model<Api>[] {
	// fuzzyFilter treats slash-only input as an empty query.
	if (query && !/[^/\s]/.test(query)) return [];
	return fuzzyFilter(models, query, (model) => `${modelKey(model)} ${model.name}`);
}

async function pickModel(ctx: ExtensionCommandContext, models: Model<Api>[]): Promise<Model<Api> | undefined> {
	if (!models.length) throw new Error("No review models are available to pick.");
	const keys = models.map(modelKey);
	const choice = await ctx.ui.select("Select a review model", keys);
	if (choice === undefined) return undefined;
	const model = models[keys.indexOf(choice)];
	if (!model) throw new Error("The review model picker returned an unknown choice.");
	return model;
}

export async function selectReviewModel(ctx: ExtensionCommandContext, query: string | undefined): Promise<Model<Api> | undefined> {
	let ref = query?.trim();
	let config: ReviewConfig | undefined;
	if (ref === undefined || ref.startsWith("@")) {
		config = await readConfig();
		ref ??= config.defaultModel;
	}
	if (ref === "current") {
		const current = ctx.model;
		if (!current) throw new Error("No current Pi model is set; specify --model <provider/id>.");
		return current;
	}
	if (ref.startsWith("@") || query === undefined) {
		const origin = query === undefined ? `${CONFIG_FILE}: defaultModel` : `Review model alias in ${CONFIG_FILE}`;
		const target = ref.startsWith("@") ? config?.aliases.get(ref.slice(1)) : ref;
		if (target === undefined) throw new Error(`${origin}: unknown alias.`);
		const model = findExact(ctx.modelRegistry, target);
		if (!model) throw new Error(`${origin} does not resolve to an exact registered provider/id.`);
		return model;
	}
	if (query === "") {
		if (ctx.mode !== "tui") throw new Error("The review model picker requires TUI mode; specify --model <query>.");
		return pickModel(ctx, candidates(ctx));
	}

	if (!ref) throw new Error("No review models match --model.");
	// A qualified reference can select an exact catalog model outside the discovery scope.
	const exact = findExact(ctx.modelRegistry, ref);
	if (exact) return exact;
	if (isModelRef(ref)) throw new Error(`Unknown provider/id: ${ref}. Use a bare query for fuzzy search.`);
	const models = candidates(ctx);
	const exactIds = models.filter((model) => model.id === ref);
	const matches = exactIds.length ? exactIds : fuzzyModels(models, ref);
	if (!matches.length) throw new Error("No review models match --model.");
	if (matches.length === 1) return matches[0]!;
	if (ctx.mode !== "tui") {
		throw new Error(`Ambiguous --model; specify one of: ${matches.map(modelKey).join(", ")}.`);
	}
	return pickModel(ctx, matches);
}

export async function modelCompletions(ctx: ExtensionContext, prefix: string): Promise<AutocompleteItem[] | null> {
	const args = prefix.trimStart();
	if (MODEL_FLAG.startsWith(args)) {
		return [{ value: `${MODEL_FLAG} `, label: MODEL_FLAG, description: "Select a review model" }];
	}
	const match = /^(.*?)(?:^|\s)--model(?:\s+|=)([^-].*|)$/.exec(args);
	if (!match || /\s--/.test(match[2])) return null;
	const preceding = match[1] ? `${match[1]} ` : "";
	const query = match[2]?.trim() ?? "";
	const items: AutocompleteItem[] = [];
	const add = (ref: string, description: string) => items.push({ value: `${preceding}${MODEL_FLAG} ${ref}`, label: ref, description });

	if ("current".startsWith(query) && ctx.model) add("current", "Use the current Pi model");
	const aliasOnly = query.startsWith("@");
	const models = aliasOnly ? [] : candidates(ctx);
	const registry = ctx.modelRegistry;
	// Keep completion working if the config is broken; selection reports the error.
	const config = await readConfig().catch(() => undefined);
	const aliasPrefix = aliasOnly ? query.slice(1) : query;
	for (const [name, target] of config?.aliases ?? []) {
		if (name.startsWith(aliasPrefix) && findExact(registry, target)) add(`@${name}`, target);
	}
	for (const model of fuzzyModels(models, query)) add(modelKey(model), model.name);
	return items.length ? items : null;
}
