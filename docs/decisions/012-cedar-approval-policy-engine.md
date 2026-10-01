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

The system defines approval categories that govern what actions agents may take autonomously versus what requires human confirmation. Microsoft's Agent Governance Toolkit uses Cedar for agent policy enforcement. Cedar's principal-action-resource-context model maps directly to approval decisions (who is requesting, what action, on what resource, under what session context). Keeping the rules as policy text in their own files, apart from the code that asks for a decision, makes them one rule set that can be read and tested on its own.

## Problem Statement

What policy engine should evaluate the approval categories so that authorization decisions stay readable, testable as one rule set, and separate from the code that asks for them?

### Trigger

Approval logic spread through application code has no single rule set to read or to test against reference cases. A dedicated policy engine has to be chosen before the approval specs and UI surface are built.

## Decision

Use Cedar (CNCF sandbox) as the approval policy engine. The built-in approval rules are `.cedar` files in the service's own source, compiled into the service with it, and changed and shipped only by an app update, like any other code. The service evaluates them in-process with the resident `@cedar-policy/cedar-wasm` authorizer: the policy set and schema are parsed once at start and held resident, then evaluated **per request with no decision cache**, so a decision is never served stale against a changed remembered rule, project trust or posture. A decision cache buys nothing at in-process latency for this local authorizer.

## Alternatives Considered

### Option A: Cedar with rules written in Cedar (Chosen)

- **What:** Write the approval rules as `.cedar` files in the service's own source, compile them into the service with it, and evaluate them in-process with the resident Cedar WASM authorizer.
- **Steel man:** Cedar's principal-action-resource-context model is purpose-built for authorization. CNCF backing signals longevity. WASM target enables in-process evaluation without native FFI.

### Option B: OPA / Rego (Rejected)

- **What:** Use Open Policy Agent with Rego policy language.
- **Why rejected:** Heavier runtime (Go-native daemon or WASM build), Rego's syntax is less intuitive for action-resource authorization patterns, and the Go toolchain is a poor fit for a TypeScript-native stack.

### Option C: Hardcoded Approval Logic (Rejected)

- **What:** Implement approval checks directly in application code.
- **Why rejected:** The rules end up spread across the code that calls them, with no single rule set to read or to test against reference cases, and every new category becomes another branch in that code.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Cedar's principal-action-resource-context model can express every approval category without contortion. | Cedar is purpose-built for authorization; Microsoft's Agent Governance Toolkit uses it for agent policy. | We would need a second policy language for categories that do not fit, fragmenting the engine. |
| 2 | Cedar WASM is usable in-process from a TypeScript host without unacceptable startup or evaluation overhead. | Cedar publishes WASM artifacts; the microsecond policy-evaluation benchmarks are **native-engine** figures — the WASM path (including JS↔WASM marshaling) has no published benchmark and stays unvalidated until the end-to-end benchmark in §Decision Validation is run. | We would need a sidecar policy service or a native Go/Rust binding, complicating deployment. |
| 3 | Cedar remains an actively maintained CNCF project over the product lifetime. | Cedar is a CNCF sandbox project with AWS and Microsoft involvement and a published roadmap. | If Cedar stagnates, we would migrate to OPA/Rego or a bespoke engine — a multi-quarter effort. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A policy category cannot be expressed cleanly in Cedar | Med | Med | Policy review during spec implementation; unit tests against reference cases | Extend the Cedar context attributes the service passes for that category |
| Cedar WASM has a correctness bug that allows or denies unintended actions | Low | High | The policy test suite's reference cases for every category | Pin the Cedar version, and fix forward with an app update that carries a corrected Cedar release or a rule written around the bug |
| A rule written in Cedar produces an unexpected refusal or an unexpected allow | Med | Med | The policy test suite's reference cases for every category, run with the service's tests on every change to the rules | Correct the `.cedar` file and ship it in the next app update |
| Cedar upstream introduces breaking changes that invalidate the rules | Low | Med | Upstream release notes and the policy test suite run against each new Cedar release | A Cedar upgrade ships in an app update together with the rules adjusted to it |

## Reversibility Assessment

- **Reversal cost:** Medium. Policies and their evaluation sites are well isolated, but every approval path calls the policy engine, so replacement touches each integration.
- **Blast radius:** Approval service, CLI/desktop approval prompts, approval records, and any runtime code that branches on approval decisions.
- **Migration path:** Every check goes through the daemon's one permission-check service, so replacing Cedar means rewriting the `.cedar` rules for the new engine, swapping the evaluator behind that service, and passing the same reference cases, shipped in one app update.
- **Point of no return:** The rule set grows with each approval category, so a later replacement means translating every rule.

## Consequences

### Positive

- Policies are one rule set, kept apart from the code that asks for a decision, and testable against reference cases
- Cedar's authorization model is a natural fit for approval decisions
- WASM target keeps policy evaluation in-process with no sidecar

### Negative (accepted trade-offs)

- Cedar is newer and less widely adopted than OPA; smaller ecosystem of tooling and examples
- A rule change ships only with an app update, like any other code change

## Cedar Version Pin

The daemon depends on `@cedar-policy/cedar-wasm` on the Cedar **v4.11** line (12.9 MB unpacked at 4.11.2; [Plan-010](../plans/010-approvals-permissions-and-trust-boundaries.md) pins 4.11.x). A Cedar upgrade ships in an app update, with the built-in rules checked against it by the policy test suite.

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Approval categories expressible purely in Cedar (no app-side fallback) | Every category of the canonical `ApprovalCategory` enum | Policy spec review | When the approval policy set lands |
| Cedar end-to-end policy decision latency per request — WASM build, **including JS↔WASM marshaling** (empirical target; no published WASM benchmark exists) | < 1 ms at p95 | End-to-end benchmark, then approval service metrics | When the composed approval gate is benchmarked, before it ships |

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
