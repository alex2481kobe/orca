## Summary

-

## Verification

Which checks did you run? (`npm test`, `npm run smoke`, `npm run smoke:screens`,
`npm run smoke:unauth-sweep`, …)

-

## Security checklist

- [ ] No secrets, tokens, pairing codes, cookies, private hostnames, or
      generated artifacts are committed.
- [ ] Auth tiers (admin vs. operator), pairing, executor lifecycle, MCP tool
      leases, live links, cleanup, and private-access boundaries are unchanged
      or covered by a test/smoke.
- [ ] Any new `/api/*` route still refuses unauthenticated callers
      (`npm run smoke:unauth-sweep`).
- [ ] Workflow, dependency, script, service-worker, license, security-policy, or
      contribution-policy changes are called out for owner review.
- [ ] No automatic workflow triggers, `pull_request_target` paths, dependency
      script bypasses, or secret-bearing PR automation were added.
- [ ] Public docs still describe what the code actually does.
