// ORCA_ARTIFACT_DIR is the path we hand a spawned agent so it can save evidence
// (screenshots for UI work). It used to be set to `lane.artifactPath` — the URL path
// used to SERVE artifacts, i.e. "/artifacts/<session>/<lane>" with a leading slash.
// An agent following our own docs therefore wrote to the FILESYSTEM ROOT, the
// evidence never landed where the reader looks (<cwd>/artifacts/...), and
// `audit.accept` permanently refused targetUrl lanes for "no captured evidence".
//
// This test ties the two ends together: what we TELL the agent must be the same
// directory the audit gate READS.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExecutorAdapter } from '../src/executor-factory.js';

test('ORCA_ARTIFACT_DIR is an absolute, existing dir that the audit gate reads', async () => {
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-artifact-env-')));
  process.chdir(tempDir);
  process.env.ORCA_ENABLE_CUSTOM_CLI = 'true';
  process.env.ORCA_CLI_BINARY = process.execPath;
  process.env.ORCA_CLI_ALLOWED_BINARIES = `${process.execPath},node`;
  process.env.ORCA_CLI_WORKDIR_ROOTS = tempDir;
  process.env.ORCA_CLI_ENV_WHITELIST = 'PATH,HOME,TMPDIR,LANG,LC_ALL,LC_CTYPE,USER,SHELL,TERM';

  try {
    const adapter = createExecutorAdapter('cli', {
      defaultWorkingDir: tempDir,
      onLog: async () => {},
      onComplete: async () => {},
      onFail: async () => {},
      onStop: async () => {},
    });

    // The adapter does not expose the child's env on runtime/processMeta, so ask the
    // CHILD what it actually received — anything less would silently assert nothing.
    const reportPath = path.join(tempDir, 'env-report.txt');
    const dumpScript = path.join(tempDir, 'dump-env.cjs');
    await fs.writeFile(
      dumpScript,
      `require('node:fs').writeFileSync(${JSON.stringify(reportPath)}, String(process.env.ORCA_ARTIFACT_DIR || ''));`,
      'utf8',
    );

    const lane = {
      id: 'lane-artifacts',
      sessionId: 'orc-artifacts',
      projectId: 'prj-artifacts',
      workdir: tempDir,
      executorBinary: process.execPath,
      commandArgs: [dumpScript],
      // The URL form the server uses to SERVE artifacts — deliberately present, to
      // prove the env var is NOT just echoing it back.
      artifactPath: '/artifacts/orc-artifacts/lane-artifacts',
    };

    const started = await adapter.start(lane);
    assert.equal(started.accepted, true, started.reason);

    const expected = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id);

    // Wait for the child to report the env it was handed.
    let exported = null;
    for (let i = 0; i < 100 && exported === null; i++) {
      exported = await fs.readFile(reportPath, 'utf8').catch(() => null);
      if (exported === null) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(exported !== null, 'child never reported its env — cannot verify the contract');
    assert.ok(exported, 'ORCA_ARTIFACT_DIR was empty in the child');
    assert.ok(path.isAbsolute(exported), `ORCA_ARTIFACT_DIR must be an absolute filesystem path, got ${exported}`);
    assert.notEqual(exported, lane.artifactPath,
      'ORCA_ARTIFACT_DIR is the URL path — an agent writing there hits the filesystem root');
    assert.equal(exported, expected);

    // Whatever we told the agent, the directory the audit gate reads must exist by
    // the time the agent is running — otherwise evidence capture fails silently.
    const stat = await fs.stat(expected).catch(() => null);
    assert.ok(stat && stat.isDirectory(), `lane artifact directory was not created at ${expected}`);

    // And a file written there is visible at the path the evidence reader uses
    // (src/registry-audit.js / registry-artifacts.js both use this exact join).
    await fs.writeFile(path.join(expected, 'evidence.png'), 'x');
    const seen = await fs.readdir(path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id));
    assert.ok(seen.includes('evidence.png'), 'evidence written to ORCA_ARTIFACT_DIR is not where the audit gate looks');

    await adapter.stop(lane.id, { actor: 'test', reason: 'cleanup' }).catch(() => {});
  } finally {
    process.chdir(previousCwd);
    Object.keys(process.env).forEach((k) => { if (!(k in previousEnv)) delete process.env[k]; });
    Object.entries(previousEnv).forEach(([k, v]) => { process.env[k] = v; });
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
