// ONE authorization gate for "may this caller launch an UNSANDBOXED agent?".
//
// It used to live inline in the spawn route only, which left two sibling holes:
//   1. PATCH /api/lanes/{id}/controls could set permissionsProfile with no check
//      at all — spawn as "plan", then escalate the queued lane to
//      "bypass-permissions" before the scheduler starts it.
//   2. The gate matched mode NAMES, but the argv builder maps modes PER EXECUTOR:
//      for composer-cli "auto-edit" becomes --force. So the spawn route's own
//      error message ("use a sandboxed mode (plan/auto-edit)") handed the caller
//      an unsandboxed run under a name the gate considered safe.
// Both are closed by gating on the EFFECTIVE mode, at every route that can set it.
import { isUnsandboxedEffectiveMode } from '../executor/command-builder.js';

export const UNSANDBOXED_DENIAL = 'Unsandboxed agent permissions require workstation admin auth, not a paired device. Use a sandboxed mode (plan, or auto-edit on an executor that sandboxes it).';

// A paired-device operator is deliberately NOT enough here: pairing grants
// workflow control (stop/resign/approve), not the ability to launch a process
// with full filesystem and network access on the workstation.
export function makeUnsandboxedGate(ctx, req) {
  const { hasAdminAuth, getToolLeaseToken } = ctx;
  return (executorType, permissionsProfile) => {
    if (!isUnsandboxedEffectiveMode(executorType, permissionsProfile)) return false;
    const privileged = (typeof hasAdminAuth === 'function' && hasAdminAuth(req))
      || Boolean(typeof getToolLeaseToken === 'function' && getToolLeaseToken(req));
    return !privileged;
  };
}
