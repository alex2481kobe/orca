# Claude Sonnet 5 Profile

Last reviewed: 2026-07-01.

Use this reference when a workflow may use Claude Sonnet 5 for execution, review, scoping, or cost-aware orchestration.

## Best Uses

- General coding execution and agentic tasks.
- Literal pipeline stages with clear instructions.
- Scoped review and verification.
- Cost-aware supervision where Fable-level autonomy is not needed.
- Frontend or design work when given concrete visual direction.

## Prompt Levers

- State the full scope explicitly; Sonnet follows instructions literally.
- If a rule applies globally, say it applies to every section, file, or output item.
- Give clear tool-use expectations for inspection and verification.
- Use positive examples for tone or output shape.
- For review harnesses, ask for coverage first and rank/filter later if you need high recall.

## Effort

- `high`: default and good for most coding/agentic work.
- `xhigh`: hardest coding or agentic tasks.
- `medium`: cost-sensitive tasks that still need reasoning.
- `low`: short, narrow, latency-sensitive work.

Adaptive thinking is on by default. Disabling thinking can reduce tool use and search behavior.

## Role Snippet

```text
Apply these instructions to every file and every output section.

Role: [executor/verifier/scoper/reviewer].
Task: [specific request].
Scope: [what to do].
Do not touch: [negative scope].
Tool use: Inspect relevant files before editing and run targeted checks afterward.
Output: [exact shape].
```

## Cautions

- Avoid vague instructions like "be conservative" in review prompts unless lower recall is intended.
- Avoid relying on non-default sampling parameters for style; steer with prompt language.
- Leave enough output budget for thinking and final answer on high effort.
