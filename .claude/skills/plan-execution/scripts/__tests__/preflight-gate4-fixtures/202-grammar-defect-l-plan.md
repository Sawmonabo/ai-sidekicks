---
status: approved
audit_complete: true
---

# Plan-202 fixture — 4-task L-class plan carrying the SAME grammar defect

## Status Promotion

- [x] **Plan-readiness audit complete**

### Shipment Manifest

```yaml
manifest_schema_version: 1
shipped: []
```

### Phase 1 — Fixture phase

#### Tasks

- **T-202-1.1** — Task with the unparseable cite form
  - **Files:** `packages/a/src/x.ts`
  - **Spec coverage:** xyz random junk
  - **Verifies invariant:** I-1
- **T-202-1.2** — Valid task
  - **Files:** `packages/a/src/y.ts`
  - **Spec coverage:** none (test placeholder)
  - **Verifies invariant:** I-2
- **T-202-1.3** — Valid task
  - **Files:** `packages/b/src/z.ts`
  - **Spec coverage:** none (test placeholder)
  - **Verifies invariant:** I-3
- **T-202-1.4** — Valid task
  - **Files:** `apps/c/src/w.ts`
  - **Spec coverage:** none (test placeholder)
  - **Verifies invariant:** I-4
