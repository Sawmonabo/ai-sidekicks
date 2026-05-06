# Cross-Plan Dependencies (Test Fixture)

## 6. NS Catalog

### NS-02: Plan-001 Phase 5 split + dep alignment

- Status: `in_progress` (last shipped: PR #36, 2026-05-01)
- Type: code (recommended split into 3 atomic PRs)
- Priority: `P1`
- Upstream: none
- References: [Plan-001](../plans/001-shared-session-core.md)
- Summary: Multi-PR fixture entry — final sub-task ships, sequence completes.
- Exit Criteria: All `PRs:` ticks checked.
- PRs:
  - [x] T-001-5-1 — first task (PR #34, merged 2026-04-30)
  - [x] T-001-5-2 — second task (PR #36, merged 2026-05-01)
  - [ ] T-001-5-3 — third task

```mermaid
graph TB
  NS02[NS-02: Plan-001 Phase 5 split<br/>multi-PR shape]:::ready
```
