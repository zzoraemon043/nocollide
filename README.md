# nocollide

**Run 5 coding agents in parallel. Zero port clashes. Zero shared databases. No containers.**

> Status: early design. The CLI described below is the planned v0.1 and is not released yet. Star / watch the repo to follow along.

## The problem

Git worktrees give every agent its own copy of the **files**. They do not give it its own **runtime**:

- Agent A runs `npm run dev` on port 3000. Agent B runs it too: `EADDRINUSE`.
- Both agents run migrations against the same `app_dev` database and break each other's tests.
- `.env` is not copied into new worktrees, so the agent starts without secrets, or with the wrong ones.
- Docker Compose project names collide, and one agent's `docker compose down` kills the other's services.

Container-per-agent tools solve this, but they are heavy, slow to start, and replace your whole dev setup. nocollide is the thin layer in between.

## How it works (planned)

Each worktree gets a **slot number**. Everything else is derived from it.

```text
main worktree      slot 0   web :3000   api :4000   db app_dev
../feat-login      slot 1   web :3010   api :4010   db app_dev_s1
../fix-cart        slot 2   web :3020   api :4020   db app_dev_s2
```

```bash
npx nocollide init      # once per repo: writes nocollide.json
npx nocollide up        # in a worktree: claims a slot, writes .env.local, creates the DB
npx nocollide ls        # who is using which ports and databases
npx nocollide down      # frees the slot and drops the slot DB
npx nocollide gc        # cleans slots whose worktree was deleted
```

`nocollide.json`:

```json
{
  "ports": { "WEB_PORT": 3000, "API_PORT": 4000 },
  "step": 10,
  "env": { "from": ".env.example", "to": ".env.local" },
  "database": { "kind": "postgres", "template": "app_dev" },
  "compose": true
}
```

## Planned features

- **Ports**: deterministic per-slot ports, checked against what is actually listening before they are handed out.
- **.env**: copied from a template with slot variables filled in (`${WEB_PORT}`, `${DB_NAME}`, `${SLOT}`).
- **Databases**: Postgres (`CREATE DATABASE ... TEMPLATE`), MySQL, SQLite (file copy), Redis (DB index per slot).
- **Docker Compose**: unique `COMPOSE_PROJECT_NAME` per slot.
- **Agent integrations**: a skill / instructions file for coding agents, plus a git `post-checkout` hook, so `up` runs automatically when a worktree is created.
- **Works with any orchestrator**: it is a CLI, not a new app. Use it under your existing worktree manager or agent dashboard.

## Non-goals

- Not a worktree manager. Keep using `git worktree`, or your favourite wrapper.
- Not a sandbox. Agents still share your machine; use containers if you need security isolation.

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## License

MIT
