# Backlog

## Purpose

This file is the active development backlog for the product defined in [vision.md](./vision.md).

## How To Use This Backlog

- Add items only when they represent real remaining work.
- Link every item to the governing spec, plan, ADR, or operations doc where possible.
- Keep items outcome-oriented. A backlog item should describe a deliverable, not a vague area of concern.
- Remove or rewrite stale items instead of letting the file become a historical log.
- When work is complete, update the canonical docs it depends on first, then move the item to [Backlog Archive](./archive/backlog-archive.md).
- If information in a backlog item becomes durable product truth, move that information into the canonical docs and keep only the remaining work here.

## Status Values

- `todo`
- `in_progress`
- `blocked`
- `completed`

## Priority Values

- `P0` — blocks all implementation or blocks a critical feature
- `P1` — blocks a specific feature or must resolve before v1
- `P2` — should resolve before v1 ship
- `P3` — should resolve before v1 ship; lower urgency than `P2` (revisit-trigger BLs, post-v1-polish surfaces, deferred-but-tracked enhancements). Active P3 usage: BL-110 (housekeeper gate promotion); archive entries BL-115/116/117/119/120/121 all closed at P3. Uniform semantics: "tracked but not blocking" across every active and closed P3 entry.

---

## Item Template

Use this shape for new backlog items:

```md
### BL-0XX: Short Title

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Relevant Spec](./specs/000-spec-template.md), [Relevant Plan](./plans/000-plan-template.md)
- Summary: One or two sentences describing the deliverable or change.
- Exit Criteria: Concrete condition that makes this item complete.
```

---

## Active Items

The items below were surfaced by the [plan-readiness-audit Tier 1](./operations/plan-implementation-readiness-audit-runbook.md) audit (commit `05125dc`, 2026-04-28). Each tracks a cross-cutting governance amendment that the Tier 1 plan amendments deferred via `BLOCKED-ON-CN` tags. Resolution unblocks the corresponding Tier 1 plan content for first-code-execution PRs. BL-104 (C-4 — ADR-014 runtime authorization reconciliation) resolved 2026-04-30 and archived. BL-101 (C-3 — Plan-023 Tier-8 substrate carve-out from Tier 1) resolved 2026-04-30 via path (1) Plan-023 Tier 1 Partial carve-out and archived. BL-102 (C-6 — JSON-RPC handshake `protocolVersion` ISO 8601 date-string), BL-103 (C-7 — JSON-RPC two-layer error envelope per RFC 7807 + LSP 3.17), and BL-105 (C-8 + C-9 — Spec-006 `membership.created` + `security.*` registrations) resolved 2026-05-01 and archived. BL-107 (C-13 + C-2 — cross-plan-deps.md §3 missing edges + §2 ownership rows) resolved 2026-05-01 via the cross-plan-deps audit pass and archived.

### BL-108: Plan-024 Windows + macOS signing procurement evidence

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Plan-024](./plans/024-rust-pty-sidecar.md) §Preconditions + Phase 4 (T-024-4-3), [ADR-019](./decisions/019-windows-v1-tier-and-pty-sidecar.md) §Decision item 8, [ADR-023](./decisions/023-v1-ci-cd-and-release-automation.md) §Axis 5, [Spec-023](./specs/023-desktop-shell-and-renderer.md) §macOS
- Summary: Procurement evidence record for Plan-024 signing-identity gates (per F-024-4-06). Four artifacts: (a) Microsoft eligibility-determination response (Track A) OR vendor procurement contract + token-shipment confirmation (Track B); (b) signing-identity attestation matching Spec-023's Electron shell per ADR-019 §Decision item 8 + ADR-023 §Axis 5; (c) Plan-024 §Decision Log entry naming the chosen track + date; (d) macOS Developer ID Application certificate procurement evidence (cert thumbprint + team-ID + Apple Developer enrollment-confirmation email).
- V1 Release Impact: Does NOT block V1 release. V1 distributes via GitHub Releases — the Electron desktop shell (delivered via Plan-023, Tier 8) and the PTY sidecar binary (Plan-024) function on macOS and Windows without code-signing certificates. Users encounter a one-time first-launch macOS Gatekeeper / Windows SmartScreen security warning that is bypassable via documented instructions (macOS: right-click the app → Open, OR System Settings → Privacy & Security → "Open Anyway"; Windows: "More info" → "Run anyway" on the SmartScreen dialog); distributing unsigned OSS Electron apps via GitHub Releases is a well-established pattern. The PTY sidecar is a daemon-spawned subprocess — the user-launched Gatekeeper/SmartScreen flow applies primarily to the Electron app installer (.dmg / .exe), not the sidecar binary. Cert procurement (the four artifacts above) is therefore a post-V1 UX-polish surface: certificates can be applied for and obtained when budget and timeline align, and the Plan-024 Phase 4 signing implementation activates on top of the existing GitHub-Releases distribution once certs are available. Tier 1 closure does NOT gate on this BL.
- Exit Criteria: All four artifacts attached; Plan-024 §Decision Log records the Windows signing-track choice + date; Plan-024 Phase 4 Preconditions row flips checked.

### BL-110: Promote post-merge housekeeper from advisory hook to merge-queue gate

- Status: `todo`
- Priority: `P3`
- Owner: `unassigned`
- References:
  - PR #34 squash `d3f08e3` (preflight Gate 3 hardening — exposed the housekeeper SPOF in the post-PR-34 architectural discussion)
  - [`.claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs`](../.claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs) — current post-merge invocation point
  - [`.claude/skills/plan-execution/references/post-merge-housekeeper-contract.md`](../.claude/skills/plan-execution/references/post-merge-housekeeper-contract.md) — script contract
  - [`.claude/agents/plan-execution-housekeeper.md`](../.claude/agents/plan-execution-housekeeper.md) — subagent contract (Phase E of /plan-execution)
  - [ADR-023 §Axis 2](./decisions/023-v1-ci-cd-and-release-automation.md) — gate-vs-detector classification (gates fail-closed, drift detectors warn)
- Summary: The post-merge housekeeper is the only code path that writes shipment-state side effects (cross-plan-deps §6 ready-set re-derivation, line-cite sweep, set-quantifier reverification, NS-XX auto-create, completion-prose composition) and — under the future shipment-manifest refactor surfaced post-PR-34 — would also be the sole writer of any per-plan task shipment manifest. Today it runs as a post-merge hook with no enforcement: if it crashes, runs with a bug, or doesn't run at all (manual `--bypass-checks` merge, CI misconfiguration, future PR disabling the action), the manifest silently drifts from git history. Three architectural fixes are viable, in increasing robustness: (a) **housekeeper-as-CI-gate** — run inside the merge-queue check, not post-merge, so PRs cannot merge unless housekeeper succeeds; converts silent drift to loud merge-block. (b) **self-healing preflight** — preflight detects manifest staleness (latest merged PR newer than latest manifest entry) and invokes housekeeper rebuild before proceeding; manifest becomes a cache, ground truth stays git. (c) **two-phase manifest commit** — PR template includes a manifest-entry placeholder; housekeeper validates and persists post-merge. (a) is the lowest-cost-highest-leverage path; (b) and (c) layer on top if needed.
- Exit Criteria: One of (a)/(b)/(c) lands as the housekeeper invocation contract; ADR-023 §Axis 2 (or successor ADR) reclassifies the housekeeper from drift-detector to gate where applicable; the housekeeper's failure mode is "loud merge-block" rather than "silent post-merge drift" for any field that downstream tooling reads as authoritative; `--rebuild-from-git` recovery mode remains available as the escape hatch.
- Revisit Trigger: Any one of — (1) second author joins the repo (multi-author race risk on the manifest file); (2) housekeeper fails in practice for the first time (concrete failure-mode signal); (3) V2 planning starts (good window for infrastructure refactor before adding new write paths); (4) shipment-manifest refactor (the larger Gate 3 architecture work surfaced post-PR-34) is sequenced for delivery — the manifest write path is the most critical new field that benefits from gate-class enforcement.

### BL-112: Plan-007 + Plan-025 Ed25519 release-manifest signing custody procurement evidence

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-027](./specs/027-self-host-secure-defaults.md) §Required Behavior row 7b + §Interfaces And Contracts (release manifest schema), [ADR-023](./decisions/023-v1-ci-cd-and-release-automation.md) §Axis 5 items 4 and 5, [Plan-007](./plans/007-local-ipc-and-daemon-control.md) (daemon-side `self-update` Sigstore + Ed25519 dual-verification), [Plan-025](./plans/025-self-hostable-node-relay.md) (relay CLI `self-update`), [BL-108](#bl-108-plan-024-windows--macos-signing-procurement-evidence) (distinct code-signing-cert procurement; this BL covers a separate manifest-signing-key custody track that BL-108 does not own)
- Summary: Procurement-evidence record for the Spec-027 §7b release-manifest dual-trust signing infrastructure. BL-108 covers binary code-signing certificates (Apple Developer ID + Windows track) only; this entry tracks the orthogonal Ed25519 manifest-signing key custody specified by ADR-023 §Axis 5 items 4 and 5 — an [AWS KMS Ed25519 hot key](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/) (GA 2025-11-07; `KeySpec = ECC_NIST_EDWARDS25519`; ~$12.02/yr single-region custody-dominated) accessed via [GitHub Actions OIDC federated credential to AWS IAM](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect) for routine releases, plus a [YubiHSM 2 standard-variant cold key ($650 one-time)](https://www.yubico.com/product/yubihsm-2/) in sole-maintainer custody for `next_signing_keys` rotation announcements and the `version=1` bootstrap manifest. Procurement is intentionally deferred until V1 is production-release-ready (no payments or applications initiated against this entry while V1 hardening is in flight). Sole-maintainer custody is the V1 model; multi-maintainer key-recovery custody is out of scope and tracked as a separate future backlog item to be opened when a second author joins the project.
- Exit Criteria: All four artifacts attached or hash-recorded under this entry — (a) YubiHSM 2 standard-variant procurement evidence (order confirmation + device serial number + first-power-on initialization timestamp); (b) AWS KMS Ed25519 key creation evidence (key ARN + key creation timestamp + attached KMS key policy with a `kms:Sign` statement conditioned on `"kms:SigningAlgorithm": "ED25519_SHA_512"` + matching IAM identity policy on the federated role with the same `kms:SigningAlgorithm` condition on `kms:Sign` for defense-in-depth (the `kms:SigningAlgorithm` key is a KMS service condition evaluated by KMS at `Sign`/`Verify` authorization time, **not** by STS at role-assume time, so it must live in the key policy and/or identity policy, never in the role's trust policy) + a GitHub Actions workflow run ID demonstrating a successful end-to-end Sign + verify against a test manifest); (c) GitHub Actions → AWS OIDC federation evidence (AWS IAM identity-provider thumbprint + repository-level OIDC subject-claim customization configured via `PUT /repos/{owner}/{repo}/actions/oidc/customization/sub` with `use_default: false`, `use_immutable_subject: true` per the [immutable-subject-claims format enforcing 2026-06-18](https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/) for repo-ID binding, and an `include_claim_keys` array combining repository, environment, and ref context — the combined `sub` is required because default GitHub OIDC tokens emit only one context per claim (e.g. `repo:OWNER/REPO:environment:production` OR `repo:OWNER/REPO:ref:refs/heads/main`, not both), so the federation `StringEquals` condition is unreachable without the customization step + the AWS IAM federated-credential `sub` condition pinned to the literal `sub` value emitted by a test workflow run in the `production` environment on `main` after the customization is applied (record the emitted `sub` from the token introspection step of the test run; do not hand-assemble the value, since the exact join format depends on which `include_claim_keys` names GitHub accepts at the time of configuration) + `aws-actions/configure-aws-credentials` pinned to a commit SHA rather than the `@v6` floating tag); (d) first-key rotation rehearsal evidence (test-cutover ceremony walkthrough demonstrating the ADR-023 §Axis 5 item 5 dual-sign procedure — `next_signing_keys` pre-published ≥30 days ahead, current hot key signs the rotation manifest, cold YubiHSM 2 counter-signs the rotation announcement, transition-period dual-sign works end-to-end). When all four artifacts are recorded, Plan-007 and Plan-025 release-manifest verification implementations have run green against signatures produced under this custody contract, and Spec-027 §7b's release-manifest schema fields (`version`, `released_at`, `expires_at`, `previous_manifest_hash`, `next_signing_keys`) have been exercised against a real signed manifest, this item is closeable.

### BL-120: Plan-002 Phase 4 invite-endpoint rate-limit wiring (Tier 6 deferral)

- Status: `blocked` (until Plan-021 ships at Tier 6)
- Priority: `P2`
- Owner: `unassigned`
- References: [Plan-002 §Cross-Plan Obligations CP-002-3](./plans/002-invite-membership-and-presence.md#cross-plan-obligations), [Plan-002 Phase 4](./plans/002-invite-membership-and-presence.md), [Plan-021 §tRPC middleware surface (Plan-008 consumer)](./plans/021-rate-limiting-policy.md), [cross-plan-dependencies.md §3 Plan-002 → Plan-021 edge](./architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph), F-002-4-02, F-002-4-04, F-002-4-05 (audit critical findings)
- Summary: Plan-002 Phase 4 (invite-endpoint rate-limit wiring) is structurally deferred from Tier 2 to Tier 6 because Plan-021 ships the `rateLimitProcedure` middleware factory at Tier 6. At Tier 6, Plan-002 Phase 4 applies `rateLimitProcedure({endpoint: 'invite.create' | 'invite.accept' | 'invite.revoke' | …})` middleware to the invite tRPC procedures defined in Phase 2's `invite-service.ts` surface, plus adds rate-limit verification tests asserting threshold breach returns the canonical 429 + `RateLimitResponse` shape per Plan-021's canonical contract. The Tier 6 deliverable closes Spec-002 §Rate Limiting (20/session/hr, 50/participant/hr, 100 pending/session).
- Exit Criteria: Plan-002 Phase 4 Tasks T4.1 + T4.2 executed at Tier 6; invite-endpoint rate-limit tests pass against Plan-021's middleware.

### BL-122: Turborepo remote-cache wiring

- Status: `todo`
- Priority: `P3`
- Owner: `unassigned`
- References: [ADR-023 §Axis 2](./decisions/023-v1-ci-cd-and-release-automation.md); Tier 1 closing audit A10 G-2
- Summary: ADR-023 §Axis 2 names Turborepo remote-cache as a future wall-clock-reduction lever but no BL tracks it. Wire a remote-cache provider so CI workers share build cache across PRs. The local Turbo cache works today; the remote-cache substrate is not yet configured.
- Exit Criteria: (a) Provider chosen (Vercel Turborepo Remote Cache, self-hosted via the open-source spec, or alternative) + authenticated via `TURBO_TOKEN` GitHub Actions secret; (b) `turbo.json` remote-cache block sets `signature: true` so HMAC-signed entries reject poisoning; (c) Tier 2+ CI build wall-clock reduction validated against a >=5-PR baseline sample (>=30% to justify the third-party dependency); (d) ADR-023 §Decision Log entry records the chosen provider + cost rationale.
- Revisit Trigger: Tier 2+ build wall-clock surfaces as a developer-experience pain point (PRs spending >10 minutes in CI on cache-cold builds), OR an ADR amendment promotes remote-cache to a required surface, OR a multi-author workflow appears where build-cache sharing has compounding payoff.

### BL-123: Wire coverage tooling + pick V1.1 numerical bar

- Status: `todo`
- Priority: `P3`
- Owner: `unassigned`
- References: ADR-023 (silent on coverage); Tier 1 closing audit A11 R2 / DQ-5
- Summary: No coverage tooling is configured (`@vitest/coverage-v8` not installed) and no governing ADR/plan mandates a numerical bar. Defer to V1.1 per criterion-gated discipline so the threshold anchors in empirical baseline rather than a folklore default (the "80% lines / 75% branches" arbitrary number would create compliance-theater pressure without project-specific justification). The Tier 1 substrate has 842 passing TS tests + 88 Cargo tests + 0 failures — the question is when to wire measurement, not whether the suite is healthy.
- Exit Criteria: (a) `@vitest/coverage-v8` (or equivalent) installed in root `package.json` devDependencies; (b) baseline coverage sample collected from >=5 Tier 2/3 PRs with file:line citations for the per-package coverage data; (c) per-package threshold chosen with justification anchored in (b) sample (e.g., "control-plane: 80% lines because the sampled PRs averaged 84% with 4% variance; floor is one std-dev below mean"); (d) ADR-023 amendment (or new ADR-NNN) merged ratifying the threshold; §Decision Log entry recording choice + rationale.
- Tracked-by: Plan-NNN (V1.1 coverage-quality plan, TBD when V1.1 scope is named).
- Revisit Trigger: V1.1 planning starts; OR a test-debt regression surfaces (e.g., a release-blocker bug that a coverage gate would have caught at PR review).

### BL-124: npm Trusted Publisher + Sigstore identity bootstrap

- Status: `todo`
- Priority: `P3`
- Owner: `unassigned`
- References: [ADR-023 §Axis 1](./decisions/023-v1-ci-cd-and-release-automation.md) (Surface 1 npm-package publish flow naming `@ai-sidekicks/contracts` + `@ai-sidekicks/client-sdk`), [ADR-023 §F-6](./decisions/023-v1-ci-cd-and-release-automation.md) (per-package Trusted Publisher registration risk + npm-bootstrap chicken-and-egg ceremony), [ADR-023 §Manual Setup Required](./decisions/023-v1-ci-cd-and-release-automation.md) (7-package × per-package 2FA registration ceremony, no automation possible through npm UI as of 2026-04), [`.github/workflows/release.yml`](../.github/workflows/release.yml) (`publish-npm` job at line 78 gated `if: false` at line 86; `sbom` job at line 135 gated `if: false` at line 152), [BL-108](#bl-108-plan-024-windows--macos-signing-procurement-evidence) (binary code-signing certificates — distinct procurement track), [BL-112](#bl-112-plan-007--plan-025-ed25519-release-manifest-signing-custody-procurement-evidence) (Ed25519 release-manifest signing custody — distinct procurement track), Tier 1 closing audit A10 R-2.
- Summary: The `publish-npm` + `sbom` jobs in `.github/workflows/release.yml` are deliberately gated `if: false` pending procurement of the npm Trusted Publisher per-package registrations and the Sigstore production identity that ADR-023 §Axis 1 + §Axis 5 specify. ADR-023 §F-6 documents the bootstrap as a one-time chicken-and-egg ceremony: each of the 7 published packages (`@ai-sidekicks/contracts`, `@ai-sidekicks/client-sdk`, plus 5 sidecar packages from ADR-023 Surface 3) must publish once via traditional `NPM_TOKEN` before npmjs.com will accept the Trusted Publisher registration. This entry tracks the npm-distribution-surface procurement track only; BL-108 covers the binary installer code-signing certificates (Apple Developer ID + Windows track), BL-112 covers the orthogonal Ed25519 release-manifest signing-key custody. Three distinct distribution surfaces, three distinct procurement BLs, one shared deferral pattern.
- V1 Release Impact: Does NOT block V1 release. V1 distributes the desktop runtime via GitHub Releases (Electron app + PTY sidecar + signed release manifest) — the npm-published packages (`@ai-sidekicks/contracts` + `@ai-sidekicks/client-sdk`) are SDK / integration surfaces for downstream integrators, not required for end-user V1 functionality. The `if: false` gates intentionally hold the publish flow until procurement window aligns with team capacity for the per-package 2FA ceremony documented in ADR-023 §Manual Setup Required. Tier 1 closure does NOT gate on this BL; the audit's A10 R-2 finding requested only that the deferral be tracked as a backlog entry (this item).
- Exit Criteria: (a) npm organization claimed + 2FA enforced on every maintainer with publish rights per [npm 2FA docs](https://docs.npmjs.com/configuring-two-factor-authentication); (b) §F-6 bootstrap step — each of the 7 packages published once via traditional `NPM_TOKEN` to seed the npmjs.com package records that Trusted Publisher registration requires; (c) per-package Trusted Publisher entry registered via npmjs.com UI pinned to this repo + the `release.yml` workflow file + the `production` GitHub environment per [npm Trusted Publishers docs](https://docs.npmjs.com/trusted-publishers/); (d) Sigstore production identity verified end-to-end via a test release run that emits a valid `actions/attest@v4` bundle for at least one package (Sigstore keyless via GitHub OIDC, no long-lived secrets per ADR-023 §Security Posture); (e) `publish-npm` + `sbom` `if: false` gates in `.github/workflows/release.yml` flipped to `if: ${{ needs.release-please.outputs.releases_created == 'true' }}` per the comments adjacent to each gate; (f) first end-to-end release publishes signed npm package + provenance statement + SBOM attestation against which `npm audit signatures` passes on a downstream install; (g) ADR-023 §Decision Log entry recording procurement date + npm organization name + the 7 registered Trusted Publisher entries.
- Tracked-by: ADR-023 §Axis 1 (Surface 1 npm-package publish flow) + §Axis 5 (production identity provisioning).
- Revisit Trigger: Team capacity aligns with the §F-6 bootstrap ceremony window (one-time per-package 2FA cost across 7 packages, no automation possible per ADR-023 §Manual Setup Required); OR a downstream integrator requests npm-distributed access to `@ai-sidekicks/contracts` / `@ai-sidekicks/client-sdk` (signal that the SDK surface needs npm publication for ecosystem reach); OR V1.1 planning starts and npm publication is sequenced into V1.1 distribution scope.

### BL-125: PASETO v4 RFC §4-F-\* failure-vector conformance suite

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Plan-025 Phase 1 Tier 1 Partial](./plans/025-self-hostable-node-relay.md#tier-1-partial-pr-sequence--substrate-vs-namespace-carve-out), [`packages/crypto-paseto/src/__tests__/rfc-vectors-v4-public.test.ts`](../packages/crypto-paseto/src/__tests__/rfc-vectors-v4-public.test.ts), [`packages/crypto-paseto/src/__tests__/rfc-vectors-v4-local.test.ts`](../packages/crypto-paseto/src/__tests__/rfc-vectors-v4-local.test.ts), [PASETO v4 spec §Test Vectors](https://github.com/paseto-standard/paseto-spec/blob/master/docs/01-Protocol-Versions/Version4.md), [ADR-010 §PASETO v4 Implementation Library](./decisions/010-paseto-webauthn-mls-auth.md#paseto-v4-implementation-library).
- Summary: The shipped RFC conformance suites in `packages/crypto-paseto/` cover the PASETO v4 spec's **success vectors** (`4-S-1..N` for v4.public, `4-E-1..N` for v4.local) but do not yet exercise the **failure vectors** (`4-F-*`) — adversarial inputs the spec mandates implementations must reject (e.g., truncated tokens, header confusion, footer-injection at the encode boundary). The negative-case discipline currently lives in handwritten unit tests (`v4-public.test.ts`, `v4-local.test.ts`, `footer-canonicalization.test.ts`) which cover the most-likely tampering shapes but are not the canonical adversarial set from the spec.
- Exit Criteria: (a) failure-vector JSON file(s) vendored from [paseto-standard/paseto-spec](https://github.com/paseto-standard/paseto-spec) into `packages/crypto-paseto/src/__tests__/vendor/` (or the next conformance-vector source the spec maintainers publish); (b) `rfc-vectors-v4-failure.test.ts` (or equivalent) iterating every `4-F-*` vector and asserting the documented rejection class (`InvalidTokenError` / `MacMismatchError` / `InvalidKeyError`); (c) suite gates CI on the `crypto-paseto` workspace.
- Tracked-by: ADR-010 acceptance criteria for `packages/crypto-paseto/` (RFC conformance gating release) — current AC is satisfied by success-vector parity; this BL hardens to spec-mandated adversarial coverage.
- Revisit Trigger: Plan-025 Tier 7 remainder begins (failure vectors should land before the Fastify relay-node ships); OR a downstream consumer plan (Plan-002 Phase 2, Plan-018) surfaces a tamper class that wasn't covered by the handwritten negative cases; OR PASETO spec maintainers publish an updated `4-F-*` vector set.

### BL-126: Local gitleaks pin drift vs CI (8.30.1 local vs 8.24.3 CI)

- Status: `todo`
- Priority: `P3`
- Owner: `unassigned`
- References: [`.gitleaks.toml`](../.gitleaks.toml), [`lefthook.yml`](../lefthook.yml), [`.github/workflows/gitleaks.yml`](../.github/workflows/gitleaks.yml), [Plan-025 PR #92 commit `584aed4`](https://github.com/Sawmonabo/ai-sidekicks/commit/584aed4) (chore(repo): use singular `[allowlist]` for gitleaks v8.24.3 ci compat), [ADR-023 §Pre-Commit Hooks](./decisions/023-v1-ci-cd-and-release-automation.md).
- Summary: Plan-025's pre-merge verification gates passed locally but the CI gitleaks job tripped on a v8.30.1 → v8.24.3 schema mismatch (plural `[[allowlists]]` block accepted by 8.30.1, rejected by 8.24.3). The fix landed in PR #92 (`584aed4`) by switching to the singular `[allowlist]` form. The root cause — local-vs-CI version drift — remains: `brew install gitleaks` ships the latest (8.30.1+) by default, while [`.github/workflows/gitleaks.yml`](../.github/workflows/gitleaks.yml) pins 8.24.3. Subsequent contributors will reproduce the same trip until either (a) the local version is documented as a pinned floor in CONTRIBUTING.md / a chezmoi-managed `Brewfile`, or (b) CI is bumped to a current version that matches what `brew install` yields.
- Exit Criteria: (a) ADR-023 amended (or [CONTRIBUTING.md §Pre-Commit Hooks](../CONTRIBUTING.md) if Type 1 reversible) to declare a single canonical gitleaks version and the matching schema form (singular `[allowlist]` vs plural `[[allowlists]]`); (b) CI workflow pin + local hook + chezmoi-installed binary all reference the same version; (c) plan-template revision (per BL-127) ensures the next plan's verification-gate runbook names the **CI-pinned** gitleaks version explicitly so local-version drift is caught at plan-authoring time, not at PR push.
- Tracked-by: Plan-template revision class — local-CI version drift surfaced as a verification-gate gap during Plan-025 Tier 1 Partial closeout.
- Revisit Trigger: Any plan whose verification gates include `gitleaks ... --staged`; OR a fresh contributor onboarding flow exposes the drift; OR gitleaks 9.x publishes a config-schema migration that obsoletes the v8 form.

### BL-127: Plan-template revision — verification-gate runbook precision

- Status: `todo`
- Priority: `P3`
- Owner: `unassigned`
- References: [Plan-025 PR #92](https://github.com/Sawmonabo/ai-sidekicks/pull/92) (three Codex review passes surfacing 8 findings: 2 + 3 + 3 across passes), [`docs/plans/000-plan-template.md`](./plans/000-plan-template.md), [Plan-025 §Decision Log](./plans/025-self-hostable-node-relay.md#decision-log), BL-126 (gitleaks version-drift class — concurrent lesson).
- Summary: Plan-025 Tier 1 Partial PR (#92) cleared CI on its first push but went through three Codex review iterations (8 findings total) before merge. Each iteration was substantively useful — strict base64url canonicalization, duplicate-id rejection, symmetric clone-in/out, empty-footer rejection, 32-byte key validation — but the pattern suggests the plan-template's "Verification" section under-specifies what an adversarial-review-equivalent check looks like at plan-authoring time. The current template's verification block enumerates positive tests (round-trips, RFC vectors, success cases) but not the adversarial-tampering shapes a reviewer like Codex will probe (non-canonical encodings, defense-in-depth boundary mutations, intake validation parity with library-level asserts).
- Exit Criteria: (a) `000-plan-template.md` §Verification gains a "Adversarial-Tampering Boundary" sub-bullet enumerating the per-substrate threat classes that should be tested before review (canonicalization round-trip; intake validation parity; mutation-isolation symmetry; empty-segment / trailing-separator rejection at every parser boundary); (b) the pattern is anchored to a published example (Plan-025 §Decision Log + the eight findings) so plan authors have a concrete reference; (c) plan-readiness-audit-runbook references the new sub-bullet as part of the pre-review checklist.
- Tracked-by: Plan-template revision class — review-iteration-discipline gap surfaced during Plan-025 PR #92 cycle.
- Revisit Trigger: Next time a Tier 1 Partial substrate plan opens a PR; OR a future Codex / external-reviewer iteration crosses the three-pass line again on a different plan; OR ADR-023 §Pre-Commit Hooks is amended (potential co-edit surface for the local-side counterpart to plan-authoring discipline).

### BL-128: Preflight Gate 4 ambient-window subject match (intro-above-block pattern)

- Status: `todo`
- Priority: `P3`
- Owner: `unassigned`
- References: [Plan-002 §Phase 4 T4.2](./plans/002-invite-membership-and-presence.md), [`preflight.mjs` `verifyLineRangeAnchor`](../.claude/skills/plan-execution/scripts/preflight.mjs), [`preflight-contract.md` §Gate 4 — Cite Anchor Semantic Check](../.claude/skills/plan-execution/references/preflight-contract.md), post-mortem `51ca5f3d` follow-up (surfaced during Plan-002 cite sweep dogfood, 2026-05-21).
- Summary: Gate 4's `verifyLineRangeAnchor` requires the subject identifier to appear within the cited line-range. This over-rejects the common Spec pattern where a contract's identifier sits on an intro line (`When a rate limit is exceeded, the API returns the standard \`RateLimitResponse\` contract`) immediately above the canonical-shape code block (`lines 127-133`). The Plan-002 T4.2 sweep worked around this by extending the cite to `lines 125-133` (intro included), but the underlying gate behavior remains: every future plan citing a "named-intro-then-shape-block" Spec contract will hit the same friction. Gate 4 should accept a subject match when the identifier appears on the line immediately preceding the cited range OR within a configurable ambient window (default ±2 lines).
- Exit Criteria: (a) `verifyLineRangeAnchor` extended to accept subject matches within an ambient window (default ±2 lines around the cited range); (b) `preflight-contract.md` §Gate 4 — Cite Anchor Semantic Check updated to document the ambient-window rule + its rationale (intro-above-block pattern); (c) `preflight-gate4.test.mjs` test case 13 fixture rewritten so the identifier appears on the intro line ABOVE the cited code block (current fixture has identifier inside the range — contrived shape that hides the bug this BL fixes); (d) new test case asserting ambient-window subject match passes; (e) Plan-002 T4.2 cite re-tightened to `lines 127-133` (the shape itself, not including the intro) to validate the new rule against a real case.
- Tracked-by: Gate 4 implementation precision — over-rejection class. Detected during the post-mortem 51ca5f3d remediation eat-your-own-dogfood validation.
- Revisit Trigger: Next time a plan cites a "named-intro-then-shape-block" Spec contract and the cite-amendment subagent needs to dodge the gate with a wider range than the actual shape; OR a future plan-readiness audit pass surfaces a Gate 4 false-positive on multi-line range cites.

---

_Closed items live in [Backlog Archive](./archive/backlog-archive.md)._
