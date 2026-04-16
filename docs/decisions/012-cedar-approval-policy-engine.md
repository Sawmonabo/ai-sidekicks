# ADR-012: Cedar Approval Policy Engine

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Type** | `Type 2 (one-way door)` |
| **Domain** | `Approval / Policy` |
| **Date** | `2026-04-15` |
| **Author(s)** | `Claude` |
| **Reviewers** | `Accepted 2026-04-15` |

## Context

The system defines 8 approval categories that govern what actions agents may take autonomously versus what requires human confirmation. Microsoft's Agent Governance Toolkit uses Cedar for agent policy enforcement. Cedar's principal-action-resource-context model maps directly to approval decisions (who is requesting, what action, on what resource, under what session context). Externalizing policies from application code makes them auditable and changeable without redeployment.

## Problem Statement

What policy engine should evaluate the 8 approval categories so that authorization decisions stay auditable, operator-tunable, and decoupled from application release cadence?

### Trigger

Approval logic was accumulating inside application code, making it impossible to audit or modify policies without a full deploy. The architecture program needs to pick a dedicated policy engine before approval specs and UI surface freeze.

## Decision

Use Cedar (CNCF sandbox) as the approval policy engine. V1 defines policies in YAML that are compiled to Cedar at build time. V1.1 evaluates Cedar WASM for runtime policy evaluation, enabling dynamic policy updates without redeployment.

## Alternatives Considered

### Option A: Cedar with YAML Policy Definitions (Chosen)

- **What:** Define approval policies in YAML, compile to Cedar policy sets. Evaluate with Cedar WASM in V1.1.
- **Steel man:** Cedar's principal-action-resource-context model is purpose-built for authorization. CNCF backing signals longevity. WASM target enables in-process evaluation without native FFI.

### Option B: OPA / Rego (Rejected)

- **What:** Use Open Policy Agent with Rego policy language.
- **Why rejected:** Heavier runtime (Go-native daemon or WASM build), Rego's syntax is less intuitive for action-resource authorization patterns, and the Go toolchain is a poor fit for a TypeScript-native stack.

### Option C: Hardcoded Approval Logic (Rejected)

- **What:** Implement approval checks directly in application code.
- **Why rejected:** Not auditable. Every policy change requires a code change, review, and deployment. Cannot be inspected or overridden by administrators without developer involvement.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
|---|-----------|----------|----------------------|
| 1 | Cedar's principal-action-resource-context model can express all 8 approval categories without contortion. | Cedar is purpose-built for authorization; Microsoft's Agent Governance Toolkit uses it for agent policy. | We would need a second policy language for categories that do not fit, fragmenting the engine. |
| 2 | Cedar WASM is usable in-process from a TypeScript host without unacceptable startup or evaluation overhead. | Cedar publishes WASM artifacts; policy evaluation benchmarks are in the microsecond range for typical request counts. | We would need a sidecar policy service or a native Go/Rust binding, complicating deployment. |
| 3 | YAML-to-Cedar compilation in V1 gives operators enough authoring ergonomics until runtime evaluation ships in V1.1. | YAML captures the structural aspects of policies; runtime Cedar arrives as soon as WASM integration is proven. | Operators demand live policy edits before V1.1, forcing an earlier WASM ship with more risk. |
| 4 | Cedar remains an actively maintained CNCF project over the product lifetime. | Cedar is a CNCF sandbox project with AWS and Microsoft involvement and a published roadmap. | If Cedar stagnates, we would migrate to OPA/Rego or a bespoke engine — a multi-quarter effort. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
|----------|-----------|--------|-----------|------------|
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
- V1 uses YAML-to-Cedar compilation, adding a build step before full runtime evaluation is available

## Decision Validation

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [ ] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
|--------|--------|--------------------|------------|
| Approval categories expressible purely in Cedar (no app-side fallback) | 8 / 8 categories | Policy spec review | `2026-07-01` |
| Cedar policy evaluation latency per request | < 1 ms at p95 | Approval service metrics | `2026-10-01` |
| Operator-initiated policy updates that ship without a code deploy (V1.1) | 100% of tuning changes post-V1.1 | Change log of policy sets vs code releases | `2026-12-01` |

## References

- [ADR-007: Collaboration Trust And Permission Model](./007-collaboration-trust-and-permission-model.md)
- [Spec-012: Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)
- [Cedar Language -- CNCF Sandbox](https://www.cedarpolicy.com/)
- [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-15 | Proposed | Initial draft |
| 2026-04-15 | Accepted | ADR accepted |
