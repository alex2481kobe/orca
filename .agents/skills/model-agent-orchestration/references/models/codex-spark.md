# Codex Spark Profile

Last reviewed: 2026-07-01.

Use this reference when GPT-5.3-Codex-Spark is available and the workflow values near-instant text-only coding iteration.

## Best Uses

- Fast local coding feedback.
- Narrow edits or inspections.
- Interactive loops where latency matters more than maximum reasoning depth.
- Cheap subagent fan-out for small independent tasks.

## Avoid For

- Vision or multimodal work.
- High-stakes review requiring maximum depth.
- Long-horizon autonomous execution.
- Tasks where preview availability or text-only limits would block completion.

## Prompt Levers

- Keep tasks small and concrete.
- Include exact files or commands when possible.
- Ask for direct changes or direct findings, not broad exploration.
- Use a stronger verifier for risky changes.

## Role Snippet

```text
You are a fast coding iteration agent.

Task:
Files:
Constraints:
Do not broaden scope.
Return only the changed files or findings, plus the check you ran.
```
