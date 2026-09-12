# Adopter acceptance

**The promise:** clone the repo and, with ONE documented command, have a working
daemon you can register with from any directory.

This page is that walkthrough for a person. `npm run smoke:adopter-acceptance`
is the same walkthrough for a machine — it drives the real CLI in a temp HOME,
a temp state directory and on an ephemeral port, and fails the build if any step
below stops being true.

Everything here was run end to end on a fresh clone on 2026-09-11. The output
shown is real, with the long temp paths shortened to `<tmp>`.

---

## What you need

Node 18.18+ and the agent CLIs you already use. Orca does not install or manage
either.

## The walkthrough

### 1. Clone and install

```console
$ git clone https://github.com/alex2481kobe/orca.git && cd orca && npm ci

added 8 packages, and audited 9 packages in 542ms
found 0 vulnerabilities
```

### 2. The one command

```console
$ node src/orca-cli.js setup --roots "$HOME/code" --connect claude

Saved <tmp>/home/.config/orca/config.json.
  roots  <tmp>/home/code
  state  <tmp>/state/orca (from the Orca config file)
Recommended: set an API token. Without one, every process on this machine is
Orca admin and role scoping is advisory; a token is required before you pair a phone.
Orca is running: pid 53449, http://127.0.0.1:39317.
  state  <tmp>/state/orca (from the Orca config file)
  log    <tmp>/state/orca/logs/daemon.log
  fence  Agents may register and run executors under <tmp>/home/code.
  It runs in a session of its own: closing this terminal, or ending the agent
  session that ran this, does not stop it.
Registered "orca" for Claude Code at user scope against Orca at
http://127.0.0.1:39317 (the daemon holding <tmp>/state/orca): refresh credential
0f3795db-… (actor "claude-user-config"), launching /…/bin/node.
Restart your Claude Code sessions to load it.
```

That command records the fence, starts the daemon, and registers Orca with your
client at user scope so its tools work from every directory. Restart your client
sessions once; from then on they obtain and renew their own leases.

**Two flags worth knowing, neither of which appears in the usage line:**

- `--state-dir DIR` puts the state somewhere other than `~/.local/state/orca`.
  It *is* in the usage line, and `status`, `stop`, `logs` and `gc` all follow it.
- **`PORT`** — the port is taken from the `PORT` environment variable (default
  3000). `setup` has no `--port` flag, so on a machine where something already
  owns 3000 the one command is `PORT=8730 node src/orca-cli.js setup …`. `start`
  does take `--port`.

### 3. Check it, from any directory

```console
$ node src/orca-cli.js status

Orca is running: pid 53449, http://127.0.0.1:39317.
  state    <tmp>/state/orca (from the Orca config file)
  config   <tmp>/home/.config/orca/config.json
  log      <tmp>/state/orca/logs/daemon.log
  fence    Agents may register and run executors under <tmp>/home/code.
  service  not installed
```

`status` finds the daemon by its instance lock and its port — never by process
name — so it works from anywhere, including a directory outside the fence.

```console
$ node src/orca-cli.js doctor

Orca doctor (http://127.0.0.1:39317)
  ok    registration Registered at user scope for Claude Code (<tmp>/home/.claude.json).
  ok    launcher     Launches /…/bin/node with <repo>/src/mcp-server.js.
  ok    daemon       Orca is answering at http://127.0.0.1:39317.
  ok    target       The checks above describe the daemon this machine manages.
  ok    credential   Refresh credential 0f3795db-… (actor "claude-user-config") is live.
  ok    fence        Agents may register and run executors under <tmp>/home/code.
  ok    state        State in <tmp>/state/orca; owned by the running daemon, pid 53449.
  warn  api-token    ORCA_API_TOKEN is not set, so every process on this machine
                     is Orca admin and role scoping is advisory.
Nothing is failing.
```

**Read the `target` check.** It is the one that says the daemon `doctor` just
described is the same daemon `start`, `stop` and `status` act on. If your client
is wired to a different Orca, that check warns and names both — without it,
`doctor` can print "Nothing is failing" about a daemon you do not control.

### 4. Run the loop

Restart your client, then from any directory:

1. `orchestrator__register { cwd, title }` — registers you for that working
   directory. The directory must be under a fence root, or registration is
   refused and names the setup command.
2. `executor__spawn { orchestratorId, body: { title, taskPrompt, executorType,
   approved: true } }`. Two things bite first-timers, and both are in the tool
   description: an omitted `executorType` is `mock`, which runs no real agent;
   and without `approved: true` the default policy refuses the spawn with 409
   and `requiresApproval: true`.
3. `lane__get` / `lane__terminal__tail` — read what the worker produced.
4. `orchestrator__status` — the canonical "what is happening" view, and it names
   the next required tool.
5. `audit__findings__record { laneId, body: { verdict, reviewedFiles } }` —
   `verdict` is required and must be `accepted`, `fix_requested` or `blocked`.
   Accepting with no recorded review is refused.

### 5. Stop it

```console
$ node src/orca-cli.js stop
Orca stopped (pid 53449).

$ node src/orca-cli.js status
Orca is not running. Start it with: node <repo>/src/orca-cli.js start
```

`stop` refuses while executors are running unless you pass `--force`. `status`
exits 3 when nothing is running, so a script can branch on it.

---

## Running the acceptance check

```bash
npm run smoke:adopter-acceptance
```

It is hermetic — a temp HOME, a temp state directory, a temp fence root and an
ephemeral port — and it never reads or writes your `~/.claude.json`, your
`~/.codex/`, `~/Library`, or any daemon it did not start itself.

It asserts, among other things, that the client config `connect` generates names
**the daemon `setup` just started**. That is a regression guard with teeth: it
used to name a hardcoded `http://127.0.0.1:3000` instead, so on a machine
already running an Orca there, the one documented command produced a config for
the wrong daemon and the wrong checkout — and because the bootstrap replaces the
credential for its actor, it logged out the other daemon's clients.

## Related checks

| command | what it proves |
| --- | --- |
| `npm run smoke:adopter-acceptance` | the CLI first-run flow, end to end |
| `npm run smoke:onboarding` | the MCP wiring an agent gets, tokenless and tokenized |
| `npm run smoke` | the full HTTP flow against a self-hosted isolated server |
| `npm run typecheck:imports` | every import resolves |

`smoke`, `smoke:streams` and `smoke:private-access` start their own isolated
server when you run them bare. Setting `ORCA_BASE_URL` (or `--base`) points them
at a daemon you name instead, and they will then register in the current working
directory — which must be inside that daemon's fence.
