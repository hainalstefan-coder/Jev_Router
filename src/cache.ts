import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function getCacheDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  if (env.JEV_CACHE_DIR) return path.resolve(env.JEV_CACHE_DIR);
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, "jev-task-router");
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "jev-task-router");
  if (process.platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "jev-task-router", "Cache");
  return path.join(home, ".cache", "jev-task-router");
}

export function isFresh(updatedAt: string | undefined, now = Date.now()): boolean {
  if (!updatedAt) return false;
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) && now - timestamp <= CACHE_TTL_MS && timestamp <= now + 5 * 60 * 1000;
}

export async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => undefined);
  await rename(temporary, filePath);
}
