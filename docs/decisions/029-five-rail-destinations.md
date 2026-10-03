# ADR-029: Five Rail Destinations

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

The desktop console has an icon rail down its left edge. Each rail item swaps the one screen region beside it for a whole screen. Saved agent definitions need a library and an editor, and skills need a screen and an owning specification, so each needs a home that is either a rail destination or a Settings page.

Two kinds of thing compete for Settings. One is configuration: the app's own version and updates, provider accounts, tool servers, projects, the browser's saved site data, keyboard chords, appearance, notifications, the background service and the account's devices. The other is authored content with a lifecycle and more than one consumer: an agent definition is written, edited, versioned and then read by both the session composer and a workflow step; a skill is a folder of files a provider loads.

## Problem Statement

Which top-level screens does the console have, in what order, and what rule decides whether a future surface becomes a rail destination or a Settings page?

### Trigger

Every screen specification needs one fixed list to route against before the build starts.

---

## Decision

The rail has exactly five destinations, in this order: **Sessions, Sidekicks, Skills, Workflows, Settings**. A Settings page configures the machine, the app, or the account's devices; a rail destination is where a person goes to make or use something.

### Thesis — Why This Option

- **One rule sorts every case.** An agent definition and a skill are things a person makes and then uses from other screens, so each is a destination. Tool servers configure what the machine exposes, so they stay in Settings. A future surface is sorted by the same sentence, without a new debate.
- **Each destination has one owner.** Sessions is owned by [Spec-021](../specs/021-desktop-app-and-renderer.md), Sidekicks by [Spec-026](../specs/026-agent-definitions-and-peer-invocation.md), Skills by [Spec-029](../specs/029-skills.md), Workflows by [Spec-015](../specs/015-workflow-authoring-and-execution.md), and Settings by Spec-021 with each page's behavior in the specification that owns its data.
- **The order follows use.** Sessions is where work happens and comes first. Sidekicks and Skills are the two libraries a session draws on and sit together. Workflows composes agents into runs and follows them. Settings is visited least and sits last.
- **Skills is its own screen, with no view switch and no tabs.** A skill list under a Sidekicks tab would hide one of the two libraries behind the other and would make a skill's address depend on a view state.
- **One set of rows serves two consumers.** The composer's command list and a workflow step's agent chooser read the same definitions, which is only coherent when the definitions have one home that is not a settings page.

### Antithesis — The Strongest Case Against [T2]

Five is a lot of top-level navigation for a product with one user whose time is spent almost entirely in Sessions. Sidekicks and Skills could be one "Library" destination with two tabs, which keeps the rail short and leaves room to add a third library later without widening the rail. A fixed list also makes the rail harder to change when a new kind of surface appears.

### Synthesis — Why It Still Holds [T2]

A rail of five icons costs five small squares of a fixed-width column and no transcript space. A merged Library destination saves one icon and pays for it with a view switch on every visit, a second level of routing, and an address that is not stable. One fixed list lets routing, deep links, keyboard chords and the notification targets be built once, and a screen added later is sorted by the same make-or-use rule. Remote Control reaches this machine's sessions from another device and adds no rail destination: its phone and web clients keep the rail beside each screen's list level and show every destination.

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
- **Steel man:** Shorter rail, one place for "things my agents can use", room for more tabs.
- **Why rejected:** The view switch makes the screen's address depend on a tab state, doubles the routing, and hides one library whenever the other is open.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | An agent definition has at least two consumers | Spec-026 resolves a definition whenever a run starts under it — a session's lead, an agent named in a composer, a workflow step; Spec-015's agent step runs on the same definitions | With one consumer the definition could live beside it, and the destination would be overhead |
| 2 | Skills differ enough from agents to need their own screen | A skill is a folder of files loaded by a provider's own path; a definition is a record bound to a provider and a model | If the two converge, they share one destination |
| 3 | The five destinations hold every V1 screen | Every console surface in [Spec-021 §The surface set](../specs/021-desktop-app-and-renderer.md#the-surface-set), Spec-026, Spec-029 and Spec-015 routes to one of the five | The rail gains a destination, sorted by the same make-or-use rule |

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A surface that is neither configuration nor authored content appears | Low | Low | A design review cannot sort it with the one-sentence rule | Extend the make-or-use rule to cover it before the surface is built |
| The rail feels heavy because four items are rarely used | Med | Low | The user says so | The rail is icons only; reorder or fold destinations |
| Skills and Sidekicks drift into duplicating each other's lists | Low | Med | The same row appears on both screens | Each screen lists only what it owns; the definition editor's skills field is one link out, never a list |

## Reversibility Assessment

- **Reversal cost:** Days of work, but only before the point of no return below; after it, a redirect has to be kept for every address already shared. Routing, deep links, chords and notification targets all name the destinations.
- **Blast radius:** The renderer's routing, the screens other than Sessions, the session address form and the keyboard map.
- **Migration path:** Move a screen under another destination and redirect its address.
- **Point of no return:** Once session addresses that name a destination are shared outside the app.

## Consequences

### Positive

- One routing table, one deep-link form and one chord per destination.
- Settings holds configuration only; no Settings page lists saved definitions.

### Negative (accepted trade-offs)

- Five top-level items where three would fit the most common day. Accepted because the cost is five icons.

### Unknowns

- None: Remote Control's phone and web clients keep the rail and show every destination.

---

## Decision Validation [T2]

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Every console surface routes to one of the five | No surface outside them | Read the routing table when the Sidekicks, Skills, Workflows and Settings screens land | When Plan-026 completes |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Feature census of reference app B, a Rust desktop console | Primary research | Its agent surface is a settings page — a toggle list with one card row per provider command-line tool, each a tile, a name, a one-line blurb and an on/off switch — reached from a nine-section navigation column that replaces the session list while it is open. The section can be opened by name; a row cannot, and no editor sits behind one | Read for the console design; the reading is summarized here |
| Feature census of reference app A, a Go desktop console | Primary research | That app has no router at all: one window frame with overlays mounted over it and one of four boot targets picked at start, so a surface inside the frame is reached by what happens to be open rather than by an address of its own | Read for the console design; the reading is summarized here |

### Related ADRs

- [ADR-015: Electron Desktop App](015-electron-desktop-app.md) — the desktop app the rail lives in.
- [ADR-024: Visual Node-Graph Workflow Authoring](024-visual-node-graph-workflow-authoring.md) — the Workflows destination's builder.
