import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCopilotModels, parseCodexCatalog, providerChildEnvironment } from "../src/providers.js";
import type { ModelInfo } from "@github/copilot-sdk";

test("Codex catalog parsing keeps only visible API-supported models and allowlisted fields", () => {
  const parsed = parseCodexCatalog(JSON.stringify({
    models: [
      {
        slug: "gpt-6-sol",
        display_name: "GPT-6 Sol",
        visibility: "list",
        supported_in_api: true,
        context_window: 272000,
        input_modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "high", description: "deep" }],
        system_prompt: "must not be forwarded",
      },
      { slug: "hidden", visibility: "hide", supported_in_api: true },
      { slug: "unsupported", visibility: "list", supported_in_api: false },
    ],
  }));

  assert.equal(parsed.candidates.length, 1);
  assert.deepEqual(parsed.candidates[0], {
    provider: "codex",
    modelId: "gpt-6-sol",
    name: "GPT-6 Sol",
    contextWindow: 272000,
    vision: true,
    reasoningEfforts: ["high"],
    subscription: { kind: "unknown", label: "Unknown per-task subscription cost" },
  });
  assert.equal(JSON.stringify(parsed).includes("system_prompt"), false);
});

test("Copilot model adapter exposes supported capabilities and live quota without API token prices", () => {
  const model = {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    capabilities: {
      supports: { vision: true, reasoningEffort: true },
      limits: { max_context_window_tokens: 128000 },
    },
    policy: { state: "enabled", terms: "" },
    billing: { multiplier: 2, tokenPrices: { input: 0.1, output: 0.2 } },
    supportedReasoningEfforts: ["high"],
  } as unknown as ModelInfo;
  const disabled = { ...model, id: "disabled", policy: { state: "disabled", terms: "" } } as ModelInfo;
  const result = normalizeCopilotModels([model, disabled], {
    remainingPercentage: 64,
    isUnlimitedEntitlement: false,
    resetDate: "2026-11-01T00:00:00Z",
  });

  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0]?.subscription, {
    kind: "quota",
    label: "Copilot subscription quota",
    remainingPercent: 64,
    unlimited: false,
    multiplier: 2,
    resetsAt: "2026-11-01T00:00:00Z",
  });
  assert.equal(JSON.stringify(result).includes("tokenPrices"), false);
  assert.match(result.quotaSummary ?? "", /64% remaining/);
});

test("provider child environments do not contain Gateway or Artificial Analysis credentials", () => {
  const cleaned = providerChildEnvironment({
    PATH: "/bin",
    AI_GATEWAY_API_KEY: "never-forward-this-gateway-secret",
    ARTIFICIAL_ANALYSIS_API_KEY: "never-forward-this-benchmark-secret",
    COPILOT_TEST_VALUE: "keep-provider-sign-in",
  });
  assert.deepEqual(cleaned, { PATH: "/bin", COPILOT_TEST_VALUE: "keep-provider-sign-in" });
  assert.equal(JSON.stringify(cleaned).includes("never-forward"), false);
});
