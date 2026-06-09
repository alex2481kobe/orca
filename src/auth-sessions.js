// Browser auth sessions + pairing codes. Split into crypto.js (pure helpers) and
// store.js (the AuthSessionStore class); this barrel preserves the public surface.

export { AuthSessionStore } from './auth-sessions/store.js';
export { SESSION_COOKIE_NAME } from './auth-sessions/crypto.js';
