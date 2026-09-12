// "if there is 1 it needs to be agent not agents" — the owner, on a project
// header that read "1 agents".
//
// The dashboard prints counts in a dozen places and each one used to carry its
// own `${n === 1 ? '' : 's'}`. Some were right ("1 older lane not shown"), some
// were not ("1 agents", "1 lanes, none running"), and nothing could tell them
// apart. public/ui/text.js is now the one owner, and this covers both the helper
// and the actual strings the screens build with it — a helper that is correct
// while a call site bypasses it is not a fix.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { countOf, isAre, plural } from '../public/ui/text.js';

test('plural agrees with the count, for every noun the dashboard prints', () => {
  for (const noun of ['agent', 'lane', 'project', 'device', 'min', 'hour', 'day']) {
    assert.equal(plural(1, noun), noun, `1 ${noun} is singular`);
    assert.equal(plural(0, noun), `${noun}s`, `0 is plural: "0 ${noun}s"`);
    assert.equal(plural(2, noun), `${noun}s`);
    assert.equal(plural(11, noun), `${noun}s`);
  }
  // A count that arrives as a string from an attribute or JSON still agrees.
  assert.equal(plural('1', 'agent'), 'agent');
  assert.equal(plural('3', 'agent'), 'agents');
  // Irregulars are declared, never guessed.
  assert.equal(plural(1, 'entry', 'entries'), 'entry');
  assert.equal(plural(4, 'entry', 'entries'), 'entries');
});

test('countOf prints the number with a noun that agrees', () => {
  assert.equal(countOf(0, 'agent'), '0 agents');
  assert.equal(countOf(1, 'agent'), '1 agent');
  assert.equal(countOf(2, 'agent'), '2 agents');
  assert.equal(countOf(1, 'lane'), '1 lane');
  assert.equal(countOf(1, 'project'), '1 project');
});

test('isAre agrees too, so a sentence built around a count reads', () => {
  assert.equal(`${countOf(1, 'lane')} ${isAre(1)} running`, '1 lane is running');
  assert.equal(`${countOf(3, 'lane')} ${isAre(3)} running`, '3 lanes are running');
  assert.equal(`${countOf(0, 'lane')} ${isAre(0)} running`, '0 lanes are running');
});

// The screens, not just the helper. Each string below is built the way the
// module builds it; if a call site drops back to its own ternary, the shape it
// produces has to keep matching these.
test('every count the dashboard prints reads correctly at one', () => {
  const sidebarIdle = (lanes) => `${countOf(lanes, 'lane')}, none running`;
  assert.equal(sidebarIdle(1), '1 lane, none running');
  assert.equal(sidebarIdle(0), '0 lanes, none running');

  const agentNode = (older) => `${countOf(older, 'older lane')} not shown`;
  assert.equal(agentNode(1), '1 older lane not shown');
  assert.equal(agentNode(5), '5 older lanes not shown');

  const held = (n) => `Orca is holding ${countOf(n, 'project')} right now`;
  assert.equal(held(1), 'Orca is holding 1 project right now');
  assert.equal(held(3), 'Orca is holding 3 projects right now');

  const archived = (n) => `${countOf(n, 'archived project')} ${isAre(n)} kept out of the panel.`;
  assert.equal(archived(1), '1 archived project is kept out of the panel.');
  assert.equal(archived(2), '2 archived projects are kept out of the panel.');

  const devices = (n) => countOf(n, 'device');
  assert.equal(devices(1), '1 device');
  assert.equal(devices(0), '0 devices');
});

// The rot guard. A helper is only a fix while every call site uses it: this whole
// bug class was a dozen hand-rolled `${n === 1 ? '' : 's'}` ternaries, most of
// them right, one of them printing "1 lanes, none running" in the panel and
// "1 Active agents" on a stat card. If a new one appears, it fails here rather
// than being spotted in a screenshot months later.
test('no dashboard module hand-rolls pluralisation instead of using text.js', () => {
  const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'ui');
  const HAND_ROLLED = /===\s*1\s*\?\s*'[^']*'\s*:\s*'[^']*'/;
  const offenders = [];
  for (const name of fs.readdirSync(uiDir)) {
    if (!name.endsWith('.js') || name === 'text.js') continue;
    fs.readFileSync(path.join(uiDir, name), 'utf8').split('\n').forEach((line, index) => {
      if (HAND_ROLLED.test(line)) offenders.push(`${name}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `these lines pluralise by hand — use countOf/plural/isAre from public/ui/text.js instead:\n${offenders.join('\n')}`,
  );
});
