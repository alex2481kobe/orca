// Pure decision: should a project's disclosure render open on this paint?
//
// The home tree re-renders its innerHTML every 2s poll, so open/closed state
// must be recomputed from the state captured just before the re-render
// (`wasOpen` = the pids that were open in the DOM). Two entry modes:
//
//   freshEntry — first paint or (re)entering the home screen via nav: default
//     to open so the operator sees the tree expanded.
//   poll refresh (freshEntry=false) — preserve the EXACT prior set, including
//     "user closed everything" (an empty wasOpen stays empty). The earlier
//     `wasOpen.size === 0 → open all` fallback conflated "never painted" with
//     "user collapsed the last one", so collapsing the final project made it
//     pop back open on the next poll. See render-ephemeral-state-invariant.
//
// A selected (drilled-in) project always renders open.
export function shouldRenderProjectOpen({ pid, wasOpen, freshEntry, hasSelection }) {
  if (freshEntry || hasSelection) return true;
  return wasOpen.has(pid);
}
