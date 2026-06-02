import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stub so the public/ui render modules import cleanly under node:test.
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, insertAdjacentElement() {} }),
  querySelector: () => null,
  addEventListener() {},
};
globalThis.window = globalThis.window || {};

const { shell } = await import('../public/ui/state.js');
const fragments = await import('../public/ui/render-fragments.js');

function seedProfiles() {
  shell.executorProfiles = {
    codex: {
      capabilities: {
        controls: {
          permissions: { values: ['plan', 'read-only', 'auto-edit', 'bypass-permissions'] },
          intelligence: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] },
          model: { values: ['gpt-5.5', 'gpt-5'], defaultValue: 'gpt-5.5' },
        },
      },
    },
    claude: {
      capabilities: {
        controls: {
          permissions: { values: ['plan', 'read-only', 'auto-edit', 'acceptEdits', 'bypassPermissions'] },
          intelligence: { passthrough: true },
          model: { values: ['claude-opus-4-7'] },
        },
      },
    },
    mock: {},
  };
}

test('lane mode options are dynamic and distinct per executor capability', () => {
  seedProfiles();
  const codex = fragments.runModeOptionsFor('codex', 'plan');
  const claude = fragments.runModeOptionsFor('claude', 'plan');
  assert.ok(codex.includes('bypass-permissions'), 'codex shows its sandbox bypass mode');
  assert.ok(!codex.includes('acceptEdits'), 'codex does not show Claude-only acceptEdits');
  assert.ok(claude.includes('acceptEdits'), 'claude shows acceptEdits');
  assert.notEqual(codex, claude, 'codex and claude render distinct mode lists');
});

test('undetected/mock executor falls back to the static superset', () => {
  seedProfiles();
  const mock = fragments.runModeOptionsFor('mock', 'plan');
  // Static superset includes both vendors' modes so the form is never empty.
  assert.ok(mock.includes('acceptEdits') && mock.includes('bypassPermissions'), 'mock falls back to superset');
});

test('intelligence passthrough is honored when the CLI has no effort flag', () => {
  seedProfiles();
  const claude = fragments.intelligenceOptionsFor('claude', 'high');
  assert.ok(claude.includes('Default (CLI config)'), 'claude intelligence defers to CLI config');
  const codex = fragments.intelligenceOptionsFor('codex', 'high');
  assert.ok(codex.includes('xhigh'), 'codex shows its detected effort levels');
});

test('model preset options surface the CLI default and known values', () => {
  seedProfiles();
  const codex = fragments.modelPresetOptionsFor('codex', '');
  assert.ok(codex.includes('Default (gpt-5.5)'), 'codex shows its default model in the Default label');
  assert.ok(codex.includes('gpt-5'), 'codex lists its known models');
});
