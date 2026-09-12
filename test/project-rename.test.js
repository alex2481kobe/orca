// NAMING THINGS. The owner: "i think in orca we should be able to rename the
// projects, and so can the orch agents, like for example since you know we are
// working on truss engine you could name it truss engine".
//
// A project's display name was derived from its directory basename and there was
// no way to change it. This adds a rename of the DISPLAY NAME and nothing else.
//
// The invariant every test here defends: a project's IDENTITY is realpath(cwd),
// keyed as prj_<sha256(cwd)>. A rename must never re-key a project, split one in
// two, or orphan the lanes hanging off it — so `id`, `cwd`, `slug` and `route`
// are asserted UNCHANGED on every path that touches the name.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OrcaRegistry } from '../src/registry.js';
import { toolLeaseRequirementForRoute } from '../src/server.js';
import { TOOL_DEFINITIONS } from '../src/agent-tools/tool-definitions.js';
import { approveFixtureRoot, restoreFixtureRoot } from './helpers/fence-root.js';

async function tempRoot(label) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `orca-rename-${label}-`)));
}

function openRegistry(stateDir) {
  return new OrcaRegistry({ stateDir, autoAudit: false, heartbeatIntervalMs: 60_000 });
}

async function closeRegistry(registry) {
  registry.stopScheduler();
  await registry.drainPendingWrites();
}

// A registry with one project, registered from `cwd` by a real orchestrator on a
// real lease — the shape every rename below is performed against.
async function fixture(label) {
  const tmp = await tempRoot(label);
  const projectDir = path.join(tmp, 'realm-shaper');
  const stateDir = path.join(tmp, 'state');
  await fs.mkdir(projectDir);
  approveFixtureRoot(tmp);
  const registry = openRegistry(stateDir);
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor: 'claude-code' });
  const orchestrator = await registry.registerOrchestrator(
    { cwd: projectDir, actor: 'claude-code', title: 'Engine lane' },
    { leaseId: lease.id },
  );
  const project = registry.getProject(orchestrator.projectId);
  return {
    tmp,
    stateDir,
    projectDir,
    registry,
    lease,
    orchestrator,
    project,
    async cleanup(...extra) {
      await closeRegistry(registry);
      for (const other of extra) if (other) await closeRegistry(other);
      restoreFixtureRoot();
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    },
  };
}

test('renameProject changes the display name and nothing else', { timeout: 30_000 }, async () => {
  const f = await fixture('display');
  try {
    assert.equal(f.project.name, 'realm-shaper', 'the name starts derived from the directory');
    const before = { id: f.project.id, cwd: f.project.cwd, slug: f.project.slug, route: f.project.route };

    const renamed = f.registry.renameProject(f.project.id, { name: 'Truss Engine' }, {
      actor: 'claude-code',
      leaseId: f.lease.id,
    });

    assert.equal(renamed.name, 'Truss Engine');
    assert.equal(renamed.id, before.id, 'the identity is unchanged — a rename must never re-key a project');
    assert.equal(renamed.cwd, before.cwd, 'the project is still keyed by realpath(cwd)');
    assert.equal(renamed.slug, before.slug, 'the slug is not re-derived from the new name');
    assert.equal(renamed.route, before.route);
    assert.equal(f.registry.projects.length, 1, 'the rename did not split the project in two');

    // The lane container still resolves through the same project.
    assert.equal(f.registry.getProject(before.id).name, 'Truss Engine');
    assert.equal(
      f.registry.orchestrators.filter((item) => item.projectId === before.id).length,
      1,
      'the orchestrator is still attached to the project it registered on',
    );
    assert.ok(
      f.registry.auditEvents.some((event) => event.type === 'project_renamed'
        && event.evidence?.previousName === 'realm-shaper'
        && event.evidence?.name === 'Truss Engine'),
      'a rename is audited with the name it replaced',
    );
  } finally {
    await f.cleanup();
  }
});

test('a rename reaches /api/overview and the SSE revision at once, and survives a restart', { timeout: 30_000 }, async () => {
  const f = await fixture('overview');
  let reloaded = null;
  try {
    const before = f.registry.getStreamRevision();
    f.registry.renameProject(f.project.id, { name: 'Truss Engine' }, { actor: 'operator' });
    assert.ok(
      f.registry.getStreamRevision() > before,
      'the stream revision moved: the dashboard diffs it to know to refresh, so a rename it does not bump is a rename nobody sees until a reload',
    );

    const overview = f.registry.buildOverview();
    assert.equal(overview.projects[0].name, 'Truss Engine', 'the projection the dashboard reads carries the new name');
    assert.equal(overview.projects[0].cwd, f.projectDir, 'and still says which folder it is');

    await closeRegistry(f.registry);
    reloaded = openRegistry(f.stateDir);
    assert.equal(reloaded.getProject(f.project.id).name, 'Truss Engine', 'the rename is on disk');
  } finally {
    await f.cleanup(reloaded);
  }
});

test('an orchestrator title change reaches /api/overview at once too', { timeout: 30_000 }, async () => {
  const f = await fixture('title');
  try {
    const before = f.registry.getStreamRevision();
    await f.registry.registerOrchestrator(
      { cwd: f.projectDir, actor: 'claude-code', title: 'Truss engine — persistence' },
      { leaseId: f.lease.id },
    );
    assert.ok(f.registry.getStreamRevision() > before, 'a title refresh bumps the revision the dashboard diffs');
    const overview = f.registry.buildOverview();
    assert.equal(overview.projects[0].orchestrators[0].title, 'Truss engine — persistence');
  } finally {
    await f.cleanup();
  }
});

test('a later registration from the same cwd never clobbers a custom name', { timeout: 30_000 }, async () => {
  const f = await fixture('sticky');
  try {
    f.registry.renameProject(f.project.id, { name: 'Truss Engine' }, { actor: 'operator' });
    const { lease: second } = f.registry.createToolLease({ role: 'orchestrator', actor: 'codex' });
    const other = await f.registry.registerOrchestrator(
      { cwd: f.projectDir, actor: 'codex', title: 'Scout' },
      { leaseId: second.id },
    );
    assert.equal(other.projectId, f.project.id, 'the second agent joined the SAME project');
    assert.equal(f.registry.projects.length, 1);
    assert.equal(
      f.registry.getProject(f.project.id).name,
      'Truss Engine',
      'the display name is not re-derived from the directory basename by a later register',
    );
  } finally {
    await f.cleanup();
  }
});

test('who may rename: a registered orchestrator on that project, or an operator', { timeout: 30_000 }, async () => {
  const f = await fixture('authz');
  try {
    // An OPERATOR — the workstation token, a paired device, the dashboard — reaches
    // the registry with no lease (or the shared 'dashboard' pseudo-lease). They own
    // the machine; they may rename anything.
    assert.equal(f.registry.renameProject(f.project.id, { name: 'By operator' }, { actor: 'operator' }).name, 'By operator');
    assert.equal(
      f.registry.renameProject(f.project.id, { name: 'By dashboard' }, { actor: 'operator', leaseId: 'dashboard' }).name,
      'By dashboard',
    );

    // The agent that registered on this project may rename it. That is the whole
    // ask — an orchestrator should be able to name the project it is working in.
    assert.equal(
      f.registry.renameProject(f.project.id, { name: 'Truss Engine' }, { actor: 'claude-code', leaseId: f.lease.id }).name,
      'Truss Engine',
    );

    // A lease that is NOT registered here may not. An orchestrator lease is
    // typically UNSCOPED, so validateToolLease's project-scope check passes it
    // through — registration is the only thing that confines an agent to its own
    // project, so it has to be checked here.
    const { lease: stranger } = f.registry.createToolLease({ role: 'orchestrator', actor: 'someone-else' });
    assert.throws(
      () => f.registry.renameProject(f.project.id, { name: 'Not yours' }, { actor: 'someone-else', leaseId: stranger.id }),
      (error) => error.status === 403 && /register/i.test(error.message),
      'a lease with no orchestrator on this project is refused, and told how to earn it',
    );
    assert.equal(f.registry.getProject(f.project.id).name, 'Truss Engine', 'the refused rename changed nothing');

    // Resigning gives up the right along with the container.
    f.registry.resignOrchestrator(f.orchestrator.id, {}, { leaseId: f.lease.id });
    assert.throws(
      () => f.registry.renameProject(f.project.id, { name: 'After resigning' }, { actor: 'claude-code', leaseId: f.lease.id }),
      (error) => error.status === 403,
      'a resigned orchestrator no longer speaks for the project',
    );
  } finally {
    await f.cleanup();
  }
});

test('a rename is validated: no empty names, no control characters, bounded length', { timeout: 30_000 }, async () => {
  const f = await fixture('validate');
  try {
    for (const bad of [undefined, '', '   ', '\t\n']) {
      assert.throws(
        () => f.registry.renameProject(f.project.id, { name: bad }, { actor: 'operator' }),
        (error) => error.status === 422,
        `a blank name (${JSON.stringify(bad)}) is refused rather than blanking the project on the dashboard`,
      );
    }
    assert.throws(
      () => f.registry.renameProject('prj_nope', { name: 'x' }, { actor: 'operator' }),
      (error) => error.status === 404,
    );

    // The dashboard renders the name as text; a name carrying control characters
    // or newlines is a display name that can misrepresent the tree.
    const cleaned = f.registry.renameProject(f.project.id, { name: '  Truss \n  Engine  ' }, { actor: 'operator' });
    assert.equal(cleaned.name, 'Truss Engine');

    const long = f.registry.renameProject(f.project.id, { name: 'T'.repeat(400) }, { actor: 'operator' });
    assert.equal(long.name.length, 120, 'bounded at the same 120 chars the other project display fields use');
  } finally {
    await f.cleanup();
  }
});

// The disk-rename question, answered as a test rather than as a claim.
test('renaming the FOLDER on disk is a different project — the rename does not follow it', { timeout: 30_000 }, async () => {
  const f = await fixture('ondisk');
  try {
    f.registry.renameProject(f.project.id, { name: 'Truss Engine' }, { actor: 'operator' });
    const moved = path.join(f.tmp, 'truss-engine');
    await fs.rename(f.projectDir, moved);

    const { lease: after } = f.registry.createToolLease({ role: 'orchestrator', actor: 'claude-code' });
    const reregistered = await f.registry.registerOrchestrator(
      { cwd: moved, actor: 'claude-code', title: 'Engine lane' },
      { leaseId: after.id },
    );

    // Identity IS realpath(cwd), so a moved folder is a new project. The old
    // record is NOT rewritten, NOT deleted and NOT merged: it keeps its custom
    // name and every lane that ran under it, and the dashboard shows both, each
    // with its own cwd. Reconciling them is an operator decision, not something a
    // register call may do silently.
    assert.notEqual(reregistered.projectId, f.project.id, 'a moved folder registers as a separate project');
    assert.equal(f.registry.projects.length, 2);
    assert.equal(f.registry.getProject(f.project.id).name, 'Truss Engine', 'the old record keeps its custom name');
    assert.equal(f.registry.getProject(f.project.id).cwd, f.projectDir, 'and keeps pointing at the path that is now gone');
    assert.equal(f.registry.getProject(reregistered.projectId).name, 'truss-engine', 'the new one derives its name from the new basename');

    // Which is exactly why the rename is reachable: the operator (or the agent now
    // registered there) names the new record too.
    f.registry.renameProject(reregistered.projectId, { name: 'Truss Engine' }, { actor: 'operator' });
    assert.equal(f.registry.getProject(reregistered.projectId).name, 'Truss Engine');
  } finally {
    await f.cleanup();
  }
});

test('project.rename is in the contract, routed, and says what gates it', () => {
  const tool = TOOL_DEFINITIONS.find((item) => item.id === 'project.rename');
  assert.ok(tool, 'project.rename must be in the agent tool table — an agent cannot call what is not there');
  assert.ok(tool.roles.includes('orchestrator'), 'an orchestrator agent must be able to name its own project');
  assert.equal(tool.mutating, true);

  const parts = tool.route.replace(/\{[^}]+\}/g, 'x').replace(/^\/+|\/+$/g, '').split('/');
  const routed = toolLeaseRequirementForRoute(tool.method, parts);
  assert.ok(routed, `${tool.method} ${tool.route} must be in the tool-lease route map, or a lease can never reach it`);
  assert.equal(routed.toolId, 'project.rename');
  assert.equal(routed.projectId, 'x', 'the requirement is project-scoped so a lease bound elsewhere is refused at the gate');

  // The description rules in agent-tools-descriptions.test.js derive their
  // expectations from the enforcing code. This tool is gated on REGISTRATION
  // rather than on the approval policy, which no generic rule can check, so it is
  // checked here: the description must state the gate an agent will actually hit.
  assert.match(
    tool.summary,
    /register/i,
    'project.rename refuses a lease with no orchestrator registered on the project — the summary must say so',
  );
  assert.match(
    tool.summary,
    /403/,
    'the summary must name the status an ungated caller gets back',
  );
  assert.ok(
    !tool.policyAction,
    'project.rename is deliberately not approval-gated; if that changes, the summary must start saying "approved"',
  );
});
