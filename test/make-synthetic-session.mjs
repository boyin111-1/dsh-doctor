// Build synthetic session logs for dsh-doctor --session/--fix testing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-test-'));
const header = { type: 'session', version: 0, id: 'synthetic', createdAt: 1786600000000, delegationDepth: 0 };
const ev = (seq, type, extra = {}) => JSON.stringify({ type, seq, time: 1000 + seq, data: { turn: 1, ...extra } });

// 1) Healthy log WITH packed rows: seq 0..7 contiguous, packed row covers 4..7.
const healthy = [
  JSON.stringify(header),
  ev(0, 'turn/start'),
  ev(1, 'user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
  ev(2, 'assistant/chunk', { chunk: { type: 'text', text: 'a' } }),
  ev(3, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] }, sourceEventSeqs: [2] }),
  JSON.stringify({ type: 'text-chunks', seq0: 4, time0: 1004, data: { turn: 1, step: 1, index: 1, dt: [1, 1], texts: ['b', 'c'] } }),
  ev(7, 'turn/end', { reason: { kind: 'completed' } }),
].join('\n') + '\n';
const healthyPath = path.join(dir, 'healthy.jsonl');
fs.writeFileSync(healthyPath, healthy, 'utf8');

// 2) Corrupted log: hole (seq 2 missing), duplicate (seq 3 twice), forward ref
//    (sourceEventSeqs [5] on seq 4), dangling ref (sourceEventSeqs [99]),
//    surfaceOp referencing a missing seq, and a packed row.
const corrupt = [
  JSON.stringify(header),
  ev(0, 'turn/start'),
  ev(1, 'turn/end', { reason: { kind: 'completed' } }),
  ev(3, 'turn/start', { turn: 2 }),
  ev(3, 'turn/start', { turn: 2 }),                       // duplicate
  JSON.stringify({ type: 'assistant/message', seq: 4, time: 1004, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } }, sourceEventSeqs: [5, 99] }), // forward + dangling
  ev(5, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  JSON.stringify({ type: 'user/message', seq: 6, time: 1006, data: { turn: 3, content: [{ type: 'text', text: 'compact' }], source: { kind: 'user' } }, surfaceOp: { op: 'replace', start: 1, end: 5 }, sourceEventSeqs: [1, 3, 4, 5] }), // surfaceOp end=5 fine, start=1 fine (after remap), but sourceEventSeqs [3,4] -> duplicates... keep simple
  ev(7, 'turn/end', { turn: 3, reason: { kind: 'completed' } }),
  JSON.stringify({ type: 'text-chunks', seq0: 8, time0: 1008, data: { turn: 3, step: 1, index: 1, dt: [1, 1], texts: ['y', 'z'] } }),
  ev(10, 'turn/start', { turn: 4 }),                      // hole at 9 (packed covers 8,9,10? no: seq0=8 dt len 2 -> 8,9; then 10 follows -> contiguous)
].join('\n') + '\n';
// wait: packed seq0=8 with dt [1,1] covers 8,9; ev(10) follows -> contiguous. Fix: make ev(11) to leave hole at 10.
const corrupt2 = corrupt.replace(
  JSON.stringify({ type: 'user/message', seq: 6, time: 1006, data: { turn: 3, content: [{ type: 'text', text: 'compact' }], source: { kind: 'user' } }, surfaceOp: { op: 'replace', start: 1, end: 5 }, sourceEventSeqs: [1, 3, 4, 5] }),
  JSON.stringify({ type: 'user/message', seq: 6, time: 1006, data: { turn: 3, content: [{ type: 'text', text: 'compact' }], source: { kind: 'user' } }, surfaceOp: { op: 'replace', start: 1, end: 5 }, sourceEventSeqs: [1, 3, 4, 5, 99] }),
).replace(ev(10, 'turn/start', { turn: 4 }), ev(11, 'turn/start', { turn: 4 }));
const corruptPath = path.join(dir, 'corrupt.jsonl');
fs.writeFileSync(corruptPath, corrupt2, 'utf8');

console.log(JSON.stringify({ dir, healthyPath, corruptPath }));
