# Spec-030: Skills

| Field | Value |
| --- | --- |
| **Status** | `draft` |
| **NNN** | `030` |
| **Slug** | `skills` |
| **Date** | `2026-09-21` |
| **Author(s)** | `Sawmon Abo` |
| **Depends On** | [Spec-004](004-provider-driver-contract-and-capabilities.md), [Spec-021](021-desktop-shell-and-renderer.md), [Spec-027](027-agent-definitions-and-peer-invocation.md); [ADR-031](../decisions/031-five-rail-destinations.md), [ADR-035](../decisions/035-one-syntax-colourer-in-the-daemon.md) |
| **Implementation Plan** | [Plan-030](../plans/030-skills.md) |

## Purpose

A **skill** is a folder of text a sidekick reads: instructions plus whatever the instructions need — a reference table, a script, a template. Both pinned providers load skills as folders and neither loads a lone file. The folder is named for the skill, a file called `SKILL.md` at its top carries the front matter and the instructions, and every other file beside it travels with the skill and is reachable from the instructions by relative path.

Skills are written, edited and used, so they are a place a person goes rather than a setting on a machine: the console's icon rail carries Skills as its third destination, between Sidekicks and Workflows ([ADR-031](../decisions/031-five-rail-destinations.md)). This spec defines that destination — the one list of every skill on the machine whatever tree it lives in, the folder editor that authors the whole folder rather than one file, and the rules by which one skill reaches both providers.

**What each provider reads out of a skill's front matter is narrow, and the two differ.** Claude Code at version `2.1.270` reads the front matter it knows and silently drops every key it does not, with nothing on the wire and nothing on standard error to say a key was dropped; its custom commands and its skills are one registry, so a skill is reachable as `/name args` in a session as well as by the model's own choice. codex-cli at version `0.154.0` (source tag `rust-v0.154.0`) parses exactly three things — `name`, defaulting to the directory name when it is absent; `description`, required and non-empty; and `metadata.short-description` — and likewise ignores unknown keys. Codex additionally reads an optional metadata file of its own, `agents/openai.yaml`, inside the same folder, carrying an interface block, a dependency block and a policy block. Codex has no custom slash commands at all at that version, so a skill is the whole of its authored-prompt surface, reached as `$name`. The wire surfaces behind both readings are recorded in [Claude wire reference §`system/init` command and skill enumeration](../reference/provider-wire/claude.md#systeminit-command-and-skill-enumeration--a-live-read-never-a-stored-registry) and [Codex wire reference §`skills/*`](../reference/provider-wire/codex.md#skills--the-skill-surface).

The consequence this spec is built on: **a skill authored once can be made available to both providers, because a folder with a name, a description and a body is the whole of what either one requires** — but neither provider will hold a field it does not know, so anything the console needs to remember about a skill lives in the console's own record beside the folder, never inside it.

## Scope

- **What a skill is, and where it lives.** A skill is a folder on disk. It lives in one of three origins, each of which exists both globally under the home folder and per project inside the repository:
  - **the console's own** — `~/.ai-sidekicks/skills/<name>/` and `<project>/.ai-sidekicks/skills/<name>/`;
  - **Claude Code's own** — `~/.claude/skills/` and `<project>/.claude/skills/`;
  - **Codex's own** — `~/.codex/skills/`, `<project>/.codex/skills/`, and the project's `.agents/skills/`, which Codex also reads as a skill root. A folder found there carries the Codex origin and shows that root in its path.

  Project folders travel with the repository. The daemon watches all of them.

- **One list across the three origins.** Every skill folder appears once, with the origin and scope it was found at, its folder path, how many files it holds, where it is available and what a person types to call it.
- **The folder is the unit.** The editor authors the folder, not one file: a Files list with the entry file first and every supporting file after it, with adding, renaming and deleting a file, and each file opening in the same editor. Availability, widening and the scan apply to the folder as a whole.
- **Availability across providers.** A setting per folder with a default derived from origin, a one-click widening whose scan reports and never refuses, and three controls that are held because the underlying change is not the console's to make.
- **Authoring and editing.** A new skill is written under the console's own tree, global or project as chosen. A skill found in a provider's own tree is edited where it already is.

## Non-Goals

- **No marketplace and no gallery.** Nothing discovers, browses, downloads or publishes skills authored elsewhere.
- **No writing into a provider's own tree from the New skill form.** A new folder is created under the console's own tree only; a provider's existing folder is edited in place and is never created by the console.
- **No Commands view.** Claude Code folded its custom commands into its skills registry, and Codex has no custom commands at all, so a Commands view would show one provider's items and draw a split neither provider has.
- **No copying into a provider's tree to make a bare terminal see skills.** Nothing is written into `.claude` or `.codex` so that a plain `claude` or `codex` invocation outside the console would find a skill authored here. Providers receive skills through the pack the daemon hands them at launch.
- **No tool-server configuration.** A tool server is machine configuration and is managed on its Settings page, not here.
- **No second registry.** The session composer's `/` and `$` list and this screen read the same skills; one is not a copy of the other.
- **Nothing about driving a session from a linked device.** This is a console surface over a registry the daemon watches on the machine the skills live on.
- **A sidekick definition does not become a folder.** A definition stays one file ([Spec-027 §The definition registry](027-agent-definitions-and-peer-invocation.md#the-definition-registry)); a sidekick that needs reference material attaches a skill, and the skill carries the folder.

## Domain Dependencies

- [Glossary](../domain/glossary.md) — _sidekick_, _session_, _provider_.
- [Session Model](../domain/session-model.md) — the session a skill is packed into at launch and becomes live inside mid-run.

## Architectural Dependencies

- [ADR-031](../decisions/031-five-rail-destinations.md) — the five rail destinations and their order; Skills is the third, and this spec is its owner.
- [ADR-035](../decisions/035-one-syntax-colourer-in-the-daemon.md) — code is coloured once in the daemon and every surface paints the spans it is handed, which is how a script file's body is drawn in this editor.
- [Spec-021](021-desktop-shell-and-renderer.md) — the console shell this destination mounts inside: the icon rail and the surface set, the console's library set, and the test tiers a console change is proven by.
- [Spec-004 §The provider command and skill surface](004-provider-driver-contract-and-capabilities.md#the-provider-command-and-skill-surface) — the driver's live read of a provider's own enumeration of commands and skills, per binding. That read is the provider's answer about what it has loaded; this spec's list is the registry on disk that the daemon watches and packs. The two are different questions and neither is derived from the other.
- [Spec-027](027-agent-definitions-and-peer-invocation.md) — the sidekick library beside this destination, and the one-file definition a skill is attached to rather than folded into.
- [Claude wire reference §`system/init` command and skill enumeration](../reference/provider-wire/claude.md#systeminit-command-and-skill-enumeration--a-live-read-never-a-stored-registry) and [Codex wire reference §`skills/*`](../reference/provider-wire/codex.md#skills--the-skill-surface) — the two providers' skill surfaces as measured, including the scope and enabled axes Codex declares and Claude Code does not.

## Preconditions

- [x] All declared `Depends On` specs are at `approved` status
- [x] Blocking open questions are resolved or explicitly deferred
- The specs and decision records under `Depends On` say what this one assumes.

## Required Behavior

### The destination, the rail and the addresses

- The icon rail draws five destinations in one order — Sessions, Sidekicks, Skills, Workflows, Settings — and on this screen Skills is the current destination, marked current to assistive technology as well as drawn.
- The Skills rail item draws an **open book**: a stroked outline at the same weight as every other rail glyph, in the same glyph box, which stands as drawn at every text size because a glyph is a drawing rather than a measure of content. It is not the robot. The robot is the only generic sidekick mark anywhere in the console, and it does not stand for a skill.
- The destination has **no view switch and no tabs**, anywhere on the screen.
- Four addresses, and no more: the list, the new-skill form, a folder (opened at its entry file), and that folder with one other file open. The entry file has **no address of its own** — the folder's address means the folder opened at its entry file — so there is exactly one address per thing on screen.
- `new` is the one folder name the destination reserves. A new skill whose typed name would produce the folder name `new` is written to `new-2` instead, so the form's address and a folder's address can never collide.

### The shell

- **Rail.** As above: five destinations, Skills current, the open book.
- **Header.** The title `Skills`, the count of folders, one search field and `New skill`. No view strip and no tabs. While a folder is open the header carries the skill's name in place of the title, and the count, the search field and `New skill` are put away until the folder is closed.
- **Body.** The list and the open folder; exactly one is drawn at a time and the other is emptied.
- **Shared shell.** The collapsed sessions track, the bell with its list and the colour-scheme control are the console's shared shell and this screen carries them unchanged.

### The list

- The list opens with a caption — the count, and one line naming the three places a folder lives — then a note saying why availability is a setting rather than a guess, and that the folder is the unit.
- Below that, one row per skill folder. Each row carries:
  - **a glyph tile** — the skill's icon on a plain tile, that skill's own picture;
  - **the name and the summary** — the folder name in the mono face, and the line a sidekick reads when it is deciding whether to use the skill;
  - **the origin mark** — `sidekicks · global`, `claude code · project`, `codex · global` and so on: the origin word with the scope beside it, the same origin words the session composer's skills list uses;
  - **the folder and its size** — the folder path, and how many files the folder holds;
  - **the availability line** — `Available on: Claude Code · Codex`, each provider a control that reads as pressed or not pressed, to assistive technology as well as to the eye, and where held reads as unavailable and carries its reason;
  - **the call form** — one line naming what a person types, per provider the skill reaches;
  - **the widen warning** — where the scan has something to say, the one line it writes, in place.
- Rows order by folder name under `Intl.Collator`.
- Search matches the folder name, the summary line, the origin words and every file path inside the folder, case-folded substring, never fuzzy. A search matching nothing says so in place of the rows and lists none.
- Opening a row opens that folder at its entry file.
- **The list has three read arms besides its populated one**, drawn the way the sidekick library draws them: an empty registry shows one sentence and a `New skill` control, never a spinner and never a list; a refused read renders the refusal with `Try again` as one faint clickable word at the right end of its line — no box and no icon — and no rows; and a read in flight is a third state, distinct from empty and from refused.
- **No row carries a "last used" line.** A skill is read into every session pack it is available to and a sidekick may follow it without ever calling it by name, so any figure would understate real use.

### The folder, open

The open folder holds, in reading order:

- **A top strip** — `All skills` back to the list, the unsaved-changes mark, `Cancel` and `Save`. Cancel leaves the folder the way `All skills` does.
- **The front-matter fields** — the name and the description. On a provider's own folder the name is a read-only line, because it is the folder name that provider gave the skill. A note under the fields says that these two are the entry file's front matter and that the icon is the console's own.
- **The icon field**, on every origin: a fixed set of twelve icons, one control each.
- **The global-or-project choice**, on a new skill only.
- **The path line**, which names the **folder** and never the open file, and which follows the name as it is typed so where the folder will land is never a surprise at save time. Its verb says whose folder it is: `Written to` on a new one, `Saved to` on one of the console's own, `Edited in place at` on a provider's.
- **The folder itself, in two columns** — the Files panel and the open file's body:
  - the **Files panel** has a head carrying `Add file`, states how many files the folder holds, and lists one row per file. The open file's row is marked as the current one. Each row opens its file, and carries either the mark **the skill** (on the entry file) or a rename control and a delete control. The panel is closed by a hint at its foot.
  - the **body column** carries the open file's name, its kind word (`Code` or `Text`), and its body in the face that file's extension chooses.
- **The availability control, its call line and its warning**, exactly as the row carries them.
- **One sentence under the folder.** On a provider's own folder it says that the record the console keeps beside that folder holds two things and nothing else. On a folder of the console's own it says that what is written here goes under the console's own tree, and that each provider is handed it at launch in its pack, so nothing is copied into a provider's tree.
- **The unsaved-changes question**, and the note saying what a save wrote.

### Files inside the folder

- The Files list holds the entry file **first** and every other file after it, ordered by whole path under `Intl.Collator`, so files under `agents/`, `references/` and `scripts/` group themselves.
- The entry file carries **no rename control and no delete control**. A path typed as `SKILL.md` in `Add file` or in a rename is refused in place with the reason.
- `Add file`, a rename and a delete each ask **inside the Files panel**, using the same in-place question pattern the rest of the console uses: no dialogs and no scrims, and the rest of the folder stays where it was. `Add file` opens one row holding a path field, an `Add file` control and a `Cancel`; a rename replaces the file's own row with a path field and `Rename` / `Cancel`; a delete replaces it with a sentence naming the file and `Delete` / `Keep it`.
- `Add file` takes a name with an **optional folder prefix**, so `references/style.md` and `scripts/check.sh` each make their folder. The file is added empty and opened. A folder carries subfolders at any depth: any prefix is taken, the list orders by the whole path, and nothing caps the depth.
- A deleted file leaves the folder and the editor falls back to the entry file. A renamed file keeps its body and takes the place in the order its new path gives it.
- **Nothing reaches disk until the folder is saved.**
- The rename and delete controls on a file row are put away until they are wanted: on a desktop the pointer or the keyboard reaching the row brings them out; on a screen with no pointer to hover with they stand on the row from the start.
- **Two editor faces, chosen by extension.** `.sh`, `.bash`, `.zsh`, `.yaml`, `.yml`, `.json`, `.js`, `.ts`, `.py`, `.rb`, `.toml` and `.sql` open in the **mono** face; everything else — the entry file, `.md`, `.txt` — opens in the **reading** face. Indentation is load-bearing in a script and in a metadata file, and a proportional face hides an alignment error the provider will not.
- **A file the daemon cannot read** — a binary, or one too large to open — is **still listed**, with its size and no editor. A folder that lists nine of its ten files is lying about what travels with the skill.

### Availability across providers

- Each row and each open folder carries the line `Available on: Claude Code · Codex`, each provider a control that reads as pressed or not pressed.
- **The default is derived from origin and from nothing else:** a skill authored in the console's own tree is available on **both** providers; a skill found in a provider's own tree is available on **that provider alone**.
- **One click widens a skill to the other provider, and the setting changes before the scan says anything.** The change is applied first.
- **The scan then reads every file in the folder** — not the entry file alone, because the folder is the skill and a reference file is exactly where a provider-specific instruction hides — and where it finds tool names or a call sigil belonging to a provider other than the one being widened onto, it writes **one amber line in place**, naming the files it read them out of, the tools as words, and what will happen instead on the target provider. It **blocks nothing**: no dialog opens and no row is removed.
- The scan names **the file, never the line**, because a line offset goes stale the moment the file is edited outside the console.
- Tool names in the warning are **words in sentence case**, never their wire spelling.
- A folder whose files name no other provider's tools widens with **no warning at all**.
- **Narrowing a skill back takes the setting and the line together** and leaves no state behind, because the line is derived from the setting and is never stored.
- **Three controls are held, and each says why.**
  - **A provider's own skill cannot be switched off its home provider.** That provider loads the folder out of its own tree whatever the console says, so the control keeps reading as pressed, also reads as unavailable, and its reason says that availability there is not the console's to switch off.
  - **The last provider a skill is on cannot be removed.** A skill available nowhere would never reach a session, so the control is held the same way and its reason names the other provider to widen to first.
  - **A provider whose command is not installed on this machine is held too.** Its control reads as not pressed and as unavailable, and its reason reads `Install the <provider> command to turn this on.`, the words Settings › Providers uses for the same case.
  - All three are **held rather than hidden**. Each hold is stated on the control and enforced again when the click is handled, so a forced click changes nothing.

### A new skill, and a provider's own folder

- **`New skill` writes under the console's own tree and nowhere else**: `~/.ai-sidekicks/skills/<name>/` or `<project>/.ai-sidekicks/skills/<name>/`, chosen on the form. The typed name becomes a folder name — case folded, non-alphanumerics to hyphens — and a collision **suffixes rather than overwrites**. A new skill opens with one file, its entry file, and is available on both providers.
- **A skill found in a provider's own tree is edited in place.** The name is read-only, the global-or-project choice is not offered because the folder is already somewhere, and **every file in the folder is listed and edited like any other** — including a file the provider itself keeps there. Codex's optional `agents/openai.yaml` appears in the Files list, opens in the mono face like any other metadata file, and is saved with the rest. Nothing of the console's is written into any of those files.
- **The console's own record beside a folder it did not author holds exactly two things: where the skill is available, and its icon.** Nothing else; every other field on the screen is already in the folder. The open folder says so in one sentence.
- **Name and description are front matter; the icon is the console's.** The two keys both providers read are surfaced as fields, and the entry file's editor below holds the body under them, so the front matter is never edited twice. The icon is kept in the console's own record on **every** origin, because no provider has a field for it.

### The call form

- Every row and every open folder carries one line naming the form each provider it reaches documents.
- A skill in a provider's own folder keeps its **bare name** in that provider's own session — `/security-review` on Claude Code, `$refactor-plan` on Codex.
- Everything the daemon packs arrives **namespaced** — `/sidekicks:review-diff` and `$sidekicks:review-diff` — so a packed skill can never shadow one of the provider's own.
- The console **states** the form; the composer **inserts** it, so the sigil is never typed by hand.

### The scan, and when a saved skill is live

- **Nothing stands between a project's own skill folders and a session.** Both providers read `<project>/.claude/skills`, `<project>/.codex/skills` and the project's `.agents/skills` out of the checkout on their own, so a hold in the console would not stop them loading and would only read as safety. The scan warns and never blocks, on a cloned project as on any other.
- The scan is a daemon read over every file in the folder, matched against the tool names and call sigils each provider publishes. The console renders what the daemon returns and **stores nothing**.
- At launch the daemon builds each provider's session pack from every skill available to that provider, and hands it over through that provider's own loading path.
- **A skill saved mid-session is live on Codex at once**, on the change notice the provider pushes, and **live on Claude Code after the daemon's reload request**, about 100 ms — measured at codex-cli `0.154.0` and Claude Code `2.1.270`.

### Words, keys and sizing

- **Keys.** `Cmd/Ctrl+S` saves. `Escape` closes an open in-place question first, and leaves the folder otherwise. `/` reaches the search field, `Arrow Up` and `Arrow Down` move between rows, and `Enter` opens the row in focus or applies the question that is open. Leaving with changes asks, and names what changed.
- **Words.** No sentence on the screen begins with `You`. The screen says **sidekick** and never agent. No wire spelling reaches the screen beyond file names, paths and the provider's own call form. The rule covers what a screen reader reads as well as what the screen shows, so a control that draws only a glyph carries a word for a name and never the code spelling of the symbol it draws.
- **Sizing.** Every chrome size on this screen is root-relative: no width custom property and no pane or main-flow floor is a bare pixel figure, and neither is any box the chrome lays out — no padding, margin, gap, floor, ceiling, flex basis or grid track — while the hairlines, the corner radii, the shadows, the icon boxes and the dots stay in pixels, because each of those is drawn rather than measured. A larger root therefore grows the whole screen in one proportion. Every text size and line height is a token of the console's type scale rather than a bare pixel figure.
- **The folder's two columns fold to one** on a threshold asked of the pane that holds them, in the same root-relative unit the columns are written in — for example, one column once that pane is under 736 px at the default text size, which with the sessions pane closed is a window of about 860 px. The threshold is asked of the pane and not of the window, because a window query's own em is fixed to the browser's default and never reads the root size the appearance settings set. The console fits the window it is given, full screen or any smaller size, down to the usual minimum a desktop app keeps.

## Default Behavior

- A skill authored in the console's own tree is **available on both providers**. A skill found in a provider's own tree is **available on that provider alone**.
- A new skill's scope is chosen explicitly on the form, and the path line shows the folder that choice produces as the name is typed, so where it lands is read rather than inferred.
- The `New skill` form opens on **Global**, whether or not a project is attached; `This project` is one press away.
- A new skill starts with the **bolt** picked from the twelve, and a skill whose record holds no icon draws the bolt, so every row and every open folder draws one of the twelve.
- A folder opens at its **entry file**.
- Rows order by **folder name**; the header carries no ordering control.
- A widening whose scan finds nothing shows **no line at all**.
- The folder's two columns are drawn as **two** and fold to one only under the narrow threshold.

## Fallback Behavior

- **A path already in the folder.** Answered in the `Add file` row or the rename row, in place, naming the path. Nothing is added and nothing is renamed.
- **A path typed as `SKILL.md`.** Answered the same way, with the reason that the folder always has exactly one entry file and it is never replaced.
- **An empty path.** Answered with what a path looks like, including the folder-prefix form.
- **A path that would walk out of the folder.** Leading slashes, `.` and `..` segments are dropped by normalization before the path is judged, so a file cannot land outside the folder it belongs to.
- **Availability held on the home provider.** The control keeps reading as pressed and also reads as unavailable. Its reason is a tooltip: a small label beside the control that opens on pointer hover and on keyboard focus, closes when either leaves, and is tied to the control so a screen reader reads it with the control. The row itself carries none of those words. A forced click changes nothing, because the hold is enforced when the click is handled too.
- **Availability held on the last provider.** The same shape and the same tooltip, with the reason naming the provider to widen to first.
- **Availability held for a provider that is not installed.** The control reads as not pressed and as unavailable, and its tooltip says to install that provider's command.
- **Leaving with changes.** One question, naming every changed field by its label and every changed file by its own path, with three ways out; saving is the only way out that keeps the changes. A file whose text changed is named by its own path; a file added to the folder or taken out of it is named once, as **Files**. The question is one small card at the top of the screen, over the folder and with no scrim behind it, so the folder it is asking about stays readable.
- **A file the daemon cannot read.** Listed with its size and no editor, rather than hidden.
- **The registry read refuses.** The refusal is rendered with `Try again` at the right end of its line and no rows; nothing is invented and no partial list is drawn.

## Interfaces And Contracts

Described here; the shapes belong to [Plan-030](../plans/030-skills.md).

- **The daemon owns disk.** It watches the three origins at both scopes, reads each folder's front matter, writes a folder, runs the scan the widening control renders, and builds each provider's session pack. **The console never writes a folder itself and never computes a pack**, so there is exactly one writer and exactly one place a pack is decided.
- **A read of the registry** returns one entry per skill folder: its origin, its scope, its folder path, the name and description read from its front matter, the file list with each file's path and size and whether the daemon could read it, the availability record, and the call form per provider the skill reaches.
- **A write of a folder** is a whole-folder save: the front-matter fields, each file's body, the files added and the files removed, applied together. A refused write leaves the folder on disk exactly as it was.
- **A scan** takes a folder and the provider being widened onto and returns the files that named another provider's tools and the tool names as words. It is a read with no durable effect; nothing is stored and nothing is cached across widenings.
- **The console's own record per folder** holds exactly two fields — availability and icon — keyed to the folder, on every origin.
- **The session pack** is composed per provider at launch from every skill available to that provider and is handed over through the provider's own loading path, namespaced. It is not a copy into a provider's tree.
- **The composer reads this registry.** The `/` and `$` list's Skills group is a read of the same entries this screen lists, name for name and line for line — one registry with two readers, never two registries.

## State And Data Implications

- **The folders on disk are the truth.** The registry is a projection of a filesystem watch; it is not events-canonical, is not replayed, and is not rebuilt from the session event log.
- The console's own per-folder record is the one piece of state the folder cannot hold, and it holds nothing else. A provider dropping an unknown front-matter key silently is exactly why that record exists rather than a widened front matter.
- **The widen warning is derived and never stored.** It is a function of the availability setting and the folder's contents at the moment of the scan, so narrowing removes it without a write.
- Nothing reaches disk until a folder is saved; an abandoned edit leaves no partial folder and no orphan file.
- Project-scoped folders travel with the repository and are therefore visible to anyone who clones it; global folders live under the home folder and do not.
- No control-plane table, no relay surface and no export surface: this destination is node-local.

## Example Flows

- `Example: A person opens Skills and sees every skill folder on the machine in one list — some under the console's own tree, some under Claude Code's, some under Codex's, one of them under the project's .agents/skills root — each row naming its origin and scope, its folder path, its file count, where it is available and what to type to call it.`
- `Example: A person opens a folder of their own, adds references/risk-classes.md from the Files panel, pastes a table into it, and saves. The save writes both files; a Codex session already running picks the skill up at once, and a Claude Code session already running picks it up after the daemon's reload request.`
- `Example: A person widens a Codex-origin skill onto Claude Code. The control flips first. The scan then writes one amber line naming the entry file and the provider metadata file as the two places it read Codex tool names, says in words what will happen on Claude Code instead, and blocks nothing. Narrowing the skill back removes the line with the setting.`
- `Example: A person opens a skill that lives in Claude Code's own tree. The name is read-only, there is no global-or-project choice, the path line reads "Edited in place at", and one sentence says the record kept beside the folder holds only where the skill is available and its icon.`
- `Example: A person tries to switch Claude Code off a skill that lives in Claude Code's own tree. The control reads as unavailable, its tooltip says availability there is not the console's to switch off, and a forced click changes nothing.`
- `Example: A person types SKILL.md into the Add file row. The row answers in place with the reason that the folder always has exactly one entry file, nothing is added, and nothing else on the screen moves.`

## Implementation Notes

- The scan's per-provider vocabulary — tool names and call sigils — is the one part of this destination that ages with the providers. It belongs in one place, read at each provider version bump, and its output is words rather than wire spellings so a rename upstream changes a table and not the screen.
- The daemon watching a root that does not exist yet is worth creating rather than skipping: on Claude Code a scope directory that did not exist when a session started is invisible for the life of that session unless the reload request is sent, so creating the roots before launch and sending the reload after a write is what makes a mid-session save reliable.
- Because the two providers' front matter overlaps on exactly the two keys the editor surfaces, the editor needs no per-provider mode. What a provider keeps for itself — the Codex metadata file — is an ordinary file in the Files list and needs no special case beyond being listed.
- The four addresses make each screen state linkable, which is also what makes each state reachable from a test without driving the interface to get there.

## Pitfalls To Avoid

- **Do not let the scan block a widening.** The scan is advice about a folder's contents, not a validator; a widening it cannot vet is still the person's decision, and a blocking scan would make an honest report into a refusal.
- **Do not scan the entry file alone.** A reference file is where a provider-specific instruction hides, and a scan that reads one file would report a clean folder that is not.
- **Do not hide a held availability control.** A hidden control is an unexplained absence; a held one that says why is an answer.
- **Do not store the widen warning.** It would then survive a narrowing, or survive an edit, and say something untrue about the folder as it is now.
- **Do not write anything of the console's into a provider's own files.** Both providers drop unknown front-matter keys silently, so a field written there is lost with no signal; that is what the console's own record is for.
- **Do not give the entry file its own address.** Two addresses for one screen state means two ways to be somewhere and one of them wrong after a rename.
- **Do not model a skill as a single text body.** Most useful skills carry more than one file, and a single-body editor cannot add, rename or delete one.
- **Do not add a "last used" figure.** A skill is read into every pack it is available to and may be followed without being named, so the figure would be wrong in the direction that matters.

## Acceptance Criteria

- [ ] The rail draws five destinations in the order Sessions, Sidekicks, Skills, Workflows, Settings, and on this screen Skills is marked current to assistive technology as well as drawn.
- [ ] The Skills rail item draws the open book at the rail's own weight, and no robot glyph appears on this screen for a skill.
- [ ] The header carries the title, the count, one search field and `New skill`, and no view switch or tab set exists anywhere on the screen.
- [ ] Every row shows its origin mark, its folder path, its file count, its availability line and its call form.
- [ ] Rows order by folder name under `Intl.Collator`.
- [ ] Search matches the folder name, the summary line, the origin words and every file path inside the folder, case-folded substring; a search matching nothing says so and lists no rows.
- [ ] Availability defaults to both providers for a folder in the console's own tree and to the home provider alone for a folder in a provider's tree.
- [ ] One click widens a skill to the other provider, and the setting is observably changed before the scan reports.
- [ ] The scan reads every file in the folder, names the files it read another provider's tool names out of, warns in one line in place, and blocks nothing — no dialog opens and no row is removed.
- [ ] Tool names in the warning are words in sentence case, with no wire spelling.
- [ ] A folder whose files name no other provider's tools widens with no warning.
- [ ] Narrowing a skill back removes the setting and the warning together and leaves no state behind.
- [ ] The home provider of a folder found in a provider's tree cannot be switched off it: the hold is stated on the control, and a forced click handled by the code changes nothing.
- [ ] The last provider a skill is on cannot be removed, held the same way, with a reason naming the provider to widen to first.
- [ ] A provider whose command is not installed is held as not pressed, with the reason `Install the <provider> command to turn this on.`
- [ ] The `New skill` form opens on Global with the bolt icon picked.
- [ ] Opening a row opens that folder at its entry file.
- [ ] The Files list holds the entry file first and every other file after it ordered by whole path, and states how many files the folder holds.
- [ ] The entry file carries no rename control and no delete control, and a path typed as `SKILL.md` is refused in place with the reason.
- [ ] `Add file` takes a path with an optional folder prefix, adds the file empty, and opens it; a path already in the folder is refused in place with the reason.
- [ ] A rename and a delete each ask inside the Files panel with no dialog and no scrim, and the rest of the folder stays where it was.
- [ ] A deleted file leaves the folder and the editor falls back to the entry file; a renamed file keeps its body and takes the place its new path gives it.
- [ ] A file with a code extension opens in the mono face and a prose file in the reading face, and the open file's name and kind word are stated above the editor.
- [ ] The path line names the folder and not the open file, on every state of the screen.
- [ ] A new skill opens with one file, writes its folder under the console's own tree global or project as chosen, follows the typed name in the path line, and is available on both providers.
- [ ] A folder in a provider's own tree is edited in place: the path line says so, the name is read-only, the scope choice is absent, and every file in it — a provider's own metadata file included — is listed and editable.
- [ ] The sentence beside a provider's own folder says the record kept beside it holds two things and nothing else: where the skill is available, and its icon.
- [ ] The four addresses are the list, the new-skill form, a folder, and a folder with one other file open; the entry file has no second address.
- [ ] `Cmd/Ctrl+S` saves; `Escape` closes an open in-place question first and leaves the folder otherwise; `/` reaches the search field; `Arrow Up` and `Arrow Down` move between rows; `Enter` opens the row in focus or applies the open question; leaving with changes asks and names every changed field by its label and every changed file by its path, with files added or removed named once as `Files`.
- [ ] No sentence on the screen begins with `You`; the screen says sidekick and never agent; no wire spelling appears beyond file names, paths and the provider's own call form, over every accessible name as well as every visible word; every control that draws only a glyph carries a word for a name.
- [ ] Every chrome size on the screen is root-relative and every text size and line height is a type-scale token, so the screen at a larger root is the same screen in one proportion; the folder's two columns fold to one under the narrow threshold, asked of the pane rather than the window.
- [ ] A file the daemon cannot read is listed with its size and no editor rather than omitted.
- [ ] A folder carries subfolders at any depth: any prefix is accepted, the list orders by whole path, and no depth is capped.
- [ ] The list draws its in-flight, refused and empty arms, each distinct from the others and from a populated list.
- [ ] No row carries a "last used" line.
- [ ] A skill saved mid-session is live on Codex on its change notice and on Claude Code after the daemon's reload request.
- [ ] The session composer's skills group and this list show the same skills, name for name and line for line.

## ADR Triggers

- Writing into a provider's own tree from the console — creating a folder there, or adding a field of the console's to a file a provider owns — crosses this spec's boundary and requires a record covering provenance and what happens when the provider rewrites the file.
- Adding a Commands view, or any second registry beside this one, changes what a single source of truth means here and requires a record.
- Bridging a skill across providers — making a skill marked for one provider execute under the other — is a change to what a skill is (text a model reads) and requires a record.
- Distributing or importing skills authored elsewhere — a marketplace, a gallery, a pull from a remote index — introduces third-party content into a session's instructions and requires a record covering trust.
- Making the widening scan a gate rather than a report inverts this spec's stated posture and requires a record.

## Open Questions

None.

## References

- [Spec-004 §The provider command and skill surface](004-provider-driver-contract-and-capabilities.md#the-provider-command-and-skill-surface) — the driver's live per-binding read of a provider's own command-and-skill enumeration, which is the provider's answer about what it loaded, beside this spec's registry of what is on disk.
- [Spec-021 §The surface set](021-desktop-shell-and-renderer.md#the-surface-set) — the icon rail and the console's surfaces this destination joins.
- [Spec-021 §Console Test Tiers](021-desktop-shell-and-renderer.md#console-test-tiers) — the tiers a console change is proven by.
- [Spec-027](027-agent-definitions-and-peer-invocation.md) — the sidekick library beside this destination; a definition stays one file and attaches a skill rather than carrying a folder.
- [ADR-031](../decisions/031-five-rail-destinations.md) — the five rail destinations, their order, and the rule that sorts a future surface into a destination or a Settings page.
- [ADR-035](../decisions/035-one-syntax-colourer-in-the-daemon.md) — one colourer in the daemon; the folder editor paints the spans it is handed.
- [Claude wire reference §`system/init` command and skill enumeration](../reference/provider-wire/claude.md#systeminit-command-and-skill-enumeration--a-live-read-never-a-stored-registry) — Claude Code's own skill enumeration, names only, with no scope and no enabled axis.
- [Codex wire reference §`skills/*`](../reference/provider-wire/codex.md#skills--the-skill-surface) — Codex's skill surface: the grouped-per-directory read, the change notification, the required `description`, and the four-value scope set.
- [Plan-030](../plans/030-skills.md) — the implementation plan for this spec.
- Provider measurements behind the front-matter and liveness rules above, taken 2026-09-13: Claude Code `2.1.270` reads the front matter it knows and drops unknown keys silently, folds custom commands into the skills registry, and picks up a written skill on a forced reload request in about 100 ms; codex-cli `0.154.0` (source tag `rust-v0.154.0`) parses `name`, `description` and `metadata.short-description`, ignores unknown keys, reads the optional `agents/openai.yaml` metadata file beside the entry file, has no custom slash commands, and pushes a change notification within about two seconds of a skill folder being written, after which the same live thread can invoke it.
