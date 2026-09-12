// A lane's captured final report (`lane.resultText`) — the one field an
// orchestrator reads to decide whether to accept the work.
//
// It used to be cut at 12,000 characters by the event normalizer, silently. On
// 2026-09-11 four Codex lanes came back at exactly 12,000 characters, every one
// cut mid-sentence with nothing saying so; their real reports were 16,870,
// 16,913, 18,261 and 28,719 characters, so the largest lost 58% of itself. The
// same capped value was written into `outcome.txt` and `transcript.json`, so the
// complete text survived only inside the raw `stdout.log`.
//
// This module owns the cap and the honesty around it, so every surface that
// shows a captured result says the same thing:
//   - the whole text is written to the lane's `result.txt` artifact, always,
//     whether or not it needed cutting;
//   - what is STORED is capped, and when it is cut it ends with a notice giving
//     the full length and naming the artifact;
//   - `resultTruncated`, `resultFullLength` and `resultArtifact` carry the same
//     facts as structured fields, for callers that render a preview.

// What a lane record (and therefore state.json, lane.get and lane.list) keeps.
//
// Sized against measurement, not taste. On the live state of 2026-09-11 the
// median stored result was 2,152 characters and 11 of 86 lanes sat at exactly
// the old 12,000 cap — i.e. 13% of lanes were being cut. 32,000 holds all four
// of the reports measured that day whole, the largest with 11% to spare.
//
// The cost is bounded and small: resultText is one of the few lane fields still
// in hot state since v4 moved logs and agent events into journals, and it was
// 391 KB of a 1.42 MB state.json. Storing those 11 lanes whole would have added
// roughly 88 KB (+6%). The absolute worst case is the terminal-lane cap —
// ORCA_MAX_TERMINAL_LANES_PER_SESSION, default 200 — so 6.4 MB instead of 2.4
// MB, and only if every one of 200 lanes emitted a maximal report.
//
// Past this the cap is no longer where data goes to die: result.txt has the rest.
export const MAX_RESULT_CONTENT = 32000;

// Ceiling on the text captured from the executor stream at all, so a runaway
// agent emitting an unbounded "final message" cannot be copied into an artifact
// without limit. Far above any real report; when it bites, the notice says so.
export const MAX_RESULT_CAPTURE = 1024 * 1024;

export const LANE_RESULT_ARTIFACT = 'result.txt';

const integer = (value) => (Number.isFinite(value) ? Math.trunc(value) : 0);

export function resultTruncationNotice({ fullLength, keptLength, artifact = LANE_RESULT_ARTIFACT }) {
  const lost = Math.max(0, integer(fullLength) - integer(keptLength));
  return `\n\n[orca] RESULT TRUNCATED — this is the first ${integer(keptLength).toLocaleString('en-US')} characters of a ${integer(fullLength).toLocaleString('en-US')}-character report; ${lost.toLocaleString('en-US')} characters are not shown here. The complete text is this lane's \`${artifact}\` artifact (lane.artifacts.get { name: "${artifact}" }).`;
}

// Split a captured report into what the lane record stores and what must be
// written whole to an artifact. `full` is the complete captured text.
export function captureLaneResult(full) {
  const text = String(full ?? '');
  if (text.length <= MAX_RESULT_CONTENT) {
    return {
      text,
      fullText: text,
      truncated: false,
      fullLength: text.length,
      artifact: LANE_RESULT_ARTIFACT,
    };
  }
  const kept = text.slice(0, MAX_RESULT_CONTENT);
  return {
    text: kept + resultTruncationNotice({ fullLength: text.length, keptLength: kept.length }),
    fullText: text,
    truncated: true,
    fullLength: text.length,
    artifact: LANE_RESULT_ARTIFACT,
  };
}

// Record the capture on the lane. Returns the full text an artifact writer must
// persist, so the caller decides when/where the write happens.
export function applyLaneResult(lane, full, at) {
  const capture = captureLaneResult(full);
  lane.resultText = capture.text;
  lane.resultTruncated = capture.truncated;
  lane.resultFullLength = capture.fullLength;
  lane.resultArtifact = capture.artifact;
  if (at) lane.resultAt = at;
  return capture.fullText;
}

// One line a preview (lane.list, the MCP lane tree, a dashboard row) can append
// so a clipped result never reads as a complete one. Null when there is nothing
// to warn about.
export function resultPreviewNotice(lane) {
  if (!lane || !lane.resultTruncated) return null;
  return `result truncated: ${integer(lane.resultFullLength).toLocaleString('en-US')} chars total, full text in the \`${lane.resultArtifact || LANE_RESULT_ARTIFACT}\` artifact`;
}
