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

The workflow actions — authoring a workflow, starting a run, canceling one and resuming one — need a policy that decides what an agent may do on its own and what needs a person's confirmation. Microsoft's Agent Governance Toolkit uses Cedar for agent policy enforcement. Cedar's principal-action-resource-context model maps directly to approval decisions (who is requesting, what action, on what resource, under what session context). Keeping the rules as policy text in their own files, apart from the code that asks for a decision, makes them one rule set that can be read and tested on its own.

## Problem Statement

What policy engine should decide the workflow actions so that authorization decisions stay readable, testable as one rule set, and separate from the code that asks for them?

### Trigger

Approval logic spread through application code has no single rule set to read or to test against reference cases. A dedicated policy engine has to be chosen before the approval specs and UI surface are built.

## Decision

Use Cedar (CNCF sandbox) as the approval policy engine. The built-in approval rules are `.cedar` files in the service's own source, compiled into the service with it, and changed and shipped only by an app update, like any other code. The service evaluates them in-process with `cedar-policy`'s authorizer, linked into the service: the policy set and schema are parsed once at start and held resident, then evaluated **per request with no decision cache**, so a decision is never served stale against a changed approval rule, project trust or posture. A decision cache buys nothing at in-process latency for this local authorizer.

The rules decide the workflow actions: `workflow::author`, `workflow::start`, `workflow::cancel` and `workflow::resume`. Messaging other sessions and the browser tools hold no rules: each call is gated by the calling session's permission level alone, like any other tool call ([Spec-014 §Sessions Talking To Each Other](../specs/014-multi-agent-orchestration.md#sessions-talking-to-each-other)). A provider's own ask gets either one of the few designed answers, written as plain code — the refusal of `claude agents`, `claude daemon` and `claude --bg`, the allow of an agent's own memory-folder `.md` file, and the answer to a Codex ask Codex has no command of its own for — or the person's approval card; no Cedar rule decides it, because each permission level is one of the provider's own modes underneath. These are fixed answers, not policy, so they sit outside the rule set.

## Alternatives Considered

### Option A: Cedar with rules written in Cedar (Chosen)

- **What:** Write the approval rules as `.cedar` files in the service's own source, compile them into the service with it, and evaluate them in-process with `cedar-policy`'s resident authorizer, linked into the service.
- **Steel man:** Cedar's principal-action-resource-context model is purpose-built for authorization. CNCF backing signals longevity. Cedar's own engine is a Rust crate, so the service links it directly, with no foreign-function boundary.

### Option B: OPA / Rego (Rejected)

- **What:** Use Open Policy Agent with Rego policy language.
- **Why rejected:** Heavier runtime (Go-native daemon or WASM build), Rego's syntax is less intuitive for action-resource authorization patterns, and the Go toolchain would be a second toolchain beside the Rust service.

### Option C: Hardcoded Approval Logic (Rejected)

- **What:** Implement approval checks directly in application code.
- **Why rejected:** The rules end up spread across the code that calls them, with no single rule set to read or to test against reference cases, and every new category becomes another branch in that code.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Cedar's principal-action-resource-context model can express every workflow action without contortion. | Cedar is purpose-built for authorization; Microsoft's Agent Governance Toolkit uses it for agent policy. | We would need a second policy language for actions that do not fit, fragmenting the engine. |
| 2 | Policy decision latency per request through `cedar-policy`'s `Authorizer::is_authorized`, under 1 ms at p95, benchmarked once in the composed approval gate's unit. | Cedar's published microsecond policy-evaluation benchmarks measure the native engine the service links; the figure is confirmed by the benchmark in §Decision Validation. | Every gated action would wait on its decision, and the rule set would have to be split so each request evaluates fewer policies. |
| 3 | Cedar remains an actively maintained CNCF project over the product lifetime. | Cedar is a CNCF sandbox project with AWS and Microsoft involvement and a published roadmap. | If Cedar stagnates, we would migrate to OPA/Rego or a bespoke engine — a multi-quarter effort. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A policy category cannot be expressed cleanly in Cedar | Med | Med | Policy review during spec implementation; unit tests against reference cases | Extend the Cedar context attributes the service passes for that category |
| Cedar has a correctness bug that allows or denies unintended actions | Low | High | The policy test suite's reference cases for every category | Pin the Cedar version, and fix forward with an app update that carries a corrected Cedar release or a rule written around the bug |
| A rule written in Cedar produces an unexpected refusal or an unexpected allow | Med | Med | The policy test suite's reference cases for every category, run with the service's tests on every change to the rules | Correct the `.cedar` file and ship it in the next app update |
| Cedar upstream introduces breaking changes that invalidate the rules | Low | Med | Upstream release notes and the policy test suite run against each new Cedar release | A Cedar upgrade ships in an app update together with the rules adjusted to it |

## Reversibility Assessment

- **Reversal cost:** Medium. Policies and their evaluation sites are well isolated, but every approval path calls the policy engine, so replacement touches each integration.
- **Blast radius:** Approval service, CLI/desktop approval prompts, approval records, and any runtime code that branches on approval decisions.
- **Migration path:** Every check goes through the daemon's one permission-check service, so replacing Cedar means rewriting the `.cedar` rules for the new engine, swapping the evaluator behind that service, and passing the same reference cases, shipped in one app update.
- **Point of no return:** The rule set grows with each action it decides, so a later replacement means translating every rule.

## Consequences

### Positive

- Policies are one rule set, kept apart from the code that asks for a decision, and testable against reference cases
- Cedar's authorization model is a natural fit for approval decisions
- The Rust engine links into the service, so policy evaluation runs in-process with no sidecar

### Negative (accepted trade-offs)

- Cedar is newer and less widely adopted than OPA; smaller ecosystem of tooling and examples
- A rule change ships only with an app update, like any other code change

## Cedar Version Pin

The daemon depends on the `cedar-policy` crate on the Cedar **v4.13** line ([Plan-009](../plans/009-approvals-permissions-and-trust-boundaries.md) pins 4.13.0), with its experimental `partial-eval` feature off. A Cedar upgrade ships in an app update, with the built-in rules checked against it by the policy test suite.

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Decisions about the workflow actions expressible purely in Cedar (no app-side fallback) | Every workflow action | Policy spec review | When the approval policy set lands |
| Policy decision latency per request through `cedar-policy`'s `Authorizer::is_authorized` | < 1 ms at p95 | Benchmarked once in the composed approval gate's unit | When the composed approval gate is benchmarked, before it ships |

## References

**Sources for the resident-authorizer posture, the scoped no-caching rule, and the latency target:**

- [AWS — Amazon Verified Permissions at scale](https://aws.amazon.com/blogs/security/use-amazon-verified-permissions-for-fine-grained-authorization-at-scale/) — decision-caching guidance for a remote PDP, carrying an explicit staleness warning; it does not cover the local in-process authorizer
- [Zanzibar: Google's Consistent, Global Authorization System (USENIX ATC '19)](https://www.usenix.org/conference/atc19/presentation/pang) — the distributed-authorizer caching precedent acknowledged as valid outside the local in-process posture
- Cedar native-engine benchmarks — [arXiv:2403.04651](https://arxiv.org/abs/2403.04651) / [OOPSLA 2024](https://dl.acm.org/doi/10.1145/3649835): the published microsecond figures measure the native engine the service links
- [cedar-wasm README](https://github.com/cedar-policy/cedar/blob/main/cedar-wasm/README.md) — carries no WASM performance claims

- [ADR-007: Device Trust and Permission Model](./007-device-trust-and-permission-model.md)
- [Spec-010: Approvals Permissions And Trust Boundaries](../specs/010-approvals-permissions-and-trust-boundaries.md)
- [Cedar Language -- CNCF Sandbox](https://www.cedarpolicy.com/)
- [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)
