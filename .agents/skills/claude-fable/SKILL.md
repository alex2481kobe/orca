---
name: claude-fable
description: "Prompt and route Claude Fable 5 for high-autonomy agent work, including supervisor, orchestrator, scoper, executor, verifier, long-running coding or research, subagent coordination, cost and effort tuning, progress grounding, and migration from older Claude prompts. Use when adapting a task, skill, subagent, or agent-team prompt specifically for Fable 5 or Fable/Mythos-class Claude models."
---

# Claude Fable

## Overview

Use this skill to adapt prompts for Claude Fable 5 when the task is hard enough to benefit from long-horizon autonomy, strong delegation, ambiguity handling, and rigorous verification. Prefer smaller or cheaper models for routine work unless the user explicitly wants Fable coverage.

## Fable Fit

Use Fable for:

- Ambiguous, multi-threaded, or long-running work where the next steps must be discovered.
- Supervisor or orchestrator roles that dispatch subagents and synthesize results.
- Complex end-to-end execution where first-shot correctness matters.
- Fresh-context verification, code review, dense screenshot/vision analysis, enterprise documents, and difficult debugging.
- Experiments that compare model behavior or prompt scaffolds.

Avoid Fable for:

- Simple lookup, formatting, small copy edits, or one-file mechanical changes.
- Workloads where a faster low-cost model is already reliable.
- Prompts that ask the model to reveal, transcribe, or reproduce hidden reasoning.
- Offensive cybersecurity, exploit construction, malware, or biology/life-science lab/protocol work.

## Prompt Recipe

Build Fable prompts with these fields:

```text
Intent: Why this task matters and what the output enables.
Role: Supervisor, orchestrator, scoper, executor, verifier, or reviewer.
Scope: What to do, what not to do, and what counts as done.
Autonomy: Act once there is enough information. Pause only for destructive actions, true scope changes, or user-only input.
Delegation: Which subtasks can run in parallel and what each worker owns.
Evidence: Progress and final claims must point to tool results or explicit observations.
Budget: Effort level, expected duration, max workers, and replan triggers.
Communication: Outcome first, concise but clear, no hidden-reasoning narration.
Verification: Fresh-context verifier when risk or duration justifies it.
```

## Role Adapters

For a **supervisor**, tell Fable to own scope, lane assignment, budget, progress evidence, conflict resolution, and final acceptance. Keep execution delegated unless the task is small.

For an **orchestrator**, tell Fable to create handoff packets, dispatch independent workers, continue non-blocking local work, intervene when workers drift, and synthesize only verified results.

For a **scoper**, make the task read-only by default. Ask for assumptions, risks, acceptance criteria, task lanes, clarifying questions, and a recommended Fable/Sonnet/Codex route.

For an **executor**, add strict boundaries: do the assigned task only, avoid opportunistic refactors, validate at the relevant boundary, and return changed files plus evidence.

For a **verifier or reviewer**, use a fresh context when possible. Ask it to report every behaviorally relevant issue with severity, confidence, evidence, and whether it blocks acceptance.

## Required Guardrails

- Ask Fable to act when enough context exists; do not let it end with only a plan when execution was requested.
- For long runs, require every progress claim to be grounded in a current-session tool result.
- Tell Fable not to add features, abstractions, broad cleanup, compatibility shims, or validation that the task does not need.
- State that final summaries are for a reader who did not watch the work; lead with what happened.
- Do not mention raw token budgets to Fable unless the harness requires it. If context anxiety appears, tell it there is enough context and to continue.
- Do not ask Fable to expose chain-of-thought or hidden reasoning. Ask for decisions, evidence, tradeoffs, or a concise rationale instead.
- In autonomous pipelines, define stop rules: blocked on user-only input, destructive action needed, repeated verification failure, or safety refusal.

## Effort Policy

Use effort as the primary cost and latency control:

- `high`: default for Fable supervisor, orchestrator, complex executor, and verifier work.
- `xhigh`: hardest ambiguous, high-value, or long-horizon work where quality justifies the cost.
- `medium`: routine but still meaningful coding, research, or review.
- `low`: narrow, interactive, or latency-sensitive tasks that still benefit from Fable behavior.

Adaptive thinking is the supported mechanism for Fable-class models. Do not use manual extended-thinking budgets or prompts that request hidden reasoning text.

## References

Load `references/fable-prompt-packets.md` when you need copy-ready role prompts. Load `references/fable-notes.md` when updating this skill, comparing Fable with other models, or auditing migration concerns.
