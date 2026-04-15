# ADR-012: Cedar Approval Policy Engine

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Domain** | `Approval / Policy` |
| **Date** | `2026-04-15` |
| **Author(s)** | `Claude` |

## Context

The system defines 8 approval categories that govern what actions agents may take autonomously versus what requires human confirmation. Microsoft's Agent Governance Toolkit uses Cedar for agent policy enforcement. Cedar's principal-action-resource-context model maps directly to approval decisions (who is requesting, what action, on what resource, under what session context). Externalizing policies from application code makes them auditable and changeable without redeployment.

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

## Consequences

### Positive

- Policies are externalized, auditable, and modifiable without code changes (V1.1)
- Cedar's authorization model is a natural fit for approval decisions
- WASM target keeps policy evaluation in-process with no sidecar

### Negative (accepted trade-offs)

- Cedar is newer and less widely adopted than OPA; smaller ecosystem of tooling and examples
- V1 uses YAML-to-Cedar compilation, adding a build step before full runtime evaluation is available

## References

- [ADR-007: Collaboration Trust And Permission Model](./007-collaboration-trust-and-permission-model.md)
- [Spec-012: Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)
- [Cedar Language -- CNCF Sandbox](https://www.cedarpolicy.com/)
- [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)
