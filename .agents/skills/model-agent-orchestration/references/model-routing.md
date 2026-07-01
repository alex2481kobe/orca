# Model Routing

Last reviewed: 2026-07-01.

Use this reference when choosing a model, role, topology, or effort level for a multi-agent run. Verify current availability and pricing before relying on a model for production budgets.

## Default Routing

| Need | Primary route | Cheaper route | Notes |
| --- | --- | --- | --- |
| Hard supervisor or orchestrator | Claude Fable 5 or GPT-5.5 | Claude Sonnet 5 high, GPT-5.4 | Use when scope is ambiguous, multi-lane, or high-value. |
| Routine coding executor | Claude Sonnet 5 or GPT-5.4 | GPT-5.4-mini | Keep prompts literal and bounded. |
| Fast narrow subagent | GPT-5.4-mini | GPT-5.3-Codex-Spark when available | Good for inspections, small edits, and fan-out. |
| Near-instant interactive coding | GPT-5.3-Codex-Spark | GPT-5.4-mini | Spark is text-only and preview-scoped. |
| Fresh-context verifier | Claude Fable 5, Claude Sonnet 5, or GPT-5.5 | GPT-5.4-mini for low-risk checks | Use a different context from the executor when risk matters. |
| Design or frontend direction | Claude Sonnet 5 or GPT-5.5 | GPT-5.4 | Specify visual direction explicitly; avoid generic defaults. |
| Dense screenshots or technical vision | Claude Fable 5 or GPT-5.5 | Claude Sonnet 5 | Use crop/screenshot tooling where available. |

## Role Fit

| Role | Best fit | Use this when |
| --- | --- | --- |
| Supervisor | Fable 5, GPT-5.5 | The agent must judge scope, budget, verification, and replan decisions. |
| Orchestrator | Fable 5, GPT-5.5 | The agent must dispatch subagents and synthesize verified results. |
| Scoper | Fable 5 for hard ambiguity; Sonnet 5 or GPT-5.4-mini for routine discovery | You need a read-only map of unknowns, risks, and lanes. |
| Executor | Sonnet 5, GPT-5.4, GPT-5.5 for hard tasks | The task has a bounded file or behavior surface. |
| Verifier | Fable 5, Sonnet 5, GPT-5.5 | Use fresh context and explicit acceptance criteria. |
| Reviewer | Sonnet 5 or GPT-5.5; Fable 5 for deep/high-stakes review | Avoid prompts that filter too aggressively before surfacing findings. |

## Effort Policy

- Start with `medium` for GPT-5.5 and raise only when the task needs deeper planning, hard debugging, long-horizon work, or review depth.
- Use `high` as the default for Fable 5 on meaningful supervisor/orchestrator work; use `xhigh` only for the hardest, eval-worthy work.
- Sonnet 5 defaults to high effort; lower to medium or low for routine or latency-sensitive work.
- Prefer `low` before `none` for OpenAI tasks that still need tools, planning, or multi-step decisions.
- Treat `xhigh` as exceptional. It should have a concrete reason, such as high-risk review, deep architecture planning, or difficult long-running execution.

## Topology Choice

Use a single agent when:

- The task is narrow and low-risk.
- The same file set would be touched by all workers.
- Parallelism would mostly duplicate context gathering.

Use scoper -> executor -> verifier when:

- The scope is not obvious but implementation is likely.
- A wrong edit would be costly.
- You need a plan before deciding whether to execute.

Use supervisor with specialists when:

- Work splits by domain, file ownership, platform, or risk lens.
- You need one agent to manage acceptance and budget.
- Multiple agents can produce independent deliverables.

Use peer handoff or swarm only when:

- A specialist should own follow-up turns.
- Resuming with the last active specialist is useful.
- The cost of shared or persistent state is justified.

## Source Notes

- Anthropic Fable guidance emphasizes long-horizon autonomy, delegation, progress grounding, effort tuning, and avoiding hidden-reasoning extraction.
- Anthropic Sonnet guidance emphasizes literal instruction following, effort selection, tool-use nudges, and explicit review recall instructions.
- OpenAI Codex model guidance currently recommends GPT-5.5 for complex Codex work, GPT-5.4-mini for faster lower-cost tasks or subagents, and GPT-5.3-Codex-Spark for near-instant text-only iteration where available.
- Open-source orchestration patterns converge on: central supervisor, bounded handoff packets, message-history filtering, task ledgers, explicit termination criteria, and separate verification.
