# Connecting an agent client to Orca

`node src/orca-cli.js setup --roots … --connect claude` already does all of this for
Claude Code and Codex, and it is the path the README documents. This page is for
everything it does not cover: another MCP client, a second client configuration on the
same machine, wiring one by hand, and what the generated config actually contains.

Orca is a plain **stdio MCP server** with no client-specific behavior, so any
MCP-capable client can drive it.

## The one-command form

```bash
node src/orca-cli.js connect claude    # or: connect codex
node src/orca-cli.js connect claude --node /opt/homebrew/bin/node   # choose the Node it writes
node src/orca-cli.js connect claude --print                          # print the command, register nothing
```

`connect` asks the daemon this machine manages for a client config and registers it
through that client's own CLI at **user scope**, so the tools work from every
directory. It needs workstation admin: run it on the machine Orca runs on, and — if
Orca has an API token — with `ORCA_API_TOKEN` set in that command's environment.

It prints the daemon it targeted, the refresh credential id, and the Node it wrote:

```
Registered "orca" for Claude Code at user scope against Orca at http://127.0.0.1:8794
(the daemon holding <tmp>/state): refresh credential d8bd780b-… (actor
"claude-user-config"), launching /opt/homebrew/bin/node.
Restart your Claude Code sessions to load it.
```

## By hand

```bash
# Run from your Orca checkout — the package isn't published to npm, so point the
# client at the bundled bridge by absolute path.
claude mcp add -s user orca -- node "$PWD/src/mcp-server.js"
codex  mcp add orca -- node "$PWD/src/mcp-server.js"
```

Keep `-s user` on the Claude command. `claude mcp add` defaults to **local** scope,
which records the server for the one directory you ran it in — so adding it from the
Orca checkout leaves your agent with no Orca tools in every other project, with no
error to tell you why. Codex has no scope flag; `codex mcp add` already writes your
user config.

For any other client, the equivalent entry is:

```jsonc
{ "command": "node", "args": ["/absolute/path/to/orca/src/mcp-server.js"] }
```

The connection defaults to the **orchestrator** role. Executor subagents that Orca
spawns get their role and ids injected automatically — you never wire those.

The bare command above works against a loopback daemon with **no** API token: Orca
grants local admin when nothing is configured. **Once `ORCA_API_TOKEN` is set** —
which it must be before you reach the dashboard from a phone — that bootstrap is
deliberately off and the bare command gets `401 Unauthorized`. Give the agent its own
scoped credential instead:

```bash
ORCA_API_TOKEN=<your token> node "$PWD/src/orca-cli.js" connect claude
```

## Asking for the config yourself

```bash
curl -sX POST http://127.0.0.1:3000/api/mcp/orchestrator-bootstrap \
  -H "x-orca-token: $ORCA_API_TOKEN" -H 'content-type: application/json' \
  -d '{"actor":"my-agent","ttlMs":86400000}'
```

That returns paste-ready MCP config for Claude Code, Codex, and any other client, each
carrying an `ORCA_REFRESH_TOKEN`: a credential that can only obtain orchestrator
leases. Your API token never reaches the agent, and the credential can be revoked on
its own. Before you paste it:

- **It reconnects by itself.** The bridge exchanges the credential for its own lease,
  every call renews that lease, and after a long idle the bridge takes a new one and
  repeats the refused call. No config rewrite, no restart. `ttlMs` sets the lease
  window (12 hours when omitted, 24 hours at most). See
  [Connecting and reconnecting](agent-orchestrator-skill.md#connecting-and-reconnecting).
- **The returned Claude command already carries `-s user`.** The Codex command has no
  scope flag.
- **Check which Node it launches.** Every returned config runs an absolute Node plus
  Orca's bridge, so nothing has to be on your PATH. Without `nodePath`, Orca names the
  Node it runs on through its PATH entry (for example `/opt/homebrew/bin/node`) rather
  than the version-pinned install path behind it. Pass `"nodePath"` to choose one; it
  is kept exactly as given, so an alias keeps following its target.
  `bootstrap.runtime` reports the choice and `bootstrap.runtime.warnings` says when
  that Node sits inside one installed version or another tool's private directory such
  as `~/.codex`. A `nodePath` that is missing, not executable, not Node, or older than
  Node 18.18 is refused with `422`. This is the trap the README's `--node` argument
  exists for.
- **Give each separate client configuration its own `actor`.** Minting again with the
  same `actor` replaces that actor's credential and revokes every lease it issued; the
  response lists them in `bootstrap.leaseLifecycle.replacedCredentialIds` and
  `replacedLeaseIds`. A refused request (a bad `nodePath`, say) changes nothing.

## Checking it

```bash
node src/orca-cli.js doctor
```

`registration` says whether an `orca` entry exists at user scope and warns when a
local-scope entry shadows it in some directory. `launcher` names the Node and bridge
each registered client actually launches — one check per client, because a second
client can point at a different Node. `credential` says whether that client's
credential is live. `target` says whether the daemon those checks describe is the one
`start`, `stop`, `status` and `gc` act on; without it, `doctor` can print "Nothing is
failing" about a daemon you do not control.

Which agent CLIs have been measured to reach MCP tools from inside a governed lane, on
which versions: [cli-capabilities.md](cli-capabilities.md).
