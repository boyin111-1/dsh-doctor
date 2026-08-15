# Changelog

All notable changes to dsh-doctor. Format follows [Keep a Changelog](https://keepachangelog.com/), versions match the npm `version` field.

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
