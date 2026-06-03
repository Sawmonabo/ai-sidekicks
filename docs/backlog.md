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

### BL-131: Plan-003 Phase-5 runtime-node renderer automated component / E2E coverage

- Status: `blocked` (until the Plan-023 renderer test harness ships)
- Priority: `P3`
- Owner: `unassigned`
- References: [Plan-003 Phase 5 (T5.1–T5.4)](./plans/003-runtime-node-attach.md) + §Verification renderer-smoke step, [Plan-003 CP-003-3](./plans/003-runtime-node-attach.md#cp-003-3--plan-023-owns-the-windowsidekicks-preload-bridge-the-phase-5-renderer-projects-over) (renderer projects over the Spec-023 `window.sidekicks` bridge), [ADR-023](./decisions/023-v1-ci-cd-and-release-automation.md) (the Plan-023-owned `test:renderer` CI surface), [Plan-023](./plans/023-desktop-shell-and-renderer.md) (renderer test harness + Tier 8 IPC dispatcher), [BL-123](#bl-123-wire-coverage-tooling--pick-v11-numerical-bar) (sibling criterion-gated V1.1 coverage deferral)
- Summary: Plan-003 Phase 5 ships three renderer view components under `apps/desktop/src/renderer/src/runtime-node-attach/` (`NodeRoster.tsx`, `AttachFlow.tsx` + `CapabilityDeclaration.tsx`, `MixedVersionStatus.tsx`) as a thin projection over the `window.sidekicks` preload bridge (CP-003-3). At Tier 3 their acceptance rests on the T5.4 manual two-client attach smoke — the load-bearing floor / attach / membership semantics (I-003-1, I-003-3) are already proven by the Phase 1–4 automated suite (C1–C6, D1–D6, P1–P8, I1–I3), so the renderer surface is a projection check, not a semantics gate. Automated renderer component tests + the two-client E2E that replaces the manual smoke are deferred to V1.1 because the Plan-023 renderer test harness (RTL/jsdom component-test infra + `window.sidekicks` mock; the Tier 8 IPC dispatcher for cross-client E2E) is not available until Plan-023's Tier 8 remainder ships. Deferral follows the criterion-gated discipline (BL-123 precedent): the test infra anchors in the Plan-023-owned harness rather than a hand-rolled per-plan mock that would drift from the canonical bridge shape.
- Exit Criteria: (a) Plan-023 ships the renderer test harness (component-test infra + `window.sidekicks` mock surface; Tier 8 IPC dispatcher for two-client E2E); (b) automated component tests for `NodeRoster` / `AttachFlow` / `CapabilityDeclaration` / `MixedVersionStatus` assert bridge-only data access (no `node:*`/`electron` imports), the three render states, and below-floor read-only surfacing of `VERSION_FLOOR_EXCEEDED`; (c) an automated two-client attach E2E replaces the T5.4 manual smoke (verifies admit-not-eject + detach-leaves-membership-intact through the renderer); (d) the "automated coverage backfilled per BL-131" notes in Plan-003 T5.1–T5.4 + §Verification are resolved.
- Tracked-by: Plan-023 (renderer test harness + Tier 8 IPC dispatcher).
- Revisit Trigger: Plan-023 Tier 8 ships the renderer test harness / IPC dispatcher; OR V1.1 planning starts; OR a runtime-node renderer regression surfaces that automated component / E2E coverage would have caught.

### BL-133: Non-consuming invite-metadata endpoint for the deep-link confirmation surface

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-023 §Deep-Link Invite Flow](./specs/023-desktop-shell-and-renderer.md#deep-link-invite-flow) (the pinned property: main confines the token and hands the renderer an opaque reference + display metadata before an explicit confirmation), [Spec-002 §Invite Delivery](./specs/002-invite-membership-and-presence.md#invite-delivery) (the control-plane resolution that validates + displays session name / proposed join mode WITHOUT consuming the token — the reusable non-consuming-resolution precedent), [Plan-002 §Progress Log Notes — PR #120 cross-plan amendment #4](./plans/002-invite-membership-and-presence.md), [Plan-002 §Cross-Plan Obligations CP-002-5](./plans/002-invite-membership-and-presence.md#cross-plan-obligations), [Plan-023 Tier 8 deep-link runtime wiring](./plans/023-desktop-shell-and-renderer.md)
- Summary: Spec-023 §Deep-Link Invite Flow was pinned (PR #120 FINDING 1 + Codex round-2 FIX C) to confine the `v4.local` invite token to the main process and hand the renderer an opaque reference plus display metadata (session name, proposed join mode, inviter) for an explicit-confirmation step BEFORE acceptance — and acceptance (`invite.accept`) is single-use/consuming per ADR-010. The renderer therefore cannot reuse the consuming `invite.accept` path to populate the confirmation UI; it needs a distinct NON-consuming invite-metadata read (validate token + return display metadata; the single-use token survives). Spec-002 §Invite Delivery already describes this resolution server-side (the control-plane web page validates + displays session name + proposed join mode without consuming; consumption is on accept), but it is not exposed as a callable contract the desktop deep-link flow can invoke. The invite contract surface is Spec-002 / Plan-002-owned (CP-002-5), so this endpoint's request/response shape, non-consuming semantics, and expiry/error behavior are owed here — it is the missing precondition for Plan-023 Tier 8 deep-link rendering.
- Exit Criteria: (a) Spec-002 amended with the non-consuming invite-metadata method contract — request keyed on the invite token (or its opaque main-process reference); response carrying display metadata (at minimum the session name + proposed join mode per Spec-002 §Invite Delivery; inviter + expiry as the shape is designed); explicitly NON-consuming (idempotent — the single-use token is not spent by the read); typed errors reusing the §Invite vocabulary for expired / revoked / already-accepted / not-found; (b) Plan-002 (or the consuming tier's plan) carries an implementation task for the endpoint on the daemon-as-gateway surface (ADR-008), mirroring the `invite.accept` wire registration; (c) Plan-023 Tier 8 deep-link rendering consumes it and the two-client manual smoke (former Plan-002 Phase 6 T6.4) passes end-to-end.
- Revisit Trigger: Plan-023 Tier 8 deep-link runtime wiring is sequenced for delivery (this endpoint is its precondition); OR a Spec-002 amendment touches the invite read / resolution surface; OR the desktop invite-accept view is reshaped to the pinned opaque-reference + display-metadata posture (Spec-023 §Deep-Link property (b)).

### BL-134: clipanion stable-v4 upgrade + lockfile bump for Plan-007 R3-PR-a CLI

- Status: `blocked` (until upstream clipanion ships a stable v4.x release)
- Priority: `P3`
- Owner: `unassigned`
- References: [Plan-007 Phase R3 — R3-PR-a CLI Delivery](./plans/007-local-ipc-and-daemon-control.md), [Spec-007 §Delivery Surfaces](./specs/007-local-ipc-and-daemon-control.md), [clipanion GitHub releases](https://github.com/arcanis/clipanion/releases) (upstream tag stream), [Yarn `yarnpkg-cli` package.json](https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-cli/package.json) (the production-precedent dependency line `"clipanion": "^4.0.0-rc.2"` — Yarn ships clipanion v4-RC in its production CLI surface, the largest typed-CLI workload in the JS ecosystem; precedent that justified the exact-RC pin for V1 ship)
- Summary: Plan-007 R3-PR-a (CLI delivery — the `sidekicks` first-class delivery track per Spec-007:41) pins `clipanion@4.0.0-rc.4` as an exact-version dependency because as of 2026-05-28 the v4 line has not shipped a stable release (latest tag is `4.0.0-rc.4`; v3.x is the last stable line). The v4 type-safety improvements over v3 (typed positional-argument inference, typed `Command.Option.String`/`Boolean` decorators, drop of the v3 unsafe `@Command.Path` decorator) are load-bearing for the V1 typed CLI commands (`sidekicks daemon start|stop|status` per F-007r-3-09). The exact-RC pin is the hardened choice — caret ranges (`^4.0.0-rc.4`) would auto-upgrade across RC drops with potentially breaking type-API changes between release candidates; an exact pin freezes the surface against an audited RC. When upstream ships a stable `4.x.x` (or `4.0.0` final), bump the pin, run the R3-T1..R3-T8 CLI test slice against the stable build, and ratify the lockfile shift.
- Exit Criteria: (a) Upstream clipanion ships a stable v4 release tag (`4.0.0` or first stable `4.x.x`); (b) Plan-007 R3-PR-a's `apps/cli/package.json` clipanion pin updated from `4.0.0-rc.4` to the stable release (exact-version pin preserved); (c) `pnpm install` regenerates `pnpm-lock.yaml` with the new resolved version; (d) the R3-T1..R3-T8 CLI test slice (per T-007r-3-15 slice-a) passes against the stable build with no migration-only behavior deltas; (e) Plan-007 §Decision Log entry records the RC-to-stable bump + date + any migration notes from the upstream changelog.
- Revisit Trigger: Upstream clipanion stable v4 release announced (the dominant trigger — file the bump PR within one week); OR a Plan-007 R3-PR-a follow-up surfaces an RC-vs-stable behavior delta during V1 hardening (e.g., a regression report against `4.0.0-rc.4` that an RC bump or stable release would fix); OR a subsequent V1 CLI plan (post-Plan-007) requires a clipanion-API surface only exposed by stable v4 (e.g., an `onError` hook or a typed-environment-variable decorator that the RC does not yet expose).

---

### BL-135: Reconcile Plan-025 relay admin-token path against canonical Spec-027 `./data/admin-token`

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Plan-025 §File-By-File Plan-Of-Record](./plans/025-self-hostable-node-relay.md), [Spec-027 §Required Behavior](./specs/027-self-host-secure-defaults.md#required-behavior) (row 3 secret set + the Example 1 first-run banner), [Plan-007 §Phase R2](./plans/007-local-ipc-and-daemon-control.md) (conformed to `./data/admin-token` in PR #124), [operations/self-host-secure-defaults.md](./operations/self-host-secure-defaults.md) (ops mirror), PR #124 Codex round-3 finding F (path divergence surfaced)
- Summary: Plan-025 writes the relay admin token to `./data/trust/relay-admin-token` in six places (file-by-file plan, plan-of-record table, build steps 21 + 26, acceptance tests), but the canonical Spec-027 §Required Behavior row 3 + the Example 1 first-run banner specify `./data/admin-token`, and the ops mirror independently confirms `./data/admin-token`. This is **one** token at a divergent path, not two separate files: Spec-027 row 3 enumerates the _complete_ first-run secret set (daemon master key per Spec-022; session-signing key; relay admin token) and the both-services Example 1 banner lists exactly one `Admin token:` line. Plan-007's Tier-4 audit (PR #124, finding F) conformed the daemon-side references to `./data/admin-token`; Plan-025 remains divergent. Resolution is a Spec-027-level canonicalization decision and is therefore deferred to Plan-025's own plan-readiness audit (later tier, not yet audited) rather than fixed by a drive-by edit from a Tier-4 PR.
- Exit Criteria: (a) Spec-027 records the canonical admin-token path as a single decision — EITHER keep `./data/admin-token` (conform Plan-025's six references to it) OR amend Spec-027 to relocate the token under `./data/trust/` alongside the other trust materials (`fingerprint.txt`, `first-run.complete`), in which case Plan-007 §Phase R2, the Spec-027 Example 1 banner, and the ops mirror are all updated to match; (b) every Plan-025 reference uses the canonical path; (c) `docs/architecture/cross-plan-dependencies.md` shared-resource ownership reflects the single owning plan for the admin-token file path; (d) no daemon/relay doc cites a path the canonical spec contradicts.
- Revisit Trigger: Plan-025 plan-readiness audit reaches the `draft → review` gate (the dominant trigger — resolve as part of that audit); OR any Spec-027 amendment touching the `./data/trust/` first-run-ceremony layout; OR a Plan-025 implementation PR is cut before the audit (block it until the path is canonicalized).

---

### BL-139: ADR-015 §V1.1 criterion-gated-commitment entry for the automated GDPR endpoint

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [ADR-015 V1 Feature Scope Definition](./decisions/015-v1-feature-scope-definition.md), [Plan-022 §Non-Goals](./plans/022-data-retention-and-gdpr.md#non-goals), [Spec-022 §Non-Goals](./specs/022-data-retention-and-gdpr.md#non-goals) — surfaced at the Tier-5 plan-readiness audit (PR #129) Codex review (round-5 GDPR hardening)
- Summary: The automated GDPR deletion/export/purge endpoint is a V1→V1.1 deferral. Per the project's criterion-gated-deferral discipline, a V1→V1.1 deferral of a compliance-relevant capability should carry a named criterion-gated commitment in ADR-015 (the V1-scope ADR), not only in the plan/spec Non-Goals. Plan-022 §Non-Goals now names the (a)/(b) deferral reasoning + (i)/(ii)/(iii) promotion criteria; this item folds an equivalent criterion-gated-commitment entry into ADR-015 §V1.1 so the scope ADR is the durable record.
- Exit Criteria: (a) ADR-015 carries a V1.1 criterion-gated-commitment entry for the automated GDPR endpoint naming the (i)/(ii)/(iii) promotion criteria from Plan-022 §Non-Goals; (b) the entry cross-links Plan-022 + Spec-022 §Non-Goals; (c) the deferral is no longer recorded only in plan/spec Non-Goals.
- Revisit Trigger: ADR-015 is next edited; OR V1.1 scope planning begins; OR the GDPR endpoint promotion criteria are met.

---

### BL-140: Spec-003 §Default-Behavior heartbeat degraded→offline threshold + sweep owner

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-003 §Default Behavior](./specs/003-runtime-node-attach.md) (defines the 15s heartbeat cadence at :59 — but no degraded→offline miss-count threshold and no named sweep owner), [Plan-003 Phase 3 — T3.6/P6 heartbeat lifecycle](./plans/003-runtime-node-attach.md) plus the explicit [Plan-003:437](./plans/003-runtime-node-attach.md) constraint (_"Do not invent threshold values or the fan-out rule until specified"_), [Plan-003 §Invariants](./plans/003-runtime-node-attach.md) (runtime-node presence lifecycle), [cross-plan-dependencies.md §6 NS-32](./architecture/cross-plan-dependencies.md) (Plan-003 Phase 3 — blocked-on-completion until this amendment lands), PR #138 (the post-merge housekeeping pass that surfaced and machine-gated this dependency via the Phase-3 `bl_closed: 140` preflight precondition)
- Summary: Spec-003 specifies the runtime-node heartbeat cadence (15s, :59) but leaves the degraded→offline transition under-specified — there is no miss-count threshold (how many missed 15s beats demote a node from `degraded` to `offline`) and no named sweep owner (which control-plane service runs the timeout sweep and emits the offline transition). Plan-003 Phase 3 T3.6/P6 requires a test asserting this transition, but Plan-003:437 forbids inventing the threshold + fan-out rule until Spec-003 specifies them — so Phase 3 cannot reach its Exit Criteria until this amendment lands. This is the missing governing spec value, owned at the Spec-003 §Default-Behavior layer (not inventable in the implementation PR).
- Exit Criteria: (a) Spec-003 §Default Behavior records the degraded→offline miss-count threshold + the sweep-owner service as canonical values (the design decision is made and written, not deferred); (b) Plan-003 Phase 3 T3.6/P6 cites the Spec-003 value with no invention; (c) the Plan-003 Phase 3 preflight precondition `bl_closed: 140` clears (this item flips `completed` / is archived), so preflight stops halting Phase 3 dispatch; (d) `cross-plan-dependencies.md` §6 NS-32 flips `blocked` → `ready`.
- Revisit Trigger: Plan-003 Phase 3 (NS-32) is sequenced for delivery (this amendment is its hard precondition); OR any Spec-003 amendment touches the heartbeat / presence lifecycle; OR the runtime-node `degraded` / `offline` product behavior is being designed.

---

_Closed items live in [Backlog Archive](./archive/backlog-archive.md)._
