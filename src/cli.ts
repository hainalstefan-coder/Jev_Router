#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchAfterRouterConfirmation } from "./approval.js";
import { buildCandidateMetadata, ensureFreshBenchmarks, getBenchmarkStatuses, refreshBenchmarkCache } from "./benchmarks.js";
import { getCacheDirectory, readJson, writePrivateJson } from "./cache.js";
import { executeCandidate } from "./execution.js";
import { discoverModels, flattenCandidates } from "./providers.js";
import { selectCandidate } from "./router.js";
import type { BenchmarkStatus, CatalogCache, ModelCandidate, ProviderName } from "./types.js";

type CliCommand = "doctor" | "models" | "route" | "run" | "help";
interface ParsedArgs {
  command: CliCommand;
  task?: string;
  provider?: ProviderName;
  model?: string;
  yes?: boolean;
  subcommand?: string;
}

function usage(): string {
  return [
    "Jev Task Router",
    "",
    "Usage:",
    "  jev doctor",
    "  jev models refresh",
    "  jev route [--provider codex|copilot] <task>",
    "  jev run [--yes] [--provider codex|copilot] [--model <id>] <task>",
    "",
    "Jev recommends from your currently eligible local provider models. Run dispatches through Codex or Copilot with their local sign-in and permission controls.",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const first = argv[0];
  if (!first || first === "--help" || first === "-h" || first === "help") return { command: "help" };
  if (first === "doctor") {
    if (argv.length > 1) throw new Error("`jev doctor` does not accept additional arguments.");
    return { command: "doctor" };
  }
  if (first === "models") {
    if (argv[1] !== "refresh" || argv.length > 2) throw new Error("Use `jev models refresh`.");
    return { command: "models", subcommand: "refresh" };
  }
  if (first !== "route" && first !== "run") throw new Error(`Unknown command: ${first}.\n\n${usage()}`);

  let yes = false;
  let provider: ProviderName | undefined;
  let model: string | undefined;
  let optionsEnabled = true;
  const taskParts: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (optionsEnabled && argument === "--") {
      optionsEnabled = false;
      continue;
    }
    if (optionsEnabled && argument === "--yes") {
      if (first !== "run") throw new Error("`--yes` is available only for `jev run`.");
      yes = true;
      continue;
    }
    if (optionsEnabled && argument === "--provider") {
      const value = argv[++index];
      if (value !== "codex" && value !== "copilot") throw new Error("`--provider` must be `codex` or `copilot`.");
      provider = value;
      continue;
    }
    if (optionsEnabled && argument === "--model") {
      if (first !== "run") throw new Error("`--model` is available only for `jev run`.");
      const value = argv[++index];
      if (!value) throw new Error("`--model` requires a model ID.");
      model = value;
      continue;
    }
    if (optionsEnabled && argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    taskParts.push(argument);
  }
  const task = taskParts.join(" ").trim();
  if (!task) throw new Error(`A task is required.\n\n${usage()}`);
  if (first === "route" && model) throw new Error("`--model` is available only for `jev run`.");
  return {
    command: first,
    task,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(yes ? { yes } : {}),
  };
}

function loadLocalEnvironment(cwd = process.cwd()): void {
  loadDotenv({ path: path.join(cwd, ".env.local"), override: false, quiet: true });
}

function providerName(provider: ProviderName): string {
  return provider === "codex" ? "Codex" : "Copilot";
}

function catalogCache(discoveries: Awaited<ReturnType<typeof discoverModels>>): CatalogCache {
  const sources: Partial<Record<ProviderName, string>> = {};
  for (const discovery of discoveries) {
    for (const model of discovery.publicModels) sources[model.provider] = model.provider === "codex"
      ? "Codex local model catalog"
      : "Authenticated Copilot SDK model list";
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    sources: {
      codex: sources.codex ?? "not queried",
      copilot: sources.copilot ?? "not queried",
    },
    models: discoveries.flatMap((discovery) => discovery.publicModels),
  };
}

async function persistCatalog(discoveries: Awaited<ReturnType<typeof discoverModels>>): Promise<CatalogCache> {
  const cache = catalogCache(discoveries);
  await writePrivateJson(path.join(getCacheDirectory(), "catalog.json"), cache);
  return cache;
}

function printStatuses(statuses: BenchmarkStatus[]): void {
  for (const status of statuses) {
    const updated = status.updatedAt ? `, updated ${status.updatedAt}` : "";
    const detail = status.detail ? ` — ${status.detail}` : "";
    console.log(`  ${status.source}: ${status.state}${updated}${detail}`);
  }
}

function subscriptionLabel(candidate: ModelCandidate): string {
  if (candidate.subscription.kind === "unknown") return `${candidate.subscription.label}; API token prices are not used as subscription cost`;
  const quota = candidate.subscription.unlimited
    ? "unlimited quota"
    : candidate.subscription.remainingPercent === undefined
      ? "quota remaining unknown"
      : `${candidate.subscription.remainingPercent}% quota remaining`;
  const multiplier = candidate.subscription.multiplier === undefined
    ? ""
    : `; ${candidate.subscription.multiplier} reported model usage multiplier`;
  return `Copilot subscription usage: ${quota}${multiplier}; exact per-task monetary cost unknown`;
}

function selectionRationale(selection: Awaited<ReturnType<typeof selectCandidate>>): string {
  if (selection.source === "override") return "Chosen by the explicit --model override after local eligibility validation.";
  const probability = selection.probability === undefined ? "" : ` Jev's choice probability: ${(selection.probability * 100).toFixed(1)}%.`;
  return `Jev selected this model from ${selection.eligibleCount} currently eligible candidates using the task text and allowlisted model metadata.${probability}`;
}

function printSelection(
  selection: Awaited<ReturnType<typeof selectCandidate>>,
  statuses: BenchmarkStatus[],
): void {
  const candidate = selection.candidate;
  console.log(`Provider: ${providerName(candidate.provider)} (${candidate.provider})`);
  console.log(`Model: ${candidate.name} (${candidate.modelId})`);
  console.log(`Eligible candidates: ${selection.eligibleCount}`);
  console.log(`Subscription cost: ${subscriptionLabel(candidate)}`);
  console.log(`Rationale: ${selectionRationale(selection)}`);
  console.log("Benchmark data:");
  printStatuses(statuses);
  const benchmarks = selection.metadata.benchmarks;
  const values = [
    benchmarks.arenaCoding === undefined ? undefined : `Arena Code ${benchmarks.arenaCoding} (rank ${benchmarks.arenaCodingRank ?? "unknown"})`,
    benchmarks.arenaAgent === undefined ? undefined : `Arena Agent ${benchmarks.arenaAgent} (rank ${benchmarks.arenaAgentRank ?? "unknown"})`,
    benchmarks.artificialAnalysisCoding === undefined ? undefined : `Artificial Analysis coding index ${benchmarks.artificialAnalysisCoding}`,
    benchmarks.artificialAnalysisAgentic === undefined ? undefined : `Artificial Analysis agentic index ${benchmarks.artificialAnalysisAgentic}`,
  ].filter((value): value is string => value !== undefined);
  console.log(`Matched candidate benchmarks: ${values.length ? values.join("; ") : "none available"}`);
  if (values.some((value) => value.startsWith("Artificial Analysis"))) {
    console.log("Artificial Analysis data source: https://artificialanalysis.ai/data-api");
  }
}

function currentProviderInfo(discoveries: Awaited<ReturnType<typeof discoverModels>>): string[] {
  return discoveries.map((discovery) => {
    const provider = discovery.candidates[0]?.provider;
    const count = discovery.candidates.length;
    if (!provider) return `No eligible models returned.`;
    const quota = discovery.quotaSummary ? ` ${discovery.quotaSummary}` : "";
    return `${providerName(provider)}: ${count} currently eligible model${count === 1 ? "" : "s"}.${quota}`;
  });
}

async function discoverFor(provider?: ProviderName) {
  return discoverModels({ providers: provider ? [provider] : ["codex", "copilot"] });
}

async function commandDoctor(): Promise<void> {
  console.log("Jev Task Router doctor");
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  const nodeSupported = nodeMajor! > 22 || (nodeMajor === 22 && nodeMinor! >= 14);
  console.log(`Node.js: ${nodeSupported ? "available" : "too old"} (${process.versions.node}; requires 22.14+)`);
  console.log(`Vercel AI Gateway key: ${process.env.AI_GATEWAY_API_KEY ? "available (value hidden)" : "missing; set AI_GATEWAY_API_KEY in .env.local or the environment"}`);
  console.log(`Artificial Analysis: ${process.env.ARTIFICIAL_ANALYSIS_API_KEY ? "optional key available (value hidden)" : "not configured (optional)"}`);
  let failed = !process.env.AI_GATEWAY_API_KEY || !nodeSupported;
  for (const provider of ["codex", "copilot"] as const) {
    try {
      const [discovery] = await discoverModels({ providers: [provider] });
      console.log(`${providerName(provider)}: available (${discovery?.candidates.length ?? 0} eligible models)${discovery?.quotaSummary ? `; ${discovery.quotaSummary}` : ""}`);
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : "Provider discovery failed.";
      console.log(`${providerName(provider)}: unavailable (${message})`);
    }
  }
  const cache = await readJson<CatalogCache>(path.join(getCacheDirectory(), "catalog.json"));
  console.log(`Local catalog cache: ${cache?.updatedAt ?? "not created"}`);
  const benchmarkCache = await ensureFreshBenchmarks();
  console.log("Benchmark data:");
  printStatuses(benchmarkCache.statuses);
  if (failed) process.exitCode = 1;
}

async function commandModelsRefresh(): Promise<void> {
  const discoveries = await discoverFor();
  const catalog = await persistCatalog(discoveries);
  const benchmarks = await refreshBenchmarkCache();
  console.log(`Saved current provider catalog at ${catalog.updatedAt}; ${catalog.models.length} public model records cached locally.`);
  for (const line of currentProviderInfo(discoveries)) console.log(line);
  console.log("Benchmark data:");
  printStatuses(benchmarks.statuses);
  for (const failure of benchmarks.failures) console.log(failure);
  console.log(`Arena attribution: ${getArenaDatasetAttribution()}`);
  if (benchmarks.cache.artificialAnalysis) {
    console.log("Artificial Analysis source: https://artificialanalysis.ai/data-api");
    console.log("Its data is cached only on this machine for internal use and is not included in the package.");
  }
}

function getArenaDatasetAttribution(): string {
  return "Arena leaderboard data: https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset (CC BY 4.0).";
}

async function askBeforeDispatch(selection: Awaited<ReturnType<typeof selectCandidate>>): Promise<boolean> {
  if (!stdin.isTTY || !stderr.isTTY) throw new Error("Run confirmation requires an interactive terminal. Review with `jev route` or pass `--yes` to waive only this router confirmation.");
  const prompt = createInterface({ input: stdin, output: stderr });
  try {
    const answer = await prompt.question(`\nDispatch to ${providerName(selection.candidate.provider)} / ${selection.candidate.modelId}? [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function routeOrRun(parsed: ParsedArgs, signal: AbortSignal): Promise<void> {
  const discoveries = await discoverFor(parsed.provider);
  await persistCatalog(discoveries);
  const candidates = flattenCandidates(discoveries);
  const benchmarks = await ensureFreshBenchmarks({ signal });
  const metadata = buildCandidateMetadata(candidates, benchmarks.cache);
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  const selection = await selectCandidate({
    task: parsed.task!,
    candidates,
    candidateMetadata: metadata,
    ...(parsed.provider ? { provider: parsed.provider } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(apiKey ? { apiKey } : {}),
    signal,
  });
  printSelection(selection, benchmarks.statuses);
  if (parsed.command === "route") return;
  const dispatched = await dispatchAfterRouterConfirmation(
    parsed.yes === true,
    () => askBeforeDispatch(selection),
    async () => {
      console.log("Dispatching through the selected local provider. Provider permission prompts remain enabled.");
      await executeCandidate(selection.candidate, parsed.task!, { signal });
    },
  );
  if (!dispatched) {
    console.log("Cancelled. No provider was started.");
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  loadLocalEnvironment();
  const parsed = parseArgs(argv);
  if (parsed.command === "help") {
    console.log(usage());
    return;
  }
  if (parsed.command === "doctor") return commandDoctor();
  if (parsed.command === "models") return commandModelsRefresh();

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  try {
    await routeOrRun(parsed, controller.signal);
  } finally {
    process.removeListener("SIGINT", abort);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "The command failed.";
    if (message === "The operation was aborted.") console.error("Cancelled.");
    else console.error(message);
    process.exitCode = 1;
  });
}
