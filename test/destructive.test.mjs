#!/usr/bin/env node
/**
 * dsh-doctor 破坏性测试 —— 在临时 DSH_HOME 里构造 好/坏 profile，
 * 用子进程跑 dsh-doctor.mjs 并断言它「报坏、不误报好」。
 *
 * 运行：node test/destructive.test.mjs
 * 依赖：dsh-doctor.mjs、node 内置 fs/path/child_process（零第三方依赖）。
 *
 * 覆盖检测项：
 *   D1 悬空插件 name:（#1197 族）
 *   D2 file: 链接失效（#1197 族）
 *   D3 重复 entry id（#1404/#1479）
 *   D4 入口产物缺失（#917/#1413：包在但 lib/index.js 不在）
 *   D5 -> D6 dsh.profile.bundles 悬空（#917 永久残留）
 *   D6 -> D7 bundle 无 dsh.bundle.patch（profile.ts 显式抛错路径）
 *   D7 -> D8 bundle 与用户 patch id 冲突（advisory item (a)、#1404/#1479）
 *   D8 -> D9 bundle 冗余 insert（#1404 reconcile 未清理）
 *   T10 TUI 超宽行补丁（缺失检出 + --fix 重打）
 *   T11 toolkit-plugins 持久化插件源码（.mjs/host.js/空壳三分）
 *   T12 host/profile 版本漂移（#1515 reading 'prepare'）
 *   T13 Windows 沙箱 schannel TLS 探测（#1789）
 *   T14 会话日志 seq 完整性（#1497/#1469 seq gap/重复/倒退）
 *   T15 skill frontmatter 冒号陷阱（#1401）
 *   T16 Windows 端口排除段（#1462）
 *   T17 锚点基线防漂移（版本漂移自动核对：脱节/仍有效/一致三场景）
 *   T18 --check-update（在线对比 npm registry，网络不可用降级）
 *   T19 --fix 防漂移闸门（锚点脱节 fail-closed 中止 / --force 强制）
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const doctor = join(__dirname, "..", "dsh-doctor.mjs");

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
	if (cond) { passed++; console.log(`  ✓ ${label}`); }
	else { failed++; console.log(`  ✗ FAIL ${label} ${detail}`); }
}

/** 建一个隔离的 DSH_HOME，返回根目录。 */
function makeHome() {
	return mkdtempSync(join(tmpdir(), "dsh-doctor-test-"));
}

/** 写一个 profile：package.json + 可选 cordis.patch.yml + 可选本地 bundle 包。 */
function writeProfile(home, name, { deps = {}, bundles = [], patch = null, localBundles = {} } = {}) {
	const pdir = join(home, "profiles", name);
	mkdirSync(pdir, { recursive: true });
	const manifest = { name: `dsh-profile-${name}`, private: true, dependencies: deps };
	if (bundles.length) manifest.dsh = { profile: { bundles } };
	writeFileSync(join(pdir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
	writeFileSync(join(pdir, "pnpm-workspace.yaml"), "packages:\n  - .\n");
	if (patch !== null) writeFileSync(join(pdir, "cordis.patch.yml"), patch);
	// 本地 bundle 包放在 profile 的 node_modules 里，保证 createRequire(profile) 能解析
	for (const [bundle, { entryIds = [], hasBundle = true }] of Object.entries(localBundles)) {
		const bpkg = join(pdir, "node_modules", ...bundle.split("/"));
		mkdirSync(bpkg, { recursive: true });
		writeFileSync(join(bpkg, "package.json"), JSON.stringify({
			name: bundle,
			dsh: hasBundle ? { bundle: { patch: "./cordis.patch.yml" } } : undefined,
		}, null, 2) + "\n");
		const rows = entryIds.map((id) => `    - id: ${id}\n      name: '${bundle}'`).join("\n");
		writeFileSync(join(bpkg, "cordis.patch.yml"),
			`# fake bundle\n- insert:\n${rows ? rows + "\n" : ""}`);
	}
	return pdir;
}

/** 跑 dsh-doctor。dsh-doctor 在发现 ✗ 时会以非零码退出，这里把它接住并返回输出。 */
function run(home) {
	return runWith(doctor, [], { DSH_HOME: home });
}
/** 带参数/环境的 dsh-doctor 运行封装。 */
function runWith(bin, args, envExtra = {}) {
	try {
		const out = execFileSync(process.execPath, [bin, ...args], {
			env: { ...process.env, ...envExtra },
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
	}
}

const home = makeHome();

console.log("== D1: 悬空插件 name 引用（应报坏）==");
 {
	const pdir = writeProfile(home, "dangling-name", { patch: "- insert:\n    - id: ghost\n      name: '@ghost-org/never-exists'\n" });
	const { out } = run(home);
	assert(out.includes("悬空引用: @ghost-org/never-exists"), "报出悬空插件", out.split("\n").filter(l=>l.includes("ghost")).join(" | "));
}

console.log("== D2: file: 链接失效（应报坏）==");
writeProfile(home, "broken-file", {
	deps: { "broken-local": "file:/definitely/not/a/dir-xyz" },
});
{
	const { out } = run(home);
	assert(out.includes("file: 链接失效: broken-local"), "报出 file: 链接失效", out.split("\n").filter(l=>l.includes("broken-local")).join(" | "));
}

console.log("== D3: 重复 entry id（应报坏）==");
{
	const pdir = writeProfile(home, "dup-id", {
		deps: { "pkg-a": "^1.0.0" },
		patch: "- insert:\n    - id: same\n      name: 'pkg-a'\n    - id: same\n      name: 'pkg-b'\n",
	});
	mkdirSync(join(pdir, "node_modules", "pkg-a"), { recursive: true });
	mkdirSync(join(pdir, "node_modules", "pkg-b"), { recursive: true });
	writeFileSync(join(pdir, "node_modules/pkg-a/package.json"), '{"name":"pkg-a","main":"index.js"}');
	writeFileSync(join(pdir, "node_modules/pkg-a/index.js"), "");
	writeFileSync(join(pdir, "node_modules/pkg-b/package.json"), '{"name":"pkg-b","main":"index.js"}');
	writeFileSync(join(pdir, "node_modules/pkg-b/index.js"), "");
	const { out } = run(home);
	assert(out.includes("重复 entry id"), "报出重复 entry id", out.split("\n").filter(l=>l.includes("重复")).join(" | "));
}

console.log("== D4: 入口产物缺失（包在但 main 缺，应报坏）==");
{
	const pdir = writeProfile(home, "missing-entry", {
		deps: { "entryless": "^1.0.0" },
	});
	mkdirSync(join(pdir, "node_modules", "entryless"), { recursive: true });
	writeFileSync(join(pdir, "node_modules/entryless/package.json"), '{"name":"entryless","main":"lib/index.js"}');
	const { out } = run(home);
	assert(out.includes("入口产物缺失: entryless"), "报出入口产物缺失", out.split("\n").filter(l=>l.includes("entryless")).join(" | "));
}

console.log("== D5: dsh.profile.bundles 悬空（#917 永久残留，应报坏）==");
writeProfile(home, "dangling-bundle", {
	bundles: ["@ghost-org/no-such-bundle"],
});
{
	const { out } = run(home);
	assert(out.includes("dsh.profile.bundles 悬空: \"@ghost-org/no-such-bundle\""), "报出悬空 bundle", out.split("\n").filter(l=>l.includes("悬空")).join(" | "));
}

console.log("== D6: bundle 无 dsh.bundle（profile.ts 显式抛错路径，应报坏）==");
writeProfile(home, "bundle-no-manifest", {
	bundles: ["@fake/bundle-nom"],
	localBundles: { "@fake/bundle-nom": { hasBundle: false } },
});
{
	const { out } = run(home);
	assert(out.includes('bundle 无 dsh.bundle: "@fake/bundle-nom"'), "报出 bundle 无 dsh.bundle", out.split("\n").filter(l=>l.includes("bundle-nom")).join(" | "));
}

console.log("== D7: bundle 与用户 patch id 冲突（advisory item a / #1404/#1479，应报坏）==");
writeProfile(home, "id-collide", {
	bundles: ["@fake/bundle-a"],
	localBundles: { "@fake/bundle-a": { entryIds: ["pet"] } },
	patch: "- insert:\n    - id: pet\n      name: '@other/plugin-with-same-id'\n",
});
{
	const { out } = run(home);
	assert(out.includes('entry id 冲突: 用户 patch 插入 "pet"'), "报出 bundle/用户 id 冲突", out.split("\n").filter(l=>l.includes("冲突")).join(" | "));
}

console.log("== D8: bundle 冗余 insert（#1404 reconcile 未清理，应报坏/警告）==");
writeProfile(home, "redundant-insert", {
	bundles: ["@fake/bundle-b"],
	localBundles: { "@fake/bundle-b": { entryIds: ["sidebar"] } },
	patch: "- insert:\n    - id: sidebar\n      name: '@fake/bundle-b'\n",
});
{
	const { out } = run(home);
	assert(out.includes("bundle 冗余 insert"), "报出 bundle 冗余 insert", out.split("\n").filter(l=>l.includes("冗余")).join(" | "));
}

console.log("\n== D9: --fix 自动重链 file: 依赖（用假 pnpm shim 记录调用，应报重链成功）==");
if (process.platform === "win32") {
	console.log("  · Windows 无 POSIX sh/shim 执行环境，D9 --fix 重链用例自动跳过");
} else {
{
	const fh = makeHome();
	const target = mkdtempSync(join(tmpdir(), "dsh-fix-target-"));
	writeFileSync(join(target, "package.json"), '{"name":"fixable-local","version":"1.0.0","main":"index.js"}');
	writeFileSync(join(target, "index.js"), "");
	writeProfile(fh, "fixable", { deps: { "fixable-local": `file:${target}` } });
	// 假 pnpm：npx 到 PATH 里，记录 cwd 与参数，退出 0
	const bindir = mkdtempSync(join(tmpdir(), "dsh-fix-bin-"));
	writeFileSync(join(bindir, "pnpm"),
		`#!/usr/bin/env node\nrequire("fs").appendFileSync(process.env.FIX_LOG, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+"\\n");\n`);
	// 给 shim 可执行权限
	execSync(`chmod +x ${JSON.stringify(join(bindir, "pnpm"))}`);
	const fixLog = join(fh, "fix.log");
	let out;
	try {
		out = execSync(`DSH_HOME=${JSON.stringify(fh)} FIX_LOG=${JSON.stringify(fixLog)} PATH=${JSON.stringify(bindir + ":" + process.env.PATH)} ${process.execPath} ${JSON.stringify(doctor)} --fix`, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (e) { out = String(e.stdout ?? "") + String(e.stderr ?? ""); }
	// macOS/linux 下 shim 需真实可执行；Windows 无 sh 则跳过（测试环境为 Linux/macOS）
	const log = readFileSync(fixLog, "utf-8");
	const rec = JSON.parse(log.trim().split("\n").at(-1));
	assert(rec.cwd === join(fh, "profiles", "fixable")
		&& rec.args.includes("add") && rec.args.some((a) => a.startsWith("file:"))
		&& out.includes("重链成功: fixable-local"), "--fix 在 profile 目录执行 pnpm add file: 并报告成功",
		`cwd=${rec.cwd} args=${JSON.stringify(rec.args)}`);
	rmSync(fh, { recursive: true, force: true });
	rmSync(target, { recursive: true, force: true });
	rmSync(bindir, { recursive: true, force: true });
}
}

console.log("\n== D10: --session 悬空 tool_call 检测（#1544/#1363）==");
{
	// 用一个单独的会话目录，feed 合成 JSONL 让 `--session` 检。
	// zstd 存在才能测 zstd 路径；否则合成明文 .jsonl（工具二者都支持）。
	const sh = makeHome();
	const cdir = mkdirSync(join(sh, "sessions"), { recursive: true });
	const base = (turn, step, callId, type) =>
		JSON.stringify({ type, seq: turn * 100 + step, time: 1, data: {
			turn, step, callId, name: "bash",
			...(type === "tool/result" ? { message: { source: { kind: "tool", callId } } } : {}),
		} });
	// 构造真正未配对：call_orphan 只有 call 没有 result，且该 call 不在最新回合（turn2 已有 result）
	const badLines = [
		base(1, 1, "call_ok_1", "tool/call"),
		base(1, 1, "call_ok_1", "tool/result"),
		base(1, 2, "call_orphan_9", "tool/call"),     // ← 悬空（后续回合已到 turn2）
		base(1, 2, "call_orphan_9", "tool/call"),     // 二次 call 仍无 result
		base(2, 1, "call_late", "tool/call"),
		base(2, 1, "call_late", "tool/result"),
	];
	const badLog = join(cdir, "bad.jsonl");
	writeFileSync(badLog, badLines.join("\n") + "\n");
	const { out } = runWith(doctor, ["--session", badLog]);
	assert(out.includes("悬空 tool_call: call_orphan_9"), "会话坏：报出已完成后回合的悬空 tool_call",
		out.split("\n").filter((l) => l.includes("call_orphan")).join(" | "));

	// (b) 好：所有 call 都有 result → 无悬空 ✓（无不误报）
	const goodLog = join(cdir, "good.jsonl");
	writeFileSync(goodLog, [
		base(1, 1, "c1", "tool/call"), base(1, 1, "c1", "tool/result"),
		base(1, 2, "c2", "tool/call"), base(1, 2, "c2", "tool/result"),
		base(2, 1, "c3", "tool/call"), base(2, 1, "c3", "tool/result"),
	].join("\n") + "\n");
	const { out: out2 } = runWith(doctor, ["--session", goodLog]);
	assert(out2.includes("无悬空 tool_call"), "会话好：全绿无不误报",
		out2.split("\n").filter((l) => l.includes("悬空")).join(" | ") || "");

	rmSync(sh, { recursive: true, force: true });
}

console.log("\n== D11: --verify-anchors（检测锚点核对。#1544/#1363 家族更新）==");
{
	// 构造一个假的 dsh 仓库目录树，内含/缺省锚点 token，验证检测逻辑本身。
	const ar = makeHome(); // 复用临时目录作为"仓库根"
	// 构造 anchors 结构：packages/core/session/src、packages/core/tools/src、packages/boot/app-boot/src
	writeFileSync(join(ar, "package.json"), "{}");
	mkdirSync(join(ar, "packages/core/session/src"), { recursive: true });
	mkdirSync(join(ar, "packages/core/tools/src"), { recursive: true });
	mkdirSync(join(ar, "packages/boot/app-boot/src"), { recursive: true });
	// 好：5 个锚点都在（token 用与 real dsh 一致的编译/源码形态）
	writeFileSync(join(ar, "packages/core/session/src/types.ts"),
		"'tool/call': { turn; step; callId };\n" +
		"'tool/result': { message: { source: { callId: CallId } } };\n");
	writeFileSync(join(ar, "packages/core/tools/src/index.ts"), "readonly callId: CallId\n");
	writeFileSync(join(ar, "packages/boot/app-boot/src/profile.ts"),
		"for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {}\ndsh?.bundle?.patch\n");
	let r = runWith(doctor, ["--verify-anchors", ar]);
	assert(r.out.includes("锚点核对: 5") && r.out.includes("5 ✓") && !r.out.includes("✗ 锚点缺失"),
		"verify-anchors 对含全部锚点的树全绿",
		r.out.split("\n").filter((l) => l.includes("锚点")).join(" | ") || "");

	// 坏：删掉 tool/result 配对键锚点 → 报 ✗ 缺锚
	writeFileSync(join(ar, "packages/core/session/src/types.ts"),
		"'tool/call': { turn; step; callId };\n"); // tool/result 配对键消失
	r = runWith(doctor, ["--verify-anchors", ar]);
	assert(r.out.includes("锚点缺失") && r.out.includes("tool/result"),
		"verify-anchors 对缺锚点的树报 ✗（且明确指出缺的是 tool/result）",
		r.out.split("\n").filter((l) => l.includes("锚点")).join(" | ") || "");

	rmSync(ar, { recursive: true, force: true });
}

console.log("\n== GOOD: 健康 profile（应全绿，无误报）==");
{
	// 用独立的 DSH_HOME，避免其它坏 profile 污染断言
	const goodHome = makeHome();
	const pdir = writeProfile(goodHome, "healthy", {
		deps: { "ok-plugin": "^1.0.0" },
		bundles: ["@fake/bundle-ok"],
		localBundles: { "@fake/bundle-ok": { entryIds: ["ok-core"] } },
		patch: "- insert:\n    - id: ok-user\n      name: 'ok-plugin'\n",
	});
	// ok-plugin（普通依赖）：writeProfile 只建 bundle 包，这里补建 deps 包 + 入口
	const okpkg = join(pdir, "node_modules", "ok-plugin");
	mkdirSync(okpkg, { recursive: true });
	writeFileSync(join(okpkg, "package.json"), '{"name":"ok-plugin","main":"index.js"}');
	writeFileSync(join(okpkg, "index.js"), "");
	const { out } = run(goodHome);
	// 只统计 profile 检查段（📦 profile 到 📌 全局检查之间）——全局检查
	// （TUI 补丁/沙箱 TLS/skill frontmatter/端口排除/PATH 工具）依赖本机
	// 环境（如 zstd 是否安装），不属于"profile 是否健康"的断言范围。
	const profileSeg = out.split("📦 profile: healthy")[1]?.split("📌 全局检查")[0] ?? out;
	const profileLines = profileSeg.split("\n").filter((l) => l.trim().startsWith("✓") || l.trim().startsWith("✗") || l.trim().startsWith("⚠"));
	const xl = profileLines.filter((l) => l.trim().startsWith("✗"));
	const wl = profileLines.filter((l) => l.trim().startsWith("⚠"));
	assert(xl.length === 0 && wl.length === 0, "healthy 无 ✗/⚠（无误报）",
		`ℹ ${xl.concat(wl).map((s) => s.trim()).join(" | ") || "full green"}`);
	rmSync(goodHome, { recursive: true, force: true });
}

	console.log("\n== D12: 双模块实例检测（#1486：同版本独立副本=工具层崩溃；symlink/非组件=正常）==");
	{
		// 需要 PATH 里能解析到真实 dsh 安装。若本机无 dsh，FindDualInstances 内部降级跳过，
		// 本用例自动跳过（不做无效断言）。Windows 用 `where`，POSIX 用 `command -v`。
		const dshProbe = process.platform === "win32" ? "where dsh" : "command -v dsh";
		const hasDsh = (() => {
			try { const o = execSync(dshProbe, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim(); return o.length > 0; }
			catch { return false; }
		})();
		if (hasDsh) {
			// 通过 dsh 的 realpath bin 定位安装根（.../@deepseek-ai/dsh）。
			// 与 dsh-doctor.mjs findDshInstall 相同：同时兼容
			// `node_modules/@deepseek-ai/dsh`（npm 全局 prefix）和
			// `lib/node_modules/@deepseek-ai/dsh`（nvm）两种布局。
			let installRoot = null;
			{
				const bin = execSync(dshProbe, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim().split(/\r?\n/)[0];
				let real = bin; try { real = realpathSync(bin); } catch {}
				let d = dirname(real);
				while (dirname(d) !== d) {
					if (basename(d) === "dsh" && basename(dirname(d)) === "@deepseek-ai") { installRoot = d; break; }
					for (const cand of [join(d, "node_modules", "@deepseek-ai", "dsh"), join(d, "lib", "node_modules", "@deepseek-ai", "dsh")]) {
						if (existsSync(join(cand, "package.json"))) { installRoot = cand; break; }
					}
					if (installRoot) break;
					d = dirname(d);
				}
			}
			const installScoped = installRoot ? join(installRoot, "node_modules", "@deepseek-ai") : null;
			if (installScoped && existsSync(installScoped) && readdirSync(installScoped).some((n) => n.startsWith("dsh-"))) {
				const pkg = readdirSync(installScoped).find((n) => n.startsWith("dsh-") && existsSync(join(installScoped, n, "package.json")));
				const installVer = JSON.parse(readFileSync(join(installScoped, pkg, "package.json"), "utf-8")).version;

				// (a) 真目录独立副本（同版本）→ 应报双模块实例
				const hA = makeHome();
				const pA = writeProfile(hA, "dup-inst-a", {});
				mkdirSync(join(pA, "node_modules", "@deepseek-ai", pkg), { recursive: true });
				writeFileSync(join(pA, "node_modules", "@deepseek-ai", pkg, "package.json"),
					JSON.stringify({ name: `@deepseek-ai/${pkg}`, version: installVer, main: "index.js" }, null, 2) + "\n");
				writeFileSync(join(pA, "node_modules", "@deepseek-ai", pkg, "index.js"), "");
				const { out: outA } = run(hA);
				assert(outA.includes("双模块实例: @deepseek-ai/" + pkg), "同版本真目录独立副本→报双模块实例",
					outA.split("\n").filter((l) => l.includes("双模块")).join(" | ") || "");
				rmSync(hA, { recursive: true, force: true });

				// (b) symlink 指向安装同一份（pnpm file: 正常形态）→ 应不报
				// Windows 无 SeCreateSymbolicLinkPrivilege（需管理员/开发者模式）时
				// symlinkSync 抛 EPERM——那是环境限制，跳过该子断言而非让套件崩溃。
				const hB = makeHome();
				const pB = writeProfile(hB, "dup-inst-b", {});
				mkdirSync(join(pB, "node_modules", "@deepseek-ai"), { recursive: true });
				try {
					symlinkSync(join(installScoped, pkg), join(pB, "node_modules", "@deepseek-ai", pkg), "dir");
					const { out: outB } = run(hB);
					assert(!outB.includes("双模块实例"), "symlink 指向安装同一份→不误报",
						outB.split("\n").filter((l) => l.includes("双模块")).join(" | ") || "");
				} catch (e) {
					if (e.code === "EPERM" || e.code === "EACCES") {
						console.log("  · Windows 无 symlink 权限，symlink 子用例跳过（EPERM）");
					} else { throw e; }
				}
				rmSync(hB, { recursive: true, force: true });
			} else {
				console.log("  · 本机 dsh 安装 scoped 目录不可用，双实例用例自动跳过");
			}
		} else {
			console.log("  · 本机 PATH 无 dsh，双实例用例自动跳过");
		}
	}

console.log("\n== T10: TUI 超宽行崩溃补丁（缺失检出 + --fix 重打）==");
{
	const th = makeHome();
	const tuiFile = join(th, "profiles", "tui", "node_modules", "@earendil-works", "pi-tui", "dist", "tui-main-screen.js");
	mkdirSync(dirname(tuiFile), { recursive: true });
	writeFileSync(tuiFile,
		'import { visibleWidth } from "./utils.js";\n' +
		'function render() {\n' +
		'  if (!isImage && visibleWidth(line) > width) {\n' +
		'    throw new Error(errorMsg);\n' +
		'  }\n' +
		'}\n');
	let { out } = runWith(doctor, [], { DSH_HOME: th });
	assert(out.includes("TUI 超宽行崩溃补丁缺失"), "检出 pi-tui 补丁缺失", out.split("\n").filter((l) => l.includes("TUI")).join(" | "));
	({ out } = runWith(doctor, ["--fix"], { DSH_HOME: th }));
	const patched = readFileSync(tuiFile, "utf-8");
	assert(patched.includes("truncateToWidth(line, width)") && !patched.includes("throw new Error(errorMsg);")
		&& existsSync(tuiFile + ".bak"), "--fix 重打补丁（截断替代 throw + .bak 备份）", patched.split("\n")[0]);
	assert(out.includes("补丁已重打"), "--fix 报告补丁已重打", out.split("\n").filter((l) => l.includes("补丁")).join(" | "));
	({ out } = runWith(doctor, [], { DSH_HOME: th }));
	assert(out.includes("TUI 超宽行补丁在位"), "补丁后不再报缺失", out.split("\n").filter((l) => l.includes("TUI")).join(" | "));
	rmSync(th, { recursive: true, force: true });
}

console.log("\n== T11: toolkit-plugins 持久化插件源码（区分 .mjs 工具 / host.js 插件 / 空壳）==");
{
	const th = makeHome();
	writeProfile(th, "web", {});
	const tk = join(th, "profiles", "web", "toolkit-plugins");
	mkdirSync(join(tk, "game-race"), { recursive: true });
	writeFileSync(join(tk, "game-race", "host.js"), "return {}");
	writeFileSync(join(tk, "game-race", "client.js"), "return {}");
	mkdirSync(join(tk, "dev-kit"), { recursive: true });
	writeFileSync(join(tk, "dev-kit", "index.mjs"), "export const apply = () => {}");
	mkdirSync(join(tk, "empty-kit"), { recursive: true });
	const { out } = runWith(doctor, [], { DSH_HOME: th });
	assert(out.includes("持久化动态插件源码: game-race"), "识别 host.js/client.js 动态插件源码", out.split("\n").filter((l) => l.includes("game-race")).join(" | "));
	assert(out.includes("全局工具插件: dev-kit"), "识别 index.mjs 全局工具", out.split("\n").filter((l) => l.includes("dev-kit")).join(" | "));
	assert(out.includes("持久化插件目录异常: empty-kit"), "空壳目录告警", out.split("\n").filter((l) => l.includes("empty-kit")).join(" | "));
	rmSync(th, { recursive: true, force: true });
}

console.log("\n== T12: host/profile 版本漂移（#1515：reading 'prepare' 崩溃场景）==");
{
	// 与 D12 相同：需要 PATH 里能解析到真实 dsh 安装。无则自动跳过。
	const dshProbe = process.platform === "win32" ? "where dsh" : "command -v dsh";
	const hasDsh = (() => {
		try { const o = execSync(dshProbe, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim(); return o.length > 0; }
		catch { return false; }
	})();
	if (hasDsh) {
		// 定位安装 scoped 目录（与 D12 相同逻辑，兼容 npm 全局 prefix / nvm 两种布局）
		let installRoot = null;
		{
			const bin = execSync(dshProbe, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim().split(/\r?\n/)[0];
			let real = bin; try { real = realpathSync(bin); } catch {}
			let d = dirname(real);
			while (dirname(d) !== d) {
				if (basename(d) === "dsh" && basename(dirname(d)) === "@deepseek-ai") { installRoot = d; break; }
				for (const cand of [join(d, "node_modules", "@deepseek-ai", "dsh"), join(d, "lib", "node_modules", "@deepseek-ai", "dsh")]) {
					if (existsSync(join(cand, "package.json"))) { installRoot = cand; break; }
				}
				if (installRoot) break;
				d = dirname(d);
			}
		}
		const installScoped = installRoot ? join(installRoot, "node_modules", "@deepseek-ai") : null;
		if (installScoped && existsSync(installScoped) && readdirSync(installScoped).some((n) => n.startsWith("dsh-"))) {
			const pkg = readdirSync(installScoped).find((n) => n.startsWith("dsh-") && existsSync(join(installScoped, n, "package.json")));

			// (a) profile 顶层放一个不同版本的 dsh-* 真目录副本 → 应报版本漂移
			const hA = makeHome();
			const pA = writeProfile(hA, "drift-a", {});
			mkdirSync(join(pA, "node_modules", "@deepseek-ai", pkg), { recursive: true });
			writeFileSync(join(pA, "node_modules", "@deepseek-ai", pkg, "package.json"),
				JSON.stringify({ name: `@deepseek-ai/${pkg}`, version: "0.0.0-drift", main: "index.js" }, null, 2) + "\n");
			writeFileSync(join(pA, "node_modules", "@deepseek-ai", pkg, "index.js"), "");
			const { out: outA } = run(hA);
			assert(outA.includes("版本漂移: @deepseek-ai/" + pkg), "profile 版本 ≠ 安装版本→报版本漂移(#1515)",
				outA.split("\n").filter((l) => l.includes("漂移")).join(" | ") || "");
			rmSync(hA, { recursive: true, force: true });

			// (b) symlink 指向安装同一份 → 应不报版本漂移（且不误报 #1515）
			// Windows 无 symlink 权限时跳过（EPERM，环境限制）。
			const hB = makeHome();
			const pB = writeProfile(hB, "drift-b", {});
			mkdirSync(join(pB, "node_modules", "@deepseek-ai"), { recursive: true });
			try {
				symlinkSync(join(installScoped, pkg), join(pB, "node_modules", "@deepseek-ai", pkg), "dir");
				const { out: outB } = run(hB);
				assert(!outB.includes("版本漂移"), "symlink 指向安装同一份→不误报版本漂移",
					outB.split("\n").filter((l) => l.includes("漂移")).join(" | ") || "");
			} catch (e) {
				if (e.code === "EPERM" || e.code === "EACCES") {
					console.log("  · Windows 无 symlink 权限，symlink 子用例跳过（EPERM）");
				} else { throw e; }
			}
			rmSync(hB, { recursive: true, force: true });
		} else {
			console.log("  · 本机 dsh 安装 scoped 目录不可用，版本漂移用例自动跳过");
		}
	} else {
		console.log("  · 本机 PATH 无 dsh，版本漂移用例自动跳过");
	}
}

console.log("\n== T13: Windows 沙箱 schannel TLS 探测（#1789；非 Windows 自动跳过）==");
{
	if (process.platform === "win32") {
		// doctor 需要 profiles 目录存在才会跑到 TLS 检查，先建一个空 profile
		const th = makeHome();
		writeProfile(th, "tls-probe", {});
		// 完整令牌 + 网络可达 → 应报告握手成功或至少不误报 #1789
		const { out } = runWith(doctor, [], { DSH_HOME: th });
		const tlsLines = out.split("\n").filter((l) => l.includes("沙箱 TLS"));
		assert(tlsLines.length > 0, "输出包含沙箱 TLS 探测行", tlsLines.join(" | ") || "");
		// 不应在完整令牌下误报 #1789 命中（除非本机确实网络不可达——那是环境问题非本测试断言）
		const hit = tlsLines.find((l) => l.includes("命中 #1789"));
		assert(!hit || out.includes("受限令牌"), "完整令牌下不误报 #1789（除非受限令牌环境）",
			tlsLines.join(" | ") || "");
		rmSync(th, { recursive: true, force: true });
	} else {
		console.log("  · 非 Windows，T13 自动跳过（schannel 仅存在于 Windows）");
	}
}

console.log("\n== T14: 会话日志 seq 完整性（#1497/#1469 seq gap / 重复 / 倒退）==");
{
	const sh = makeHome();
	const cdir = mkdirSync(join(sh, "sessions"), { recursive: true });
	const ev = (seq, type) => JSON.stringify({ type, seq, time: 1, data: { turn: 1 } });
	// 坏：(a) seq 空洞（1 缺失） (b) seq 重复 (c) seq 倒退
	const badLog = join(cdir, "bad-seq.jsonl");
	writeFileSync(badLog, [
		ev(0, "a"), ev(1, "b"), ev(3, "c"), // gap: 2 缺失
		ev(3, "d"),                        // 重复 3
		ev(2, "e"),                        // 倒退到 2
	].join("\n") + "\n");
	const { out } = runWith(doctor, ["--session", badLog]);
	assert(out.includes("seq 空洞"), "报出 seq 空洞（#1469/#1497）", out.split("\n").filter((l) => l.includes("seq")).join(" | "));
	assert(out.includes("seq 重复"), "报出 seq 重复（#1497/#1287）", out.split("\n").filter((l) => l.includes("seq")).join(" | "));
	assert(out.includes("seq 倒退"), "报出 seq 倒退（#1433/#1452）", out.split("\n").filter((l) => l.includes("seq")).join(" | "));

	// 好：连续 seq → 无问题
	const goodLog = join(cdir, "good-seq.jsonl");
	writeFileSync(goodLog, [ev(0, "a"), ev(1, "b"), ev(2, "c"), ev(3, "d")].join("\n") + "\n");
	const { out: out2 } = runWith(doctor, ["--session", goodLog]);
	assert(out2.includes("会话 seq 连续"), "连续 seq 全绿无不误报", out2.split("\n").filter((l) => l.includes("seq")).join(" | ") || "");
	rmSync(sh, { recursive: true, force: true });
}

console.log("\n== T15: skill frontmatter 冒号陷阱（#1401/#936）==");
{
	const sh = makeHome();
	writeProfile(sh, "skill-probe", {}); // doctor 需要 profiles 存在才会跑到全局检查
	// preset skills 目录：~/.dsh/.agent-presets/<id>/skills/<name>/SKILL.md
	const badSkill = join(sh, ".agent-presets", "demo", "skills", "foo", "SKILL.md");
	mkdirSync(dirname(badSkill), { recursive: true });
	writeFileSync(badSkill, "---\nname: foo\ndescription: Use when user asks. Priority order: check curated list first.\n---\n");
	const goodSkill = join(sh, ".agent-presets", "demo", "skills", "bar", "SKILL.md");
	mkdirSync(dirname(goodSkill), { recursive: true });
	writeFileSync(goodSkill, '---\nname: bar\ndescription: "Quoted: safe here."\n---\n');
	const { out } = runWith(doctor, [], { DSH_HOME: sh });
	assert(out.includes("skill frontmatter 冒号未加引号"), "报出未加引号的冒号 description", out.split("\n").filter((l) => l.includes("frontmatter")).join(" | "));
	assert(out.includes("foo") && out.includes("Priority order"), "指明具体 skill 与问题文本", out.split("\n").filter((l) => l.includes("foo")).join(" | "));
	// 好 skill 不应被误报（bar 用引号包裹）
	assert(!out.includes("bar"), "已加引号的不误报", out.split("\n").filter((l) => l.includes("bar")).join(" | ") || "bar not flagged ✓");
	rmSync(sh, { recursive: true, force: true });
}

console.log("\n== T16: Windows 端口排除段（#1462；非 Windows 自动跳过）==");
{
	if (process.platform === "win32") {
		const th = makeHome();
		writeProfile(th, "port-probe", {});
		const { out } = runWith(doctor, [], { DSH_HOME: th });
		const lines = out.split("\n").filter((l) => l.includes("端口"));
		assert(lines.length > 0, "输出包含端口排除段检查行", lines.join(" | ") || "");
		assert(lines.some((l) => l.includes("不在 Windows 排除段内") || l.includes("在 Windows 排除段") || l.includes("netsh 无输出") || l.includes("netsh 不可用")),
			"端口检查有确定结论（不静默跳过）", lines.join(" | ") || "");
		rmSync(th, { recursive: true, force: true });
	} else {
		console.log("  · 非 Windows，T16 自动跳过");
	}
}

console.log("\n== T17: 锚点基线防漂移（版本漂移自动核对；本机一致不误报）==");
{
	// 构造假 dsh 安装树：<home>/lib/node_modules/@deepseek-ai/dsh + 子包，bin 放 <home>/bin
	// 通过 PATH 注入让 findDshInstall 命中假安装（doctor 从 PATH 解析）。
	const fakeDsh = (ver, anchorTokens) => {
		const h = makeHome();
		const dshRoot = join(h, "lib", "node_modules", "@deepseek-ai", "dsh");
		const scoped = join(dshRoot, "node_modules", "@deepseek-ai");
		mkdirSync(scoped, { recursive: true });
		writeFileSync(join(dshRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: ver }, null, 2) + "\n");
		for (const [pkg, src] of Object.entries(anchorTokens)) {
			const dir = join(scoped, pkg);
			mkdirSync(join(dir, "lib"), { recursive: true });
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@deepseek-ai/${pkg}`, version: ver, main: "lib/index.js" }, null, 2) + "\n");
			writeFileSync(join(dir, "lib", "index.js"), src);
			writeFileSync(join(dir, "src", "index.ts"), src);
		}
		const binDir = join(h, "bin");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(binDir, "dsh"), "#!/usr/bin/env node\n"); execSync(`chmod +x ${JSON.stringify(join(binDir, "dsh"))}`);
		writeProfile(h, "probe", {});
		return { h, binDir };
	};
	const runWithPath = (h, binDir) => {
		const sep = process.platform === "win32" ? ";" : ":";
		return runWith(doctor, [], { DSH_HOME: h, PATH: binDir + sep + process.env.PATH });
	};

	// (a) 版本漂移（rc.7）+ 锚点缺失 → 自动核对报脱节，且列受影响检查
	{
		const { h, binDir } = fakeDsh("0.1.0-rc.7", {
			"dsh-session": "// new build, old tokens removed\n",
			"dsh-tools": "// new build\n",
			"dsh-app-boot": "// new build\n",
		});
		const { out } = runWithPath(h, binDir);
		assert(out.includes("≠ 基线 v0.1.0-rc.6"), "版本漂移 → 自动核对触发", out.split("\n").filter((l) => l.includes("锚点基线")).join(" | "));
		assert(out.includes("5/5 锚点缺失") && out.includes("与当前 dsh 脱节"), "锚点全缺 → 宣告检测脱节", out.split("\n").filter((l) => l.includes("锚点")).join(" | "));
		assert(out.includes("依赖它的检查"), "列出受影响检查", out.split("\n").filter((l) => l.includes("依赖它的检查")).join(" | ") || "");
		rmSync(h, { recursive: true, force: true });
	}

	// (b) 版本漂移（rc.7）但锚点全在 → 提示仍有效，不误杀
	{
		const { h, binDir } = fakeDsh("0.1.0-rc.7", {
			"dsh-session": `"tool/call"\n"tool/result"\n`,
			"dsh-tools": "readonly callId: CallId\n",
			"dsh-app-boot": "[installAnchor, join(profileDir, 'package.json')]\ndsh?.bundle?.patch\n",
		});
		const { out } = runWithPath(h, binDir);
		assert(out.includes("版本漂移但 5 个锚点全部仍在"), "锚点全在 → 检测仍有效", out.split("\n").filter((l) => l.includes("锚点基线")).join(" | ") || "");
		rmSync(h, { recursive: true, force: true });
	}

	// (c) 本机 == 基线（用真实安装，或假安装 rc.6 + 锚点全在）→ 不报漂移
	{
		const { h, binDir } = fakeDsh("0.1.0-rc.6", {
			"dsh-session": `"tool/call"\n"tool/result"\n`,
			"dsh-tools": "readonly callId: CallId\n",
			"dsh-app-boot": "[installAnchor, join(profileDir, 'package.json')]\ndsh?.bundle?.patch\n",
		});
		const { out } = runWithPath(h, binDir);
		assert(out.includes("本机 dsh v0.1.0-rc.6 == 基线"), "版本一致 → 锚点可信", out.split("\n").filter((l) => l.includes("锚点基线")).join(" | ") || "");
		rmSync(h, { recursive: true, force: true });
	}
}

console.log("\n== T18: --check-update（在线对比 npm registry；网络不可用自动降级）==");
{
	const th = makeHome();
	writeProfile(th, "cu-probe", {});
	const { out, code } = runWith(doctor, ["--check-update"], { DSH_HOME: th });
	// 网络可用 → 输出本机/官方对比；不可用 → 降级提示。两者都不应崩溃。
	assert(
		out.includes("对比 @deepseek-ai/dsh") && (out.includes("官方最新") || out.includes("无法访问 npm registry")),
		"--check-update 输出对比或降级提示", out.split("\n").filter((l) => l.includes("对比") || l.includes("官方") || l.includes("registry")).join(" | ") || "");
	assert(code === 0, "--check-update 干净退出（code 0）", `code=${code}`);
	rmSync(th, { recursive: true, force: true });
}

console.log("\n== T19: --fix 防漂移闸门（锚点脱节 → fail-closed 中止；--force 强制）==");
{
	// 复用假 dsh 安装布局：<home>/lib/node_modules/@deepseek-ai/dsh + bin，TUI 坏文件作可修复项
	const fixSetup = (ver, withAnchors) => {
		const h = makeHome();
		const dshRoot = join(h, "lib", "node_modules", "@deepseek-ai", "dsh");
		const scoped = join(dshRoot, "node_modules", "@deepseek-ai");
		mkdirSync(scoped, { recursive: true });
		writeFileSync(join(dshRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: ver }, null, 2) + "\n");
		const src = withAnchors
			? { "dsh-session": `"tool/call"\n"tool/result"\n`, "dsh-tools": "readonly callId: CallId\n", "dsh-app-boot": "[installAnchor, join(profileDir, 'package.json')]\ndsh?.bundle?.patch\n" }
			: { "dsh-session": "// new\n", "dsh-tools": "// new\n", "dsh-app-boot": "// new\n" };
		for (const [pkg, s] of Object.entries(src)) {
			const dir = join(scoped, pkg);
			mkdirSync(join(dir, "lib"), { recursive: true });
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@deepseek-ai/${pkg}`, version: ver, main: "lib/index.js" }, null, 2) + "\n");
			writeFileSync(join(dir, "lib", "index.js"), s);
			writeFileSync(join(dir, "src", "index.ts"), s);
		}
		const binDir = join(h, "bin");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(binDir, "dsh"), "#!/usr/bin/env node\n"); execSync(`chmod +x ${JSON.stringify(join(binDir, "dsh"))}`);
		const tuiFile = join(h, "profiles", "tui", "node_modules", "@earendil-works", "pi-tui", "dist", "tui-main-screen.js");
		mkdirSync(dirname(tuiFile), { recursive: true });
		writeFileSync(tuiFile,
			'import { visibleWidth } from "./utils.js";\n' +
			'function render() {\n  if (!isImage && visibleWidth(line) > width) {\n    throw new Error(errorMsg);\n  }\n}\n');
		writeProfile(h, "web", {});
		return { h, binDir, tuiFile };
	};
	const runFix = (h, binDir, args) => {
		const sep = process.platform === "win32" ? ";" : ":";
		try {
			return execFileSync(process.execPath, [doctor, ...args], {
				env: { ...process.env, DSH_HOME: h, PATH: binDir + sep + process.env.PATH },
				encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			// doctor 发现 ✗ 时以非零码退出（脱节场景正是如此）——输出才是断言对象
			return String(e.stdout ?? "") + String(e.stderr ?? "");
		}
	};

	// (a) 正常基线 + --fix → 照常执行补丁
	{
		const { h, binDir, tuiFile } = fixSetup("0.1.0-rc.6", true);
		const out = runFix(h, binDir, ["--fix"]);
		assert(!out.includes("--fix 中止") && out.includes("补丁已重打"), "正常基线：--fix 照常执行",
			out.split("\n").filter((l) => l.includes("--fix") || l.includes("补丁")).join(" | "));
		assert(readFileSync(tuiFile, "utf-8").includes("truncateToWidth(line, width)"), "正常基线：补丁确实写入文件");
		rmSync(h, { recursive: true, force: true });
	}

	// (b) 锚点脱节 + --fix → fail-closed 中止，不写文件
	{
		const { h, binDir, tuiFile } = fixSetup("0.1.0-rc.7", false);
		const out = runFix(h, binDir, ["--fix"]);
		assert(out.includes("--fix 中止") && out.includes("fail-closed"), "脱节：--fix 中止（fail-closed）",
			out.split("\n").filter((l) => l.includes("中止")).join(" | "));
		assert(!readFileSync(tuiFile, "utf-8").includes("truncateToWidth"), "脱节中止：未写任何文件");
		assert(out.includes("自动修复：已中止"), "脱节中止：总结行体现", out.split("\n").filter((l) => l.includes("自动修复")).join(" | ") || "");
		rmSync(h, { recursive: true, force: true });
	}

	// (c) 锚点脱节 + --fix --force → 用户显式授权，强制执行
	{
		const { h, binDir, tuiFile } = fixSetup("0.1.0-rc.7", false);
		const out = runFix(h, binDir, ["--fix", "--force"]);
		assert(!out.includes("--fix 中止") && out.includes("用户已显式授权"), "脱节+--force：不中止且标注强制",
			out.split("\n").filter((l) => l.includes("--fix") || l.includes("授权")).join(" | "));
		assert(out.includes("补丁已重打") && readFileSync(tuiFile, "utf-8").includes("truncateToWidth(line, width)"), "脱节+--force：补丁执行并写入");
		rmSync(h, { recursive: true, force: true });
	}
}

// 清理临时 home
rmSync(home, { recursive: true, force: true });

console.log(`\n========== 破坏性测试: ${passed} ✓ / ${failed} ✗ ==========`);
process.exit(failed > 0 ? 1 : 0);
