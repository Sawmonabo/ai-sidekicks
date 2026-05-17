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
- Exit Criteria: All four artifacts attached or hash-recorded under this entry — (a) YubiHSM 2 standard-variant procurement evidence (order confirmation + device serial number + first-power-on initialization timestamp); (b) AWS KMS Ed25519 key creation evidence (key ARN + key creation timestamp + attached KMS key policy + IAM role trust policy gated on `"kms:SigningAlgorithm": "ED25519_SHA_512"` + a GitHub Actions workflow run ID demonstrating a successful end-to-end Sign + verify against a test manifest); (c) GitHub Actions → AWS OIDC federation evidence (AWS IAM identity-provider thumbprint + federated-credential subject claim pinned to `repo:OWNER/REPO:environment:production:ref:refs/heads/main` per the immutable-subject-claims format enforcing 2026-06-18 + `aws-actions/configure-aws-credentials` pinned to a commit SHA rather than the `@v6` floating tag); (d) first-key rotation rehearsal evidence (test-cutover ceremony walkthrough demonstrating the ADR-023 §Axis 5 item 5 dual-sign procedure — `next_signing_keys` pre-published ≥30 days ahead, current hot key signs the rotation manifest, cold YubiHSM 2 counter-signs the rotation announcement, transition-period dual-sign works end-to-end). When all four artifacts are recorded, Plan-007 and Plan-025 release-manifest verification implementations have run green against signatures produced under this custody contract, and Spec-027 §7b's release-manifest schema fields (`version`, `released_at`, `expires_at`, `previous_manifest_hash`, `next_signing_keys`) have been exercised against a real signed manifest, this item is closeable.

---

_Closed items live in [Backlog Archive](./archive/backlog-archive.md)._
