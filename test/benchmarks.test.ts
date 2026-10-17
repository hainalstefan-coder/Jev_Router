import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCandidateMetadata, parseArenaRows, parseArtificialAnalysis, refreshBenchmarkCache } from "../src/benchmarks.js";
import { isFresh } from "../src/cache.js";
import type { BenchmarkCache, ModelCandidate } from "../src/types.js";

test("Arena Code and Agent rows parse their separate score fields", () => {
  const input = { rows: [
    { row: { model_name: "GPT-6.1 Sol (Max)", rating: 1810.2, rank: 4, category: "overall", leaderboard_publish_date: "2026-10-16" } },
    { row: { model_name: "ignore category", rating: 10, category: "speed" } },
  ] };
  assert.deepEqual(parseArenaRows("webdev", input), [{
    modelName: "GPT-6.1 Sol (Max)", category: "coding", value: 1810.2, rank: 4, publishedAt: "2026-10-16",
  }]);
  assert.deepEqual(parseArenaRows("agent", { rows: [{ row: { model_name: "GPT-6.1 Sol", score: 0.14, rank: 2, category: "overall" } }] }), [
    { modelName: "GPT-6.1 Sol", category: "agent", value: 0.14, rank: 2 },
  ]);
});

test("Artificial Analysis parser keeps only local coding and agentic indices", () => {
  assert.deepEqual(parseArtificialAnalysis({ data: [
    {
      slug: "gpt-6.1-sol",
      name: "GPT-6.1 Sol (Max)",
      evaluations: { artificial_analysis_coding_index: 54.2, artificial_analysis_agentic_index: 61.7 },
      pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 3 },
    },
    { slug: "empty", name: "Empty", evaluations: {} },
  ] }), [{ modelSlug: "gpt-6.1-sol", modelName: "GPT-6.1 Sol (Max)", codingIndex: 54.2, agenticIndex: 61.7 }]);
});

test("benchmark matching normalizes common model effort labels without blocking missing data", () => {
  const candidate: ModelCandidate = {
    provider: "codex",
    modelId: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    vision: false,
    reasoningEfforts: ["xhigh"],
    subscription: { kind: "unknown", label: "Unknown per-task subscription cost" },
  };
  const cache: BenchmarkCache = {
    version: 1,
    arena: { source: "Arena", updatedAt: "2026-10-17T00:00:00Z", records: [
      { modelName: "GPT-6.1 Sol (Max)", category: "coding", value: 1800, rank: 4 },
      { modelName: "GPT-6.1 Sol (High)", category: "agent", value: 0.15, rank: 3 },
    ] },
    artificialAnalysis: { source: "AA", updatedAt: "2026-10-17T00:00:00Z", records: [
      { modelSlug: "gpt-6.1-sol", modelName: "GPT-6.1 Sol", codingIndex: 54.2 },
    ] },
  };
  assert.deepEqual(buildCandidateMetadata([candidate], cache)[0]?.benchmarks, {
    arenaCoding: 1800,
    arenaCodingRank: 4,
    arenaAgent: 0.15,
    arenaAgentRank: 3,
    artificialAnalysisCoding: 54.2,
  });
  const missing = buildCandidateMetadata([candidate], { version: 1 });
  assert.deepEqual(missing[0]?.benchmarks, {});
});

test("stale benchmark data remains labeled and unavailable data does not become a score", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-router-bench-"));
  const cacheDirectory = path.join(root, "cache");
  await mkdir(cacheDirectory, { recursive: true });
  const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const prior: BenchmarkCache = {
    version: 1,
    arena: { source: "Arena", updatedAt: staleTime, records: [{ modelName: "GPT-6 Sol", category: "coding", value: 1 }] },
  };
  await writeFile(path.join(cacheDirectory, "benchmarks.json"), JSON.stringify(prior));
  try {
    const result = await refreshBenchmarkCache({
      cacheDirectory,
      env: {},
      now: new Date(),
      fetch: async () => { throw new Error("offline"); },
    });
    assert.equal(result.statuses[0]?.state, "stale");
    assert.equal(result.statuses[1]?.state, "not-configured");
    assert.equal(result.cache.arena?.records.length, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(isFresh(staleTime), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing benchmark sources are marked unavailable without blocking cache refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-router-missing-"));
  try {
    const result = await refreshBenchmarkCache({
      cacheDirectory: root,
      env: {},
      fetch: async () => new Response("offline", { status: 503 }),
    });
    assert.equal(result.statuses[0]?.state, "unavailable");
    assert.equal(result.statuses[1]?.state, "not-configured");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
