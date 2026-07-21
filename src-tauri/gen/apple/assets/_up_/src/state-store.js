// Atomic, recoverable JSON state store. Split into io.js (low-level atomic
// read/write + parse hardening) and recovery.js (backup recovery + quarantine);
// this barrel preserves the public import path and surface.

export {
  STATE_STORE_CONTRACT_VERSION,
  backupPathFor,
  cloneJson,
  writeJsonFileAtomic,
  writeJsonFileAtomicSync,
} from './state-store/io.js';

export {
  readJsonFileWithRecovery,
  readJsonFileWithRecoverySync,
} from './state-store/recovery.js';
