# Changelog

All notable changes to dsh-doctor. Format follows [Keep a Changelog](https://keepachangelog.com/), versions match the npm `version` field.

## [0.4.1] - 2026-08-16

### Fixed
- **Check 14（会话日志 seq 完整性）误报修复：按 rc.6 chunk-row 展开语义核对.**
  rc.6 起 dsh 把连续的 `assistant/chunk` 增量事件打包成一行存储行
  （`text-chunks` / `reasoning-chunks` / `tool-call-chunks`，见
  `@deepseek-ai/dsh-session` 的 `chunk-rows.js`），loader 的 seq 连续性校验
  （`SessionLogScanner.consumeEventLine`）是在**展开后的事件流**上做的。旧检查
  逐行按 `seq` 判断，把含打包行的健康日志误报为 seq 空洞（实测一个健康会话
  518 行打包行 → 误报 92 处）。现新增 `expandStorageRow()`（镜像
  `decodeStorageRecord` 的零依赖纯 Node 实现）：普通行原样返回；打包行严格校验
  envelope（`{type, seq0, time0, data}`）与 data 形状后展开成 `seq0+k` 事件序列；
  malformed 打包行 fail-loud 报「会话损坏行」——与 loader 一致，绝不静默跳过。
- 测试套件新增 T14b（chunk-row 展开）：合法打包行展开后 seq 连续不误报；
  dt 长度不匹配 / envelope 缺字段均报损坏行。

## [0.4.0] - 2026-08-15

### Added
- **Check 10: TUI 超宽行崩溃补丁完整性.** `@earendil-works/pi-tui` 在渲染超宽行时
  `throw new Error(errorMsg)` 直接杀掉 pi 进程；本 check 检测 `tui-main-screen.js`
  是否仍带该崩溃代码（升级覆盖补丁会被检出），`--fix` 可自动重打补丁
  （截断替代崩溃，原文件备份 `.bak`）。
- **Check 11: `toolkit-plugins` 持久化插件源码完整性.** 区分 `.mjs` 全局工具
  （host 组合加载）与 `host.js`/`client.js` 动态插件源码（重启后 `plugin_deploy`
  恢复的前提）；目录空壳会警告。
- **README「运行时问题处理手册」.** 记录三类非启动问题的处理方法：TUI 超宽行
  崩溃（刷新/`--fix` 重打补丁）、历史 run 卡片渲染崩溃
  `Cannot read properties of undefined (reading 'kind')`（刷新页面/新会话）、
  动态插件重启丢失（`plugin_deploy` 恢复）。

### Fixed
- **Windows 兼容：dsh 安装发现不再用 POSIX 命令.** `command -v dsh` → Windows 用
  `where dsh`；glob 回退从 `ls -d ... | head -1` 改为纯 Node 目录展开
  （`expandFirstGlob`），消除 Windows 下每次运行都喷的 `'command' is not
  recognized` 噪音。
- **`verify-anchors` 的源码扫描从 `grep` 改为纯 Node 递归**（`deepInspectContains`
  + `globToRegExp`）——Windows 无 grep，此前锚点核对在 Windows 上永远全报缺失；
  `lstatSync` 跳过符号链接与 grep -r 不跟随 symlink 的行为一致。
- **测试套件 Windows 兼容**：D9（POSIX shim）与 D12（`command -v` 探测）在
  Windows 自动跳过；新增 T10（TUI 补丁检出 + `--fix` 重打 + 备份 + 复检）与
  T11（toolkit-plugins 的 .mjs 工具 / host.js 插件 / 空壳告警 区分）用例。

## [0.3.2] - 2026-08-15

### Fixed
- **Dual-instance check now catches the same-version `#1486` crash.** `checkDualInstances`
  previously only reported when a profile-hoisted `@deepseek-ai/*` copy's **version
  differed** from the dsh install, so the exact `#1486` failure mode — two **identical-
  version** module copies whose module-local `Symbol` mismatch crashes the tool layer —
  slipped through green. It now flags an independent copy (a real directory, not a
  symlink back to the install) **regardless of version**. Symlinked copies back to the
  dsh install (the normal pnpm `file:` layout) are correctly treated as a single
  instance, and shared libs (`cosmokit`/`schemastery`) are excluded so pnpm-hoisted
  transitive deps don't false-positive.
- **dsh install discovery no longer hard-codes `$HOME/.nvm`.** `findDshInstall`
  resolves the real install from `command -v dsh` (realpath → walk up to the
  `node_modules/@deepseek-ai/dsh` root), covering npx-cache / npm-global / custom
  prefix layouts that the old `.nvm`/pnpm glob silently skipped. Existing glob fallback
  retained for PATH-less shells.

### Added
- Destructive test D12: version-equal independent copy is reported; a symlink back to
  the install is not (runtime component detection). Runs only when a `dsh` is on PATH.

## [0.3.1] - 2026-08-15

### Added
- **`--verify-anchors` (anti-rot guard)**. `dsh-doctor`'s checks mirror specific
  calls in dsh; if the version you run changes one of those behaviors a check can
  silently mis-report. This mode greps the **installed** dsh (compiled
  `node_modules` artifacts — what you actually run, not a source checkout) for the
  tokens each check relies on (5 anchors: the `tool/call` and `tool/result` event
  literals, `ToolResultMessage.callId`, the bundle two-anchor install-first order,
  and the `dsh.bundle.patch` contract) and exits 1 if any vanished — so a behavior
  change surfaces immediately instead of producing a stale verdict.

### Changed
- `--verify-anchors` now takes an **optional** dir. With no argument it checks the
  locally installed dsh (via `$HOME/.nvm .../@deepseek-ai/dsh`); with an argument
  it checks **only that dir** and **never falls back** to the local install. The
  prior version required a source-repo path, which wrongly verified a build the
  user wasn't running (npm users run compiled `lib/`, and the repo can be a
  different version/patch). This closes that gap.
- Destructive test D11 updated to the 5-anchor contract: a complete tree reports
  `5 ✓`; one with `tool/result` removed reports that exact anchor missing. The
  test also proves the explicit-dir mode is independent of the local install.

## [0.3.0] - 2026-08-15

### Added
- **`--session <log>` — dangling-`tool_call` scan (check 9, #1544/#1363)**. Parses a
  session log (`.jsonl.zstd` via `zstd -dc`, or plain `.jsonl`) and pairs every
  `tool/call` id (`packages/core/session/src/types.ts:279`) against its
  `tool/result` (`types.ts:291` `message.source.callId`; `tools/src/index.ts:315`).
  A call whose turn has already produced results but is still unmatched is an
  orphan: it poisons every later model request with
  `400 insufficient tool messages` (#1544/#1363). A dangling call in the latest
  still-active turn is downgraded to a warning (likely an in-flight tool), so
  scanning a live session never false-positives a hard error.
- **Destructive test D10** — a synthetic log with an orphaned call in a completed
  turn is flagged `✗`; an identical log with the matching result is reported
  clean (`✓`), locking in the no-false-positive guarantee for the session check.
- Field in the numbered check table + README section for the `--session` mode.

### Correctness (out of the loop: this check was added from forum feedback)
- The dangling-`tool_call` symptom came straight from community report #1544
  (and its #1363 sibling), demonstrating the "forum → task-1" feedback loop the
  project runs on: a new offline-detectable failure class, confirmed against the
  real session-event schema, turned into a tested check.

## [0.2.0] - 2026-08-15

### Added
- **`dsh.profile.bundles` integrity (check 6)** — flags a bundle listed in
  `package.json` that cannot resolve from the dsh install or the profile dir
  (the persistent boot failure from #917), or that resolves but declares no
  `dsh.bundle.patch` (a profile.ts `resolveBundleDir` throw path).
- **Bundle ↔ user-patch entry-id collision (check 7)** — a `cordis.patch.yml`
  insert reusing a bundle's entry id → `duplicate loader entry id` (#1479), and
  a bundle both in `dsh.profile.bundles` and inserted again by name
  (post-reconcile redundancy, #1404). Directly implements the `dsh doctor` spec
  items (a)+(b) from #1496.
- **`--fix` mode** — auto-relinks `file:` deps whose target exists but is not
  linked into `node_modules` (`pnpm add file:<target>` inside the profile dir).
  Only that reversible repair is automated; everything else is reported with a
  backup-then-edit recipe.
- **`$DSH_HOME` support** — the tool now reads the Harness home from `$DSH_HOME`
  (defaulting to `~/.dsh`), matching dsh's own `resolveDshHome` precedence. This
  lets it be exercised against a throwaway home without touching the live env.
- **Destructive test suite** (`test/destructive.test.mjs`) — 10 assertions that
  each check fires on a broken profile and stays silent on a healthy one.
- **Bare npm-name plugin references** — `extractPluginNames` now also recognizes
  unscoped package names (e.g. `ok-plugin`, `dsh-find-plugin`) in patch inserts,
  eliminating a false "no plugin references" warning.

### Changed
- Bumped to `0.2.0`; README reorganized with a numbered check table mapping each
  check to its discussion/advisory source, a `--fix` section, and a Tests section.

### Security / correctness
- All new detection logic mirrors `packages/boot/app-boot/src/profile.ts`
  (`resolveBundleDir` two-anchor order, `dsh.bundle.patch` contract), so offline
  conclusions match what a real boot would throw.

## [0.1.0] - 2026-08-14

Initial release. Offline pre-boot check for DeepSeek Harness profiles:
dangling plugin references (#1197), broken `file:` links (#1197), duplicate
entry ids (#1404/#1479), dual `@deepseek-ai` instances (#1486), and missing
entry artifacts (#917). Distribution via `npx --yes github:boyin111-1/dsh-doctor`
(no npm publish).
