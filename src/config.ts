import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NocollideError } from "./errors.js";

export interface EnvConfig {
  from?: string;
  to: string;
}

export interface Config {
  ports: Record<string, number>;
  step: number;
  env?: EnvConfig;
}

export const CONFIG_FILE = "nocollide.json";
export const DEFAULT_STEP = 10;

const VARIABLE = /^[A-Z_][A-Z0-9_]*$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(reason: string): NocollideError {
  return new NocollideError(`Invalid ${CONFIG_FILE}: ${reason}.`);
}

export function parseConfig(raw: unknown): Config {
  if (!isObject(raw)) throw invalid("the file must contain a JSON object");
  const { ports, step = DEFAULT_STEP, env } = raw;
  if (!isObject(ports) || Object.keys(ports).length === 0) {
    throw invalid('"ports" must map at least one name to a port, for example { "WEB_PORT": 3000 }');
  }
  const parsed: Record<string, number> = {};
  for (const [name, value] of Object.entries(ports)) {
    if (!VARIABLE.test(name)) {
      throw invalid(`port name "${name}" must be an upper-case variable name such as WEB_PORT`);
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
      throw invalid(`port "${name}" must be an integer between 1 and 65535`);
    }
    parsed[name] = value;
  }
  if (typeof step !== "number" || !Number.isInteger(step) || step < 1) {
    throw invalid('"step" must be a positive integer');
  }
  const config: Config = { ports: parsed, step };
  if (env !== undefined) {
    if (
      !isObject(env) ||
      typeof env.to !== "string" ||
      env.to === "" ||
      (env.from !== undefined && typeof env.from !== "string")
    ) {
      throw invalid('"env" must look like { "from": ".env.example", "to": ".env.local" }');
    }
    config.env = env.from ? { from: env.from, to: env.to } : { to: env.to };
  }
  return config;
}

export function loadConfig(root: string): Config {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new NocollideError(`No ${CONFIG_FILE} in ${root}. Run "nocollide init" first.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw invalid(`not valid JSON (${(error as Error).message})`);
  }
  return parseConfig(raw);
}
