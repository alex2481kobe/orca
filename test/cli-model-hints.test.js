import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelHints } from '../src/registry-cli-info.js';

// Real-world shape of Claude's `claude --help` --model block. The apostrophe in
// "model's" used to desync quote parsing and drop the full-name example.
const CLAUDE_HELP = `
  --fallback-model <model>              Enable automatic fallback to specified
                                        model when the default model is overloaded
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'sonnet' or 'opus') or a model's full
                                        name (e.g. 'claude-opus-4-8').
  --settings <file>                     Path to a settings JSON file
`;

test('parseModelHints extracts aliases and the current full model name', () => {
  const hints = parseModelHints(CLAUDE_HELP);
  assert.deepEqual(hints, ['sonnet', 'opus', 'claude-opus-4-8']);
});

test('parseModelHints does not confuse --fallback-model for --model', () => {
  // Only the --model block (not --fallback-model) should be mined; "overloaded"
  // prose must not leak in.
  const hints = parseModelHints(CLAUDE_HELP);
  assert.ok(!hints.includes('overloaded'));
});

test('parseModelHints returns [] when the CLI documents no model examples', () => {
  const codexish = '  -m, --model <MODEL>\n          Model the agent should use\n';
  assert.deepEqual(parseModelHints(codexish), []);
});

test('parseModelHints ignores prose stopwords even when quoted', () => {
  const help = "  --model <model>  Pass the 'model' alias or the 'latest' build\n";
  assert.deepEqual(parseModelHints(help), []);
});
