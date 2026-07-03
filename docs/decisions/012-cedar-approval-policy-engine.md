# ADR-012: Cedar Approval Policy Engine

| Field         | Value                   |
| ------------- | ----------------------- |
| **Status**    | `accepted`              |
| **Type**      | `Type 2 (one-way door)` |
| **Domain**    | `Approval / Policy`     |
| **Date**      | `2026-04-15`            |
| **Author(s)** | `Claude`                |
| **Reviewers** | `Accepted 2026-04-15`   |

## Context

The system defines 9 approval categories that govern what actions agents may take autonomously versus what requires human confirmation. Microsoft's Agent Governance Toolkit uses Cedar for agent policy enforcement. Cedar's principal-action-resource-context model maps directly to approval decisions (who is requesting, what action, on what resource, under what session context). Externalizing policies from application code makes them auditable and changeable without redeployment.

## Problem Statement

What policy engine should evaluate the 9 approval categories so that authorization decisions stay auditable, operator-tunable, and decoupled from application release cadence?

### Trigger

Approval logic was accumulating inside application code, making it impossible to audit or modify policies without a full deploy. The architecture program needs to pick a dedicated policy engine before approval specs and UI surface freeze.

## Decision

Use Cedar (CNCF sandbox) as the approval policy engine. V1 defines policies in YAML that are compiled to Cedar at build time and evaluated in-process by the resident, signature-verified `@cedar-policy/cedar-wasm` authorizer — the compiled set is parsed once at startup and held resident, then evaluated **per request with no decision cache** (a decision is never served stale; caching is rejected for the local in-process authorizer per the 2026-07-02 Decision Log row) — (per the 2026-06-10 and 2026-07-02 Decision Log rows — WASM is the V1 evaluation substrate, not a V1.1 arrival). V1.1 adds runtime policy-bundle loading, enabling dynamic policy updates without redeployment.

## Alternatives Considered

### Option A: Cedar with YAML Policy Definitions (Chosen)

- **What:** Define approval policies in YAML, compile to Cedar policy sets, evaluate in-process with the resident Cedar WASM authorizer from V1. Runtime policy-bundle loading arrives in V1.1.
- **Steel man:** Cedar's principal-action-resource-context model is purpose-built for authorization. CNCF backing signals longevity. WASM target enables in-process evaluation without native FFI.

### Option B: OPA / Rego (Rejected)

- **What:** Use Open Policy Agent with Rego policy language.
- **Why rejected:** Heavier runtime (Go-native daemon or WASM build), Rego's syntax is less intuitive for action-resource authorization patterns, and the Go toolchain is a poor fit for a TypeScript-native stack.

### Option C: Hardcoded Approval Logic (Rejected)

- **What:** Implement approval checks directly in application code.
- **Why rejected:** Not auditable. Every policy change requires a code change, review, and deployment. Cannot be inspected or overridden by administrators without developer involvement.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Cedar's principal-action-resource-context model can express all 9 approval categories without contortion. | Cedar is purpose-built for authorization; Microsoft's Agent Governance Toolkit uses it for agent policy. | We would need a second policy language for categories that do not fit, fragmenting the engine. |
| 2 | Cedar WASM is usable in-process from a TypeScript host without unacceptable startup or evaluation overhead. | Cedar publishes WASM artifacts; the microsecond policy-evaluation benchmarks are **native-engine** figures — the WASM path (including JS↔WASM marshaling) has no published benchmark and stays unvalidated until the campaign-B13 end-to-end benchmark (2026-07-02 B8 amendment; see §Decision Validation). | We would need a sidecar policy service or a native Go/Rust binding, complicating deployment. |
| 3 | YAML-to-Cedar compilation in V1 gives operators enough authoring ergonomics until runtime **policy-bundle loading** ships in V1.1 (the resident WASM evaluator itself ships at V1 — 2026-07-02 Decision Log row; this assumption is only about bundle-loading timing). | YAML captures the structural aspects of policies; runtime bundle loading arrives as soon as the signing/custody pipeline is proven. | Operators demand live policy edits before V1.1, forcing an earlier bundle-loading ship with more risk. |
| 4 | Cedar remains an actively maintained CNCF project over the product lifetime. | Cedar is a CNCF sandbox project with AWS and Microsoft involvement and a published roadmap. | If Cedar stagnates, we would migrate to OPA/Rego or a bespoke engine — a multi-quarter effort. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A policy category cannot be expressed cleanly in Cedar | Med | Med | Policy review during spec implementation; unit tests against reference cases | Extend Cedar context attributes or fall back to an application-level pre-check for that category |
| Cedar WASM has a correctness bug that allows or denies unintended actions | Low | High | Policy test suite plus canary evaluation comparing WASM vs reference interpreter | Pin Cedar versions, add dual-evaluation for sensitive categories, and ship rapid rollback for policy sets |
| Policy authoring (YAML→Cedar) surprises operators with unexpected denials | Med | Med | Dry-run evaluation UI and deny-rate dashboards | Ship policy simulation tooling and staged rollout per category |
| Cedar upstream introduces breaking changes that invalidate stored policies | Low | Med | Upstream release notes and pinned CI on new Cedar versions | Version-tag compiled policy sets; run migrations during upgrades |

## Reversibility Assessment

- **Reversal cost:** Medium. Policies and their evaluation sites are well isolated, but every approval path calls the policy engine, so replacement touches each integration.
- **Blast radius:** Approval service, CLI/desktop approval prompts, audit logs, and any runtime code that branches on approval decisions.
- **Migration path:** Introduce an engine-agnostic policy interface, run Cedar and a replacement engine in shadow mode, diff decisions, then cut over once divergence is zero.
- **Point of no return:** After operator-authored policies accumulate in production and audit logs reference Cedar policy identifiers, replacement requires a coordinated policy-translation effort.

## Consequences

### Positive

- Policies are externalized, auditable, and modifiable without code changes (V1.1)
- Cedar's authorization model is a natural fit for approval decisions
- WASM target keeps policy evaluation in-process with no sidecar

### Negative (accepted trade-offs)

- Cedar is newer and less widely adopted than OPA; smaller ecosystem of tooling and examples
- V1 uses YAML-to-Cedar compilation, adding a redeploy per policy change (the compiled set is build-embedded); V1.1 removes that cost with runtime policy-bundle loading — the deferral is bundle loading only, the resident WASM evaluator ships at V1

## Policy Chain of Custody

Cedar's security model assumes trustworthy policy input. A daemon that evaluates attacker-controlled policy text produces attacker-controlled authorization decisions. This section defines how policy artifacts are signed, distributed, verified, versioned, and rotated so that the integrity assumption Cedar relies on is actually established at runtime.

### Scope By Phase

**V1 (compiled policy set embedded at build time; resident in-process WASM evaluation).** Policy text is compiled to a Cedar policy set and embedded in the daemon artifact at build time per §Decision, and evaluated from V1 by the resident, signature-verified `@cedar-policy/cedar-wasm` authorizer — parse-once at startup, per-request evaluation, **no decision cache** (2026-07-02 Decision Log row). The in-process verified artifact is the **compiled policy set** — a detached signature under the operator release key (pinned algorithm per §Signing Algorithm: Ed25519 by default, ECDSA P-256 compliance fallback), verified on every daemon start before any `PermissionCheck` is served, in both topologies (2026-06-10 Decision Log row) — while whole-image signing remains the distribution pipeline's supply-chain layer: images are signed by the operator's release signing key, and containerized daemons additionally refuse to start if the image they were launched from cannot be verified against the pinned operator public key.

**V1.1 (runtime policy-bundle loading).** Policy text ships as a detached bundle `policy-bundle-v{N}.cedar.tar.gz` with a companion detached signature `policy-bundle-v{N}.cedar.tar.gz.sig`. The daemon loads the bundle into the **already-resident** `@cedar-policy/cedar-wasm` evaluator at runtime — the evaluator itself ships at V1; V1.1 adds dynamic loading, not WASM evaluation. Policy chain of custody becomes a distinct concern from image signing. This section's bundle-level rules apply from V1.1 forward; the V1 rules above remain the floor.

### Signing Key Identity

A single operator signing keypair (the _operator release key_) signs daemon images, the V1 build-embedded compiled policy set (its detached signature — 2026-07-02 amendment), and, from V1.1, policy bundles. The private half is held by the operator release infrastructure. The public half is pinned in the daemon at build time:

- **Hosted Sidekicks daemons:** pinned to the Sidekicks operator public key baked into the official daemon image at build.
- **Self-hosted daemons:** the operator public key is injected at image build time via an `OPERATOR_PUBLIC_KEY` build argument. Self-hosters rebuild the daemon image with their organization's operator public key substituted in. Self-hosters who run unmodified hosted images implicitly trust the Sidekicks operator key; this is the same trust boundary any signed-container-image ecosystem imposes.

The operator signing key is distinct from participant identity keys ([ADR-010](./010-paseto-webauthn-mls-auth.md), [ADR-021](./021-cli-identity-key-storage-custody.md)). It never signs participant-scoped artifacts. It signs only operator-produced, operator-released artifacts (daemon images; the V1 compiled policy set's detached signature; V1.1+ policy bundles).

### Signing Algorithm

- **Primary:** Ed25519 (FIPS 186-5 approved; consistent with ADR-010 PASETO v4 and ADR-021 participant identity keys; small signatures; constant-time implementations widely available).
- **Configurable fallback:** ECDSA P-256 for deployments requiring FIPS 140-3 module validation where an Ed25519 module is not yet available in the operator's compliance envelope.

Signature algorithm is selected at build time per daemon image. Daemons reject bundles signed with an algorithm other than the one their pinned key uses.

### Policy Bundle Format (V1.1+)

```
policy-bundle-v{N}.cedar.tar.gz
  manifest.json           # bundle version N, build timestamp, algorithm, hash
  policies/*.cedar        # Cedar policy files
  schema.cedarschema.json # Cedar schema the policies validate against
policy-bundle-v{N}.cedar.tar.gz.sig  # detached signature over the tar.gz
```

The manifest records the bundle version `N` (monotonic unsigned integer), the build timestamp, the signing algorithm, and the SHA-256 hash of the tarball contents. The detached signature covers the tarball bytes.

### Atomic, Versioned Updates

The bundle version `N` is a monotonic unsigned integer baked into the signed manifest. The daemon persists `last_verified_bundle_version` in its local SQLite store. When evaluating a candidate bundle:

- If `candidate.N <= last_verified_bundle_version`: **reject** (rollback protection; prevents an attacker who captures an older signed bundle from replaying it against a daemon that has already accepted a newer one).
- If `candidate.N > last_verified_bundle_version` and signature verifies and manifest timestamp is within freshness window: **accept atomically** (swap the evaluator's policy set, then persist the new `last_verified_bundle_version` in the same local transaction).

Partial-apply is not permitted. A bundle is accepted whole or rejected whole.

### Verification On Daemon Start And Update

On every daemon start and on every bundle-update attempt, the daemon:

1. Parses the detached `.sig` using the algorithm pinned at the daemon's build time (not a value read from `manifest.algorithm`). A bundle whose `manifest.algorithm` disagrees with the pinned algorithm is rejected with `policy-bundle-algorithm-mismatch` before any cryptographic verification is attempted, closing the attack where a malicious bundle advertises the pinned algorithm while its `.sig` is produced under a different one.
2. Verifies the signature against the pinned operator public key.
3. Recomputes the SHA-256 hash of the bundle tarball and checks against the manifest hash.
4. Checks the manifest timestamp is within the daemon's freshness window (V1.1 default: 180 days; operator-configurable at build time).
5. Checks the monotonic version counter per the rule above.

If any step fails, the daemon **fails closed**: it does not evaluate approvals against the unverified bundle, it does not fall back to any previous in-memory bundle, and it reports `ApprovalPolicyEngineUnavailable` via `RecoveryStatusRead`. Operators resolve the failure via the runbook (see below).

### V1 Operator Key Lifecycle

V1 is deliberately minimal. Pretending otherwise would be the larger risk.

- **Normal rotation:** The operator generates a new signing keypair, builds a new daemon image with the new public key pinned in place of the old, **re-signs the build-embedded compiled policy set under the new key and verifies it locally before publishing** (all topologies — an image pinned to the new key but carrying a policy set still signed by the old key fails startup with `policy-artifact-signature-invalid`), releases the new image, and notifies daemon operators to upgrade. V1 does not support dual-pinning, so rotation is a coordinated upgrade event, not a hot rotation. Full procedure: [Cedar Policy Signing And Rotation](../operations/cedar-policy-signing-and-rotation.md) §Scenario C.
- **Compromise response:** The operator revokes the compromised key from release infrastructure, generates a replacement keypair, publishes an emergency daemon image pinned to the replacement public key **with the build-embedded compiled policy set re-signed under the replacement key and locally verified — so the compromised key is out of the policy-artifact chain, not just the image signature**, and advises daemon operators to upgrade immediately. Daemons that have not yet upgraded will continue to accept artifacts signed by the compromised key until they upgrade — this gap is acknowledged and not papered over. Operators requiring stronger compromise semantics must forward-declare to V2+ (see below).
- **Multi-signature thresholds:** Not supported in V1. The operator release key is a single keypair held by the operator release infrastructure.

### Forward Declarations For V2+

The V1/V1.1 design deliberately leaves the following for V2+:

- **TUF (The Update Framework):** role-based multi-signature thresholds with snapshot/targets/timestamp/root role separation and rollback protection beyond the monotonic counter (TUF spec v1.0.34 as of 2026-01-22).
- **Sigstore keyless (Fulcio):** short-lived OIDC-bound signing certificates, eliminating long-lived operator key custody as a category.
- **Rekor transparency log:** third-party tamper-evident append-only record of operator signing events (Rekor v2 GA as of 2026).
- **Post-quantum signatures:** ML-DSA (FIPS 204) or SLH-DSA (FIPS 205) hybrids alongside Ed25519. NIST finalized Aug 2024; no production-grade PQC signing tooling integrates cleanly into container-image and policy-bundle release pipelines as of 2026-04.
- **Online revocation / CRL:** V1 has no way to revoke a published bundle or image short of publishing a newer one with a higher version counter. An online revocation channel is V2+ scope.
- **HSM-backed operator key custody:** V1 assumes the operator release infrastructure holds the signing key. Hardware root-of-trust custody of the operator key is V2+ scope.

### Cedar Version Pin

The daemon pins `@cedar-policy/cedar-wasm` at Cedar **v4.11** from **V1** (current stable as of 2026-06; verified against the npm registry at the Tier-6 audit; the resident evaluator ships at V1 per the 2026-07-02 amendment, and Plan-012 D-012-9 pins 4.11.x on the embedded set). Policy bundles (V1.1+) declare their target Cedar version in the manifest. Daemons reject bundles whose target version does not match the daemon's compiled cedar-wasm version. Cedar major-version upgrades are a coordinated daemon-image upgrade event and require an ADR-012 amendment.

### Related Operational Docs

The operational procedures for signing a V1.1 policy bundle, diagnosing a daemon that refuses to enforce approvals because signature verification failed, rotating the operator signing key, and responding to a suspected operator-key compromise are in:

- [Cedar Policy Signing And Rotation](../operations/cedar-policy-signing-and-rotation.md)

## Decision Validation

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [ ] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Approval categories expressible purely in Cedar (no app-side fallback) | 9 / 9 categories from the canonical `ApprovalCategory` enum | Policy spec review | `2026-07-01` |
| Cedar end-to-end policy decision latency per request — WASM build, **including JS↔WASM marshaling** (empirical target; no published WASM benchmark exists — 2026-07-02 B8 amendment) | < 1 ms at p95 | Campaign B13 benchmark, then approval service metrics | `2026-10-01` |
| Operator-initiated policy updates that ship without a code deploy (V1.1) | 100% of tuning changes post-V1.1 | Change log of policy sets vs code releases | `2026-12-01` |

## References

**2026-07-02 amendment (campaign B8) sources:**

- [AWS — Amazon Verified Permissions at scale](https://aws.amazon.com/blogs/security/use-amazon-verified-permissions-for-fine-grained-authorization-at-scale/) — the decision-caching guidance (a remote-PDP optimization carrying an explicit staleness warning) whose scope the amendment narrows to exclude the local in-process authorizer
- [Zanzibar: Google's Consistent, Global Authorization System (USENIX ATC '19)](https://www.usenix.org/conference/atc19/presentation/pang) — the distributed-authorizer caching precedent acknowledged as valid outside the local in-process posture
- Cedar native-engine benchmarks — [arXiv:2403.04651](https://arxiv.org/abs/2403.04651) / [OOPSLA 2024](https://dl.acm.org/doi/10.1145/3649835): the published microsecond figures measure the native engine only
- [cedar-wasm README](https://github.com/cedar-policy/cedar/blob/main/cedar-wasm/README.md) — carries no WASM performance claims, hence the `<1ms p95` target is empirical, measured end-to-end including JS↔WASM marshaling (benched by the campaign's B13 task)

- [ADR-007: Collaboration Trust And Permission Model](./007-collaboration-trust-and-permission-model.md)
- [Spec-012: Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)
- [Cedar Language -- CNCF Sandbox](https://www.cedarpolicy.com/)
- [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-04-15 | Proposed | Initial draft |
| 2026-04-15 | Accepted | ADR accepted |
| 2026-06-10 | Clarified | Tier-6 plan-readiness audit (Plan-012 D-012-9): the V1 evaluation engine is `@cedar-policy/cedar-wasm` (`isAuthorized`) running in-process over the build-embedded, signature-verified compiled policy set — the V1→V1.1 delta is the policy SOURCE only (build-embedded static set → runtime-loaded signed bundle); the engine is identical in both phases. A thrown evaluation error maps to deny (fail-closed), never allow. Pins the §Decision ambiguity ("compiled from YAML" named no V1 evaluator); reverses nothing. |
| 2026-06-10 | Clarified | Tier-6 audit (Plan-012 D-012-9): the V1 verified artifact, as enforced in-process, is the compiled Cedar policy set — Ed25519 detached signature over its canonical bytes under the operator release key, verified against the pinned `OPERATOR_PUBLIC_KEY` on every daemon start BEFORE any PermissionCheck is served; verification failure → the daemon refuses to start (typed log `policy-artifact-signature-invalid`). This realizes §Scope By Phase (V1) in both topologies (containerized AND shell-spawned desktop daemon, where no container image exists); whole-image signing remains the distribution pipeline's supply-chain layer, not an in-process check. |
| 2026-06-10 | Corrected | Tier-6 audit (Plan-012 D-012-9): package name `@cedarpolicy/cedar-wasm` → `@cedar-policy/cedar-wasm` (the unhyphenated scope does not exist on npm — 404 verified 2026-06-10; dependency-confusion hazard). Version pin re-anchored to Cedar v4.11 (current stable, npm-verified). |
| 2026-07-02 | Amended — resident-authorizer posture + scoped no-caching + empirical WASM latency target | Capability-enhancement campaign (B8), P1-7. Records the V1 authorizer posture as **resident compiled-authorizer**: the signature-verified compiled Cedar policy set is parsed once and held resident in-process (building on the 2026-06-10 `@cedar-policy/cedar-wasm` `isAuthorized` in-process ruling above), then evaluated per request with **no decision cache**. Decision caching is rejected **scoped to the local in-process authorizer only** ("buys nothing at in-process latency and adds policy-update staleness") — not a universal anti-pattern: remote-PDP / Zanzibar-style caching stays valid elsewhere (§9 BP-11 of the campaign design — AWS's caching guidance is a remote-PDP optimization carrying an explicit staleness warning). The §Success Criteria "Cedar policy evaluation latency per request `< 1 ms at p95`" row (Check Date `2026-10-01`) is retied as an **empirical** target **measured end-to-end on the WASM build including JS↔WASM marshaling** (§9 BP-12 — published microsecond figures are the native engine; no WASM benchmark exists), benchmarked before that Check Date by the Plan-012 bundle (B13). Engine and YAML→Cedar decision unchanged; ADR stays `accepted`. |
