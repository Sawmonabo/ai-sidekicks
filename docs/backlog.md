# Backlog

## How To Use This Backlog

This is the working backlog for the remaining documentation tasks between the current greenfield state and implementation-ready docs.

Keep this file current as the agenda changes. Move items from `todo` to `done` only when the underlying docs have actually been corrected.

## Ready To Begin Implementation When

- canonical status metadata is trustworthy
- the canonical set matches `vision.md`
- foundational vocabulary is consistent across domain, architecture, specs, decisions, plans, and operations
- all required approved specs have concrete implementation plans
- no blocking open question forces implementers to invent behavior
- operations docs are executable enough to support development and recovery work

## Current Agenda

### 1. Re-baseline status truth

- Status: `todo`
- Agenda:
  - Fix the meaning and usage of `approved` and `accepted` across the canonical set.
  - Remove or resolve `TBD` placeholders, unmet gates, unresolved checklist items, and invalid final-state metadata from any doc that keeps a final status.
- Docs in scope:
  - `tmp/002-canonical-doc-backlog.md`
  - `tmp/003-review-checklist.md`
  - `specs/006-session-event-taxonomy-and-audit-log.md`
  - `specs/017-workflow-authoring-and-execution.md`
  - `specs/020-observability-and-failure-recovery.md`
  - `plans/001-shared-session-core.md`
  - `decisions/001-session-is-the-primary-domain-object.md`
  - `decisions/006-worktree-first-execution-mode.md`
  - `decisions/008-default-transports-and-relay-boundaries.md`
- Close when:
  - no canonical doc claims a stronger status than its content supports

### 2. Canonicalize `local-only`

- Status: `todo`
- Agenda:
  - Define `local-only` in the domain vocabulary and align every normative use to the defined concept.
  - Choose the canonical prose spelling and any literal enum form deliberately.
- Docs in scope:
  - `domain/glossary.md`
  - `domain/session-model.md`
  - `specs/001-shared-session-core.md`
  - `architecture/deployment-topology.md`
- Close when:
  - `local-only` is defined once and used consistently everywhere else

### 3. Align recovery and failure vocabulary

- Status: `todo`
- Agenda:
  - Reconcile the run-state machine with all recovery and failure terms used elsewhere.
  - Decide which labels are canonical run states, which are recovery outcomes, and which are observability-only surfaces.
- Docs in scope:
  - `domain/run-state-machine.md`
  - `specs/005-provider-driver-contract-and-capabilities.md`
  - `specs/020-observability-and-failure-recovery.md`
  - `operations/provider-failure-runbook.md`
- Close when:
  - no spec or runbook uses an undefined recovery or failure term as if it were canonical

### 4. Reconcile execution modes with the vision

- Status: `todo`
- Agenda:
  - Make the canonical execution-mode taxonomy match the vision's intended product model.
  - Reconcile `read-only`, `branch`, `worktree`, and `ephemeral clone` with the current `local` and `worktree` model.
- Docs in scope:
  - `vision.md`
  - `domain/repo-workspace-worktree-model.md`
  - `specs/009-repo-attachment-and-workspace-binding.md`
  - `specs/010-worktree-lifecycle-and-execution-modes.md`
  - `specs/011-gitflow-pr-and-diff-attribution.md`
  - `plans/009-repo-attachment-and-workspace-binding.md`
  - `plans/010-worktree-lifecycle-and-execution-modes.md`
  - `decisions/006-worktree-first-execution-mode.md`
- Close when:
  - one authoritative execution-mode model exists end to end

### 5. Reconcile join roles and permission taxonomy

- Status: `todo`
- Agenda:
  - Make the canonical role model match the vision and remove competing role vocabularies.
  - Resolve how `owner`, `viewer`, `collaborator`, `runtime contributor`, and `contributor` relate to each other.
- Docs in scope:
  - `vision.md`
  - `domain/glossary.md`
  - `domain/participant-and-membership-model.md`
  - `specs/002-invite-membership-and-presence.md`
  - `specs/012-approvals-permissions-and-trust-boundaries.md`
  - `specs/018-identity-and-participant-state.md`
  - `decisions/007-collaboration-trust-and-permission-model.md`
- Close when:
  - one role and join-mode taxonomy exists across vision, domain, specs, and identity surfaces

### 6. Standardize implementation topology assumptions

- Status: `todo`
- Agenda:
  - Either define a canonical repo or package topology or remove hard-coded repo-shape assumptions from the plans.
  - Implementation agents should not have to guess whether paths like `packages/runtime-daemon` are normative.
- Docs in scope:
  - `architecture/container-architecture.md`
  - `architecture/component-architecture-local-daemon.md`
  - `architecture/component-architecture-control-plane.md`
  - `architecture/component-architecture-desktop-app.md`
  - `plans/001-shared-session-core.md`
  - `plans/002-invite-membership-and-presence.md`
  - `plans/003-runtime-node-attach.md`
  - `plans/004-queue-steer-pause-resume.md`
  - `plans/005-provider-driver-contract-and-capabilities.md`
  - `plans/009-repo-attachment-and-workspace-binding.md`
  - `plans/010-worktree-lifecycle-and-execution-modes.md`
  - `plans/011-gitflow-pr-and-diff-attribution.md`
- Close when:
  - plans no longer rely on unstated file-layout assumptions

### 7. Author the missing implementation plans

- Status: `todo`
- Agenda:
  - Create canonical plans for every approved spec that still shows `Implementation Plan: TBD`.
  - Work in this order:
    1. `006-session-event-taxonomy-and-audit-log`
    2. `007-local-ipc-and-daemon-control`
    3. `008-control-plane-relay-and-session-join`
    4. `015-persistence-recovery-and-replay`
    5. `020-observability-and-failure-recovery`
    6. `012-approvals-permissions-and-trust-boundaries`
    7. `013-live-timeline-visibility-and-reasoning-surfaces`
    8. `018-identity-and-participant-state`
    9. `019-notifications-and-attention-model`
    10. `014-artifacts-files-and-attachments`
    11. `016-multi-agent-channels-and-orchestration`
    12. `017-workflow-authoring-and-execution`
- Close when:
  - no implementation-critical approved spec remains planless

### 8. Canonicalize the CLI delivery path

- Status: `todo`
- Agenda:
  - Make the vision's CLI milestone explicit in canonical execution docs rather than implied only by architecture prose.
  - Decide whether the CLI gets its own plan or a clearly named delivery track inside the IPC plan.
- Docs in scope:
  - `vision.md`
  - `architecture/system-context.md`
  - `architecture/container-architecture.md`
  - `specs/007-local-ipc-and-daemon-control.md`
  - `plans/007-local-ipc-and-daemon-control.md` once created
- Close when:
  - an implementation agent can locate the CLI delivery path without inference

### 9. Resolve or bound all blocking open questions

- Status: `todo`
- Agenda:
  - Review every open question in approved foundational specs.
  - For each one, choose one of:
    - resolve now
    - explicitly defer with fixed v1 behavior
    - mark the doc as not yet eligible for final status
- Docs in scope:
  - `specs/001-shared-session-core.md`
  - `specs/006-session-event-taxonomy-and-audit-log.md`
  - `specs/007-local-ipc-and-daemon-control.md`
  - `specs/008-control-plane-relay-and-session-join.md`
  - `specs/009-repo-attachment-and-workspace-binding.md`
  - `specs/010-worktree-lifecycle-and-execution-modes.md`
  - `specs/012-approvals-permissions-and-trust-boundaries.md`
  - `specs/013-live-timeline-visibility-and-reasoning-surfaces.md`
  - `specs/014-artifacts-files-and-attachments.md`
  - `specs/015-persistence-recovery-and-replay.md`
  - `specs/016-multi-agent-channels-and-orchestration.md`
  - `specs/017-workflow-authoring-and-execution.md`
  - `specs/018-identity-and-participant-state.md`
  - `specs/019-notifications-and-attention-model.md`
  - `specs/020-observability-and-failure-recovery.md`
- Close when:
  - no approved foundational spec leaves behavior ambiguous enough that implementers must invent product semantics

### 10. Make operations docs executable

- Status: `todo`
- Agenda:
  - Replace undefined references and missing recovery paths in the operations set.
  - Ensure each runbook points to concrete canonical reads, actions, and escalation conditions.
- Docs in scope:
  - `operations/local-daemon-runbook.md`
  - `operations/control-plane-runbook.md`
  - `operations/provider-failure-runbook.md`
  - `operations/replay-and-audit-runbook.md`
  - `operations/template.md`
- Close when:
  - an operator can execute every runbook using only canonical docs

### 11. Repair malformed markdown examples

- Status: `todo`
- Agenda:
  - Fix broken example formatting in the two affected specs.
- Docs in scope:
  - `specs/017-workflow-authoring-and-execution.md`
  - `specs/019-notifications-and-attention-model.md`
- Close when:
  - both specs render valid markdown examples without nested-backtick breakage

### 12. Run the final readiness review

- Status: `todo`
- Agenda:
  - Re-run the review checklist across every touched canonical doc.
  - Update backlog and status metadata only after the underlying issues are actually fixed.
- Docs in scope:
  - `tmp/002-canonical-doc-backlog.md`
  - `tmp/003-review-checklist.md`
  - every doc changed by Steps `1` through `11`
- Close when:
  - the documentation set can be treated as the implementation baseline for the current vision

## Backlog Close Condition

This backlog is complete when the greenfield docs are ready for implementation and the remaining `tmp/` control layer can be deleted without losing anything needed later.
