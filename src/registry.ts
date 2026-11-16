import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { NocollideError } from "./errors.js";

export interface SlotEntry {
  slot: number;
  root: string;
  ports: Record<string, number>;
  claimedAt: string;
}

export interface Registry {
  version: 1;
  repos: Record<string, Record<string, SlotEntry>>;
}

const LOCK_TIMEOUT_MS = 15_000;
const STALE_LOCK_MS = 30_000;

export function homeDir(): string {
  return process.env.NOCOLLIDE_HOME || join(homedir(), ".nocollide");
}

function registryFile(dir: string): string {
  return join(dir, "slots.json");
}

function read(dir: string): Registry {
  const file = registryFile(dir);
  if (!existsSync(file)) return { version: 1, repos: {} };
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Registry;
    if (data.version !== 1 || typeof data.repos !== "object" || data.repos === null) throw new Error("unknown format");
    return data;
  } catch (error) {
    throw new NocollideError(`The slot registry ${file} is unreadable (${(error as Error).message}). Fix or delete it.`);
  }
}

function write(dir: string, registry: Registry): void {
  const file = registryFile(dir);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(temp, file);
}

async function acquire(lock: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) {
      throw new NocollideError(
        `Timed out waiting for the registry lock ${lock}. If no other nocollide command is running, delete that folder.`,
      );
    }
    await sleep(20 + Math.floor(Math.random() * 40));
  }
}

export async function withRegistry<T>(update: (registry: Registry) => T | Promise<T>): Promise<T> {
  const dir = homeDir();
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "lock");
  await acquire(lock);
  try {
    const registry = read(dir);
    const result = await update(registry);
    write(dir, registry);
    return result;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
