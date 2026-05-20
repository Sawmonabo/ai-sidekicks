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

### BL-119: Plan-025 `crypto-paseto` Tier 1 partial carve-out decision

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Plan-002 §Cross-Plan Obligations CP-002-4](./plans/002-invite-membership-and-presence.md#cross-plan-obligations), [Plan-002 Phase 2](./plans/002-invite-membership-and-presence.md), [Plan-025](./plans/025-self-hostable-node-relay.md) (workspace path `packages/crypto-paseto/` Tier 5), [ADR-010](./decisions/010-paseto-webauthn-mls-auth.md), [audit runbook §Tier 2 Lessons Learned](./operations/plan-implementation-readiness-audit-runbook.md) (2026-05-20 entry), F-002-2-01 (audit critical finding)
- Summary: Plan-002 Phase 2 needs PASETO v4.local minting at Tier 2, but Plan-025 ships `packages/crypto-paseto/` at Tier 5. Decide between (a) carve out a Tier 1 partial of `packages/crypto-paseto/` (mirrors Plan-007-partial / Plan-008-bootstrap / Plan-023-partial precedent — a substrate-vs-namespace decomposition), or (b) inline a minimal PASETO v4.local implementation in `packages/control-plane/src/invites/invite-service.ts` with an explicit `TODO(Plan-025)` marker and a follow-up replace at Tier 5. Decision pre-blocks Plan-002 Phase 2 execution. Cross-references: NS-14 Tier 2 audit closure.
- Exit Criteria: Plan-002 §Cross-Plan Obligations CP-002-4 updated with the chosen path; if (a), Plan-025 gains a Tier 1 Partial carve-out section + cross-plan-dependencies.md §5 row + Plan-002 §3 dep edge re-validated; if (b), Plan-002 Phase 2 Tasks block adds the `TODO(Plan-025)` task with explicit Tier-5 replace step.

### BL-120: Plan-002 Phase 4 invite-endpoint rate-limit wiring (Tier 6 deferral)

- Status: `blocked` (until Plan-021 ships at Tier 6)
- Priority: `P2`
- Owner: `unassigned`
- References: [Plan-002 §Cross-Plan Obligations CP-002-3](./plans/002-invite-membership-and-presence.md#cross-plan-obligations), [Plan-002 Phase 4](./plans/002-invite-membership-and-presence.md), [Plan-021 §tRPC middleware surface (Plan-008 consumer)](./plans/021-rate-limiting-policy.md), [cross-plan-dependencies.md §3 Plan-002 → Plan-021 edge](./architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph), F-002-4-02, F-002-4-04, F-002-4-05 (audit critical findings)
- Summary: Plan-002 Phase 4 (invite-endpoint rate-limit wiring) is structurally deferred from Tier 2 to Tier 6 because Plan-021 ships the `rateLimitProcedure` middleware factory at Tier 6. At Tier 6, Plan-002 Phase 4 applies `rateLimitProcedure({endpoint: 'invite.create' | 'invite.accept' | 'invite.revoke' | …})` middleware to the invite tRPC procedures defined in Phase 2's `invite-service.ts` surface, plus adds rate-limit verification tests asserting threshold breach returns the canonical 429 + `RateLimitResponse` shape per Plan-021's canonical contract. The Tier 6 deliverable closes Spec-002 §Rate Limiting (20/session/hr, 50/participant/hr, 100 pending/session).
- Exit Criteria: Plan-002 Phase 4 Tasks T4.1 + T4.2 executed at Tier 6; invite-endpoint rate-limit tests pass against Plan-021's middleware.

### BL-121: Spec-002 §Interfaces and Contracts — declare `InviteRevoke` payload shape

- Status: `todo`
- Priority: `P3`
- Owner: `unassigned`
- References: [Spec-002 §Interfaces and Contracts](./specs/002-invite-membership-and-presence.md), [Plan-002 Phase 1 contract bullet](./plans/002-invite-membership-and-presence.md) (`InviteRevoke` shape declared inline as audit amendment), F-002-1-02 (audit critical finding)
- Summary: Spec-002 §Interfaces and Contracts lists `InviteCreate` and `InviteAccept` payloads but omits `InviteRevoke`. Plan-002 Phase 1 declared the shape inline as the NS-14 audit amendment (`{sessionId: SessionId, inviteId: InviteId, reason?: string}`) per the C-2 cross-cutting pattern (plan declares when spec is silent). Backlog this for canonical spec backfill — low-priority because plan-side declaration is authoritative for implementation, but spec is the design contract and should match. No code-execution blocker.
- Exit Criteria: Spec-002 §Interfaces and Contracts gains an `InviteRevoke` payload row matching the Plan-002 Phase 1 shape; spec promotion-PR cites NS-14 + BL-121.

---

_Closed items live in [Backlog Archive](./archive/backlog-archive.md)._
