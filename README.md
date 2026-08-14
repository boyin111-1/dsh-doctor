# dsh-doctor

Pre-boot health check for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) profiles. Zero dependencies, single file, runs **before** dsh starts — so it works exactly when dsh can't.

## Why

dsh's plugin tree is "fragile by install": a single dangling reference, broken `file:` link, or duplicate entry id can brick the whole profile at boot with an opaque `ERR_MODULE_NOT_FOUND` or `duplicate loader entry id`, and there is no offline diagnostic (`--dump-config` never mounts the loader, so it passes on broken setups).

This class of failure was consolidated in [dsh discussion #1496](https://github.com/deepseek-ai/deepseek-harness/discussions/1496) (Advisory: plugin-install path needs guardrails) from [#1404](https://github.com/deepseek-ai/deepseek-harness/discussions/1404), [#1197](https://github.com/deepseek-ai/deepseek-harness/discussions/1197), [#1486](https://github.com/deepseek-ai/deepseek-harness/discussions/1486), [#1415](https://github.com/deepseek-ai/deepseek-harness/discussions/1415), [#1413](https://github.com/deepseek-ai/deepseek-harness/discussions/1413). `dsh-doctor` is the offline check that advisory calls for.

## Install / run

No npm publish needed — dsh users already have Node.js, so run it straight from GitHub:

```bash
npx --yes github:boyin111-1/dsh-doctor
```

Or clone and run locally:

```bash
git clone https://github.com/boyin111-1/dsh-doctor
node dsh-doctor/dsh-doctor.mjs
```

## Usage

```bash
dsh-doctor                # check all profiles
dsh-doctor --profile web  # check only the web profile
dsh-doctor --fix          # auto-relink file: deps whose target exists but is not linked
DSH_HOME=/path dsh-doctor # point at a specific Harness home (default ~/.dsh)
```

`dsh-doctor` respects `$DSH_HOME` (default `~/.dsh`) like dsh itself does, so it
never needs to touch a live environment to be exercised — point it at a temp home
to vet a profile before switching to it.

## Checks

| # | Check | Detects | Related issue |
|---|---|---|---|
| 1 | Plugin resolution | dangling references unresolvable **from the profile dir** (the loader's real anchor) | #1197, #880 |
| 2 | `file:` link integrity | dependencies whose `file:` target is missing / not linked in `node_modules` | #1197 |
| 3 | Duplicate entry ids | same `id:` across/within `cordis*.yml` → `duplicate loader entry id` boot crash | #1404, #1479 |
| 4 | Dual `@deepseek-ai` instances | profile-hoisted copies at different versions than the dsh install | #1486 |
| 5 | Entry artifacts | package present in `node_modules` but its `exports["."]/main` file is missing → boot hard-fails | #917, #1413 |
| 6 | `dsh.profile.bundles` integrity | a bundle listed in `package.json` that can't resolve (dangling → permanent boot failure), declares no `dsh.bundle`, or whose patch file is missing | #917 |
| 7 | Bundle ↔ user-patch id collision | a user `cordis.patch.yml` insert reuses a bundle's entry id → `duplicate loader entry id`; or a bundle is both in `dsh.profile.bundles` and inserted again by name (post-`reconcile` redundancy) | #1404, #1479 (advisory item a) |
| 8 | Lockfile `file:` reference | `pnpm-lock.yaml` records a `file:` dep consistent with disk | #1197 |

Checks 6 & 7 mirror `packages/boot/app-boot/src/profile.ts` `resolveBundleDir`
(two-anchor: install package first, then profile dir) and the bundle-manifest
contract (`dsh.bundle.patch`), so their conclusions match what real boot would
throw. They directly implement the `dsh doctor` spec (a)+(b) proposed in
[#1496](https://github.com/deepseek-ai/deepseek-harness/discussions/1496).

Resolution checks use `createRequire(<profile>/package.json)` — the **same resolution anchor** the loader uses (`cordis-plugin-loader` imports bare specifiers against `ctx.baseUrl`), so the diagnosis matches what boot would do.

## `--fix`

`dsh-doctor --fix` auto-executes the **safe** repair for `file:` dependencies whose
target exists but was never linked into `node_modules`: it runs
`pnpm add file:<target>` inside the profile directory. Only that reversible repair
is automated. Everything else is **reported with a backup-then-edit recipe** rather
than silently mutated:

```
cp cordis.patch.yml cordis.patch.yml.bak   # then edit/remove the bad insert
# or remove a residue from dsh.profile.bundles in package.json
```

dsh-doctor never rewrites your live profile without `--fix` being explicit, and even
then only touches broken `file:` links.

## Tests

`node test/destructive.test.mjs` builds throwaway profiles in a temp `$DSH_HOME`
and asserts each check **fires on a broken profile and stays silent on a healthy
one** — the no-false-positive guarantee behind the "real env is all green" check.

```bash
node --check dsh-doctor.mjs          # syntax
node dsh-doctor.mjs                  # real ~/.dsh must be all green
node test/destructive.test.mjs       # 10 destructive assertions
```

## Example

```
🔍 dsh-doctor — check /home/user/.dsh/profiles

📦 profile: web
  ✓ plugin resolvable: @dsh-user/dev-workbench
  ✗ dangling reference: @ghost-org/never-existed (MODULE_NOT_FOUND)
  ✗ file: link broken: @fake-org/broken-link → file:/tmp/nonexistent-dir/xxx (target missing)
  ✗ duplicate entry id: "same-entry" in cordis.patch.yml and cordis.yml
  ✗ dsh.profile.bundles dangling: "@ghost-org/residue" (unresolvable from dsh install & profile)
  ✗ entry id collision: user patch inserts "pet" = @fake/bundle-a's bundle entry id

========== result: 1 ✓ / 0 ⚠ / 4 ✗ ==========
```

## Why not a dsh plugin?

Diagnosis must run *before/outside* the plugin tree — a plugin can't load when the tree is the thing that crashed (chicken-and-egg). Standalone CLI is the only form that works on a bricked profile.

## License

MIT
