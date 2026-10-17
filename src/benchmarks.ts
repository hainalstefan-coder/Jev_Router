import path from "node:path";
import { getCacheDirectory, isFresh, readJson, writePrivateJson } from "./cache.js";
import type {
  ArenaMetric,
  ArtificialAnalysisMetric,
  BenchmarkCache,
  BenchmarkStatus,
  CandidateMetadata,
  ModelCandidate,
} from "./types.js";

const ARENA_DATASET = "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset";
const HF_ROWS_API = "https://datasets-server.huggingface.co/rows";
const AA_MODELS_API = "https://artificialanalysis.ai/api/v2/language/models";
const CACHE_FILE = "benchmarks.json";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRows(json: unknown): unknown[] {
  const root = record(json);
  return Array.isArray(root?.rows) ? root.rows : [];
}

export function parseArenaRows(config: "webdev" | "agent", json: unknown): ArenaMetric[] {
  const category: ArenaMetric["category"] = config === "webdev" ? "coding" : "agent";
  const output: ArenaMetric[] = [];
  for (const item of asRows(json)) {
    const row = record(record(item)?.row);
    if (!row || row.category !== "overall") continue;
    const modelName = text(row.model_name);
    const value = number(config === "webdev" ? row.rating ?? row.score : row.score ?? row.rating);
    if (!modelName || value === undefined) continue;
    const rank = number(row.rank);
    const publishedAt = text(row.leaderboard_publish_date);
    output.push({
      modelName,
      category,
      value,
      ...(rank === undefined ? {} : { rank }),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return output;
}

export function parseArtificialAnalysis(json: unknown): ArtificialAnalysisMetric[] {
  const root = record(json);
  const rows = Array.isArray(root?.data) ? root.data : [];
  const output: ArtificialAnalysisMetric[] = [];
  for (const item of rows) {
    const model = record(item);
    const evaluations = record(model?.evaluations);
    const modelSlug = text(model?.slug);
    const modelName = text(model?.name);
    if (!modelSlug || !modelName || !evaluations) continue;
    const codingIndex = number(evaluations.artificial_analysis_coding_index);
    const agenticIndex = number(evaluations.artificial_analysis_agentic_index);
    if (codingIndex === undefined && agenticIndex === undefined) continue;
    output.push({
      modelSlug,
      modelName,
      ...(codingIndex === undefined ? {} : { codingIndex }),
      ...(agenticIndex === undefined ? {} : { agenticIndex }),
    });
  }
  return output;
}

async function fetchArena(fetcher: FetchLike, signal?: AbortSignal): Promise<ArenaMetric[]> {
  const metrics: ArenaMetric[] = [];
  for (const config of ["webdev", "agent"] as const) {
    const url = new URL(HF_ROWS_API);
    url.searchParams.set("dataset", "lmarena-ai/leaderboard-dataset");
    url.searchParams.set("config", config);
    url.searchParams.set("split", "latest");
    url.searchParams.set("offset", "0");
    url.searchParams.set("length", "100");
    const response = await fetcher(url, signal ? { signal } : {});
    if (!response.ok) throw new Error("Arena benchmark refresh failed.");
    metrics.push(...parseArenaRows(config, await response.json()));
  }
  return metrics;
}

async function fetchArtificialAnalysis(
  fetcher: FetchLike,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ArtificialAnalysisMetric[]> {
  const response = await fetcher(AA_MODELS_API, {
    headers: { "x-api-key": apiKey },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error("Artificial Analysis refresh failed.");
  return parseArtificialAnalysis(await response.json());
}

function validatedCache(value: unknown): BenchmarkCache | undefined {
  const root = record(value);
  if (root?.version !== 1) return undefined;
  return value as BenchmarkCache;
}

export interface RefreshBenchmarkOptions {
  cacheDirectory?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  now?: Date;
  signal?: AbortSignal;
}

export interface RefreshedBenchmarks {
  cache: BenchmarkCache;
  statuses: BenchmarkStatus[];
  failures: string[];
}

export async function refreshBenchmarkCache(options: RefreshBenchmarkOptions = {}): Promise<RefreshedBenchmarks> {
  const directory = options.cacheDirectory ?? getCacheDirectory(options.env);
  const file = path.join(directory, CACHE_FILE);
  const existing = validatedCache(await readJson<unknown>(file)) ?? { version: 1 as const };
  const cache: BenchmarkCache = { ...existing };
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? new Date();
  const failures: string[] = [];
  const statuses: BenchmarkStatus[] = [];

  try {
    cache.arena = {
      source: ARENA_DATASET,
      updatedAt: now.toISOString(),
      records: await fetchArena(fetcher, options.signal),
    };
  } catch {
    if (options.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    failures.push("Arena benchmark data could not be refreshed.");
  }
  const env = options.env ?? process.env;
  const aaKey = env.ARTIFICIAL_ANALYSIS_API_KEY;
  if (aaKey) {
    try {
      cache.artificialAnalysis = {
        source: "https://artificialanalysis.ai/data-api",
        updatedAt: now.toISOString(),
        records: await fetchArtificialAnalysis(fetcher, aaKey, options.signal),
      };
    } catch {
      if (options.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      failures.push("Artificial Analysis enrichment could not be refreshed.");
    }
  }

  if (cache.arena) {
    statuses.push({ source: "Arena Code and Agent leaderboards", state: isFresh(cache.arena.updatedAt, now.getTime()) ? "fresh" : "stale", updatedAt: cache.arena.updatedAt });
  } else {
    statuses.push({ source: "Arena Code and Agent leaderboards", state: "unavailable" });
  }
  if (cache.artificialAnalysis) {
    statuses.push({ source: "Artificial Analysis", state: isFresh(cache.artificialAnalysis.updatedAt, now.getTime()) ? "fresh" : "stale", updatedAt: cache.artificialAnalysis.updatedAt });
  } else {
    statuses.push({
      source: "Artificial Analysis",
      state: aaKey ? "unavailable" : "not-configured",
      ...(!aaKey ? { detail: "Optional; configure ARTIFICIAL_ANALYSIS_API_KEY for local enrichment." } : {}),
    });
  }
  await writePrivateJson(file, cache);
  return { cache, statuses, failures };
}

export async function loadBenchmarkCache(cacheDirectory = getCacheDirectory()): Promise<BenchmarkCache> {
  const parsed = validatedCache(await readJson<unknown>(path.join(cacheDirectory, CACHE_FILE)));
  return parsed ?? { version: 1 };
}

export async function ensureFreshBenchmarks(options: RefreshBenchmarkOptions = {}): Promise<RefreshedBenchmarks> {
  const directory = options.cacheDirectory ?? getCacheDirectory(options.env);
  const existing = await loadBenchmarkCache(directory);
  const now = options.now ?? new Date();
  const hasCurrentArena = existing.arena && isFresh(existing.arena.updatedAt, now.getTime());
  const env = options.env ?? process.env;
  const hasCurrentAA = !env.ARTIFICIAL_ANALYSIS_API_KEY
    || Boolean(existing.artificialAnalysis && isFresh(existing.artificialAnalysis.updatedAt, now.getTime()));
  if (hasCurrentArena && hasCurrentAA) {
    return {
      cache: existing,
      statuses: getBenchmarkStatuses(existing, options.env, now),
      failures: [],
    };
  }
  return refreshBenchmarkCache(options);
}

export function getBenchmarkStatuses(
  cache: BenchmarkCache,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): BenchmarkStatus[] {
  const statuses: BenchmarkStatus[] = [];
  statuses.push(cache.arena
    ? { source: "Arena Code and Agent leaderboards", state: isFresh(cache.arena.updatedAt, now.getTime()) ? "fresh" : "stale", updatedAt: cache.arena.updatedAt }
    : { source: "Arena Code and Agent leaderboards", state: "unavailable" });
  statuses.push(cache.artificialAnalysis
    ? { source: "Artificial Analysis", state: isFresh(cache.artificialAnalysis.updatedAt, now.getTime()) ? "fresh" : "stale", updatedAt: cache.artificialAnalysis.updatedAt }
    : {
        source: "Artificial Analysis",
        state: env.ARTIFICIAL_ANALYSIS_API_KEY ? "unavailable" : "not-configured",
          ...(!env.ARTIFICIAL_ANALYSIS_API_KEY ? { detail: "Optional; configure ARTIFICIAL_ANALYSIS_API_KEY for local enrichment." } : {}),
      });
  return statuses;
}

function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:max|xhigh|high|medium|low|fast|thinking|extended|preview)\b/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function findExact<T>(records: T[], names: string[], selector: (record: T) => string): T | undefined {
  const normalized = new Set(names.map(normalizeName).filter(Boolean));
  return records.find((candidate) => normalized.has(normalizeName(selector(candidate))));
}

export function buildCandidateMetadata(
  candidates: ModelCandidate[],
  cache: BenchmarkCache,
): CandidateMetadata[] {
  return candidates.map((candidate) => {
    const names = [candidate.modelId, candidate.name];
    const coding = cache.arena?.records.find((metric) =>
      metric.category === "coding" && names.some((name) => normalizeName(metric.modelName) === normalizeName(name)),
    );
    const agent = cache.arena?.records.find((metric) =>
      metric.category === "agent" && names.some((name) => normalizeName(metric.modelName) === normalizeName(name)),
    );
    const aa = findExact(cache.artificialAnalysis?.records ?? [], names, (metric) => metric.modelName)
      ?? findExact(cache.artificialAnalysis?.records ?? [], names, (metric) => metric.modelSlug);
    const id = `${candidate.provider}:${candidate.modelId}`;
    return {
      id,
      provider: candidate.provider,
      model: candidate.modelId,
      name: candidate.name,
      capabilities: {
        ...(candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow }),
        vision: candidate.vision,
        reasoningEfforts: candidate.reasoningEfforts,
      },
      subscription: candidate.subscription,
      benchmarks: {
        ...(coding ? { arenaCoding: coding.value, ...(coding.rank === undefined ? {} : { arenaCodingRank: coding.rank }) } : {}),
        ...(agent ? { arenaAgent: agent.value, ...(agent.rank === undefined ? {} : { arenaAgentRank: agent.rank }) } : {}),
        ...(aa?.codingIndex === undefined ? {} : { artificialAnalysisCoding: aa.codingIndex }),
        ...(aa?.agenticIndex === undefined ? {} : { artificialAnalysisAgentic: aa.agenticIndex }),
      },
    };
  });
}

export function getArenaDatasetAttribution(): string {
  return `Arena leaderboard data by LMSYS Arena, licensed CC BY 4.0: ${ARENA_DATASET}`;
}
