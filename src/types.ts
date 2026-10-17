export type ProviderName = "codex" | "copilot";

export interface ModelCandidate {
  provider: ProviderName;
  modelId: string;
  name: string;
  contextWindow?: number;
  vision: boolean;
  reasoningEfforts: string[];
  subscription: {
    kind: "unknown" | "quota";
    label: string;
    remainingPercent?: number;
    unlimited?: boolean;
    multiplier?: number;
    resetsAt?: string;
  };
}

export type ArenaMetric = {
  modelName: string;
  category: "coding" | "agent";
  value: number;
  rank?: number;
  publishedAt?: string;
};

export type ArtificialAnalysisMetric = {
  modelSlug: string;
  modelName: string;
  codingIndex?: number;
  agenticIndex?: number;
};

export interface CandidateMetadata {
  id: string;
  provider: ProviderName;
  model: string;
  name: string;
  capabilities: {
    contextWindow?: number;
    vision: boolean;
    reasoningEfforts: string[];
  };
  subscription: ModelCandidate["subscription"];
  benchmarks: {
    arenaCoding?: number;
    arenaCodingRank?: number;
    arenaAgent?: number;
    arenaAgentRank?: number;
    artificialAnalysisCoding?: number;
    artificialAnalysisAgentic?: number;
  };
}

export interface CatalogCache {
  version: 1;
  updatedAt: string;
  sources: Record<ProviderName, string>;
  models: Array<{
    provider: ProviderName;
    modelId: string;
    name: string;
    contextWindow?: number;
    vision: boolean;
    reasoningEfforts: string[];
  }>;
}

export interface BenchmarkSourceCache<T> {
  updatedAt: string;
  source: string;
  records: T[];
}

export interface BenchmarkCache {
  version: 1;
  arena?: BenchmarkSourceCache<ArenaMetric>;
  artificialAnalysis?: BenchmarkSourceCache<ArtificialAnalysisMetric>;
}

export interface BenchmarkStatus {
  source: string;
  state: "fresh" | "stale" | "unavailable" | "not-configured";
  updatedAt?: string;
  detail?: string;
}

export interface ModelDiscovery {
  candidates: ModelCandidate[];
  publicModels: CatalogCache["models"];
  quotaSummary?: string;
}
