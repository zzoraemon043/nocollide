#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { down, gc, init, list, up } from "./core.js";
import { NocollideError } from "./errors.js";
import { isIgnored } from "./git.js";

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

const HELP = `nocollide ${version}
Run parallel coding agents without collisions.

Usage:
  nocollide init [--force]        Create nocollide.json for this repository
  nocollide up [--force]          Claim a slot for this worktree and write its env file
  nocollide down                  Release the slot of this worktree
  nocollide ls                    List the slots of this repository
  nocollide gc                    Release slots whose worktree was deleted
  nocollide port <NAME>           Print one port of this worktree
  nocollide run -- <command...>   Run a command with the slot variables set

Options:
  -h, --help      Show this help
  -v, --version   Show the version
`;

function formatPorts(ports: Record<string, number>): string {
  return Object.entries(ports)
    .map(([name, port]) => `${name}=${port}`)
    .join(" ");
}

function quoteWindows(arg: string): string {
  return /^[\w\-.:/\\=@,+%]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

function runCommand(command: string[], vars: Record<string, string>): Promise<number> {
  const env = { ...process.env, ...vars };
  const [file, ...args] = command;
  if (!file) throw new NocollideError('Nothing to run. Usage: nocollide run -- <command...>');
  const child =
    process.platform === "win32"
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command.map(quoteWindows).join(" ")}"`], {
          stdio: "inherit",
          env,
          windowsVerbatimArguments: true,
        })
      : spawn(file, args, { stdio: "inherit", env });
  return new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new NocollideError(`Could not start ${file}: ${error.message}`)));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((arg) => arg.startsWith("-")));
  const force = flags.has("--force") || flags.has("-f");
  const cwd = process.cwd();

  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "-v" || command === "--version") {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  switch (command) {
    case "init": {
      const { file, config, detection } = init(cwd, { force });
      const source = detection.detected ? "Detected" : "No ports detected, using";
      console.log(`${source} ${formatPorts(config.ports)} (step ${config.step}).`);
      console.log(`Wrote ${relative(cwd, file) || file}.`);
      if (detection.hardcoded.length > 0) {
        console.log(
          `These scripts hard-code a port: ${detection.hardcoded.join(", ")}. Make them read the variable instead, or start them with "nocollide run -- <command>".`,
        );
      }
      const envTo = config.env?.to;
      if (envTo && !isIgnored(cwd, envTo)) console.log(`Add ${envTo} to .gitignore so slot values are not committed.`);
      return 0;
    }
    case "up": {
      const claim = await up(cwd, { force });
      console.log(`Slot ${claim.slot}${claim.created ? "" : " (already claimed)"} for ${claim.root}`);
      for (const [name, port] of Object.entries(claim.ports)) console.log(`  ${name}=${port}`);
      if (claim.envFile) console.log(`Wrote ${relative(cwd, claim.envFile) || claim.envFile}`);
      return 0;
    }
    case "down": {
      const result = await down(cwd);
      console.log(result.slot === undefined ? "This worktree had no slot." : `Released slot ${result.slot}.`);
      if (result.removedEnv) console.log(`Removed ${relative(cwd, result.removedEnv) || result.removedEnv}`);
      return 0;
    }
    case "ls":
    case "list": {
      const rows = await list(cwd);
      if (rows.length === 0) {
        console.log('No slots claimed in this repository. Run "nocollide up" in a worktree.');
        return 0;
      }
      const width = Math.max(...rows.map((row) => row.root.length), "WORKTREE".length);
      console.log(`SLOT  ${"WORKTREE".padEnd(width)}  PORTS`);
      for (const row of rows) {
        const note = row.current ? "  (here)" : row.exists ? "" : "  (missing, run gc)";
        console.log(`${String(row.slot).padEnd(4)}  ${row.root.padEnd(width)}  ${formatPorts(row.ports)}${note}`);
      }
      return 0;
    }
    case "gc": {
      const removed = await gc();
      if (removed.length === 0) console.log("Nothing to clean.");
      for (const entry of removed) console.log(`Released slot ${entry.slot} of ${entry.root}`);
      return 0;
    }
    case "port": {
      const name = rest.find((arg) => !arg.startsWith("-"));
      if (!name) throw new NocollideError("Usage: nocollide port <NAME>");
      const claim = await up(cwd);
      const port = claim.ports[name];
      if (port === undefined) {
        throw new NocollideError(`Unknown port "${name}". Known: ${Object.keys(claim.ports).join(", ")}`);
      }
      console.log(port);
      return 0;
    }
    case "run": {
      const separator = rest.indexOf("--");
      const commandLine = separator >= 0 ? rest.slice(separator + 1) : rest;
      const claim = await up(cwd);
      return runCommand(commandLine, claim.vars);
    }
    default:
      throw new NocollideError(`Unknown command "${command}". Run "nocollide --help".`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof NocollideError) {
      console.error(`nocollide: ${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  },
);
