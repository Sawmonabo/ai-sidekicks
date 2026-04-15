# Plan-{NNN}: {Title}

<!--
  Implementation Plan Template

  Purpose:
  - Defines how an approved spec will be implemented
  - Must be executable by an implementation agent without inventing missing behavior

  Preconditions:
  - The paired spec must already be approved
  - Required ADRs must already exist or be explicitly called out as blockers

  Writing rules:
  - Be concrete about files, modules, migrations, tests, and rollout order
  - Do not restate the entire spec; reference it and translate it into execution
-->

| Field | Value |
| --- | --- |
| **Status** | `draft` · `review` · `approved` · `completed` |
| **NNN** | `{NNN}` |
| **Slug** | `{kebab-case-slug}` |
| **Date** | `YYYY-MM-DD` |
| **Author(s)** | `{name(s)}` |
| **Spec** | `{link to specs/NNN-...}` |
| **Required ADRs** | `{link(s)}` |

## Goal

{What this implementation phase will deliver.}

## Scope

{What this plan covers.}

## Non-Goals

- {What this plan intentionally excludes}

## Preconditions

- [ ] Paired spec is approved
- [x] Required ADRs are accepted
- [ ] Blocking open questions are resolved or explicitly deferred

## Target Areas

- {Target service/module/file area}
- {Target service/module/file area}

## Data And Storage Changes

- {Schema or persistence change}

## API And Transport Changes

- {IPC, HTTP, WebSocket, event, or protocol change}

## Implementation Steps

1. {Step}
2. {Step}
3. {Step}

## Parallelization Notes

- {What can run in parallel}
- {What must remain sequential}

## Test And Verification Plan

- {Unit tests}
- {Integration tests}
- {Manual verification}

## Rollout Order

1. {Rollout step}
2. {Rollout step}

## Rollback Or Fallback

- {Rollback or containment path}

## Risks And Blockers

- {Risk}
- {Blocker}

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
