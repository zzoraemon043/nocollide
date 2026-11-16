# Roadmap

## v0.1 – ports and env (MVP)

- [ ] `nocollide init`: detect common dev ports from `package.json` scripts and `.env.example`, write `nocollide.json`
- [ ] Slot registry in `~/.nocollide/slots.json` with a file lock (safe when several agents start at once)
- [ ] `up` / `down` / `ls` / `gc`
- [ ] Port check: skip a port that is already listening
- [ ] `.env` templating with slot variables
- [ ] Works on macOS, Linux and Windows

## v0.2 – databases and services

- [ ] Postgres: per-slot database cloned from a template database
- [ ] SQLite: per-slot file copy
- [ ] MySQL
- [ ] Redis: DB index per slot
- [ ] Docker Compose: per-slot project name and port overrides

## v0.3 – agent integrations

- [ ] Skill / instructions file for coding agents
- [ ] git `post-checkout` hook installer
- [ ] Recipes for popular worktree managers and agent orchestrators

## Launch

- [ ] 30-second demo GIF: three agents, three dev servers, three databases, no clashes
- [ ] Show HN post and agent-tooling communities
