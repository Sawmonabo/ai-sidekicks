# ADR-031: Five Rail Destinations

| Field         | Value                       |
| ------------- | --------------------------- |
| **Status**    | `accepted`                  |
| **Type**      | `Type 2 (one-way door)`     |
| **Domain**    | Desktop Console, Navigation |
| **Date**      | 2026-09-21                  |
| **Author(s)** | Claude (AI-assisted)        |
| **Reviewers** | Sawmon Abo                  |

---

## Context

The desktop console has an icon rail down its left edge. Each rail item swaps the one screen region beside it for a whole screen. Before this decision the rail had three destinations: sessions, workflows and settings. Saved sidekick definitions were listed on a Settings page that could delete one and hand it to a session, with no editor at all, and skills had no screen of their own and no owning specification.

Two kinds of thing were competing for Settings. One is operator configuration: the app's own version and updates, provider accounts, tool servers, projects, the browser's saved site data, keyboard chords, appearance, notifications and the background service. The other is authored content with a lifecycle and more than one consumer: a sidekick definition is written, edited, versioned and then read by both the session composer and a workflow step; a skill is a folder of files a provider loads.

## Problem Statement

Which top-level screens does the console have, in what order, and what rule decides whether a future surface becomes a rail destination or a Settings page?

### Trigger

The console design was locked on 2026-09-21, and every screen specification needs one fixed list to route against before the build starts.

---

## Decision

The rail has exactly five destinations, in this order: **Sessions, Sidekicks, Skills, Workflows, Settings**. A Settings page configures the runtime node or the shell; a rail destination is where a person goes to make or use something.

### Thesis — Why This Option

- **One rule sorts every case.** A sidekick definition and a skill are things a person makes and then uses from other screens, so each is a destination. Tool servers configure what the machine exposes, so they stay in Settings. A future surface is sorted by the same sentence, without a new debate.
- **Each destination has one owner.** Sessions is owned by [Spec-021](../specs/021-desktop-shell-and-renderer.md), Sidekicks by [Spec-027](../specs/027-sidekick-definitions-and-peer-invocation.md), Skills by [Spec-030](../specs/030-skills.md), Workflows by [Spec-015](../specs/015-workflow-authoring-and-execution.md), and Settings by Spec-021 with each page's behaviour in the specification that owns its data.
- **The order follows use.** Sessions is where work happens and comes first. Sidekicks and Skills are the two libraries a session draws on and sit together. Workflows composes sidekicks into runs and follows them. Settings is visited least and sits last.
- **Skills is its own screen, with no view switch and no tabs.** A skill list under a Sidekicks tab would hide one of the two libraries behind the other and would make a skill's address depend on a view state.
- **One set of rows serves two consumers.** The composer's command list and a workflow step's sidekick chooser read the same definitions, which is only coherent when the definitions have one home that is not a settings page.

### Antithesis — The Strongest Case Against [T2]

Five is a lot of top-level navigation for a product with one user whose time is spent almost entirely in Sessions. Sidekicks and Skills could be one "Library" destination with two tabs, which keeps the rail short and leaves room to add a third library later without widening the rail. Fixing the list in a one-way record also makes the rail harder to change when Remote Control or a marketplace arrives.

### Synthesis — Why It Still Holds [T2]

A rail of five icons costs five small squares of a fixed-width column and no transcript space. A merged Library destination saves one icon and pays for it with a view switch on every visit, a second level of routing, and an address that is not stable. The list is fixed so that routing, deep links, keyboard chords and the notification targets can be built once; it is not frozen against a sixth destination, which is added by a new record that applies the same rule. Remote Control reaches this machine's sessions from another device and adds no rail destination here; which of the five its own clients draw is decided with those screens.

---

## Alternatives Considered

### Option A: Five destinations, sorted by the make-or-use rule (Chosen)

- **What:** Sessions, Sidekicks, Skills, Workflows, Settings, in that order.
- **Steel man:** Every authored thing has a home with a stable address, and Settings holds only configuration.
- **Weaknesses:** Four of the five screens are visited far less than the first.

### Option B: Definitions and skills stay under Settings (Rejected)

- **What:** Settings keeps a saved-definitions page and gains a skills page.
- **Steel man:** The rail stays at three items, and everything that is "set up once" is in one place.
- **Why rejected:** A definition is not set up once. It is edited, duplicated, bound per provider and chosen from two other screens. Settings pages have no library view, no editor view and no per-item address, so each would have to be rebuilt inside Settings.

### Option C: One Library destination with Sidekicks and Skills tabs (Rejected)

- **What:** Four rail items; the second holds both libraries behind a view switch.
- **Steel man:** Shorter rail, one place for "things my sidekicks can use", room for more tabs.
- **Why rejected:** The view switch makes the screen's address depend on a tab state, doubles the routing, and hides one library whenever the other is open.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | A sidekick definition has at least two consumers | Spec-027 resolves a definition when a sidekick is attached; Spec-015's sidekick step runs on the same definitions | With one consumer the definition could live beside it, and the destination would be overhead |
| 2 | Skills differ enough from sidekicks to need their own screen | A skill is a folder of files loaded by a provider's own path; a definition is a record bound to a provider and a model | If the two converge, one destination is removed by a later record |
| 3 | No sixth top-level screen is needed at V1 | Every console surface in Spec-021 §The surface set, Spec-027, Spec-030 and Spec-015 routes to one of the five | A sixth is added by a new record under the same rule |

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A surface that is neither configuration nor authored content appears | Low | Low | A design review cannot sort it with the one-sentence rule | Extend the rule in a new record before adding the surface |
| The rail feels heavy because four items are rarely used | Med | Low | The user says so | The rail is icons only; reorder or fold in a later record |
| Skills and Sidekicks drift into duplicating each other's lists | Low | Med | The same row appears on both screens | Each screen lists only what it owns; the attach seam is a reference, not a copy |

## Reversibility Assessment

- **Reversal cost:** Days. Routing, deep links, chords and notification targets all name the destinations.
- **Blast radius:** The renderer's routing, the four screen families, the session address form and the keyboard map.
- **Migration path:** Move a screen family under another destination and redirect its address.
- **Point of no return:** Once session addresses that name a destination are shared outside the app.

## Consequences

### Positive

- One routing table, one deep-link form and one chord per destination.
- The Settings entry for saved definitions goes away, and Settings holds configuration only.

### Negative (accepted trade-offs)

- Five top-level items where three would fit the most common day. Accepted because the cost is five icons.

### Unknowns

- Whether Remote Control's phone client shows all five. That is decided with the Remote Control screens.

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
| Every console surface routes to one of the five | No surface outside them | Read the routing table when the four non-session screens land | When Plan-030 completes |

---

## References

No outside research was needed; the decision rests on the specifications linked above.

### Related ADRs

- [ADR-016: Electron Desktop Shell](016-electron-desktop-shell.md) — the shell the rail lives in.
- [ADR-026: Visual Node-Graph Workflow Authoring](026-visual-node-graph-workflow-authoring.md) — the Workflows destination's builder.

## Decision Log

| Date       | Event    | Notes                            |
| ---------- | -------- | -------------------------------- |
| 2026-09-21 | Accepted | Decided with the console design. |
