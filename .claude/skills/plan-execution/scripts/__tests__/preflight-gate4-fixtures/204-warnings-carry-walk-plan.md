---
status: approved
audit_complete: true
---

# Plan-204 fixture — skipped S phase's demoted warnings carry to the walk's selection

## Status Promotion

- [x] **Plan-readiness audit complete**

### Shipment Manifest

```yaml
manifest_schema_version: 1
shipped: []
```

### Phase 1 — S phase with a demoted grammar defect AND an unmet precondition

**Precondition:** Plan-099 Phase 1 merged.

#### Tasks

- **T-204-1.1** — Task whose only G4 defect is grammar-shaped
  - **Files:** `packages/a/src/x.ts`
  - **Spec coverage:** xyz random junk
  - **Verifies invariant:** I-204-1
- **T-204-1.2** — Valid sibling keeping the phase M-classified (demotion still applies)
  - **Files:** `packages/a/src/y.ts`
  - **Spec coverage:** none (test placeholder)
  - **Verifies invariant:** I-204-2

### Phase 2 — Clean phase the walk selects

#### Tasks

- **T-204-2.1** — Valid task
  - **Files:** `packages/a/src/z.ts`
  - **Spec coverage:** none (test placeholder)
  - **Verifies invariant:** I-204-3
