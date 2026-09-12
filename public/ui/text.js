// Display-string helpers for the dashboard. Pure — no DOM, no fetch, no module
// state — so they are unit-tested directly (test/dashboard-text.test.js), the
// same reason scope.js exists.
//
// Why this is a module and not a ternary at each call site. The owner, looking
// at a project page that said "1 agents": "if there is 1 it needs to be agent
// not agents". The dashboard prints counts in ten or so places and each one
// carried its own `${n === 1 ? '' : 's'}`; some were right, some were not, and
// nothing could tell you which. One helper, one test over the strings the UI can
// actually produce, and the rule cannot rot in a corner nobody looked at.

// The NOUN alone, agreeing with the count: plural(1, 'agent') === 'agent'.
// For an irregular plural pass the second form: plural(2, 'entry', 'entries').
export function plural(count, one, many = `${one}s`) {
  return Number(count) === 1 ? one : many;
}

// The count and the noun: countOf(1, 'agent') === '1 agent'. This is what almost
// every call site wants; `plural` is for a slot that already shows the number
// separately (a stat card, where the figure is its own element).
export function countOf(count, one, many) {
  return `${count} ${plural(count, one, many)}`;
}

// Verb agreement for a sentence built around a count: "1 lane is running",
// "2 lanes are running".
export function isAre(count) {
  return Number(count) === 1 ? 'is' : 'are';
}
