---
name: model-agent-orchestration
description: "Plan and prompt multi-agent work across supervisor, orchestrator, scoper, executor, verifier, reviewer, and handoff roles with model-specific routing for Claude Fable, Claude Opus, Claude Sonnet, Codex GPT-5.5, Codex Spark 5.3, or other frontier models. Use when deciding which model or agent should own a task, creating handoff packets, supervising subagents, controlling token and cost budgets, designing read-only scoping versus execution workflows, or adding a new model profile."
---

# Model Agent Orchestration

## Overview

Use this skill to turn a user goal into a controlled agent topology: who scopes, who executes, who verifies, which model each role should use, and what evidence proves completion. Keep the main path small; load model references only when a model choice or prompt adapter matters.

## Quick Workflow

1. Classify the request:
   - `answer`: no edits or subagents; answer directly.
   - `scope`: read-only discovery, risk mapping, clarifying questions, or plan.
   - `execute`: bounded implementation with verification.
   - `review`: independent audit, bug finding, or acceptance check.
   - `experiment`: compare models, prompts, or agent topologies.

2. Choose the simplest topology that fits:
   - Single agent: narrow work, one file set, low uncertainty.
   - Scoper -> executor -> verifier: default for non-trivial coding work.
   - Supervisor with specialists: independent lanes, risky changes, or several domains.
   - Parallel fan-out review: security, correctness, performance, tests, accessibility, or other separate lenses.
   - Peer handoff or swarm: only when a specialist should temporarily own the conversation or workflow state.

3. Define control objects before delegation:
   - `TaskLedger`: goal, assumptions, constraints, risks, owners, acceptance criteria.
   - `ProgressLedger`: completed work, open blockers, evidence, verification state.
   - `HandoffPacket`: destination agent, reason, scoped task, context, forbidden actions, output shape.
   - `VerificationReport`: checks run, evidence, failures, residual risk.
   - `BudgetPolicy`: model, effort, max turns, max workers, stop and replan triggers.

4. Pick models from the smallest adequate tier:
   - Read `references/model-routing.md` when choosing across providers or effort levels.
   - Read only the relevant file in `references/models/` when adapting a prompt to a named model.
   - Use deterministic rules when obvious; do not ask a model to route work that a clear policy can route.

5. Delegate with narrow context:
   - Give each worker enough task-specific context to succeed.
   - Avoid all-agents-see-all-history unless the workflow truly needs it.
   - Assign disjoint file ownership for parallel code edits.
   - Make read-only scopers and verifiers the default unless edits are explicitly needed.

6. Verify before synthesis:
   - Prefer a fresh-context verifier for meaningful changes.
   - Compare output to acceptance criteria, not only to compile status.
   - Report evidence, skipped checks, and residual risk.

## Role Defaults

- **Supervisor:** Owns scope, budget, lane assignment, conflict resolution, replan decisions, and final acceptance. It should not be the main executor unless the task is small.
- **Orchestrator:** Creates handoff packets, starts subagents, monitors progress, and synthesizes outputs. It is responsible for keeping work parallel without letting context or cost balloon.
- **Scoper:** Runs read-only discovery, identifies unknowns, drafts acceptance criteria, and recommends lanes. It must not edit unless explicitly promoted.
- **Executor:** Changes files or performs the assigned action. It owns one bounded slice and returns evidence.
- **Verifier:** Independently checks output against the spec, runs targeted tests or inspections, and reports gaps without silently fixing them unless asked.
- **Reviewer:** Finds issues across a specific lens such as security, performance, behavior, tests, or maintainability.

## Cost And Control Rules

- Do not use multiple agents for work a single agent can finish and verify cleanly.
- Use 2-3 workers for most parallel work; go above that only when lanes are independent and valuable.
- Use cheaper/faster models for narrow inspection, routine edits, and subagent fan-out.
- Reserve top-tier models for long-horizon ambiguity, complex debugging, architectural judgment, high-risk reviews, or final supervision.
- Set explicit stop conditions: max turns, max tool calls where supported, max elapsed time, unresolved blockers, conflicting findings, or test failures.
- Replan when a worker returns low evidence, drifts outside scope, touches shared files unexpectedly, or fails verification twice.

## Prompt Assembly

When producing a prompt for another agent or model, include these sections in this order:

```text
Goal:
Context:
Role:
Scope:
Forbidden actions:
Files or systems owned:
Available tools:
Budget:
Verification:
Output:
Stop conditions:
```

Use `references/handoff-and-ledgers.md` for detailed packet templates.

## References

Load references selectively:

- `references/model-routing.md`: cross-model routing, effort policy, and topology choices.
- `references/role-contracts.md`: reusable role prompts and responsibilities.
- `references/handoff-and-ledgers.md`: structured packet and ledger templates.
- `references/models/claude-fable-5.md`: Fable-specific prompt adapter and role fit.
- `references/models/claude-opus-4-8.md`: Opus-specific prompt adapter and role fit.
- `references/models/claude-sonnet-5.md`: Sonnet-specific prompt adapter and role fit.
- `references/models/codex-gpt.md`: GPT-5.5, GPT-5.4, and GPT-5.4-mini routing for Codex-style work.
- `references/models/codex-spark.md`: Spark routing for near-instant text-only coding iteration.
