import assert from "node:assert/strict";
import { test } from "node:test";
import { addWorktree, config, randomBase, runCli, sandbox } from "./helpers.js";

test("parallel up calls from many worktrees never share a slot", async (t) => {
  const base = randomBase();
  const box = sandbox({ "nocollide.json": config({ WEB_PORT: base, API_PORT: base + 5000 }) });
  t.after(box.cleanup);
  const worktrees = Array.from({ length: 6 }, (_, index) => addWorktree(box, `agent-${index}`));
  const results = await Promise.all(worktrees.map((path) => runCli(path, ["up"], box.home)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const slots = results.map((result) => Number(/^Slot (\d+)/.exec(result.stdout)?.[1]));
  assert.deepEqual(
    [...slots].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6],
  );
});

test("run passes the slot variables to the command and port prints one port", async (t) => {
  const base = randomBase();
  const box = sandbox({ "nocollide.json": config({ WEB_PORT: base }) });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "runner");
  const run = await runCli(worktree, ["run", "--", "node", "-p", "process.env.WEB_PORT+':'+process.env.NOCOLLIDE_SLOT"], box.home);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout.trim(), `${base + 10}:1`);

  const port = await runCli(worktree, ["port", "WEB_PORT"], box.home);
  assert.equal(port.stdout.trim(), String(base + 10));

  const exit = await runCli(worktree, ["run", "--", "node", "-e", "process.exit(7)"], box.home);
  assert.equal(exit.code, 7);
});

test("errors are short and exit with code 1", async (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const result = await runCli(box.repo, ["up"], box.home);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^nocollide: No nocollide\.json/);
  const unknown = await runCli(box.repo, ["fly"], box.home);
  assert.match(unknown.stderr, /Unknown command "fly"/);
  const help = await runCli(box.repo, ["--help"], box.home);
  assert.match(help.stdout, /Usage:/);
});
