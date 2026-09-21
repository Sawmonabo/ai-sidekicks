# Plan-030: Skills

| Field | Value |
| --- | --- |
| **Status** | `draft` |
| **NNN** | `030` |
| **Slug** | `skills` |
| **Date** | `2026-09-21` |
| **Author(s)** | `Sawmon Abo` |
| **Spec** | [Spec-030: Skills](../specs/030-skills.md) |
| **Decisions** | [ADR-031](../decisions/031-five-rail-destinations.md), [ADR-035](../decisions/035-one-syntax-colourer-in-the-daemon.md) |
| **Dependencies** | [Plan-021](./021-desktop-shell-and-renderer.md) (the console frame, the icon rail, the routing module, the test tiers), [Plan-006](./006-local-ipc-and-daemon-control.md) (the daemon's local method surface), [Plan-004](./004-provider-driver-contract-and-capabilities.md) (the provider spawn path the session pack rides) |

## Goal

When this plan is done, Skills is a working rail destination. One list shows every skill folder on the machine — the console's own, Claude Code's and Codex's, global and project — each with its origin, its path, its file count, where it is available and what to type to call it. A folder opens into an editor that authors the whole folder: the front-matter fields above, a Files list with the entry file pinned first, and every supporting file addable, renamable and deletable in place. Availability is one control per provider with an origin-derived default, a widening scan that reports and never blocks, and two holds that cannot be talked past. Underneath, the daemon watches the three origins, writes folders, runs the scan and hands each provider a pack of every skill available to it, so a skill authored once reaches both providers and a skill saved mid-session goes live without a restart.

## Non-Goals

- **No marketplace, gallery or import.** Nothing discovers, downloads or publishes a skill authored elsewhere.
- **No Commands view and no second registry.** The session composer's `/` and `$` list reads the registry this plan builds; it does not get a copy of it.
- **No writing into a provider's own tree.** A new folder lands under the console's own tree only; a provider's folder is edited where it is, and no field of the console's is written into a file a provider owns.
- **No tool-server work.** Tool servers are machine configuration and belong to their Settings page.
- **No sidekick-definition work.** The definition record, its editor and the attach seam are [Plan-027](./027-agent-definitions-and-peer-invocation.md)'s. This plan publishes a skill reference for a definition to name and authors no Plan-027 file.
- **No rail or routing ownership.** The icon rail and the routing module are Plan-021's files; this plan adds one destination arm to each and authors nothing else there.

## Target Areas

- `apps/desktop/src/renderer/src/console/skills/` (NEW) — the destination owns the list, the folder editor, the Files panel, the availability control with its scan line, and the reader the session composer mounts for its Skills group. Nothing about skills lives in the sidekick family's subtree; that family keeps the library, the definition editor and its picker.
- `apps/desktop/src/renderer/src/console/routing/routes.ts` (EXTEND, Plan-021-owned) — the `skills` destination arm and its four addresses, added beside the existing `sessions` / `workflows` / `settings` arms.
- `apps/desktop/src/renderer/src/console/frame/composition/IconRail.tsx` and `rail-navigation.ts` (EXTEND, Plan-021-owned) — the third rail item and its place in the keyboard order.
- `packages/runtime-daemon/src/skills/` (NEW) — the watch over the three origins at both scopes, the front-matter read, the whole-folder write, the scan the widening control renders, the console's own per-folder record, and the per-provider session pack. The console never writes a folder and never computes a pack.
- `packages/runtime-daemon/src/ipc/handlers/` (EXTEND) — the skill method namespace: the registry read, the folder write, the availability write and the scan.
- `packages/contracts/src/skill.ts` (NEW) — the folder record, the file entry, the availability record, the scan result and the request/response pairs, as strict schemas.
- `packages/client-sdk/src/` (EXTEND) — the typed client the console and the CLI both call, plus its one barrel export line.

## Phases

### Phase 1 — Contracts, and the daemon's read over the three origins

Precondition: Plan-006 Phase R1 merged.

The contract module and the daemon's read half. The contracts carry the folder record, the per-file entry (path, size, and whether the daemon could read it), the availability record, the scan result and the method pairs, as strict schemas that reject unknown keys. The daemon gains a watch over all six roots — the console's own, Claude Code's and Codex's, global and project, with the project's `.agents/skills` root counted as Codex's — creates a root that does not exist yet so a later write is visible to a running session, reads each folder's front matter, and answers a registry read with one entry per folder carrying its origin, its scope, its path, its name and description, and its file list. A file it cannot read is listed with its size and no body rather than dropped.

Done when: a registry read returns every skill folder from all three origins at both scopes with its origin, scope, path, front matter and file list, and a folder created, edited or removed on disk changes the next read with no restart.

### Phase 2 — The folder write, the availability record and the widening scan

Precondition: Plan-030 Phase 1 merged.

The daemon's write half. A whole-folder save applies the front-matter fields, each file's body, the files added and the files removed together, and leaves the folder untouched when it refuses; path normalization drops leading slashes and `.` and `..` segments before a path is judged, so no file can land outside its folder. A new folder is created under the console's own tree only, with the typed name folded to a folder name and a collision suffixed rather than overwritten; a folder in a provider's tree is edited in place with its name taken from the directory. The console's own per-folder record is added, holding exactly two fields — availability and icon — with the origin-derived default and both holds enforced when the write is handled, not only when the control is drawn. The scan reads every file in a folder against each provider's published tool names and call sigils and returns the files and the tool names as words; it stores nothing.

Done when: a folder can be created, edited and saved through the daemon; a path that would escape the folder, a duplicate path and a path naming the entry file are each refused with a reason; and a scan of a folder returns the files that name the other provider's tools, or nothing where none does.

### Phase 3 — The session pack and mid-session liveness

Precondition: Plan-030 Phase 2 merged; Plan-004 Phase 3 merged.

The provider-facing half. At launch the daemon composes one pack per provider from every skill available to that provider and hands it over through that provider's own loading path, namespaced so a packed skill can never shadow one of the provider's own; a skill in a provider's own tree keeps its bare name in that provider's session. Nothing is copied into `.claude`, `.codex` or the repository. A skill saved mid-session is carried into the live session: on Codex by the change notification the provider pushes, on Claude Code by the daemon's reload request, sent after the write so the session picks the folder up without a restart. The call-form line the console states is derived here, once, per origin-and-provider pair.

Done when: a session started after a skill is authored can invoke it under the namespaced form, a skill in a provider's own tree is invocable under its bare name, and a skill saved while a session is running is invocable in that same session on both providers without a restart.

### Phase 4 — The destination: rail, addresses and the list

Precondition: Plan-030 Phase 3 merged; Plan-021 Phase 6 merged.

The screen's first half. The rail gains its third item drawing the open book, marked current on this screen to assistive technology as well as drawn. The routing module gains the four addresses, with `new` reserved so the form's address and a folder's address cannot collide. The shell is built — the title, the count, one search field and `New skill`, no view strip and no tabs, the shared sessions track and bell carried unchanged — and then the list: the caption and its note, one row per folder with its glyph tile, name and summary, origin mark, folder and size, availability line, call form and widen line, ordered by folder name under `Intl.Collator`, searched case-folded across name, summary, origin words and every file path inside the folder. The list's in-flight, refused and empty arms are built with it. The destination's state is one store per screen over the contract shapes (`zustand` 5.0.15 parsed with `zod` 4.3.6) and its widgets come from the console's own widget set (`@base-ui/react` 1.7.0), styled from the console tokens.

Done when: the rail reaches Skills, each of the four addresses renders its own state, and the list shows every folder the daemon reports with all six row parts, ordering, search and its three non-populated arms.

### Phase 5 — The folder editor

Precondition: Plan-030 Phase 4 merged.

The screen's second half. The open folder: the top strip with `All skills`, the unsaved mark, `Cancel` and `Save`; the front-matter fields with the note saying which field lives where; the twelve-icon field on every origin; the global-or-project choice on a new skill only; the path line naming the folder and following the typed name, with its three verbs. Then the folder in two columns — the Files panel with the entry file pinned first, the file count, the current-row mark, the entry file's **the skill** mark in place of its rename and delete controls, and the three in-place questions for adding, renaming and deleting, each answering a refused path in its own row with the reason and moving nothing else on the screen; and the body column with the open file's name, its kind word and its body in the mono or reading face its extension chooses, painted from the spans the daemon's one colourer supplies ([ADR-035](../decisions/035-one-syntax-colourer-in-the-daemon.md)). The keyboard set lands here — save, escape, the search key, row movement, and the leaving-with-changes question that names every changed field by its label and every changed file by its path — as does the two-column fold to one under the narrow threshold, asked of the pane rather than the window.

Done when: a folder can be opened, every field and every file edited, a file added, renamed and deleted through the in-place questions, and the whole folder saved; a delete falls the editor back to the entry file; a refused path is answered in its own row; and leaving with changes asks and names what changed.

### Phase 6 — Availability on the screen, and the composer's Skills group

Precondition: Plan-030 Phase 5 merged.

The last surface, and the second reader. On the row and in the open folder, the availability control per provider reading as pressed or not pressed, the held case reading as unavailable with its reason in a tooltip tied to the control so a screen reader reads it with the control, and the row itself carrying none of those words. One click widens; the setting changes first, then the scan's one amber line appears in place naming the files and the tool names as words and blocking nothing, and narrowing removes the setting and the line together. Beside it the call-form line, and the two sentences under the folder — the two-things sentence on a provider's folder, the packed-at-launch sentence on one of the console's own. Last, the reader the session composer mounts for its Skills group, so the composer's `/` and `$` list draws these same skills, name for name and line for line, from the one registry.

Done when: both held cases refuse a forced click and say why, a widening shows the scan's line for a folder that names the other provider's tools and no line for one that does not, narrowing leaves nothing behind, and the composer's Skills group and this list show the same skills.

## Test And Verification Plan

- **Unit** — the path normalizer over its leading-slash, duplicate-separator and `..` arms; the refusal rule over the empty, duplicate and entry-file cases; the file ordering with the entry file pinned first; the availability default per origin; the hold predicate over both held cases; the scan's union across the files of one folder; the call-form builder over the four origin-and-provider combinations.
- **Console unit** — the list over its four arms (populated, in flight, refused, empty); the folder editor over each field, each in-place question, the face chosen per extension, and the fallback to the entry file after a delete; routing over the five rail destinations and the four addresses of this one.
- **Browser tier** — the geometry and the flow in the built shell: list → open a folder → add a file → save, plus the two-column fold at the narrow threshold.
- **Accessibility tier** — zero violations on the list, the open folder, the new-skill form and each in-place question; a held availability control reads as unavailable and its reason is read with the control; every control that draws only a glyph carries a word for a name.
- **Bundle tier** — the destination's chunk inside the console's budgets.

### Screen states to reach, and what must be true in each

Each of these is one state of the built screen, reached through the interface and then read.

1. **The whole registry in one list.** Ten folders across every origin at both scopes, one of them under the project's `.agents/skills` root and carrying the Codex origin with that root in its path. Each row shows its origin mark, its folder path, its file count, its availability line and its call form. Five of the ten carry more than one file.
2. **A folder of the console's own, open at its entry file.** Three files, one under a `references/` prefix and one under a `scripts/` prefix; the Files list holds the entry file first and the other two ordered by whole path; the path line names the folder and not the open file.
3. **The same folder with its script file open.** The body is in the mono face, the kind word reads `Code`, and the address carries that file's path while the path line still names the folder.
4. **A folder in Claude Code's own tree, edited in place.** The name is a read-only line, there is no global-or-project choice, the path line's verb says the folder is edited where it is, and the sentence under the folder says the record beside it holds where the skill is available and its icon and nothing else.
5. **A folder in Codex's own tree with the provider's own metadata file open.** `agents/openai.yaml` is an ordinary row in the Files list, opens in the mono face, and saves with the rest; nothing of the console's is written into it.
6. **The new-skill form.** One file in the Files list, the global-or-project choice present, the path line following the typed name character by character, and both providers on.
7. **A widening with something to report.** A Codex-origin folder widened onto Claude Code from the list: the control is already flipped, one amber line stands in place naming both files the scan read Codex tool names out of and the tool names as words, no dialog opened and no row was removed.
8. **A widening with nothing to report.** A folder whose files name no other provider's tools widens and no line appears at all.
9. **Narrowing.** The same folder narrowed back: the setting and the line both go, and re-widening recomputes the line rather than restoring a stored one.
10. **The three held controls.** A provider's own folder with that provider's control held, a skill on one provider only with that control held, and a provider whose command is not installed: each reads as unavailable, each has its reason in a tooltip that opens on hover and on keyboard focus, and a forced click changes nothing.
11. **The three in-place refusals.** A duplicate path, a path typed as the entry file's name, and an empty path, each answered inside its own row with the reason, with nothing else on the screen moving.
12. **A file the daemon cannot read.** Listed with its size and no editor, in its ordered place.
13. **The three non-populated list arms.** Empty (one sentence and `New skill`, no spinner and no rows), refused (the refusal with `Try again` at the right end of its line and no rows), and in flight (distinct from both).
14. **Leaving with changes.** One small card at the top over the folder with no scrim, naming every changed field by its label and every changed file by its own path, with a file added or removed named once as `Files`, and three ways out of which only saving keeps the changes.
15. **The two states a control only reveals.** A file row's rename and delete controls, reached by the pointer and by the keyboard on a desktop and standing on the row from the start where there is no pointer; and a held availability control's tooltip, opened by hover and by focus. Neither is provable from a state that never reveals it, so each gets its own pass.

### Sweeps over the built screen

Run over every state above: the rail draws five destinations in order with Skills current; the screen says sidekick and never agent; no sentence begins with `You`; no wire spelling appears beyond file names, paths and the provider's own call form, read over every accessible name as well as every visible word; every glyph-only control carries a word for a name; no horizontal overflow at 1440 × 900; no runtime error on any state; both colour schemes render; reduced motion is respected; one remote origin; and every chrome size root-relative with every text size and line height a type-scale token, so the screen at a larger root is the same screen in one proportion.

Tooling is the console's existing tiers ([Spec-021 §Console Test Tiers](../specs/021-desktop-shell-and-renderer.md#console-test-tiers)): Vitest with happy-dom for unit, Vitest browser mode through `@vitest/browser-playwright` for the browser and accessibility tiers with `axe-core` 4.13.0 run in-page, `@playwright/test` 1.62.1's Electron launcher for the end-to-end flow, `@testing-library/react` for the console unit tier, and `knip` 6.34.0 with `dependency-cruiser` 18.2.0 for the structural gates.

## Risks

- **The scan's provider vocabulary ages.** Tool names and call sigils change as the providers ship. Keep the vocabulary in one table, re-read it at every provider version bump, and keep the scan's output words rather than wire spellings so an upstream rename changes the table and not the screen.
- **A provider adds or moves a skill root.** The watch's root list is one place for exactly this reason; a new root is one entry, and a folder found there keeps that provider's origin mark and shows the root in its path.
- **A mid-session save that the provider never sees.** On Claude Code a scope directory that did not exist when a session started stays invisible for that session's whole life unless the reload request is sent. Create the roots before launch and send the reload after every write; a save that reports success and does not reach the running session is the failure this mitigates.
- **Six recursive watches cost handles and wake-ups.** Use one recursive watch per root with a debounce, coalesce a burst of writes into one registry rebuild, and never poll.
- **A very large folder.** A skill folder has no depth cap and no file cap by design. List every file, read the ones that can be read, and bound the editor by refusing to open a body over the readable size rather than by hiding the row.

## Notes

Dated notes about decisions taken during the build, newest first. What has merged is `git log --oneline --grep 'Plan-030'`.
