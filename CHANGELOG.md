# Changelog

All notable changes to dsh-doctor. Format follows [Keep a Changelog](https://keepachangelog.com/), versions match the npm `version` field.

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
