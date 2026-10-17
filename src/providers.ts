import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { CopilotClient, type ModelInfo } from "@github/copilot-sdk";
import type { ModelCandidate, ModelDiscovery, ProviderName } from "./types.js";

const execFile = promisify(nodeExecFile);
const GATEWAY_SECRET = "AI_GATEWAY_API_KEY";
const AA_SECRET = "ARTIFICIAL_ANALYSIS_API_KEY";

export function providerChildEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[0] !== GATEWAY_SECRET && entry[0] !== AA_SECRET,
    ),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseCodexCatalog(json: string): ModelDiscovery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Codex returned an unreadable model catalog.");
  }
  const root = asRecord(parsed);
  const models = root?.models;
  if (!Array.isArray(models)) throw new Error("Codex returned an unsupported model catalog format.");

  const candidates: ModelCandidate[] = [];
  const publicModels: ModelDiscovery["publicModels"] = [];
  for (const value of models) {
    const model = asRecord(value);
    if (!model || model.visibility !== "list" || model.supported_in_api !== true) continue;
    const modelId = typeof model.slug === "string" ? model.slug : undefined;
    if (!modelId) continue;
    const name = typeof model.display_name === "string" ? model.display_name : modelId;
    const contextWindow = finiteNumber(model.context_window);
    const inputModalities = Array.isArray(model.input_modalities) ? model.input_modalities : [];
    const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
    const reasoningEfforts = levels.flatMap((item) => {
      const effort = asRecord(item)?.effort;
      return typeof effort === "string" ? [effort] : [];
    });
    const candidate: ModelCandidate = {
      provider: "codex",
      modelId,
      name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      vision: inputModalities.includes("image"),
      reasoningEfforts,
      subscription: { kind: "unknown", label: "Unknown per-task subscription cost" },
    };
    candidates.push(candidate);
    publicModels.push({
      provider: "codex",
      modelId,
      name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      vision: candidate.vision,
      reasoningEfforts,
    });
  }
  return { candidates, publicModels };
}

export function normalizeCopilotModels(
  models: ModelInfo[],
  quota?: { remainingPercentage: number; isUnlimitedEntitlement: boolean; resetDate?: string },
): ModelDiscovery {
  const candidates: ModelCandidate[] = [];
  const publicModels: ModelDiscovery["publicModels"] = [];
  for (const model of models) {
    if (!model.id || model.policy?.state === "disabled" || model.policy?.state === "unconfigured") continue;
    const contextWindow = finiteNumber(model.capabilities?.limits?.max_context_window_tokens);
    const remaining = quota && finiteNumber(quota.remainingPercentage);
    const multiplier = finiteNumber(model.billing?.multiplier);
    const subscription: ModelCandidate["subscription"] = quota
      ? {
          kind: "quota",
          label: quota.isUnlimitedEntitlement ? "Copilot subscription quota: unlimited" : "Copilot subscription quota",
          ...(remaining === undefined ? {} : { remainingPercent: remaining }),
          unlimited: quota.isUnlimitedEntitlement,
          ...(multiplier === undefined ? {} : { multiplier }),
          ...(quota.resetDate ? { resetsAt: quota.resetDate } : {}),
        }
      : { kind: "unknown", label: "Copilot quota unavailable; per-task cost unknown" };
    const reasoningEfforts = model.supportedReasoningEfforts ?? [];
    const candidate: ModelCandidate = {
      provider: "copilot",
      modelId: model.id,
      name: model.name || model.id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      vision: model.capabilities?.supports?.vision === true,
      reasoningEfforts,
      subscription,
    };
    candidates.push(candidate);
    publicModels.push({
      provider: "copilot",
      modelId: model.id,
      name: candidate.name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      vision: candidate.vision,
      reasoningEfforts,
    });
  }

  const quotaSummary = quota
    ? quota.isUnlimitedEntitlement
      ? "Copilot subscription quota is unlimited."
      : `Copilot subscription quota: ${quota.remainingPercentage}% remaining${quota.resetDate ? `; resets ${quota.resetDate}` : ""}.`
    : undefined;
  return { candidates, publicModels, ...(quotaSummary ? { quotaSummary } : {}) };
}

export interface DiscoverOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  codexCommand?: (cwd: string, env: Record<string, string>, signal?: AbortSignal) => Promise<string>;
  copilotFactory?: (options: ConstructorParameters<typeof CopilotClient>[0]) => Pick<CopilotClient, "start" | "stop" | "listModels" | "rpc">;
  providers?: ProviderName[];
}

async function defaultCodexCommand(cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<string> {
  const result = await execFile("codex", ["debug", "models"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  return result.stdout;
}

export async function discoverModels(options: DiscoverOptions = {}): Promise<ModelDiscovery[]> {
  const providers = options.providers ?? ["codex", "copilot"];
  const cwd = options.cwd ?? process.cwd();
  const cleanEnv = providerChildEnvironment(options.env);
  const results: ModelDiscovery[] = [];

  if (providers.includes("codex")) {
    try {
      const output = await (options.codexCommand ?? defaultCodexCommand)(cwd, cleanEnv, options.signal);
      results.push(parseCodexCatalog(output));
    } catch {
      if (options.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      throw new Error("Could not discover Codex models. Install and sign in to Codex, then run `jev doctor`.");
    }
  }

  if (providers.includes("copilot")) {
    let client: Pick<CopilotClient, "start" | "stop" | "listModels" | "rpc"> | undefined;
    try {
      client = (options.copilotFactory ?? ((clientOptions) => new CopilotClient(clientOptions)))({
        workingDirectory: cwd,
        logLevel: "none",
        useLoggedInUser: true,
        env: cleanEnv,
      });
      await client.start();
      const models = await client.listModels();
      let quota: { remainingPercentage: number; isUnlimitedEntitlement: boolean; resetDate?: string } | undefined;
      try {
        const response = await client.rpc.account.getQuota({});
        const rawQuota = response.quotaSnapshots.premium_interactions
          ?? response.quotaSnapshots.completions
          ?? response.quotaSnapshots.chat;
        if (rawQuota) {
          quota = {
            remainingPercentage: rawQuota.remainingPercentage,
            isUnlimitedEntitlement: rawQuota.isUnlimitedEntitlement,
            ...(rawQuota.resetDate ? { resetDate: rawQuota.resetDate } : {}),
          };
        }
      } catch {
        // Model discovery remains useful if this account does not expose quota data.
      }
      results.push(normalizeCopilotModels(models, quota));
    } catch {
      if (options.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      throw new Error("Could not discover Copilot models. Install Copilot CLI and sign in through its SDK, then run `jev doctor`.");
    } finally {
      if (client) await client.stop().catch(() => undefined);
    }
  }

  const candidates = results.flatMap((result) => result.candidates);
  if (candidates.length === 0) throw new Error("No currently eligible Codex or Copilot models were found. Check provider sign-in with `jev doctor`.");
  return results;
}

export function flattenCandidates(discoveries: ModelDiscovery[]): ModelCandidate[] {
  return discoveries.flatMap((discovery) => discovery.candidates);
}
