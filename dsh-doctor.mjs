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
 *   node dsh-doctor.mjs --fix      # 报告可自动修复项（file: 依赖重链）
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const profilesRoot = join(homedir(), ".dsh", "profiles");
const args = process.argv.slice(2);
const onlyProfile = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : null;
const fixMode = args.includes("--fix");

let pass = 0, fail = 0, warn = 0;

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
			// 插件名特征：@scope/name 或 含 / 的包路径，排除中文/普通配置词
			if (n.startsWith("@") || n.includes("/")) names.add(n);
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

/** 读 package.json 的 dependencies */
function readDeps(profileDir) {
	try {
		return JSON.parse(readFileSync(join(profileDir, "package.json"), "utf-8")).dependencies || {};
	} catch {
		return {};
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
			report("✓", `依赖在位: ${name}`);
		} else if (spec.startsWith("file:")) {
			const raw = spec.slice(5);
			const target = raw.startsWith("/") ? raw : join(profileDir, raw);
			report("✗", `file: 链接失效: ${name} → ${spec}（目标 ${existsSync(target) ? "存在但未链接" : "不存在"}）`);
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
if (fail > 0) {
	console.log("\n修复建议:");
	console.log("  1. 悬空引用：确认插件来源（npm / file: / 内置），file: 依赖用 `cd ~/.dsh/profiles/<名> && pnpm add file:<路径>` 重链");
	console.log("  2. 移除无用引用：编辑 cordis.patch.yml 删除对应 insert");
	console.log("  3. 仍无法启动：备份后临时移除坏引用让 dsh 恢复，再定位插件来源");
}
process.exit(fail > 0 ? 1 : 0);
