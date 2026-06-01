# Agent run modes

Command Deck chooses how an agent runs at lane creation time. The dashboard,
orchestrator tools, and direct API calls all write the same lane fields; the
server then derives safe argv, workdir, env, MCP config, and audit state.

## Lane fields that control agent execution

| Field | Applies to | Purpose |
| --- | --- | --- |
| `executorType` | all lanes | Chooses `mock`, `codex`, `claude`, custom `cli`, or API provider executor. |
| `taskPrompt` | Codex, Claude, API providers, custom CLI fallback | Main instruction body. Control characters are stripped before argv/API use. |
| `model` | Codex, Claude, API providers | Per-lane model override. Also supports provider/env defaults. |
| `permissionsProfile` | Codex, Claude | Per-lane run mode, such as plan/restricted/auto-edit/bypass, interpreted by the underlying CLI. |
| `mcpToolIds` | Codex, Claude, custom CLI | Attaches approved MCP tools scoped to the selected executor. |
| `targetUrl` | Codex, Claude, evidence | Saved preview or app target; validated by Command Deck URL policy. |
| `commandArgs` | CLI-backed lanes | Explicit argv tokens. Use for known-safe commands such as `--version`. |
| `executorBinary` | CLI-backed lanes | Optional binary override. Must target the selected executor and pass allowlists. |
| `workdir` | CLI-backed lanes | Execution directory. Must stay inside approved roots or the session workspace. |
| `settingsOverrides` | all lanes | Scoped product policy overrides. Cannot weaken locked defaults without approval. |

## Current adapter mapping

When `commandArgs` are not explicitly supplied, Command Deck derives argv from
lane fields:

| Executor | Derived argv |
| --- | --- |
| Codex | `--model <model>`, `--permissions <permissionsProfile>`, `--mcp-config <path>`, `--target <targetUrl>`, `--prompt <taskPrompt>` |
| Claude | `--model <model>`, `--permission-mode <permissionsProfile>`, `--mcp-config <path>`, `--print <taskPrompt>` |
| Gemini CLI | `--model <model>`, `--approval-mode <permissionsProfile>`, `--prompt <taskPrompt>`. Shared labels normalize `auto-edit` to `auto_edit` and bypass/force labels to `yolo`. |
| Composer CLI | `--model <model>`, optional `--force` for force-style modes, `--output-format text`, `-p <taskPrompt>` |
| API providers | JSON request body with `model` and prompt content; secrets resolved server-side. |
| Custom CLI | Uses explicit `commandArgs`, default args, or the task prompt as argv. Custom CLI is disabled unless explicitly configured. |

## Provider support matrix

Do not expose unverified provider-specific CLIs as first-class supported
executors. Until each CLI has argv mapping, MCP behavior, binary allowlists,
install policy, and redaction tests, use either the tested API executor or the
advanced Custom CLI adapter.

| Provider | Tested CLI executor | Tested API executor | Untested CLI path |
| --- | --- | --- | --- |
| Codex | yes, `executorType: "codex"` | no | n/a |
| Claude | yes, `executorType: "claude"` | no | n/a |
| Gemini | yes, `executorType: "gemini-cli"` | yes, `executorType: "gemini"` | Custom CLI optional for nonstandard hosts |
| Kimi | no | yes, `executorType: "kimi"` | Custom CLI only, disabled until configured and proven |
| DeepSeek | no | yes, `executorType: "deepseek"` | Custom CLI only, disabled until configured and proven |
| OpenRouter | no | yes, `executorType: "openrouter"` | Custom CLI only, disabled until configured and proven |
| Composer | yes, `executorType: "composer-cli"` using Cursor Agent CLI | yes, `executorType: "composer"` | Custom CLI optional for nonstandard hosts |

The release posture is: tested adapters are listed as supported; untested CLIs
are documented as experimental host configuration, not selectable defaults.

The exact meaning of `permissionsProfile` is owned by the selected CLI. Command
Deck stores and passes the string, but the CLI decides whether values such as
`plan`, `restricted`, `auto-edit`, or `bypass` are valid for that installed
version.

## Defaults and allowlists

Host operators can set executor defaults with environment variables:

| Variable family | Purpose |
| --- | --- |
| `COMMAND_DECK_CODEX_BINARY`, `COMMAND_DECK_CLAUDE_BINARY`, `COMMAND_DECK_GEMINI_CLI_BINARY`, `COMMAND_DECK_COMPOSER_CLI_BINARY`, `COMMAND_DECK_CLI_BINARY` | Default executable path or name. Composer CLI defaults to `cursor-agent`. |
| `COMMAND_DECK_CODEX_ALLOWED_BINARIES`, `COMMAND_DECK_CLAUDE_ALLOWED_BINARIES`, `COMMAND_DECK_GEMINI_CLI_ALLOWED_BINARIES`, `COMMAND_DECK_COMPOSER_CLI_ALLOWED_BINARIES`, `COMMAND_DECK_CLI_ALLOWED_BINARIES` | Binary allowlists. |
| `COMMAND_DECK_CODEX_DEFAULT_ARGS`, `COMMAND_DECK_CLAUDE_DEFAULT_ARGS`, `COMMAND_DECK_GEMINI_CLI_DEFAULT_ARGS`, `COMMAND_DECK_COMPOSER_CLI_DEFAULT_ARGS`, `COMMAND_DECK_CLI_DEFAULT_ARGS` | Default argv when the lane does not provide task-derived args. |
| `COMMAND_DECK_CODEX_WORKDIR_ROOTS`, `COMMAND_DECK_CLAUDE_WORKDIR_ROOTS`, `COMMAND_DECK_GEMINI_CLI_WORKDIR_ROOTS`, `COMMAND_DECK_COMPOSER_CLI_WORKDIR_ROOTS`, `COMMAND_DECK_CLI_WORKDIR_ROOTS` | Approved execution roots. |
| `COMMAND_DECK_CODEX_ENV_WHITELIST`, `COMMAND_DECK_CLAUDE_ENV_WHITELIST`, `COMMAND_DECK_GEMINI_CLI_ENV_WHITELIST`, `COMMAND_DECK_COMPOSER_CLI_ENV_WHITELIST`, `COMMAND_DECK_CLI_ENV_WHITELIST` | Extra env keys allowed into child processes. |
| `COMMAND_DECK_CODEX_MODEL`, `COMMAND_DECK_CLAUDE_MODEL`, `COMMAND_DECK_GEMINI_CLI_MODEL`, `COMMAND_DECK_COMPOSER_CLI_MODEL` | Default model metadata for provider/profile surfaces. |

## MCP tools

MCP tools are configured separately from run mode:

- Tools have executor scopes such as `codex`, `claude`, `gemini-cli`,
  `composer-cli`, `cli`, or `all`.
- Lane creation rejects unknown, disabled, or scope-mismatched tools.
- Command Deck writes a per-lane `mcp-tools.json` containing both `tools` and
  `mcpServers` shapes.
- CLI-backed executors receive `COMMAND_DECK_MCP_CONFIG=<path>` in env and,
  for Codex/Claude, `--mcp-config <path>` in derived argv.
- Tool leases are scoped by role/project/session/lane and are hashed at rest.

## High-risk modes

Modes equivalent to auto-accept edits, unrestricted execution, or bypassed
permissions should be treated as high risk:

- They must be explicit per lane or host profile, not hidden defaults.
- They should be visible in lane details and audit history.
- They must not bypass Command Deck's server-side controls: auth, same-origin
  checks, workdir roots, binary allowlists, MCP scope checks, provider-secret
  redaction, cleanup approval, and CLI install approval.
- Paired phones can operate lanes, but they are not workstation admins and
  cannot mint pairing codes, write provider secrets, change private-access
  settings, or export app data.

## Example lane payloads

Codex planning lane:

```json
{
  "title": "Plan dashboard release",
  "executorType": "codex",
  "taskPrompt": "Review the release checklist and identify blockers.",
  "model": "gpt-5",
  "permissionsProfile": "plan",
  "mcpToolIds": ["project-links"],
  "approved": true
}
```

Claude auto-edit lane, if the installed Claude CLI supports that permission
mode:

```json
{
  "title": "Fix pairing copy",
  "executorType": "claude",
  "taskPrompt": "Update the pairing copy and run focused tests.",
  "model": "claude-opus-4-7",
  "permissionsProfile": "auto-edit",
  "mcpToolIds": ["project-links", "evidence-capture"],
  "approved": true
}
```

Custom CLI lane with explicit argv:

```json
{
  "title": "Run local analyzer",
  "executorType": "cli",
  "executorBinary": "my-agent",
  "commandArgs": ["--mode", "review", "--json"],
  "approved": true
}
```
