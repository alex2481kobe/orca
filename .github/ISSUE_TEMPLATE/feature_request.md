---
name: Feature request
about: Propose a new capability or improvement for Orca
title: "[Feature]: "
labels: enhancement
assignees: ""
---

## Use case

What are you trying to accomplish? Describe the workflow or problem this
feature would address.

## Proposed behavior

What should Orca do? Describe the feature from the operator's point of view.

## Alternatives considered

What workarounds or alternatives have you tried or ruled out?

## Scope and safety

- Does this touch privileged surfaces (executor spawning, shell execution,
  remote/Tailscale access, secrets, file mutation)? If so, describe the policy,
  approval, and audit expectations.
- Which surface: the MCP tool contract, the daemon/API, or the dashboard?
- Orca is deliberately a small harness for the CLI agents you already run — it
  ships no agent, no model, no keys, and no chat UI. Say how the proposal fits
  that scope.

## Additional context

Anything else (mockups, references). Paste only redacted output. Do not include
API tokens, provider secrets, pairing codes, cookies, private hostnames, or
screenshots containing sensitive data.
