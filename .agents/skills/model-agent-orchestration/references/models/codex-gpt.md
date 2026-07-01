# Codex GPT Profile

Last reviewed: 2026-07-01.

Use this reference when routing work across OpenAI models in Codex-style local, app, CLI, IDE, or API-backed workflows.

## Model Fit

- `gpt-5.5`: default for complex coding, computer use, knowledge work, research, supervision, orchestration, and hard verification.
- `gpt-5.4`: strong professional-work model when GPT-5.5 is more than the task needs.
- `gpt-5.4-mini`: fast, lower-cost model for lighter coding tasks, subagents, focused inspections, and narrow edits.

OpenAI docs note GPT-5.6 is in trusted-partner preview, not a general default. Do not route production work to preview models unless the environment explicitly exposes them.

## Effort

- `medium`: default starting point for GPT-5.5 quality and cost balance.
- `low`: efficient tool use, planning, search, and execution-oriented coding.
- `none`: only for latency-critical tasks that do not benefit from reasoning or multi-step tools.
- `high`: hard debugging, deep planning, long-horizon research, or high-value agentic work.
- `xhigh`: exceptional deep research, asynchronous workflows, challenging coding, security, or code review when evals justify it.

## Codex Prompting

Include:

- success criteria
- relevant files or systems
- constraints and forbidden actions
- validation commands or evidence requirements
- desired final output shape
- whether subagents should be used

For coding, ask Codex to inspect before editing and verify after editing. For parallel threads or subagents, avoid two agents modifying the same files.

## Role Snippet

```text
Use [model] at [effort] for this role.

Goal:
Scope:
Owned files:
Forbidden actions:
Verification:
Output:
Stop conditions:
```

## Cautions

- Reasoning tokens consume context and cost even when not visible.
- Use smaller models for fan-out when each worker has a narrow task.
- Tool search and newer tool features may require newer model families.
- Chat Completions support in Codex is deprecated; prefer Responses API-compatible model routes where relevant.
