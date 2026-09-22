# Plan-NNN: Title

|               |                                                 |
| ------------- | ----------------------------------------------- |
| **Status**    | `draft` (set to `ready` when you want it built) |
| **Spec**      | `[Spec-NNN](../specs/NNN-name.md)`              |
| **Decisions** | `[ADR-NNN](../decisions/NNN-name.md)`           |

## Goal

One paragraph: what exists when this plan is done, and why it matters.

## Non-goals

- What this plan deliberately does not do.

## Target areas

- `packages/<name>/src/<area>` — what changes here
- `apps/desktop/src/<area>` — what changes here

## Phases

Each phase is one pull request. Keep the precondition to one sentence naming the plan phases it needs (`Precondition: Plan-004 Phase 2 merged.` or `Precondition: none.`), and the done-when to one sentence a reviewer can check.

### Phase 1 — Short title

Precondition: none.

What it builds, in a few sentences. Files and tests are decided at build time from this section and the spec.

Done when: the sentence.

### Phase 2 — Short title

Precondition: Plan-NNN Phase 1 merged.

What it builds, in a few sentences.

Done when: the sentence.

## Risks

- A risk and what you would do about it.
