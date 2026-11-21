import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ComposeConfig, DatabaseConfig } from "./config.js";
import { SlotenvError } from "./errors.js";
import { copyMysqlDatabase, createMysqlDatabase, dropMysqlDatabase, mysqlDatabaseExists } from "./mysql.js";
import { createDatabase, databaseExists, databaseName, withDatabase } from "./postgres.js";

export const REDIS_DEFAULT_DATABASES = 16;

export interface CreatedDatabase {
  kind: "postgres" | "mysql";
  url: string;
  ready?: boolean;
  pendingImport?: true;
}

export interface Provisioned {
  created: CreatedDatabase[];
  copied: string[];
  warnings: string[];
}

export function slotDatabaseValue(db: DatabaseConfig, slot: number): string {
  if (db.kind === "sqlite") return db.path;
  if (slot === 0) return db.url;
  if (db.kind === "postgres" || db.kind === "mysql") return withDatabase(db.url, `${databaseName(db.url)}_s${slot}`);
  const url = new URL(db.url);
  const base = Number(url.pathname.slice(1) || "0");
  url.pathname = `/${base + slot}`;
  return url.toString();
}

export function slotDatabaseVars(databases: Record<string, DatabaseConfig> | undefined, slot: number): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, db] of Object.entries(databases ?? {})) vars[name] = slotDatabaseValue(db, slot);
  return vars;
}

export function composeProjectName(compose: ComposeConfig, mainRoot: string, slot: number): string {
  const base =
    (compose.name ?? basename(mainRoot))
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "") || "app";
  return slot === 0 ? base : `${base}-s${slot}`;
}

function sqliteFile(path: string): string {
  return path.replace(/^file:(\/\/)?/, "").replace(/\?.*$/, "");
}

async function snapshotSqlite(source: string, target: string): Promise<boolean> {
  const sqlite = await import("node:sqlite").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
    throw new SlotenvError("Copying SQLite databases requires Node.js 22.13 or newer with node:sqlite enabled.");
  });
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, ".slotenv-"));
  const snapshot = join(temporary, "snapshot.db");
  try {
    const db = new sqlite.DatabaseSync(source, { readOnly: true });
    try {
      if (sqlite.backup) await sqlite.backup(db, snapshot);
      else db.prepare("VACUUM INTO ?").run(snapshot);
    } finally {
      db.close();
    }
    chmodSync(snapshot, statSync(source).mode & 0o777);
    if (existsSync(target)) return false;
    renameSync(snapshot, target);
    return true;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function assertNameFits(name: string, db: DatabaseConfig, slot: number): void {
  if (db.kind !== "postgres" && db.kind !== "mysql") return;
  const database = databaseName(slotDatabaseValue(db, slot));
  const size = db.kind === "postgres" ? Buffer.byteLength(database) : [...database].length;
  const limit = db.kind === "postgres" ? 63 : 64;
  if (size <= limit) return;
  const unit = db.kind === "postgres" ? "bytes" : "characters";
  const server = db.kind === "postgres" ? "Postgres" : "MySQL";
  throw new SlotenvError(
    `${name}: database name "${database}" is ${size} ${unit}, but ${server} allows ${limit}. Use a shorter database name in the URL.`,
  );
}

export async function provisionDatabases(
  databases: Record<string, DatabaseConfig> | undefined,
  slot: number,
  root: string,
  mainRoot: string | undefined,
  owned: (url: string) => Promise<CreatedDatabase | undefined>,
  record: (url: string, db?: CreatedDatabase) => Promise<void>,
): Promise<Provisioned> {
  const result: Provisioned = { created: [], copied: [], warnings: [] };
  if (slot === 0 || !databases) return result;
  for (const [name, db] of Object.entries(databases)) assertNameFits(name, db, slot);
  for (const [name, db] of Object.entries(databases)) {
    if (db.kind === "postgres" || db.kind === "mysql") {
      const url = slotDatabaseValue(db, slot);
      const exists = db.kind === "postgres" ? await databaseExists(url) : await mysqlDatabaseExists(url);
      const previous = await owned(url);
      const mine = previous?.ready === false ? undefined : previous;
      if (exists) {
        if (!mine) {
          if (previous) await record(url);
          result.warnings.push(
            `${name}: database ${databaseName(url)} already existed, so this slot uses it as it is and slotenv will never drop it.`,
          );
          continue;
        }
        if (!mine.pendingImport) continue;
        result.warnings.push(`${name}: the last copy into ${databaseName(url)} did not finish, so it is made again.`);
        await dropMysqlDatabase(url);
      }
      if (previous) await record(url);
      const template = db.template ? databaseName(db.url) : undefined;
      const created: CreatedDatabase = { kind: db.kind, url, ready: true };
      if (db.kind === "postgres") {
        await createDatabase(url, template);
      } else {
        await createMysqlDatabase(url);
        if (template) {
          await record(url, { kind: "mysql", url, pendingImport: true });
          try {
            await copyMysqlDatabase(url, template);
          } catch (error) {
            if (await dropMysqlDatabase(url).then(() => true, () => false)) await record(url);
            throw error;
          }
        }
      }
      await record(url, created);
      result.created.push(created);
    } else if (db.kind === "sqlite") {
      const file = sqliteFile(db.path);
      if (isAbsolute(file)) {
        result.warnings.push(`${name} points to an absolute path, so every worktree shares ${file}. Use a path inside the repository.`);
        continue;
      }
      const target = join(root, file);
      const source = mainRoot ? join(mainRoot, file) : undefined;
      if (!existsSync(target) && source && existsSync(source) && await snapshotSqlite(source, target)) {
        result.copied.push(target);
      }
    } else {
      const index = Number(new URL(slotDatabaseValue(db, slot)).pathname.slice(1));
      if (index >= REDIS_DEFAULT_DATABASES) {
        result.warnings.push(
          `${name} uses Redis DB ${index}. A default Redis server has ${REDIS_DEFAULT_DATABASES} (0-${REDIS_DEFAULT_DATABASES - 1}); raise "databases" in redis.conf.`,
        );
      }
    }
  }
  return result;
}
