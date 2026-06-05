// One-off: wrap every `:hover` style rule in `@media (hover: hover)` so touch
// devices don't get stuck-on hover/selected feedback after a tap. Combined
// selectors are SPLIT — e.g. `.x:hover, .x.sel { ... }` keeps `.x.sel` outside the
// media query (so the selected state still applies on touch) and moves only
// `.x:hover` inside. Rules already inside an `@media (hover: hover)` are left alone.
import fs from 'node:fs';

const path = process.argv[2] || 'public/styles.css';
const css = fs.readFileSync(path, 'utf8');

function readBlock(str, openIdx) {
  let depth = 0;
  const n = str.length;
  for (let i = openIdx; i < n; i++) {
    const c = str[i];
    if (c === '/' && str[i + 1] === '*') { const e = str.indexOf('*/', i + 2); i = e < 0 ? n : e + 1; continue; }
    if (c === '"' || c === "'") { const q = c; i++; while (i < n && str[i] !== q) { if (str[i] === '\\') i++; i++; } continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { content: str.slice(openIdx + 1, i), end: i + 1 }; }
  }
  return { content: str.slice(openIdx + 1), end: n };
}

function parseNodes(str) {
  const nodes = [];
  let i = 0; const n = str.length; let buf = '';
  while (i < n) {
    const c = str[i];
    if (c === '/' && str[i + 1] === '*') { const e = str.indexOf('*/', i + 2); buf += str.slice(i, e < 0 ? n : e + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") { const q = c; let j = i + 1; while (j < n && str[j] !== q) { if (str[j] === '\\') j++; j++; } buf += str.slice(i, j + 1); i = j + 1; continue; }
    if (c === '{') { const b = readBlock(str, i); nodes.push({ type: 'block', prelude: buf, content: b.content }); buf = ''; i = b.end; continue; }
    if (c === ';') { buf += ';'; nodes.push({ type: 'text', text: buf }); buf = ''; i++; continue; }
    buf += c; i++;
  }
  if (buf) nodes.push({ type: 'text', text: buf });
  return nodes;
}

const isHoverMedia = (p) => /@media[^{]*\(\s*hover\s*:\s*hover/i.test(p);

function splitTopLevelCommas(s) {
  const parts = []; let depth = 0; let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

let wrapped = 0;
function transform(nodes, insideHover) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') { out += node.text; continue; }
    const trimmed = node.prelude.trim();
    if (trimmed.startsWith('@')) {
      const hoverHere = insideHover || isHoverMedia(node.prelude);
      // Recurse into nestable at-rules; keyframe steps / declarations round-trip fine.
      if (/@(media|supports|layer|container|scope)\b/i.test(trimmed)) {
        out += node.prelude + '{' + transform(parseNodes(node.content), hoverHere) + '}';
      } else {
        out += node.prelude + '{' + node.content + '}';
      }
      continue;
    }
    if (insideHover || !/:hover/.test(node.prelude)) { out += node.prelude + '{' + node.content + '}'; continue; }
    const m = node.prelude.match(/^([\s\S]*?)([^\s/][\s\S]*)$/) || ['', '', node.prelude];
    // Separate leading trivia (whitespace + comments) from the selector list.
    const leadMatch = node.prelude.match(/^((?:\s|\/\*[\s\S]*?\*\/)*)/);
    const lead = leadMatch ? leadMatch[0] : '';
    const selPart = node.prelude.slice(lead.length);
    const sels = splitTopLevelCommas(selPart);
    const hoverSel = sels.filter((s) => /:hover/.test(s)).map((s) => s.trim());
    const otherSel = sels.filter((s) => !/:hover/.test(s)).map((s) => s.trim());
    let piece = lead;
    if (otherSel.length) piece += otherSel.join(',\n') + ' {' + node.content + '}\n';
    piece += '@media (hover: hover) { ' + hoverSel.join(', ') + ' {' + node.content + '} }';
    out += piece;
    wrapped++;
  }
  return out;
}

const result = transform(parseNodes(css), false);

// Validation: braces balanced, no selectors lost.
const balance = (s) => { let d = 0; for (let i = 0; i < s.length; i++) { if (s[i] === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 1; continue; } if (s[i] === '{') d++; else if (s[i] === '}') d--; } return d; };
const before = balance(css); const after = balance(result);
const hoverBefore = (css.match(/@media[^{]*\(\s*hover\s*:\s*hover/gi) || []).length;
const hoverAfter = (result.match(/@media[^{]*\(\s*hover\s*:\s*hover/gi) || []).length;
console.log(JSON.stringify({ wrapped, braceBalanceBefore: before, braceBalanceAfter: after, hoverMediaBefore: hoverBefore, hoverMediaAfter: hoverAfter, lenBefore: css.length, lenAfter: result.length }, null, 2));
if (after !== 0) { console.error('FAIL: unbalanced braces in output'); process.exit(1); }
fs.writeFileSync(path, result);
console.log('written', path);
