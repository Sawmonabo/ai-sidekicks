# ADR-034: The Transcript Is One Flow

| Field         | Value                            |
| ------------- | -------------------------------- |
| **Status**    | `accepted`                       |
| **Type**      | `Type 2 (one-way door)`          |
| **Domain**    | Desktop Console, Design Language |
| **Date**      | 2026-09-21                       |
| **Author(s)** | Claude (AI-assisted)             |
| **Reviewers** | Sawmon Abo                       |

---

## Context

The session screen's centre is the transcript: the person's messages, the sidekick's replies, tool calls, commands, approvals and the rows that mark an act. The product has one user ([ADR-001](001-session-is-the-primary-domain-object.md) and the product scope), so there is never a second person to tell apart from the first. The console's design language, Meridian, is specified in [Spec-021 §Meridian, the design language](../specs/021-desktop-shell-and-renderer.md#meridian-the-design-language).

## Problem Statement

How does the transcript show who said what, and how much chrome does each turn carry?

### Trigger

Spec-021 described timeline rows as flush-left ledger lines with no bubbles. The locked console design keeps the single flow and removes the identity chrome, but gives the person's own words a bubble. The two must say the same thing before the transcript is built.

---

## Decision

The transcript is **one flow**, and role is carried by asymmetry alone.

- The sidekick's words are **flat prose** in the column, with no container.
- The person's words sit in a **tinted bubble, right-aligned**, with one asymmetric corner. The bubble has no width cap: it is as wide as its own text needs, out to the full column. A message longer than about twelve of its own lines folds to twelve with a control that names its line count, and opening it never moves the page.
- There is **no left-and-right alternation**: the sidekick's turns never move to a side, and nothing else in the flow is aligned by author.
- A sidekick turn carries **no avatar, no name label and no eyebrow** naming the speaker.
- **The one user carries no identity mark anywhere** on the console: no avatar, no initial, no hue, no "You" label on a reply or a pull-request header, no colour bar for who changed a file. The word "you" appears only where it says who acted, such as a command row that reads `Stopped by you` or a session row that reads `Waiting on you`.
- A row that marks an act names the act in words, such as `Goal set` or `Committed`, never the actor. The only swatches on the screen belong to sidekicks.

### Thesis — Why This Option

- **One difference is enough.** With one person and their sidekicks, the only question a reader has is "is this mine or the sidekick's?". A tint and a right edge answer it at a glance, and the answer survives a long scroll.
- **The sidekick's words are the work.** Replies are long, carry code, tables and diagrams, and need the full measure. A container around them spends width and adds a border to every row.
- **Identity chrome has nothing to identify.** An avatar or a name on every turn repeats a fact that never changes within a session. Removing it returns a line of height to every turn.
- **Alternation is a messaging convention.** It suits two people of equal standing. Here one side is a stream of work with tool rows between its paragraphs, and alternating it would scatter that stream.

### Antithesis — The Strongest Case Against [T2]

A pure ledger, every row flush left with a coloured edge, is more uniform and is what Spec-021 first specified; a bubble is the one element that breaks the ledger and imports the look of a chat application. When several sidekicks work in one session, a reader does need to know which sidekick wrote a row, and removing name labels seems to make that harder.

### Synthesis — Why It Still Holds [T2]

The ledger reading holds for everything the sidekick produces, which is nearly all of the screen; the bubble marks the few rows that are the person's own instructions, which are the rows a reader scrolls back to find. That is a job the coloured edge did poorly, because an instruction and a reply looked alike. Several sidekicks are told apart where it matters: a child's work is inside its own dispatch block and child view, headed by that sidekick's swatch and name, so the lead's flow needs no per-row label.

---

## Alternatives Considered

### Option A: One flow, a tinted right-aligned bubble for the person, flat prose for the sidekick (Chosen)

- **What:** As decided above.
- **Steel man:** The least chrome that still answers "whose words are these?" at a glance.
- **Weaknesses:** One element departs from the ledger look.

### Option B: A pure ledger, every row flush left with an author edge (Rejected)

- **What:** A thin coloured edge and an author gutter on every row, no bubbles.
- **Steel man:** Perfectly uniform, reads as a work log.
- **Why rejected:** The person's instructions are the landmarks of a session, and in a uniform ledger they do not stand out. The author gutter also spends width on a fact that is constant.

### Option C: A chat layout with alternating sides, avatars and names (Rejected)

- **What:** The person on the right, the sidekick on the left in its own bubble, each with an avatar and a name.
- **Steel man:** Familiar from every messaging application.
- **Why rejected:** It narrows the sidekick's replies, which hold code and tables, and spends a line per turn on identity that never changes.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | The product has one user per console | The product scope: one user and their sidekicks | With several people in one transcript, an identity mark would be needed |
| 2 | A tint and a right edge are readable in both themes and both colour schemes | The design's contrast check runs at run time against the theme tokens | The bubble would need a border in the failing theme |
| 3 | Child sidekicks are distinguishable without per-row labels | Their work is grouped in dispatch blocks headed by swatch and name | Per-row swatches would return inside the lead's flow |

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A long pasted message dominates the screen | Med | Low | A message over twelve lines | It folds, and opening it holds the page still |
| A reader cannot tell a sidekick reply from quoted text | Low | Low | The user says so | Quoted text carries one hairline rule down its left and reads a little quieter, which no sidekick reply does |
| A later feature adds a second human to a session | Low | High | A design that needs a name on a person's row | A new record; this one rests on one user |

## Reversibility Assessment

- **Reversal cost:** Days for the renderer, but every screenshot, test scenario and the design language text change with it.
- **Blast radius:** The transcript, Review's authorship marks, pull-request headers and the act rows.
- **Migration path:** Change the row component and the design-language rule together.
- **Point of no return:** None technical; the cost is coherence.

## Consequences

### Positive

- The sidekick's replies use the full measure.
- The person's instructions are the visible landmarks of a long session.

### Negative (accepted trade-offs)

- The transcript is not a uniform ledger. Accepted because the one exception is the row people look for.

### Unknowns

- None.

---

## Decision Validation [T2]

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [x] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Identity marks for the user anywhere on the console | Zero | Assert that no element identifies the user in the browser test tier's scenarios | When the session screen lands |

---

## References

No outside research was needed; the decision rests on the specifications linked above.

### Related ADRs

- [ADR-001: Session Is The Primary Domain Object](001-session-is-the-primary-domain-object.md) — the session whose transcript this draws.
- [ADR-029: Canonical Transcript Is Authoritative](029-canonical-transcript-is-authoritative.md) — what the transcript's content is; this record is only how it is drawn.

## Decision Log

| Date       | Event    | Notes                            |
| ---------- | -------- | -------------------------------- |
| 2026-09-21 | Accepted | Decided with the console design. |
