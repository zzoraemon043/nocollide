import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, DEFAULT_STEP, loadConfig, type Config, type EnvConfig } from "./config.js";
import { detectPorts, type Detection } from "./detect.js";
import { isGenerated, renderEnv } from "./env.js";
import { NocollideError } from "./errors.js";
import { currentWorktree, mainWorktreeRoot, type Worktree } from "./git.js";
import { pathKey } from "./paths.js";
import { isPortFree } from "./ports.js";
import { withRegistry, type SlotEntry } from "./registry.js";

export const MAX_SLOTS = 100;
export const DEFAULT_ENV_TO = ".env.local";

export interface Claim {
  slot: number;
  root: string;
  ports: Record<string, number>;
  vars: Record<string, string>;
  envFile?: string;
  created: boolean;
}

export interface SlotRow extends SlotEntry {
  current: boolean;
  exists: boolean;
}

export interface InitResult {
  file: string;
  config: Config;
  detection: Detection;
}

export function slotPorts(config: Config, slot: number): Record<string, number> {
  const ports: Record<string, number> = {};
  for (const [name, base] of Object.entries(config.ports)) ports[name] = base + slot * config.step;
  return ports;
}

export function slotVars(ports: Record<string, number>, slot: number): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, port] of Object.entries(ports)) vars[name] = String(port);
  vars.NOCOLLIDE_SLOT = String(slot);
  return vars;
}

function fitsPortRange(config: Config, slot: number): boolean {
  return Object.values(slotPorts(config, slot)).every((port) => port <= 65535);
}

async function portsFree(ports: Record<string, number>): Promise<boolean> {
  for (const port of Object.values(ports)) {
    if (!(await isPortFree(port))) return false;
  }
  return true;
}

async function findSlot(config: Config, taken: Set<number>): Promise<number> {
  for (let slot = 1; slot < MAX_SLOTS && fitsPortRange(config, slot); slot += 1) {
    if (taken.has(slot)) continue;
    if (await portsFree(slotPorts(config, slot))) return slot;
  }
  throw new NocollideError("No free slot left. Run \"nocollide gc\", stop unused dev servers, or lower the base ports.");
}

function envPath(root: string, env: EnvConfig): string {
  return join(root, env.to);
}

function assertEnvWritable(root: string, env: EnvConfig | undefined, force: boolean): void {
  if (!env || force) return;
  const file = envPath(root, env);
  if (existsSync(file) && !isGenerated(readFileSync(file, "utf8"))) {
    throw new NocollideError(
      `${env.to} already exists and was not written by nocollide. Move its values into ${env.from ?? "a template"} or rerun with --force.`,
    );
  }
}

function readTemplate(roots: string[], from: string | undefined): string {
  if (!from) return "";
  const found = roots.map((root) => join(root, from)).find((file) => existsSync(file));
  return found ? readFileSync(found, "utf8") : "";
}

function writeEnv(root: string, source: string, env: EnvConfig, vars: Record<string, string>, slot: number): string {
  const template = readTemplate([root, source], env.from);
  const file = envPath(root, env);
  writeFileSync(file, renderEnv(template, vars, slot));
  return file;
}

function configFor(worktree: Worktree): { config: Config; source: string } {
  if (!worktree.isMain && !existsSync(join(worktree.root, CONFIG_FILE))) {
    const main = mainWorktreeRoot(worktree.root);
    if (main && existsSync(join(main, CONFIG_FILE))) return { config: loadConfig(main), source: main };
  }
  return { config: loadConfig(worktree.root), source: worktree.root };
}

function keys(worktree: Worktree): { repo: string; worktree: string } {
  return { repo: pathKey(worktree.repo), worktree: pathKey(worktree.root) };
}

export function init(cwd: string, options: { force?: boolean } = {}): InitResult {
  const worktree = currentWorktree(cwd);
  const file = join(worktree.root, CONFIG_FILE);
  if (existsSync(file) && !options.force) {
    throw new NocollideError(`${CONFIG_FILE} already exists. Rerun with --force to replace it.`);
  }
  const detection = detectPorts(worktree.root);
  const env: EnvConfig = detection.envFrom ? { from: detection.envFrom, to: DEFAULT_ENV_TO } : { to: DEFAULT_ENV_TO };
  const config: Config = { ports: detection.ports, step: DEFAULT_STEP, env };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return { file, config, detection };
}

export async function up(cwd: string, options: { force?: boolean } = {}): Promise<Claim> {
  const worktree = currentWorktree(cwd);
  const { config, source } = configFor(worktree);
  assertEnvWritable(worktree.root, config.env, options.force ?? false);
  const key = keys(worktree);

  const { slot, created } = await withRegistry(async (registry) => {
    const slots = (registry.repos[key.repo] ??= {});
    const existing = slots[key.worktree];
    if (existing && (!worktree.isMain || existing.slot === 0) && fitsPortRange(config, existing.slot)) {
      existing.root = worktree.root;
      existing.ports = slotPorts(config, existing.slot);
      return { slot: existing.slot, created: false };
    }
    delete slots[key.worktree];
    let chosen: number;
    if (worktree.isMain) {
      for (const [other, entry] of Object.entries(slots)) if (entry.slot === 0) delete slots[other];
      chosen = 0;
    } else {
      chosen = await findSlot(config, new Set(Object.values(slots).map((entry) => entry.slot)));
    }
    slots[key.worktree] = {
      slot: chosen,
      root: worktree.root,
      ports: slotPorts(config, chosen),
      claimedAt: new Date().toISOString(),
    };
    return { slot: chosen, created: true };
  });

  const ports = slotPorts(config, slot);
  const vars = slotVars(ports, slot);
  const claim: Claim = { slot, root: worktree.root, ports, vars, created };
  if (config.env) claim.envFile = writeEnv(worktree.root, source, config.env, vars, slot);
  return claim;
}

export async function down(cwd: string): Promise<{ slot?: number; removedEnv?: string }> {
  const worktree = currentWorktree(cwd);
  const key = keys(worktree);
  const slot = await withRegistry((registry) => {
    const slots = registry.repos[key.repo];
    const entry = slots?.[key.worktree];
    if (!slots || !entry) return undefined;
    delete slots[key.worktree];
    if (Object.keys(slots).length === 0) delete registry.repos[key.repo];
    return entry.slot;
  });
  const result: { slot?: number; removedEnv?: string } = {};
  if (slot !== undefined) result.slot = slot;
  let env: EnvConfig | undefined;
  try {
    env = configFor(worktree).config.env;
  } catch {
    env = undefined;
  }
  if (env) {
    const file = envPath(worktree.root, env);
    if (existsSync(file) && isGenerated(readFileSync(file, "utf8"))) {
      rmSync(file);
      result.removedEnv = file;
    }
  }
  return result;
}

export async function list(cwd: string): Promise<SlotRow[]> {
  const worktree = currentWorktree(cwd);
  const key = keys(worktree);
  return withRegistry((registry) =>
    Object.entries(registry.repos[key.repo] ?? {})
      .map(([id, entry]) => ({ ...entry, current: id === key.worktree, exists: existsSync(entry.root) }))
      .sort((a, b) => a.slot - b.slot),
  );
}

export async function gc(): Promise<SlotEntry[]> {
  return withRegistry((registry) => {
    const removed: SlotEntry[] = [];
    for (const [repo, slots] of Object.entries(registry.repos)) {
      for (const [id, entry] of Object.entries(slots)) {
        if (!existsSync(entry.root)) {
          removed.push(entry);
          delete slots[id];
        }
      }
      if (Object.keys(slots).length === 0) delete registry.repos[repo];
    }
    return removed.sort((a, b) => a.slot - b.slot);
  });
}
