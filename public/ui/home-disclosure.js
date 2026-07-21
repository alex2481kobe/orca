// Pure decision: should a project's disclosure render open on this paint?
//
// The home tree is a monitoring view, so a project renders OPEN by default —
// including new projects/agents that appear via the 2s poll. It stays collapsed
// only if the operator explicitly collapsed it (tracked in collapsedPids, which
// the toggle handler maintains across the innerHTML re-render). This is what
// preserves ephemeral disclosure state across polls — see
// render-ephemeral-state-invariant.
export function shouldRenderProjectOpen({ pid, collapsedPids }) {
  return !collapsedPids.has(pid);
}
