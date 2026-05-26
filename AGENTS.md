# AGENTS

Canonical project guide for coding agents and contributors working in this repo. `CLAUDE.md` is a pointer here.

## Project

Command Deck is planned as a local-first control plane for coordinating AI coding agents, project sessions, worker lanes, browser evidence, logs, artifacts, and review actions from one dashboard.

This repo is currently scaffold-only. Do not assume an app stack, runtime, package manager, or architecture exists until those files are added intentionally.

## Public / Private Boundary

Keep this repo public-safe. Do not add internal roadmap, private task tracking, personal workflow notes, launch chatter, or Codex/Claude coordination details here.

Private planning belongs in the non-git parent workspace.

## Dependency Safety

- Do not add dependencies speculatively.
- When a package manager is introduced, commit the manifest and lockfile together.
- Never commit dependency directories such as `node_modules/`.
- Prefer exact pinned versions and reviewed dependency updates.
- Treat install scripts, Git dependencies, and brand-new package releases as supply-chain risks requiring inspection before use.

## Security Posture

Command Deck will eventually touch sensitive surfaces: local files, git repos, shells, browsers, agent sessions, logs, screenshots, videos, and private network access.

- Bind local services privately by default.
- Do not expose dashboard controls publicly by default.
- Gate destructive or repo-mutating actions behind explicit policy and audit logs.
- Avoid broad shell execution where a typed command or API can do the job.
- Keep secrets, local databases, logs, and generated artifacts out of git.

## Command Shape

- Prefer direct executable calls for approved tools such as `rg`, `grep`, `find`, `cat`, `git`, `npm`, and test commands.
- Do not wrap simple commands in `/bin/zsh -lc`, `bash -lc`, `sh -c`, or similar shell launchers unless shell behavior is actually required, such as compound control flow, redirection, expansion, or environment setup.
- Shell wrappers are intentionally prompt-gated because they can hide arbitrary work behind a generic shell command.
- For searches, call `rg` directly with quoted patterns and explicit paths. Use `grep` mainly for small single-file searches or portability fallback.

## Coding Guidelines

### Think Before Coding

- State assumptions explicitly.
- If multiple interpretations exist, name them instead of silently picking one.
- If a simpler approach exists, say so.
- Push back when a requested change would make the project worse.
- If something is unclear and a wrong guess would be costly, stop and ask.

### Simplicity First

- Write the minimum code that solves the assigned problem.
- Do not add features, extension points, settings, or abstractions that were not requested.
- Do not create a new system for a single-use case.

### Surgical Changes

- Touch only what the task requires.
- Match existing style and local patterns.
- Do not refactor adjacent code just because it looks tempting.
- If unrelated issues are discovered, record them for a later task instead of sweeping them into the current change.

### Goal-Driven Execution

- Define success criteria before implementation.
- For bugs, prefer a failing test or clear repro before the fix.
- For refactors, preserve behavior and run relevant checks before and after when practical.
