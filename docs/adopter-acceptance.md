# The setup path, with its real output

**The promise:** clone the repo and, with **one** documented command, have a working
daemon your agent CLI can drive.

This page is that path for a person, with the actual output of every command.
`npm run smoke:adopter-acceptance` is the same path for a machine — it drives the real
CLI in a temp HOME, a temp state directory, a temp fence root and on an ephemeral
port, and fails the build if any step below stops being true.

Everything here was run end to end on a **fresh clone on 2026-09-12**, on macOS with
Node v26.8.2. The output is real. Two edits were made to it: long temp paths are
shortened to `<tmp>`, and the long absolute `node …/orca-cli.js` prefix Orca prints
inside its own fix commands is shortened to `node src/orca-cli.js`. Nothing else is
paraphrased. The run pinned `--port 8794` and `--state-dir <tmp>/state` so it could not
touch a real Orca on the same machine; **you need neither flag** — the defaults are
port 3000 and `~/.local/state/orca`.

---

## What you need

Node ≥ 18.18.0, git, and whichever agent CLIs you intend to drive — installed and
already logged in. Orca launches them; it does not install them or authenticate them.
See the README's [requirements table](../README.md#what-you-need-before-you-start).

## 1. Clone and install

```console
$ git clone https://github.com/alex2481kobe/orca.git && cd orca && npm ci
added 8 packages, and audited 9 packages in 3s
found 0 vulnerabilities
```

## 2. The one command

```console
$ node src/orca-cli.js setup --roots "$HOME/code" --connect claude --node /opt/homebrew/bin/node
Saved <tmp>/home/.config/orca/config.json.
  roots  <tmp>/home/code
  state  <tmp>/state (from the Orca config file)
  Orca's own checkout (<tmp>/clone) is not under these roots, so agents cannot orchestrate work on Orca itself. To allow it, add it to --roots.
Orca is running: pid 2288, http://127.0.0.1:8794.
  state  <tmp>/state (from the Orca config file)
  log    <tmp>/state/logs/daemon.log
  fence  Agents may register and run executors under <tmp>/home/code (from the Orca config file).
  It runs in a session of its own: closing this terminal, or ending the agent session that ran this, does not stop it.
  Stop it with: node src/orca-cli.js stop
Recommended: set an API token. Without one, every process on this machine is Orca admin and role scoping is advisory; a token is required before you pair a phone.
  Keep it in a file only you can read: (umask 077; openssl rand -hex 32 > ~/.config/orca/api-token)
  then run Orca with ORCA_API_TOKEN_FILE=~/.config/orca/api-token (for the LaunchAgent: service install --token-file ~/.config/orca/api-token).
  Agents never get the token: `connect` gives each client its own scoped credential.
Registered "orca" for Claude Code at user scope against Orca at http://127.0.0.1:8794 (the daemon holding <tmp>/state): refresh credential d8bd780b-4818-4414-bb0d-5ebbbbc8a607 (actor "claude-user-config"), launching /opt/homebrew/bin/node.
Restart your Claude Code sessions to load it. From then on they obtain and renew their own leases; nothing needs re-running.
Check it any time with: node src/orca-cli.js doctor
```

One command records the fence, starts the daemon in a session of its own, and
registers Orca with your client at user scope so its tools work from every directory.
Restart your client sessions once; from then on they obtain and renew their own leases.

**It worked** when you see `Orca is running: pid …, http://127.0.0.1:…` and
`Registered "orca" for … at user scope`. The credential id it prints is an id, not a
secret — the credential itself goes only into the client config.

**Flags worth knowing.**

- `--node PATH` is the Node written into your client's MCP config. Pass one *you*
  maintain — see
  [the Node path Orca writes down](../README.md#the-node-path-orca-writes-down).
  Without it, Orca picks the Node it is running on, named through its PATH alias.
- `--port N` moves the daemon off 3000, and so does the `PORT` environment variable
  (`--port` wins). `start` takes `--port` too.
- `--state-dir DIR` puts the state somewhere other than `~/.local/state/orca`;
  `status`, `stop`, `logs` and `gc` all follow it.
- `--no-start` records the fence and starts nothing, for the LaunchAgent flow.
- `--allow-home-root` is required to name your whole home directory as a root. Orca
  records the choice and keeps warning about it.

## 3. Check it, from any directory

```console
$ node src/orca-cli.js status
Orca is running: pid 2288, http://127.0.0.1:8794.
  state    <tmp>/state (from the Orca config file)
  config   <tmp>/home/.config/orca/config.json
  log      <tmp>/state/logs/daemon.log
  fence    Agents may register and run executors under <tmp>/home/code (from the Orca config file).
  service  not installed
```

`status` finds the daemon by its instance lock and its port — never by process name —
so it works from anywhere, including a directory outside the fence. It exits `0` when
the daemon is running and `3` when nothing is, so a script can branch on it.

```console
$ node src/orca-cli.js doctor
Orca doctor (http://127.0.0.1:8794)
  ok    registration Registered at user scope for Claude Code (<tmp>/home/.claude.json).
  ok    launcher     Launches /opt/homebrew/bin/node (v26.8.2) with <tmp>/clone/src/mcp-server.js.
  ok    node         The Node connect and service install would write down, /opt/homebrew/bin/node, is not inside another tool's directory or one installed Node version, so connect and service install can write it down safely.
  ok    daemon       Orca is answering at http://127.0.0.1:8794.
  ok    target       The checks above describe the daemon this machine manages (http://127.0.0.1:8794, state in <tmp>/state).
  ok    credential   Refresh credential d8bd780b-4818-4414-bb0d-5ebbbbc8a607 (actor "claude-user-config") is live. This client obtains its own leases; they renew while used and are replaced by the bridge after they lapse.
  ok    fence        Agents may register and run executors under <tmp>/home/code (from the Orca config file).
  ok    state        State in <tmp>/state (from the Orca config file); owned by the running daemon, pid 2288.
  warn  api-token    ORCA_API_TOKEN is not set, so every process on this machine is Orca admin and role scoping is advisory.
                     fix: when no executors are running: node src/orca-cli.js stop, then ORCA_API_TOKEN="$(openssl rand -hex 32)" node src/orca-cli.js start (keep the token out of git and plists)
Nothing is failing.
```

**It worked** when the last line is `Nothing is failing.` The `api-token` warning is
the expected default on a fresh install, not damage — see
[Security defaults](../README.md#security-defaults). `doctor` writes nothing, renews
nothing, and never starts or stops Orca. It exits 1 when a check FAILs.

**Read the `node` check.** It judges exactly the path `connect` and `service install`
would write next; `doctor --node /path/to/node` asks the same question about a path
you are considering.

**Read the `target` check.** It is the one that says the daemon `doctor` just described
is the same daemon `start`, `stop`, `status` and `gc` act on. If your client is wired
to a different Orca, that check warns and names both — without it, `doctor` can print
"Nothing is failing" about a daemon you do not control.

**Run `doctor` after `setup`, not before.** Until you have a daemon of your own it
falls back to the port this installation *would* start on, so on a machine where
somebody else's Orca already answers on 3000 the `daemon` and `target` checks describe
that one. After `setup` both are found through your state directory's instance lock,
which is what the transcript above shows.

## 4. Run the loop

Restart your client. These are the tool calls it then makes; the output below came from
the bridge in the config `setup` had just written, driven against that daemon.

```console
> orchestrator__register { cwd: "$HOME/code/demo-project", title: "Docs walkthrough" }
{
  "id": "orc_b57bcc33-ee88-4f2b-9762-3cfe052b7cd3",
  "projectId": "prj_578d342f5497",
  "title": "Docs walkthrough"
}

> executor__spawn { orchestratorId, body: { title: "Scout", executorType: "mock", approved: true, taskPrompt: "read the README" } }
{
  "id": "d1f5fdcb-48ee-4eea-82b5-a555e49f4e3d",
  "state": "queued",
  "worktreeMode": "direct"
}

> lane__get { laneId }
{
  "id": "d1f5fdcb-48ee-4eea-82b5-a555e49f4e3d",
  "state": "done",
  "changedFiles": [],
  "resultText": ""
}

> orchestrator__status { orchestratorId }
{
  "nextRequiredTool": "audit.queue_one",
  "lanes": [
    { "id": "d1f5fdcb-48ee-4eea-82b5-a555e49f4e3d", "title": "Scout", "state": "done" }
  ]
}

> audit__findings__record { laneId, body: { verdict: "accepted", reviewedFiles: ["README.md"] } }
{
  "laneId": "d1f5fdcb-48ee-4eea-82b5-a555e49f4e3d",
  "verdict": "accepted",
  "state": "accepted"
}
```

Four things bite first-timers, and all four are in the tool descriptions:

1. **`cwd` must be under a fence root**, or registration is refused and names the setup
   command.
2. **An omitted `executorType` is `mock`**, which runs no real agent. That is what this
   walkthrough uses on purpose; pass `claude` or `codex` for real work.
3. **Without `approved: true`** the default policy refuses the spawn with `409` and
   `requiresApproval: true`.
4. **`verdict` is required** on `audit__findings__record`, and must be `accepted`,
   `fix_requested` or `blocked`. Accepting with no recorded review is refused.

`worktreeMode: "direct"` above is the default `auto` policy deciding this lane needed
no isolation: only overlapping writers get a dedicated worktree.
`orchestrator__status` is the canonical "what is happening" view, and it names the next
required tool.

## 5. Clean up, and stop

```console
$ node src/orca-cli.js gc
Orca gc (dry run: nothing is changed; add --apply to move what is listed)
  state directory: <tmp>/state
  state.json 16 KB · state.json.bak 5 KB · lanes/ 2 KB · archive/ 0 KB · artifacts/ (outside the state dir, not managed) 4 KB
  nothing to do.
Note: a daemon owns this state directory (pid 2288, listening on http://127.0.0.1:8794). This plan reads the last state it persisted; --apply refuses until it stops.

$ node src/orca-cli.js stop
Orca stopped (pid 2288).

$ node src/orca-cli.js status
Orca is not running. Start it with: node src/orca-cli.js start
  state    <tmp>/state (from the Orca config file)
  config   <tmp>/home/.config/orca/config.json
  log      <tmp>/state/logs/daemon.log
  fence    Agents may register and run executors under <tmp>/home/code (from the Orca config file).
  service  not installed
```

`gc` is a dry run unless you pass `--apply`, and `--apply` only *moves* things into the
state directory's `archive/` — deleting needs `--purge-archive` and an age. The whole
retention table is [state-retention.md](state-retention.md).

`stop` refuses while executors are running unless you pass `--force`.

---

## Running the acceptance check

```bash
npm run smoke:adopter-acceptance
```

It is hermetic — a temp HOME, a temp state directory, a temp fence root and an
ephemeral port — and it never reads or writes your `~/.claude.json`, your `~/.codex/`,
`~/Library`, or any daemon it did not start itself.

It asserts, among other things:

- that the client config `connect` generates names **the daemon `setup` just started**.
  That is a regression guard with teeth: it used to name a hardcoded
  `http://127.0.0.1:3000`, so on a machine already running an Orca there, the one
  documented command produced a config for the wrong daemon and the wrong checkout —
  and because the bootstrap replaces the credential for its actor, it logged out the
  other daemon's clients;
- that `--port` beats `PORT` in the environment. It runs with a *different* `PORT` set,
  so the flag cannot pass vacuously;
- that the client config launches the Node `--node` named, not whatever Node the CLI
  happened to be running on.

## Related checks

| command | what it proves |
| --- | --- |
| `npm run smoke:adopter-acceptance` | the CLI first-run flow, end to end |
| `npm run smoke:onboarding` | the MCP wiring an agent gets, tokenless and tokenized |
| `npm run smoke` | the full HTTP flow against a self-hosted isolated server |
| `npm run typecheck:imports` | every import resolves |

`smoke`, `smoke:streams` and `smoke:private-access` start their own isolated server
when you run them bare. Setting `ORCA_BASE_URL` (or `--base`) points them at a daemon
you name instead, and they will then register in the current working directory — which
must be inside that daemon's fence.
