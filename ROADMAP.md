# Roadmap

## v0.1 - ports and env (MVP)

- [x] `nocollide init`: detect dev ports from `package.json` scripts and `.env.example`, write `nocollide.json`
- [x] Slot registry in `~/.nocollide/slots.json` with a file lock (safe when several agents start at once)
- [x] `up` / `down` / `ls` / `gc`
- [x] `run` and `port` for scripts and hard-coded dev servers
- [x] Port check: skip a slot whose port is already listening
- [x] `.env` templating with slot variables
- [x] CI on macOS, Linux and Windows
- [ ] Publish to npm

## v0.2 - databases and services

- [ ] Postgres: per-slot database cloned from a template database
- [ ] SQLite: per-slot file copy
- [ ] MySQL
- [ ] Redis: DB index per slot
- [ ] Docker Compose: per-slot project name and port overrides

## v0.3 - agent integrations

- [ ] Ready-made instructions for popular coding agents
- [ ] git `post-checkout` hook installer
- [ ] Recipes for popular worktree managers and agent orchestrators

## Launch

- [ ] 30-second demo GIF: three agents, three dev servers, three databases, no clashes
- [ ] Show HN post and agent-tooling communities
