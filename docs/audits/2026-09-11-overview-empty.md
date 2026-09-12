# `/api/overview` returns no projects — PRE-EXISTING, not caused by the v4 migration

**Found:** 2026-09-11, by the Claude orchestrator, right after the v3-to-v4 state migration landed.

## What happens

With a state holding 3 projects, 10 orchestrators and 82 lanes, the daemon reports those
counts on `/api/health`:

    {"status":"ok","counts":{"projects":3,"orchestrators":10,"lanes":82,"auditEvents":201}}

while `/api/overview` — **the only endpoint the dashboard fetches** — returns an empty list:

    {"revision":1,"generatedAt":"…","projects":[]}

So the dashboard shows nothing while the daemon holds a full state.

## It is NOT the migration

Verified by A/B, on 2026-09-11:

- the migrated v4 state on port 3000 returned `projects: []`;
- the **verbatim pre-migration v3 original**, restored from
  `.orca/archive/migrations/<stamp>-v3-to-v4-<sha>/state.json` into a temp state directory and
  served by a second daemon on port 3010, returned `projects: []` **as well**, from the same
  code.

Both daemons reported the same non-zero health counts. The second daemon was stopped after the
check, and the live state directory was never touched.

## Not diagnosed

Why the overview projection drops every project. `GET /api/orchestrators` returns 5 rows for a
state whose health count is 10, so the same projection or filter probably narrows both. Whoever
picks this up should start at the overview projection and ask what it filters on — plausibly
recency, an orchestrator's lease, or a lane-state predicate — and add a test that a state with
projects and lanes yields a non-empty overview.
