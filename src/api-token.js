// Orca's API token, from ORCA_API_TOKEN or from ORCA_API_TOKEN_FILE.
//
// The file form keeps the token out of any service definition: a LaunchAgent
// plist names the file, and only its owner can read the file. A token file that
// is set but unusable (a relative path, missing, not a regular file, empty, or
// readable by group or others) is an error, never a silent fall back to no
// token: with no token, every loopback caller is Orca admin.
//
// Nothing here prints or logs the token.

import fs from 'node:fs';
import path from 'node:path';

// -> { token } | { error }
export function readApiTokenFile(file) {
  const target = String(file ?? '').trim();
  if (!path.isAbsolute(target)) return { error: `ORCA_API_TOKEN_FILE must be an absolute path, not "${target}".` };
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    return { error: `ORCA_API_TOKEN_FILE ${target} cannot be read: ${error?.code === 'ENOENT' ? 'it does not exist' : error?.message}.` };
  }
  if (!stat.isFile()) return { error: `ORCA_API_TOKEN_FILE ${target} is not a regular file.` };
  if (stat.mode & 0o077) {
    return { error: `ORCA_API_TOKEN_FILE ${target} can be read by other users (mode ${(stat.mode & 0o777).toString(8)}). Make it owner-only: chmod 600 ${target}` };
  }
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (error) {
    return { error: `ORCA_API_TOKEN_FILE ${target} cannot be read: ${error?.message}.` };
  }
  const token = raw.split(/\r?\n/)[0].trim();
  if (!token) return { error: `ORCA_API_TOKEN_FILE ${target} is empty.` };
  return { token };
}

// -> { token, source, error }. ORCA_API_TOKEN wins over the file.
export function resolveApiToken(env = process.env) {
  if (env.ORCA_API_TOKEN) return { token: env.ORCA_API_TOKEN, source: 'ORCA_API_TOKEN', error: null };
  if (String(env.ORCA_API_TOKEN_FILE || '').trim()) {
    const result = readApiTokenFile(env.ORCA_API_TOKEN_FILE);
    return result.error
      ? { token: '', source: 'ORCA_API_TOKEN_FILE', error: result.error }
      : { token: result.token, source: 'ORCA_API_TOKEN_FILE', error: null };
  }
  return { token: '', source: null, error: null };
}
