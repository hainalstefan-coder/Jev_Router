import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createInteractivePermissionHandler, executeCandidate } from "../src/execution.js";
import type { CopilotClient, PermissionRequest } from "@github/copilot-sdk";
import type { ModelCandidate } from "../src/types.js";

const codex: ModelCandidate = {
  provider: "codex",
  modelId: "gpt-6-sol",
  name: "GPT-6 Sol",
  vision: false,
  reasoningEfforts: [],
  subscription: { kind: "unknown", label: "unknown" },
};

test("Codex dispatch uses the chosen model, ephemeral workspace sandbox, and a scrubbed environment", async () => {
  const child = new EventEmitter() as EventEmitter & { kill: () => void };
  child.kill = () => undefined;
  const setExit = () => setImmediate(() => child.emit("close", 0, null));
  let captured: { file: string; args: string[]; options: { env: Record<string, string> } } | undefined;
  await executeCandidate(codex, "Say hello", {
    cwd: "/tmp/smoke",
    env: {
      PATH: "/bin",
      AI_GATEWAY_API_KEY: "gateway-secret-never-forwarded",
      ARTIFICIAL_ANALYSIS_API_KEY: "aa-secret-never-forwarded",
      COPILOT_GITHUB_TOKEN: "provider-login-retained",
    },
    spawn: ((file: string, args: string[], options: { env: Record<string, string> }) => {
      captured = { file, args, options };
      setExit();
      return child;
    }) as never,
  });
  assert.equal(captured?.file, "codex");
  assert.deepEqual(captured?.args.slice(0, 8), ["exec", "--ephemeral", "--model", "gpt-6-sol", "--sandbox", "workspace-write", "--cd", "/tmp/smoke"]);
  assert.equal(captured?.args.at(-1), "Say hello");
  assert.equal("AI_GATEWAY_API_KEY" in captured!.options.env, false);
  assert.equal("ARTIFICIAL_ANALYSIS_API_KEY" in captured!.options.env, false);
  assert.equal(captured!.options.env.COPILOT_GITHUB_TOKEN, "provider-login-retained");
});

test("Copilot dispatch deletes its temporary session and leaves provider permission decisions interactive", async () => {
  let clientOptions: Record<string, unknown> | undefined;
  let sessionConfig: Record<string, unknown> | undefined;
  let deletedSession = "";
  const output = new PassThrough();
  let responseText = "";
  output.on("data", (chunk) => { responseText += chunk.toString(); });
  const session = {
    sessionId: "created-by-jev",
    sendAndWait: async () => ({ data: { content: "copilot smoke response" } }),
    disconnect: async () => undefined,
    abort: async () => undefined,
  };
  const client = {
    start: async () => undefined,
    stop: async () => [],
    createSession: async (config: Record<string, unknown>) => { sessionConfig = config; return session; },
    deleteSession: async (id: string) => { deletedSession = id; },
  };
  const candidate: ModelCandidate = { ...codex, provider: "copilot", modelId: "gpt-6-sol" };
  await executeCandidate(candidate, "Say hello", {
    cwd: "/tmp/smoke",
    stdout: output as never,
    stderr: process.stderr,
    env: { PATH: "/bin", AI_GATEWAY_API_KEY: "gateway-secret", ARTIFICIAL_ANALYSIS_API_KEY: "aa-secret" },
    copilotFactory: ((options: Record<string, unknown>) => { clientOptions = options; return client; }) as never,
    confirmPermission: async () => false,
  });
  assert.equal(responseText.trim(), "copilot smoke response");
  assert.equal(deletedSession, "created-by-jev");
  assert.equal("AI_GATEWAY_API_KEY" in (clientOptions?.env as Record<string, string>), false);
  assert.equal("ARTIFICIAL_ANALYSIS_API_KEY" in (clientOptions?.env as Record<string, string>), false);
  assert.equal(sessionConfig?.model, "gpt-6-sol");
  assert.deepEqual(sessionConfig?.allowedModels, ["gpt-6-sol"]);
  assert.equal(typeof sessionConfig?.onPermissionRequest, "function");
  const askPermission = sessionConfig!.onPermissionRequest as (request: PermissionRequest, invocation: { sessionId: string }) => Promise<unknown>;
  const request = {
    kind: "shell",
    intention: "inspect a harmless path",
    fullCommandText: "pwd",
    warning: "",
    commands: [],
    possiblePaths: [],
    possibleUrls: [],
    canOfferSessionApproval: false,
    hasWriteFileRedirection: false,
  } as PermissionRequest;
  const result = await askPermission(request, { sessionId: "created-by-jev" });
  assert.deepEqual(result, { kind: "reject", feedback: "The user declined this provider permission request." });
});

test("a failed selected provider does not try another provider, and pre-cancellation starts nothing", async () => {
  let starts = 0;
  const child = new EventEmitter() as EventEmitter & { kill: () => void };
  child.kill = () => undefined;
  await assert.rejects(executeCandidate(codex, "fail", {
    spawn: (() => {
      starts += 1;
      setImmediate(() => child.emit("close", 2, null));
      return child;
    }) as never,
    env: { PATH: "/bin" },
  }), /No other model or provider was selected/);
  assert.equal(starts, 1);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executeCandidate(codex, "cancel", {
    signal: controller.signal,
    spawn: (() => { starts += 1; return child; }) as never,
  }), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(starts, 1);
});

test("permission display omits file contents and proposed diffs", async () => {
  let displayed = "";
  const sink = { write: (value: string) => { displayed += value; return true; } } as never;
  const handler = createInteractivePermissionHandler(async () => "n", sink);
  await handler({
    kind: "write",
    intention: "Update the configuration",
    fileName: ".env.local",
    diff: "AI_GATEWAY_API_KEY=do-not-display-this-test-secret",
    newFileContents: "AI_GATEWAY_API_KEY=do-not-display-this-test-secret",
    canOfferSessionApproval: false,
  } as PermissionRequest);
  assert.match(displayed, /Update the configuration/);
  assert.match(displayed, /\.env\.local/);
  assert.equal(displayed.includes("do-not-display-this-test-secret"), false);
});
