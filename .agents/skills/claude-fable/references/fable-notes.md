# Fable Notes

Last reviewed: 2026-07-01.

## Current Behavior Summary

Claude Fable 5 is strongest on hard, long-running, ambiguous, and multi-agent tasks. It benefits from prompts that explain the larger reason for the work, state boundaries, define delegation rules, and require evidence-backed progress. It can be used as a supervisor, orchestrator, executor, scoper, or verifier, but it is most valuable when the task is above the routine difficulty range.

## Migration From Older Claude Prompts

- Remove overly prescriptive step lists when the default behavior is already strong.
- Keep short instructions that steer the important behavior: act when enough context exists, avoid unrequested cleanup, ground progress claims, and pause only for real blockers.
- Audit prompts for any request to reveal or reproduce hidden reasoning. Replace with visible decisions, concise rationale, evidence, or structured summaries.
- Add explicit verification intervals for long runs, preferably with a separate fresh-context verifier.

## Cost Controls

- Use effort before prompt sprawl.
- Use `medium` or `low` for routine work where Fable is desired for consistency but maximum intelligence is unnecessary.
- Avoid broad subagent swarms. Start with 2-3 focused agents unless the work naturally splits wider.
- Prefer final-message-only worker summaries unless full history is needed for audit.
- If a task is narrow, route it to Sonnet or a smaller Codex model and reserve Fable for supervision or verification.

## Safety And Reliability

- Fable-class models may refuse offensive cybersecurity, exploit construction, malware, certain biology/life-science content, or hidden-reasoning extraction.
- Treat benign work in sensitive domains with careful scoping and fallback planning.
- For long autonomous runs, add explicit stop conditions and evidence rules.
- Use a `send_to_user` style tool in products where mid-run messages must be delivered verbatim without ending the run.

## Source URLs

- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5
- https://docs.anthropic.com/en/docs/claude-code/sub-agents
- https://code.claude.com/docs/en/agent-teams
