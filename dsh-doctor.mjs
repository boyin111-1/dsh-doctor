#!/usr/bin/env node
/**
 * dsh-doctor — DeepSeek Harness 配置健康检查（独立 CLI，零依赖）
 *
 * 为什么不是 dsh 插件：诊断必须在"插件树加载失败→启动崩溃"之前/之外能跑，
 * 插件形态会陷入鸡生蛋问题。独立 CLI 在 dsh 启动前可随时运行。
 *
 * 核心校验逻辑对齐 loader 的真实解析行为：
 *   loader 用 profile 目录作为解析锚点（cordis-plugin-loader/lib/index.js:264
 *   internal.import(name, this.ctx.baseUrl)）→ 我们用 createRequire(profile 目录)
 *   做同样的裸包名解析，保证诊断结论与真实启动一致。
 *
 * 用法:
 *   node dsh-doctor.mjs            # 检查全部 profile
 *   node dsh-doctor.mjs --profile web   # 只查 web
 *   node dsh-doctor.mjs --fix      # 自动重链 file: 依赖（target 存在但未链接）
 *   DSH_HOME=/path dsh-doctor.mjs  # 指定 Harness home（默认 ~/.dsh）
 *   node dsh-doctor.mjs 检查项 ≥9 类：悬空引用 / file:链接 / 重复id /
 *      入口产物 / 双实例 / bundles完整性 / bundle-id碰撞 / bundle冗余insert
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const dshHome = (process.env.DSH_HOME && process.env.DSH_HOME.trim())
	? process.env.DSH_HOME.trim()
	: join(homedir(), ".dsh");
const profilesRoot = join(dshHome, "profiles");
const args = process.argv.slice(2);
const onlyProfile = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : null;
const fixMode = args.includes("--fix");

let pass = 0, fail = 0, warn = 0;
const fixableFileLinks = []; // { profileDir, name, target }
const fixed = [];

function report(icon, msg) {
	console.log(`  ${icon} ${msg}`);
	if (icon === "✗") fail++;
	else if (icon === "⚠") warn++;
	else pass++;
}

/** 提取 YAML 里的插件引用（name: 'xxx' 形式，过滤配置字段） */
function extractPluginNames(ymlPath) {
	try {
		const src = readFileSync(ymlPath, "utf-8");
		const names = new Set();
		for (const m of src.matchAll(/name:\s*['"]([^'"]+)['"]/g)) {
			const n = m[1];
			// 插件名特征：@scope/name、含 / 的包路径，或裸 npm 包名
			// （dsh-find-plugin、ok-plugin 等）。裸名须形如合法小写 npm 包名，
			// 避免把 persona/root/mode 等单配置键误收。
			const barePkg = /^[a-z0-9][a-z0-9._-]{2,}$/.test(n);
			if (n.startsWith("@") || n.includes("/") || barePkg) names.add(n);
		}
		return [...names];
	} catch {
		return [];
	}
}

/** 提取 YAML 里所有 entry id（duplicate id 检测，覆盖 #1404/#1479） */
function extractEntryIds(ymlPath) {
	try {
		const src = readFileSync(ymlPath, "utf-8");
		const ids = [];
		for (const m of src.matchAll(/\bid:\s*['"]?([a-zA-Z0-9@/_.-]+)['"]?\s*$/gm)) {
			const id = m[1];
			// 跳过明显非 entry id 的值（中文/长文本/路径）
			if (/^[a-zA-Z0-9@/_.-]{1,60}$/.test(id) && !id.includes(".")) ids.push({ id, yml: ymlPath.split("/").pop() });
		}
		return ids;
	} catch {
		return [];
	}
}

/** 检测重复 entry id（覆盖 #1404 duplicate id / #1479 双插件同 id） */
function checkDuplicateIds(profileDir) {
	const ymls = readdirSync(profileDir).filter((f) => f.endsWith(".yml"));
	const seen = new Map();
	const dupes = [];
	for (const f of ymls) {
		for (const { id, yml } of extractEntryIds(join(profileDir, f))) {
			if (seen.has(id)) {
				dupes.push({ id, first: seen.get(id), second: yml });
			} else {
				seen.set(id, yml);
			}
		}
	}
	for (const { id, first, second } of dupes) {
		report("✗", `重复 entry id: "${id}" 出现在 ${first} 和 ${second}（会导致 duplicate loader entry id 崩溃）`);
	}
}

/** 检测双模块实例（覆盖 #1486：pnpm hoisting 导致两个 @deepseek-ai 实例） */
function checkDualInstances(profileDir) {
	const profileScoped = join(profileDir, "node_modules", "@deepseek-ai");
	if (!existsSync(profileScoped)) return;
	// dsh 安装目录（~/.nvm 下全局安装的 @deepseek-ai/dsh）
	let installScoped = null;
	try {
		const out = execSync("ls -d $HOME/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai 2>/dev/null | head -1", { encoding: "utf-8" }).trim();
		if (out) installScoped = out;
	} catch { /* ignore */ }
	if (!installScoped) return; // 找不到 dsh 安装目录，跳过双实例检查

	const profilePkgs = existsSync(profileScoped) ? readdirSync(profileScoped) : [];
	const installPkgs = existsSync(installScoped) ? readdirSync(installScoped) : [];
	for (const pkg of profilePkgs) {
		if (!installPkgs.includes(pkg)) continue;
		// 两个位置都有同名 @deepseek-ai 包 → 可能双实例（hoisting 提升的副本）
		const readVer = (dir) => {
			try {
				return JSON.parse(readFileSync(join(dir, pkg, "package.json"), "utf-8")).version;
			} catch { return "?"; }
		};
		const profileVer = readVer(profileScoped);
		const installVer = readVer(installScoped);
		if (profileVer !== installVer) {
			report("⚠", `可能双模块实例: @deepseek-ai/${pkg}（profile: v${profileVer} vs dsh 安装: v${installVer}）`);
		}
	}
}

/**
 * 定位 dsh 安装锚点（@deepseek-ai/dsh 的 package.json）。
 * 与 checkDualInstances 共用 ~/.nvm 全局安装布局；找不到则返回 null，
 * 相关检测自动降级为"跳过"而不是误报。
 */
function findInstallAnchor() {
	const dirs = [
		"$HOME/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh/package.json",
		"$HOME/.local/share/pnpm/global/5/node_modules/@deepseek-ai/dsh/package.json",
	];
	for (const glob of dirs) {
		try {
			const out = execSync(`ls ${glob} 2>/dev/null | head -1`, { encoding: "utf-8" }).trim();
			if (out) return out;
		} catch { /* keep looking */ }
	}
	return null;
}

/** 从 anchor（package.json 路径）解析包目录，镜像 profile.ts packageDirFromAnchor。 */
function packageDirFromAnchor(anchor, packageName) {
	try {
		for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
			const candidate = join(searchPath, ...packageName.split("/"));
			if (existsSync(join(candidate, "package.json"))) return candidate;
		}
	} catch { /* unresolved */ }
	return null;
}

/**
 * 双锚点解析 bundle 目录（安装锚点优先，profile 目录其次）——与
 * profile.ts `resolveBundleDir`（packages/boot/app-boot/src/profile.ts）一致。
 * 安装优先是契约：in-box bundle（@deepseek-ai/dsh-base 等）必须来自同一安装。
 */
function resolveBundleDir(bundleName, installAnchor, profileDir) {
	for (const anchor of [installAnchor, join(profileDir, "package.json")]) {
		if (!anchor) continue;
		const dir = packageDirFromAnchor(anchor, bundleName);
		if (dir) return dir;
	}
	return null;
}

/**
 * 从 patch 文件（bundle 或用户 cordis.patch.yml）提取 insert 列表的 entry id。
 * 只认可 `- insert:` 段下的 `- id: xxx` 行，避免把 `cordis.yml` 根数组或
 * 配置字段当成 entry id。
 */
function extractInsertIds(ymlPath) {
	try {
		const src = readFileSync(ymlPath, "utf-8");
		const ids = [];
		// 逐行扫描，处于 insert 段内才收集 id
		let inInsert = false;
		for (const line of src.split("\n")) {
			const t = line.trim();
			if (/^-?\s*insert:/.test(t) || /^insert:/.test(t)) { inInsert = true; continue; }
			if (inInsert && /^[a-zA-Z]/ && !/^\s*-\s+.+/.test(line)) { /* section close */ }
			if (inInsert) {
				const m = t.match(/^-?\s*id:\s*['"]?([a-zA-Z0-9@/_.-]+)['"]?\s*$/);
				if (m) ids.push(m[1]);
			}
		}
		return ids;
	} catch {
		return [];
	}
}

/** 检测 dsh.profile.bundles 完整性（#917/#880/#1197 族；advisory 分辨率锚点）。 */
function checkBundles(profileDir, installAnchor) {
	let manifest = {};
	try {
		manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf-8"));
	} catch {
		return;
	}
	const bundles = manifest.dsh?.profile?.bundles ?? [];
	if (bundles.length === 0) return;
	const profileName = profileDir.split("/").pop();
	for (const bundle of bundles) {
		const dir = resolveBundleDir(bundle, installAnchor, profileDir);
		if (!dir) {
			report("✗", `dsh.profile.bundles 悬空: "${bundle}"（从 dsh 安装和 ${profileName} 目录都无法解析——正是 #917 的永久不可启动残留）`);
			continue;
		}
		let bm = {};
		try { bm = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")); } catch { /* ignore */ }
		const declared = bm.dsh?.bundle?.patch;
		if (declared === undefined) {
			report("✗", `bundle 无 dsh.bundle: "${bundle}"（package.json 未声明 dsh.bundle.patch，loader 启动即失败）`);
			continue;
		}
		const patchPath = join(dir, declared);
		if (!existsSync(patchPath)) {
			report("⚠", `bundle patch 缺失: "${bundle}" 声明 ${declared} 但文件不存在`);
			continue;
		}
		report("✓", `bundle 在位: ${bundle}`);
	}
}

/**
 * 检测 bundle 与用户 patch 的 entry id 碰撞（advisory item (a)；#1404/#1479）。
 * 场景 1：用户 cordis.patch.yml 的 insert id 与某个 bundle 的 patch id 相同
 *          → duplicate loader entry id 崩溃（#1479 正是同 id 双插件）。
 * 场景 2：某个 bundle 出现在 dsh.profile.bundles，同时又在用户 patch 里以
 *          同名 entry insert → reconcile 提升后未清理冗余 insert（#1404）。
 */
function checkBundleIdCollision(profileDir, installAnchor) {
	let manifest = {};
	try {
		manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf-8"));
	} catch { return; }
	const bundles = manifest.dsh?.profile?.bundles ?? [];
	// 收集每个可解析 bundle 的 patch entry id
	const bundleIds = new Map(); // id -> bundle name
	for (const bundle of bundles) {
		const dir = resolveBundleDir(bundle, installAnchor, profileDir);
		if (!dir) continue;
		let bm = {};
		try { bm = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")); } catch { continue; }
		const declared = bm.dsh?.bundle?.patch;
		if (!declared) continue;
		for (const id of extractInsertIds(join(dir, declared))) {
			if (!bundleIds.has(id)) bundleIds.set(id, bundle);
		}
	}
	if (bundleIds.size === 0) return;

	// 用户 patch 的 insert id
	const patchPath = join(profileDir, "cordis.patch.yml");
	if (!existsSync(patchPath)) return;
	const userIds = extractInsertIds(patchPath);

	// 场景 1：用户 insert id 与 bundle id 冲突
	for (const id of userIds) {
		if (bundleIds.has(id)) {
			report("✗", `entry id 冲突: 用户 patch 插入 "${id}" = ${bundleIds.get(id)} 的 bundle entry id（duplicate loader entry id 崩溃，#1404/#1479）`);
		}
	}
	// 场景 2：bundle 同时在 bundles 与用户 patch 中以同名 insert 出现（冗余提升）
	const userNames = new Set();
	try {
		const src = readFileSync(patchPath, "utf-8");
		for (const m of src.matchAll(/name:\s*['"]([^'"]+)['"]/g)) userNames.add(m[1]);
	} catch { /* ignore */ }
	for (const bundle of bundles) {
		if (userNames.has(bundle)) {
			report("⚠", `bundle 冗余 insert: "${bundle}" 已在 dsh.profile.bundles，又在 cordis.patch.yml 里 insert（#1404 reconcile 未清理的冗余；确认后删除 patch insert）`);
		}
	}
}

/** 读 package.json 的 dependencies */
function readDeps(profileDir) {
	try {
		return JSON.parse(readFileSync(join(profileDir, "package.json"), "utf-8")).dependencies || {};
	} catch {
		return {};
	}
}

/** 读依赖入口文件（exports["."] → main → index.js） */
function entryFile(pkgDir) {
	try {
		const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
		// exports["."] 优先（可以是字符串或条件对象）
		const dot = pkg.exports && pkg.exports["."];
		if (typeof dot === "string") return join(pkgDir, dot);
		if (dot && typeof dot === "object") {
			const cond = dot.import ?? dot.default ?? dot.require;
			if (typeof cond === "string") return join(pkgDir, cond);
		}
		if (pkg.main) return join(pkgDir, pkg.main);
		return join(pkgDir, "index.js");
	} catch {
		return null;
	}
}
/** 检查 pnpm-lock.yaml 里的 file: 依赖是否存在 */
function checkFileLinks(profileDir, pkgName) {
	const lockPath = join(profileDir, "pnpm-lock.yaml");
	if (!existsSync(lockPath)) return null;
	try {
		const lock = readFileSync(lockPath, "utf-8");
		// 找 importers 段的 file: 引用
		const re = new RegExp(`(${pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}):\\s*$[^\\n]*file:([^\\n]+)`, "m");
		const m = lock.match(re);
		return m ? m[2].trim() : null;
	} catch {
		return null;
	}
}

/** 检查一个 profile */
function checkProfile(dir) {
	const profileName = dir.split("/").pop();
	console.log(`\n📦 profile: ${profileName}`);
	const profileDir = dir;

	// 1. 解析锚点 = profile 目录（与 loader 一致）
	const requireFromProfile = createRequire(join(profileDir, "package.json"));

	// 2. 收集所有 yml 里的插件引用
	const ymls = readdirSync(profileDir).filter((f) => f.endsWith(".yml"));
	const referenced = new Set();
	for (const f of ymls) for (const n of extractPluginNames(join(profileDir, f))) referenced.add(n);

	// 3. 逐个解析（真实锚点测试）
	if (referenced.size === 0) report("⚠", "没有找到插件引用（yml 里无 @scope/包名 形式的 name）");
	for (const name of referenced) {
		try {
			requireFromProfile.resolve(name);
			report("✓", `插件可解析: ${name}`);
		} catch (e) {
			report("✗", `悬空引用: ${name}  (从 ${profileName} 解析失败: ${e.code || e.message.slice(0, 60)})`);
		}
	}

	// 4. dependencies 真实性检查（file: 链接失效检测）
	const deps = readDeps(profileDir);
	for (const [name, spec] of Object.entries(deps)) {
		const resolved = join(profileDir, "node_modules", ...name.split("/"));
		if (existsSync(resolved)) {
			// 入口产物完整性检查（#917/ICCuse：包在但 lib/index.js 缺失也会 boot 崩溃）
			const mainFile = entryFile(resolved);
			if (mainFile && !existsSync(mainFile)) {
				report("✗", `入口产物缺失: ${name} → ${mainFile.slice(-60)}（包在但入口文件不在，boot 会崩溃）`);
			} else {
				report("✓", `依赖在位: ${name}`);
			}
		} else if (spec.startsWith("file:")) {
			const raw = spec.slice(5);
			const target = raw.startsWith("/") ? raw : join(profileDir, raw);
			const targetExists = existsSync(target);
			report("✗", `file: 链接失效: ${name} → ${spec}（目标 ${targetExists ? "存在但未链接" : "不存在"}）`);
			if (fixMode && targetExists) fixableFileLinks.push({ profileDir, name, target });
		} else {
			report("⚠", `依赖缺失: ${name}（spec: ${spec}，node_modules 无此包）`);
		}
	}

	// 5. pnpm-lock.yaml 的 file: 引用核对
	for (const name of Object.keys(deps)) {
		if (!deps[name].startsWith("file:")) continue;
		const lockFile = checkFileLinks(profileDir, name);
		if (lockFile) {
			const absTarget = join(profileDir, lockFile.replace(/^\.\.\/\.\.\/\.\.\/\.\.\//, ""));
			// 简化：报告 lock 里的 file: 目标
			const targetPath = lockFile.includes("..") ? join(profileDir, lockFile) : lockFile;
			report("✓", `lock 记录 file: 引用: ${name} → ${lockFile.slice(-60)}`);
		}
	}

	// 6. 重复 entry id 检测（覆盖 #1404/#1479）
	checkDuplicateIds(profileDir);

	// 7. 双模块实例检测（覆盖 #1486）
	checkDualInstances(profileDir);

	// 8. dsh.profile.bundles 完整性检测（覆盖 #917 悬空 bundle 残留）
	const installAnchor = findInstallAnchor();
	checkBundles(profileDir, installAnchor);

	// 9. bundle 与用户 patch id 碰撞检测（advisory item (a)；#1404/#1479）
	checkBundleIdCollision(profileDir, installAnchor);
}

// ---- main ----
console.log(`🔍 dsh-doctor — 检查 ${profilesRoot}`);
if (!existsSync(profilesRoot)) {
	console.log("✗ 未找到 .dsh/profiles 目录");
	process.exit(1);
}

const profiles = readdirSync(profilesRoot)
	.filter((p) => existsSync(join(profilesRoot, p, "package.json")))
	.filter((p) => !onlyProfile || p === onlyProfile);

for (const p of profiles) checkProfile(join(profilesRoot, p));

console.log(`\n========== 结果: ${pass} ✓ / ${warn} ⚠ / ${fail} ✗ ==========`);

// ---- --fix 执行 ----
if (fixMode) {
	console.log("\n🔧 --fix 模式下执行的可自动修复项：");
	if (fixableFileLinks.length === 0) {
		console.log("  · 无 file: 链接失效（target 存在但未链接）需要重链。");
	} else {
		for (const { profileDir, name, target } of fixableFileLinks) {
			console.log(`  · 重链 ${name} → ${target}`);
			try {
				execSync(`pnpm add file:${JSON.stringify(target)}`, {
					cwd: profileDir,
					stdio: "inherit",
					env: { ...process.env, npm_config_yes: "true" },
				});
				fixed.push(name);
				console.log(`    ✓ 重链成功: ${name}`);
			} catch {
				console.log(`    ✗ 重链失败（pnpm 非零退出），无改自动配置；可手动 cd ${profileDir} && pnpm add file:${target}`);
			}
		}
	}
}

if (fail > 0) {
	console.log("\n修复建议:");
	console.log("  1. 悬空引用/悬空 bundle：确认插件来源，file: 依赖用 `dsh-doctor --fix` 或");
	console.log("     `cd ~/.dsh/profiles/<名> && pnpm add file:<路径>` 重链；纯 npm 依赖 `pnpm add <名>`");
	console.log("  2. 移除无用/bundle 冗余引用：先备份再删——`cp cordis.patch.yml cordis.patch.yml.bak`，");
	console.log("     然后编辑删除对应 insert；或从 package.json dsh.profile.bundles 删除残留");
	console.log("  3. 入口产物缺失：重装该包或重新构建（不需要改 manifest）");
	console.log("  4. 仍无法启动：备份后停止用坏 profile，用 `--profile <其他>` 启动再定位");
}

console.log(`\n${fixMode ? "自动修复：" + (fixed.length ? `${fixed.join(", ")} 已重链 ✓` : "本次无需重链（或全部失败）") : "用 --fix 自动重链 file: 依赖"}`);
process.exit(fail > 0 ? 1 : 0);
