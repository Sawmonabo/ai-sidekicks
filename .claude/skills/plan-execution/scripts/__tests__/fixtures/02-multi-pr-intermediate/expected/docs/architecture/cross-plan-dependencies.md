# Cross-Plan Dependencies (Test Fixture)

## 6. NS Catalog

### NS-02: Plan-001 Phase 5 split + dep alignment

- Status: `in_progress` (last shipped: PR #34, 2026-05-03)
- Type: code (recommended split into 3 atomic PRs)
- Priority: `P1`
- Upstream: none
- References: [Plan-001](../plans/001-shared-session-core.md)
- Summary: Multi-PR fixture entry — first sub-task ships, leaves remaining ticks open.
- Exit Criteria: All `PRs:` ticks checked.
- PRs:
  - [x] T-001-5-1 — first task (PR #34, merged 2026-05-03)
  - [ ] T-001-5-2 — second task
  - [ ] T-001-5-3 — third task

```mermaid
graph TB
  NS02[NS-02: Plan-001 Phase 5 split<br/>multi-PR shape]:::ready
```
