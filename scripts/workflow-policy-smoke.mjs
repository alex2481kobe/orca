#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const workflowsDir = path.resolve('.github', 'workflows');
const disallowedTriggers = ['push', 'pull_request', 'pull_request_target', 'schedule'];
const allowedTrigger = 'workflow_dispatch';

function stripComments(line) {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

async function main() {
  let entries = [];
  try {
    entries = await fs.readdir(workflowsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.log('[workflow-policy] no workflows directory present');
      return;
    }
    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && /\.(ya?ml)$/i.test(entry.name))
    .map((entry) => path.join(workflowsDir, entry.name));

  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    const activeLines = text
      .split(/\r?\n/)
      .map(stripComments)
      .filter((line) => line.trim());
    const activeText = activeLines.join('\n');
    const hasManualTrigger = new RegExp(`^\\s*${allowedTrigger}\\s*:`, 'm').test(activeText);
    if (!hasManualTrigger) {
      throw new Error(`${file} must include manual ${allowedTrigger}: trigger.`);
    }
    for (const trigger of disallowedTriggers) {
      if (new RegExp(`^\\s*${trigger}\\s*:`, 'm').test(activeText)) {
        throw new Error(`${file} must not use automatic ${trigger}: trigger.`);
      }
    }
  }

  console.log(`[workflow-policy] done — ${files.length} workflow(s) manual-only`);
}

main().catch((error) => {
  console.error(`[workflow-policy FAIL] ${error.message}`);
  process.exitCode = 1;
});
