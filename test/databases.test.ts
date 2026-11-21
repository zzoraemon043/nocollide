import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { down, gc, init, list, up } from "../src/core.js";
import { composeProjectName, slotDatabaseValue } from "../src/databases.js";
import { detectPorts } from "../src/detect.js";
import { quoteName, setMysqlRunner } from "../src/mysql.js";
import { quoteIdent, setPsqlRunner } from "../src/postgres.js";
import { addWorktree, freeBase, removeWorktree, sandbox } from "./helpers.js";

function fakePostgres(existing: string[] = ["app_dev"]) {
  const databases = new Set(existing);
  const calls: string[] = [];
  setPsqlRunner(async (url, sql) => {
    calls.push(sql);
    assert.equal(new URL(url).pathname, "/postgres");
    const exists = /datname = '(.+)'$/.exec(sql);
    if (exists?.[1]) return databases.has(exists[1].replace(/''/g, "'")) ? "1" : "";
    const create = /^CREATE DATABASE "(.+?)"(?: TEMPLATE "(.+)")?$/.exec(sql);
    if (create?.[1]) {
      if (create[2] && !databases.has(create[2])) throw new Error(`psql failed: template "${create[2]}" does not exist`);
      databases.add(create[1]);
      return "";
    }
    const drop = /^DROP DATABASE IF EXISTS "(.+?)"/.exec(sql);
    if (drop?.[1]) {
      databases.delete(drop[1]);
      return "";
    }
    throw new Error(`unexpected sql: ${sql}`);
  });
  return { databases, calls };
}

async function dbConfig(extra: Record<string, unknown>): Promise<string> {
  return `${JSON.stringify({ ports: { WEB_PORT: await freeBase() }, env: { to: ".env.local" }, ...extra }, null, 2)}\n`;
}

test("slot values for postgres, redis and sqlite", () => {
  const pg = { kind: "postgres", url: "postgres://me:secret@localhost:5432/app_dev?sslmode=disable", template: true } as const;
  assert.equal(slotDatabaseValue(pg, 0), pg.url);
  assert.equal(slotDatabaseValue(pg, 2), "postgres://me:secret@localhost:5432/app_dev_s2?sslmode=disable");
  assert.equal(slotDatabaseValue({ kind: "redis", url: "redis://localhost:6379/3" }, 2), "redis://localhost:6379/5");
  assert.equal(slotDatabaseValue({ kind: "redis", url: "redis://localhost:6379" }, 1), "redis://localhost:6379/1");
  assert.equal(slotDatabaseValue({ kind: "sqlite", path: "data/dev.db" }, 4), "data/dev.db");
});

test("compose project names are valid and unique per slot", () => {
  assert.equal(composeProjectName({}, "/home/me/My App", 0), "my-app");
  assert.equal(composeProjectName({}, "/home/me/My App", 3), "my-app-s3");
  assert.equal(composeProjectName({ name: "shop" }, "/x", 1), "shop-s1");
});

test("parseConfig validates databases and compose", () => {
  const config = parseConfig({
    databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app" } },
    compose: true,
  });
  assert.deepEqual(config.ports, {});
  assert.deepEqual(config.databases, { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app", template: true } });
  assert.deepEqual(config.compose, {});
  assert.throws(() => parseConfig({ databases: { DATABASE_URL: { kind: "mongo" } } }), /"kind"/);
  assert.throws(() => parseConfig({ databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/" } } }), /name a database/);
  assert.throws(() => parseConfig({ databases: { REDIS_URL: { kind: "redis", url: "redis://localhost/x" } } }), /DB index/);
  assert.throws(() => parseConfig({ ports: { A_PORT: 3000 }, databases: { A_PORT: { kind: "sqlite", path: "a.db" } } }), /both/);
  assert.throws(() => parseConfig({ compose: "yes", ports: { A_PORT: 1 } }), /"compose"/);
});

test("init detects databases, Compose and leaves service ports alone", (t) => {
  const box = sandbox({
    ".env.example": [
      "PORT=3000",
      "DB_PORT=5432",
      "REDIS_PORT=6379",
      "DATABASE_URL=postgres://postgres:postgres@localhost:5432/shop",
      "REDIS_URL=redis://localhost:6379/0",
      "SQLITE_PATH=file:./data/dev.db",
      "SLOT_DB=postgres://localhost/app_s${SLOTENV_SLOT}",
      "API_URL=https://example.com",
      "",
    ].join("\n"),
  });
  t.after(box.cleanup);
  const detection = detectPorts(box.repo);
  assert.deepEqual(detection.ports, { PORT: 3000 });
  assert.deepEqual(detection.skipped, ["DB_PORT", "REDIS_PORT"]);
  assert.deepEqual(Object.keys(detection.databases), ["DATABASE_URL", "REDIS_URL", "SQLITE_PATH"]);
  assert.equal(detection.compose, false);

  writeFileSync(join(box.repo, "compose.yaml"), "services: {}\n");
  const withCompose = init(box.repo);
  assert.deepEqual(withCompose.config.ports, { PORT: 3000, DB_PORT: 5432, REDIS_PORT: 6379 });
  const written = JSON.parse(readFileSync(withCompose.file, "utf8"));
  assert.equal(written.compose, true);
  assert.equal(written.databases.DATABASE_URL.kind, "postgres");
});

test("postgres: each slot gets a database cloned from the template and down drops it", async (t) => {
  const pg = fakePostgres();
  t.after(() => setPsqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": await dbConfig({ databases: { DATABASE_URL: { kind: "postgres", url: "postgres://me:pw@localhost:5432/app_dev" } } }),
  });
  t.after(box.cleanup);
  const main = await up(box.repo);
  assert.equal(main.vars.DATABASE_URL, "postgres://me:pw@localhost:5432/app_dev");
  assert.deepEqual(main.createdDatabases, []);

  const worktree = addWorktree(box, "feat");
  const claim = await up(worktree);
  assert.equal(claim.vars.DATABASE_URL, "postgres://me:pw@localhost:5432/app_dev_s1");
  assert.ok(pg.databases.has("app_dev_s1"));
  assert.ok(pg.calls.includes('CREATE DATABASE "app_dev_s1" TEMPLATE "app_dev"'));
  assert.match(readFileSync(join(worktree, ".env.local"), "utf8"), /^DATABASE_URL=postgres:\/\/me:pw@localhost:5432\/app_dev_s1$/m);

  const again = await up(worktree);
  assert.deepEqual(again.createdDatabases, []);

  const released = await down(worktree);
  assert.deepEqual(released.droppedDatabases, ["postgres://me:pw@localhost:5432/app_dev_s1"]);
  assert.equal(pg.databases.has("app_dev_s1"), false);
  assert.ok(pg.databases.has("app_dev"));
});

test("postgres: template false, --keep-data and gc", async (t) => {
  const pg = fakePostgres([]);
  t.after(() => setPsqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": await dbConfig({
      databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app", template: false } },
    }),
  });
  t.after(box.cleanup);
  const a = addWorktree(box, "a");
  const b = addWorktree(box, "b");
  await up(a);
  await up(b);
  assert.ok(pg.calls.includes('CREATE DATABASE "app_s1"'));
  const kept = await down(a, { keepData: true });
  assert.deepEqual(kept.keptDatabases, ["postgres://localhost/app_s1"]);
  assert.ok(pg.databases.has("app_s1"));

  removeWorktree(box, b);
  const collected = await gc();
  assert.deepEqual(collected.droppedDatabases, ["postgres://localhost/app_s2"]);
  assert.equal(pg.databases.has("app_s2"), false);
});

test("database names too long for the server are refused before anything is created", async (t) => {
  const pg = fakePostgres([]);
  t.after(() => setPsqlRunner(undefined));
  const mysqlCalls: string[] = [];
  setMysqlRunner({
    async query(_url, sql) {
      mysqlCalls.push(sql);
      return "";
    },
    async copy() {},
  });
  t.after(() => setMysqlRunner(undefined));
  const longName = "a".repeat(61);
  const box = sandbox({
    "slotenv.json": await dbConfig({
      databases: {
        DATABASE_URL: { kind: "postgres", url: `postgres://localhost/${longName}`, template: false },
        SHOP_URL: { kind: "mysql", url: `mysql://root@127.0.0.1:3306/${"b".repeat(62)}`, template: false },
      },
    }),
  });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "long");
  await assert.rejects(up(worktree), /DATABASE_URL: database name "a{61}_s1" is 64 bytes, but Postgres allows 63/);
  assert.deepEqual(pg.calls, []);
  assert.deepEqual(mysqlCalls, []);
});

test("mysql database names over 64 characters are refused", async (t) => {
  const calls: string[] = [];
  setMysqlRunner({
    async query(_url, sql) {
      calls.push(sql);
      return "";
    },
    async copy() {},
  });
  t.after(() => setMysqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": await dbConfig({
      databases: { SHOP_URL: { kind: "mysql", url: `mysql://root@127.0.0.1:3306/${"b".repeat(62)}`, template: false } },
    }),
  });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "long");
  await assert.rejects(up(worktree), /SHOP_URL: database name "b{62}_s1" is 65 characters, but MySQL allows 64/);
  assert.deepEqual(calls, []);
});

test("sqlite: the main worktree file is copied into new worktrees", async (t) => {
  const box = sandbox({
    "slotenv.json": await dbConfig({ databases: { DATABASE_URL: { kind: "sqlite", path: "file:./data/dev.db" } } }),
    ".gitignore": "data/\n.env.local\n",
  });
  t.after(box.cleanup);
  mkdirSync(join(box.repo, "data"));
  const source = new DatabaseSync(join(box.repo, "data", "dev.db"));
  try {
    source.exec("CREATE TABLE data (value TEXT); INSERT INTO data VALUES ('seed')");
  } finally {
    source.close();
  }
  const worktree = addWorktree(box, "lite");
  const claim = await up(worktree);
  const target = join(worktree, "data", "dev.db");
  assert.deepEqual(claim.copied, [target]);
  const copied = new DatabaseSync(target);
  try {
    assert.equal(copied.prepare("SELECT value FROM data").get()?.value, "seed");
    copied.exec("UPDATE data SET value = 'changed'");
  } finally {
    copied.close();
  }
  assert.deepEqual((await up(worktree)).copied, []);
  await down(worktree);
  const original = new DatabaseSync(join(box.repo, "data", "dev.db"), { readOnly: true });
  try {
    assert.equal(original.prepare("SELECT value FROM data").get()?.value, "seed");
  } finally {
    original.close();
  }
  assert.ok(existsSync(target));
});

test("redis and compose variables reach the env file", async (t) => {
  const box = sandbox({
    "slotenv.json": await dbConfig({ databases: { REDIS_URL: { kind: "redis", url: "redis://localhost:6379/14" } }, compose: true }),
  });
  t.after(box.cleanup);
  const a = addWorktree(box, "a");
  const b = addWorktree(box, "b");
  const first = await up(a);
  assert.equal(first.vars.REDIS_URL, "redis://localhost:6379/15");
  assert.deepEqual(first.warnings, []);
  const second = await up(b);
  assert.equal(second.vars.REDIS_URL, "redis://localhost:6379/16");
  assert.match(second.warnings[0] ?? "", /Redis DB 16/);
  const env = readFileSync(join(b, ".env.local"), "utf8");
  assert.match(env, /^COMPOSE_PROJECT_NAME=repo-s2$/m);
  assert.match(env, /^REDIS_URL=redis:\/\/localhost:6379\/16$/m);
});

function databaseFixture(server: string, quote: (name: string) => string, execute: (sql: string) => string) {
  const url = new URL(server);
  const name = `slotenv_test_${randomBytes(12).toString("hex")}`;
  url.pathname = `/${name}`;
  execute(`CREATE DATABASE ${quote(name)}`);
  return { url: url.toString(), name, cleanup: () => { execute(`DROP DATABASE ${quote(name)}`); } };
}

test("database fixtures create unique databases and leave the URL database alone", () => {
  for (const [server, quote] of [["postgres://localhost/dev", quoteIdent], ["mysql://localhost/dev", quoteName]] as const) {
    const calls: string[] = [];
    const execute = (sql: string) => { calls.push(sql); return ""; };
    const first = databaseFixture(server, quote, execute);
    const second = databaseFixture(server, quote, execute);
    assert.notEqual(first.name, second.name);
    assert.equal(new URL(first.url).pathname, `/${first.name}`);
    first.cleanup();
    second.cleanup();
    assert.deepEqual(calls, [
      `CREATE DATABASE ${quote(first.name)}`, `CREATE DATABASE ${quote(second.name)}`,
      `DROP DATABASE ${quote(first.name)}`, `DROP DATABASE ${quote(second.name)}`,
    ]);
    const failed: string[] = [];
    assert.throws(() => databaseFixture(server, quote, (sql) => {
      failed.push(sql);
      throw new Error("already exists");
    }), /already exists/);
    assert.equal(failed.length, 1);
    assert.match(failed[0] ?? "", /^CREATE DATABASE /);
  }
});

const realPostgres = process.env.SLOTENV_TEST_PG_URL;

test("postgres against a real server", { skip: realPostgres ? false : "set SLOTENV_TEST_PG_URL to run" }, async (t) => {
  const admin = new URL(realPostgres!);
  if (admin.searchParams.has("dbname")) admin.searchParams.delete("dbname");
  admin.pathname = "/postgres";
  const { execFileSync } = await import("node:child_process");
  const psql = (url: string, sql: string) =>
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-c", sql], { encoding: "utf8" }).trim();
  const { url: base, name, cleanup } = databaseFixture(admin.toString(), quoteIdent, (sql) => psql(admin.toString(), sql));
  t.after(cleanup);
  psql(base, "CREATE TABLE items (id int); INSERT INTO items VALUES (1), (2)");

  const box = sandbox({ "slotenv.json": await dbConfig({ databases: { DATABASE_URL: { kind: "postgres", url: base } } }) });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "pg");
  try {
    const claim = await up(worktree);
    const slotUrl = claim.createdDatabases[0];
    assert.ok(slotUrl);
    assert.equal(psql(slotUrl, "SELECT count(*) FROM items"), "2");
    psql(slotUrl, "INSERT INTO items VALUES (3)");
    assert.equal(psql(base, "SELECT count(*) FROM items"), "2");
  } finally {
    await down(worktree);
  }
  assert.equal(psql(admin.toString(), `SELECT count(*) FROM pg_database WHERE datname = '${name}_s1'`), "0");
});

test("mysql: each slot gets a copy of the main database and down drops it", async (t) => {
  const databases = new Set(["shop"]);
  const copies: string[] = [];
  setMysqlRunner({
    async query(_url, sql) {
      const exists = /SCHEMA_NAME = '(.+)'$/.exec(sql);
      if (exists?.[1]) return databases.has(exists[1]) ? "1" : "";
      const create = /^CREATE DATABASE `(.+)`$/.exec(sql);
      if (create?.[1]) {
        databases.add(create[1]);
        return "";
      }
      const drop = /^DROP DATABASE IF EXISTS `(.+)`$/.exec(sql);
      if (drop?.[1]) {
        databases.delete(drop[1]);
        return "";
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    async copy(from, to) {
      copies.push(`${new URL(from).pathname} -> ${new URL(to).pathname}`);
    },
  });
  t.after(() => setMysqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": await dbConfig({ databases: { DATABASE_URL: { kind: "mysql", url: "mysql://root:pw@127.0.0.1:3306/shop" } } }),
  });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "my");
  const claim = await up(worktree);
  assert.equal(claim.vars.DATABASE_URL, "mysql://root:pw@127.0.0.1:3306/shop_s1");
  assert.deepEqual(copies, ["/shop -> /shop_s1"]);
  assert.ok(databases.has("shop_s1"));
  assert.deepEqual((await up(worktree)).createdDatabases, []);
  await down(worktree);
  assert.equal(databases.has("shop_s1"), false);
  assert.ok(databases.has("shop"));
});

test("mysql: a failed copy removes the half-made database", async (t) => {
  const databases = new Set<string>();
  const box = sandbox({
    "slotenv.json": await dbConfig({ databases: { DATABASE_URL: { kind: "mysql", url: "mysql://root@localhost/shop" } } }),
  });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "broken");
  let failCreate = true;
  setMysqlRunner({
    async query(_url, sql) {
      if (sql.startsWith("SELECT")) return "";
      const name = /`(.+)`/.exec(sql)?.[1] ?? "";
      if (sql.startsWith("CREATE")) {
        assert.deepEqual((await list(worktree))[0]?.databases ?? [], []);
        if (failCreate) throw new Error("could not create database");
        databases.add(name);
      }
      if (sql.startsWith("DROP")) databases.delete(name);
      return "";
    },
    async copy() {
      assert.deepEqual((await list(worktree))[0]?.databases, [{ kind: "mysql", url: "mysql://root@localhost/shop_s1", pendingImport: true }]);
      throw new Error("mysqldump failed: Unknown database 'shop'");
    },
  });
  t.after(() => setMysqlRunner(undefined));
  await assert.rejects(up(worktree), /could not create database/);
  assert.deepEqual((await list(worktree))[0]?.databases ?? [], []);
  failCreate = false;
  await assert.rejects(up(worktree), /Unknown database/);
  assert.equal(databases.size, 0);
  assert.deepEqual((await list(worktree))[0]?.databases ?? [], []);
});

const realMysql = process.env.SLOTENV_TEST_MYSQL_URL;

test("mysql against a real server", { skip: realMysql ? false : "set SLOTENV_TEST_MYSQL_URL to run" }, async (t) => {
  const { execFileSync } = await import("node:child_process");
  const parsed = new URL(realMysql!);
  const sql = (statement: string, database = "") =>
    execFileSync(
      "mysql",
      ["--protocol=TCP", "-h", parsed.hostname, "-P", parsed.port || "3306", "-u", parsed.username, "-N", "-B", ...(database ? [database] : []), "-e", statement],
      { encoding: "utf8", env: { ...process.env, MYSQL_PWD: decodeURIComponent(parsed.password) } },
    ).trim();
  const { url: base, name, cleanup } = databaseFixture(realMysql!, quoteName, sql);
  t.after(cleanup);
  sql("CREATE TABLE items (id int); INSERT INTO items VALUES (1), (2);", name);

  const box = sandbox({ "slotenv.json": await dbConfig({ databases: { DATABASE_URL: { kind: "mysql", url: base } } }) });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "mysql");
  try {
    const claim = await up(worktree);
    assert.deepEqual(claim.createdDatabases, [claim.vars.DATABASE_URL]);
    assert.equal(sql("SELECT count(*) FROM items", `${name}_s1`), "2");
    sql("INSERT INTO items VALUES (3)", `${name}_s1`);
    assert.equal(sql("SELECT count(*) FROM items", name), "2");
  } finally {
    await down(worktree);
  }
  assert.equal(sql(`SELECT count(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${name}_s1'`), "0");
});

test("init detects MySQL and MariaDB URLs", (t) => {
  const box = sandbox({
    ".env.example": "DATABASE_URL=mysql://root:root@localhost:3306/shop\nLEGACY_DB=mariadb://localhost/legacy\n",
  });
  t.after(box.cleanup);
  assert.deepEqual(detectPorts(box.repo).databases, {
    DATABASE_URL: { kind: "mysql", url: "mysql://root:root@localhost:3306/shop", template: true },
    LEGACY_DB: { kind: "mysql", url: "mariadb://localhost/legacy", template: true },
  });
});
