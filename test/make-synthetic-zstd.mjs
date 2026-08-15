// Build a corrupted .jsonl.zstd session (header frame + event frame) for
// dsh-doctor --session/--fix round-trip testing.
import fs from 'node:fs';
import { zstdCompressSync, constants } from 'node:zlib';

const out = process.argv[2];
const header = { type: 'session', version: 0, id: 'synthetic-zstd', createdAt: 1786600000000, delegationDepth: 0 };
const ev = (seq, type, extra = {}) => JSON.stringify({ type, seq, time: 1000 + seq, data: { turn: 1, ...extra } });

const corrupt = [
  JSON.stringify(header),
  ev(0, 'turn/start'),
  ev(1, 'turn/end', { reason: { kind: 'completed' } }),
  ev(3, 'turn/start', { turn: 2 }),                                       // hole at 2
  JSON.stringify({ type: 'assistant/message', seq: 4, time: 1004, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } }, sourceEventSeqs: [3, 9] }), // dangling 9
  ev(5, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
].join('\n') + '\n';

const headerFrame = zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
const bodyFrame = zstdCompressSync(Buffer.from(corrupt.slice(corrupt.indexOf('\n') + 1)), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
fs.writeFileSync(out, Buffer.concat([headerFrame, bodyFrame]));
console.log('written', out);
