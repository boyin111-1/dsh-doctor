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
 *   node dsh-doctor.mjs --session <log>     # 扫会话日志里的悬空 tool_call（#1544/#1363）
 *   node dsh-doctor.mjs --verify-anchors <dshRepo>  # 核对检测锚点是否仍与官方源码一致
 *   node dsh-doctor.mjs --check-update      # 在线对比 npm registry 与本机 dsh 版本
 *   DSH_HOME=/path dsh-doctor.mjs  # 指定 Harness home（默认 ~/.dsh）
 *   node dsh-doctor.mjs 检查项 ≥18 类：悬空引用 / file:链接 / 重复id /
 *      入口产物 / 双实例 / bundles完整性 / bundle-id碰撞 / bundle冗余insert /
 *      会话孤儿tool_call / TUI超宽行崩溃补丁 / toolkit-plugins持久化插件源码 /
 *      版本漂移(#1515) / 沙箱schannel TLS(#1789) / 会话seq完整性(#1497族) /
 *      skill frontmatter冒号(#1401) / 端口排除段(#1462) / PATH工具(#1270) /
 *      锚点基线(防漂移，自动)
 *
 * 防漂移设计（官方仓库改了 / 本地二进制更新了 / 本地与官方不一致）：
 *   - 每次运行自动 checkAnchorBaseline()：本机 dsh 版本 vs ANCHOR_BASELINE_VERSION，
 *     不一致立即扫描 5 个行为锚点；锚点缺失则明确宣告"检测逻辑已脱节"并列出受影响检查。
 *   - --verify-anchors：手动深度核对（可传官方仓库目录）。
 *   - --check-update：在线对比 npm registry 最新版。
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { get as httpsGet } from "node:https";

// Node 22.18+ 内置 zstd（dsh 要求 node ^22.19 || >=24）；读取与写回都优先用它，
// 缺失时读取降级为 zstd CLI（check 17 探测 PATH），再缺失则 --session 的
// zstd 会话检查/修复不可用并明确提示。
let zstdCompressSync = null, zstdDecompressSync = null, zstdChecksumFlag = 1;
try {
	const z = await import("node:zlib");
	zstdCompressSync = z.zstdCompressSync ?? null;
	zstdDecompressSync = z.zstdDecompressSync ?? null;
	zstdChecksumFlag = z.constants?.ZSTD_c_checksumFlag ?? 1;
} catch { /* 旧 Node：zstd 能力不可用 */ }

const dshHome = (process.env.DSH_HOME && process.env.DSH_HOME.trim())
	? process.env.DSH_HOME.trim()
	: join(homedir(), ".dsh");
const profilesRoot = join(dshHome, "profiles");
const args = process.argv.slice(2);
const onlyProfile = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : null;
const fixMode = args.includes("--fix");
const sessionArg = args.includes("--session") ? args[args.indexOf("--session") + 1] : null;
const verifyAnchorsIdx = args.indexOf("--verify-anchors");
const verifyAnchorsDir = verifyAnchorsIdx !== -1
	? (args[verifyAnchorsIdx + 1] && !args[verifyAnchorsIdx + 1].startsWith("--") ? args[verifyAnchorsIdx + 1] : null)
	: null;
const checkUpdateIdx = args.indexOf("--check-update");

/**
 * 检测锚点的**版本基准**：以下 ANCHORS 是围绕哪个 dsh 版本验证过的。
 *
 * 防漂移契约（对应"官方仓库改了 / 本地二进制更新了 / 本地与官方不一致"三类变化）：
 *   1. 每次常规运行都自动跑 checkAnchorBaseline()：把本机安装的 dsh 版本与
 *      此基线比较。版本一致 → 锚点可信；不一致 → 自动扫描锚点确认是否仍命中，
 *      锚点缺失即说明检测逻辑已与当前 dsh 脱节（此时 #6/#7/#9/#14 等依赖锚点的
 *      检查结论不可信，必须人工核对或更新本工具）。
 *   2. `--verify-anchors` 是深度的手动核对（可用官方仓库目录覆盖）。
 *   3. `--check-update` 在线对比 npm registry，回答"官方/本地谁新"。
 *
 * dsh 升级后应重新跑 `--verify-anchors` 确认锚点仍在；若缺失，本工具需随
 * 官方源码同步更新锚点（或按新 token 修正检查逻辑），而不是继续用旧 token 静默运行。
 */
const ANCHOR_BASELINE_VERSION = "0.1.0-rc.6";
const ANCHORS = [
	{
		name: "tool/call 事件字面量（session 日志配对起点；types.js）",
		tokenCompiled: `"tool/call"`, tokenSource: `'tool/call'`,
		fileCompiled: "*.js", fileSource: "*.ts",
		dependsOn: ["#9 会话孤儿 tool_call", "#14 会话 seq 完整性"],
	},
	{
		name: "tool/result 事件字面量（配对终点；types.js）",
		tokenCompiled: `"tool/result"`, tokenSource: `'tool/result'`,
		fileCompiled: "*.js", fileSource: "*.ts",
		dependsOn: ["#9 会话孤儿 tool_call", "#14 会话 seq 完整性"],
	},
	{
		name: "ToolResultMessage 携带 callId（tools lib）",
		tokenCompiled: `readonly callId`, tokenSource: `readonly callId: CallId`,
		fileCompiled: "*.js", fileSource: "*.ts",
		dependsOn: ["#9 会话孤儿 tool_call（callId 配对键）"],
	},
	{
		name: "bundle 双锚点顺序·安装优先（boot profile 产物）",
		tokenCompiled: `[installAnchor, join(profileDir`, tokenSource: `for (const anchor of [installAnchor`,
		fileCompiled: "*.js", fileSource: "*.ts",
		dependsOn: ["#6 bundles 完整性", "#7 bundle↔patch id 碰撞"],
	},
	{
		name: "dsh.bundle.patch 清单契约（boot profile 产物）",
		tokenCompiled: `dsh?.bundle?.patch`, tokenSource: `dsh?.bundle?.patch`,
		fileCompiled: "*.js", fileSource: "*.ts",
		dependsOn: ["#6 bundles 完整性（patch 契约）"],
	},
];

let pass = 0, fail = 0, warn = 0;
const fixableFileLinks = []; // { profileDir, name, target }
const fixableTuiPatches = []; // { file }
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

/**
 * 定位 dsh 安装根目录（@deepseek-ai/dsh 包根）。
 *
 * 优先从 PATH 解析：`which dsh` → realpath（展开 symlink）→ 向上逐段找
 * `@deepseek-ai/dsh` 作为完整目录段，返回其父目录。这样 nvm / npm-global /
 * pnpm-global / npx-cache / 自定义 prefix 等任意安装布局都能命中——修掉了
 * 旧实现硬编码 `$HOME/.nvm/...` glob、导致其它安装方式下静默跳过的盲点。
 *
 * `dsh` 不在 PATH 时回退到常见全局布局 glob。返回 dsh 包根目录，找不到返回 null。
 */
/** 展开只含单个 `*` 段的 glob（POSIX ls 的 Windows 替代），返回第一个存在的完整路径或 null。 */
function expandFirstGlob(pattern) {
	const parts = pattern.split("/");
	let cur = parts[0] === "$HOME" ? homedir() : parts[0];
	for (let i = 1; i < parts.length; i++) {
		if (parts[i] === "*") {
			try {
				for (const child of readdirSync(cur)) {
					const cand = join(cur, child, ...parts.slice(i + 1));
					if (existsSync(cand)) return cand;
				}
			} catch { /* keep looking */ }
			return null;
		}
		cur = join(cur, parts[i]);
	}
	return existsSync(cur) ? cur : null;
}

/**
 * 定位 dsh 安装根（@deepseek-ai/dsh 包目录）。先探测 PATH 里的 dsh 可执行文件
 * （Windows 用 `where`，POSIX 用 `command -v`），找不到再回退到常见全局布局
 * glob。返回包根目录，找不到返回 null。
 */
function findDshInstall() {
	try {
		const which = process.platform === "win32" ? "where dsh" : "command -v dsh";
		const bin = execSync(which, { encoding: "utf-8" }).trim().split(/\r?\n/)[0];
		if (bin && (bin.startsWith("/") || bin.includes("/") || /^[A-Za-z]:[\\/]/.test(bin))) {
			let real = bin;
			try { real = realpathSync(bin); } catch { /* keep symlink path */ }
			let dir = dirname(real);
			while (dirname(dir) !== dir) {
				if (basename(dir) === "dsh" && basename(dirname(dir)) === "@deepseek-ai") {
					// bin 直接就是 .../@deepseek-ai/dsh/bin/dsh 之类的布局 → 包根即 dir
					return dir;
				}
				// 常见布局：
				//   a) npm 全局 prefix：.../node_modules/@deepseek-ai/dsh（无 lib/ 层）
				//   b) nvm / npm --prefix=.../lib：.../lib/node_modules/@deepseek-ai/dsh
				for (const cand of [
					join(dir, "node_modules", "@deepseek-ai", "dsh"),
					join(dir, "lib", "node_modules", "@deepseek-ai", "dsh"),
				]) {
					if (existsSync(join(cand, "package.json"))) return cand;
				}
				dir = dirname(dir);
			}
		}
	} catch { /* where/command -v failed */ }
	const globs = [
		"$HOME/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh",
		"$HOME/.local/share/pnpm/global/*/node_modules/@deepseek-ai/dsh",
	];
	for (const g of globs) {
		const hit = expandFirstGlob(g);
		if (hit) return hit;
	}
	return null;
}

/**
 * 定位 dsh 安装锚点（@deepseek-ai/dsh 的 package.json）。供 createRequire 解析。
 * 基于 findDshInstall 的统一安装发现，不再硬编码安装布局。
 */
function findInstallAnchor() {
	const root = findDshInstall();
	if (!root) return null;
	const a = join(root, "package.json");
	return existsSync(a) ? a : null;
}

/** 检测双模块实例（覆盖 #1486：同一 @deepseek-ai 包出现两个独立副本并实例化）。
 *
 * 旧实现只在 profile 副本与 dsh 安装**版本不同**时才报，漏掉了 #1486 的核心
 * 崩溃场景——同版本双副本（模块级 Symbol 不匹配）。且安装发现硬编码 ~/.nvm，
 * npx/npm-global 下静默跳过。这里改为：
 *  1. 从 PATH 统一发现 dsh 安装（findDshInstall）；
 *  2. 版本无关：profile 顶层 node_modules/@deepseek-ai/<pkg> 只要是与安装不同
 *     的**独立副本**就报（真目录 vs 指向安装的 symlink）——但仅限 dsh 运行时
 *     组件（名以 `dsh-` 开头），排除 cosmokit/schemastery 这类共享基础库（它们
 *     被 pnpm hoist 提升到顶层是正常、无模块级状态，重复无害）；
 *  3. symlink 指向 dsh 安装同一份 → 单实例，不误报（与 pnpm file: 链接的正常形态一致）。
 */
function checkDualInstances(profileDir) {
	const profileScoped = join(profileDir, "node_modules", "@deepseek-ai");
	if (!existsSync(profileScoped)) return;
	const installRoot = findDshInstall();
	if (!installRoot) return; // 找不到 dsh 安装，跳过（降级，不误报）
	// 安装侧的 @deepseek-ai scoped 目录
	const installScoped = join(installRoot, "node_modules", "@deepseek-ai");
	const installPkgs = existsSync(installScoped) ? new Set(readdirSync(installScoped)) : new Set();
	if (installPkgs.size === 0) return;

	readdirSync(profileScoped)
		.filter((pkg) => pkg.startsWith("dsh-")) // 仅 dsh 运行时组件；cosmokit/schemastery 等共享库排除
		.forEach((pkg) => {
			const pdir = join(profileScoped, pkg);
			let st;
			try { st = lstatSync(pdir); } catch { return; }
			// symlink → 解析真实路径；若指向 install 里的同一份 → 单实例，忽略
			if (st.isSymbolicLink()) {
				try {
					const real = realpathSync(pdir);
					const installPkgDir = join(installScoped, pkg);
					if (real === realpathSync(installPkgDir)) return; // 同一份，正常
				} catch { /* fall through: 无法解析则视为独立副本 */ }
			}
			// 独立副本（真目录或 symlink 指向别处）：若安装在同包名，构成双实例
			if (!installPkgs.has(pkg)) return;
			const readVer = (dir) => {
				try { return JSON.parse(readFileSync(join(dir, pkg, "package.json"), "utf-8")).version; }
				catch { return "?"; }
			};
			const profileVer = readVer(profileScoped);
			const installVer = readVer(installScoped);
			const verNote = profileVer !== installVer ? `（profile v${profileVer} vs 安装 v${installVer}）` : `（同版本 v${profileVer} —— 正是 #1486 的模块级 Symbol 崩溃场景）`;
			report("✗", `双模块实例: @deepseek-ai/${pkg} 在 ${basename(profileDir)} 顶层有独立副本（非指向安装的链接）${verNote}——两个实例会各自持有模块级状态导致工具层崩溃（#1486）`);
		});
}

/**
 * 版本漂移检测（#1515：host 与 profile 各自持有不同版本的 @deepseek-ai/* 包）。
 *
 * 背景（社区讨论 #1515，rc.6 实测）：profile 里 `pnpm install` 把
 * @deepseek-ai/dsh-tools@rc.6 提升进 profile/node_modules，而 host bundle 仍是
 * rc.5。dsh-tools 的 TOOL_RUNTIME_SCHEDULER 是**非全局** Symbol（非 Symbol.for），
 * host 的 agent-loop 从自己那份 import 它，ctx.tools 却是 profile 那份构建的
 * ToolRuntime → ctx.tools[TOOL_RUNTIME_SCHEDULER] === undefined →
 * startCall 抛 "Cannot read properties of undefined (reading 'prepare')"，
 * 会话里每个工具调用都直接失败。
 *
 * 与 checkDualInstances 的分工：
 *   - checkDualInstances 只管"存在独立副本"（同版本也崩，#1486 模块级状态）；
 *   - 本检查聚焦**版本不一致**（#1515），并给出对齐修复指引；且覆盖 cordis 等
 *     共享库（#1515 第二类症状 "cannot get property tools without inject"）。
 *
 * 严重度分级：dsh-* 运行时组件版本漂移 → ✗（工具层必崩）；其余 @deepseek-ai/*
 * （cordis / cosmokit 等共享库）漂移 → ⚠（潜在 inject 失败）。
 */
function checkVersionDrift(profileDir) {
	const profileScoped = join(profileDir, "node_modules", "@deepseek-ai");
	if (!existsSync(profileScoped)) return;
	const installRoot = findDshInstall();
	if (!installRoot) return;
	const installScoped = join(installRoot, "node_modules", "@deepseek-ai");
	if (!existsSync(installScoped)) return;
	const readVer = (dir) => {
		try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")).version; }
		catch { return null; }
	};
	const installPkgs = new Set(readdirSync(installScoped));
	for (const pkg of readdirSync(profileScoped)) {
		if (!installPkgs.has(pkg)) continue;
		const pv = readVer(join(profileScoped, pkg));
		const iv = readVer(join(installScoped, pkg));
		if (!pv || !iv || pv === iv) continue;
		const fix = `删除 ${join(profileScoped, pkg)} 副本 或 pnpm add @deepseek-ai/${pkg}@${iv} 对齐安装版本`;
		if (pkg.startsWith("dsh-")) {
			report("✗", `版本漂移: @deepseek-ai/${pkg} profile v${pv} ≠ 安装 v${iv}（#1515：Symbol 不匹配 → 工具调用崩 reading 'prepare'）; 修复: ${fix}`);
		} else {
			report("⚠", `版本漂移: @deepseek-ai/${pkg} profile v${pv} ≠ 安装 v${iv}（#1515：共享库副本可能引发 "cannot get property tools without inject"）; 修复: ${fix}`);
		}
	}
}

/**
 * Windows 沙箱 TLS 探测（#1789：受限令牌下 schannel 拿不到 TLS 凭据）。
 *
 * 背景：dsh-sandbox-windows-acl 用 CreateRestrictedToken 创建受限令牌跑
 * workspace-write 沙箱命令，Windows schannel（curl.exe/.NET HttpClient）因此
 * `SEC_E_NO_CREDENTIALS (0x8009030e)` 无法完成 TLS——与沙箱文档
 * "reads, network, and process visibility are NOT restricted" 矛盾。
 *
 * 本检查：先探测当前进程是否受限令牌（whoami /groups 找 deny-only），再实测
 * curl.exe 的 HTTPS 握手。命中特征错误即报 #1789 并给 workaround；完整令牌或
 * 握手成功则放行。dsh-doctor 由用户在受限会话里跑时即可现场复现该 bug。
 */
function checkSandboxTls() {
	if (process.platform !== "win32") return; // schannel 仅存在于 Windows
	let restricted = false;
	try {
		const groups = execSync("whoami /groups", { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		restricted = /deny-only|restricted/i.test(groups);
	} catch { /* 探测失败不阻塞后续实测 */ }
	let httpCode = null, errText = "";
	try {
		httpCode = execSync('curl.exe -s -o NUL -w "%{http_code}" -m 10 https://example.com', {
			encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000,
		}).trim();
	} catch (e) {
		errText = String(e.stderr ?? "");
	}
	const tokenDesc = restricted ? "受限令牌(workspace-write 沙箱)" : "完整令牌";
	if (httpCode === "200") {
		report("✓", `沙箱 TLS: ${tokenDesc} 下 curl HTTPS 握手成功（HTTP 200，#1789 未复现）`);
		return;
	}
	if (/SEC_E_NO_CREDENTIALS|AcquireCredentialsHandle/i.test(errText)) {
		report("✗", `沙箱 TLS: ${tokenDesc} 下 schannel 无法获取 TLS 凭据（${errText.match(/SEC_E_[A-Z_]+/)?.[0] ?? "SEC_E_NO_CREDENTIALS"}）—— 命中 #1789；workaround: 用 danger-full-access 模式跑联网命令，或改用 Python/OpenSSL 等非 schannel 客户端`);
		return;
	}
	if (httpCode === null) {
		report("⚠", `沙箱 TLS: 无法用 curl 完成 HTTPS 探测（${errText.trim().split("\n")[0].slice(0, 100) || "curl 不可用/超时"}）—— 若在受限会话里且错误含 SEC_E_NO_CREDENTIALS 即 #1789`);
		return;
	}
	report("✓", `沙箱 TLS: ${tokenDesc} 下 curl HTTPS 返回 HTTP ${httpCode}（非 #1789 特征）`);
}

/**
 * skill frontmatter 冒号检测（#1401/#1450/#936）。
 *
 * `~/.dsh/skills/<name>/SKILL.md`（以及 preset 的 skills/）frontmatter 里
 * `description` 值若包含 ASCII "冒号+空格"（如 "Priority order: check ..."）
 * 且未用引号包裹，parseFrontmatter 会抛 "Nested mappings are not allowed in
 * compact mappings"，skill 被静默移除——catalog 完全不出现，仅后端 logger.warn。
 *
 * 本检查扫描 DSH_HOME/skills 与各 preset 的 skills 目录，找出未加引号且
 * description 含 ASCII 冒号后随空格的 SKILL.md，提示加双引号包裹。
 */
function checkSkillFrontmatter() {
	const roots = [join(dshHome, "skills")];
	// preset 自带的 skills/（~/.dsh/.agent-presets/<id>/skills/）
	try {
		const presetsRoot = join(dshHome, ".agent-presets");
		if (existsSync(presetsRoot)) {
			for (const id of readdirSync(presetsRoot)) {
				const p = join(presetsRoot, id, "skills");
				if (existsSync(p)) roots.push(p);
			}
		}
	} catch { /* ignore */ }
	let scanned = 0, bad = 0;
	for (const root of roots) {
		if (!existsSync(root)) continue;
		let entries;
		try { entries = readdirSync(root); } catch { continue; }
		for (const skillDir of entries) {
			const md = join(root, skillDir, "SKILL.md");
			if (!existsSync(md)) continue;
			scanned++;
			let src;
			try { src = readFileSync(md, "utf8"); } catch { continue; }
			// 只取 frontmatter（首个 --- 到第二个 ---）
			const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
			if (!fm) continue;
			for (const line of fm[1].split(/\r?\n/)) {
				const m = line.match(/^description:\s*(.+)$/);
				if (!m) continue;
				const val = m[1].trim();
				// 已用引号包裹 → 安全
				if (/^["'].*["']$/.test(val)) continue;
				// ASCII 冒号+空格 → YAML compact mapping 解析炸弹
				if (/:\s/.test(val)) {
					bad++;
					report("⚠", `skill frontmatter 冒号未加引号: ${md.replace(dshHome, "~")} — description 含 ": " 会被 YAML 误解析、skill 被静默丢弃（#1401/#936）；修复: description: "${val}"`);
				}
			}
		}
	}
	if (scanned > 0 && bad === 0) report("✓", `skill frontmatter: ${scanned} 个 SKILL.md 无冒号陷阱（#1401）`);
	else if (scanned === 0) report("✓", `skill frontmatter: 无 skills 目录可扫（跳过）`);
}

/**
 * Windows 端口排除段检测（#1462：3080 落在 Hyper-V/WSL2 保留区间 → EACCES）。
 *
 * Windows 启用 Hyper-V/WSL2/Docker 后，系统会保留若干 TCP 端口段（如
 * 3080–3179），任何进程（含管理员）都无法绑定 → dsh web 默认端口 3080
 * 直接 EACCES 起不来。排除段每台机器不同，换固定端口也脆弱。
 *
 * 本检查解析 `netsh interface ipv4 show excludedportrange protocol=tcp`，
 * 报告 3080 是否落在排除段内并给出 `--port` 建议。
 */
function checkExcludedPorts() {
	if (process.platform !== "win32") return; // 仅 Windows 有 Hyper-V 保留端口
	let out = "";
	try {
		out = execSync("netsh interface ipv4 show excludedportrange protocol=tcp", {
			encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
		});
	} catch {
		report("⚠", `端口排除段: netsh 不可用/超时（跳过 #1462 检查）`);
		return;
	}
	const ranges = [];
	for (const line of out.split(/\r?\n/)) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
		if (m) ranges.push({ start: +m[1], end: +m[2] });
	}
	if (ranges.length === 0) { report("✓", `端口排除段: netsh 无输出（#1462 不适用）`); return; }
	const PORT = 3080;
	const hit = ranges.find((r) => PORT >= r.start && PORT <= r.end);
	if (hit) {
		report("✗", `端口 3080 在 Windows 排除段 ${hit.start}–${hit.end} 内（#1462）— dsh web 绑定将 EACCES；修复: dsh web --port 8080（或任一非排除端口），或 netsh int ipv4 add excludedportrange 调整保留段`);
	} else {
		report("✓", `端口 3080 不在 Windows 排除段内（当前 ${ranges.length} 段，最近 ${ranges.map((r) => `${r.start}-${r.end}`).slice(0, 3).join(", ")}…）`);
	}
}

/**
 * PATH 工具可用性检测（#1270/#1772：node/pnpm 不在 PATH → 新建会话静默失败 /
 * npx 无法安装）。
 *
 * dsh 的 subprocess 后端用 `env node` 定位 node，node 不在 PATH 时新建会话
 * 静默失败（web.err.log 刷 "env: node: No such file or directory"）；npx/npm
 * 安装同理。本检查探测 node/pnpm/npm/zstd 是否可解析。
 */
function checkPathTools() {
	const probe = (name) => {
		try {
			const cmd = process.platform === "win32" ? `where ${name}` : `command -v ${name}`;
			const o = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
			return o.split(/\r?\n/)[0] || null;
		} catch { return null; }
	};
	const nodePath = probe("node");
	const pnpmPath = probe("pnpm");
	const npmPath = probe("npm");
	const zstdPath = probe("zstd");
	if (nodePath) report("✓", `PATH node: ${nodePath}`);
	else report("✗", `PATH node: 未找到 — dsh 新建会话会静默失败（#1270）；修复: 把 node 所在目录加入 PATH（版本管理器/自定义安装常见）`);
	if (pnpmPath) report("✓", `PATH pnpm: ${pnpmPath}`);
	else report("⚠", `PATH pnpm: 未找到（dsh 插件安装依赖 pnpm；npm 也可用）`);
	if (npmPath) report("✓", `PATH npm: ${npmPath}`);
	else report("⚠", `PATH npm: 未找到（npx 安装 dsh 依赖 npm）`);
	if (zstdPath) report("✓", `PATH zstd: ${zstdPath}`);
	else report("⚠", `PATH zstd: 未找到（会话日志 zstd 解码降级为明文；--session 检查仍可用）`);
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

/**
 * 部署 zstd 解码会话日志（`session.jsonl.zstd`）。优先 Node 内置 zstd（多帧
 * 拼接，与官方 `.zstd` 布局一致），再回退 `zstd -dc`；都不可用时返回 null
 * （降级跳过）。
 */
function zstdDecode(filePath) {
	if (zstdDecompressSync !== null) {
		try {
			const buf = readFileSync(filePath);
			const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
			const frames = [];
			let i = 0;
			while (i < buf.length) {
				const idx = buf.indexOf(magic, i);
				if (idx === -1) break;
				const next = buf.indexOf(magic, idx + 4);
				const end = next === -1 ? buf.length : next;
				frames.push(buf.subarray(idx, end));
				i = end;
			}
			if (frames.length === 0) return null;
			return frames.map((f) => zstdDecompressSync(f).toString("utf8")).join("");
		} catch {
			// fall through to the zstd CLI
		}
	}
	try {
		return execSync(`zstd -dc ${JSON.stringify(filePath)}`, { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
	} catch {
		return null;
	}
}

/**
 * 扫描会话日志里的“悬空 tool_call”——覆盖 #1544/#1363：
 * 工具执行崩溃时未写入对应 `tool/result`，会话历史残留带 tool_calls 却无
 * tool 结果的消息 → 后续每个请求都被 API 以 400 insufficient tool messages 拒绝。
 *
 * 配对键对齐源码：
 *   packages/core/session/src/types.ts:279 `tool/call` 携带 `callId`
 *   packages/core/session/src/types.ts:291 `tool/result` 的 `message.source.callId`
 *   （tools/src/index.ts:315 ToolResultMessage.callId）
 * 孤儿判定：某 callId 在 tool/call 中出现的次数 > 在 tool/result 中匹配的次数。
 *
 * @param sessionPath - `session.jsonl.zstd` 文件路径。
 * @param display - 会话显示名。
 */
function checkSessionOrphanToolCalls(sessionPath, display) {
	const raw = /\.zstd$/.test(sessionPath) ? zstdDecode(sessionPath) : (existsSync(sessionPath) ? readFileSync(sessionPath, "utf-8") : null);
	if (raw === null) {
		report("⚠", `会话不可读/无 zstd: ${display}（跳过孤儿 tool_call 检查）`);
		return;
	}
	const callCount = new Map();   // callId -> { count, turn }
	const resultCount = new Map(); // callId -> 匹配次数
	let maxResultTurn = -Infinity;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let d;
		try { d = JSON.parse(line); } catch { continue; }
		const t = d.type;
		const data = d.data ?? {};
		if (t === "tool/call" && typeof data.callId === "string") {
			const prev = callCount.get(data.callId) ?? { count: 0, turn: data.turn };
			callCount.set(data.callId, { count: prev.count + 1, turn: data.turn });
		} else if (t === "tool/result") {
			const m = data.message ?? {};
			if (Number.isFinite(data.turn)) maxResultTurn = Math.max(maxResultTurn, data.turn);
			const cid = (m.source ?? {}).callId;
			if (typeof cid === "string") {
				resultCount.set(cid, (resultCount.get(cid) ?? 0) + 1);
			}
		}
	}
	let orphans = 0;
	for (const [cid, { count: calls, turn }] of callCount) {
		const results = resultCount.get(cid) ?? 0;
		if (calls <= results) continue;
		// 若该 tool/call 落在尚未产出过任何 tool/result 的最新回合（可能是
		// 仍在运行的会话的 in-flight 调用），只警告不判死；已完成的旧回合里
		// 残留才是真正的悬空（#1544 会污染后续每个请求）。
		if (turn >= maxResultTurn) {
			orphans++;
			report("⚠", `可能 in-flight tool_call: ${cid}（turn=${turn} 是目前最新活动回合 —— 若会话已结束才算悬空，#1544）`);
			continue;
		}
		orphans++;
		report("✗", `悬空 tool_call: ${cid}（${calls} 次 tool/call 仅 ${results} 次 tool/result，且位于已完成的较旧回合 —— 会话 ${display} 后续回合会被 400 insufficient tool messages 拒绝，#1544/#1363）`);
	}
	if (orphans === 0) report("✓", `无悬空 tool_call: ${display}`);
}

/**
 * 解析会话日志为事件流——与 loader 一致（SessionLogScanner.consumeEventLine）：
 * packed 分片行（text-chunks / reasoning-chunks / tool-call-chunks）展开为
 * seq0..seq0+dt.length 的成员事件，普通事件取 d.seq。header 行跳过。
 * 零依赖，只做结构解析。
 *
 * @param {string} raw - 解码后的 JSONL 文本。
 * @returns {{ events: Array, present: Set<number>, maxSeq: number }}
 *   events 每项: { seq, type, line, src?, srcOne?, surfaceOp? }
 *   src = d.sourceEventSeqs；srcOne = d.data.sourceEventSeq；surfaceOp = d.surfaceOp。
 */
function parseSessionLog(raw) {
	const events = [];
	const present = new Set();
	let maxSeq = -1, line = 0;
	for (const l of raw.split("\n")) {
		line++;
		if (!l.trim()) continue;
		let d;
		try { d = JSON.parse(l); } catch { continue; }
		if (d && typeof d === "object" && d.type === "session") continue;
		if (d && typeof d === "object" && (d.type === "text-chunks" || d.type === "reasoning-chunks" || d.type === "tool-call-chunks")) {
			const count = (d.data && Array.isArray(d.data.dt) ? d.data.dt.length : 0) + 1;
			for (let i = 0; i < count; i++) {
				const seq = d.seq0 + i;
				events.push({ seq, type: d.type, line, packed: true });
				present.add(seq);
				if (seq > maxSeq) maxSeq = seq;
			}
			continue;
		}
		const seq = d.seq;
		if (!Number.isInteger(seq)) continue;
		events.push({
			seq,
			type: d.type,
			line,
			src: Array.isArray(d.sourceEventSeqs) ? d.sourceEventSeqs : undefined,
			srcOne: typeof (d.data ?? {})?.sourceEventSeq === "number" ? d.data.sourceEventSeq : undefined,
			surfaceOp: d.surfaceOp && typeof d.surfaceOp === "object" ? d.surfaceOp : undefined,
		});
		present.add(seq);
		if (seq > maxSeq) maxSeq = seq;
	}
	return { events, present, maxSeq };
}

/**
 * 会话日志 seq 完整性检测（#1497/#1469/#1586/#1452/#1433/#1333/#1305/#1287/#1299）。
 *
 * dsh 的 SessionLogScanner.consumeEventLine 要求每个事件的 `seq` 与它在日志中的
 * 位置连续（expected === index）。社区里反复出现三类破坏：
 *   - 非正常退出后重放已提交事件 → seq 倒退/重复（#1497/#1287）
 *   - 强制压缩折叠事件但未重排后续 seq → seq gap（#1469）
 *   - 多进程并发写同一会话 → seq 撞号（#1433/#1452/#1586）
 * 任何一种都会让加载器报 `corrupt session log: seq gap in committed region`，
 * 整段历史永久不可加载（#1047/#1473：单个坏日志还能让 session.list 整体 500）。
 *
 * 本检查与 loader 同样先展开 packed 分片行再核对连续性（避免对含 packed 行的
 * 正常日志误报），并额外扫描压缩的伴生损坏——seq 引用（sourceEventSeqs /
 * data.sourceEventSeq / surfaceOp.start/end）指向自身、后续事件或日志中不存在的
 * 事件（压缩折叠后未重映射引用的典型形态）。
 *
 * @param sessionPath - `session.jsonl.zstd` / 明文 `.jsonl` 文件路径。
 * @param display - 会话显示名。
 */
function checkSessionSeqIntegrity(sessionPath, display) {
	const raw = /\.zstd$/.test(sessionPath) ? zstdDecode(sessionPath) : (existsSync(sessionPath) ? readFileSync(sessionPath, "utf-8") : null);
	if (raw === null) {
		report("⚠", `会话不可读/无 zstd: ${display}（跳过 seq 完整性检查）`);
		return;
	}
	const { events, present } = parseSessionLog(raw);
	let expected = 0, issues = 0;
	const gaps = [], dupes = [], rewind = [];
	for (const e of events) {
		if (e.seq === expected) { expected++; continue; }
		if (e.seq > expected) { gaps.push(`L${e.line} seq ${expected}→${e.seq}（缺 ${e.seq - expected}）`); expected = e.seq + 1; issues++; }
		else if (e.seq === expected - 1) { /* 重复的旧 seq 也计问题 */ dupes.push(`L${e.line} seq ${e.seq} 重复`); issues++; }
		else { rewind.push(`L${e.line} seq ${e.seq} 倒退（已见 ${expected - 1}）`); issues++; }
	}
	// 伴生损坏：seq 引用指向自身/后续事件，或指向日志中不存在的事件（悬空）。
	const selfRefs = [], danglingRefs = [];
	for (const e of events) {
		const refs = [];
		if (e.src) for (const s of e.src) refs.push([s, "sourceEventSeqs"]);
		if (e.srcOne !== undefined) refs.push([e.srcOne, "data.sourceEventSeq"]);
		if (e.surfaceOp) {
			if (Number.isInteger(e.surfaceOp.start)) refs.push([e.surfaceOp.start, "surfaceOp.start"]);
			if (Number.isInteger(e.surfaceOp.end)) refs.push([e.surfaceOp.end, "surfaceOp.end"]);
		}
		for (const [s, field] of refs) {
			if (s >= e.seq) selfRefs.push(`L${e.line} seq=${e.seq} ${field}=${s} 引用自身/后续事件`);
			else if (!present.has(s)) danglingRefs.push(`L${e.line} seq=${e.seq} ${field}=${s} 悬空（日志中不存在该 seq）`);
		}
	}
	if (issues === 0 && selfRefs.length === 0 && danglingRefs.length === 0) {
		report("✓", `会话 seq 连续: ${display}（${events.length} 事件无 gap/重复/坏引用）`);
		return;
	}
	const MAX_SHOW = 4;
	const show = (arr) => arr.slice(0, MAX_SHOW).join("; ") + (arr.length > MAX_SHOW ? ` …（共 ${arr.length} 处）` : "");
	if (gaps.length) report("✗", `会话 seq 空洞: ${display} — ${show(gaps)}（#1469/#1497 压缩/崩溃后未重排 seq，加载器将报 corrupt session log）`);
	if (dupes.length) report("✗", `会话 seq 重复: ${display} — ${show(dupes)}（#1497/#1287 崩溃重放已提交事件）`);
	if (rewind.length) report("✗", `会话 seq 倒退: ${display} — ${show(rewind)}（#1433/#1452/#1586 并发写/重放导致 seq 撞号）`);
	if (selfRefs.length) report("✗", `会话 seq 引用错乱: ${display} — ${show(selfRefs)}（压缩折叠后未重映射引用，sourceEventSeqs 指向自身/后续事件）`);
	if (danglingRefs.length) report("✗", `会话 seq 引用悬空: ${display} — ${show(danglingRefs)}（压缩折叠删除了被引用事件但未重映射）`);
}

/** 用 Node 内置 zstd（带 checksum 标志）编码一帧 JSONL；不可用时返回 null。 */
function zstdEncodeFrame(text) {
	if (zstdCompressSync === null) return null;
	try {
		return zstdCompressSync(Buffer.from(text, "utf8"), { params: { [zstdChecksumFlag]: 1 } });
	} catch {
		return null;
	}
}

/**
 * 原子修复会话日志的 seq 类损坏（#1497/#1469 族）——实现"压缩写入路径"的正确
 * 修复语义：按出现顺序重排全部 seq（含 packed 行 seq0 与成员），并全量重映射
 * seq 引用（sourceEventSeqs / data.sourceEventSeq / surfaceOp.start/end）。
 * 无法映射的悬空引用剔除；surfaceOp 语义无法保持的事件降级为普通事件（被删
 * 节点已不在日志中，保留 replace 声明只会继续悬空）。
 *
 * 写回严格原子：备份原文件 → 写临时文件 → 用 loader 规则（展开后 seq 连续、
 * 无自身/后续/悬空引用）校验通过 → rename 替换；校验不过或写失败均不触碰
 * 原文件（备份保留，供人工复查）。
 *
 * @param {string} sessionPath - 会话日志路径。
 * @returns {boolean} 是否成功写回。
 */
function repairSessionLog(sessionPath) {
	const isZstd = /\.zstd$/.test(sessionPath);
	const raw = isZstd ? zstdDecode(sessionPath) : (existsSync(sessionPath) ? readFileSync(sessionPath, "utf-8") : null);
	if (raw === null) {
		report("⚠", `会话不可读/无 zstd: ${sessionPath}（跳过修复）`);
		return false;
	}

	// 1) 按出现顺序分配新 seq（展开事件流；packed 行成员在行内连续出现）。
	const lines = raw.split("\n");
	const seqFor = new Map(); // oldSeq -> newSeq
	let next = 0, eventCount = 0, packedRows = 0;
	for (const l of lines) {
		if (!l.trim()) continue;
		let d;
		try { d = JSON.parse(l); } catch { continue; }
		if (d && typeof d === "object" && d.type === "session") continue;
		if (d && typeof d === "object" && (d.type === "text-chunks" || d.type === "reasoning-chunks" || d.type === "tool-call-chunks")) {
			const count = (d.data && Array.isArray(d.data.dt) ? d.data.dt.length : 0) + 1;
			for (let i = 0; i < count; i++) {
				if (!seqFor.has(d.seq0 + i)) seqFor.set(d.seq0 + i, next);
				next++;
			}
			packedRows++;
			continue;
		}
		const seq = d?.seq;
		if (!Number.isInteger(seq)) continue;
		if (!seqFor.has(seq)) seqFor.set(seq, next);
		next++;
		eventCount++;
	}

	// 2) 重写行：新 seq 按行序独立分配（重复 seq 的每一行都拿到唯一新 seq；
	//    seqFor 只记录每个旧 seq 的首次映射，供引用重映射使用）。
	const out = [];
	let nextSeq = 0, droppedRefs = 0, demotedSurface = 0;
	for (const l of lines) {
		if (!l.trim()) { out.push(l); continue; }
		let d;
		try { d = JSON.parse(l); } catch { out.push(l); continue; }
		if (d && typeof d === "object" && d.type === "session") { out.push(l); continue; }
		if (d && typeof d === "object" && (d.type === "text-chunks" || d.type === "reasoning-chunks" || d.type === "tool-call-chunks")) {
			const count = (d.data && Array.isArray(d.data.dt) ? d.data.dt.length : 0) + 1;
			d.seq0 = nextSeq;
			nextSeq += count;
			out.push(JSON.stringify(d));
			continue;
		}
		const seq = d?.seq;
		if (!Number.isInteger(seq)) { out.push(l); continue; }
		d.seq = nextSeq++;
		// sourceEventSeqs：重映射；目标已不在日志中或映射后 ≥ 自身（引用后续
		// 事件本身即损坏）的引用剔除。
		if (Array.isArray(d.sourceEventSeqs)) {
			const mapped = d.sourceEventSeqs.map((s) => seqFor.get(s)).filter((s) => s !== undefined && s < d.seq);
			droppedRefs += d.sourceEventSeqs.length - mapped.length;
			if (mapped.length === 0) delete d.sourceEventSeqs;
			else d.sourceEventSeqs = mapped;
		}
		// data.sourceEventSeq（command/done）：同上。
		if (d.data && typeof d.data === "object" && typeof d.data.sourceEventSeq === "number") {
			const m = seqFor.get(d.data.sourceEventSeq);
			if (m === undefined || m >= d.seq) { delete d.data.sourceEventSeq; droppedRefs++; }
			else d.data.sourceEventSeq = m;
		}
		// surfaceOp.start/end：重映射；任一目标缺失或映射后 ≥ 自身则降级为普通事件。
		if (d.surfaceOp && typeof d.surfaceOp === "object") {
			const start = Number.isInteger(d.surfaceOp.start) ? seqFor.get(d.surfaceOp.start) : undefined;
			const end = Number.isInteger(d.surfaceOp.end) ? seqFor.get(d.surfaceOp.end) : undefined;
			if (start === undefined || end === undefined || start >= d.seq || end >= d.seq) {
				delete d.surfaceOp;
				delete d.sourceEventSeqs; // 降级为普通事件：replace 语义已无法保持
				demotedSurface++;
			} else {
				d.surfaceOp.start = start;
				d.surfaceOp.end = end;
			}
		}
		out.push(JSON.stringify(d));
	}
	const repairedText = out.join("\n");

	// 3) 校验（loader 规则：展开后 seq === index；引用 < 自身且目标存在）。
	const { events, present } = parseSessionLog(repairedText);
	let badSeq = 0, expected = 0;
	for (const e of events) { if (e.seq !== expected) badSeq++; expected++; }
	let badRef = 0;
	for (const e of events) {
		const refs = [];
		if (e.src) for (const s of e.src) refs.push(s);
		if (e.srcOne !== undefined) refs.push(e.srcOne);
		if (e.surfaceOp) { refs.push(e.surfaceOp.start, e.surfaceOp.end); }
		for (const s of refs) if (s >= e.seq || !present.has(s)) badRef++;
	}
	if (badSeq !== 0 || badRef !== 0) {
		report("✗", `修复校验失败（${badSeq} 处不连续 / ${badRef} 处坏引用），未写回: ${sessionPath}`);
		return false;
	}

	// 4) 备份 + 临时文件 + rename 原子写回。
	const backup = `${sessionPath}.bak-repair-${Date.now()}`;
	try {
		copyFileSync(sessionPath, backup);
		const tmp = `${sessionPath}.repair-tmp`;
		if (isZstd) {
			const headerEnd = repairedText.indexOf("\n") + 1;
			const headerFrame = zstdEncodeFrame(repairedText.slice(0, headerEnd));
			const bodyFrame = zstdEncodeFrame(repairedText.slice(headerEnd));
			if (headerFrame === null || bodyFrame === null) {
				report("✗", `zstd 编码不可用（Node 需 ≥22.18 或安装 zstd CLI），未写回: ${sessionPath}（备份已保留: ${backup}）`);
				return false;
			}
			writeFileSync(tmp, Buffer.concat([headerFrame, bodyFrame]));
		} else {
			writeFileSync(tmp, repairedText, "utf-8");
		}
		renameSync(tmp, sessionPath);
	} catch (e) {
		report("✗", `修复写回失败（备份已保留 ${backup}）: ${String(e?.message ?? e)}`);
		return false;
	}
	report("✓", `会话已修复: ${sessionPath}（重排 ${eventCount} 事件${packedRows ? ` / ${packedRows} 个 packed 行` : ""}${droppedRefs ? ` / 剔除 ${droppedRefs} 个悬空引用` : ""}${demotedSurface ? ` / 降级 ${demotedSurface} 个 surfaceOp` : ""}；备份: ${backup}）`);
	return true;
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

/** 检查 pi-tui 超宽行崩溃补丁是否在位。
 * 背景：@earendil-works/pi-tui 的 tui-main-screen.js 在渲染超宽行时
 * `throw new Error(errorMsg)` 直接杀掉整个 pi 进程（我们实测过：一次超长
 * 中文行就把进程搞崩，还连累进行中的工具调用）。修复是把它换成
 * `truncateToWidth(line, width)` 截断。补丁打在 node_modules 里，
 * pi-tui 升级会被覆盖 —— 本 check 检测补丁是否仍在，`--fix` 可重打。
 */
function checkTuiPatch() {
	const tuiDir = join(profilesRoot, "tui");
	const tuiFile = join(tuiDir, "node_modules", "@earendil-works", "pi-tui", "dist", "tui-main-screen.js");
	if (!existsSync(tuiFile)) return; // 无 TUI profile 或该版本无此文件 → 跳过
	let src;
	try { src = readFileSync(tuiFile, "utf8"); } catch { return; }
	const patched = src.includes("truncateToWidth(line, width)");
	const oldCrash = src.includes("throw new Error(errorMsg);");
	if (patched) {
		report("✓", `TUI 超宽行补丁在位: pi-tui（超宽行截断而非杀进程）`);
	} else if (oldCrash) {
		report("✗", `TUI 超宽行崩溃补丁缺失: pi-tui 仍是「超宽即 throw 杀进程」${fixMode ? "" : "（升级可能覆盖了补丁；用 --fix 重打）"}`);
		if (fixMode) fixableTuiPatches.push({ file: tuiFile });
	} else {
		report("⚠", `TUI 渲染文件结构未知: pi-tui 既无补丁也无旧崩溃代码（版本可能已改结构）`);
	}
}

/** 给 pi-tui 打超宽行截断补丁（token 级替换，对版本变化鲁棒），返回是否改动。 */
function applyTuiPatch(file) {
	const src = readFileSync(file, "utf8");
	let out = src;
	let changed = false;
	if (!out.includes("truncateToWidth") && out.includes('import { visibleWidth } from "./utils.js";')) {
		out = out.replace('import { visibleWidth } from "./utils.js";', 'import { visibleWidth, truncateToWidth } from "./utils.js";');
		changed = true;
	}
	if (out.includes("throw new Error(errorMsg);")) {
		out = out.replace("throw new Error(errorMsg);", "line = truncateToWidth(line, width); // [dsh-doctor] 超宽行截断替代崩溃");
		changed = true;
	}
	if (changed) {
		writeFileSync(file + ".bak", src); // 备份
		writeFileSync(file, out);
	}
	return changed;
}

/** 检查一个 profile */
function checkProfile(dir) {
	const profileName = basename(dir); // Windows 路径用 \，split("/") 会返回整条路径
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

	// 7b. host/profile 版本漂移检测（覆盖 #1515：reading 'prepare' 崩溃）
	checkVersionDrift(profileDir);

	// 8. dsh.profile.bundles 完整性检测（覆盖 #917 悬空 bundle 残留）
	const installAnchor = findInstallAnchor();
	checkBundles(profileDir, installAnchor);

	// 9. bundle 与用户 patch id 碰撞检测（advisory item (a)；#1404/#1479）
	checkBundleIdCollision(profileDir, installAnchor);

	// 10. toolkit-plugins 持久化动态插件源码完整性（plugin_deploy 恢复的前提）
	const tkDir = join(profileDir, "toolkit-plugins");
	if (existsSync(tkDir)) {
		const kits = readdirSync(tkDir).filter((k) => {
			try { return lstatSync(join(tkDir, k)).isDirectory(); } catch { return false; }
		});
		for (const kit of kits) {
			const hasMjs = existsSync(join(tkDir, kit, "index.mjs"));
			const hasHost = existsSync(join(tkDir, kit, "host.js"));
			const hasClient = existsSync(join(tkDir, kit, "client.js"));
			if (hasMjs) {
				report("✓", `全局工具插件: ${kit}（index.mjs，host 组合加载，重启自动生效）`);
			} else if (hasHost || hasClient) {
				report("✓", `持久化动态插件源码: ${kit}（host:${hasHost ? "有" : "无"} client:${hasClient ? "有" : "无"}；重启后用 plugin_deploy 恢复）`);
			} else {
				report("⚠", `持久化插件目录异常: ${kit}（无 index.mjs / host.js / client.js，plugin_deploy 无法恢复）`);
			}
		}
	}
}

/** 转义正则元字符（fixed 字面量匹配用）。 */
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 简单 glob（仅 `*`）转正则：*.js → ^.*\.js$。 */
function globToRegExp(glob) {
	return new RegExp("^" + glob.split("*").map(escapeRegExp).join(".*") + "$");
}

/** 深度扫描某目录下源码/编译文件是否包含某 token。
 * 纯 Node 递归实现（Windows 无 grep，POSIX 的 grep -r 也不跟随 symlink，
 * 这里用 lstatSync 同样跳过符号链接以免循环）。fixed=true 时 token 按字面量匹配。 */
function deepInspectContains(root, filenamePattern, token, fixed = false) {
	const needle = fixed ? token : new RegExp(token);
	const fileRe = globToRegExp(filenamePattern);
	let hits = 0;
	const walk = (dir) => {
		if (hits >= 5) return;
		let entries;
		try { entries = readdirSync(dir); } catch { return; }
		for (const child of entries) {
			if (hits >= 5) return;
			const full = join(dir, child);
			let st;
			try { st = lstatSync(full); } catch { continue; }
			if (st.isDirectory()) { walk(full); continue; }
			if (!st.isFile() || !fileRe.test(child)) continue;
			try {
				const content = readFileSync(full, "utf8");
				if (fixed ? content.includes(token) : needle.test(content)) hits++;
			} catch { /* 不可读/非文本文件跳过 */ }
		}
	};
	walk(root);
	return hits > 0;
}

/**
 * 解析安装版 dsh 的某个子包目录（在 @deepseek-ai/dsh 的 node_modules 下）。
 * npm 编译产物布局：@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>。
 */
function installedSubPackage(installAnchor, pkg) {
	if (!installAnchor) return null;
	const base = dirname(installAnchor); // .../lib/node_modules/@deepseek-ai/dsh
	for (const dir of [join(base, "node_modules", "@deepseek-ai", pkg), join(base, "node_modules", pkg)]) {
		if (existsSync(dir)) return dir;
	}
	return null;
}

/**
 * 定位并扫描锚点（共享实现：verifyAnchors CLI 与 checkAnchorBaseline 自动检查共用）。
 *
 * 返回 { targetDesc, sessionDir, toolsDir, bootDir, results }：
 *   results = [{ name, ok, where, dependsOn }]；找不到安装时返回 null（调用方降级）。
 * 不 process.exit —— 由调用方决定如何处理结果。
 */
function scanAnchors(dirArg) {
	let installAnchor = null;
	let targetDesc;
	if (dirArg) {
		if (!existsSync(dirArg)) return null;
		targetDesc = dirArg;
	} else {
		installAnchor = findInstallAnchor();
		if (!installAnchor) return null;
		targetDesc = dirname(installAnchor);
	}

	const sessionDir = (dirArg != null
		? [join(dirArg, "node_modules", "@deepseek-ai", "dsh-session"), join(dirArg, "packages/core/session")].find(existsSync)
		: installedSubPackage(installAnchor, "dsh-session") ?? join(targetDesc, "node_modules", "@deepseek-ai", "dsh-session"));
	const toolsDir = (dirArg != null
		? [join(dirArg, "node_modules", "@deepseek-ai", "dsh-tools"), join(dirArg, "packages/core/tools")].find(existsSync)
		: installedSubPackage(installAnchor, "dsh-tools") ?? join(targetDesc, "node_modules", "@deepseek-ai", "dsh-tools"));
	const bootDir = (dirArg != null
		? [join(dirArg, "node_modules", "@deepseek-ai", "dsh-app-boot"), join(dirArg, "packages/boot/app-boot")].find(existsSync)
		: installedSubPackage(installAnchor, "dsh-app-boot") ?? join(targetDesc, "node_modules", "@deepseek-ai", "dsh-app-boot"));

	const whichDir = (dir, kind) =>
		kind === "compiled" && existsSync(dir) ? dir
			: kind === "source" && existsSync(dir) ? dir
				: null;

	const results = [];
	for (const a of ANCHORS) {
		const candidates = [
			[a, "session", sessionDir, "compiled"], [a, "session", sessionDir, "source"],
			[a, "tools", toolsDir, "compiled"], [a, "tools", toolsDir, "source"],
			[a, "boot", bootDir, "compiled"], [a, "boot", bootDir, "source"],
		];
		let found = false, where = "";
		for (const [, , dir, kind] of candidates) {
			if (!dir) continue;
			const token = kind === "compiled" ? a.tokenCompiled : a.tokenSource;
			const file = kind === "compiled" ? a.fileCompiled : a.fileSource;
			if (deepInspectContains(dir, file, token, true)) { found = true; where = `${kind}:${dir}`; break; }
		}
		results.push({ name: a.name, ok: found, where, dependsOn: a.dependsOn });
	}
	return { targetDesc, sessionDir, toolsDir, bootDir, results };
}

/**
 * 自动锚点基线检查（防漂移第 1 道闸，每次常规运行都跑）。
 *
 * 本机安装的 dsh 版本 vs ANCHOR_BASELINE_VERSION：
 *   - 版本一致 → 锚点可信，✓；
 *   - 版本不一致（本地更新了 / 与基线漂移）→ 立即自动扫描锚点：
 *       锚点全在 → ⚠ 提示版本漂移但检测仍有效（建议核对官方是否改行为）；
 *       锚点缺失 → ✗ 检测逻辑已与当前 dsh 脱节，列出受影响检查，要求人工核对。
 *   找不到 dsh 安装 → ⚠ 跳过（无安装无从核对，不误报）。
 */
function checkAnchorBaseline() {
	const installAnchor = findInstallAnchor();
	if (!installAnchor) {
		report("⚠", `锚点基线: 找不到 dsh 安装（跳过；可显式 --verify-anchors <目录>）`);
		return;
	}
	let installedVer = "?";
	try { installedVer = JSON.parse(readFileSync(installAnchor, "utf-8")).version ?? "?"; } catch { /* keep ? */ }
	if (installedVer === ANCHOR_BASELINE_VERSION) {
		report("✓", `锚点基线: 本机 dsh v${installedVer} == 基线（${ANCHORS.length} 个检测锚点可信）`);
		return;
	}
	// 版本漂移 → 自动扫描锚点确认检测是否仍有效
	report("⚠", `锚点基线: 本机 dsh v${installedVer} ≠ 基线 v${ANCHOR_BASELINE_VERSION}（官方可能已改行为）—— 自动核对 ${ANCHORS.length} 个锚点…`);
	const scan = scanAnchors(null);
	if (!scan) { report("⚠", `锚点基线: 自动核对无结果（子包目录不可解析），请 --verify-anchors 人工核对`); return; }
	let bad = 0;
	for (const r of scan.results) {
		if (r.ok) { report("✓", `锚点仍在（${r.where}）: ${r.name}`); }
		else { bad++; report("✗", `锚点缺失: ${r.name} —— 依赖它的检查 ${r.dependsOn.join("、")} 的结论已不可信`); }
	}
	if (bad > 0) {
		report("✗", `锚点基线: ${bad}/${ANCHORS.length} 锚点缺失 —— 本工具检测逻辑已与当前 dsh 脱节；请人工核对官方源码并同步更新本工具，勿再依据 #6/#7/#9/#14 的旧结论`);
	} else {
		report("✓", `锚点基线: 版本漂移但 ${ANCHORS.length} 个锚点全部仍在，检测逻辑仍有效（建议确认官方版本间无行为变化）`);
	}
}

/**
 * `--verify-anchors [<dir>]`：核对检测依赖的官方行为锚点是否仍与"用户实际安装的 dsh"
 * 一致。默认用 `findInstallAnchor()` 定位到的本机 dsh 安装，并检查其**编译产物**（lib/*.js）
 * ——因为 dsh-doctor 跑的时候就是解析这套 node_modules，源码与实际运行行为必须一致。
 * 也可显式传一个目录（源码仓库或安装目录）作覆盖。
 *
 * 为什么查产物而非源码：他人通过 npm 装的是编译后的 lib/，与 github 源码可能版本/补丁
 * 不一致；只看仓库源码等于验证了用户没在跑的那份。这里对齐"用户跑的版本"。
 *
 * @param dirArg - 可选；缺省为 findInstallAnchor() 得到的安装。
 */
function verifyAnchors(dirArg) {
	// 1. 决定要核对的目标。**显式指定时只看该目录，绝不回退到本机安装**——
	//    否则会让"故意删除锚点的测试目录"被本机 dsh 掩盖，验了个寂寞。
	let targetDesc;
	if (dirArg) {
		if (!existsSync(dirArg)) {
			console.log(`✗ 目录不存在: ${dirArg}`);
			process.exit(1);
		}
		targetDesc = dirArg;
	} else {
		const installAnchor = findInstallAnchor();
		if (!installAnchor) {
			console.log("✗ 找不到 dsh 安装；需显式传 `--verify-anchors <目录>`（dsh 安装或源码仓库）");
			process.exit(1);
		}
		targetDesc = dirname(installAnchor);
	}
	console.log(`🔎 核对锚点于: ${targetDesc}` + (dirArg ? "（显式指定）" : "（本机 dsh 安装）"));

	// 2. 扫描锚点（共享实现）
	const scan = scanAnchors(dirArg);
	let ok = 0, bad = 0;
	for (const r of scan.results) {
		if (r.ok) { ok++; console.log(`  ✓ 锚点仍在（${r.where}）: ${r.name}`); }
		else {
			bad++;
			console.log(`  ✗ 锚点缺失: ${r.name}\n    在 session/tools/boot 的 lib 与 src 均未命中 —— 依赖它的检查 ${r.dependsOn.join("、")} 的结论已不可信，请人工核对对应检测是否仍对齐实际安装版本。`);
		}
	}
	console.log(`\n========== 锚点核对: ${ok} ✓ / ${bad} ✗ ==========`);
	console.log(`（基线版本 ${ANCHOR_BASELINE_VERSION}；若本机 dsh 已升级到其它版本，锚点缺失属预期，需同步更新本工具）`);
	process.exit(bad > 0 ? 1 : 0);
}

/**
 * `--check-update`：在线对比 npm registry 的 @deepseek-ai/dsh 最新版本与本机安装。
 *
 * 防漂移第 3 道闸：回答"本地二进制 vs 官方"谁新。npm registry 是官方发布渠道
 * （比 GitHub master 更贴近用户实际会装的版本），零依赖（Node 18+ 内置 fetch）。
 * 网络不可用 / registry 被墙时降级为提示，不视为失败。
 *
 * 输出：
 *   - 本机 < 最新 → 提示可升级（附命令）；
 *   - 本机 == 最新 → ✓ 已是最新（锚点基线若落后会在常规检查里另行提示）；
 *   - 本机 > 最新（本地装过预发布/自建）→ 提示与官方版本漂移。
 */
async function checkUpdate() {
	const anchor = findInstallAnchor();
	const localVer = anchor
		? (() => { try { return JSON.parse(readFileSync(anchor, "utf-8")).version ?? "?"; } catch { return "?"; } })()
		: null;
	console.log(`🔎 对比 @deepseek-ai/dsh：本机 ${localVer ?? "（未找到安装）"} vs npm registry …`);
	// 用 node:https 而非 fetch：node:https 默认不 keep-alive，连接用完即关，
	// process.exit 不会触发 Windows 上 fetch 的 UV_HANDLE_CLOSING 断言。
	const latest = await new Promise((resolve) => {
		const req = httpsGet("https://registry.npmjs.org/@deepseek-ai/dsh/latest", { timeout: 10000 }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => {
				try { resolve(JSON.parse(body).version); }
				catch { resolve(null); }
			});
		});
		req.on("timeout", () => { req.destroy(); resolve(null); });
		req.on("error", () => resolve(null));
	});
	if (latest == null) {
		console.log("  ⚠ 无法访问 npm registry —— 若浏览器能上 npm 而命令行不能，多半是代理/DNS 问题；不影响离线检查");
		return;
	}
	if (!localVer) {
		console.log(`  ✓ 官方最新: v${latest}（本机未发现安装，无从比较）`);
		return;
	}
	const cmp = compareVersions(localVer, latest);
	if (cmp < 0) {
		console.log(`  ⚠ 本机 v${localVer} < 官方最新 v${latest} —— 建议升级: npm i -g @deepseek-ai/dsh@latest（升级后请跑 --verify-anchors 核对检测锚点）`);
	} else if (cmp === 0) {
		console.log(`  ✓ 本机 v${localVer} == 官方最新 v${latest}（已是最新）`);
	} else {
		console.log(`  ⚠ 本机 v${localVer} > 官方最新 v${latest}（本地装了官方未发布的预发布/自建版本，与官方仓库漂移；--verify-anchors 以本机安装为准）`);
	}
}

/**
 * 语义化版本比较（仅处理 doctor 场景：rc 预发布 vs 正式版，以及 x.y.z 数字段）。
 * 返回 <0 / 0 / >0。预发布按"rc.N 低于同号正式版"处理：0.1.0-rc.6 < 0.1.0。
 */
function compareVersions(a, b) {
	const parse = (v) => {
		const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(rc\.)?(\d+))?/);
		if (!m) return null;
		// 无 -rc 后缀 → 正式版，rc 段视为 +Infinity（任何 rc.N 都低于同号正式版）
		return { major: +m[1], minor: +m[2], patch: +m[3], rc: m[4] ? +m[5] : Number.POSITIVE_INFINITY };
	};
	const pa = parse(a), pb = parse(b);
	if (!pa || !pb) return String(a).localeCompare(String(b)); // 解析失败退回字符串比较
	for (const k of ["major", "minor", "patch"]) {
		if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
	}
	// 数字段全等：比较 rc（Infinity 表示正式版）
	if (pa.rc === pb.rc) return 0;
	return pa.rc > pb.rc ? 1 : -1;
}

// ---- main ----

// --verify-anchors：核对检测结论是否仍与"用户实际安装的 dsh"一致（先于任何 profile 检查）
if (verifyAnchorsIdx !== -1) {
	verifyAnchors(verifyAnchorsDir);
}

// --check-update：在线对比 npm registry 最新版（防漂移第 3 道闸）。
// node:https 连接用完即关，可直接 process.exit（无 fetch 的句柄残留问题）。
if (checkUpdateIdx !== -1) {
	await checkUpdate();
	process.exit(0);
}

// --session 模式：扫单个会话文件（#1544/#1363 悬空 tool_call + #1497 族 seq 完整性）
// 加 --fix 时先诊断、再原子修复 seq 类损坏、最后复检。
if (sessionArg) {
	const sp = sessionArg;
	if (!existsSync(sp)) {
		console.log(`✗ 会话文件不存在: ${sp}`);
		process.exit(1);
	}
	console.log("📼 session: " + sp);
	const display = basename(sp).replace(/\.jsonl\.zstd$/, "").slice(-24);
	checkSessionOrphanToolCalls(sp, display);
	checkSessionSeqIntegrity(sp, display);
	if (fixMode) {
		console.log("\n🔧 修复模式: 重排 seq + 重映射引用（备份 → 临时文件 → 校验 → 替换）");
		if (repairSessionLog(sp)) {
			// 复检：清空统计只看修复后的 seq 完整性
			pass = 0; fail = 0; warn = 0;
			checkSessionSeqIntegrity(sp, display + "（修复后）");
		}
	}
	console.log(`\n========== 结果: ${pass} ✓ / ${warn} ⚠ / ${fail} ✗ ==========`);
	process.exit(fail > 0 ? 1 : 0);
}

console.log(`🔍 dsh-doctor — 检查 ${profilesRoot}`);

if (!existsSync(profilesRoot)) {
	console.log("✗ 未找到 .dsh/profiles 目录");
	process.exit(1);
}

const profiles = readdirSync(profilesRoot)
	.filter((p) => existsSync(join(profilesRoot, p, "package.json")))
	.filter((p) => !onlyProfile || p === onlyProfile);

for (const p of profiles) checkProfile(join(profilesRoot, p));

console.log("\n📌 全局检查（独立于 profile）");

// 防漂移第 1 道闸：锚点基线（本机 dsh 版本 vs 锚点基线，不一致自动扫描）
checkAnchorBaseline();

// 额外：TUI profile 的超宽行崩溃补丁完整性（不属于 profile 清单检查，单独跑）
checkTuiPatch();

// 额外：Windows 沙箱 schannel TLS 探测（#1789，独立于 profile）
checkSandboxTls();

// 额外：skill frontmatter 冒号陷阱（#1401/#936）
checkSkillFrontmatter();

// 额外：Windows 端口排除段（#1462，独立于 profile）
checkExcludedPorts();

// 额外：PATH 工具可用性（#1270/#1772）
checkPathTools();

console.log(`\n========== 结果: ${pass} ✓ / ${warn} ⚠ / ${fail} ✗ ==========`);

// ---- --fix 执行 ----
if (fixMode) {
	console.log("\n🔧 --fix 模式下执行的可自动修复项：");
	if (fixableFileLinks.length === 0 && fixableTuiPatches.length === 0) {
		console.log("  · 无可自动修复项。");
	}
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
	for (const { file } of fixableTuiPatches) {
		console.log(`  · 重打 TUI 超宽行补丁: ${file}`);
		try {
			if (applyTuiPatch(file)) {
				fixed.push("pi-tui 补丁");
				console.log(`    ✓ 补丁已重打（原文件备份为 .bak）`);
			} else {
				console.log(`    ⚠ 补丁结构不匹配（import 行或 throw 行已变），未改动；请人工核对 ${file}`);
			}
		} catch (e) {
			console.log(`    ✗ 打补丁失败: ${e.message}`);
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
