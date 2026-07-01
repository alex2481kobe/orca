# Claude Fable 5 Profile

Last reviewed: 2026-07-01.

Use this reference when a workflow may use Claude Fable 5 as supervisor, orchestrator, scoper, executor, or verifier.

## Best Uses

- Hard ambiguous tasks that need long-horizon autonomy.
- Supervisor and orchestrator roles that coordinate parallel subagents.
- Complex end-to-end execution where first-pass correctness matters.
- Fresh-context verification and deep code review outside prohibited domains.
- Dense screenshots, technical images, enterprise documents, spreadsheets, slides, and long research.

## Prompt Levers

- Give the larger intent, not only the task.
- Tell Fable to act once it has enough information.
- Bound scope explicitly to prevent overbuilding.
- Ground progress claims in tool evidence.
- Use subagents for independent lanes and keep working while they run.
- Prefer fresh-context verifier subagents over self-critique for long runs.
- Do not ask for hidden reasoning or chain-of-thought text.

## Effort

- `high`: default for meaningful Fable work.
- `xhigh`: highest-value, hardest, or longest tasks.
- `medium`: routine work where Fable is still desired.
- `low`: narrow interactive work where latency matters.

Fable uses adaptive thinking. Do not use manual thinking budgets.

## Role Snippet

```text
You are operating as [supervisor/orchestrator/scoper/executor/verifier].

Intent: [larger reason].
Task: [specific request].
Scope: [allowed work].
Out of scope: [forbidden work].
Autonomy: Act once you have enough information. Pause only for destructive actions, true scope changes, or user-only input.
Evidence: Before reporting progress or completion, audit each claim against current-session tool results.
Verification: [checks or fresh-context verifier requirement].
Output: Lead with the outcome, then concise evidence and any unresolved risk.
```

## Cautions

- Fable may run longer at higher effort. Tune effort before adding more prompt text.
- It can overplan or over-refactor if the task boundary is vague.
- It may occasionally stop after stating intent. Remind it to perform tool work before ending when execution was requested.
- It can trigger refusal behavior for offensive cybersecurity, biology/life-science lab content, and hidden-reasoning extraction.
