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

The system defines approval categories that govern what actions agents may take autonomously versus what requires human confirmation. Microsoft's Agent Governance Toolkit uses Cedar for agent policy enforcement. Cedar's principal-action-resource-context model maps directly to approval decisions (who is requesting, what action, on what resource, under what session context). Externalizing policies from application code makes them auditable and changeable without redeployment.

## Problem Statement

What policy engine should evaluate the approval categories so that authorization decisions stay auditable, tunable, and decoupled from application release cadence?

### Trigger

Approval logic written inside application code cannot be audited, and no policy in it changes without a full deploy. A dedicated policy engine has to be chosen before the approval specs and UI surface are built.

## Decision

Use Cedar (CNCF sandbox) as the approval policy engine. The built-in approval rules are `.cedar` files in the service's own source, compiled into the service with it, and shipped in one signed bundle form that carries the built-in approval rules and every later one: the set built into the service is the first bundle, and a later bundle arrives on the update feed, so an approval rule is fixed without a service update. Every bundle passes the same verifier (§Policy Chain of Custody) and is evaluated in-process by the resident `@cedar-policy/cedar-wasm` authorizer — each verified bundle's set is parsed once and held resident, then evaluated **per request with no decision cache**, so a decision is never served stale. Decision caching is rejected for this local in-process authorizer: it buys nothing at in-process latency and adds policy-update staleness.

## Alternatives Considered

### Option A: Cedar with rules written in Cedar (Chosen)

- **What:** Write the approval rules as `.cedar` files in the service's own source, compile them into the service with it, ship them as signed bundles, and evaluate in-process with the resident Cedar WASM authorizer; the built-in set and every later bundle go through one verifier.
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
| 1 | Cedar's principal-action-resource-context model can express every approval category without contortion. | Cedar is purpose-built for authorization; Microsoft's Agent Governance Toolkit uses it for agent policy. | We would need a second policy language for categories that do not fit, fragmenting the engine. |
| 2 | Cedar WASM is usable in-process from a TypeScript host without unacceptable startup or evaluation overhead. | Cedar publishes WASM artifacts; the microsecond policy-evaluation benchmarks are **native-engine** figures — the WASM path (including JS↔WASM marshaling) has no published benchmark and stays unvalidated until the end-to-end benchmark in §Decision Validation is run. | We would need a sidecar policy service or a native Go/Rust binding, complicating deployment. |
| 3 | Shipping an approval-rule fix as a signed bundle on the update feed is fast enough that no rule ever needs a service update to change. | A bundle is one more file on the update feed the service already checks, verified in well under the 20 ms budget (§Verification Cost) and swapped in between two checks with no restart. | A rule fix would wait for a full service release, leaving a known-wrong rule in force on every machine meanwhile. |
| 4 | Cedar remains an actively maintained CNCF project over the product lifetime. | Cedar is a CNCF sandbox project with AWS and Microsoft involvement and a published roadmap. | If Cedar stagnates, we would migrate to OPA/Rego or a bespoke engine — a multi-quarter effort. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A policy category cannot be expressed cleanly in Cedar | Med | Med | Policy review during spec implementation; unit tests against reference cases | Extend Cedar context attributes or fall back to an application-level pre-check for that category |
| Cedar WASM has a correctness bug that allows or denies unintended actions | Low | High | Policy test suite plus canary evaluation comparing WASM vs reference interpreter | Pin Cedar versions, add dual-evaluation for sensitive categories, and fix forward with a newer bundle — versions only rise, so a fix is never a rollback |
| A rule written in Cedar produces an unexpected refusal or an unexpected allow | Med | Med | The policy test suite's reference cases for every category, run by the release workflow before a bundle is signed | Fix forward with a newer bundle on the update feed |
| Cedar upstream introduces breaking changes that invalidate stored policies | Low | Med | Upstream release notes and pinned CI on new Cedar versions | Each bundle's manifest names its `cedarVersion`, and the service refuses a bundle built for another; a Cedar upgrade ships with a service update and a bundle rebuilt for it |

## Reversibility Assessment

- **Reversal cost:** Medium. Policies and their evaluation sites are well isolated, but every approval path calls the policy engine, so replacement touches each integration.
- **Blast radius:** Approval service, CLI/desktop approval prompts, audit logs, and any runtime code that branches on approval decisions.
- **Migration path:** Introduce an engine-agnostic policy interface, run Cedar and a replacement engine in shadow mode, diff decisions, then cut over once divergence is zero.
- **Point of no return:** After policies accumulate in production and audit logs reference Cedar policy identifiers, replacement requires a coordinated policy-translation effort.

## Consequences

### Positive

- Policies are externalized, auditable, and modifiable without a service update: a fix ships as a signed bundle on the update feed
- Cedar's authorization model is a natural fit for approval decisions
- WASM target keeps policy evaluation in-process with no sidecar

### Negative (accepted trade-offs)

- Cedar is newer and less widely adopted than OPA; smaller ecosystem of tooling and examples
- Every bundle carries two signatures and a public signing record, so a rule change needs the project's own release workflow to run; there is no quicker path, by design
- The Sigstore verifier needs a one-line `pnpm patch` under the Electron runtime until an upstream release contains it (§Dependencies)

## Policy Chain of Custody

Cedar's security model assumes trustworthy policy input. A daemon that evaluates attacker-controlled policy text produces attacker-controlled authorization decisions. This section defines how policy artifacts are signed, distributed, verified, versioned, and rotated so that the integrity assumption Cedar relies on is actually established at runtime.

### One Bundle Form

One bundle form carries the built-in approval rules and every later one. The set built into the service is the first bundle, in the same form, and it is checked the same way at every start; a later bundle arrives on the update feed and is checked the same way on arrival. There is one verify path, never two. Signing the service's own build is the release pipeline's layer and is separate from this verifier.

Example: a rule that asks before `git push --force` is widened to also cover `git push -f`. The fix ships as bundle 42. The service picks it up at its next update check and applies it from the next approval on, and `sidekicks daemon status` then prints `Approval rules: bundle 42 · built Sept 20, 2026`.

### Signing Key Identity

Each service build pins two signing key pairs, `current` and `next`, and each pair holds one Ed25519 key and one ML-DSA-65 key (§Signing Algorithm). The project signs with `current`; rotating is signing with `next`, and the following build pins `next` as its `current` beside a new `next` (§Key Rotation And Retirement).

- **Where the keys are held:** the signing keys sit in the release workflow's protected environment — GitHub environment secrets, readable only by the tag-triggered release workflow, with the project's owner as required reviewer. Building and signing a bundle are repository scripts the release workflow runs, not `sidekicks` verbs, because the person never handles a bundle.
- **What the build pins:** the two key pairs, the Sigstore trusted root, the release workflow's identity pattern and the repository's and its owner's numeric ids (§Verification On Daemon Start And Update) are a build input. Dev and test builds pin test material the test setup makes and run the same verifier, so only the pins differ from a release build, never the path, and a dev service starts on its own test-signed built-in bundle. Someone building the service themselves pins their own material the same way.

The bundle signing keys are distinct from user and device identity keys ([ADR-010](./010-tokens-passkeys-and-the-remote-channel.md), [ADR-021](./021-cli-identity-key-storage-custody.md)). They never sign user-scoped artifacts; they sign only approval-rule bundles and the retirement statements of §Key Rotation And Retirement.

### Signing Algorithm

Every bundle carries two signatures over its canonical manifest bytes, which carry the content hashes, and both are required:

- **Ed25519** (FIPS 186-5; consistent with ADR-010 PASETO v4 and ADR-021 user identity keys; small signatures; constant-time implementations widely available).
- **ML-DSA-65** ([FIPS 204](https://csrc.nist.gov/pubs/fips/204/final)), a post-quantum signature, so the bundle holds against a future quantum attacker who can forge Ed25519.

Both are checked with `node:crypto` against the pinned key pairs, and no signature library is added. Ed25519 is native everywhere the service runs; ML-DSA-65 is native on Node 24.16 or later and on the Electron runtime (measured: 192 to 197 µs on Node 24.16, 24.18 and 26.8.1, 362 µs on Electron 44.1.0) and absent on Node 22, so the service's runtime floor is Node 24.16. A bundle missing either signature, or carrying one that fails, is refused.

### Policy Bundle Format

A bundle is one file, `approval-rules-<version>.bundle`, holding:

- a manifest in [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON, made with the service's existing canonicalizer: `{version, builtAt, cedarVersion, schemaSha256, policiesSha256, keyIds}`;
- the compiled Cedar schema and policy text;
- the Ed25519 and ML-DSA-65 signatures over the canonical manifest bytes.

The release workflow publishes the bundle's Sigstore record beside it (§Verification On Daemon Start And Update). A bundle is one more file on the update feed, fetched at the update check the service already makes.

### Atomic, Versioned Updates

The service stores the highest verified `version` and its `builtAt` in its database. A candidate whose `version` is not higher, or whose `builtAt` is earlier than the running bundle's, is refused: an attacker who captures an older signed bundle cannot replay it against a service that has already accepted a newer one. There is no absolute expiry: a machine left offline keeps running the last rules it verified.

A verified bundle is parsed with `preparsePolicySet` and `preparseSchema` and swapped in between two checks, with no restart and no approval evaluated across the swap; an approval already asked keeps its question, and the new rules apply from the next check. The new highest `version` and `builtAt` are persisted with the swap, and the service records `policy_bundle.loaded {version, builtAt}`. A bundle is accepted whole or refused whole.

### Verification On Daemon Start And Update

The built-in bundle at every start, before any `PermissionCheck` is served, and every later bundle on arrival go through the same steps:

1. Canonicalize the manifest and check the schema and policy hashes against the bundle's contents.
2. Verify the Ed25519 and the ML-DSA-65 signatures over the canonical manifest bytes against the pinned `current` and `next` pairs; both are required (§Signing Algorithm).
3. Refuse a bundle signed by a key id the service has recorded as retired (§Key Rotation And Retirement).
4. Verify the bundle's public signing record. The release workflow also signs each bundle keyless through Sigstore: its GitHub OIDC identity gets a short-lived Fulcio certificate, and the signature lands as an entry in the Rekor transparency log. The service verifies that record offline with [`@sigstore/verify`](https://www.npmjs.com/package/@sigstore/verify)'s `Verifier`, against the Sigstore trusted root shipped in its build, and requires a transparency-log entry. The signer is pinned three ways: the issuer `https://token.actions.githubusercontent.com`; the identity as a pattern — the release workflow's fixed path at any release tag, `^https://github\.com/<owner>/<repo>/\.github/workflows/<file>@refs/tags/v\d+\.\d+\.\d+$`, because the certificate names the ref the run fired on and an exact string pinned in one release would refuse the next release's bundle; and the repository's and its owner's numeric ids, carried in the certificate extensions 1.3.6.1.4.1.57264.1.15 and 1.3.6.1.4.1.57264.1.17 ([Fulcio OID reference](https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md)), so a renamed or transferred repository at the same path cannot pass. The shipped trusted root is replaced with each service update, so a bundle signed after Sigstore rotates its own keys verifies from the update that ships the new root.
5. Check the rising version and `builtAt` (§Atomic, Versioned Updates) and that the manifest's `cedarVersion` is the evaluator's (§Cedar Version Pin).
6. Parse the policy set and schema.

**A refused candidate changes nothing.** The service keeps evaluating with the bundle it runs, never loads unverified rules, and records `policy_bundle.rejected {version, reason}`, where `reason` is one of `signature`, `key_retired`, `record` (the Sigstore check), `not_newer`, `malformed` and `cedar`.

**The only start refusal.** The service refuses to start only when no bundle verifies at all, not even the one built into it. `sidekicks daemon status` and Settings › Runtime's service line then read `Stopped: its approval rules did not pass their signature check. Reinstall the app to restore them.`

**What the person sees.** `sidekicks daemon status` prints `Approval rules: bundle <n> · built <date>` (or `built in` for the first bundle), in text and `--json` alike, and the daemon status read carries the same as `approvalRules {version, builtAt, source: "built_in" | "update"}`. Nothing else is drawn.

### Key Rotation And Retirement

- **Hot rotation:** each build pins `current` and `next`. The project rotates by signing with `next`; the following build pins `next` as its `current` beside a new `next`. Every machine already verifies `next`, so rotation needs no coordinated upgrade.
- **Retiring a key early:** the project publishes a retirement statement naming the retired key ids, signed by the other pinned pair and published together with the newest bundle re-signed by that pair. The service records retired ids in its database for good, refuses anything signed by them, and swaps to the re-signed bundle. A retirement statement never arrives alone, so no machine is left without verifiable rules.
- **A copied key alone is not enough:** because every bundle also needs the public signing record, which only the project's own release workflow on its own repository can make, someone who copies both signing keys still cannot ship rules the service accepts, and the attempt would have to appear in the public log.
- **Watching the log:** the project runs a scheduled workflow that searches the transparency log for its release identity and alerts on any entry it did not make.

The procedures are in [Cedar Policy Signing And Rotation](../operations/cedar-policy-signing-and-rotation.md).

### Further Hardening, Item By Item

| Item | What ships |
| --- | --- |
| Multi-signature thresholds (TUF roles, k of n) | Out of scope for one user: thresholds exist so that several people must sign, and the product is one person's. The two-signature rule is the one-signer form. Whether the update feed itself uses TUF metadata is the update feed's decision; if it does, a bundle is one more target in it. |
| Keyless signing (Fulcio) | Ships: every bundle carries a required Sigstore keyless record (§Verification On Daemon Start And Update). |
| Transparency log (Rekor) | Ships: a log entry is required, and the project's scheduled workflow watches the log for entries it did not make. |
| Post-quantum signatures | Ships: ML-DSA-65 beside Ed25519, both required. |
| Online revocation | Ships: signed retirement statements on the update feed. |
| Hardware custody of the signing keys | Not needed: a copied key alone produces nothing the service accepts, because the record check needs the project's own workflow on its own repository. |
| Hot key rotation | Ships: two pinned pairs, `current` and `next`. |

### Verification Cost

Workload: one verification at each start and one per new bundle. Budget: at most 20 ms of processor time and 16 MiB of added heap per verification. Measured with a 64 KiB manifest: SHA-256 29 µs; Ed25519 91 µs on Electron 44.1.0 and 131 to 136 µs on Node; ML-DSA-65 362 µs on Electron and 192 to 197 µs on Node 24.16, 24.18 and 26.8.1; the offline Sigstore check 4.8 to 7.0 ms once its verifier is built, and 2.9 to 14.2 ms to build it. On disk a bundle adds 3,309 bytes of ML-DSA-65 signature and its Sigstore record.

### Dependencies

- **Added:** `@sigstore/verify` 4.1.2, with `@sigstore/core`, `@sigstore/bundle` and `@sigstore/protobuf-specs` (Apache-2.0, 944 KiB on disk); its `engines` range holds on the Electron runtime. Under Electron, `@sigstore/core` calls `crypto.verify` with no digest for EC keys, which BoringSSL refuses; the library turns the error into a failed check, so every check fails there. A one-line `pnpm patch` passes `sha256` for EC and RSA keys when the caller names no digest — the digest Node's OpenSSL uses for both, so every result matches Node's — and Ed25519 keeps passing none; it is offered upstream and carried until a release contains it.
- **Not used:** `sigstore` itself, whose update-framework client fails on the Electron runtime the same way; a shipped trusted root removes the need for that client in the service. `@noble/post-quantum`, which verifies ML-DSA in 2.9 to 3.9 ms, because the service's runtime has ML-DSA natively.

### Cedar Version Pin

The daemon pins `@cedar-policy/cedar-wasm` on the Cedar **v4.11** line from **V1** (12.9 MB unpacked at 4.11.2; [Plan-010](../plans/010-approvals-permissions-and-trust-boundaries.md) pins 4.11.x on the embedded set). Every bundle, the built-in one included, names its target Cedar version in its manifest's `cedarVersion`, and the service refuses a bundle whose target does not match its cedar-wasm version (`policy_bundle.rejected` with reason `cedar`). A Cedar major-version upgrade ships with a service update and a bundle rebuilt for it.

### Related Operational Docs

The procedures for publishing an approval-rules bundle, reading a refused bundle or a service that will not start, rotating a signing key, and retiring a key early after a suspected compromise are in:

- [Cedar Policy Signing And Rotation](../operations/cedar-policy-signing-and-rotation.md)

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Approval categories expressible purely in Cedar (no app-side fallback) | Every category of the canonical `ApprovalCategory` enum | Policy spec review | When the approval policy set lands |
| Cedar end-to-end policy decision latency per request — WASM build, **including JS↔WASM marshaling** (empirical target; no published WASM benchmark exists) | < 1 ms at p95 | End-to-end benchmark, then approval service metrics | When the composed approval gate is benchmarked, before it ships |
| Approval-rule fixes that ship as a bundle without a service update | 100% of rule changes | Bundle releases compared against service releases | When the first rule fix ships as a bundle |

## References

**Sources for the resident-authorizer posture, the scoped no-caching rule, and the empirical WASM latency target:**

- [AWS — Amazon Verified Permissions at scale](https://aws.amazon.com/blogs/security/use-amazon-verified-permissions-for-fine-grained-authorization-at-scale/) — decision-caching guidance for a remote PDP, carrying an explicit staleness warning; it does not cover the local in-process authorizer
- [Zanzibar: Google's Consistent, Global Authorization System (USENIX ATC '19)](https://www.usenix.org/conference/atc19/presentation/pang) — the distributed-authorizer caching precedent acknowledged as valid outside the local in-process posture
- Cedar native-engine benchmarks — [arXiv:2403.04651](https://arxiv.org/abs/2403.04651) / [OOPSLA 2024](https://dl.acm.org/doi/10.1145/3649835): the published microsecond figures measure the native engine only
- [cedar-wasm README](https://github.com/cedar-policy/cedar/blob/main/cedar-wasm/README.md) — carries no WASM performance claims, hence the `<1ms p95` target is empirical, measured end-to-end including JS↔WASM marshaling

- [ADR-007: Device Trust and Permission Model](./007-device-trust-and-permission-model.md)
- [Spec-010: Approvals Permissions And Trust Boundaries](../specs/010-approvals-permissions-and-trust-boundaries.md)
- [Cedar Language -- CNCF Sandbox](https://www.cedarpolicy.com/)
- [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)
- [FIPS 204: Module-Lattice-Based Digital Signature Standard (ML-DSA)](https://csrc.nist.gov/pubs/fips/204/final)
- [Fulcio OID reference](https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md) — the Source Repository Identifier and Source Repository Owner Identifier extensions the signer pin checks
- [`@sigstore/verify`](https://www.npmjs.com/package/@sigstore/verify) — the offline verifier over a shipped trusted root
