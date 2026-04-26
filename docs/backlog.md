# Backlog

## Purpose

This file is the active development backlog for the product defined in [vision.md](./vision.md).

## How To Use This Backlog

- Add items only when they represent real remaining work.
- Link every item to the governing spec, plan, ADR, or operations doc where possible.
- Keep items outcome-oriented. A backlog item should describe a deliverable, not a vague area of concern.
- Remove or rewrite stale items instead of letting the file become a historical log.
- When work is complete, update the canonical docs it depends on first, then move the item to [Backlog Archive](./archive/backlog-archive.md).

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

## Active Items

### BL-099: Author `docs/domain/trust-and-identity.md`

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-027 — Self-Host Secure Defaults](./specs/027-self-host-secure-defaults.md), [Participant And Membership Model](./domain/participant-and-membership-model.md), [Security Architecture](./architecture/security-architecture.md), [ADR-010 — PASETO/WebAuthn/MLS Auth](./decisions/010-paseto-webauthn-mls-auth.md)
- Summary: Author the missing `docs/domain/trust-and-identity.md` domain doc to canonicalize trust-ceremony semantics (first-run secret generation, fingerprint display, device-trust establishment) currently scattered across `participant-and-membership-model.md`, `security-architecture.md`, and Spec-027. Surfaced by the 2026-04-26 read-only docs audit (M-003): Spec-027 §Domain Dependencies originally cited the file as if it existed; the audit-driven fix re-pointed Spec-027 to `participant-and-membership-model.md` as the closest existing scope match, but the trust-ceremony surface deserves its own domain doc.
- Exit Criteria: `docs/domain/trust-and-identity.md` exists; covers identity-material provisioning, fingerprint verification ceremony, and trust-state lifecycle; is referenced from Spec-027 §Domain Dependencies, ADR-010, and security-architecture.md; sibling docs cross-link consistently.

### BL-100: Author ADR-023 — V1 CI/CD, Pre-Commit Hooks, and Release Automation

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [ADR-022 — V1 Toolchain Selection](./decisions/022-v1-toolchain-selection.md) (CI named as success criterion; workflow files unauthored), [Spec-027 — Self-Host Secure Defaults](./specs/027-self-host-secure-defaults.md) (**governance constraint**: §Behavior 7b end-user trust model — Ed25519 manifest signing + Sigstore bundle + `actions/attest-build-provenance` — is decided; ADR-023's release-automation axis MUST implement it, not relitigate it), [ADR-019 — Windows V1 Tier and PTY Sidecar](./decisions/019-windows-v1-tier-and-pty-sidecar.md) (Rust sidecar code-signing scope to be extended), [Plan-001 — Shared Session Core](./plans/001-shared-session-core.md) (PR #1 ship-gate consumer), [Spec-011 — Gitflow, PR, and Diff Attribution](./specs/011-gitflow-pr-and-diff-attribution.md) (product-level gitflow; engineering-side gitflow is this BL's scope)
- Summary: Author the missing engineering CI/CD ADR. Currently scattered: end-user release distribution decided in Spec-027 §7b; cross-compile CI matrix mentioned in ADR-019 + ADR-022 success criteria but not authored; engineering-side decisions for `.github/workflows/`, pre-commit framework, commit-message format, branch protection, release automation for npm-publishable packages, npm provenance, SBOM, dependency-update bot, secret scanning, and code-signing custody have NO governing ADR. ADR-023 closes this gap. Scope (5 axes): (1) **CI workflow architecture** — job graph, matrix axes for two-ABI rebuilds + two-tier Node 22/24 + Windows/macOS/Linux, Turbo remote-cache integration, `concurrency` rules to cancel superseded runs, secrets scope, branch protection + required-checks list, `CODEOWNERS`; (2) **pre-commit hook framework + dev-loop** — Husky vs lefthook vs simple-git-hooks vs `pre-commit` (Python); `lint-staged` config; commitlint + conventional-commits; (3) **release automation** — semantic-release vs changesets vs release-please for npm-publishable packages (`@ai-sidekicks/contracts`, `@ai-sidekicks/client-sdk`); desktop-binary release flow (must implement Spec-027 §7b verbatim); Rust sidecar release flow (extends ADR-019 distribution pattern); (4) **supply-chain hygiene** — `npm publish --provenance`, SBOM emission (syft / cyclonedx / spdx), Dependabot vs Renovate vs Socket.dev, secret scanning (GitHub Advanced Security vs Gitleaks vs trufflehog); (5) **code-signing custody** — Apple Developer ID + Windows code-signing or Azure Artifact Signing extension to cover Electron app + npm packages; secret storage in GitHub Actions; key-rotation procedure; signing-config CODEOWNERS scope.
- Methodology: Per [`feedback_websearch_before_recommendation.md`](MEMORY) primitive choices in this space are architectural decisions requiring primary-source-cited research with current-year (2026) citations BEFORE recommendations are presented. Spawn **5 parallel Opus 4.7 specialized subagents** (one per scope axis) per [`feedback_research_standards.md`](MEMORY) Opus-4.7-only subagent constraint; subagent findings drafted transiently under `docs/research/adr-023-ci-cd/<axis>.md` per the transient-drafting pattern; citations carried forward into ADR-023 References before transient drafts are deleted at commit time. WebSearch verification per axis BEFORE recommendation lands.
- Exit Criteria: `docs/decisions/023-v1-ci-cd-and-release-automation.md` exists with status `accepted`; Decision section covers all 5 scope axes; each choice carries Antithesis + Synthesis sections per ADR template; all assumptions cite primary sources with 2026 fetch dates; failure-mode analysis with detection signals; reversibility assessment; re-evaluation triggers documented; Plan-001's Required ADRs row updates ADR-023 from `(pending per BL-100)` to a normal accepted reference; Plan-001 Preconditions PR #1 ship-gate item flips from `[ ]` to `[x]`; Plan-001 PR #1 enumerates the concrete artifact list authored by ADR-023 (`.github/workflows/{ci,release}.yml`, pre-commit hook config, commitlint config, dependency-update bot config, `CODEOWNERS`, code-signing custody scaffolding).

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

## Maintenance Rule

If information in a backlog item becomes durable product truth, move that information into the canonical docs and keep only the remaining work here.
