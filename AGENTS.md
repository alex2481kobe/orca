# AGENTS

Operating rules for coding agents and contributors working **on this repo**.
`CLAUDE.md` is a pointer here. `README.md` explains what Orca is for a user — read it
first, then read this for how to change the code without breaking the contracts.

## What you are working in

Read the source before changing behavior; this is a working daemon, not scaffolding.

- `src/` — the Node daemon: registry, scheduler, tool-lease auth, HTTP route groups
  (`src/server-routes/`), the MCP tool contract (`src/agent-tools/`), and the
  hand-rolled stdio MCP bridge (`src/mcp-server.js`).
- `public/` — the dashboard: a static shell plus `public/ui/`. The Home screen is an
  interactive node-graph canvas of projects, orchestrators, and executor lanes.
- `test/`, `scripts/` — `node --test` suites and the `smoke:*` gates. Security-relevant
  behavior is proven here, not asserted in prose.
- `docs/` — public agent skill docs and operator runbooks.

Roles are exactly four: `orchestrator`, `executor`, `auditor`, `dashboard`
(`src/agent-tools/contract.js`). Do not invent a fifth.

## Things that are easy to get wrong

- **The dashboard is not read-only, and it is not an agent console.** It is a
  monitoring surface with deliberate break-glass controls: stop an executor, stop the
  agents under an orchestrator, close (resign) an agent. There is no chat, no prompt
  box, and no way to type into a running agent from the UI. Do not add one without
  owner review.
- **Worktree isolation is conditional.** `worktreeMode` defaults to `auto`: read-only
  and sole-writer lanes run directly in the project checkout with no worktree, and only
  overlapping writers get a dedicated isolated worktree. `lane.integrate` applies to
  isolated lanes only. Never document or assume "every executor gets its own worktree".
- **A paired remote device is an operator, not an admin.** Operators (API token,
  loopback bootstrap, or a paired browser session) get workflow reads and writes,
  including emergency-stop and resign. Admin (API token or loopback bootstrap only)
  gates workstation actions: minting pairing codes, private-access changes, revoking
  another device's session, host-level MCP credentials, fleet-wide stops, and
  unsandboxed lane permissions. Keep that split intact.
- **The server is authoritative.** Pairing, live links, tool leases, executor
  lifecycle, cleanup, and route authorization are decided server-side. A client must
  never be able to grant itself a tool the server did not lease it.

External MCP clients drive Orca as the orchestrator over `src/mcp-server.js`. It is a
plain stdio MCP server with no client-specific behavior, so any MCP-capable agent can
wire it — `claude mcp add orca -- node "$PWD/src/mcp-server.js"`,
`codex mcp add orca -- node "$PWD/src/mcp-server.js"`, or the equivalent
`{"command": "node", "args": ["<abs>/src/mcp-server.js"]}` entry. The bare wiring
defaults to the orchestrator role; spawned executors get their role and ids injected
by the lane runtime. A scoped off-origin orchestrator lease is minted by
`POST /api/mcp/orchestrator-bootstrap`, which is admin-gated on purpose.

## Public / Private Boundary

Keep this repo public-safe. Do not add internal roadmap, private task tracking,
personal workflow notes, launch chatter, or Codex/Claude coordination details here.

## Dependency Safety

- Do not add dependencies speculatively.
- When a package manager is introduced, commit the manifest and lockfile together.
- Never commit dependency directories such as `node_modules/`.
- Prefer exact pinned versions and reviewed dependency updates.
- Treat install scripts, Git dependencies, and brand-new package releases as supply-chain risks requiring inspection before use.

## Security Posture

Orca touches sensitive surfaces: local files, git repos, spawned CLI processes and their
PTYs, agent tool leases, logs and artifacts, and private network access.

- Bind local services privately by default.
- Do not expose dashboard controls publicly by default.
- Gate destructive or repo-mutating actions behind explicit policy and audit logs.
- Avoid broad shell execution where a typed command or API can do the job.
- Keep secrets, local databases, logs, and generated artifacts out of git.
- Never store provider secrets in browser storage, app state, logs, artifacts, screenshots, route inventory, service-worker cache, or MCP config. Persist only credential references or env-var names.
- Never auto-install or auto-update CLIs, package managers, browser binaries, Tailscale, credential helpers, or native runtimes by default. Managed install/update behavior requires explicit opt-in, dry-run command preview, approval, and audit logging.
- Keep Tailscale access private to the tailnet. Tailscale Funnel is not part of the security model.
- Route changes must keep the unauthenticated-access guard (`scripts/unauth-sweep-smoke.mjs`) and the matching tests/smokes green in the same logical change: every new `/api/*` route stays deny-by-default (401/403) for unauthenticated callers except the two intentionally-public endpoints (`GET /api/health`, `GET /api/auth/status`).
- Project live links are server-authoritative. Agents and the dashboard must manage them through the quick-link API/tool contract, not stale chat text.

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
