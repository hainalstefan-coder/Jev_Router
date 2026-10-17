import assert from "node:assert/strict";
import test from "node:test";
import { dispatchAfterRouterConfirmation } from "../src/approval.js";
import { selectCandidate } from "../src/router.js";
import type { CandidateMetadata, ModelCandidate } from "../src/types.js";

const codex: ModelCandidate = {
  provider: "codex",
  modelId: "gpt-6-sol",
  name: "GPT-6 Sol",
  contextWindow: 272000,
  vision: false,
  reasoningEfforts: ["high", "xhigh"],
  subscription: { kind: "unknown", label: "Unknown per-task subscription cost" },
};
const copilot: ModelCandidate = {
  provider: "copilot",
  modelId: "claude-sonnet-5.5",
  name: "Claude Sonnet 5.5",
  vision: true,
  reasoningEfforts: [],
  subscription: { kind: "quota", label: "Copilot premium-request quota", remainingPercent: 64, multiplier: 1 },
};

test("Jev receives only task text and allowlisted candidate metadata and its choice is validated", async () => {
  let observed: { state: string; options: Record<string, string> } | undefined;
  const candidatesWithPrivateExtra = [
    { ...codex, repositoryFiles: ["secret-source.ts"] },
    copilot,
  ] as unknown as ModelCandidate[];
  const metadata: CandidateMetadata[] = [
    {
      id: "codex:gpt-6-sol",
      provider: "codex",
      model: "gpt-6-sol",
      name: "GPT-6 Sol",
      capabilities: { contextWindow: 272000, vision: false, reasoningEfforts: ["high", "xhigh"] },
      subscription: codex.subscription,
      benchmarks: { arenaCoding: 1800, arenaAgent: 0.14 },
    },
    {
      id: "copilot:claude-sonnet-5.5",
      provider: "copilot",
      model: "claude-sonnet-5.5",
      name: "Claude Sonnet 5.5",
      capabilities: { vision: true, reasoningEfforts: [] },
      subscription: copilot.subscription,
      benchmarks: {},
    },
  ];
  const result = await selectCandidate({
    task: "Fix the route handler",
    candidates: candidatesWithPrivateExtra,
    candidateMetadata: metadata,
    decide: async (input) => {
      observed = input;
      return { choice: "copilot:claude-sonnet-5.5", probabilities: { "copilot:claude-sonnet-5.5": 0.82 } };
    },
  });

  assert.equal(result.candidate.provider, "copilot");
  assert.equal(result.probability, 0.82);
  const state = JSON.parse(observed!.state) as { task: string; candidates: CandidateMetadata[]; [key: string]: unknown };
  assert.equal(state.task, "Fix the route handler");
  assert.equal("repositoryFiles" in state, false);
  assert.equal("files" in state, false);
  assert.equal(state.candidates.length, 2);
  assert.deepEqual(Object.keys(state.candidates[0]!), ["id", "provider", "model", "name", "capabilities", "subscription", "benchmarks"]);
  assert.equal(Object.keys(observed!.options).length, 2);
});

test("invalid Jev choice stops without selecting a fallback", async () => {
  await assert.rejects(
    selectCandidate({
      task: "Review a change",
      candidates: [codex],
      decide: async () => ({ choice: "copilot:unavailable-model" }),
    }),
    /not in the eligible candidate list/,
  );
});

test("provider and model overrides must match the live eligible catalog", async () => {
  const override = await selectCandidate({
    task: "Explain this error",
    candidates: [codex, copilot],
    provider: "codex",
    model: "gpt-6-sol",
    decide: async () => { throw new Error("Jev should not be called for an explicit model override"); },
  });
  assert.equal(override.source, "override");
  assert.equal(override.candidate.modelId, "gpt-6-sol");
  await assert.rejects(selectCandidate({ task: "x", candidates: [codex], model: "not-installed" }), /not currently eligible/);
  await assert.rejects(selectCandidate({ task: "x", candidates: [codex, copilot], model: "shared-id" }), /not currently eligible/);
});

test("abort during Jev decision cancels and does not route", async () => {
  const controller = new AbortController();
  await assert.rejects(
    selectCandidate({
      task: "Cancel this route",
      candidates: [codex, copilot],
      signal: controller.signal,
      decide: async () => {
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      },
    }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

test("declining router confirmation cancels before dispatch, while --yes skips only that question", async () => {
  let dispatched = 0;
  const declined = await dispatchAfterRouterConfirmation(false, async () => false, async () => { dispatched += 1; });
  assert.equal(declined, false);
  assert.equal(dispatched, 0);
  let asked = false;
  const accepted = await dispatchAfterRouterConfirmation(true, async () => { asked = true; return false; }, async () => { dispatched += 1; });
  assert.equal(accepted, true);
  assert.equal(asked, false);
  assert.equal(dispatched, 1);
});
