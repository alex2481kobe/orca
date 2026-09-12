// Home-screen scope rules. Pure — no DOM, no fetch, no module state — so they
// are unit-tested directly (test/dashboard-scope.test.js) while overview.js,
// which touches `document` at import time, cannot be.
//
// Why this file exists. The home screen used to render every project the
// projection returned: over the owner's real state that is 3 projects, 11
// orchestrators and 50 lanes as one flat tree, a dead animation project and
// Orca's own project mixed in with the work in hand. Home now shows ONE project
// and reaches the others through the sidebar.
//
// The rule that governs everything here: SCOPING IS NOT HIDING. Every function
// below falls back to something real and reports what it did not draw as a
// count. The day before this was written, three recency filters composed to an
// empty dashboard over a state full of work; a presentation layer that can
// resolve to nothing would be the same failure wearing different clothes.

// Which project the home screen should open on.
//
// Order of authority, most specific first:
//   1. what the viewer picked in this session;
//   2. what this browser remembered from last time — the only sense in which the
//      client knows "the viewer's own" project;
//   3. the projection's nomination (`defaultProjectId`: the project of a live
//      orchestrator, else the most recently active — see src/registry-overview.js);
//   4. the first project in the projection's ranking.
// Every candidate is checked against the projects actually present, so a project
// that was archived or removed since it was remembered falls through instead of
// scoping home to nothing. Returns null only when there is genuinely no project.
export function chooseProjectId(data, { selected = null, remembered = null } = {}) {
  const projects = (data && Array.isArray(data.projects)) ? data.projects : [];
  if (!projects.length) return null;
  const present = (id) => Boolean(id) && projects.some((project) => project.id === id);
  if (present(selected)) return selected;
  if (present(remembered)) return remembered;
  if (present(data.defaultProjectId)) return data.defaultProjectId;
  return projects[0].id;
}

// How many other projects switching would reach — the number the scope control
// puts next to the current project's name.
export function otherProjectCount(data, selectedId) {
  const projects = (data && Array.isArray(data.projects)) ? data.projects : [];
  return projects.filter((project) => project.id !== selectedId).length;
}

// Does this project have live work for the collapse to protect?
// Uses the projection's own per-project counts, nothing new.
export function hasLiveWork(project) {
  if (!project) return false;
  return (Number(project.liveExecutorCount) || 0) > 0 || (Number(project.liveOrchestratorCount) || 0) > 0;
}

// Split ONE project's agents into the work to draw and the work to collapse.
//
// `retired` and `recent` are the projection's own fields, not a second scheme
// invented here: an orchestrator is retired when it is inactive (resigned or
// stale) with no live lane left, and a lane is retired when it is terminal and
// no longer recent. An inactive orchestrator that still has a lane running is
// NOT retired and is always drawn — that is precisely the row the old projection
// used to delete.
//
// Nothing is discarded: `retiredOrchestratorCount`, `retiredExecutorCount`,
// `omittedExecutorCount` (the projection's own per-orchestrator window) and
// their sum `hiddenCount` account for every row not drawn.
//
// `showRetired` is deliberately TRI-STATE. true/false are the viewer's own
// toggle. null (the default) is AUTO, and auto collapses retired work only when
// there is live work for the collapse to protect. The reason is the bug this
// screen is still living down: over a state where nothing has run for hours,
// every row is retired, and an unconditional collapse would draw an empty canvas
// over a project holding 11 finished lanes — "a state full of work rendering as
// nothing" again, arrived at from the presentation side instead of the
// projection side. Retired work must not CROWD OUT live work; with no live work
// to crowd out, it is simply the work.
export function partitionProject(project, { showRetired = null } = {}) {
  const all = (project && Array.isArray(project.orchestrators)) ? project.orchestrators : [];
  const collapsing = showRetired === null ? hasLiveWork(project) : !showRetired;
  let retiredOrchestratorCount = 0;
  let retiredExecutorCount = 0;
  let omittedExecutorCount = 0;

  const orchestrators = [];
  for (const orchestrator of all) {
    omittedExecutorCount += Number(orchestrator.executorsOmitted) || 0;
    const executors = Array.isArray(orchestrator.executors) ? orchestrator.executors : [];
    if (orchestrator.retired) {
      retiredOrchestratorCount += 1;
      // Its lanes are retired with it; count them once, here, so a collapsed
      // agent never takes its work off the books.
      retiredExecutorCount += executors.length;
      if (collapsing) continue;
      orchestrators.push({ ...orchestrator, executors });
      continue;
    }
    // The counts describe the project, not the current toggle: how much retired
    // work there IS. What is not drawn right now is hiddenCount, below.
    retiredExecutorCount += executors.filter((lane) => lane.terminal && !lane.recent).length;
    const drawn = collapsing ? executors.filter((lane) => !(lane.terminal && !lane.recent)) : executors;
    orchestrators.push({ ...orchestrator, executors: drawn });
  }

  return {
    orchestrators,
    retiredOrchestratorCount,
    retiredExecutorCount,
    omittedExecutorCount,
    // Everything the canvas is not drawing right now, as one number the screen
    // can state out loud.
    hiddenCount: (collapsing ? retiredOrchestratorCount + retiredExecutorCount : 0) + omittedExecutorCount,
    // What the caller actually ended up doing, so the toggle can label itself
    // honestly under AUTO instead of claiming to be collapsed when it is not.
    collapsingRetired: collapsing,
  };
}
