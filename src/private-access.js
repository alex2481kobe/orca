// Private access (Tailscale/tailnet). Split into validation.js, tailnet.js, and
// store.js; this barrel preserves the public surface.

export {
  ACCESS_MODES,
  DEFAULT_SETTINGS,
  validateAccessUrl,
} from './private-access/validation.js';
export {
  buildSetupPlan,
  clearTailnetStateCache,
  detectTailnetState,
  fakeTailnetState,
} from './private-access/tailnet.js';
export { PrivateAccessStore } from './private-access/store.js';
