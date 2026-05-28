# Route-by-route audit

This is the operator-visible inventory of every Command Deck route, the
guardrails on it, and where the test coverage lives. `GET` routes are
read-only and listed for completeness; every non-GET route is gated by the
API token (when `COMMAND_DECK_API_TOKEN` is set) and by the actor-spoofing
check that refuses `actor` values in {`scheduler`, `system`, `cron`,
`worker`}.

All non-GET handlers reject oversize bodies with `413` and malformed JSON
with `400` (`COMMAND_DECK_MAX_JSON_BYTES`, default 256KB).

## Health, policy, profiles

| Method | Route | Auth | Approval | Validation | Audit | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/health` | none | n/a | n/a | n/a | server `requires token for mutating`, `smoke` |
| GET | `/api/policy` | none | n/a | n/a | n/a | smoke |
| GET | `/api/executors/profiles` | none | n/a | n/a | n/a | smoke |

## Executor CLI

| Method | Route | Auth | Approval | Validation | Audit | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/executors/{codex,claude}/cli` | none | n/a | type allowlist | n/a | CLI info tests |
| POST | `/api/executors/{codex,claude}/cli/reinstall` | token | `manageExecutorCli` | command/source allowlist, install-verb check, `confirmed:true` for execute | audit on plan + execute | reinstall approval + confirmation + URL/package + source tests |

## Artifact cleanup

| Method | Route | Auth | Approval | Validation | Audit | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/artifacts/cleanup` | token | `cleanupArtifacts` | sessionId presence, retention, `confirmed` for destructive | cleanup audit with candidates/removed/bytes/errors/dryRun | cleanup approval + confirmation + retention tests |
| GET | `/api/artifacts/cleanup/schedule` | none | n/a | n/a | n/a | schedule retention test |
| POST | `/api/artifacts/cleanup/schedule` | token | `manageCleanupSchedule` | `intervalHours <= 720`, `olderThanDays` positive int or null, sessionId 404 | schedule audit | schedule validation test |
| POST | `/api/artifacts/cleanup/run-now` | token | `cleanupArtifacts` | overrides validated; dry-run default | cleanup audit | run-now approval + dry-run test |

## Audit events

| Method | Route | Auth | Approval | Validation | Audit | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/audit/events?status=...` | none | n/a | query decoding | n/a | malformed query test |
| POST | `/api/audit/events/{id}/ack` | token | n/a | event exists + pending | ack audit | audit ack test |

## MCP tools

| Method | Route | Auth | Approval | Validation | Audit | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/mcp/tools` | none | n/a | scope query decoded, strict filter | n/a | scope filter test |
| POST | `/api/mcp/tools` | token | `manageMcpTools` | name, command, allowlist, args, env, workdir, description, owner, notes, scope | created audit | CRUD + validation + allowlist + scope tests |
| GET | `/api/mcp/tools/{id}` | none | n/a | id exists | n/a | CRUD test |
| PATCH | `/api/mcp/tools/{id}` | token | `manageMcpTools` | same as POST | updated audit | update approval test |
| DELETE | `/api/mcp/tools/{id}` | token | `manageMcpTools` | id exists | delete audit + lane detach | delete-detach test |

## Projects and sessions

| Method | Route | Auth | Approval | Validation | Audit | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/projects` | none | n/a | n/a | n/a | smoke |
| POST | `/api/projects` | token | `createProject` | name, slug uniqueness | project_created audit | project approval test |
| GET | `/api/projects/{id}` | none | n/a | id exists | n/a | smoke |
| PATCH | `/api/projects/{id}` | token | `updateProject` | quickLinks array | project_updated audit | quick-link test |
| GET | `/api/projects/{id}/sessions` | none | n/a | id exists | n/a | smoke |
| POST | `/api/projects/{id}/sessions` | token | `createSession` | name | session_created audit | session approval test |
| GET | `/api/sessions/{id}` | none | n/a | id exists | n/a | smoke |
| GET | `/api/sessions/{id}/lanes` | none | n/a | id exists | n/a | smoke |
| POST | `/api/sessions/{id}/lanes` | token | `createLane` | title, executorType, workdir boundary, MCP scope, executor binary/command targeting | lane_created (+lane_shared_worktree if shared) | createLane validation tests, MCP scope tests |
| POST | `/api/sessions/{id}/audit-done-lanes` | token | `auditDoneLanes` | session exists | done-lanes audit | audit filtering test |
| GET | `/api/sessions/{id}/audit-events?status=...` | none | n/a | id exists, query decoded | n/a | audit filtering test |

## Lanes

| Method | Route | Auth | Approval | Validation | Audit | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/lanes/{id}` | none | n/a | id exists | n/a | smoke |
| POST | `/api/lanes/{id}/stop` | token | `stopLane` | id exists, lane in active state | lane_stopped audit | stop approval test |
| POST | `/api/lanes/{id}/retry` | token | `retryLane` | id exists, retryable state | lane_retried audit | included in registry tests |
| POST | `/api/lanes/{id}/audit` | token | `auditLane` | id exists | lane_audit_queued | audit listing tests |
| GET | `/api/lanes/{id}/audit-events?status=...` | none | n/a | id exists, query decoded | n/a | audit listing test |
| POST | `/api/lanes/{id}/heartbeat` | token + optional `COMMAND_DECK_WORKER_TOKEN` | n/a | actor forced to body actor or `worker` | none (heartbeat is high-frequency) | heartbeat governance test |
| GET | `/api/lanes/{id}/artifacts` | none | n/a | id exists | n/a | smoke |
| GET | `/api/lanes/{id}/evidence` | none | n/a | id exists | n/a | smoke |
| POST | `/api/lanes/{id}/evidence` | token | `captureEvidence` | url, modes whitelist | lane_evidence_captured / failed audit | evidence smoke |
| GET | `/api/lanes/{id}/evidence/latest?mode=...` | none | n/a | id exists, mode whitelist | n/a | smoke |
| GET | `/api/lanes/{id}/evidence/presets` | none | n/a | id exists | n/a | covered by smoke |
| POST | `/api/lanes/{id}/evidence/clear` | token | `clearEvidenceArtifacts` | id exists | lane_evidence_cleared audit | covered by registry tests |

## Mobile manifest and static

| Method | Route | Auth | Approval | Validation | Audit | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/mobile/manifest` | none | n/a | n/a | n/a | mobile manifest contract test |
| GET | `/artifacts/{session}/{lane}/{file}` | none | n/a | path containment + symlink refused + encoding rejected | n/a | artifact path containment test |
| GET | `/` and unknown paths | none | n/a | static dir resolved from server.js | n/a | smoke fetches HTML/JS |

## Reserved-actor handling

All non-GET routes reject body `actor` values in `{scheduler, system, cron,
worker}` with `403`. Tests:
`server rejects dashboard requests that try to spoof the scheduler actor`.

## Body limit handling

`COMMAND_DECK_MAX_JSON_BYTES` defaults to 262144. Oversize requests return
`413`; malformed JSON returns `400`. Tested via:
`server rejects oversized JSON bodies with 413 and small limit override`.

## Shared-worktree governance

Lanes created with `sharedWorktree: true` get a `lane_shared_worktree` audit
event and a `warnings` entry; the dashboard surfaces the warning at the top
of lane detail. Operators must explicitly opt into shared-worktree edits.
