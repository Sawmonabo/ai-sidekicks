# ADR-023: V1 CI/CD, Pre-Commit Hooks, and Release Automation

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

This project ([CLAUDE.md "Current State: Documentation-Only"](../../CLAUDE.md)) has reached the end of its doc-first phase. [BL-100](../backlog.md) is the gating backlog item: it requires a complete engineering-side CI/CD, pre-commit, and release-automation surface authored as an accepted ADR before any code-execution PR — including [Plan-001](../plans/001-shared-session-core.md) Phase 1 — can land. ADR-023 fills that gate.

Five axes need first-time decisions, and they are deeply coupled:

1. **CI workflow architecture** — GitHub Actions job graph, matrix strategy across two Node tiers ([ADR-022 §Decision row 8](022-v1-toolchain-selection.md)) + the 5-platform Rust PTY sidecar ([ADR-019 §Decision item 6](019-windows-v1-tier-and-pty-sidecar.md)), Turborepo remote-cache integration, branch protection.
2. **Pre-commit hook framework + dev-loop** — local hook runner; `lint-staged` shape; `commitlint` + Conventional Commits configuration; engineering-side branch-naming convention disjoint from [Spec-011](../specs/011-gitflow-pr-and-diff-attribution.md)'s product-side `GitHostingAdapter` namespace.
3. **Release automation** — release tooling for the npm-publishable workspace packages and a custom desktop-binary release flow that implements [Spec-027 §Behavior 7b](../specs/027-self-host-secure-defaults.md) verbatim (Ed25519 manifest signing + Sigstore bundle dual-trust).
4. **Supply-chain hygiene** — npm provenance, SBOM emission, dependency-update bot, secret scanning, pnpm 10 hardening.
5. **Code-signing custody** — Apple Developer ID, Windows code-signing per [ADR-019 §Decision item 7](019-windows-v1-tier-and-pty-sidecar.md), Linux Sigstore keyless, and Spec-027 §7b Ed25519 manifest signing.

The five axes converge on a single GitHub-Actions workflow shape: per-job `id-token: write` permissions, `actions/attest@v4` as the unified attestation primitive, npm Trusted Publishing for npm packages, OIDC-federated cloud KMS for Ed25519 manifest signing, and an environment-gate (`production`) that binds the OIDC sub-claim adversarially. This ADR captures all five decisions in one place because their permission-shapes, secret-shapes, and trust-paths must compose.

## Problem Statement

How should V1 ship its engineering CI/CD, pre-commit dev loop, release automation, and code-signing custody — composing into a single GitHub Actions surface — such that [Plan-001 Phase 1](../plans/001-shared-session-core.md) can ship code, the released artifacts satisfy [Spec-027 §7b](../specs/027-self-host-secure-defaults.md) dual-trust verification, and no long-lived signing secrets live in `secrets.*`?

### Trigger

[BL-100](../backlog.md) is the explicit trigger: completion gates Plan-001 Phase 1 (the first code-execution PR per CLAUDE.md "Current State: Documentation-Only"). The five axes were enumerated as scope in BL-100's exit criteria; this ADR resolves them as one composed decision.

---

## Decision

We adopt the following five-axis configuration.

### Axis 1 — CI Workflow Architecture

**Decision:** A single `.github/workflows/ci.yml` with **two separate matrices** (a per-OS test matrix and a 5-platform sidecar build matrix) joined by a `ci-gate` aggregator job; **least-privilege permissions per job** (workflow default `contents: read`); **event-split concurrency** (PR runs cancel-in-progress, integration-branch runs (`develop`, `main`) do not — amended 2026-04-26, see [Decision Log](#decision-log)); **self-hosted Turborepo remote cache** ([`ducktors/turborepo-remote-cache`](https://github.com/ducktors/turborepo-remote-cache), HMAC ≥32 bytes); **native compilation per OS** for the Rust PTY sidecar (no cross-compile to Apple-Darwin from Linux); **explicit two-ABI `pnpm rebuild`** in the test job (`better-sqlite3` + `pg` against both Node 22 and Electron ABIs per ADR-022); branch protection (on `develop` and `main`) requires only `ci-gate`; `CODEOWNERS` lives at `.github/CODEOWNERS` (canonical search order: `.github/`, root, `docs/`).

**Drift correction (load-bearing):** The GitHub-hosted runner label `macos-13` was fully deprecated 2025-12-04 per [`actions/runner-images#13046`](https://github.com/actions/runner-images/issues/13046). The V1 darwin-x64 runner uses **`macos-15-intel`** — the _last_ x86_64 macOS runner per [`actions/runner-images#13045`](https://github.com/actions/runner-images/issues/13045), supported through August 2027. The V1 darwin-arm64 runner uses `macos-15`. This deprecation cascades to Axis 3's release.yml.

**OIDC environment-gate (load-bearing, paired with Axis 5):** The release workflow trigger requires `environment: production` configured in repository settings. Without the environment gate, the GitHub OIDC sub-claim is `repo:<org>/<repo>:ref:refs/tags/<tag>`, which a compromised contributor can spoof by pushing a tag. With the environment gate, the sub-claim is `repo:<org>/<repo>:environment:production`, which Axis 5's federated credentials bind to.

**Antithesis (single cross-product matrix `(node × os × sidecar-target)`):** A unified matrix is mechanically simpler — one matrix definition, one set of job names, one fail-fast policy. We have headroom under GitHub's [256-job-per-workflow limit](https://docs.github.com/en/actions/reference/limits). Workflow-level `permissions: write-all` is also simpler than per-job least-privilege.

**Synthesis:** The cross-product confuses two unrelated concerns. (a) Which Node ABI compiles `better-sqlite3`/`pg` is a _package_ concern (`engines.node` per [ADR-022 §Decision row 8](022-v1-toolchain-selection.md)), enforced by pnpm during install — not a CI matrix dimension. (b) Which OS we test on is a _workflow_ concern. Cross-multiplying produces matrix legs that pretend to test "Node 22 on macOS arm64" but in reality test the same package binaries with no behavioral delta. The two-matrix split also matches the structural reality that the Rust sidecar build has zero relation to the Node tier — it's bytes-on-disk produced before any JS runs. Workflow-level write permissions also negate `id-token: write` job-scoping — per [GitHub's permissions docs](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/controlling-permissions-for-github_token), "all unspecified permissions are set to no access" only when `permissions:` is declared at job level. A broad workflow-level write grant means every job (including third-party action steps) can mint OIDC tokens or push to the repo.

### Axis 2 — Pre-Commit Hook Framework

**Decision:** [**lefthook 2.1.6**](https://github.com/evilmartians/lefthook/releases) (`npm-installer` postinstall-binary variant); `lint-staged.config.mjs` (ESM, function-form for `tsc -b --noEmit` per [lint-staged README](https://github.com/lint-staged/lint-staged)); `commitlint.config.mjs` extending [`@commitlint/config-conventional`](https://commitlint.js.org/reference/rules.html) with a 10-type `type-enum` (default 11 minus `style` — Prettier enforces formatting) and a strict `scope-enum`; engineering-side branch shape `<type>/<topic>` per upstream [Conventional Branch](https://conventional-branch.github.io/) (amended 2026-04-26 — see [Decision Log](#decision-log)), disjoint from [Spec-011](../specs/011-gitflow-pr-and-diff-attribution.md)'s product-side `run/<run-id>/<topic>` namespace via type-prefix.

**Drift correction (versions):** Live verification on 2026-04-26 found Husky **9.1.7** (no v10 cut), lefthook **2.1.6** (the 1.x line ended), commitlint **20.5.2** (no v21 cut). Recommendations bind to actually-published versions.

**CI parity (D-1 cross-axis with Axis 1):** CI's `lint` job runs `lefthook run pre-commit --all-files` to close the `git commit --no-verify` bypass; the local hook is the diagnostic, CI is the enforcement.

**Antithesis (Husky 9.1.7):** Husky has the larger network effect — default in TypeScript starters (Next.js, t3-stack), 5× weekly downloads, highest AI-assistant familiarity. The 2 kB / no-runtime-deps profile is genuinely small. The Windows `core.hooksPath` issues are not show-stoppers — workarounds exist and are documented.

**Synthesis:** Three V1 facts tip the choice. (1) **Parallel execution out of the box** — `lefthook.yml` `parallel: true` is documented config per [lefthook configuration docs](https://github.com/evilmartians/lefthook/blob/master/docs/configuration.md); Husky has no parallel primitive (the hook script body must invoke a parallel runner manually). For an AI-implementer-led project where commit cadence is high, sub-second feedback on the local loop is load-bearing. (2) **No Node startup per hook task** — Husky's hook is shell→`npx <tool>` per task (~200 ms Node startup per task on cold cache); lefthook is a single Go binary. (3) **Cross-platform packaging without `core.hooksPath` Windows fragility** — Husky has four open Windows/pnpm bugs sharing a root cause ([#1574](https://github.com/typicode/husky/issues/1574), [#1576](https://github.com/typicode/husky/issues/1576), [#1387](https://github.com/typicode/husky/issues/1387), [#1398](https://github.com/typicode/husky/issues/1398)) where the `prepare`-script regenerates `.husky/_` and overwrites committed hooks under pnpm + Windows. Lefthook's `npm-installer` does an OS+arch-detected GitHub-release download postinstall, sidestepping the entire class.

### Axis 3 — Release Automation

**Decision:** Three release surfaces, tooled separately, unified by a shared monotonic `version` integer.

- **Surface 1 (npm packages: `@ai-sidekicks/contracts`, `@ai-sidekicks/client-sdk`):** [`release-please-action@v5`](https://github.com/googleapis/release-please-action) + [manifest mode](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md) + [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/). Provenance auto-generated by npm CLI under Trusted Publishing — no `--provenance` flag needed. Per the 2026-04-26 branch-model amendment ([Decision Log](#decision-log)), `release-please-action` observes `develop` (the integration branch); release tags ultimately land on `main`; exact configuration (`target-branch` setting + any `develop` → `main` fast-forward step) is finalized in Plan-001 Phase 1 during `release.yml` authoring.
- **Surface 2 (desktop binary, [Spec-027 §7b](../specs/027-self-host-secure-defaults.md) verbatim):** Custom workflow built from [`actions/attest@v4`](https://github.com/actions/attest) (per-platform binaries → Sigstore bundle) + a manifest-assembly script (emits Spec-027 §7b schema: `version`, `released_at`, `expires_at = released_at + 30d`, `previous_manifest_hash`, `next_signing_keys`, `artifacts.{platform}.{url, sha256}`) + an OIDC→cloud-KMS Ed25519 sign step (custody per Axis 5).
- **Surface 3 (Rust sidecar, 5 npm platform packages per ADR-019 §Decision item 6):** Extends Surface 1's `release-please` manifest to include `@ai-sidekicks/pty-sidecar-{win32-x64,darwin-arm64,darwin-x64,linux-x64,linux-arm64}`. Each binary built on its native OS runner (per Axis 1's sidecar-build matrix), packaged into the matching platform package, published under the same Trusted Publishing configuration.

**Resolution of ADR-022 Node-floor tension (load-bearing):** Trusted Publishing requires npm CLI ≥11.5.1, which ships with Node ≥22.14.0 per [npm docs](https://docs.npmjs.com/trusted-publishers/). [ADR-022 §Decision](022-v1-toolchain-selection.md) pins the daemon's Node 22 floor at 22.12+. **Resolution:** the release CI itself runs on Node 24 (control-plane / CLI tier per ADR-022 §Decision row 8); the daemon's `engines.node: 22.12+` is unchanged. The release-CI Node version is independent of `engines.node` for the package being published.

**OIDC environment-gate (paired with Axis 1 + Axis 5):** Surface 2's release workflow trigger requires `environment: production`. Surface 1's `publish-npm` job inherits the same gate — Trusted Publishing's npmjs.com configuration optionally pins a GitHub `environment`, and we use it.

**Antithesis (one tool across all surfaces — semantic-release):** [semantic-release](https://semantic-release.gitbook.io/semantic-release/recipes/ci-configurations/github-actions) ships first-class npm-provenance and `id-token: write`. Unifying tooling across surfaces would simplify cognitive load.

**Antithesis (changesets):** [changesets](https://github.com/changesets/changesets) is the modern npm-monorepo standard with independent + fixed-package release modes.

**Synthesis:** semantic-release is rejected because its monorepo story is weaker than `release-please`'s manifest mode for handling 7 packages (2 from Surface 1 + 5 from Surface 3) with per-package overrides. changesets is rejected because [`changesets/action` issue #515](https://github.com/changesets/action/issues/515) documents an open conflation: the action runs version-PR-creation and publish in a single workflow, but OIDC requires a dedicated publish-only workflow file registered with npmjs.com. Adopting changesets means owning the issue-#515 workaround until upstream resolves. `release-please-action`'s native two-step pattern (release-PR job + downstream `if: ${{ steps.release.outputs.release_created }}` publish job) aligns with OIDC out of the box. Surface 2 cannot be unified with either tool — Spec-027 §7b's manifest schema is graph-aware (`previous_manifest_hash`) and out of model for plugin-driven release tooling. A custom workflow built from `actions/attest@v4` + manifest-assembly + KMS-signing is the only path that emits Spec-027 §7b's exact dual-signature artifact pair. Surface 3 ride-alongs on Surface 1's manifest because the build matrix is shared with Axis 1's sidecar-build matrix anyway.

### Axis 4 — Supply-Chain Hygiene

**Decision (5 sub-axes):**

1. **npm provenance** — [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) per package; no explicit `--provenance` flag (auto-generated under Trusted Publishing per [npm provenance docs](https://docs.npmjs.com/generating-provenance-statements/)).
2. **SBOM emission** — [Anchore Syft v1.43+](https://github.com/anchore/syft) (full surface, including container/binary layers) + native [`pnpm sbom`](https://pnpm.io) (JS-only, second-channel); both signed via [`actions/attest@v4`](https://github.com/actions/attest) with `--predicate-type sbom`. Avoid `actions/attest-sbom` (deprecated wrapper) and `npm sbom` (CycloneDX 1.5 only, no pnpm-lockfile parsing).
3. **Dependency updates** — [Renovate](https://docs.renovatebot.com/key-concepts/minimum-release-age/) primary with `minimumReleaseAge: 14 days` (matches Renovate's documented automerge floor) and `security:minimumReleaseAgeNpm` preset; [Socket.dev](https://docs.socket.dev/docs/socket-for-github) GitHub App as adjunct for PR-time malicious-version analysis (`shai-hulud-scan` family detectors). Dependabot deferred (lacks first-class minimum-release-age).
4. **Secret scanning** — GitHub native secret scanning + push protection (free in public repos per [GitHub Advanced Security overview](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security)) + [Gitleaks v8.30+](https://github.com/gitleaks/gitleaks) (MIT) as pre-commit + CI-side adjunct. [TruffleHog](https://github.com/trufflesecurity/trufflehog) deferred — AGPL-3.0 license conflicts with [ADR-020](020-v1-deployment-model-and-oss-license.md) Apache-2.0 stance for downstream self-hosters.
5. **pnpm 10 hardening** — `minimumReleaseAge: 1440` (1 day) AND `blockExoticSubdeps: true` in `pnpm-workspace.yaml` from V1 day 1, opting into [pnpm 11's defaults](https://github.com/pnpm/pnpm/releases) ahead of the upgrade.

**Cross-axis attestation surface:** The five axes converge on `actions/attest@v4` as the unified attestation primitive — `actions/attest-build-provenance` and `actions/attest-sbom` are wrappers and are deprecated in favor of the underlying action per their READMEs. New workflow code targets `actions/attest@v4` directly; the wrapper names appear only in onboarding documentation as breadcrumbs.

**Antithesis (single bot — Dependabot only):** "Two PR-author bots is twice the noise. Dependabot is GitHub-native and zero-config."

**Synthesis:** In the post-Shai-Hulud era — [Unit 42](https://unit42.paloaltonetworks.com/npm-supply-chain-attack/) confirmed 1700+ packages affected across four campaign waves Sept 2025 → Feb 2026; [CISA issued a widespread-supply-chain-compromise alert 2025-09-23](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem) — release cooldown is the controlling defense for transitive package compromise. Dependabot does not provide minimum-release-age; the "zero-config" framing trades a real defense for an aesthetic preference. Socket.dev adds runtime analysis Renovate cannot do. Renovate (release cadence + cooldown + catalog-awareness) and Socket.dev (PR-time malicious-version detection) cover orthogonal failure modes, not redundant ones.

### Axis 5 — Code-Signing Custody

**Decision (5 sub-axes):**

1. **macOS** — [Apple Developer Program Individual ($99/yr)](https://developer.apple.com/programs/enroll/) under the named project maintainer for V1; App Store Connect API key (`.p8` + key ID + issuer ID) in GitHub Actions Secrets; signing via `productbuild --sign "Developer ID Installer: <Maintainer Name>"` + [`xcrun notarytool submit --wait`](https://github.com/electron/notarize). Migration to Organization enrollment deferred to post-V1 (requires legal-entity formation + D-U-N-S; Apple's transferability flow handles re-keying without invalidating prior-signed binaries).
2. **Windows** — [Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) (formerly Trusted Signing, FIPS 140-2 Level 3 service, $9.99/mo for 5,000 signatures) via [GitHub Actions OIDC + Microsoft Entra federated credential](https://docs.github.com/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-azure). EV cert in cloud HSM (DigiCert KeyLocker / SSL.com eSigner / Azure Key Vault Managed HSM) is the documented Tripwire-2 fallback per [ADR-019 §Decision item 7](019-windows-v1-tier-and-pty-sidecar.md). Per [ADR-019 §Decision item 8](019-windows-v1-tier-and-pty-sidecar.md), the same Azure Artifact Signing identity covers both the Electron app and all 5 sidecar packages for SmartScreen reputation pooling.
3. **Linux** — [Sigstore keyless](https://docs.sigstore.dev/cosign/signing/overview/) via GitHub OIDC for Electron AppImage and daemon binary; Trusted Publishing handles provenance for npm packages. Hosted apt/yum repository signing deferred to V1.1 per [Spec-027 §Open Questions](../specs/027-self-host-secure-defaults.md).
4. **Ed25519 manifest signing key (Spec-027 §7b)** — **Layered custody**:
   - **Hot key**: [AWS KMS Ed25519](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/) (GA 2025-11; private key never leaves KMS) accessed via GitHub Actions OIDC → AWS IAM role; signs every routine release; rotated quarterly.
   - **Cold key**: [YubiHSM 2](https://docs.yubico.com/hardware/yubihsm-2/hsm-2-user-guide/webdocs.pdf) in maintainer custody, offline; signs the `next_signing_keys` rotation announcement and the bootstrap manifest (`version=1`); ceremony cadence 4 years (matches FIPS 140-3 cert validity); used for post-compromise emergency rotation.
   - This layering is what makes Spec-027 §7b's `next_signing_keys` pre-publication out-of-band-attested. Collapsing both into the cloud-KMS layer would defeat the dual-trust property under CI compromise — an attacker who compromises a privileged GitHub collaborator account or a popular GitHub Action can call `aws kms sign` legitimately, but cannot sign a `next_signing_keys` rotation without physical YubiHSM access.
5. **Rotation procedure** — `next_signing_keys` pre-published ≥30 days ahead of cutover (signed by current hot key + counter-signed by cold key for transition-period dual-sign per Debian archive-keyring precedent). `CODEOWNERS`-scoped `release-manifest-config.yml`, `signing-keys-pubkey-pinned.txt`, `.github/workflows/release-*.yml` to `@ai-sidekicks/security` only. Post-rotation telemetry verification step scrapes SmartScreen telemetry against the publisher to confirm reputation persisted; rollback-to-pre-rotation-cert plan if reputation breaks.

**OIDC environment-gate (load-bearing, paired with Axis 1 + Axis 3):** Federated credentials in Microsoft Entra (Windows), AWS IAM (Ed25519 hot key), and Azure Key Vault (alternative Ed25519 hot key) bind their trust policies to OIDC sub-claim `repo:<org>/<repo>:environment:production`, **not** `repo:<org>/<repo>:ref:refs/tags/<tag>`. Without the environment gate, a compromised contributor pushing a malicious tag still gets a valid OIDC token and both Ed25519 + Sigstore paths verify cleanly — dual-trust collapses to single-trust under compromise. The environment gate also enables review-required-before-deploy and a deployment URL audit trail.

**Antithesis (raw Ed25519 private key as GitHub Actions Secret):** Simpler — one secret, one workflow line, no cloud KMS dependency. Cheaper.

**Antithesis (YubiHSM offline for every release):** Strongest dual-trust posture against CI compromise — a CI compromise cannot sign without physical access. Spec-027 §7b's "force attacker to compromise two independent systems" rationale is fully honored.

**Synthesis (raw key):** Single point of compromise; rotation requires manually rolling secrets across all envs; satisfies neither Spec-027 §7b's dual-path rationale nor 2026 supply-chain hygiene baseline. The [Trivy 2026-03 PAT-theft incident](https://github.com/aquasecurity/trivy) — `pull_request_target` workflow trigger exploited to steal a PAT and inject a credential stealer into Trivy's official release — is direct precedent for "stored secret = stolen secret."

**Synthesis (YubiHSM-only):** Operationally untenable for a bi-weekly release cadence; every release would block on physical-presence sign ceremony. Layered custody is the pragmatic resolution: hot key for routine releases (cloud KMS, OIDC-only), cold key for `next_signing_keys` rotation announcements (YubiHSM, offline). This composes with Spec-027 §7b's `next_signing_keys` field — operators with `last_seen_version` already have the next pubkey pinned out-of-band.

---

## Alternatives Considered

Per Type 1 treatment, alternatives are listed with brief rejection rationales. Per-option steel-mans appear inline above where load-bearing.

### Axis 1 alternatives

- **Single cross-product matrix `(node × os × sidecar-target)`** (rejected — confuses package-level Node tier with workflow-level OS axis; produces matrix legs with no behavioral delta).
- **`cross-rs/cross` for all 5 sidecar targets** (rejected — [`cross-rs/cross`](https://github.com/cross-rs/cross) explicitly states "MSVC and Apple Darwin targets, which we cannot ship pre-built images of"; cross-compile to Apple-Darwin from Linux is unsupported).
- **`cargo-zigbuild` for darwin targets** (rejected — Apple `codesign` and `xcrun notarytool` only run on macOS; cross-compiling darwin on Linux still forces a macOS runner step for signing, eliminating savings, and adds macOS SDK licensing risk).
- **Workflow-level `permissions: write-all`** (rejected — broad write grant means every job can mint OIDC tokens; violates least-privilege).
- **Vercel hosted Turborepo Remote Cache** (rejected — [ADR-022 §Decision row 2](022-v1-toolchain-selection.md) commits to self-hosted; Vercel relicensing risk is named there).
- **Cache `node_modules/**/\*.node` artifacts\*\* (rejected — silently masks ADR-022's two-ABI binding assumption).
- **Enumerate every matrix-leg name in branch protection** (rejected — matrix-leg names embed strategy values; renaming or adding a leg silently bypasses protection per [GitHub Community Discussion #26822](https://github.com/orgs/community/discussions/26822)).

### Axis 2 alternatives

- **[Husky 9.1.7](https://typicode.github.io/husky/)** (rejected — no parallel primitive, ~200 ms Node startup per task on cold cache, four open Windows/pnpm bugs sharing the same root cause).
- **[simple-git-hooks 2.13.1](https://github.com/toplenboren/simple-git-hooks)** (rejected — no documented monorepo or parallel-hook support).
- **[`pre-commit` 4.6.0 (Python)](https://pre-commit.com/)** (rejected — Python `>=3.10` interpreter prerequisite is a separate install path on Windows; per-machine Python version skew becomes a CI-vs-local divergence vector; refuses to install if `core.hooksPath` is set per [pre-commit's `install_uninstall.py`](https://github.com/pre-commit/pre-commit/blob/main/pre_commit/commands/install_uninstall.py)).
- **All-11 `type-enum` (keep `style`)** (rejected — Prettier auto-applies via lint-staged; a "pure formatting" commit shouldn't exist in the V1 workflow; `chore(format): ...` is sufficient).

### Axis 3 alternatives

- **[semantic-release](https://semantic-release.gitbook.io/semantic-release/recipes/ci-configurations/github-actions)** for all surfaces (rejected — monorepo story weaker than `release-please` manifest mode; cannot emit Spec-027 §7b's graph-aware manifest schema).
- **[changesets](https://github.com/changesets/action) for npm packages** (rejected — [`changesets/action#515`](https://github.com/changesets/action/issues/515) conflates version-PR and publish into one workflow; OIDC requires dedicated publish-only workflow file).
- **electron-builder + electron-updater for desktop binary** (rejected — Spec-027 §7b mandates dual-trust verification, anti-rollback, anti-freeze, and platform-specific swap rules that diverge from electron-updater's Squirrel model).
- **Publish sidecar via GitHub Releases instead of npm** (rejected — [ADR-019 §Decision item 6](019-windows-v1-tier-and-pty-sidecar.md) commits to the `@esbuild/*` distribution pattern).

### Axis 4 alternatives

- **Token-based npm publish + manual `--provenance` flag** (rejected — long-lived `NPM_TOKEN` extends credential surface; Trusted Publishing strictly dominates after [GA 2025-07-31](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)).
- **`npm sbom`** (rejected — CycloneDX 1.5 / SPDX 2.3 only; no pnpm-lockfile parsing).
- **Dependabot only** (rejected — no first-class minimum-release-age; insufficient defense against post-publish-malicious-version compromise families).
- **TruffleHog v3.95+** (rejected — AGPL-3.0 license raises legal-review friction with downstream self-hosters; revisit if false-positive rate becomes operationally painful).
- **pnpm 10 defaults (`minimumReleaseAge: 0`, `blockExoticSubdeps: false`)** (rejected — forfeits documented attack surface that pnpm itself names as the top supply-chain hardening).

### Axis 5 alternatives

- **Apple Developer Program Organization enrollment for V1** (rejected — requires D-U-N-S + legal-entity formation; deferred until post-V1 incorporation. Apple's transferability flow handles eventual upgrade without invalidating prior-signed binaries).
- **Self-signed publisher certificate (Windows)** (rejected — Microsoft SmartScreen page classifies as "strong block — same behavior as unsigned").
- **Microsoft Store distribution** (rejected for V1 primary — Store certification + revenue share + delivery cadence don't fit `git clone` developer-tool category; optional V1.1 secondary).
- **Sigstore keyless for the Ed25519 manifest itself** (rejected — Spec-027 §7b mandates DUAL trust paths; using Sigstore for both collapses to one trust path).
- **Raw Ed25519 private key as GitHub Actions Secret** (rejected — single point of compromise; Trivy 2026-03 incident is direct precedent).
- **YubiHSM-only for every release** (rejected — operationally untenable for routine release cadence; layered hot/cold custody is the pragmatic resolution).

---

## Failure Mode Analysis

| # | Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- | --- |
| **F-1** | **Compromised contributor pushes malicious tag → CI mints valid OIDC token without environment review (axes 1, 3, 5).** Without the environment gate, the OIDC sub-claim is `repo:<org>/<repo>:ref:refs/tags/<tag>`, which a compromised contributor can spoof. | Medium | Critical | GitHub branch-protection event log; environment-deployment audit trail; SmartScreen telemetry shows publisher signing a binary that wasn't reviewed. | **Environment gate** is mandatory: federated credentials bind to `repo:<org>/<repo>:environment:production`. Branch protection requires `ci-gate` to pass + tag pushes to a release branch require `production` environment review-by-`@ai-sidekicks/security`. |
| **F-2** | **Trivy-style PAT theft via `pull_request_target` (axis 4 / axis 5).** Per the [Trivy 2026-03 incident](https://github.com/aquasecurity/trivy), a `pull_request_target` workflow trigger exploited to steal a PAT and inject a credential stealer. | Low–Medium | Critical | Provenance attestation mismatch in `gh attestation verify`; npm `audit signatures` failure on published version; GitHub Audit Log shows PAT use from anomalous IP. | **No long-lived secrets in `secrets.*`** for signing operations. OIDC-only access to KMS / Trusted Publishing. `pull_request_target` workflows scoped to `permissions: read-all`. CI workflows under `CODEOWNERS` `@ai-sidekicks/security`. |
| **F-3** | **Shai-Hulud-class transitive compromise (axis 4).** [Unit 42 documented 1700+ packages affected Sept 2025 → Feb 2026](https://unit42.paloaltonetworks.com/npm-supply-chain-attack/) across four campaign waves; transitive deps silently swap to malicious versions. | Medium (active threat) | High | Renovate cooldown blocks publish window; Socket.dev `shai-hulud-scan` flags PR; `pnpm install` fails with `blockExoticSubdeps: true` if a transitive switches to git-tarball URL. | **`minimumReleaseAge: 1440` + `blockExoticSubdeps: true`** in `pnpm-workspace.yaml` from V1 day 1. Renovate `minimumReleaseAge: 14 days` for automerged updates. Socket.dev GitHub App for PR-time malicious-version analysis. `minimumReleaseAgeExclude` runbook for emergency CVE patches. |
| **F-4** | **Azure Artifact Signing silent CA migration breaks SmartScreen (axis 5).** Per [`Azure/artifact-signing-action#128`](https://github.com/Azure/artifact-signing-action/issues/128), Microsoft silently migrated from `EOC CA 02` to `AOC CA 03` on 2026-03-21/23, triggering "Windows protected your PC" warnings on identical-config builds. | Low (recurrence) | Medium | SmartScreen telemetry post-rotation; user reports of warning prompts on installer download; `Azure/artifact-signing-action` repo issue tracker. | Post-rotation telemetry verification step in release workflow. **Tripwire-2** (per [ADR-019 §Failure Mode Analysis](019-windows-v1-tier-and-pty-sidecar.md)): if Artifact Signing materially breaks SmartScreen reputation again, evaluate switching to EV cert in cloud HSM (DigiCert KeyLocker / SSL.com eSigner / Azure Key Vault Managed HSM) and accept the per-build hash-reputation reset cost. |
| **F-5** | **macos-13 deprecation cascade (axis 1, 3).** GitHub deprecated `macos-13` 2025-12-04 per [`actions/runner-images#13046`](https://github.com/actions/runner-images/issues/13046). Workflows referencing `macos-13` fail at job start. | Already realized 2025-12-04 | Medium (build outage) | Workflow logs show "this image is deprecated"; jobs fail to schedule. | **`macos-15-intel` is the V1 darwin-x64 runner** (last x86_64 macOS runner per [`actions/runner-images#13045`](https://github.com/actions/runner-images/issues/13045), supported through August 2027). Re-evaluate when `macos-15-intel` deprecation lands. |
| **F-6** | **npm Trusted Publishing per-package config drift (axis 3, 4).** Adding a new published package without registering its Trusted Publisher entry fails at publish time. | Medium (process) | Low (loud failure) | `npm publish` exits non-zero with auth error; workflow log clearly attributes to missing trusted-publisher config. | Failure-loud is the right default. Onboarding doc names "register Trusted Publisher before first publish." Bootstrap path: each package must be published once via traditional `NPM_TOKEN` _before_ Trusted Publisher can be configured (npm bootstrap chicken-and-egg). |
| **F-7** | **Husky-class hook regeneration overwrites committed config (axis 2 — N/A under chosen design).** Listed for completeness: [#1574](https://github.com/typicode/husky/issues/1574) / [#1576](https://github.com/typicode/husky/issues/1576) / [#1387](https://github.com/typicode/husky/issues/1387) / [#1398](https://github.com/typicode/husky/issues/1398) describe `pnpm install` regenerating `.husky/_` and overwriting committed hooks. | N/A under lefthook | Would be Medium | Diff on `.husky/_` after `pnpm install`. | **Mitigation by tool choice** — lefthook does not use the `prepare`-script-regenerates-`.husky/_` pattern. Trigger detection only if we ever migrate back to Husky. |
| **F-8** | **Two-ABI native rebuild silent failure (axis 1).** Cached `.node` artifacts could compile against one ABI yesterday and become invalid today after a transitive NAPI bump; daemon and Electron load incompatible native binaries at runtime. | Low–Medium | High | `pnpm rebuild` step fails in CI; Electron launches with cryptic `node-gyp` rebuild errors. | **No native-binary cache** — explicit `pnpm rebuild` runs every CI run on every OS. Cost ~2–3 min per OS leg is the diagnostic budget for [ADR-022's](022-v1-toolchain-selection.md) most load-bearing assumption. |
| **F-9** | **release-please-action breaking change (axis 3).** Major-version bump to v6+ could break manifest-mode behavior or change release-PR shape. | Low | Medium | CI workflow fails after Renovate auto-bumps action version; release PRs stop opening. | Pin to `@v5` major version (not `@latest`); Renovate config excludes major-version bumps from automerge for release-tooling actions. |
| **F-10** | **Sigstore public-good infrastructure outage (axis 4, 5).** Fulcio + Rekor downtime would prevent verification on operator machines. | Low | Medium (verification-side only) | `sigstore.verify` returns transparency-log fetch error; release flow itself can still produce bundles (signing succeeds; verification at consumer fails open / closed depending on Spec-027 implementation). | CLI-side: `sigstore.verify` with `tlogThreshold: 1` accepts cached transparency-log entries. Release flow: bundle is uploaded to GitHub attestations API + GitHub Release asset (redundancy). |

---

## Reversibility Assessment

ADR-023 is **Type 1 (two-way door) NOW** because:

- No signed binaries have shipped to end users yet (greenfield);
- No npm package has been published under any release-tool's tag scheme yet;
- No installed users are trusting any signing key today;
- Configuration changes to `.github/workflows/*.yml`, `lefthook.yml`, `commitlint.config.mjs`, `release-please-config.json`, `pnpm-workspace.yaml` are reversible in a single PR.

### Per-axis time-fuse

The five axes have different reversibility profiles, and **axes 3 and 5 flip from Type 1 to Type 2 the moment V1 ships its first signed release.** Future ADRs amending those domains will need Type 2 treatment.

| Axis | Reversibility today (Type 1) | Time-fuse to Type 2 | Migration path if reversed |
| --- | --- | --- | --- |
| **1 — CI workflow** | Hours (rewrite `ci.yml` + branch-protection rule) | Stays Type 1 — workflow surgery is always reversible. | Replace `.github/workflows/*.yml`; update branch-protection rules; ensure `ci-gate` semantics preserved. |
| **2 — Pre-commit** | Hours (swap `lefthook.yml` for `husky.config`; update onboarding doc) | Stays Type 1 — local dev tooling, no installed-user impact. | Migrate to Husky (or other) by adding `prepare` script + per-hook shell script; commit lock-file changes. |
| **3 — Release automation** | Days now; **flips to Type 2 after first signed release** — replacing the release-tool means re-attesting historical artifacts and republishing manifest schema versions to operators. | First signed Spec-027 §7b release. | Pre-flip: rewrite workflow + manifest assembly. Post-flip: pre-publish migration manifest with `next_signing_keys` from new-tool key; migration window ≥30 days per Spec-027 `expires_at` rule. |
| **4 — Supply-chain** | Hours–days (config-only change in `renovate.json`, `pnpm-workspace.yaml`, action versions) | Stays Type 1 — supply-chain hygiene is policy, reversible by config. | Replace bot configs; rerun SBOM emission; update `.gitleaks.toml`. |
| **5 — Code-signing custody** | Days now; **flips to Type 2 after first signed release** — rotating signing identity post-installed-user requires `next_signing_keys` ceremony, post-rotation telemetry verification, and SmartScreen reputation reset. | First signed Spec-027 §7b release. | Pre-flip: provision new KMS / Apple Dev / Azure Artifact Signing identity; ceremony cost ~hours. Post-flip: 30-day pre-publication via `next_signing_keys`; cold-key counter-sign; CODEOWNERS approval; SmartScreen telemetry verification post-cutover. |

**Point of no return:** First signed V1 release lands publicly. After that point, any change to axis 3 or axis 5 tooling that affects key custody or manifest schema requires the [Spec-027 §7b](../specs/027-self-host-secure-defaults.md) `next_signing_keys` migration ceremony.

---

## Consequences

### Positive

- [Plan-001](../plans/001-shared-session-core.md) Phase 1 ship-gate clears; first code-execution PR can land.
- [Spec-027 §Behavior 7b](../specs/027-self-host-secure-defaults.md) dual-trust verification has a working release-pipeline implementation: Ed25519 manifest signature (cloud-KMS hot-key) AND Sigstore bundle (`actions/attest@v4`), independently verifiable, both required, environment-gated to defeat tag-spoofing under contributor compromise.
- No long-lived signing secrets in `secrets.*`. Every release-time signing operation goes through OIDC federation: GitHub OIDC → AWS IAM (Ed25519 hot-key), GitHub OIDC → Microsoft Entra (Azure Artifact Signing), GitHub OIDC → Sigstore Fulcio (Linux keyless), GitHub OIDC → npmjs.com (Trusted Publishing). The Trivy 2026-03 PAT-theft attack vector is structurally unavailable.
- [ADR-019 §Decision items 6–8](019-windows-v1-tier-and-pty-sidecar.md) compose cleanly: the 5-platform sidecar build matrix is shared between Axis 1's CI and Axis 3's release; the same Azure Artifact Signing identity covers Electron app + sidecar binaries for SmartScreen reputation pooling; sidecar packages publish under the same Trusted Publishing configuration as the workspace npm packages.
- [ADR-022 §Decision row 8](022-v1-toolchain-selection.md) two-tier Node target survives intact — release CI runs Node 24 (control-plane tier), daemon stays at 22.12+.
- `actions/attest@v4` unifies the attestation surface across Axis 3 (binary release), Axis 4 (npm provenance + SBOM), and Axis 5 (signing custody). The deprecated wrappers (`actions/attest-build-provenance`, `actions/attest-sbom`) appear only in onboarding breadcrumbs.

### Negative (accepted trade-offs)

- **Three signing-key custodies for V1.** Apple Developer ID (macOS notarization), Azure Artifact Signing identity (Windows + sidecar), Ed25519 hot-key (cloud KMS) + cold-key (YubiHSM, offline). Each has a distinct rotation procedure. Mitigation: each is single-purpose, exercised by a single small workflow step gated by an environment, and rotation procedures are bounded by `next_signing_keys` ≥30-day pre-publication.
- **Per-package npmjs.com Trusted Publisher registration ceremony.** 7 packages (2 workspace + 5 sidecar) × manual UI configuration × per-package 2FA. One-time cost, but real work; cannot be automated through npm's UI as of 2026-04. Bootstrap: each package must be published once via traditional `NPM_TOKEN` _before_ Trusted Publisher can be configured.
- **Self-hosted Turborepo Remote Cache operational cost.** [ADR-022 §Decision row 2](022-v1-toolchain-selection.md) commits to this; `ducktors/turborepo-remote-cache` deployed in our infrastructure with HMAC ≥32 bytes (`TURBO_REMOTE_CACHE_SIGNATURE_KEY`).
- **`actions/attest-build-provenance` and `actions/attest-sbom` are wrappers.** New code targets `actions/attest@v4` directly. Cosmetic, but workflows look slightly less recognizable than the brand-name actions.
- **lefthook smaller ecosystem footprint than Husky.** ~5× smaller weekly downloads → fewer Stack-Overflow / AI-training-data hits when debugging unusual configs. Mitigated by lefthook being out-of-band for hook-script content (commands are language-agnostic shell invocations).
- **`minimumReleaseAge: 1440` blocks installs of brand-new packages for 24 hours.** Mitigated via `minimumReleaseAgeExclude` for named CVE-fix versions; operator runbook step required when an emergency patch lands.

### Unknowns

- **Linux apt/yum hosted repository GPG signing strategy.** Deferred to V1.1 per [Spec-027 §Open Questions](../specs/027-self-host-secure-defaults.md). When V1.1 lands, ADR-023 (or a successor) will name GPG key custody (likely Ed25519 GPG in cloud KMS) and reprepro/rpmsign integration. Debian archive-keyring dual-sign-during-rotation precedent applies.
- **Azure Artifact Signing CA migration cadence.** [`Azure/artifact-signing-action#128`](https://github.com/Azure/artifact-signing-action/issues/128) demonstrates Microsoft can silently migrate the upstream CA. Tripwire-2 evaluation will fire if that recurs and breaks SmartScreen reputation in production.
- **pnpm 11 GA date.** [pnpm 11.0.0-rc.5](https://github.com/pnpm/pnpm/releases) is current as of 2026-04-21; once stable lands, `engines.pnpm` floor shifts and our V1-day-1 hardening flags become defaults (no behavioral change).
- **Apple Organization enrollment timeline.** Tied to legal-entity formation post-V1; until then, Developer ID cert subject CN reads as the named maintainer. Migration cost is one-time re-key + re-notarize; older signed binaries remain valid.

---

## Re-Evaluation Triggers

Per axis, the conditions that force a fresh look at this ADR:

- **Axis 1 — CI workflow.** (1) `macos-15-intel` deprecation announcement (Aug-2027 tentative). (2) GitHub Actions adds free public-repo arm64 Linux runners (`ubuntu-24.04-arm` pricing change). (3) Turborepo deprecates the v8 remote-cache HTTP API or the `ducktors/turborepo-remote-cache` project becomes unmaintained.
- **Axis 2 — Pre-commit.** (1) Husky 10 (or successor) ships a fix for the four pnpm/Windows hook-regeneration bugs ([#1574](https://github.com/typicode/husky/issues/1574), [#1576](https://github.com/typicode/husky/issues/1576), [#1387](https://github.com/typicode/husky/issues/1387), [#1398](https://github.com/typicode/husky/issues/1398)) AND adds first-class parallel hooks. (2) lefthook upstream changes the `npm-installer` postinstall-binary download contract.
- **Axis 3 — Release automation.** (1) [`changesets/action#515`](https://github.com/changesets/action/issues/515) merges (split version-PR + publish workflows natively), making changesets a viable replacement for `release-please`. (2) Spec-027 amends §Behavior 7b's manifest schema. (3) npm Trusted Publishing deprecates or changes its OIDC trust policy. (4) ADR-022 lifts the Node 22.12+ floor and the daemon's tier matches the release-CI tier.
- **Axis 4 — Supply-chain.** (1) Renovate self-host operational cost becomes prohibitive (switch to Dependabot fallback). (2) GitHub native secret-scanning custom-pattern free-tier expansion (revisit paid Secret Protection). (3) TruffleHog re-licenses or AGPL-incompatibility friction with downstream operators is resolved differently.
- **Axis 5 — Code-signing.** (1) Apple Organization enrollment becomes practical (legal-entity formation post-V1) — migrate Developer ID cert subject. (2) Tripwire-2 fires: Azure Artifact Signing materially breaks SmartScreen reputation again — switch to EV cert in cloud HSM. (3) AWS KMS Ed25519 service availability changes (FIPS validation lapse, region restriction). (4) YubiHSM 2 FIPS 140-3 validation status changes (current FIPS 140-2 valid through 2026-05-02; FIPS 140-3 expected Q2 2026).

---

## References

### Research Conducted

Primary sources consulted during ADR-023 research, surfaced forward from transient subagent research artifacts (`.agents/tmp/research/adr-023-ci-cd/axis-{1..5}-*.md`) per [AGENTS.md](../../AGENTS.md) "Surface-Forward-Then-Delete." All fetches dated 2026-04-26.

#### Axis 1 — CI workflow

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| GitHub Actions — Control workflow concurrency | Documentation | Concurrency: at most one running and one pending job per group; pending cancelled on new arrival. | <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency> |
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
| `rust-cross/cargo-zigbuild` | Documentation | Can target `*-apple-darwin` from Linux given a macOS SDK; Apple `codesign`/`notarytool` only run on macOS. | <https://github.com/rust-cross/cargo-zigbuild> |
| Electron — Native Node Modules | Documentation | "Electron has a different application binary interface (ABI) from a given Node.js binary." | <https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules> |
| GitHub Community Discussion #26822 — matrix branch protection | GitHub-issue | Aggregator-job pattern (`if: always()`, `needs:`-shell-check) is canonical for matrix branch protection. | <https://github.com/orgs/community/discussions/26822> |
| GitHub Docs — Required status checks (branch protection) | Documentation | Matrix-leg names embed strategy values; renaming silently bypasses protection. | <https://docs.github.com/en/repositories/configuring-branch-and-merge-management/managing-protected-branches/managing-a-branch-protection-rule> |

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
| Lefthook install docs | Documentation | "Standalone, no-deps binary"; `lefthook self-update`. | <https://lefthook.dev/install.html> |
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

#### Axis 3 — Release automation

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| npm Docs — Trusted Publishers | Documentation | Requires npm CLI ≥11.5.1, Node ≥22.14.0; `id-token: write`; provenance auto-emitted. | <https://docs.npmjs.com/trusted-publishers/> |
| npm Docs — Generating Provenance Statements | Documentation | Trusted Publishing → no `--provenance` flag needed; `npm audit signatures` for verify. | <https://docs.npmjs.com/generating-provenance-statements/> |
| GitHub Changelog — npm Trusted Publishing GA | Vendor-announcement | OIDC trusted publishing GA 2025-07-31. | <https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/> |
| `actions/attest` README | Documentation | Permissions `id-token: write` + `attestations: write`; predicate-type provenance/SBOM/custom; output Sigstore bundle. | <https://github.com/actions/attest> |
| `actions/attest-build-provenance` releases | Documentation | v4.x is "simply a wrapper on top of `actions/attest`"; new code targets `actions/attest@v4`. | <https://github.com/actions/attest-build-provenance/releases> |
| GitHub Docs — Using artifact attestations | Documentation | Required permissions for binaries: `id-token: write`, `contents: read`, `attestations: write`. | <https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds> |
| `gh attestation verify` reference | Documentation | Validates `SourceRepository`/`SubjectAlternativeName`; default predicate `https://slsa.dev/provenance/v1`. | <https://cli.github.com/manual/gh_attestation_verify> |
| `sigstore` npm client README | Documentation | Public API `sign`/`attest`/`verify`; auto-detects GitHub Actions for OIDC. | <https://raw.githubusercontent.com/sigstore/sigstore-js/main/packages/client/README.md> |
| `npm/provenance` repo | Documentation | npm provenance = SLSA in-toto attestation in Sigstore bundle (v0.1/v0.2). | <https://github.com/npm/provenance> |
| semantic-release GitHub Actions recipe | Documentation | Permissions `contents`/`issues`/`pull-requests`/`id-token: write`; OIDC for Trusted Publishing. | <https://semantic-release.gitbook.io/semantic-release/recipes/ci-configurations/github-actions> |
| `changesets/action` README | Documentation | v1.7.0 (2026-02-12); README's only auth path is `NPM_TOKEN`; no native OIDC. | <https://github.com/changesets/action> |
| `changesets/action#515` (split-workflow OIDC ask) | GitHub-issue | Open issue: action conflates version-PR + publish; OIDC needs dedicated publish file. | <https://github.com/changesets/action/issues/515> |
| `release-please-action` README | Documentation | v5.0.0 (2026-04-22); two-step pattern: release-PR job + downstream `if: release_created` publish. | <https://github.com/googleapis/release-please-action> |
| `release-please` manifest releaser docs | Documentation | Single `release-please-config.json` + `.release-please-manifest.json`; per-package overrides. | <https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md> |
| Trivy supply-chain compromise (2026-03 PAT theft) | Vendor-announcement | `pull_request_target` exploited to steal PAT and inject credential stealer; precedent for OIDC-only signing. | (see Axis 5 row `Trivy 2026-03 incident`) |

#### Axis 4 — Supply-chain hygiene

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Anchore Syft repo | Documentation | v1.43.0 (2026-04-22); Apache-2.0; pnpm cataloger present (anchore/syft PR-#4765). | <https://github.com/anchore/syft> |
| `cyclonedx/cyclonedx-node-pnpm` (archived) | Documentation | Repository archived 2026-02-25; pnpm absorbed CycloneDX SBOM generation natively. | <https://github.com/CycloneDX/cyclonedx-node-pnpm> |
| pnpm settings reference | Documentation | `minimumReleaseAge` (v10.16); `blockExoticSubdeps` (v10.26); `allowBuilds` replaces `onlyBuiltDependencies`. | <https://pnpm.io/settings> |
| pnpm releases | Documentation | pnpm 10.33.2 (2026-04-23); 11.0.0-rc.5 flips `minimumReleaseAge: 1440` + `blockExoticSubdeps: true` defaults. | <https://github.com/pnpm/pnpm/releases> |
| pnpm "Protecting Our Newsroom" blog | Vendor-announcement | Seattle Times pilot: layered defenses (`strictDepBuilds` + `onlyBuiltDependencies` + `minimumReleaseAge` + `trustPolicy: no-downgrade`). | <https://pnpm.io/blog/2025/12/05/newsroom-npm-supply-chain-security> |
| Unit 42 Shai-Hulud writeup | Audit-report | First published 2025-09-17; multiple campaign waves through Feb 2026; 1700+ packages affected. | <https://unit42.paloaltonetworks.com/npm-supply-chain-attack/> |
| CISA Shai-Hulud alert | Vendor-announcement | Widespread-supply-chain-compromise alert 2025-09-23. | <https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem> |
| Dependabot pnpm catalogs GA | Vendor-announcement | pnpm-workspace catalog support GA 2025-02-04. | <https://github.blog/changelog/2025-02-04-dependabot-now-supports-pnpm-workspace-catalogs-ga/> |
| Renovate `minimumReleaseAge` docs | Documentation | Format `"14 days"`; preset `security:minimumReleaseAgeNpm` (3-day floor); 14-day automerge floor recommended. | <https://docs.renovatebot.com/key-concepts/minimum-release-age/> |
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
| `npm sbom` command docs | Documentation | npm CLI v11; CycloneDX 1.5 / SPDX 2.3; no pnpm-lockfile parsing. | <https://docs.npmjs.com/cli/v11/commands/npm-sbom/> |
| CycloneDX CLI repo | Documentation | v0.30.0 (2026-02-10); Apache-2.0; converter/validator/signer/merger; does NOT generate from lockfiles. | <https://github.com/CycloneDX/cyclonedx-cli> |

#### Axis 5 — Code-signing custody

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Microsoft — Artifact Signing FAQ | Documentation | Rebranded canonical product (resource provider `Microsoft.CodeSigning`); FIPS 140-2 L3; eligibility USA/Canada/EU/UK orgs + USA/Canada individuals; Free/Trial subs cannot register. | <https://learn.microsoft.com/en-us/azure/artifact-signing/faq> |
| Microsoft — Artifact Signing trust models | Documentation | Public Trust certs from Microsoft Identity Verification Root CA 2020; supports Win32/Smart App Control/`/INTEGRITYCHECK`/VBS enclaves. | <https://learn.microsoft.com/en-us/azure/artifact-signing/concept-trust-models> |
| Microsoft — Artifact Signing pricing | Documentation | $9.99/mo for 5,000 sigs + 1 cert profile; $99.99/mo for 100,000 sigs + 10 profiles. | <https://azure.microsoft.com/en-us/pricing/details/artifact-signing/> |
| Microsoft Learn — SmartScreen reputation for Windows app developers | Documentation | "SmartScreen reputation is per file hash — every new build of your app starts with zero reputation." (2026-04-17 update) | <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation> |
| `Azure/artifact-signing-action#128` | GitHub-issue | 2026-03-21/23 silent CA migration `EOC CA 02` → `AOC CA 03` triggered SmartScreen warnings on identical-config builds. | <https://github.com/Azure/artifact-signing-action/issues/128> |
| Apple Developer Program — Enroll | Documentation | Individual: $99/yr, no D-U-N-S; Organization: $99/yr + D-U-N-S + legal entity. | <https://developer.apple.com/programs/enroll/> |
| Apple Developer Program — D-U-N-S Number | Documentation | D-U-N-S required for Org enrollment; 9-digit Dun & Bradstreet identifier; free. | <https://developer.apple.com/help/account/membership/D-U-N-S/> |
| AWS — KMS Edwards-curve Digital Signature Algorithm | Vendor-announcement | 2025-11 GA: AWS KMS supports EdDSA (Ed25519) for asymmetric keys; private key never leaves KMS. | <https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/> |
| AWS — KMS Key spec reference | Documentation | Asymmetric key specs include Ed25519 (Edwards Curve); HSM protection always available. | <https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html> |
| Azure Key Vault — Key types, algorithms, operations | Documentation | Managed HSM supports Ed25519 (FIPS 140-3 L3). | <https://learn.microsoft.com/en-us/azure/key-vault/keys/about-keys-details> |
| Google Cloud KMS — Key purposes and algorithms | Documentation | Curve25519 PureEdDSA; HSM protection level FIPS 140-2 L3. | <https://docs.cloud.google.com/kms/docs/algorithms> |
| GitHub Docs — Configuring OpenID Connect in Azure | Documentation | OIDC flow GitHub Actions JWT → Microsoft Entra federated credential (sub-claim binds repo + workflow + environment). | <https://docs.github.com/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-azure> |
| Microsoft Learn — Authenticate to Azure from GitHub Actions by OIDC | Documentation | Trust setup: Entra app registration → service principal → role assignment + federated credential. | <https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect> |
| Sigstore Blog — Cosign Verification of npm Provenance, GHA Attestations, Homebrew | Vendor-announcement | Cosign v2.4.0+ verifies all three in same Sigstore bundle format; `cosign verify-blob-attestation --new-bundle-format`. | <https://blog.sigstore.dev/cosign-verify-bundles/> |
| Sigstore Docs — Cosign signing overview | Documentation | Keyless = ephemeral keypair + OIDC → Fulcio short-lived cert → Rekor; `COSIGN_EXPERIMENTAL` removed. | <https://docs.sigstore.dev/cosign/signing/overview/> |
| Sigstore — Cosign GitHub releases | Documentation | Cosign v3.x+ standardized Sigstore bundle format; .deb/.rpm provided. | <https://github.com/sigstore/cosign/releases> |
| CA/Browser Forum — Code Signing Baseline Requirements | RFC | Effective 2023-06-01: code-signing keys MUST be in FIPS 140-2 L2+ or CC EAL 4+ HSM (EV and OV); non-exportable. | <https://cabforum.org/working-groups/code-signing/requirements/> |
| CA/Browser Forum — Baseline Requirements v3.7 PDF | RFC | CSBR §6.2.7 subscriber private-key protection; compliant cloud-HSM list (AWS CloudHSM, Azure Dedicated/Managed/Key Vault, GCP HSM, IBM, Luna). | <https://cabforum.org/uploads/Baseline-Requirements-for-the-Issuance-and-Management-of-Code-Signing.v3.7.pdf> |
| SSL.com — Which Code Signing Certificate (CSBR ballot) | Vendor-announcement | 2026-02-23: max validity reduced to 459 days; SSL.com enforced 2026-02-27. | <https://www.ssl.com/faqs/which-code-signing-certificate-do-i-need-ev-ov/> |
| DigiCert KeyLocker | Vendor-announcement | Cloud-based FIPS 140-2 L3 HSM for code signing; 1 KeyLocker = 1000 ops. | <https://docs.digicert.com/en/digicert-keylocker.html> |
| Apple — `electron/notarize` README | Documentation | Auth options: App Store Connect API key (recommended) / Apple ID + app-specific password / keychain. | <https://github.com/electron/notarize> |
| Yubico — YubiHSM 2 User Guide | Vendor-announcement | Ed25519 sign/verify; FIPS 140-2 valid through 2026-05-02; FIPS 140-3 expected Q2 2026. | <https://docs.yubico.com/hardware/yubihsm-2/hsm-2-user-guide/webdocs.pdf> |
| Apache Software Foundation — License v2.0 | Documentation | Apache-2.0 redistribution requirements; permissive; explicit patent grant §3. | <https://www.apache.org/licenses/LICENSE-2.0> |

### Related ADRs and Specs

- [ADR-001](001-session-is-the-primary-domain-object.md) — first-class session primitive (every release artifact is session-recoverable through Plan-001).
- [ADR-016](016-electron-desktop-shell.md) — Electron shell forces the daemon's Node 22 floor, which interacts with [ADR-022](022-v1-toolchain-selection.md)'s two-tier Node target and Axis 3's release CI Node 24 selection.
- [ADR-019](019-windows-v1-tier-and-pty-sidecar.md) — §Decision item 6 (5-platform sidecar packaging via `@esbuild/*` pattern), item 7 (Windows code-signing custody — Azure Artifact Signing preferred / EV cert fallback), item 8 (SmartScreen reputation pooling under shared signer identity). ADR-023 axis 5 is the signing-custody overlay; ADR-019 remains the canonical sidecar-distribution doc.
- [ADR-020](020-v1-deployment-model-and-oss-license.md) — Apache-2.0 OSS license stance (forces Axis 4's TruffleHog deferral on AGPL grounds).
- [ADR-022](022-v1-toolchain-selection.md) — pnpm 10.33+, Turborepo 2.9+, ESLint 10, Vitest 4, two-tier Node 22.12+/24.x. CI job graph is named there as a success criterion; ADR-023 builds out the workflow files.
- [Spec-011](../specs/011-gitflow-pr-and-diff-attribution.md) — product-side gitflow (`GitHostingAdapter`, `BranchContextRead`, `createChangeRequest`, `PRPrepare`). ADR-023 axis 2's engineering-side `<type>/<topic>` branch shape (amended 2026-04-26) is disjoint from Spec-011's `run/<run-id>/<topic>` via type-prefix (`feat/...` vs `run/...`).
- [Spec-027](../specs/027-self-host-secure-defaults.md) — §Behavior 7b release-manifest schema and dual-trust verification path (Ed25519 + Sigstore). ADR-023 axes 3 and 5 are the implementation primitives for the §7b governance constraint.
- [Plan-001](../plans/001-shared-session-core.md) — first code-execution PR; ship-gate consumer of Axis 1's CI surface and Axis 3's release surface.

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-04-26 | Accepted | Initial author + acceptance per [BL-100](../backlog.md) exit criteria. Five-axis composition synthesized from primary-source research; all citations dated 2026-04-26. Drift findings surfaced inline: `macos-13` deprecation → `macos-15-intel` (Axis 1, 3); Husky 9.1.7 / lefthook 2.1.6 / commitlint 20.5.2 (Axis 2); Trusted Publishing Node ≥22.14 vs ADR-022 Node 22.12+ floor → release CI runs Node 24 (Axis 3). Type 1 classification confirmed on greenfield grounds; per-axis time-fuse to Type 2 documented in §Reversibility. |
| 2026-04-26 | Amended (§Axis 2) | Engineering-side branch shape simplified from `<type>/<scope>/<topic>` (3-segment) to `<type>/<topic>` (2-segment) per upstream [Conventional Branch](https://conventional-branch.github.io/). Rationale: the package-scope segment duplicated the package noun already carried in the conventional-commit subject (`feat(daemon): ...`); two-segment branches read more naturally and match the upstream spec without local extension. Disjoint property with Spec-011's `run/<run-id>/<topic>` is preserved at the type-prefix level (`feat/...` vs `run/...`). Reversibility unchanged (Type 1, axis 2 still time-fused to Type 2 only after first signed V1 release). Operationalized via [`CONTRIBUTING.md`](../../CONTRIBUTING.md). |
| 2026-04-26 | Amended (§Axis 1, §Axis 3) | Branch model shifted from trunk-based (`main` only) to GitFlow-lite (`main` + `develop`). Engineering-side feature branches now off `develop`; squash-merge target is `develop`; `develop` → `main` only at release time. Driver: stable `main` for release commits, `develop` integration branch where features accumulate. §Axis 1 amended: event-split concurrency now treats `develop` and `main` as integration branches (PRs cancel-in-progress, integration-branch pushes do not); branch protection applies to both. §Axis 3 amended: `release-please-action` observes `develop` (the integration branch); release tags ultimately land on `main`; exact `release-please-config.json` settings finalized in Plan-001 Phase 1 during `release.yml` authoring. Reversibility unchanged (Type 1, axes 1 + 3 still time-fused to Type 2 only after first signed V1 release). Operationalized via [`CONTRIBUTING.md`](../../CONTRIBUTING.md) Branch Model section. |
