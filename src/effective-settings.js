// Effective settings resolution. Split into schema.js (validation) and
// resolve.js (merge precedence); this barrel preserves the public surface.

export {
  CONTRACT_VERSION,
  DEFAULT_EFFECTIVE_SETTINGS,
  sanitizeSettingsOverrides,
} from './effective-settings/schema.js';
export { buildEffectiveSettings } from './effective-settings/resolve.js';
