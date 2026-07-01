# Codex GPT-5.5 Profile

Last reviewed: 2026-07-01.

Use this reference when routing work across OpenAI models in Codex-style local, app, CLI, IDE, or API-backed workflows.

## Model Fit

- `gpt-5.5`: Codex default for complex coding, computer use, knowledge work, research, supervision, orchestration, hard verification, and product-spec-to-plan workflows.
- `gpt-5.4`: strong professional-work fallback when GPT-5.5 is more than the task needs.
- `gpt-5.4-mini`: fast, lower-cost model for lighter coding tasks, subagents, focused inspections, and narrow edits.

OpenAI docs currently describe GPT-5.5 as Codex's recommended starting point for most tasks. They describe GPT-5.3-Codex-Spark separately as a text-only research preview for near-instant iteration.

## Prompt Levers

- Use outcome-first prompts: goal, success criteria, allowed side effects, evidence rules, output shape, and stop conditions.
- Avoid carrying over every instruction from older prompt stacks. Keep only instructions that preserve the product contract.
- Let GPT-5.5 choose the efficient solution path unless the exact process matters.
- Include validation commands or explicit evidence requirements for code changes.
- For customer-facing or collaborative agents, split voice from collaboration behavior: tone is not a substitute for tool rules or stopping criteria.
- For tool-heavy Responses workflows, preserve preambles, `phase` handling, and assistant-item replay where the harness relies on them.

## Effort

- `medium`: GPT-5.5 default and recommended starting point for quality, reliability, latency, and cost.
- `low`: efficient tool use, planning, search, data analysis, execution-oriented coding, and support/chat workflows.
- `none`: only latency-critical work that does not need reasoning or multi-step tools.
- `high`: complex debugging, deep planning, long-horizon research, agentic coding, and high-value knowledge work.
- `xhigh`: exceptional asynchronous, deep research, security/code review, enterprise productivity, or challenging coding workflows when evals justify the cost.

Prefer `low` before `none` when tool use, planning, search, or multi-step decisions still matter. Higher effort can overthink when prompts have weak stopping criteria or open-ended tool access.

## Role Routing

- **Supervisor/orchestrator:** Strong default for Codex-native workflows, especially with tools, repos, long context, and code evidence.
- **Executor:** Strong for complex tasks; use GPT-5.4 or GPT-5.4-mini for simpler bounded lanes.
- **Verifier/reviewer:** Strong for high-value review; use explicit severity/confidence output and acceptance criteria.
- **Scoper:** Strong for product-spec-to-plan and repo discovery when you need a concrete plan.

## Role Snippet

```text
Use [model] at [effort] for this role.

Goal:
Success criteria:
Scope:
Allowed side effects:
Forbidden actions:
Owned files:
Evidence required:
Validation:
Output:
Stop conditions:
```

## Cautions

- Reasoning tokens are not visible, but still occupy context and are billed as output tokens.
- Use smaller models for fan-out when each worker has a narrow task.
- Responses API is preferred for reasoning models; Codex Chat Completions support is deprecated for future releases.
- Do not route production work to preview models unless the environment explicitly exposes and supports them.

## Source URLs

- https://developers.openai.com/codex/models
- https://developers.openai.com/api/docs/guides/latest-model
- https://developers.openai.com/api/docs/guides/prompt-guidance
- https://developers.openai.com/api/docs/guides/reasoning
