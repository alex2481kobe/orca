# Agent CLI capabilities — measured, not assumed

Orca drives whichever agent CLI you already run. This page records what we have
actually **measured**, on named versions, so nobody has to take a claim on trust.

Everything here is produced by a script you can re-run:

```bash
npm run verify:cli-capabilities
```

It spawns each installed CLI for real against a tiny local MCP server and checks
whether the tool call genuinely arrives. It is opt-in (not in CI) because it costs
real tokens. **It exits non-zero when observed behavior stops matching this page —
including when a limitation gets fixed upstream** — so this document fails loudly
instead of rotting.

## Measured results

Last run: **2026-07-25**.

| CLI | version | Reaches MCP tools in a governed lane | Notes |
|---|---|---|---|
| Codex | `codex-cli 0.144.5` | **yes** — verified under both `--sandbox read-only` and `--sandbox workspace-write` | MCP servers wired with `-c mcp_servers.<name>.*` |
| Claude Code | `2.1.220` | **yes** | MCP servers from `--mcp-config`; approvals answered programmatically via `--permission-prompt-tool` |

**Neither CLI is preferred.** Both are first-class executors, and both can call back
into Orca's MCP tools mid-run on the versions above.

## Correction to earlier documentation

Orca previously documented that a sandboxed `codex exec` **could not** call MCP tools
("user cancelled MCP tool call") and pointed at
[openai/codex#24135](https://github.com/openai/codex/issues/24135) and
[#16685](https://github.com/openai/codex/issues/16685). Re-testing with a correct
harness on codex-cli 0.144.5 shows that is **not** the behavior here: Codex called the
probe tool under both sandbox levels, reporting `mcp: probe/probe_marker started` /
`(completed)`.

The earlier conclusion came from a faulty measurement, and it had leaked into guidance
telling people to prefer one CLI or to hand executors full sandbox access. Both are
withdrawn. If you hit a cancellation on some other version or configuration, re-run the
script above and update this table — that is what it is for.

## Why a CLI limitation would not break Orca anyway

Orca never depends on a spawned agent phoning home:

- **Process exit is the authoritative completion signal** (`src/executor/cli-adapter.js`).
- The daemon spawns the child, so it captures stdout/JSONL and the exit code directly.

MCP callback is a convenience for richer mid-run reporting, not the completion path. An
executor that cannot reach MCP still runs, still completes, and is still audited.

## Known CLI-specific quirks

- A sandboxed `codex exec` cannot bind localhost ports. If a lane needs to serve a dev
  server for a preview URL, give that lane the access it needs explicitly.
- `codex exec` has no `-a/--ask-for-approval` flag (that is on the interactive `codex`
  only); passing it fails with exit 2. Use `-c approval_policy=...`.
- `claude --allowed-tools` is variadic: put the prompt **before** it, or the prompt is
  swallowed as another tool name.
