// What a PROJECT page draws. Pure — no DOM, no fetch, no module state — so it
// is unit-tested directly (test/dashboard-scope.test.js) while overview.js,
// which touches `document` at import time, cannot be.
//
// Why this file exists, and what changed on 2026-09-12.
//
// The home screen used to render every project the projection returned: over
// the owner's real state that was 3 projects, 11 orchestrators and 50 lanes as
// one flat tree. The first fix scoped HOME to one project and added two
// controls — an in-canvas project dropdown and a "hide retired agents" collapse.
// The owner threw both out: "for the orca dashboard the home page should just
// show the welcome essentially, and then the projects themselves can show what
// is running, get rid of that hide retired agents and the dropdown picker thing
// you made, thats why we have the panel on the left".
//
// So the screens now split by ADDRESS, not by a control:
//   - `#/`                → a welcome. It has no agent graph at all.
//   - `#/project/<id>`    → that one project's work, and only that project's.
//   - the left panel      → the switcher. There is exactly one.
//
// The rule that still governs everything here: SCOPING IS NOT HIDING. Nothing
// below can drop an agent, and everything it does not draw comes back as a
// count the screen states out loud. The day before this was written, three
// recency filters composed to an empty dashboard over a state full of work; a
// presentation layer that can resolve to nothing would be the same failure
// wearing different clothes.

// How many FINISHED lanes one agent contributes to the graph.
//
// This is the whole answer to "retired work must not swamp a project page",
// and it is deliberately not a toggle:
//   - every agent of the project is drawn, retired or not — nothing is ever
//     collapsed away, so there is nothing to un-collapse;
//   - every LIVE lane is drawn, always, however many there are;
//   - a bounded number of that agent's most recent FINISHED lanes are drawn,
//     newest first (the projection already sorts them that way);
//   - the remainder is counted on that agent's own node and in the project
//     total, so it is stated rather than hidden.
// The bound is per AGENT, not per project, so one agent with a hundred finished
// lanes cannot crowd out the agent beside it — which is what "swamping" meant.
// And because the window is filled with the most recent lanes whether or not
// anything is running, a project where nothing has run for hours still draws
// its finished work instead of an empty canvas. That was the bug this screen is
// living down (docs/audits/2026-09-11-overview-empty.md), and an unconditional
// collapse would have re-created it from the presentation side.
export const PROJECT_LANE_WINDOW = 8;

// Find the project a `#/project/<id>` route names.
//
// It never falls through to a DIFFERENT project. Home is a welcome now, so
// there is no "the one project" to fall back to, and silently showing project B
// under project A's URL would be worse than saying the id is gone. `missing` is
// true only when the route named something the projection does not carry —
// which the screen reports, pointing at the left panel.
export function resolveProject(data, projectId) {
  const projects = (data && Array.isArray(data.projects)) ? data.projects : [];
  const id = projectId ? String(projectId) : '';
  if (!id) return { project: null, missing: false };
  const project = projects.find((item) => item && item.id === id) || null;
  return { project, missing: !project };
}

// One project's agents, laid out for the graph.
//
// Returns EVERY orchestrator the projection carried for the project — none is
// filtered, sorted away or collapsed. Only the finished-lane window bounds
// anything, and what it leaves out is counted twice over: per agent
// (`olderExecutorCount` on the row, so the node can say so) and per project.
export function projectView(project, { laneWindow = PROJECT_LANE_WINDOW } = {}) {
  const all = (project && Array.isArray(project.orchestrators)) ? project.orchestrators : [];
  const parsed = Number(laneWindow);
  const windowSize = Math.max(0, Number.isFinite(parsed) ? parsed : PROJECT_LANE_WINDOW);

  let shownExecutorCount = 0;
  let olderExecutorCount = 0;
  let liveExecutorCount = 0;
  let totalExecutorCount = 0;
  let retiredOrchestratorCount = 0;

  const orchestrators = all.map((orchestrator) => {
    const executors = Array.isArray(orchestrator.executors) ? orchestrator.executors : [];
    // What the projection itself already left out for this agent
    // (MAX_EXECUTORS_PER_ORCHESTRATOR in src/registry-overview.js). It is part
    // of the same number, not a separate one, or the screen would under-report.
    const beyondProjection = Math.max(0, Number(orchestrator.executorsOmitted) || 0);
    const live = executors.filter((lane) => !lane.terminal);
    const finished = executors.filter((lane) => lane.terminal);
    const drawnFinished = finished.slice(0, windowSize);
    const older = (finished.length - drawnFinished.length) + beyondProjection;

    if (orchestrator.retired) retiredOrchestratorCount += 1;
    liveExecutorCount += live.length;
    totalExecutorCount += executors.length + beyondProjection;
    shownExecutorCount += live.length + drawnFinished.length;
    olderExecutorCount += older;

    return {
      ...orchestrator,
      // Live first, then the newest finished ones — the projection's own order.
      executors: [...live, ...drawnFinished],
      olderExecutorCount: older,
    };
  });

  return {
    orchestrators,
    orchestratorCount: orchestrators.length,
    retiredOrchestratorCount,
    liveExecutorCount,
    shownExecutorCount,
    // Everything the canvas is not drawing right now, as one number the screen
    // can state out loud. It is only ever OLDER FINISHED lanes: no agent, and no
    // running lane, is ever in here.
    olderExecutorCount,
    totalExecutorCount,
    laneWindow: windowSize,
  };
}
