# ADR-022: V1 CI/CD, Pre-Commit Hooks, and Release Automation

| Field | Value |
| --- | --- |
| **Status** | `accepted` |
| **Type** | `Type 1 (two-way door)` — see [Reversibility](#reversibility-assessment) for axis-by-axis time-fuse |
| **Domain** | Engineering: CI/CD, Pre-Commit, Release Automation, Supply-Chain, Code-Signing |
| **Date** | 2026-04-26 |
| **Author(s)** | Claude Opus 4.7 (AI-assisted, primary-source-cited research per AGENTS.md) |
| **Reviewers** | Sawmon (project maintainer) |

---

## Context

Every code-execution PR, from [Plan-001](../plans/001-session-core.md) Phase 1 on, lands through one engineering-side CI/CD, pre-commit, and release-automation surface, which this record sets.

The surface has five axes, and they are deeply coupled:

1. **CI workflow architecture** — GitHub Actions job graph, a per-OS matrix on the one Node line, 24.21 or later ([ADR-021 §Decision row 8](021-v1-toolchain-selection.md#decision)), + the Windows-only Rust PTY sidecar ([ADR-018 §Decision item 6](018-windows-v1-tier-and-pty-sidecar.md#decision)), Turborepo remote-cache integration, branch protection.
2. **Pre-commit hook framework + dev-loop** — local hook runner; `lint-staged` shape; `commitlint` + Conventional Commits configuration; engineering-side branch-naming convention disjoint from [Spec-009](../specs/009-gitflow-pr-and-diff-attribution.md)'s product-side `GitHostingAdapter` namespace.
3. **Release automation** — release tooling for the terminal helper's npm platform packages, and a custom release flow for the desktop app's installers and the release manifest of [Spec-023 §Behavior 7b](../specs/023-self-host-secure-defaults.md), which lists each artifact's SHA-256. The app's own updater is `electron-updater` with its stock GitHub provider.
4. **Supply-chain hygiene** — npm provenance, dependency-update bot, secret scanning, pnpm 10 hardening.
5. **Code-signing custody** — macOS signing (a self-signed identity until the Apple Developer certificate exists), Windows signing through SignPath Foundation per [ADR-018 §Decision item 7](018-windows-v1-tier-and-pty-sidecar.md#decision), and the signed Linux package repository.

The five axes converge on a single GitHub-Actions workflow shape: least-privilege permissions per job, `id-token: write` only where npm Trusted Publishing publishes the terminal helper's platform packages, and one long-lived signing secret. This ADR captures all five decisions in one place because their permission-shapes, secret-shapes, and trust-paths must compose.

## Problem Statement

How should V1 ship its engineering CI/CD, pre-commit dev loop, release automation, and code-signing custody — composing into a single GitHub Actions surface — such that every code-execution PR can land, the released artifacts carry the checksums [Spec-023 §7b](../specs/023-self-host-secure-defaults.md) and the app's updater check, and `secrets.*` holds one long-lived signing secret?

### Trigger

Every code-execution PR, Plan-001 Phase 1 first, lands through these five axes, so they are set as one composed decision, because their permission-shapes, secret-shapes, and trust-paths must compose.

---

## Decision

We adopt the following five-axis configuration.

### Axis 1 — CI Workflow Architecture

**Decision:** A single `.github/workflows/ci.yml` with **two separate matrices** (a per-OS test matrix and a Windows sidecar build matrix, whose `win32-arm64` leg runs on the `windows-11-arm` runner, free on this public repository, and which also builds the service's Windows half, `sidekicks-windows-half.exe`, for x64 and arm64) joined by a `ci-gate` aggregator job; **least-privilege permissions per job** (workflow default `contents: read`); **event-split concurrency** (PR runs cancel-in-progress, integration-branch runs on `develop` and `main` do not); **Turborepo remote cache backed by the GitHub Actions cache** ([`rharkor/caching-for-turbo`](https://github.com/rharkor/caching-for-turbo), HMAC ≥32 bytes via `TURBO_REMOTE_CACHE_SIGNATURE_KEY`), **with every test-executing task non-cacheable** so a cached result can never stand in for a run that did not happen; **native compilation on Windows runners** for the Rust PTY sidecar; **no native-binary reuse across ABIs** — `side-effects-cache=false` in `.npmrc`, not a CI `pnpm rebuild` step, is the primitive that keeps `better-sqlite3` / `pg` bindings matched to the Node and Electron ABIs per ADR-021; **per-package coverage measured on an advisory job** (v8 provider, informational — deliberately absent from `ci-gate`'s `needs`, so a coverage movement cannot block a merge); **a fast pull-request run, slow jobs on a schedule** — a pull request into `develop` runs only the jobs that finish within about ten minutes (typecheck, lint and the package tests, the dead-code and layering checks, and the desktop bundle, smoke, unit, renderer and browser tiers, joined by the endurance and accessibility tiers once the macOS build is complete), while mutation testing, the desktop end-to-end tier and the native prebuild matrix run nightly against `develop` at 2:00 AM Eastern daylight time, on every pull request into `main`, and on a manual run; branch protection requires `ci-gate` on `main` only; `CODEOWNERS` lives at `.github/CODEOWNERS` (canonical search order: `.github/`, root, `docs/`) and names one default owner with no per-path scopes.

**Cache-poisoning and cache-key rules (load-bearing):** `--cache=local:rw,remote:r` rides every `turbo run` invocation in the cache-enabled jobs on `pull_request`, so a fork-originated run can never write the remote cache; the first write happens on a `push` to an integration branch. `remoteCache.signature` is artifact-integrity verification, not a security control — Turborepo says so itself — and the controls that actually defend the cache are GitHub withholding secrets from fork workflows, the read-only `GITHUB_TOKEN` on `pull_request`, and that switch. The shared compiler configs (`tsconfig.base.json`, `tsconfig.node.json`, `eslint.config.mjs`) sit in `globalDependencies`, because a package-relative `inputs` glob never matches above its package directory and a change to them would otherwise move no task hash at all. Neither cache-enabled job carries an `actions:` grant: the caching toolkit authenticates with the runner-injected `ACTIONS_RUNTIME_TOKEN`, never with `GITHUB_TOKEN`, and `actions: write` would permit repo-wide Actions-API writes the merge-ref scoping of cache entries does not contain. The OS is not part of Turborepo's cache key, so the day this axis adds macOS or Windows test legs, a per-OS `globalEnv` discriminator must land with them.

**Mutation testing (informational):** StrykerJS (`@stryker-mutator/core` with `@stryker-mutator/vitest-runner`, configured in `stryker.config.json`) mutates each package's source and runs the package's Vitest tests against the mutants, in `ci.yml`'s mutation jobs. It has no score threshold and sits outside `ci-gate`, so it never holds a merge. It runs only on the nightly run, on pull requests into `main`, and on a manual run. A pull request into `main` mutates only the files it changed and re-tests only the mutants whose code or covering tests changed since the saved results; the nightly run and a manual run mutate every file and save the combined results. StrykerJS has no sharding, so `tools/mutation-shards.mjs` splits each package's files into shards the job matrix runs in parallel.

**macOS runners (load-bearing):** The V1 darwin-x64 runner uses **`macos-15-intel`** — the _last_ x86_64 macOS runner per [`actions/runner-images#13045`](https://github.com/actions/runner-images/issues/13045), supported through August 2027; the `macos-13` label is retired ([`actions/runner-images#13046`](https://github.com/actions/runner-images/issues/13046)). The V1 darwin-arm64 runner uses `macos-15`. Axis 3's release.yml uses the same runners.

**Antithesis (single cross-product matrix `(node × os × sidecar-target)`):** A unified matrix is mechanically simpler — one matrix definition, one set of job names, one fail-fast policy. We have headroom under GitHub's [256-job-per-workflow limit](https://docs.github.com/en/actions/reference/limits). Workflow-level `permissions: write-all` is also simpler than per-job least-privilege.

**Synthesis:** The cross-product confuses two unrelated concerns. (a) Which Node a package runs on is a _package_ concern (`engines.node` per [ADR-021 §Decision row 8](021-v1-toolchain-selection.md#decision)), not a CI matrix dimension; the daemon never runs inside Electron, so there is no second Node to test it under. (b) Which OS we test on is a _workflow_ concern. Cross-multiplying produces matrix legs that pretend to test "Node 24 on macOS arm64" but in reality test the same package binaries with no behavioral delta. The two-matrix split also matches the structural reality that the Rust sidecar build has zero relation to the Node version — it's bytes-on-disk produced before any JS runs. Workflow-level write permissions also negate `id-token: write` job-scoping — per [GitHub's permissions docs](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/controlling-permissions-for-github_token), "all unspecified permissions are set to no access" only when `permissions:` is declared at job level. A broad workflow-level write grant means every job (including third-party action steps) can mint OIDC tokens or push to the repo.

### Axis 2 — Pre-Commit Hook Framework

**Decision:** [**lefthook 2.1.16**](https://github.com/evilmartians/lefthook/releases) (`npm-installer` postinstall-binary variant); `lint-staged.config.mjs` (ESM, per the [lint-staged README](https://github.com/lint-staged/lint-staged)) running the formatter and linter over staged files only — typechecking is a CI concern, because `tsc -b` reads the whole project graph and a staged-file hook cannot bound its cost; `commitlint.config.mjs` extending [`@commitlint/config-conventional`](https://commitlint.js.org/reference/rules.html) with a 10-type `type-enum` (default 11 minus `style` — Prettier enforces formatting) and a `scope-enum` set to warn, so an unlisted scope reports without refusing the commit; engineering-side branch shape `<type>/<topic>` per upstream [Conventional Branch](https://conventional-branch.github.io/), disjoint from [Spec-009](../specs/009-gitflow-pr-and-diff-attribution.md)'s product-side `run/<run-id>/<topic>` namespace via type-prefix.

**Published versions:** lefthook **2.1.16** and commitlint **21.2.3**, against Husky **9.1.7** for the comparison. This decision binds to published versions.

**CI parity (cross-axis with Axis 1):** CI closes the `git commit --no-verify` bypass with explicit full-repo `eslint .` + `prettier --check .` invocations in `.github/workflows/ci.yml` — `lefthook run pre-commit --all-files` would be a no-op in CI, because `lint-staged` reads the git staging index, which is empty in a fresh checkout; the local hook is the diagnostic, CI is the enforcement.

**Antithesis (Husky 9.1.7):** Husky has the larger network effect — default in TypeScript starters (Next.js, t3-stack), 5× weekly downloads, highest AI-assistant familiarity. The 2 kB / no-runtime-deps profile is genuinely small. The Windows `core.hooksPath` issues are not show-stoppers — workarounds exist and are documented.

**Synthesis:** Three V1 facts tip the choice. (1) **Parallel execution out of the box** — parallelism is first-class lefthook config at both hook and group level ([lefthook configuration docs](https://github.com/evilmartians/lefthook/blob/master/docs/configuration.md); the [v2.1.6 `group` docs](https://github.com/evilmartians/lefthook/blob/v2.1.6/docs/configuration/group.md) state a group's `parallel` "executes all jobs in the group simultaneously"), and this repo exercises it as a parallel `screens` group nested under a sequential top-level `lefthook.yml` job list: `lint-staged` runs first and restages what it fixes, then the screens run against the settled index. Husky has no parallel primitive (the hook script body must invoke a parallel runner manually). For an AI-implementer-led project where commit cadence is high, fast local-loop feedback is load-bearing. (2) **No Node startup per hook task** — Husky's hook is shell→`npx <tool>` per task (~200 ms Node startup per task on cold cache); lefthook is a single Go binary. (3) **Cross-platform packaging without `core.hooksPath` Windows fragility** — Husky has four open Windows/pnpm bugs sharing a root cause ([#1574](https://github.com/typicode/husky/issues/1574), [#1576](https://github.com/typicode/husky/issues/1576), [#1387](https://github.com/typicode/husky/issues/1387), [#1398](https://github.com/typicode/husky/issues/1398)) where the `prepare`-script regenerates `.husky/_` and overwrites committed hooks under pnpm + Windows. Lefthook's `npm-installer` does an OS+arch-detected GitHub-release download postinstall, sidestepping the entire class.

### Axis 3 — Release Automation

**Decision:** Two release surfaces, tooled separately, unified by a shared monotonic `version` integer. A tag push releases.

- **Surface 2 (the desktop app and the release manifest, [Spec-023 §7b](../specs/023-self-host-secure-defaults.md)):** A custom workflow builds the installers: the macOS `.dmg` to install and `.zip` for updates (arm64 and x64), NSIS per user on Windows x64 and arm64, AppImage on Linux x64 and arm64, and `.deb` and `.rpm`. Each Windows installer also carries the service's Linux runtime archives for its architecture, with their SHA-256, and `sidekicks-windows-half.exe`. A manifest-assembly script emits the Spec-023 §7b schema (`version`, `released_at`, `artifacts.{platform}.{url, sha256}`), the release's checksum list. The feed is the project's GitHub Releases.

  The app updates through `electron-updater` 6.8.10 as shipped, with nothing of the project's on top: its stock GitHub provider reads the update files `electron-builder` publishes and checks each download's SHA-512 against them, and the operating system's code signature decides the rest on macOS and Windows. Squirrel.Mac takes an update only when it meets the running app's designated requirement, and on Windows `electron-updater` takes an installer only when it is signed by the publisher the running app names. An older release is refused: main keeps the last version seen in `userData/updater-state.json`, and `allowDowngrade` stays off. `autoDownload` and `autoInstallOnAppQuit` are off. A download is a blockmap delta on NSIS, on the macOS zip once a previous update is cached, and on AppImage. The service updates on its own path (`sidekicks self-update`), which checks the downloaded program against the SHA-256 the release's manifest lists for it, and nothing more.

  The `.deb` and `.rpm` packages publish to the project's signed apt and dnf repository, which a package adds on install (`signed-by=/usr/share/keyrings/…`). It is hosted on [Cloudsmith's open-source plan](https://docs.cloudsmith.com/resources/open-source-hosting-policy) ("at least 50GB of artifact data + 200GB of package delivery for free", with an attribution link required) and keeps the last ten versions; older packages stay on GitHub Releases. The project signs no package and no repository itself. Cloudsmith's own per-repository key signs each RPM on upload and the apt and dnf metadata ([Cloudsmith package signing](https://docs.cloudsmith.com/supply-chain-security/signing-keys): "you do not need to manage GPG keys or signing infrastructure yourself"; "RPM packages are signed with a GPG key upon upload"), and a `.deb` is checked through apt's signed `Release` file, as apt does, so the project holds no package or repository signing key; the package that adds the repository ships that public key as its `signed-by` keyring, and a key change follows Debian's archive-keyring dual-sign-during-rotation precedent. A `.deb` or `.rpm` install is the package manager's to update and never runs `electron-updater`'s Debian or RPM updater, which installs with `--allow-unauthenticated` and would bypass the repository's signature.

  Not shipped: Snap and Flatpak (AppImage, `.deb` and `.rpm` already reach every mainstream distribution); 32-bit Windows, which Electron 44 does not publish. Out of scope for one user: the MSI installer, which exists for an organization's deployment tools, and staged rollouts (`stagingPercentage`), which protect a population of users.

- **Surface 3 (Rust sidecar, 2 npm platform packages per [ADR-018 §Decision](./018-windows-v1-tier-and-pty-sidecar.md#decision) item 6):** [`release-please-action@v5`](https://github.com/googleapis/release-please-action) + [manifest mode](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md) over `@ai-sidekicks/pty-sidecar-{win32-x64,win32-arm64}`, published under [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/), whose npm CLI generates npm's own provenance with no `--provenance` flag. Each binary built on its native OS runner (per Axis 1's sidecar-build matrix), packaged into the matching platform package. `release.yml` is `workflow_dispatch`-only until the first release: with no published version yet, a push trigger on the integration branch would open release PRs nobody acts on. The release PR opens against `develop` (`target-branch: develop`), and release tags land on `main` through a `develop` → `main` fast-forward in the publish job. These two and their umbrella `@ai-sidekicks/pty-sidecar` ([Plan-021](../plans/021-rust-pty-sidecar.md) step 12) are the only packages the project publishes to npm: nothing is published for outside developers, and `@ai-sidekicks/contracts`, `@ai-sidekicks/client-sdk` and `@ai-sidekicks/crypto-paseto` stay inside the workspace.

**The npm floor and ADR-021's Node floor (load-bearing):** Trusted Publishing requires npm CLI ≥11.5.1, which ships with Node ≥22.14.0 per [npm docs](https://docs.npmjs.com/trusted-publishers/). [ADR-021 §Decision](021-v1-toolchain-selection.md#decision) row 8 sets Node 24.21 or later for the service and the CLI and makes `>=24.21.0` the packages' `engines.node` floor, which clears both npm ≥11.5.1 and the `better-sqlite3` 13.x Node-API-10 prebuilds. The release CI runs on that line, and the release-CI Node version is independent of `engines.node` for the package being published, so the npm floor never constrains a published package's own floor.

**Antithesis (one tool across all surfaces — semantic-release):** [semantic-release](https://semantic-release.gitbook.io/semantic-release/recipes/ci-configurations/github-actions) ships first-class npm-provenance and `id-token: write`. Unifying tooling across surfaces would simplify cognitive load.

**Antithesis (changesets):** [changesets](https://github.com/changesets/changesets) is the modern npm-monorepo standard with independent + fixed-package release modes.

**Synthesis:** semantic-release is rejected because its monorepo story is weaker than `release-please`'s manifest mode for handling Surface 3's packages with per-package overrides. changesets is rejected because [`changesets/action` issue #515](https://github.com/changesets/action/issues/515) documents an open conflation: the action runs version-PR-creation and publish in a single workflow, but OIDC requires a dedicated publish-only workflow file registered with npmjs.com. Adopting changesets means owning the issue-#515 workaround until upstream resolves. `release-please-action`'s native two-step pattern (release-PR job + downstream `if: ${{ steps.release.outputs.release_created }}` publish job) aligns with OIDC out of the box. Surface 2 is neither tool's: its release manifest (Spec-023 §7b) comes from the manifest-assembly script in a custom workflow.

### Axis 4 — Supply-Chain Hygiene

**Decision (4 sub-axes):**

1. **npm provenance** — [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) per package; no explicit `--provenance` flag (auto-generated under Trusted Publishing per [npm provenance docs](https://docs.npmjs.com/generating-provenance-statements/)).
2. **Dependency updates** — [Renovate](https://docs.renovatebot.com/) primary, with no release-age setting of its own: a new release waits pnpm's one-day default (pnpm 10 hardening, below); [Socket.dev](https://docs.socket.dev/docs/socket-for-github) GitHub App as adjunct for PR-time malicious-version analysis (`shai-hulud-scan` family detectors). Dependabot deferred (lacks first-class minimum-release-age).
3. **Secret scanning** — GitHub native secret scanning + push protection (free in public repos per [GitHub Advanced Security overview](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security)) + [Gitleaks v8.30.1](https://github.com/gitleaks/gitleaks) (MIT) as pre-commit + CI-side adjunct. **Version v8.30.1** pinned in [`.github/workflows/gitleaks.yml`](../../.github/workflows/gitleaks.yml) (`env.GITLEAKS_VERSION` honored by `gitleaks-action@v2.3.9` per [`src/index.js`](https://github.com/gitleaks/gitleaks-action/blob/v2.3.9/src/index.js)), the authoritative gate; the local hook runs the gitleaks the developer installed per [CONTRIBUTING.md §Hooks](../../CONTRIBUTING.md#hooks). **Canonical config schema:** singular `[allowlist]` block — chosen over plural `[[allowlists]]` (introduced in [v8.25.0](https://github.com/gitleaks/gitleaks/releases/tag/v8.25.0)) for cross-version compatibility and audit traceability; plural-form migration is deferred to the next gitleaks major version bump. [TruffleHog](https://github.com/trufflesecurity/trufflehog) declined — AGPL-3.0 license conflicts with [ADR-019](019-v1-deployment-model-and-oss-license.md) Apache-2.0 stance for downstream self-hosters.
4. **pnpm 10 hardening** — `minimumReleaseAge: 1440` (1 day) AND `blockExoticSubdeps: true` in `pnpm-workspace.yaml` from V1 day 1, opting into [pnpm 11's defaults](https://github.com/pnpm/pnpm/releases) ahead of the upgrade. A fix needed now is named in `minimumReleaseAgeExclude`.

**Antithesis (single bot — Dependabot only):** "Two PR-author bots is twice the noise. Dependabot is GitHub-native and zero-config."

**Synthesis:** In the post-Shai-Hulud era — [Unit 42](https://unit42.paloaltonetworks.com/npm-supply-chain-attack/) confirmed 1700+ packages affected across four waves Sept 2025 → Feb 2026; [CISA issued a widespread-supply-chain-compromise alert 2025-09-23](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem) — release cooldown is the controlling defense for transitive package compromise. Dependabot does not provide minimum-release-age; the "zero-config" framing trades a real defense for an aesthetic preference. Socket.dev adds runtime analysis Renovate cannot do. Renovate (release cadence + catalog-awareness) and Socket.dev (PR-time malicious-version detection) cover orthogonal failure modes, not redundant ones.

### Axis 5 — Code-Signing Custody

**Decision (4 sub-axes):**

1. **macOS** — Until the Apple Developer certificate exists, every macOS build is signed with the project's own self-signed code-signing identity, held as a release secret, with the same bundle identifier on every build. Squirrel.Mac accepts an update only when it satisfies the running app's designated requirement; a self-signed identity's requirement names the certificate, which every later build meets, while an ad-hoc signature's is a `cdhash` only that exact build meets. So one-press update works, and the keychain and privacy permissions, which follow the designated requirement, stay granted across updates. The first launch still asks the person to open the app from Finder's menu, because the app is not notarized; that prompt, and nothing else in the update path, waits on the certificate. The identity is the one long-lived signing secret in `secrets.*`. When the certificate exists: [Apple Developer Program Individual ($99/yr)](https://developer.apple.com/programs/enroll/) under the named project maintainer, App Store Connect API key (`.p8` + key ID + issuer ID) in GitHub Actions Secrets, Developer ID Application signing + [`xcrun notarytool submit --wait`](https://github.com/electron/notarize), and the self-signed identity retires. Organization enrollment waits with it (it also requires legal-entity formation + D-U-N-S; Apple's transferability flow handles re-keying without invalidating prior-signed binaries).
2. **Windows** — [SignPath Foundation](https://signpath.org)'s free open-source program, per [ADR-018 §Decision item 7](018-windows-v1-tier-and-pty-sidecar.md#decision). The release workflow applies for it and submits the Electron app, the sidecar's Windows binaries and `sidekicks-windows-half.exe` to one signing step. "The code signing certificate is issued to SignPath Foundation" ([signpath.org/terms](https://signpath.org/terms)), which holds the key, so Windows names SignPath Foundation as the publisher, and one publisher pools SmartScreen reputation across every Windows binary ([ADR-018 §Decision item 8](018-windows-v1-tier-and-pty-sidecar.md#decision)). If SignPath finds the project ineligible, the choice goes back to the person and nothing in this axis changes silently. **OV or EV is not the lever**: Microsoft's [SmartScreen reputation documentation](https://learn.microsoft.com/en-us/windows/security/threat-protection/microsoft-defender-smartscreen/smartscreen-reputation) (updated 2026-08-17) says of the EV bypass that "this behavior no longer exists".
3. **Linux and npm** — the AppImage updates through `electron-updater`'s SHA-512 check (Axis 3 Surface 2). The `.deb` and `.rpm` packages are covered by the signed apt and dnf repository (Axis 3 Surface 2). The sidecar's npm platform packages carry npm's own provenance through Trusted Publishing (Axis 3 Surface 3).
4. **Rotation procedure** — `CODEOWNERS` carries a single default owner and no per-path scope, so nothing in the repository enforces a separate reviewer for `.github/workflows/release.yml`; with one maintainer, a per-path rule would name the same person twice. Per-path scoping is what a second maintainer buys, and it lands with them.

---

## Alternatives Considered

Per Type 1 treatment, alternatives are listed with brief rejection rationales. Per-option steel-mans appear inline above where load-bearing.

### Axis 1 alternatives

- **Single cross-product matrix `(node × os × sidecar-target)`** (rejected — confuses package-level Node tier with workflow-level OS axis; produces matrix legs with no behavioral delta).
- **`cross-rs/cross` for the Windows sidecar targets** (rejected — [`cross-rs/cross`](https://github.com/cross-rs/cross) explicitly states "MSVC and Apple Darwin targets, which we cannot ship pre-built images of", so the two `*-pc-windows-msvc` targets get no image; the native Windows runners build them).
- **Workflow-level `permissions: write-all`** (rejected — broad write grant means every job can mint OIDC tokens; violates least-privilege).
- **Vercel hosted Turborepo Remote Cache** (rejected on the relicensing risk [ADR-021 §Decision row 2](021-v1-toolchain-selection.md#decision) names — a GitHub-Actions-cache artifact is not held by a vendor who can relicense the service out from under it).
- **Cache `node_modules/**/\*.node` artifacts\*\* (rejected — silently masks ADR-021's two-ABI binding assumption).
- **Enumerate every matrix-leg name in branch protection** (rejected — matrix-leg names embed strategy values; renaming or adding a leg silently bypasses protection per [GitHub Community Discussion #26822](https://github.com/orgs/community/discussions/26822)).

### Axis 2 alternatives

- **[Husky 9.1.7](https://typicode.github.io/husky/)** (rejected — no parallel primitive, ~200 ms Node startup per task on cold cache, four open Windows/pnpm bugs sharing the same root cause).
- **[simple-git-hooks 2.13.1](https://github.com/toplenboren/simple-git-hooks)** (rejected — no documented monorepo or parallel-hook support).
- **[`pre-commit` 4.6.0 (Python)](https://pre-commit.com/)** (rejected — Python `>=3.10` interpreter prerequisite is a separate install path on Windows; per-machine Python version skew becomes a CI-vs-local divergence vector; refuses to install if `core.hooksPath` is set per [pre-commit's `install_uninstall.py`](https://github.com/pre-commit/pre-commit/blob/main/pre_commit/commands/install_uninstall.py)).
- **All-11 `type-enum` (keep `style`)** (rejected — Prettier auto-applies via lint-staged; a "pure formatting" commit shouldn't exist in the V1 workflow; `chore(format): ...` is sufficient).

### Axis 3 alternatives

- **[semantic-release](https://semantic-release.gitbook.io/semantic-release/recipes/ci-configurations/github-actions)** for all surfaces (rejected — monorepo story weaker than `release-please` manifest mode; cannot emit Spec-023 §7b's graph-aware manifest schema).
- **[changesets](https://github.com/changesets/action) for npm packages** (rejected — [`changesets/action#515`](https://github.com/changesets/action/issues/515) conflates version-PR and publish into one workflow; OIDC requires dedicated publish-only workflow file).
- **Publish sidecar via GitHub Releases instead of npm** (rejected — [ADR-018 §Decision item 6](018-windows-v1-tier-and-pty-sidecar.md#decision) commits to the `@esbuild/*` distribution pattern).

### Axis 4 alternatives

- **Token-based npm publish + manual `--provenance` flag** (rejected — long-lived `NPM_TOKEN` extends credential surface; Trusted Publishing strictly dominates after [GA 2025-07-31](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)).
- **Dependabot only** (rejected — no first-class minimum-release-age; insufficient defense against post-publish-malicious-version compromise families).
- **TruffleHog v3.95+** (rejected — AGPL-3.0 license raises legal-review friction with downstream self-hosters; revisit if false-positive rate becomes operationally painful).
- **pnpm 10 defaults (`minimumReleaseAge: 0`, `blockExoticSubdeps: false`)** (rejected — forfeits documented attack surface that pnpm itself names as the top supply-chain hardening).

### Axis 5 alternatives

- **Apple Developer Program Organization enrollment** (not adopted — requires D-U-N-S + legal-entity formation, and waits with the Apple certificate itself. Apple's transferability flow handles eventual upgrade without invalidating prior-signed binaries).
- **Self-signed publisher certificate (Windows)** (rejected — Microsoft SmartScreen page classifies as "strong block — same behavior as unsigned").
- **Ad-hoc signing on macOS** (rejected — an ad-hoc signature's designated requirement is a `cdhash` only that exact build meets, so Squirrel.Mac refuses every update).
- **Azure Artifact Signing, or a bought OV or EV certificate (Windows)** (not adopted — each costs money every year, and SignPath Foundation's free open-source program signs the same binaries; a bought certificate is one of the paths the person is offered if SignPath finds the project ineligible).
- **Microsoft Store distribution** (not adopted — SignPath signing keeps the NSIS installer's own one-press update; the Store is one of the paths the person is offered if SignPath finds the project ineligible).

---

## Failure Mode Analysis

| # | Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- | --- |
| **F-1** | **Trivy-style PAT theft via `pull_request_target` (axis 4 / axis 5).** Per the [Trivy 2026-03 incident](https://github.com/aquasecurity/trivy/discussions/10462), a `pull_request_target` workflow exploited to steal a PAT, the stolen credential later shipping a credential stealer through the vendor's own release workflow and action tags. | Low–Medium | Critical | npm `audit signatures` failure on published version; GitHub Audit Log shows PAT use from anomalous IP. | **No long-lived secrets in `secrets.*`** for signing operations. OIDC-only access to Trusted Publishing. `pull_request_target` workflows scoped to `permissions: read-all`. CI workflows sit under `CODEOWNERS`, which names one default owner; a dedicated security owner for them arrives with a second maintainer. |
| **F-2** | **Shai-Hulud-class transitive compromise (axis 4).** [Unit 42 documented 1700+ packages affected Sept 2025 → Feb 2026](https://unit42.paloaltonetworks.com/npm-supply-chain-attack/) across four waves; transitive deps silently switch to malicious versions. | Medium (active threat) | High | pnpm's `minimumReleaseAge` holds back a version published within the day; Socket.dev `shai-hulud-scan` flags PR; `pnpm install` fails with `blockExoticSubdeps: true` if a transitive switches to git-tarball URL. | **`minimumReleaseAge: 1440` + `blockExoticSubdeps: true`** in `pnpm-workspace.yaml` from V1 day 1. Socket.dev GitHub App for PR-time malicious-version analysis. `minimumReleaseAgeExclude` runbook for emergency CVE patches. |
| **F-3** | **SignPath Foundation finds the project ineligible, or withdraws it (axis 5).** Windows installers would then carry no signature, and SmartScreen blocks an unsigned file at install. | Low | Medium | SignPath's answer to the release workflow's application; a failed signing step in the release run. | The choice goes back to the person with the remaining paths (the Microsoft Store, a bought certificate, or unsigned with SmartScreen's block) per [ADR-018 §Failure Mode Analysis](018-windows-v1-tier-and-pty-sidecar.md#failure-mode-analysis); nothing in the release workflow changes until they choose. Certificate class is not the lever — reputation accrues by publisher and file hash for OV and EV alike. |
| **F-4** | **A runner label is retired (axis 1, 3).** GitHub retires runner labels, as it retired `macos-13` per [`actions/runner-images#13046`](https://github.com/actions/runner-images/issues/13046). Workflows referencing a retired label fail at job start. | Medium | Medium (build outage) | Workflow logs show "this image is deprecated"; jobs fail to schedule. | **`macos-15-intel` is the V1 darwin-x64 runner** (last x86_64 macOS runner per [`actions/runner-images#13045`](https://github.com/actions/runner-images/issues/13045), supported through August 2027). Re-evaluate when `macos-15-intel` deprecation lands. |
| **F-5** | **npm Trusted Publishing per-package config drift (axis 3, 4).** Adding a new published package without registering its Trusted Publisher entry fails at publish time. | Medium (process) | Low (loud failure) | `npm publish` exits non-zero with auth error; workflow log clearly attributes to missing trusted-publisher config. | Failure-loud is the right default. Onboarding doc names "register Trusted Publisher before first publish." Bootstrap path: each package must be published once under a **granular access token** _before_ Trusted Publisher can be configured (npm bootstrap chicken-and-egg). Classic npm tokens were permanently revoked in November–December 2025, and granular write tokens carry a 90-day maximum lifetime, so the bootstrap credential is minted for the ceremony and never held. |
| **F-6** | **Husky-class hook regeneration overwrites committed config (axis 2 — N/A under chosen design).** Listed for completeness: [#1574](https://github.com/typicode/husky/issues/1574) / [#1576](https://github.com/typicode/husky/issues/1576) / [#1387](https://github.com/typicode/husky/issues/1387) / [#1398](https://github.com/typicode/husky/issues/1398) describe `pnpm install` regenerating `.husky/_` and overwriting committed hooks. | N/A under lefthook | Would be Medium | Diff on `.husky/_` after `pnpm install`. | **Mitigation by tool choice** — lefthook does not use the `prepare`-script-regenerates-`.husky/_` pattern. Trigger detection only if we ever migrate back to Husky. |
| **F-7** | **Two-ABI native rebuild silent failure (axis 1).** Cached `.node` artifacts could compile against one ABI yesterday and become invalid today after a transitive NAPI bump; the daemon loads an incompatible native binary at runtime. | Low–Medium | High | A wrong-ABI binding surfaces as `Module did not self-register` at daemon start; `prebuild-install` failures surface as cryptic `node-gyp` rebuild errors during install. | **No native-binary cache** — `side-effects-cache=false` in `.npmrc` forces `prebuild-install` to re-run per `node_modules` tree on every CI run on every OS, so each job picks the prebuild matching its own ABI. An explicit CI `pnpm rebuild` step does not close this and is deliberately absent: `pnpm rebuild` does not bypass the side-effects cache ([pnpm/pnpm#5002](https://github.com/pnpm/pnpm/issues/5002), open), so the `.npmrc` flag is the only primitive that works. |
| **F-8** | **release-please-action breaking change (axis 3).** Major-version bump to v6+ could break manifest-mode behavior or change release-PR shape. | Low | Medium | CI workflow fails after Renovate auto-bumps action version; release PRs stop opening. | Pin to `@v5` major version (not `@latest`); Renovate config excludes major-version bumps from automerge for release-tooling actions. |

---

## Reversibility Assessment

ADR-022 is **Type 1 (two-way door) until the first signed release** because, before it:

- No signed binary has shipped to anyone;
- No npm package is published under any release-tool's tag scheme;
- No install takes updates from the release feed;
- Configuration changes to `.github/workflows/*.yml`, `lefthook.yml`, `commitlint.config.mjs`, `release-please-config.json`, `pnpm-workspace.yaml` are reversible in a single PR.

### Per-axis time-fuse

The five axes have different reversibility profiles, and **axes 3 and 5 flip from Type 1 to Type 2 the moment V1 ships its first signed release.**

| Axis | Reversibility today (Type 1) | Time-fuse to Type 2 | Migration path if reversed |
| --- | --- | --- | --- |
| **1 — CI workflow** | Hours (rewrite `ci.yml` + branch-protection rule) | Stays Type 1 — workflow surgery is always reversible. | Replace `.github/workflows/*.yml`; update branch-protection rules; ensure `ci-gate` semantics preserved. |
| **2 — Pre-commit** | Hours (swap `lefthook.yml` for `husky.config`; update onboarding doc) | Stays Type 1 — local dev tooling, no installed-user impact. | Migrate to Husky (or other) by adding `prepare` script + per-hook shell script; commit lock-file changes. |
| **3 — Release automation** | Days now; **flips to Type 2 after first signed release** — replacing the release-tool means keeping installed apps on an update feed they read. | First signed Spec-023 §7b release. | Pre-flip: rewrite workflow + manifest assembly. Post-flip: the new feed reaches installed apps only through a release they take from the current one. |
| **4 — Supply-chain** | Hours–days (config-only change in `renovate.json`, `pnpm-workspace.yaml`, action versions) | Stays Type 1 — supply-chain hygiene is policy, reversible by config. | Replace bot configs; update `.gitleaks.toml`. |
| **5 — Code-signing custody** | Days now; **flips to Type 2 after first signed release** — rotating the signing identity after installs exist resets SmartScreen reputation. | First signed Spec-023 §7b release. | Pre-flip: provision new Apple Developer / SignPath project identity; ceremony cost ~hours. Post-flip: owner approval through the default `CODEOWNERS` entry. |

**Point of no return:** First signed V1 release lands publicly. After that point, a change to axis 3 or axis 5 tooling that affects the signing identity or the update feed reaches installed apps only through a release they already take.

---

## Consequences

### Positive

- Every code-execution PR, from [Plan-001](../plans/001-session-core.md) Phase 1 on, lands through one CI, hook and release surface.
- One long-lived signing secret in `secrets.*`, the self-signed macOS identity. npm publishing goes through OIDC federation (GitHub OIDC → npmjs.com, Trusted Publishing); Windows signing happens at SignPath Foundation, which holds its own key.
- [ADR-018 §Decision items 6–8](018-windows-v1-tier-and-pty-sidecar.md#decision) compose cleanly: the Windows sidecar build matrix is shared between Axis 1's CI and Axis 3's release; one SignPath Foundation step signs the Electron app, the sidecar binaries and the Windows half for SmartScreen reputation pooling; the sidecar packages publish under Trusted Publishing with npm's own provenance.
- [ADR-021 §Decision row 8](021-v1-toolchain-selection.md#decision)'s one Node line holds — release CI and the service both run Node 24.21 or later, which also clears the floor the `better-sqlite3` 13.x Node-API-10 prebuild needs.

### Negative (accepted trade-offs)

- **Two signing custodies for V1.** The self-signed macOS identity (a release secret, until the Apple Developer certificate) and SignPath Foundation's certificate (held by SignPath; the Windows app, sidecar and Windows half). Each has a distinct rotation procedure. Mitigation: each is single-purpose, exercised by a single small workflow step.
- **Per-package npmjs.com Trusted Publisher registration ceremony.** Every sidecar package × per-package registration × per-package 2FA. One-time cost, but real work. Registration is scriptable rather than a click-path — `npm trust github <package> --file <workflow> --repo <owner/repo>`, in npm 11.15.0 and later. The bootstrap chicken-and-egg stands: each package must be published once under a short-lived granular write token _before_ a Trusted Publisher relationship can be configured for it.
- **Turborepo Remote Cache operational cost.** The cache is backed by the GitHub Actions cache through `rharkor/caching-for-turbo`, with HMAC ≥32 bytes (`TURBO_REMOTE_CACHE_SIGNATURE_KEY`): no service to host and no bill, at the price of the Actions cache's own eviction and size limits, which a dedicated cache service would not impose.
- **lefthook smaller ecosystem footprint than Husky.** ~5× smaller weekly downloads → fewer Stack-Overflow / AI-training-data hits when debugging unusual configs. Mitigated by lefthook being out-of-band for hook-script content (commands are language-agnostic shell invocations).
- **`minimumReleaseAge: 1440` blocks installs of brand-new packages for 24 hours.** Mitigated via `minimumReleaseAgeExclude` for named CVE-fix versions; a runbook step is required when an emergency patch lands.

### Unknowns

- **pnpm 11 GA date.** Once [pnpm 11](https://github.com/pnpm/pnpm/releases) is stable, the `packageManager` pin moves and our V1-day-1 hardening flags become defaults (no behavioral change).
- **Apple certificate and Organization enrollment timeline.** Organization enrollment is tied to legal-entity formation and waits with the certificate; until the certificate, builds carry the self-signed identity (Axis 5 item 1), and after it the Developer ID cert subject CN reads as the named maintainer. Migration cost is one-time re-key + re-notarize; older signed binaries remain valid.

---

## Re-Evaluation Triggers

Per axis, the conditions that force a fresh look at this ADR:

- **Axis 1 — CI workflow.** (1) `macos-15-intel` deprecation announcement (Aug-2027 tentative). (2) GitHub Actions adds free public-repo arm64 Linux runners (`ubuntu-24.04-arm` pricing change). (3) Turborepo deprecates the v8 remote-cache HTTP API, or `rharkor/caching-for-turbo` becomes unmaintained, or turbo 3.x lands — 2.9.6 warns that `futureFlags.longerSignatureKey` becomes fatal there, and the fork-safe empty-key degradation this wiring relies on expires with it.
- **Axis 2 — Pre-commit.** (1) Husky 10 (or successor) ships a fix for the four pnpm/Windows hook-regeneration bugs ([#1574](https://github.com/typicode/husky/issues/1574), [#1576](https://github.com/typicode/husky/issues/1576), [#1387](https://github.com/typicode/husky/issues/1387), [#1398](https://github.com/typicode/husky/issues/1398)) AND adds first-class parallel hooks. (2) lefthook upstream changes the `npm-installer` postinstall-binary download contract.
- **Axis 3 — Release automation.** (1) [`changesets/action#515`](https://github.com/changesets/action/issues/515) merges (split version-PR + publish workflows natively), making changesets a viable replacement for `release-please`. (2) Spec-023 changes §Behavior 7b's manifest schema. (3) npm Trusted Publishing deprecates or changes its OIDC trust policy. (4) ADR-021 moves the workspace's Node floor, which the release CI follows.
- **Axis 4 — Supply-chain.** (1) Renovate self-host operational cost becomes prohibitive (switch to Dependabot fallback). (2) GitHub native secret-scanning custom-pattern free-tier expansion (revisit paid Secret Protection). (3) TruffleHog re-licenses or AGPL-incompatibility friction downstream is resolved differently.
- **Axis 5 — Code-signing.** (1) The Apple Developer certificate lands — notarize, retire the self-signed identity, and consider Organization enrollment once a legal entity exists. (2) SignPath Foundation finds the project ineligible or withdraws it — the choice goes back to the person ([ADR-018 §Tripwires](018-windows-v1-tier-and-pty-sidecar.md#tripwires-revisit-triggers) item 2).

---

## References

### Research Conducted

Primary sources behind each axis. All fetches dated 2026-04-26 unless a row carries its own fetch date.

#### Axis 1 — CI workflow

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| GitHub Actions — Control workflow concurrency | Documentation | Concurrency: at most one running and one pending job per group; pending canceled on new arrival. | <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency> |
| GitHub Actions — Reference: limits | Documentation | Matrix max 256 jobs/workflow; max 6 h per job; max 35 days/run. | <https://docs.github.com/en/actions/reference/limits> |
| GitHub Actions — Running variations of jobs (matrix) | Documentation | `strategy.matrix.include`/`exclude`, `max-parallel`, `fail-fast` semantics. | <https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/running-variations-of-jobs-in-a-workflow> |
| GitHub Actions — Controlling permissions for `GITHUB_TOKEN` | Documentation | When `permissions` declared, all unspecified scopes set to no-access (except `metadata`); private-repo default no-access. | <https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/controlling-permissions-for-github_token> |
| GitHub Docs — About code owners | Documentation | CODEOWNERS search order: `.github/`, root, `docs/`; gitignore-style patterns; max 3 MB. | <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners> |
| `actions/runner-images#13045` (macOS 15 Intel) | GitHub-issue | `macos-15-intel` is the _last_ x86_64 macOS runner; supported until August 2027. | <https://github.com/actions/runner-images/issues/13045> |
| `actions/runner-images#13046` (macOS 13 deprecation) | GitHub-issue | `macos-13` runner image fully deprecated 2025-12-04. | <https://github.com/actions/runner-images/issues/13046> |
| Turborepo — Remote Caching | Documentation | HMAC-SHA256 signatures on artifacts; `remoteCache.signature: true` + `TURBO_REMOTE_CACHE_SIGNATURE_KEY`. | <https://turborepo.dev/docs/core-concepts/remote-caching> |
| `ducktors/turborepo-remote-cache` | Documentation | Open-source S3-backed implementation of Turborepo Remote Cache HTTP API. | <https://github.com/ducktors/turborepo-remote-cache> |
| `pnpm/action-setup` | Documentation | v6 (latest stable major); `cache: true` caches pnpm store + post-action `pnpm store prune`. | <https://github.com/pnpm/action-setup> |
| pnpm — Continuous Integration | Documentation | Canonical CI pattern: `pnpm/action-setup` + `actions/setup-node` `cache: 'pnpm'`. | <https://pnpm.io/continuous-integration> |
| `cross-rs/cross` README | Documentation | "MSVC and Apple Darwin targets, which we cannot ship pre-built images of." | <https://github.com/cross-rs/cross> |
| Electron — Native Node Modules | Documentation | "Electron has a different application binary interface (ABI) from a given Node.js binary." | <https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules> |
| GitHub Community Discussion #26822 — matrix branch protection | GitHub-issue | Aggregator-job pattern (`if: always()`, `needs:`-shell-check) is canonical for matrix branch protection. | <https://github.com/orgs/community/discussions/26822> |
| GitHub Docs — Required status checks (branch protection) | Documentation | Matrix-leg names embed strategy values; renaming silently bypasses protection. | <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule> |

#### Axis 2 — Pre-commit framework + dev-loop

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Husky homepage | Documentation | Uses Git's `core.hooksPath`; 2 kB gzipped, no deps; cross-platform. | <https://typicode.github.io/husky/> |
| Husky `package.json` (raw) | Documentation | Latest `"version": "9.1.7"`; `"engines": {"node": ">=18"}`; MIT. | <https://raw.githubusercontent.com/typicode/husky/main/package.json> |
| `typicode/husky#1574` (cross-platform `core.hooksPath` + prepare conflict) | GitHub-issue | `prepare: husky` regenerates `.husky/_` overwriting committed hooks. | <https://github.com/typicode/husky/issues/1574> |
| `typicode/husky#1576` (Windows `core.hooksPath` empty post-init) | GitHub-issue | Windows + Git 2.41 + Husky 9.1.7 unresolved. | <https://github.com/typicode/husky/issues/1576> |
| `typicode/husky#1387` (pnpm prepare-script overwrite) | GitHub-issue | Windows 11 + pnpm 8.14: `husky init` replaces existing `prepare`. | <https://github.com/typicode/husky/issues/1387> |
| `typicode/husky#1398` (pnpm install regenerates hooks) | GitHub-issue | `pnpm install` re-runs `prepare` and overwrites committed hooks. | <https://github.com/typicode/husky/issues/1398> |
| Lefthook releases | Documentation | Latest stable v2.1.6 (2026-04-16); active 2.1.x stream. | <https://github.com/evilmartians/lefthook/releases> |
| Lefthook README (raw) | Documentation | Single dependency-free Go binary; npm/gem/pipx/go install paths; parallel + glob/regexp + sub-dir + tags + Docker. | <https://raw.githubusercontent.com/evilmartians/lefthook/master/README.md> |
| Lefthook configuration docs | Documentation | Top-level keys: `min_version`, `parallel: true`, `commands.run`/`glob`/`exclude_tags`/`files`/`stage_fixed`. | <https://github.com/evilmartians/lefthook/blob/master/docs/configuration.md> |
| Lefthook install docs | Documentation | "Standalone, no-deps binary"; `lefthook self-update`. | <https://lefthook.dev/install/> |
| Lefthook `npm-installer` source | Documentation | Postinstall script downloads platform Go binary from GitHub release; CI-skipped unless `LEFTHOOK=1`. | <https://github.com/evilmartians/lefthook/blob/master/packaging/registries/npm-installer/install.js> |
| Lefthook packaging registries | Documentation | Multi-tier: `npm`, `npm-bundled`, `npm-installer`, plus aur/pypi/rubygems. | <https://github.com/evilmartians/lefthook/tree/master/packaging/registries> |
| `simple-git-hooks` | Documentation | v2.13.1 (2025-07-31); zero deps; no monorepo / parallel support documented. | <https://github.com/toplenboren/simple-git-hooks> |
| `pre-commit` (Python) homepage | Documentation | v4.6.0; auto-builds language toolchains; requires Python `>=3.10`. | <https://pre-commit.com/> |
| `pre-commit` install_uninstall.py | Documentation | "Cowardly refusing to install hooks with `core.hooksPath` set." | <https://github.com/pre-commit/pre-commit/blob/main/pre_commit/commands/install_uninstall.py> |
| lint-staged GitHub releases | Documentation | Latest v16.4.0 (2026-03-14); requires Node `>= 20.17.0`; pure ESM since v12. | <https://github.com/lint-staged/lint-staged> |
| lint-staged MIGRATION.md | Documentation | v16 removes `--shell`; `nano-spawn` over `execa`; auto-detects ESM/CJS via `"type": "module"`. | <https://github.com/lint-staged/lint-staged/blob/main/MIGRATION.md> |
| commitlint releases | Documentation | Latest v20.5.2 (2026-04-25); v20.5.0 added explicit `!` breaking-change marker handling. | <https://github.com/conventional-changelog/commitlint/releases> |
| commitlint configuration docs | Documentation | Config files; rule shape `[severity, applicability, allowedValues]`; multi-scope delimiters. | <https://commitlint.js.org/reference/configuration.html> |
| commitlint rules reference | Documentation | `@commitlint/config-conventional` default `type-enum` (11 types incl. `style`); default `header-max-length: 72`. | <https://commitlint.js.org/reference/rules.html> |
| Conventional Commits 1.0.0 | RFC | Mandatory `feat`/`fix`; `!` before `:` OR `BREAKING CHANGE:` footer; spec silent on revert/merge. | <https://www.conventionalcommits.org/en/v1.0.0/> |
| lint-staged v16.4.0 README — stash + automatic re-staging (fetched 2026-07-28) | Documentation | "By default _lint-staged_ creates a `git stash` as a backup of the original state"; "unstaged changes from partially staged files will be hidden and applied back after running tasks"; "Lint-staged will automatically add any modifications to the commit as long as there are no errors." | <https://github.com/lint-staged/lint-staged/blob/v16.4.0/README.md> |
| lint-staged v16.4.0 `gitWorkflow.js` (fetched 2026-07-28) | Documentation | Backup lifecycle in source: `git stash push --keep-index` ("Save stash of all changes, clearing the working tree but keeping staged files as-is"), with hidden unstaged changes restored after tasks. | <https://github.com/lint-staged/lint-staged/blob/v16.4.0/lib/gitWorkflow.js> |
| Lefthook v2.1.6 `stage_fixed` docs (fetched 2026-07-28) | Documentation | "When set to `true` lefthook will automatically call `git add` on files after running the command or script"; pre-commit hook only; `glob`/`exclude` filters apply to the staging. | <https://github.com/evilmartians/lefthook/blob/v2.1.6/docs/configuration/stage_fixed.md> |
| Lefthook v2.1.6 `group` docs (fetched 2026-07-28) | Documentation | Nested job groups: a group's `parallel` "executes all jobs in the group simultaneously"; group-level settings cascade to member jobs. | <https://github.com/evilmartians/lefthook/blob/v2.1.6/docs/configuration/group.md> |

#### Axis 3 — Release automation

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| npm Docs — Trusted Publishers | Documentation | Requires npm CLI ≥11.5.1, Node ≥22.14.0; `id-token: write`; provenance auto-emitted. | <https://docs.npmjs.com/trusted-publishers/> |
| npm Docs — Generating Provenance Statements | Documentation | Trusted Publishing → no `--provenance` flag needed; `npm audit signatures` for verify. | <https://docs.npmjs.com/generating-provenance-statements/> |
| GitHub Changelog — npm Trusted Publishing GA | Vendor-announcement | OIDC trusted publishing GA 2025-07-31. | <https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/> |
| `npm/provenance` repo | Documentation | npm provenance = SLSA in-toto attestation in Sigstore bundle (v0.1/v0.2). | <https://github.com/npm/provenance> |
| semantic-release GitHub Actions recipe | Documentation | Permissions `contents`/`issues`/`pull-requests`/`id-token: write`; OIDC for Trusted Publishing. | <https://semantic-release.gitbook.io/semantic-release/recipes/ci-configurations/github-actions> |
| `changesets/action` README | Documentation | v1.7.0 (2026-02-12); README's only auth path is `NPM_TOKEN`; no native OIDC. | <https://github.com/changesets/action> |
| `changesets/action#515` (split-workflow OIDC ask) | GitHub-issue | Open issue: action conflates version-PR + publish; OIDC needs dedicated publish file. | <https://github.com/changesets/action/issues/515> |
| `release-please-action` README | Documentation | v5.0.0 (2026-04-22); two-step pattern: release-PR job + downstream `if: release_created` publish. | <https://github.com/googleapis/release-please-action> |
| `release-please` manifest releaser docs | Documentation | Single `release-please-config.json` + `.release-please-manifest.json`; per-package overrides. | <https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md> |
| Trivy supply-chain compromise (2026-03 PAT theft) | Vendor-announcement | `pull_request_target` exploited to steal PAT and inject credential stealer; precedent for OIDC-only signing. | <https://github.com/aquasecurity/trivy/discussions/10462> (timeline detail in the Axis 5 row `Trivy 2026-03 incident`) |

#### Axis 4 — Supply-chain hygiene

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| pnpm settings reference | Documentation | `minimumReleaseAge` (v10.16); `blockExoticSubdeps` (v10.26); `allowBuilds` replaces `onlyBuiltDependencies`. | <https://pnpm.io/settings> |
| pnpm releases | Documentation | pnpm 10.33.2 (2026-04-23); 11.0.0-rc.5 flips `minimumReleaseAge: 1440` + `blockExoticSubdeps: true` defaults. | <https://github.com/pnpm/pnpm/releases> |
| pnpm "Protecting Our Newsroom" blog | Vendor-announcement | Seattle Times pilot: layered defenses (`strictDepBuilds` + `onlyBuiltDependencies` + `minimumReleaseAge` + `trustPolicy: no-downgrade`). | <https://pnpm.io/blog/2025/12/05/newsroom-npm-supply-chain-security> |
| Unit 42 Shai-Hulud writeup | Audit-report | First published 2025-09-17; multiple waves through Feb 2026; 1700+ packages affected. | <https://unit42.paloaltonetworks.com/npm-supply-chain-attack/> |
| CISA Shai-Hulud alert | Vendor-announcement | Widespread-supply-chain-compromise alert 2025-09-23. | <https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem> |
| Dependabot pnpm catalogs GA | Vendor-announcement | pnpm-workspace catalog support GA 2025-02-04. | <https://github.blog/changelog/2025-02-04-dependabot-now-supports-pnpm-workspace-catalogs-ga/> |
| Renovate npm catalog issue #30079 | GitHub-issue | pnpm catalog support added; closed via renovatebot/renovate PR-#33376. | <https://github.com/renovatebot/renovate/issues/30079> |
| Renovate npm catalog bug #37485 | GitHub-issue | When `shared-workspace-lockfile = false`, catalog updates fail to propagate; `postUpgradeTasks` workaround. | <https://github.com/renovatebot/renovate/issues/37485> |
| Socket.dev `socket-for-github` docs | Documentation | PR-time analysis of new deps; install-script + telemetry + native-code + typosquat detection. | <https://docs.socket.dev/docs/socket-for-github> |
| Socket.dev scans risk taxonomy | Documentation | Vulnerability + supply-chain risks (malware, typosquatting, obfuscation, network/shell access, ownership). | <https://docs.socket.dev/docs/scans> |
| Socket.dev `shai-hulud-scan` CLI | Documentation | Supports package-lock.json, yarn.lock, pnpm-lock.yaml; post-publish-malicious-version detection. | <https://socket.dev/npm/package/shai-hulud-scan> |
| GitHub secret scanning custom patterns docs | Documentation | Custom-pattern definition: name + regex; push-protection enablement; per-repo 100, per-org 500 limits. | <https://docs.github.com/en/code-security/secret-scanning/using-advanced-secret-scanning-and-push-protection-features/custom-patterns/defining-custom-patterns-for-secret-scanning> |
| GitHub Advanced Security overview | Documentation | Code/secret scanning + push protection enabled free for public repos; custom patterns require paid Secret Protection. | <https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security> |
| GitHub Secret Protection / Code Security launch | Vendor-announcement | 2025-03-04: Secret Protection $19/committer/mo; Code Security $30/committer/mo (split available to GitHub Team plan). | <https://github.blog/changelog/2025-03-04-introducing-github-secret-protection-and-github-code-security/> |
| GitHub secret scanning push-protection custom patterns GA | Vendor-announcement | Custom patterns in push protection GA 2025-08-19. | <https://github.blog/changelog/2025-08-19-secret-scanning-configuring-patterns-in-push-protection-is-now-generally-available/> |
| Gitleaks repo | Documentation | v8.30.1 (2026-03-21); MIT; pre-commit + composite rules + SARIF → GitHub Advanced Security. | <https://github.com/gitleaks/gitleaks> |
| TruffleHog repo | Documentation | v3.95.2 (2026-04-21); AGPL-3.0; >700 detectors with active API verification. | <https://github.com/trufflesecurity/trufflehog> |

#### Axis 5 — Code-signing custody

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Microsoft — Artifact Signing FAQ | Documentation | Rebranded canonical product (resource provider `Microsoft.CodeSigning`); FIPS 140-2 L3; eligibility USA/Canada/EU/UK orgs + USA/Canada individuals; Free/Trial subs cannot register. | <https://learn.microsoft.com/en-us/azure/artifact-signing/faq> |
| SignPath Foundation terms | Documentation | Free code signing for open-source projects: OSI license "without commercial dual-licensing for all components", no proprietary components, actively maintained, already released, a published code-signing policy; "The code signing certificate is issued to SignPath Foundation. This means that SignPath Foundation is the publisher of the OSS project." | <https://signpath.org/terms> |
| Cloudsmith open-source hosting policy | Documentation | "at least 50GB of artifact data + 200GB of package delivery for free", attribution link required; hosts the signed apt and dnf repository. | <https://docs.cloudsmith.com/resources/open-source-hosting-policy> |
| Microsoft — Artifact Signing trust models | Documentation | Public Trust certs from Microsoft Identity Verification Root CA 2020; supports Win32/Smart App Control/`/INTEGRITYCHECK`/VBS enclaves. | <https://learn.microsoft.com/en-us/azure/artifact-signing/concept-trust-models> |
| Microsoft — Artifact Signing pricing | Documentation | $9.99/mo for 5,000 sigs + 1 cert profile; $99.99/mo for 100,000 sigs + 10 profiles. | <https://azure.microsoft.com/en-us/pricing/details/artifact-signing/> |
| Microsoft Learn — SmartScreen reputation for Windows app developers | Documentation | "SmartScreen reputation is per file hash — every new build of your app starts with zero reputation." (2026-04-17 update) | <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation> |
| `Azure/artifact-signing-action#128` | GitHub-issue | 2026-03-21/23 silent CA migration `EOC CA 02` → `AOC CA 03` triggered SmartScreen warnings on identical-config builds. | <https://github.com/Azure/artifact-signing-action/issues/128> |
| Apple Developer Program — Enroll | Documentation | Individual: $99/yr, no D-U-N-S; Organization: $99/yr + D-U-N-S + legal entity. | <https://developer.apple.com/programs/enroll/> |
| Apple Developer Program — D-U-N-S Number | Documentation | D-U-N-S required for Org enrollment; 9-digit Dun & Bradstreet identifier; free. | <https://developer.apple.com/help/account/membership/D-U-N-S/> |
| GitHub Docs — Configuring OpenID Connect in Azure | Documentation | OIDC flow GitHub Actions JWT → Microsoft Entra federated credential (sub-claim binds repo + workflow + environment). | <https://docs.github.com/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-azure> |
| Microsoft Learn — Authenticate to Azure from GitHub Actions by OIDC | Documentation | Trust setup: Entra app registration → service principal → role assignment + federated credential. | <https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect> |
| CA/Browser Forum — Code Signing Baseline Requirements | RFC | Effective 2023-06-01: code-signing keys MUST be in FIPS 140-2 L2+ or CC EAL 4+ HSM (EV and OV); non-exportable. | <https://cabforum.org/working-groups/code-signing/requirements/> |
| CA/Browser Forum — Baseline Requirements v3.7 PDF | RFC | CSBR §6.2.7 subscriber private-key protection; compliant cloud-HSM list (AWS CloudHSM, Azure Dedicated/Managed/Key Vault, GCP HSM, IBM, Luna). | <https://cabforum.org/uploads/Baseline-Requirements-for-the-Issuance-and-Management-of-Code-Signing.v3.7.pdf> |
| SSL.com — Which Code Signing Certificate (CSBR ballot) | Vendor-announcement | 2026-02-23: max validity reduced to 459 days; SSL.com enforced 2026-02-27. | <https://www.ssl.com/faqs/which-code-signing-certificate-do-i-need-ev-ov/> |
| DigiCert KeyLocker | Vendor-announcement | Cloud-based FIPS 140-2 L3 HSM for code signing; 1 KeyLocker = 1000 ops. | <https://docs.digicert.com/en/digicert-keylocker.html> |
| Apple — `electron/notarize` README | Documentation | Auth options: App Store Connect API key (recommended) / Apple ID + app-specific password / keychain. | <https://github.com/electron/notarize> |
| Apache Software Foundation — License v2.0 | Documentation | Apache-2.0 redistribution requirements; permissive; explicit patent grant §3. | <https://www.apache.org/licenses/LICENSE-2.0> |
| Trivy 2026-03 incident — Aqua Security incident conclusion (Discussion #10462, 2026-03-30) and advisory GHSA-69fq-xp46-6x23 (2026-03-21) | Vendor-announcement | Vendor timeline verbatim: 2026-02-27 "the attacker exploited a workflow vulnerable through a `pull_request_target` invocation in aquasecurity/trivy" (initial access and credential theft); 2026-03-01 remediation revoked the observed automation-account credentials, yet "the attacker regained persistence despite initial revocation" and "the secret rotation process was too long and complex and therefore was not effective"; 2026-03-19 the attacker "used stolen credentials to build a malicious version of Trivy v0.69.4" via the release workflow and force-pushed 75 of 76 `trivy-action` tags plus every `setup-trivy` tag at a credential stealer (dumps `Runner.Worker` memory, sweeps 50+ credential paths). Vendor hardening: every `pull_request_target` trigger removed, immutable releases, SLSA provenance, no new tokens issued until existing access was fully revoked. Fetched 2026-09-02. | <https://github.com/aquasecurity/trivy/discussions/10462>; <https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23> |

### Related ADRs and Specs

- [ADR-001](001-session-is-the-primary-domain-object.md) — first-class session primitive (every release artifact is session-recoverable through Plan-001).
- [ADR-015](015-electron-desktop-app.md) — the Electron app runs the Node its Electron pin bundles; [ADR-021](021-v1-toolchain-selection.md)'s Node 24.21 or later covers the service and the CLI, and its packages' `engines.node` floor of `>=24.21.0` covers Axis 3's release CI.
- [ADR-018](018-windows-v1-tier-and-pty-sidecar.md) — §Decision item 6 (Windows sidecar packaging via `@esbuild/*` pattern), item 7 (Windows code-signing through SignPath Foundation, an ineligible project going back to the person), item 8 (SmartScreen reputation pooling under one publisher). ADR-022 axis 5 is the signing-custody overlay; ADR-018 decides the sidecar's distribution.
- [ADR-019](019-v1-deployment-model-and-oss-license.md) — Apache-2.0 OSS license stance (forces Axis 4's TruffleHog deferral on AGPL grounds).
- [ADR-021](021-v1-toolchain-selection.md) — pnpm 10.33+, Turborepo 2.11+, ESLint 10, Vitest 4, one Node line, 24.21+. CI job graph is named there as a success criterion; ADR-022 builds out the workflow files.
- [Spec-009](../specs/009-gitflow-pr-and-diff-attribution.md) — product-side gitflow (`GitHostingAdapter`, `BranchContextRead`, `createChangeRequest`, `PRPrepare`). ADR-022 axis 2's engineering-side `<type>/<topic>` branch shape is disjoint from Spec-009's `run/<run-id>/<topic>` via type-prefix (`feat/...` vs `run/...`).
- [Spec-023](../specs/023-self-host-secure-defaults.md) — §Behavior 7b release-manifest schema and the self-update checksum check. ADR-022 axes 3 and 5 are the implementation primitives for §7b.
- [Plan-001](../plans/001-session-core.md) — the first code built on Axis 1's CI surface and Axis 3's release surface.
