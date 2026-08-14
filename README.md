# dsh-doctor

Pre-boot health check for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) profiles. Zero dependencies, single file, runs **before** dsh starts — so it works exactly when dsh can't.

## Why

dsh's plugin tree is "fragile by install": a single dangling reference, broken `file:` link, or duplicate entry id can brick the whole profile at boot with an opaque `ERR_MODULE_NOT_FOUND` or `duplicate loader entry id`, and there is no offline diagnostic (`--dump-config` never mounts the loader, so it passes on broken setups).

This class of failure was consolidated in [dsh discussion #1496](https://github.com/deepseek-ai/deepseek-harness/discussions/1496) (Advisory: plugin-install path needs guardrails) from [#1404](https://github.com/deepseek-ai/deepseek-harness/discussions/1404), [#1197](https://github.com/deepseek-ai/deepseek-harness/discussions/1197), [#1486](https://github.com/deepseek-ai/deepseek-harness/discussions/1486), [#1415](https://github.com/deepseek-ai/deepseek-harness/discussions/1415), [#1413](https://github.com/deepseek-ai/deepseek-harness/discussions/1413). `dsh-doctor` is the offline check that advisory calls for.

## Install

```bash
npm install -g dsh-doctor
# or run without installing:
npx dsh-doctor
```

## Usage

```bash
dsh-doctor                # check all profiles
dsh-doctor --profile web  # check only the web profile
dsh-doctor --fix          # (reserved) report auto-fixable items
```

## Checks

| Check | Detects | Related issue |
|---|---|---|
| Plugin resolution | dangling references unresolvable **from the profile dir** (the loader's real anchor) | #1197 |
| `file:` link integrity | dependencies whose `file:` target is missing / not linked in `node_modules` | #1197 |
| Duplicate entry ids | same `id:` across/within `cordis*.yml` → `duplicate loader entry id` boot crash | #1404, #1479 |
| Dual `@deepseek-ai` instances | profile-hoisted copies at different versions than the dsh install | #1486 |
| Dependency presence | declared deps missing from `node_modules` | general |

Resolution checks use `createRequire(<profile>/package.json)` — the **same resolution anchor** the loader uses (`cordis-plugin-loader` imports bare specifiers against `ctx.baseUrl`), so the diagnosis matches what boot would do.

## Example

```
🔍 dsh-doctor — check /home/user/.dsh/profiles

📦 profile: web
  ✓ plugin resolvable: @dsh-user/dev-workbench
  ✗ dangling reference: @ghost-org/never-existed (MODULE_NOT_FOUND)
  ✗ file: link broken: @fake-org/broken-link → file:/tmp/nonexistent-dir/xxx (target missing)
  ✗ duplicate entry id: "same-entry" in cordis.patch.yml and cordis.yml

========== result: 1 ✓ / 0 ⚠ / 2 ✗ ==========
```

## Why not a dsh plugin?

Diagnosis must run *before/outside* the plugin tree — a plugin can't load when the tree is the thing that crashed (chicken-and-egg). Standalone CLI is the only form that works on a bricked profile.

## License

MIT
