// A lane's log lines and agent events, persisted in per-lane journal files
// (lane-journal.js) instead of state.json. Prototype mixin for OrcaRegistry.
//
// In memory a lane keeps the same capped arrays it always had (`lane.logs`,
// `lane.agentEvents`), so every existing reader and writer is unchanged. What
// changes is persistence:
//   - new entries are APPENDED to the lane's journal (debounced, and always
//     before state.json is written), found by scanning each array back from its
//     end to the first entry already on disk;
//   - the state.json snapshot drops both arrays and keeps their counts;
//   - a lane restored from disk has no arrays until something needs them: a
//     writer loads them from the journal first, and a reader (lane.get, the
//     transcript) gets a copy read from the journal without keeping it.
// If a journal append fails, that lane's arrays stay INLINE in the snapshot, so
// nothing depends on a file that was never written.

import { readJournalTail, appendJournalEntries } from './lane-journal.js';

// The in-memory (and lane.get) view keeps at most this many entries per stream,
// exactly as before; the journal keeps everything.
export const MAX_LANE_LOG_ENTRIES = 2000;
export const MAX_AGENT_EVENT_ENTRIES = 3000;
const JOURNAL_FLUSH_DELAY_MS = 250;

const STREAMS = [
  { field: 'logs', stream: 'logs', max: MAX_LANE_LOG_ENTRIES, count: 'logCount' },
  { field: 'agentEvents', stream: 'agentEvents', max: MAX_AGENT_EVENT_ENTRIES, count: 'agentEventCount' },
];

const isEntry = (value) => value !== null && typeof value === 'object';

export const laneJournalMethods = {
  laneStreamsLoaded(lane) {
    return Boolean(lane) && Array.isArray(lane.logs) && Array.isArray(lane.agentEvents);
  },

  // Load a restored lane's streams from its journal before anything appends to
  // them. Entries read from disk are already journaled.
  ensureLaneStreams(lane) {
    if (!lane || this.laneStreamsLoaded(lane)) return lane;
    for (const { field, stream, max } of STREAMS) {
      if (Array.isArray(lane[field])) continue;
      const entries = lane.id ? readJournalTail(this.storageDir, lane.id, stream, max) : [];
      for (const entry of entries) if (isEntry(entry)) this._journaled.add(entry);
      lane[field] = entries;
    }
    this._laneTailCache?.delete(String(lane.id));
    return lane;
  },

  // The lane as readers have always seen it (logs + agentEvents included),
  // without pulling a restored lane's streams into memory for good.
  laneForRead(lane) {
    if (!lane || this.laneStreamsLoaded(lane)) return lane;
    const view = { ...lane };
    for (const { field, stream, max } of STREAMS) {
      if (!Array.isArray(view[field])) view[field] = readJournalTail(this.storageDir, lane.id, stream, max);
    }
    return view;
  },

  laneStreamCounts(lane) {
    if (!lane) return { logs: 0, agentEvents: 0 };
    return {
      logs: Array.isArray(lane.logs) ? lane.logs.length : (Number(lane.logCount) || 0),
      agentEvents: Array.isArray(lane.agentEvents) ? lane.agentEvents.length : (Number(lane.agentEventCount) || 0),
    };
  },

  // The newest `count` agent events (the lane-list preview). A restored lane's
  // tail is read once from its journal and cached until the lane is loaded.
  laneAgentEventTail(lane, count) {
    if (!lane) return [];
    if (Array.isArray(lane.agentEvents)) return lane.agentEvents.slice(-count);
    const key = String(lane.id);
    let cached = this._laneTailCache.get(key);
    if (!cached || cached.count !== count) {
      cached = { count, events: readJournalTail(this.storageDir, lane.id, 'agentEvents', count) };
      this._laneTailCache.set(key, cached);
    }
    return cached.events;
  },

  _scheduleJournalFlush() {
    if (this._journalTimer) return;
    this._journalTimer = setTimeout(() => {
      this._journalTimer = null;
      this._flushLaneJournals();
    }, JOURNAL_FLUSH_DELAY_MS);
    this._journalTimer.unref?.();
  },

  // Append every entry not yet on disk. Synchronous, so collecting, writing and
  // marking cannot interleave with another flush. Returns the ids of lanes whose
  // append failed; their entries stay unmarked and are retried next time.
  _flushLaneJournals() {
    if (this._journalTimer) {
      clearTimeout(this._journalTimer);
      this._journalTimer = null;
    }
    const failed = new Set();
    if (!this._storageReady) return failed;
    for (const lane of this.lanes || []) {
      if (!lane?.id) continue;
      for (const { field, stream } of STREAMS) {
        const entries = lane[field];
        if (!Array.isArray(entries) || !entries.length) continue;
        let index = entries.length - 1;
        while (index >= 0 && !(isEntry(entries[index]) && this._journaled.has(entries[index]))) index -= 1;
        const pending = entries.slice(index + 1).filter(isEntry);
        if (!pending.length) continue;
        try {
          appendJournalEntries(this.storageDir, lane.id, stream, pending);
          for (const entry of pending) this._journaled.add(entry);
        } catch (error) {
          failed.add(lane.id);
          if (!this._journalErrorLogged) {
            this._journalErrorLogged = true;
            console.error(`Lane journal append failed (${lane.id}); keeping that lane's streams in state.json until it succeeds:`, error?.message || error);
          }
        }
      }
    }
    if (!failed.size) this._journalErrorLogged = false;
    return failed;
  },

  // A lane as state.json stores it: streams out, counts in — unless its journal
  // could not be written, in which case the streams stay inline.
  _laneForSnapshot(lane, failedJournalLaneIds) {
    if (!lane || typeof lane !== 'object') return lane;
    if (failedJournalLaneIds?.has(lane.id)) return lane;
    const { logs, agentEvents, ...record } = lane;
    const counts = this.laneStreamCounts(lane);
    return { ...record, logCount: counts.logs, agentEventCount: counts.agentEvents };
  },
};
