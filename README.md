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
dsh-doctor --session <log># scan one session log (.jsonl.zstd / .jsonl) for dangling tool_calls
dsh-doctor --fix          # auto-relink file: deps whose target exists but is not linked
dsh-doctor --verify-anchors           # confirm checks still match YOUR installed dsh
dsh-doctor --verify-anchors <dir>     # ... or a specific dir (source checkout / install)
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
| 4 | Dual `@deepseek-ai` runtime instances | a `dsh-*` package with an **independent copy** (real dir, not a symlink back to the dsh install) hoisted at the profile's top-level `node_modules/@deepseek-ai/` — flagged **regardless of version** (version-equal copies are precisely the #1486 module-local `Symbol` crash); shared libs (`cosmokit`/`schemastery`) excluded | #1486 |
| 5 | Entry artifacts | package present in `node_modules` but its `exports["."]/main` file is missing → boot hard-fails | #917, #1413 |
| 6 | `dsh.profile.bundles` integrity | a bundle listed in `package.json` that can't resolve (dangling → permanent boot failure), declares no `dsh.bundle`, or whose patch file is missing | #917 |
| 7 | Bundle ↔ user-patch id collision | a user `cordis.patch.yml` insert reuses a bundle's entry id → `duplicate loader entry id`; or a bundle is both in `dsh.profile.bundles` and inserted again by name (post-`reconcile` redundancy) | #1404, #1479 (advisory item a) |
| 8 | Lockfile `file:` reference | `pnpm-lock.yaml` records a `file:` dep consistent with disk | #1197 |
| 9 | Dangling `tool_call` (session) | a `tool/call` with no matching `tool/result` (by `message.source.callId`) in a completed turn → every later request rejected with `400 insufficient tool messages` | #1544, #1363 |
| 10 | TUI over-wide-line crash patch | `pi-tui`'s `tui-main-screen.js` still throws (`throw new Error(errorMsg)`) on any rendered line wider than the terminal → kills the whole pi process; `--fix` re-applies the truncate patch (`.bak` backup) | runtime incident |
| 11 | `toolkit-plugins` persistence | `.mjs` global tools (host-composed) vs `host.js`/`client.js` dynamic-plugin sources (the `plugin_deploy` recovery prerequisite); an empty kit dir warns | — |
| 12 | host ↔ profile `@deepseek-ai/*` version drift | a profile-top-level copy of a `dsh-*`/shared package whose version differs from the installed dsh → the module-local `TOOL_RUNTIME_SCHEDULER` Symbol mismatch that crashes **every** tool call with `Cannot read properties of undefined (reading 'prepare')` (or `cannot get property "tools" without inject` for shared libs); fix hint: delete the copy or `pnpm add @deepseek-ai/<pkg>@<installed>` | #1515 |
| 13 | Windows sandbox schannel TLS | probes `curl.exe` HTTPS under the current token; `SEC_E_NO_CREDENTIALS (0x8009030e)` means the ACL-restricted token (workspace-write sandbox) breaks schannel — contradicting the sandbox doc's "network not restricted" claim; workaround: `danger-full-access` for network commands or a non-schannel client (Python/OpenSSL) | #1789 |
| 14 | Session log `seq` integrity (`--session`) | `seq` gaps / duplicates / rewinds in `session.jsonl[.zstd]` — the exact corruptions the loader rejects with `corrupt session log: seq gap in committed region`, from unclean-exit replays, forced compaction, or concurrent writers; reports line numbers + expected/got | #1497, #1469, #1586, #1433, #1452, #1333, #1305, #1287 |
| 15 | Skill frontmatter colon trap | `SKILL.md` frontmatter whose unquoted `description` contains ASCII `": "` → YAML parses it as a nested mapping, the skill is silently dropped from the catalog (only a `logger.warn`); scans `~/.dsh/skills` and preset `skills/`, suggests quoting | #1401, #1450, #936 |
| 16 | Windows excluded port range | parses `netsh interface ipv4 show excludedportrange protocol=tcp`; flags when dsh's default port 3080 falls inside a Hyper-V/WSL2/Docker reserved band (bind fails with EACCES even as admin) and suggests `--port` | #1462 |
| 17 | PATH tool availability | `node`/`pnpm`/`npm`/`zstd` resolvable from PATH — missing `node` silently breaks new-session creation (`env: node: No such file or directory`), missing `pnpm` breaks plugin install | #1270, #1772 |

Checks 6 & 7 mirror `packages/boot/app-boot/src/profile.ts` `resolveBundleDir`
(two-anchor: install package first, then profile dir) and the bundle-manifest
contract (`dsh.bundle.patch`), so their conclusions match what real boot would
throw. They directly implement the `dsh doctor` spec (a)+(b) proposed in
[#1496](https://github.com/deepseek-ai/deepseek-harness/discussions/1496).

Check 9 pairs `tool/call` ids (`packages/core/session/src/types.ts:279`) against
`tool/result` ids (`types.ts:291` `message.source.callId`; `tools/src/index.ts:315`).
A call still unmatched **after** its turn has produced results is an orphan that
poisons every subsequent request (#1544). A dangling call in the **latest still
active** turn is reported as a warning (likely in-flight), not a hard error, so
scanning a live session doesn't false-positive. Read side consumes zstd frames
(`zstd -dc`) or plain JSONL.

Check 12 implements the version-drift check proposed in
[#1515](https://github.com/deepseek-ai/deepseek-harness/discussions/1515): the
`TOOL_RUNTIME_SCHEDULER` symbol in `packages/core/tools/src/index.ts` is a
**non-global** `Symbol` (not `Symbol.for`), so host (rc.5) and profile (rc.6)
copies disagree and `startCall` throws at
`packages/core/agent-loop/src/tool-calls.ts` (`ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare`).
Check 13 surfaces [#1789](https://github.com/deepseek-ai/deepseek-harness/discussions/1789):
the ACL-restricted token from `dsh-sandbox-windows-acl` (`CreateRestrictedToken`,
dwFlags=13) breaks schannel TLS on Windows, which contradicts the sandbox doc's
"reads, network, and process visibility are NOT restricted".

Check 14 mirrors the loader's own contiguity rule
(`packages/core/session-persistence-jsonl/lib/index.js` `SessionLogScanner.consumeEventLine`:
each event's `seq` must equal its index in the log) — the same check that makes
a corrupted session permanently unloadable (#1497/#1469) and, for a single bad
log, can 500 the whole `session.list` sidebar (#1047/#1473). `--session <log>`
now runs both the orphan-`tool_call` scan (check 9) and this seq scan.
Check 15 targets the `parseFrontmatter` failure in
`packages/skills/skill-filesystem` that silently drops a skill when an unquoted
`description` contains ASCII `": "` (#1401/#936). Check 16 reads the Windows
`netsh` excluded-port ranges (Hyper-V/WSL2/Docker NAT bands) that make dsh's
default port 3080 unbindable (#1462). Check 17 probes the same PATH assumptions
dsh's subprocess backend makes (`env node`; #1270/#1772).

The install discovery used by checks 4 & 12 was also fixed to recognize the
npm-global-prefix layout (`<prefix>/node_modules/@deepseek-ai/dsh`, no `lib/`
layer) in addition to the nvm layout — previously a dsh installed that way
silently skipped the dual-instance and drift checks.

## Staying aligned with the dsh you actually run (anti-rot)

`dsh-doctor`'s checks are written to mirror specific calls in dsh. If the
version you run changes one of those behaviors, a check can silently start
mis-reporting. `--verify-anchors` greps the **installed** dsh — the compiled
`node_modules` artifacts you actually run, not a source checkout — for the
source-level tokens each check depends on, and flags any that vanished:

```bash
node dsh-doctor.mjs --verify-anchors          # checks YOUR installed dsh
node dsh-doctor.mjs --verify-anchors <dir>    # checks a specific dir instead
```

Why the compiled install and not the GitHub source: most people install the
npm build (`lib/*.js`), which can differ from the source repo in version or
patch level. Verifying a source repo checks a build the user isn't running;
verifying the installed artifacts matches exactly what `dsh-doctor` resolves
at check time. An explicit dir is checked **alone** (never falls back to the
local install), so a deliberately broken tree is reported broken.

It verifies 5 anchors: the `tool/call` and `tool/result` event literals,
`ToolResultMessage.callId`, the bundle two-anchor (install-first) order, and
the `dsh.bundle.patch` manifest contract. Exit code is 1 when any is missing.

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

## Runtime incident handbook

The checks above are pre-boot. Some failures are **runtime** (dsh is up, but a
page or process misbehaves); they are not boot-blockers, so no check gates on
them. When they happen, here is the playbook — check 10/11 cover their durable
state:

### 1. TUI dies with `Rendered line N exceeds terminal width`

`pi-tui` renders an over-wide line (e.g. a long Chinese line or a base64 blob in
a tool result) and **throws, killing the whole pi process** — mid-turn, which
also aborts the in-flight tool call. The fix replaces the throw with
`truncateToWidth(line, width)`:

```bash
node dsh-doctor.mjs --fix        # detects the missing patch and re-applies it
```

or by hand: patch `profiles/tui/node_modules/@earendil-works/pi-tui/dist/tui-main-screen.js`
(`throw new Error(errorMsg);` → `line = truncateToWidth(line, width);` and add
`truncateToWidth` to the `./utils.js` import). A pi-tui upgrade overwrites the
patch — re-run `--fix` after updates. The running process keeps the old code in
memory, so restart pi after patching.

### 2. A run card fails to render: `Cannot read properties of undefined (reading 'kind')`

Browser-only render crash. After a service restart, stale dynamic-plugin Run
cards in history re-project with incomplete node data (the plugin registry is
process-memory), and the conversation renderer reads `node.xxx.kind` without a
null guard. Harmless — session data is intact, the server is unaffected.
**Refresh the page** (frontend state rebuilds, stale cards stop rendering), or
start a new session if it recurs. Not a plugin bug; a frontend-robustness gap
in the framework.

### 3. Dynamic plugins vanish after a restart

Dynamic Cordis plugins live in process memory — every restart clears them by
design. Sources persisted under `profiles/<profile>/toolkit-plugins/<id>/`
(check 11 verifies them) are re-deployed in one step:

```
plugin_deploy   id=<id>     # any session; reads host.js/client.js → define → run
```

First run of a client half asks for one UI approval; the grant persists for
that version. Full static auto-load is not configurable here (client↔host
communication requires Remote services whose capability set is compile-time).

## Tests

`node test/destructive.test.mjs` builds throwaway profiles in a temp `$DSH_HOME`
and asserts each check **fires on a broken profile and stays silent on a healthy
one** — the no-false-positive guarantee behind the "real env is all green" check.

```bash
node --check dsh-doctor.mjs          # syntax
node dsh-doctor.mjs                  # real ~/.dsh must be all green
node test/destructive.test.mjs       # 20 assertions (D1-D12 + T10/T11, incl. --session orphan + TUI patch + toolkit-plugins)
```

Cross-platform note: the suite runs on Windows too — POSIX-only cases
(D9's shim, D12's `command -v`) auto-skip, and `verify-anchors` uses a pure-Node
recursive scan instead of `grep`.

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
