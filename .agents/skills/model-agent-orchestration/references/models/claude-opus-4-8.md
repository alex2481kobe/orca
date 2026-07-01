# Claude Opus 4.8 Profile

Last reviewed: 2026-07-01.

Use this reference when a workflow may use Claude Opus 4.8 for long-horizon agentic work, knowledge work, vision, memory-heavy tasks, deep review, or high-value supervision.

## Best Uses

- Long-horizon agentic work where continuity and autonomy matter.
- Knowledge work, vision, memory tasks, and dense review.
- Supervisor, scoper, verifier, and reviewer roles where deep judgment matters.
- Complex coding or agentic tasks at high or xhigh effort.
- Frontend or design work when given concrete visual direction or asked to propose options.

## Prompt Levers

- Set concise response style if the product needs short output. Opus 4.8 can produce long answers for open-ended analysis.
- Use explicit scope and global application rules. At lower effort it follows prompts literally and will not infer broad scope from one example.
- Give explicit tool-use rules. Opus can favor reasoning over tool calls unless told when and why tools should be used.
- Give explicit subagent rules. Opus tends to spawn fewer subagents by default.
- For review harnesses, ask for coverage first and severity/confidence ranking later.
- For design variety, specify the visual system or ask it to propose options before building.

## Effort

- `xhigh`: recommended starting point for most coding and agentic use cases.
- `high`: minimum for most intelligence-sensitive work.
- `medium`: cost-sensitive tasks with some intelligence tradeoff.
- `low`: short, scoped, latency-sensitive work.
- `max`: test for the hardest tasks, but watch for overthinking and diminishing returns.

Thinking is off unless explicitly set to adaptive thinking. At `xhigh` or `max`, use a large output token budget so the model has room for reasoning, tools, and subagents.

## Role Routing

- **Supervisor:** Strong for high-value judgment, but include budget, delegation, and stop rules.
- **Orchestrator:** Strong when told exactly when to spawn subagents and how many lanes to run.
- **Scoper:** Strong for ambiguous work, risk maps, and long-context synthesis.
- **Executor:** Strong for complex coding at high/xhigh. Use Sonnet or Codex for routine bounded edits.
- **Verifier/reviewer:** Strong for deep review. Avoid vague severity filters if recall matters.

## Role Snippet

```text
Role: [supervisor/orchestrator/scoper/executor/verifier].
Task:
Scope:
Apply globally to:
Tool use:
Subagent policy:
Verification:
Output:
Stop conditions:
```

## Subagent Snippet

```text
Do not spawn a subagent for work you can complete directly in one focused pass. Spawn multiple subagents in the same turn only when the work fans out across independent files, domains, or review lenses. Give each subagent narrow context, owned files, forbidden actions, and expected output.
```

## Cautions

- Opus 4.8 can use more tokens in interactive coding sessions because it reasons more after user turns.
- Higher effort can increase tool use, but it can also overthink when prompts lack stop criteria.
- Its default frontend style can skew toward warm editorial design. Specify dashboards, dev tools, fintech, healthcare, or enterprise visual systems concretely.
- Computer-use work should tune image resolution for cost and accuracy.

## Source URLs

- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8
