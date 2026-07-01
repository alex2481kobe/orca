# Claude Sonnet 5 Profile

Last reviewed: 2026-07-01.

Use this reference when a workflow may use Claude Sonnet 5 for execution, review, scoping, cost-aware orchestration, or literal pipeline stages.

## Best Uses

- Default executor for bounded coding and agentic tasks.
- Scoped reviewer or verifier where clear criteria matter.
- Cost-aware supervisor for ordinary work that does not need Fable or Opus.
- Structured extraction and API pipelines where literal instruction following is valuable.
- Frontend and design work when the visual direction is concrete.

## Prompt Levers

- State the full scope explicitly. Sonnet 5 follows instructions literally and does not silently generalize from one item to all items.
- If a rule applies globally, say it applies to every file, section, row, or output item.
- Give clear tool-use expectations: inspect relevant files before editing, use tools when they improve correctness, and run targeted checks after editing.
- Use concise verbosity guidance when needed: "Provide concise, focused responses. Skip non-essential context, and keep examples minimal."
- Use positive examples for tone or output shape.
- For review harnesses, ask for coverage first and rank/filter later if you need high recall.
- For design variety, specify a concrete visual direction or ask for options before building.

## Effort

- `high`: default and good for most coding and agentic work.
- `xhigh`: hardest coding and agentic tasks.
- `medium`: cost-sensitive work that still needs reasoning.
- `low`: short, scoped, latency-sensitive work.

Adaptive thinking is on by default. Disabling thinking can reduce tool use and search behavior. Manual extended thinking budgets are not supported.

## Role Routing

- **Executor:** Strong default. Give exact scope, negative scope, files, and verification.
- **Verifier:** Strong when criteria are explicit. Avoid vague "be conservative" prompts if recall matters.
- **Scoper:** Good for routine discovery. Ask for output shape and breadth explicitly.
- **Supervisor/orchestrator:** Good for ordinary work at high or xhigh effort, but write literal delegation and stop rules.
- **Frontend executor:** Good when given concrete palette, layout, type, and interaction direction.

## Role Snippet

```text
Apply these instructions to every file and every output section.

Role: [executor/verifier/scoper/reviewer].
Task: [specific request].
Scope: [what to do].
Do not touch: [negative scope].
Tool use: Inspect relevant files before editing. Run targeted checks after editing.
Output: [exact shape].
```

## Review Snippet

```text
Report every issue you find, including uncertain or lower-severity issues. Do not filter for importance or confidence in this stage. Include confidence and estimated severity so a later step can rank findings.
```

## Cautions

- Avoid vague filtering words like "important" or "conservative" unless you truly want fewer findings.
- Leave enough output budget for thinking and final answer on high, xhigh, or max effort.
- Revisit `max_tokens` after migrating from older Sonnet prompts because thinking and tokenizer changes can affect truncation.

## Source URLs

- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5
