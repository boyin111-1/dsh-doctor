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
	const profileLines = out.split("\n").filter((l) => l.trim().startsWith("✓") || l.trim().startsWith("✗") || l.trim().startsWith("⚠"));
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
			// 通过 dsh 的 realpath bin 定位安装根（.../@deepseek-ai/dsh）
			let installRoot = null;
			{
				const bin = execSync(dshProbe, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim().split(/\r?\n/)[0];
				let real = bin; try { real = realpathSync(bin); } catch {}
				let d = dirname(real);
				while (dirname(d) !== d) {
					if (basename(d) === "dsh" && basename(dirname(d)) === "@deepseek-ai") { installRoot = d; break; }
					const cand = join(d, "lib", "node_modules", "@deepseek-ai", "dsh");
					if (existsSync(join(cand, "package.json"))) { installRoot = cand; break; }
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
				const hB = makeHome();
				const pB = writeProfile(hB, "dup-inst-b", {});
				mkdirSync(join(pB, "node_modules", "@deepseek-ai"), { recursive: true });
				symlinkSync(join(installScoped, pkg), join(pB, "node_modules", "@deepseek-ai", pkg), "dir");
				const { out: outB } = run(hB);
				assert(!outB.includes("双模块实例"), "symlink 指向安装同一份→不误报",
					outB.split("\n").filter((l) => l.includes("双模块")).join(" | ") || "");
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

// 清理临时 home
rmSync(home, { recursive: true, force: true });

console.log(`\n========== 破坏性测试: ${passed} ✓ / ${failed} ✗ ==========`);
process.exit(failed > 0 ? 1 : 0);
