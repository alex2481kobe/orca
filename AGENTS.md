# AGENTS

Operating rules for coding agents and contributors working **on this repo**.
`CLAUDE.md` is a pointer here. `README.md` explains what Orca is for a user — read it
first, then read this for how to change the code without breaking the contracts.

## What you are working in

Read the source before changing behavior; this is a working daemon, not scaffolding.

- `src/` — the Node daemon: registry, scheduler, tool-lease auth, HTTP route groups
  (`src/server-routes/`), the MCP tool contract (`src/agent-tools/`), and the
  hand-rolled stdio MCP bridge (`src/mcp-server.js`).
- `public/` — the dashboard: a static shell plus `public/ui/`. Home (`#/`) is a
  WELCOME — the daemon, where its state is, and what exists; a project page
  (`#/project/<id>`) is the interactive node-graph canvas of that one project's
  orchestrators and executor lanes. The left panel is the only project switcher.
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
- **One daemon per machine, owned by no session, enforced by an instance lock.**
  The daemon keeps its state in one directory resolved by `src/orca-paths.js`
  (`ORCA_STATE_DIR`, then the config's `stateDir`, then an existing
  `<checkout>/.orca`, then `~/.local/state/orca`), never by its working
  directory. A start takes an exclusive lock on it (`<state dir>/daemon.lock`,
  see `src/instance-lock.js`) before it binds the port or reads any state. A
  second start against a running daemon's state is refused: it exits 1, names
  the owner's pid and URL, changes no state and signals no process.
  `orca-cli.js start|stop|status` find the daemon by that lock and its port,
  never by process name, and `start` runs it detached so it outlives the session
  that ran it. A stale lock is taken over only when its owner has exited or its
  pid now belongs to a process with a different start time — and only when THIS
  machine took it, judged by a stable machine identity (`src/machine-identity.js`:
  the macOS platform UUID, `/etc/machine-id`, else a UUID file in the config
  dir), never by hostname, which macOS changes with the network. When Orca cannot
  prove the owner is gone it refuses, says what this machine can see about the
  recorded pid, and points at `orca-cli.js stop --force` — never at deleting a
  lock a live daemon may still hold. `--force` is the break-glass: it stops the
  owner when the pid matches, clears the lock without signaling anything when the
  pid is absent or reused, and still refuses when the pid cannot be checked at
  all. `status` reports such a lock as `unreachable-by-lock`, never as stopped.
  The lock only defends state a *running* daemon owns. Importing `src/server.js`, as tests do,
  keeps `<cwd>/.orca` state and never reads the user's config; over a stopped
  daemon's `.orca/` it opens that state and runs interrupted-lane recovery on it.
  So develop in a separate worktree or clone, keep tests and smokes on their own
  temp state and ephemeral ports (pin `ORCA_STATE_DIR` for any daemon a test
  spawns), and never point them at port 3000 or a real state directory.
- **The fence is exact** (`src/fence.js`). Agents register, and executors run,
  only under the configured roots (`orca-cli.js setup --roots`, or
  `ORCA_REPO_ROOTS`); the daemon's working directory is never added, and no
  roots means setup-required, not a default. A test that registers agents
  declares its fixture as the fence (`test/helpers/fence-root.js`).

External MCP clients drive Orca as the orchestrator over `src/mcp-server.js`. It is a
plain stdio MCP server with no client-specific behavior, so any MCP-capable agent can
wire it — `claude mcp add -s user orca -- node "$PWD/src/mcp-server.js"`,
`codex mcp add orca -- node "$PWD/src/mcp-server.js"`, or the equivalent
`{"command": "node", "args": ["<abs>/src/mcp-server.js"]}` entry. Keep `-s user` on
the Claude form: `claude mcp add` defaults to local scope, which registers Orca for one
directory only. Codex has no scope flag. The bare wiring defaults to the orchestrator
role; spawned executors get their role and ids injected by the lane runtime. Client
configs come from `POST /api/mcp/orchestrator-bootstrap`, which is admin-gated on
purpose, usually through `node src/orca-cli.js connect claude|codex`. A config
carries a refresh credential, never a lease and never the API token. The bridge
exchanges it for its own lease (`POST /api/agent-tools/leases/refresh`); every
accepted call slides a lease forward; after a lapse the bridge gets a new lease and
repeats only the call the auth gate refused (`src/mcp-connection.js`). The
credential cannot call a tool, and orchestrator ownership follows it, not the
lease. Issuing a config again for the same actor and scope replaces the credential
and revokes every lease it issued; revoking the credential does the same. The
emitted Claude command carries `-s user`, and the Node launcher is checked before
any credential changes. `node src/orca-cli.js doctor` is the read-only check.
`test/lease-renewal.test.js`, `test/mcp-connection-errors.test.js`,
`test/orca-doctor.test.js` and `test/lease-recovery-e2e.test.js` cover the lease
flow end to end. `test/agent-tools.test.js`
checks that the docs and the bootstrap text name only live tools and that documented
Claude installs carry user scope; `test/mcp-orchestrator-bootstrap.test.js` and
`npm run smoke:mcp-cli-handshake` cover the emitted commands.

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
