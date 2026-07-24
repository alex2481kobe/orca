// Pure, dependency-free text renderer that draws a session's lanes as a
// Claude-Code-style tree (├─ └─ │ connectors) for return through MCP tools, so a
// chat asking "show me what lanes are active" gets a readable monospace picture
// instead of raw JSON. No I/O, no registry coupling — trivially unit-testable.
//
// Output is plain text using light box-drawing glyphs; the caller should wrap it
// in a Markdown code fence so a chat client preserves the monospace alignment.

const GLYPH = {
  queued: '◷',
  starting: '◐',
  running: '●',
  ready_for_audit: '◆',
  auditing: '🔍',
  fix_requested: '↻',
  accepted: '✓',
  blocked: '⛔',
  stopped: '◼',
  done: '✓',
  failed: '✗',
  archived: '·',
};

// Truncate by code points (not UTF-16 units) so emoji/CJK don't blow past the
// budget mid-surrogate, and collapse newlines so a multi-line value stays one row.
function clip(value, max = 64) {
  const oneLine = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const points = Array.from(oneLine);
  if (points.length <= max) return oneLine;
  return `${points.slice(0, Math.max(1, max - 1)).join('')}…`;
}

function laneGlyph(state) {
  return GLYPH[String(state || '').toLowerCase()] || '○';
}

function agentLine(lane) {
  const parts = [lane.executorType || 'mock'];
  if (lane.model) parts.push(lane.model);
  if (lane.permissionsProfile) parts.push(lane.permissionsProfile);
  if (lane.intelligenceProfile) parts.push(lane.intelligenceProfile);
  return parts.filter(Boolean).map((p) => clip(p, 40)).join(' · ');
}

function detailLines(lane) {
  const lines = [agentLine(lane)];
  const task = clip(lane.taskDescription || lane.taskPrompt || lane.title, 64);
  if (task) lines.push(`task: ${task}`);
  const audit = String(lane.auditState || 'not_queued');
  const meta = [];
  if (audit && audit !== 'not_queued') meta.push(`audit: ${audit}`);
  if (meta.length) lines.push(meta.join('   '));
  if (lane.targetUrl) lines.push(`url: ${clip(lane.targetUrl, 60)}`);
  else if (lane.branch) lines.push(`branch: ${clip(lane.branch, 56)}`);
  if (lane.resultText) lines.push(`result: ${clip(lane.resultText, 64)}`);
  return lines.filter(Boolean);
}

function summaryCounts(lanes) {
  const counts = {};
  for (const lane of lanes) counts[lane.state] = (counts[lane.state] || 0) + 1;
  return Object.entries(counts).map(([state, n]) => `${n} ${state}`).join(' · ');
}

// session: { name } ; lanes: array of compact lane objects (listLanesCompact shape).
export function renderLaneTree(session, lanes = []) {
  const all = Array.isArray(lanes) ? lanes : [];
  const name = clip(session?.name || 'Session', 60);
  const header = all.length
    ? `${name} — ${all.length} lane${all.length === 1 ? '' : 's'} (${summaryCounts(all)})`
    : `${name} — no lanes yet`;
  const out = [header];

  // Top-level = non-auditor lanes. Auditor lanes nest under their target.
  const auditorsByTarget = new Map();
  const auditorsOrphan = [];
  for (const lane of all) {
    if (lane.owner === 'auditor') {
      if (lane.auditTargetLaneId) {
        const list = auditorsByTarget.get(lane.auditTargetLaneId) || [];
        list.push(lane);
        auditorsByTarget.set(lane.auditTargetLaneId, list);
      } else {
        auditorsOrphan.push(lane);
      }
    }
  }
  const tops = all.filter((lane) => lane.owner !== 'auditor').concat(auditorsOrphan);

  if (!tops.length) {
    out.push('│');
    out.push('└─ (none)');
    return out.join('\n');
  }

  out.push('│');
  tops.forEach((lane, index) => {
    const last = index === tops.length - 1;
    const branch = last ? '└─' : '├─';
    const pad = last ? '   ' : '│  ';
    out.push(`${branch} ${laneGlyph(lane.state)} ${clip(lane.title, 56)}  [${lane.state}]`);
    const details = detailLines(lane);
    const auditors = auditorsByTarget.get(lane.id) || [];
    details.forEach((line) => out.push(`${pad}  ${line}`));
    auditors.forEach((auditor, aIdx) => {
      const aLast = aIdx === auditors.length - 1;
      const aBranch = aLast ? '└─' : '├─';
      out.push(`${pad}${aBranch} ${laneGlyph(auditor.state)} ${clip(auditor.title, 48)}  [${auditor.state}] (${auditor.executorType || 'mock'})`);
    });
  });

  return out.join('\n');
}
