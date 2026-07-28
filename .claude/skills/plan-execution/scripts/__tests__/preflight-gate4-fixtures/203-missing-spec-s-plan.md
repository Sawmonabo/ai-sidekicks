---
status: approved
audit_complete: true
---

# Plan-203 fixture — 1-task S-class plan citing a nonexistent spec file

## Status Promotion

- [x] **Plan-readiness audit complete**

### Shipment Manifest

```yaml
manifest_schema_version: 1
shipped: []
```

### Phase 1 — Fixture phase

#### Tasks

- **T-203-1.1** — Single fixture task citing a spec absent from the real corpus
  - **Files:** `packages/a/src/x.ts`
  - **Spec coverage:** Spec-100 line 3 (MissingFixtureIdentifier)
  - **Verifies invariant:** I-1
