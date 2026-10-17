import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { CopilotClient, type PermissionRequest, type PermissionRequestResult } from "@github/copilot-sdk";
import { providerChildEnvironment } from "./providers.js";
import type { ModelCandidate } from "./types.js";

export interface ExecutionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  spawn?: typeof nodeSpawn;
  copilotFactory?: (options: ConstructorParameters<typeof CopilotClient>[0]) => CopilotClient;
  confirmPermission?: (request: PermissionRequest) => Promise<boolean>;
}

function clip(value: string, max = 500): string {
  const singleLine = value.replace(/[\r\n\t]+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max)}…` : singleLine;
}

function permissionDescription(request: PermissionRequest): string {
  switch (request.kind) {
    case "shell":
      return [request.intention, `Command: ${request.fullCommandText}`, request.warning].filter(Boolean).join("\n");
    case "write":
      return `${request.intention}\nFile: ${request.fileName}`;
    case "read":
      return `${request.intention}\nPath: ${request.path}`;
    case "mcp":
      return `MCP server: ${request.serverName}\nTool: ${request.toolTitle || request.toolName}`;
    case "url":
      return `${request.intention}\nURL: ${request.url}${request.requestSandboxBypass ? "\nThis request asks to bypass the sandbox network restriction." : ""}`;
    case "memory":
      return `Memory permission: ${request.action ?? "operation"}`;
    case "custom-tool":
      return `Custom tool permission: ${request.toolName}`;
    case "hook":
      return "Hook execution permission requested.";
    case "extension-management":
      return `Extension management permission: ${request.operation}`;
    case "workflow":
      return `Workflow permission: ${request.description}`;
    case "extension-permission-access":
      return `Extension permission access: ${request.extensionName}`;
    case "extension-env-access":
      return `Extension environment access: ${request.extensionName}`;
    default:
      return "Provider permission requested.";
  }
}

export function createInteractivePermissionHandler(
  prompt: (message: string) => Promise<string>,
  output: NodeJS.WriteStream = process.stderr,
): (request: PermissionRequest) => Promise<PermissionRequestResult> {
  return async (request) => {
    output.write(`\nCopilot requests permission (${request.kind}).\n${clip(permissionDescription(request), 1600)}\nApprove this request once? [y/N] `);
    const answer = await prompt("");
    return /^y(?:es)?$/i.test(answer.trim())
      ? { kind: "approve-once", approvedInteractively: true }
      : { kind: "reject", feedback: "The user declined this provider permission request." };
  };
}

function waitForExit(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      child.kill("SIGTERM");
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Could not start the selected provider CLI."));
    });
    child.once("close", (code, exitSignal) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new DOMException("The operation was aborted.", "AbortError"));
      else if (code === 0) resolve();
      else reject(new Error(`The selected provider command failed (${exitSignal ?? code ?? "unknown exit"}). No other model or provider was selected.`));
    });
  });
}

async function executeCodex(candidate: ModelCandidate, task: string, options: ExecutionOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const args = ["exec", "--ephemeral", "--model", candidate.modelId, "--sandbox", "workspace-write", "--cd", cwd, "--", task];
  const child = (options.spawn ?? nodeSpawn)("codex", args, {
    cwd,
    env: providerChildEnvironment(options.env),
    stdio: ["ignore", "inherit", "inherit"],
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await waitForExit(child, options.signal);
}

async function executeCopilot(candidate: ModelCandidate, task: string, options: ExecutionOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const client = (options.copilotFactory ?? ((clientOptions) => new CopilotClient(clientOptions)))({
    workingDirectory: cwd,
    logLevel: "none",
    useLoggedInUser: true,
    env: providerChildEnvironment(options.env),
  });
  const readline = process.stdin.isTTY && process.stderr.isTTY
    ? createInterface({ input: process.stdin, output: process.stderr })
    : undefined;
  let session: Awaited<ReturnType<CopilotClient["createSession"]>> | undefined;
  try {
    await client.start();
    session = await client.createSession({
      model: candidate.modelId,
      allowedModels: [candidate.modelId],
      workingDirectory: cwd,
      onPermissionRequest: async (request) => {
        if (options.confirmPermission) {
          const approved = await options.confirmPermission(request);
          return approved
            ? { kind: "approve-once", approvedInteractively: true }
            : { kind: "reject", feedback: "The user declined this provider permission request." };
        }
        if (!readline) return { kind: "user-not-available" };
        return createInteractivePermissionHandler((message) => readline.question(message), options.stderr ?? process.stderr)(request);
      },
    });
    const onAbort = () => { void session?.abort().catch(() => undefined); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await session.sendAndWait(task);
      if (options.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      if (!response) throw new Error("Copilot returned no completed response.");
      (options.stdout ?? process.stdout).write(`${response.data.content}\n`);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  } catch {
    if (options.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    throw new Error("Copilot execution failed. Check the provider status and try again; no other model or provider was selected.");
  } finally {
    readline?.close();
    if (session) {
      await client.deleteSession(session.sessionId).catch(() => undefined);
      await session.disconnect().catch(() => undefined);
    }
    await client.stop().catch(() => undefined);
  }
}

export async function executeCandidate(candidate: ModelCandidate, task: string, options: ExecutionOptions = {}): Promise<void> {
  if (options.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  if (candidate.provider === "codex") return executeCodex(candidate, task, options);
  if (candidate.provider === "copilot") return executeCopilot(candidate, task, options);
  const provider: string = candidate.provider;
  throw new Error(`Unsupported provider: ${provider}`);
}
