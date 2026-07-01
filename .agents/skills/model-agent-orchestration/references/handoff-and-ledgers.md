# Handoff And Ledgers

Use these structures to keep multi-agent runs auditable and token-efficient.

## TaskLedger

```text
TaskLedger
- Goal:
- User intent:
- Constraints:
- Assumptions:
- Unknowns:
- Acceptance criteria:
- Risk level:
- Agent lanes:
- File ownership:
- Budget:
- Stop/replan triggers:
```

## ProgressLedger

```text
ProgressLedger
- Lane:
- Owner:
- Status: pending | in_progress | complete | blocked | failed
- Evidence:
- Checks run:
- Checks skipped:
- Open blockers:
- Next action:
```

## HandoffPacket

```text
HandoffPacket
- Destination agent:
- Model and effort:
- Reason for handoff:
- Scoped task:
- Context to load:
- Files or systems owned:
- Forbidden actions:
- Tools allowed:
- Expected output:
- Verification required:
- Budget:
- Stop conditions:
```

## VerificationReport

```text
VerificationReport
- Verifier:
- Scope checked:
- Acceptance criteria:
- Findings:
- Evidence:
- Checks run:
- Checks skipped:
- Pass/fail:
- Residual risk:
- Recommendation:
```

## BudgetPolicy

```text
BudgetPolicy
- Max workers:
- Max turns per worker:
- Max elapsed time:
- Effort level:
- Escalate model when:
- Downgrade model when:
- Stop when:
- Replan when:
```

## Good Handoff Rules

- Give workers enough context to act without pulling the full conversation.
- State one owner per lane and one reviewer or verifier when risk matters.
- Use final-message-only worker summaries unless the supervisor needs detailed trace.
- Require exact file ownership for parallel edit lanes.
- Include negative scope. A good worker prompt says what not to touch.
- Use a separate verifier for meaningful edits rather than executor self-check only.
- Close or stop workers when their result is no longer needed.
