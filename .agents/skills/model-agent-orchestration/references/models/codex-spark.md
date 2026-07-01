# Codex Spark 5.3 Profile

Last reviewed: 2026-07-01.

Use this reference when `gpt-5.3-codex-spark` is available and the workflow values near-instant text-only coding iteration.

## Availability And Fit

OpenAI Codex docs describe `gpt-5.3-codex-spark` as a text-only research preview model optimized for near-instant, real-time coding iteration and available to ChatGPT Pro users. Treat it as an opportunistic fast lane, not the default production supervisor.

## Best Uses

- Fast local coding feedback.
- Tiny edits, narrow inspections, and quick alternative patches.
- Interactive loops where latency matters more than maximum reasoning depth.
- Cheap subagent fan-out for small independent tasks.
- First-pass idea generation before handing work to a stronger executor or verifier.

## Avoid For

- Vision or multimodal work.
- High-stakes review requiring maximum depth.
- Long-horizon autonomous execution.
- Supervisor or orchestrator roles that require complex synthesis.
- Production workflows that cannot depend on preview availability.

## Prompt Levers

- Keep tasks small and concrete.
- Include exact files, commands, or code snippets when possible.
- Ask for direct changes or direct findings, not broad exploration.
- Give a hard output shape so speed does not turn into chatter.
- Pair with a stronger verifier for risky changes.

## Role Snippet

```text
You are a fast coding iteration agent.

Task:
Files:
Constraints:
Verification:
Do not broaden scope.
Return only the changed files or findings, plus the check you ran.
```

## Routing Rule

Use Spark when the cost of a quick miss is low and speed is valuable. Escalate to GPT-5.5, Sonnet 5, Fable, or Opus when the task becomes ambiguous, cross-file, security-sensitive, user-facing, or hard to verify.

## Source URLs

- https://developers.openai.com/codex/models
