import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

export interface Sandbox {
  dir: string;
  repo: string;
  home: string;
  cleanup: () => void;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "ignore",
  });
}

export function randomBase(): number {
  return 20000 + Math.floor(Math.random() * 300) * 100;
}

export function sandbox(files: Record<string, string> = {}): Sandbox {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nocollide-")));
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "test\n");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  process.env.NOCOLLIDE_HOME = home;
  return { dir, repo, home, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function addWorktree(box: Sandbox, name: string): string {
  const path = join(box.dir, name);
  git(box.repo, ["worktree", "add", "-q", "-b", name, path]);
  return path;
}

export function removeWorktree(box: Sandbox, path: string): void {
  git(box.repo, ["worktree", "remove", "--force", path]);
}

export function config(ports: Record<string, number>, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ports, step: 10, env: { from: ".env.example", to: ".env.local" }, ...extra }, null, 2)}\n`;
}

export function runCli(
  cwd: string,
  args: string[],
  home: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...process.env, NOCOLLIDE_HOME: home, FORCE_COLOR: "1" } },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}
