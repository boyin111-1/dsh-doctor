// 诊断脚本 v2：dump 会话里所有 turn/end reason + error 相关事件 + 最近消息
// 用法：node scan-sessions.mjs [sessions目录]（缺省取 $DSH_HOME/sessions，再缺省 ~/.dsh/sessions）
import { zstdDecompressSync } from 'node:zlib';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

const sessionsRoot = process.argv[2]
	?? (process.env.DSH_HOME && process.env.DSH_HOME.trim() ? path.join(process.env.DSH_HOME.trim(), 'sessions') : null)
	?? path.join(homedir(), '.dsh', 'sessions');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name === 'session.jsonl.zstd') files.push(full);
  }
})(sessionsRoot);

for (const f of files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, 4)) {
  try {
    const buf = zstdDecompressSync(fs.readFileSync(f));
    const lines = buf.toString('utf-8').split('\n');
    console.log(`\n════════ ${new Date(fs.statSync(f).mtime).toLocaleString()} ${path.basename(path.dirname(f))} ════════`);
    let turns = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'turn/end') {
          turns++;
          const r = e.data?.reason;
          if (r?.kind !== 'completed') {
            console.log(`  turn/end turn=${e.data?.turn} kind=${r?.kind} ${JSON.stringify(r?.error ?? r?.failure ?? '').slice(0, 500)}`);
          }
        } else if (e.type === 'step/end') {
          const r = e.data?.reason;
          if (r && r.kind !== 'completed' && r.kind !== 'tools-owned') {
            console.log(`  step/end turn=${e.data?.turn} step=${e.data?.step} kind=${r?.kind} ${JSON.stringify(r?.error ?? '').slice(0, 500)}`);
          }
        } else if (e.type?.includes('error') || e.type?.includes('fail')) {
          console.log(`  [${e.type}] ${JSON.stringify(e.data ?? e).slice(0, 400)}`);
        }
      } catch { /* skip */ }
    }
    console.log(`  （共 ${turns} 个 turn/end）`);
  } catch (err) {
    console.log(`⚠️ ${f}: ${err.message}`);
  }
}
