import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export function pathKey(path: string): string {
  let full = resolve(path);
  try {
    full = realpathSync.native(full);
  } catch {}
  full = full.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? full.toLowerCase() : full;
}
