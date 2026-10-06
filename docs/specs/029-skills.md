# Spec-029: Skills

| Field | Value |
| --- | --- |
| **Status** | `draft` |
| **NNN** | `029` |
| **Slug** | `skills` |
| **Date** | `2026-09-21` |
| **Author(s)** | `Sawmon Abo` |
| **Depends On** | [Spec-004](004-provider-driver-contract-and-capabilities.md), [Spec-021](021-desktop-app-and-renderer.md), [Spec-026](026-agent-definitions-and-peer-invocation.md); [ADR-029](../decisions/029-five-rail-destinations.md) |
| **Implementation Plan** | [Plan-026](../plans/026-skills.md) |

## Purpose

A **skill** is a folder of text an agent reads: instructions plus whatever the instructions need — a reference table, a script, a template. Both pinned providers load skills as folders and neither loads a lone file. The folder is named for the skill, a file called `SKILL.md` at its top carries the front matter and the instructions, and every other file beside it travels with the skill and is reachable from the instructions by relative path.

Skills are written, edited and used, so they are a place a person goes rather than a setting on a machine: the console's icon rail carries Skills as its third destination, between Sidekicks and Workflows ([ADR-029](../decisions/029-five-rail-destinations.md)). This spec defines that destination — the one list of every skill on the machine whatever tree it lives in, the folder editor that authors the whole folder rather than one file, and the rules by which one skill reaches both providers.

**What each provider reads out of a skill's front matter is narrow, and the two differ.** Claude Code at version `2.1.270` reads the front matter it knows and silently drops every key it does not, with nothing on the wire and nothing on standard error to say a key was dropped; its custom commands and its skills are one registry, so a skill is reachable as `/name args` in a session as well as by the model's own choice. codex-cli at version `0.154.0` (source tag `rust-v0.154.0`) parses exactly three things — `name`, defaulting to the directory name when it is absent; `description`, required and non-empty; and `metadata.short-description` — and likewise ignores unknown keys. Codex additionally reads an optional metadata file of its own, `agents/openai.yaml`, inside the same folder, carrying an interface block, a dependency block and a policy block. Codex has no custom slash commands at all at that version, so a skill is the whole of its authored-prompt surface, reached as `$name`. The wire surfaces behind both readings are recorded in [Claude wire reference §`system/init` command and skill enumeration](../reference/provider-wire/claude.md#systeminit-command-and-skill-enumeration--a-live-read-never-a-stored-registry) and [Codex wire reference §`skills/*`](../reference/provider-wire/codex.md#skills--the-skill-surface).

The consequence this spec is built on: **a skill authored once can be made available to both providers, because a folder with a name, a description and a body is the whole of what either one requires** — but neither provider will hold a field it does not know, so anything the console needs to remember about a skill lives in the console's own record beside the folder, never inside it.

## Scope

- **What a skill is, and where it lives.** A skill is a folder on disk. It lives in one of four origins. The first three each exist both globally under the home folder and per project inside the repository:
  - **the console's own** — `~/.ai-sidekicks/skills/<name>/` and `<project>/.ai-sidekicks/skills/<name>/`;
  - **Claude Code's own** — `~/.claude/skills/` and `<project>/.claude/skills/`;
  - **Codex's own** — `$HOME/.agents/skills/` (its current user location), `~/.codex/skills/` (the older one it still reads), `<project>/.codex/skills/`, and the project's `.agents/skills/`, which Codex also reads as a skill root. A folder found there carries the Codex origin and shows that root in its path.
  - **a plugin's** — a skill a plugin installed, read from the daemon's own plugin home for that plugin's provider, and read-only here; plugins are found, installed and removed in `Browse plugins` ([Spec-026 §Browse plugins](026-agent-definitions-and-peer-invocation.md#browse-plugins)).

  Project folders travel with the repository. The daemon watches all of them.

- **One list across the origins.** Every skill folder appears once, with the origin and scope it was found at, its folder path, how many files it holds, where it is available and what a person types to call it, and whether its provider switches it off or it fails to load.
- **The folder is the unit.** The editor authors the folder, not one file: a Files list with the entry file first and every supporting file after it, with adding, renaming and deleting a file, and each file opening in the same editor. Availability, widening and the scan apply to the folder as a whole.
- **Availability across providers.** A setting per folder with a default derived from origin, a one-click widening whose scan reports and never refuses, and one switch per provider with no lock, written through that provider's own per-session off switch.
- **Authoring and editing.** A new skill is written under the console's own tree, global or project as chosen. A skill found in a provider's own tree is edited where it already is.

## Non-Goals

- **No gallery of the console's own.** Skills made elsewhere arrive as plugins from each provider's own catalogs, installed in `Browse plugins` ([Spec-026 §Browse plugins](026-agent-definitions-and-peer-invocation.md#browse-plugins)), and a plugin's skills are listed read-only beside the rest. Nothing here publishes a skill.
- **No writing into a provider's own tree from the New skill form.** A new folder is created under the console's own tree only; a provider's existing folder is edited in place and is never created by the console. The console adds no field of its own to a file a provider owns.
- **No Commands view.** Claude Code folded its custom commands into its skills registry, and Codex has no custom commands at all, so a Commands view would show one provider's items and draw a split neither provider has.
- **No copying into a provider's tree to make a bare terminal see skills.** Nothing is written into `.claude` or `.codex` so that a plain `claude` or `codex` invocation outside the console would find a skill authored here. Providers receive skills through the pack the daemon hands them at launch.
- **No tool-server configuration.** A tool server is machine configuration and is managed on its Settings page, not here.
- **No second registry.** The session composer's `/` and `$` list and this screen read the same skills; one is not a copy of the other. The daemon's skill list is the one inventory and the one answer to where a skill is available; a provider's own skill list is evidence of what that provider loaded or failed to load, never a second registry. The daemon parses every `SKILL.md` itself rather than trusting what a provider chose to load.
- **Nothing about driving a session from a linked device.** This is a console surface over a registry the daemon watches on the machine the skills live on.
- **An agent definition does not become a folder, and nothing attaches a skill to one.** A definition stays one file ([Spec-026 §The definition registry](026-agent-definitions-and-peer-invocation.md#the-definition-registry)); reference material lives in a skill, and the skill carries the folder. Every skill available on the provider an agent runs on reaches that agent in the pack the daemon builds at launch, so there is no per-definition list of skills.

## Domain Dependencies

- [Glossary](../domain/glossary.md) — _agent_, _session_.
- [Session Model](../domain/session-model.md) — the session a skill is packed into at launch and becomes live inside mid-run.

## Architectural Dependencies

- [ADR-029](../decisions/029-five-rail-destinations.md) — the five rail destinations and their order; Skills is the third, and this spec is its owner.
- [Spec-021](021-desktop-app-and-renderer.md) — the app layout this destination mounts inside: the icon rail and the surface set, the console's library set, and the test tiers a console change is proven by.
- [Spec-004 §The provider command and skill surface](004-provider-driver-contract-and-capabilities.md#the-provider-command-and-skill-surface) — the driver's live read of a provider's own enumeration of commands and skills, per binding. That read is the provider's answer about what it has loaded; this spec's list is the registry on disk that the daemon watches and packs. The two are different questions and neither is derived from the other.
- [Spec-026](026-agent-definitions-and-peer-invocation.md) — the agent library beside this destination; the one-file definition every available skill reaches through the pack rather than being folded into; the file watch, the record kept beside a provider's file and the session pack, which this destination reuses rather than duplicates; and `Browse plugins`, where a plugin that carries skills is installed.
- [Claude wire reference §`system/init` command and skill enumeration](../reference/provider-wire/claude.md#systeminit-command-and-skill-enumeration--a-live-read-never-a-stored-registry) and [Codex wire reference §`skills/*`](../reference/provider-wire/codex.md#skills--the-skill-surface) — the two providers' skill surfaces as measured, including the scope and enabled axes Codex declares and Claude Code does not.

## Preconditions

- The specs and decision records under `Depends On` say what this one assumes.

## Required Behavior

### The destination, the rail and the addresses

- The icon rail draws five destinations in one order — Sessions, Sidekicks, Skills, Workflows, Settings — and on this screen Skills is the current destination, marked current to assistive technology as well as drawn.
- The Skills rail item draws an **open book**: a stroked outline at the same weight as every other rail glyph, in the same glyph box, which stands as drawn at every text size because a glyph is a drawing rather than a measure of content. It is not the robot. The robot is the only generic agent mark anywhere in the console, and it does not stand for a skill.
- The destination has **no view switch and no tabs**, anywhere on the screen.
- Four addresses, and no more: `#/skills` (the list), `#/skills?new` (the new-skill form), `#/skills/<id>` (a folder, opened at its entry file) and `#/skills/<id>/<file path>` (that folder with one other file open), where `<id>` is the `skillId` the service gives each folder and `skill.list` carries, kept through a rename made in the app, so two folders that share a name never share an address. The entry file has **no address of its own** — the folder's address means the folder opened at its entry file — so there is exactly one address per thing on screen.
- A skill folder keeps its real name, `new` included: the form's address is a query on the list's, so it never collides with a folder's.

### The layout

- **Rail.** As above: five destinations, Skills current, the open book.
- **Header.** The title `Skills`, the count of folders, one search field, `Browse plugins` and `New skill`. No view strip and no tabs. `Browse plugins` opens `#/sidekicks/plugins`. While a folder is open the header carries the skill's name in place of the title, and the count, the search field, `Browse plugins` and `New skill` are put away until the folder is closed.
- **Body.** The list and the open folder; exactly one is drawn at a time and the other is emptied.
- **Shared layout.** The collapsed sessions track, the bell with its list and the color-scheme control are the console's shared layout and this screen carries them unchanged.

### The list

- The list opens with a caption — the count, and one line naming the places a folder lives — then a note saying why availability is a setting rather than a guess, and that the folder is the unit.
- Below that, one row per skill folder. Each row carries:
  - **a glyph tile** — the skill's icon on a plain tile, that skill's own picture;
  - **the name and the summary** — the folder name in the mono face, and the line an agent reads when it is deciding whether to use the skill;
  - **the origin mark** — `sidekicks · global`, `claude code · project`, `codex · global` and so on: the origin word with the scope beside it, the same origin words the session composer's skills list uses; a plugin's skill reads `plugin · <plugin name>`;
  - **the folder and its size** — the folder path, and how many files the folder holds;
  - **the availability line** — `Available on: Claude Code · Codex`, each provider a control that reads as pressed or not pressed, to assistive technology as well as to the eye;
  - **the call form** — one line naming what a person types, per provider the skill reaches;
  - **the widen warning** — where the scan has something to say, the one line it writes, in place;
  - **the provider facts** — `Off in Claude Code` or `Off in Codex` while that provider's own configuration switches the skill off, and `Didn't load · <reason>` while its folder fails to load, each drawn only while it holds, each its own mark, and both drawn when both hold. Both are read from the daemon's own parse of the folder, never from a provider's list alone.
- Rows order by folder name under `Intl.Collator`.
- Search matches the folder name, the summary line, the origin words and every file path inside the folder, case-folded substring, never fuzzy. A search matching nothing says so in place of the rows and lists none.
- Opening a row opens that folder at its entry file.
- **A skill whose folder was renamed or deleted outside the console** leaves the rows for a group of its own after them, `Folder gone`. Its row keeps what the console's record still holds — the icon and where it was available — reads the last path the folder was known at, and carries two acts: `Reattach…`, which opens the platform's folder chooser and attaches the record to the folder picked, and `Discard`, which drops the record after asking in place. The row is never drawn among the live rows and never dropped.
- **The list has three read arms besides its populated one**, drawn the way the agent library draws them: an empty registry shows one sentence, `No skills yet — a skill is a folder of instructions and files Claude Code and Codex read when a task calls for it.`, and a `New skill` control, never a spinner and never a list; a refused read renders the refusal with `Try again` as one faint clickable word at the right end of its line — no box and no icon — and no rows; and a read in flight is a third state, distinct from empty and from refused, whose loading note reads `Reading the skills on this machine…` while the count reads `—`.
- **No row carries a "last used" line.** A skill is read into every session pack it is available to and an agent may follow it without ever calling it by name, so any figure would understate real use.

### The folder, open

The open folder holds, in reading order:

- **A top strip** — `All skills` back to the list, the unsaved-changes mark, `Cancel` and `Save`. Cancel leaves the folder the way `All skills` does.
- **The front-matter fields** — the name and the description. On a provider's own folder the name is a read-only line, because it is the folder name that provider gave the skill. On a folder of the console's own, editing the name renames the folder too, so the row, its order, its call form and the front matter's `name` stay in step. A note under the fields says that these two are the entry file's front matter and that the icon is the console's own.
- **The icon field**, on every origin: a fixed set of twelve icons, one control each.
- **The global-or-project choice**, on a new skill only.
- **The path line**, which names the **folder** and never the open file, and which follows the name as it is typed so where the folder will land is never a surprise at save time. Its verb says whose folder it is: `Written to` on a new one, `Saved to` on one of the console's own, `Edited in place at` on a provider's.
- **The folder itself, in two columns** — the Files panel and the open file's body:
  - the **Files panel** has a head carrying `Add file`, states how many files the folder holds, and lists one row per file. The open file's row is marked as the current one. Each row opens its file, and carries either the mark **the skill** (on the entry file) or a rename control and a delete control. The panel is closed by a hint at its foot.
  - the **body column** carries the open file's name, its kind word (`Code` or `Text`), and its body in the face that file's extension chooses.
- **The availability control, its call line and its warning**, exactly as the row carries them.
- **One sentence under the folder.** On a provider's own folder it says that the record the console keeps beside that folder holds two things and nothing else. On a folder of the console's own it says that what is written here goes under the console's own tree, and that each provider is handed it at launch in its pack, so nothing is copied into a provider's tree.
- **The unsaved-changes question**, and the note saying what a save wrote.

A skill a plugin installed opens the same folder with its fields and files drawn and no control: no `Save`, no `Add file`, no rename and no delete, and no icon, scope or availability control to press. One line stands in their place: `Installed by a plugin. Update or remove it in Browse plugins.`, where `Browse plugins` opens `#/sidekicks/plugins`.

### Files inside the folder

- The Files list holds the entry file — `SKILL.md` — **first** and every other file after it, ordered by whole path under `Intl.Collator`, so files under `agents/`, `references/` and `scripts/` group themselves.
- The entry file carries **no rename control and no delete control**. A path typed as `SKILL.md` in `Add file` or in a rename is refused in place with the reason.
- `Add file`, a rename and a delete each ask **inside the Files panel**, using the same in-place question pattern the rest of the console uses: no dialogs and no scrims, and the rest of the folder stays where it was. `Add file` opens one row holding a path field, an `Add file` control and a `Cancel`; a rename replaces the file's own row with a path field and `Rename` / `Cancel`; a delete replaces it with a sentence naming the file and `Delete` / `Keep it`.
- `Add file` takes a name with an **optional folder prefix**, so `references/style.md` and `scripts/check.sh` each make their folder. The file is added empty and opened. A folder carries subfolders at any depth: any prefix is taken, the list orders by the whole path, and nothing caps the depth.
- A deleted file leaves the folder and the editor falls back to the entry file. A renamed file keeps its body and takes the place in the order its new path gives it.
- **Nothing reaches disk until the folder is saved.**
- The rename and delete controls on a file row are put away until they are wanted: on a desktop the pointer or the keyboard reaching the row brings them out; on a screen with no pointer to hover with they stand on the row from the start.
- **Two editor faces, chosen by extension.** `.sh`, `.bash`, `.zsh`, `.yaml`, `.yml`, `.json`, `.js`, `.ts`, `.py`, `.rb`, `.toml` and `.sql` open in the **mono** face; everything else — the entry file, `.md`, `.txt` — opens in the **reading** face. Indentation is load-bearing in a script and in a metadata file, and a proportional face hides an alignment error the provider will not.
- **A file the daemon cannot read** — a binary — is **still listed**, with its size and no editor. A folder that lists nine of its ten files is lying about what travels with the skill.
- **Any text file opens, whatever its size.** Past the memory budget the console works out from the machine it runs on, the editor shows the file read-only, drawing only part of it, and names the file's real size and how much is shown; there is no fixed figure. The read goes through the service (`skill.fileRead`), never a file path in the window.

### Availability across providers

- Each row and each open folder carries the line `Available on: Claude Code · Codex`, each provider a control that reads as pressed or not pressed.
- **The default is derived from origin and from nothing else:** a skill authored in the console's own tree is available on **both** providers; a skill found in a provider's own tree is available on **that provider alone**.
- **One click widens a skill to the other provider, and the setting changes before the scan says anything.** The change is applied first.
- **The scan then reads every file in the folder** — not the entry file alone, because the folder is the skill and a reference file is exactly where a provider-specific instruction hides — and where it finds tool names or a call sigil belonging to a provider other than the one being widened onto, it writes **one amber line in place**, naming the files it read them out of, the tools as words, and what will happen instead on the target provider. It **blocks nothing**: no dialog opens and no row is removed.
- The scan names **the file, never the line**, because a line offset goes stale the moment the file is edited outside the console.
- Tool names in the warning are **words in sentence case**, never their wire spelling.
- A folder whose files name no other provider's tools widens with **no warning at all**.
- **Narrowing a skill back takes the setting and the line together** and leaves no state behind, because the line is derived from the setting and is never stored.
- **One switch per provider, with no lock.** A skill is switched off on a provider through that provider's own per-session off switch — Claude Code's `skillOverrides` in the session's settings, Codex's session config — which the daemon writes; nothing writes the person's own config files, and the window never touches a provider folder. A provider's own skill can be switched off its own provider the same way, and a skill may be off everywhere, its row showing neither provider pressed and no call line.
- **A plugin's skill is available on the provider the plugin was installed for, and neither control can be pressed**, because the plugin, not the console, decides where the skill goes.
- **A skill runs only on the providers it is available on.** A skill marked for one provider never runs under the other; widening it is the one way it reaches the other provider.

### A new skill, and a provider's own folder

- **`New skill` writes under the console's own tree and nowhere else**: `~/.ai-sidekicks/skills/<name>/` or `<project>/.ai-sidekicks/skills/<name>/`, chosen on the form. The typed name becomes a folder name — case folded, non-alphanumerics to hyphens — and a collision **suffixes rather than overwrites**. A new skill opens with one file, its entry file, and is available on both providers.
- **A skill found in a provider's own tree is edited in place.** The name is read-only, the global-or-project choice is not offered because the folder is already somewhere, and **every file in the folder is listed and edited like any other** — including a file the provider itself keeps there. Codex's optional `agents/openai.yaml` appears in the Files list, opens in the mono face like any other metadata file, and is saved with the rest. Nothing of the console's is written into any of those files.
- **The console's own record beside a folder it did not author holds exactly two things: where the skill is available, and its icon.** Nothing else; every other field on the screen is already in the folder. The open folder says so in one sentence.
- **Name and description are front matter; the icon is the console's.** The two keys both providers read are surfaced as fields, and the entry file's editor below holds the body under them, so the front matter is never edited twice. The icon is kept in the console's own record on **every** origin, because no provider has a field for it.

### The call form

- Every row and every open folder carries one line naming the form each provider it reaches documents.
- A skill in a provider's own folder keeps its **bare name** in that provider's own session — `/security-review` on Claude Code, `$refactor-plan` on Codex.
- Everything the daemon packs arrives **namespaced**, so a packed skill can never shadow one of the provider's own: the daemon packs each origin as a plugin of its own, and both providers put a plugin's name before its skills.
- **Only a skill made in the console carries `sidekicks:`** — `/sidekicks:review-diff` and `$sidekicks:review-diff`.
- A skill that crosses to the other provider arrives under the name of where it came from, always, never only when two names meet, so its name never changes because some other folder appeared: a Claude Code skill reads `$claude:security-review` in a Codex session, and a Codex skill reads `/codex:refactor-plan` in a Claude Code session.
- A plugin's skill keeps the plugin's own namespace on both providers: `/<plugin name>:<skill name>` on Claude Code, and `$<plugin name>:<skill name>` on Codex, where the daemon packs it as a plugin of that name.
- A provider's own skills that collide with each other in that provider's own session, as a personal and a project `deploy` on Claude Code, are the project's to resolve; the console adds nothing.
- Two folders of one origin that share a name, a global one and a project one, both pack: the global one keeps the name and the project one takes the `-2` suffix a new skill takes. Saving a folder of the console's own under a name another of its own already packs under warns first: while the name is typed the screen asks the daemon, `skill.callFormRead`, what the name would be called by and which folder it collides with, and draws the warning under the Name field from that answer, saying where the other folder lives and the name the project one is called by. The screen never works the collision or the `-2` out itself. The one Save writes, on a new skill as on an existing one.
- The console **states** the form; the composer **inserts** it, so the sigil is never typed by hand.
- **A skill picked for a Codex agent also travels by its path.** Each skill the person picks from the composer's list rides the send (`run.queueCreate`) with that row's name and folder, as `skill.list` gives them. To a Codex agent each one goes in the turn's input as Codex's own skill item, `{type: "skill", name, path}`, its `path` the `SKILL.md` file the daemon builds from that folder, beside the `$name` text, so of two of Codex's own folders that share a name and both read `$<name>`, the row picked is the one that runs. A Claude Code agent receives the `/name` text alone. The daemon accepts a pick only when its name and folder match a row of `skill.list` and refuses the send otherwise with `skill.path_refused` (`not_listed`), so no path the registry did not list reaches a provider.

### The scan, and when a saved skill is live

- **Nothing stands between a project's own skill folders and a session.** Both providers read `<project>/.claude/skills`, `<project>/.codex/skills` and the project's `.agents/skills` out of the checkout on their own, and the console adds no gate over them: the scan warns and never blocks, on a cloned project as on any other, and a skill stays out of a session only when the person switches it off on that provider.
- The scan is a daemon read over every file in the folder, matched against the tool names and call sigils each provider publishes. The console renders what the daemon returns and **stores nothing**.
- **The daemon parses every `SKILL.md` itself**, because a provider's own report misses cases. Codex's `skills/list` reports a failed skill only in its `errors`, as `{path, message}`, which the daemon matches to its row by path. Codex flags missing or unclosed front matter, invalid YAML, a missing or empty `description` and a name over 64 characters; it loads without error a skill with no name (under its folder's name), a name that differs from its folder, a duplicate name and front matter it repairs (a broken name loads as `[unterminated`), and it never reports a system skill's error. The daemon's own parse is what sets a row's `Didn't load · <reason>`, and Codex's report is evidence beside it.
- At launch the daemon builds each provider's session pack from every skill available to that provider, and hands it over through that provider's own loading path, each origin packed as a plugin of its own whose name the provider puts before its skills: on Claude Code each a plugin folder passed with `--plugin-dir`, on Codex each a plugin through its configuration. A skill made in the console packs as `sidekicks`, a Claude Code skill packs for Codex in the plugin `claude` (`$claude:<name>`), a Codex skill packs for Claude Code in the plugin `codex` (`/codex:<name>`), and a plugin's skill packs for Codex in a plugin of the plugin's own name (`$<plugin name>:<skill name>`). It is the one session pack the agent definitions also travel in ([Spec-026 §The definition registry](026-agent-definitions-and-peer-invocation.md#the-definition-registry)).
- **A skill saved mid-session is live on Codex at once**, on the `skills/changed` notice the provider pushes, and **live on Claude Code after the daemon's `reload_plugins` request**, about 100 ms — measured at codex-cli `0.154.0` and Claude Code `2.1.270`.

### Words, keys and sizing

- **Keys.** `Cmd/Ctrl+S` saves. `Escape` closes an open in-place question first, and leaves the folder otherwise. `/` reaches the search field, `Arrow Up` and `Arrow Down` move between rows, and `Enter` opens the row in focus or applies the question that is open. Leaving with changes asks, and names what changed.
- **Words.** No sentence on the screen begins with `You`. The screen says `sidekick` and never `agent`. No wire spelling reaches the screen beyond file names, paths and the provider's own call form. The rule covers what a screen reader reads as well as what the screen shows, so a control that draws only a glyph carries a word for a name and never the code spelling of the symbol it draws.
- **Sizing.** Every chrome size on this screen is root-relative: no width custom property and no pane or main-flow floor is a bare pixel figure, and neither is any box the chrome lays out — no padding, margin, gap, floor, ceiling, flex basis or grid track — while the hairlines, the corner radii, the shadows, the icon boxes and the dots stay in pixels, because each of those is drawn rather than measured. A larger root therefore grows the whole screen in one proportion. Every text size and line height is a token of the console's type scale rather than a bare pixel figure.
- **The folder's two columns fold to one** on a threshold asked of the pane that holds them, in the same root-relative unit the columns are written in — for example, one column once that pane is under 736 px at the default text size, which with the sessions pane closed is a window of about 860 px. The threshold is asked of the pane and not of the window, because a window query's own em is fixed to the browser's default and never reads the root size the appearance settings set. The console fits the window it is given, full screen or any smaller size, down to the usual minimum a desktop app keeps.

## Default Behavior

- A skill authored in the console's own tree is **available on both providers**. A skill found in a provider's own tree is **available on that provider alone**.
- A skill a plugin installed is **available on the provider the plugin was installed for**, and the console cannot change it.
- A new skill's scope is chosen explicitly on the form, and the path line shows the folder that choice produces as the name is typed, so where it lands is read rather than inferred.
- The `New skill` form opens on **Global**, whether or not a project is attached; `This project` is one press away, held with its reason (`No project is attached`) while none is. The project it names is the one the person came from — the session's project when the destination was opened from a session, otherwise the project of the most recently focused session — shown in the control's own label, `This project · <name>`, with the machine's other known projects one press away in its list.
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
- **A name another folder of the console's own already holds in the same place.** Renaming a folder of its own onto it is answered under the name field, in place, naming that folder. Nothing is renamed.
- **Leaving with changes.** One question, naming every changed field by its label and every changed file by its own path, with three ways out; saving is the only way out that keeps the changes. A file whose text changed is named by its own path; a file added to the folder or taken out of it is named once, as **Files**. The question is one small card at the top of the screen, over the folder and with no scrim behind it, so the folder it is asking about stays readable.
- **A file the daemon cannot read.** Listed with its size and no editor, rather than hidden.
- **A provider's skill folder renamed or deleted outside the console.** The availability and the icon the console's record holds for it are shown as orphaned in the `Folder gone` group, with the last path the folder was known at, until they are reattached to a folder or discarded, as an agent's record is ([Spec-026 §Fallback Behavior](026-agent-definitions-and-peer-invocation.md#fallback-behavior)). Nothing is silently rewritten and nothing is silently dropped. A reattach is accepted only while the record is orphaned.
- **A skill folder that does not load, or that its provider switches off.** The row stays in the list and says which, `Didn't load · <reason>` or `Off in Codex`; nothing hides the skill.
- **Availability held on a plugin's skill.** Neither availability control can be pressed. Each keeps reading as pressed or not and also reads as unavailable, and its reason is a tooltip: a small label beside the control that opens on pointer hover and on keyboard focus, closes when either leaves, and is tied to the control so a screen reader reads it with the control; the row itself carries none of those words. A forced click changes nothing, because the hold is enforced when the click is handled too.
- **A change to a plugin's skill.** Nothing on the open folder can change it; the line under it sends the person to `Browse plugins`, where the plugin is updated or removed.
- **The registry read refuses.** The refusal is rendered with `Try again` at the right end of its line and no rows; nothing is invented and no partial list is drawn.

## Interfaces And Contracts

Described here; the shapes belong to [Plan-026](../plans/026-skills.md).

- **The daemon owns disk.** It watches the origins — the file origins at both scopes, and the plugin origin in its own plugin homes — parses each folder's `SKILL.md` itself, writes a folder, runs the scan the widening control renders, and builds each provider's session pack. **The console never writes a folder itself and never computes a pack**, so there is exactly one writer and exactly one place a pack is decided. The watch, the record beside a folder and the pack are the ones the agent definitions use ([Spec-026 §The definition registry](026-agent-definitions-and-peer-invocation.md#the-definition-registry)), extended for skills, never built a second time.
- **The daemon's operations are ten**, none of them built yet; each is a build gap its plan phase delivers:
  - `skill.list` — the read of the registry. It returns one entry per skill folder across the origins: its id (`skillId`), kept through a rename made in the app, its origin (and the plugin's name on a plugin's skill), its scope, its folder path, the name and description read from its front matter, the file list with each file's path and size and whether the daemon could read it, the availability record, the icon, the call form per provider the skill reaches, and the facts `orphaned`, `disabledInProvider` and `loadError` with its reason — each its own field, the same spellings the agent list uses. It is read when a screen opens.
  - `skill.subscribe` — the whole list again each time a save from any window or the daemon's watch over the origins changes it, so this screen and the composer's Skills group stay current in every open window.
  - `skill.fileRead` — one file's body, read when that file opens; the list carries paths and sizes only.
  - `skill.create` — a new folder under the console's own tree, global or project, its name folded and a collision suffixed, available on both providers. A name another folder of the console's own already packs under at the other place is warned of while it is typed, as [§The call form](#the-call-form) says, and the one Save writes.
  - `skill.update` — a whole-folder save: the front-matter fields, each file's body, the files added, renamed and removed, and the icon, applied together, for a folder of the console's own and for a provider's own folder in place. A refused write leaves the folder on disk exactly as it was. A path it cannot take is refused as `skill.path_refused`, naming the path, with the reason `escapes_folder`, `duplicate_path` or `names_entry_file`. A name that would rename a folder of the console's own onto a name another of its own holds in the same place is refused as `skill.name_taken`, naming that folder (`folderPath`), and nothing is renamed. A name another folder of the console's own already packs under at the other place is warned of while it is typed, as on `skill.create`, and the one Save writes.
  - `skill.callFormRead` — the name a skill of the console's own would be called by on each provider, read while its name is typed and before any save: it takes the typed name, the scope and its project, and the folder being edited, if any, and answers the call form per provider and the other folder of the console's own it collides with, one global and one project, with what that folder is called by once this one is saved, or none. The daemon derives both with the code that builds the session pack, so the rule lives once; it is a read that never refuses a name for the folder it collides with, and its request is refused only when malformed — a blank or overlong name, or a project scope without its project.
  - `skill.availabilityUpdate` — sets one provider on or off for a folder, with no lock, so a skill may be off everywhere; the daemon writes it through that provider's own per-session off switch.
  - `skill.scan` — takes a folder and the provider being widened onto and returns the files that named another provider's tools, the tool names as words, and for each tool what will happen instead on the target provider, in words, as a member of that tool's entry beside its name. It is a read with no durable effect; nothing is stored and nothing is cached across widenings.
  - `skill.recordReattach` — attaches an orphaned record to a folder, taking the token the platform's folder chooser returned, accepted only while the record is orphaned and refused otherwise with `skill.write_refused` (`reason: not_orphaned`).
  - `skill.recordDiscard` — drops an orphaned record.

  Every operation that writes refuses a plugin's skill with `skill.write_refused` (`reason: plugin_read_only`).

- **The console's own record per folder** holds exactly two fields — availability and icon — keyed to the folder, on every origin but a plugin's. When the folder is renamed or deleted outside the console, the record stays, marked orphaned with the last path the folder was known at.
- **The session pack** is composed per provider at launch from every skill available to that provider and is handed over through the provider's own loading path, namespaced. It is not a copy into a provider's tree. The session pack and the live refresh are the daemon's own work with the providers; no screen calls them.
- **The composer reads this registry.** The `/` and `$` list's Skills group is `skill.list`, kept current by `skill.subscribe`, the same entries this screen lists, name for name and line for line — one registry with two readers, never two registries. A skill only the other provider can run is left out of the list; the Skills page still lists both providers. A skill Codex failed to load stays listed and grayed, with its load error as the reason: the daemon matches each error in Codex's own `skills/list` to its row, and the composer draws the row as it is given.

## State And Data Implications

- **The folders on disk are the truth.** The registry is a projection of a filesystem watch; it is not events-canonical and is not rebuilt from the session event log.
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
- `Example: A person switches Claude Code off a skill that lives in Claude Code's own tree. The control reads as not pressed, the daemon writes Claude Code's own per-session skillOverrides switch for it, and nothing writes the folder or the person's own settings files.`
- `Example: A person types SKILL.md into the Add file row. The row answers in place with the reason that the folder always has exactly one entry file, nothing is added, and nothing else on the screen moves.`

## Implementation Notes

- The scan's per-provider vocabulary — tool names and call sigils — is the one part of this destination that ages with the providers. It belongs in one table, and its output is words rather than wire spellings so a rename upstream changes the table and not the screen. The scan works with whatever provider version is installed, and nothing is re-checked on a version bump: a tool a provider renamed shows as a scan miss in the daemon's logs and is investigated when seen.
- The daemon watching a root that does not exist yet is worth creating rather than skipping: on Claude Code a scope directory that did not exist when a session started is invisible for the life of that session unless the reload request is sent, so creating the roots before launch and sending the reload after a write is what makes a mid-session save reliable.
- Because the two providers' front matter overlaps on exactly the two keys the editor surfaces, the editor needs no per-provider mode. What a provider keeps for itself — the Codex metadata file — is an ordinary file in the Files list and needs no special case beyond being listed.
- The four addresses make each screen state linkable, which is also what makes each state reachable from a test without driving the interface to get there.

## Pitfalls To Avoid

- **Do not let the scan block a widening.** The scan is advice about a folder's contents, not a validator; a widening it cannot vet is still the person's decision, and a blocking scan would make an honest report into a refusal.
- **Do not scan the entry file alone.** A reference file is where a provider-specific instruction hides, and a scan that reads one file would report a clean folder that is not.
- **Do not store the widen warning.** It would then survive a narrowing, or survive an edit, and say something untrue about the folder as it is now.
- **Do not write anything of the console's into a provider's own files.** Both providers drop unknown front-matter keys silently, so a field written there is lost with no signal; that is what the console's own record is for.
- **Do not give the entry file its own address.** Two addresses for one screen state means two ways to be somewhere and one of them wrong after a rename.
- **Do not model a skill as a single text body.** Most useful skills carry more than one file, and a single-body editor cannot add, rename or delete one.
- **Do not add a "last used" figure.** A skill is read into every pack it is available to and may be followed without being named, so the figure would be wrong in the direction that matters.

## Acceptance Criteria

- [ ] The rail draws five destinations in the order Sessions, Sidekicks, Skills, Workflows, Settings, and on this screen Skills is marked current to assistive technology as well as drawn.
- [ ] The Skills rail item draws the open book at the rail's own weight, and no robot glyph appears on this screen for a skill.
- [ ] The header carries the title, the count, one search field, `Browse plugins` and `New skill`, and no view switch or tab set exists anywhere on the screen; `Browse plugins` opens `#/sidekicks/plugins`.
- [ ] Every row shows its origin mark, its folder path, its file count, its availability line and its call form.
- [ ] Rows order by folder name under `Intl.Collator`.
- [ ] Search matches the folder name, the summary line, the origin words and every file path inside the folder, case-folded substring; a search matching nothing says so and lists no rows.
- [ ] Availability defaults to both providers for a folder in the console's own tree and to the home provider alone for a folder in a provider's tree.
- [ ] One click widens a skill to the other provider, and the setting is observably changed before the scan reports.
- [ ] The scan reads every file in the folder, names the files it read another provider's tool names out of, warns in one line in place, and blocks nothing — no dialog opens and no row is removed.
- [ ] Tool names in the warning are words in sentence case, with no wire spelling.
- [ ] A folder whose files name no other provider's tools widens with no warning.
- [ ] Narrowing a skill back removes the setting and the warning together and leaves no state behind.
- [ ] Each provider's control switches a skill on or off with no lock, a provider's own skill off its own provider and a skill off everywhere included, written through that provider's own per-session off switch and never into a config file of the person's.
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
- [ ] The four addresses are the list, the new-skill form, a folder, and a folder with one other file open; a folder's address carries its `skillId` and keeps it through a rename made in the app; the entry file has no second address.
- [ ] `Cmd/Ctrl+S` saves; `Escape` closes an open in-place question first and leaves the folder otherwise; `/` reaches the search field; `Arrow Up` and `Arrow Down` move between rows; `Enter` opens the row in focus or applies the open question; leaving with changes asks and names every changed field by its label and every changed file by its path, with files added or removed named once as `Files`.
- [ ] No sentence on the screen begins with `You`; the screen says `sidekick` and never `agent`; no wire spelling appears beyond file names, paths and the provider's own call form, over every accessible name as well as every visible word; every control that draws only a glyph carries a word for a name.
- [ ] Every chrome size on the screen is root-relative and every text size and line height is a type-scale token, so the screen at a larger root is the same screen in one proportion; the folder's two columns fold to one under the narrow threshold, asked of the pane rather than the window.
- [ ] A file the daemon cannot read is listed with its size and no editor rather than omitted.
- [ ] A folder carries subfolders at any depth: any prefix is accepted, the list orders by whole path, and no depth is capped.
- [ ] The list draws its in-flight, refused and empty arms, each distinct from the others and from a populated list; in flight the loading note reads `Reading the skills on this machine…` and the count reads `—`.
- [ ] No row carries a "last used" line.
- [ ] A skill saved mid-session is live on Codex on its change notice and on Claude Code after the daemon's reload request.
- [ ] The session composer's skills group and this list show the same skills, name for name and line for line.
- [ ] The list holds every skill folder across the origins; a plugin's skill is marked `plugin · <plugin name>`, lists its folder under the daemon's plugin home, is available on the plugin's provider with neither control pressable, and opens with no control and the line `Installed by a plugin. Update or remove it in Browse plugins.`
- [ ] A row draws `Off in Claude Code` or `Off in Codex` while that provider switches the skill off and `Didn't load · <reason>` while its folder fails to load, each only while it holds and both when both hold, from the daemon's own parse.
- [ ] A skill whose folder was renamed or deleted outside the console is drawn in a `Folder gone` group after the rows with its icon, where it was available and its last path; `Reattach…` attaches the record to a folder picked in the platform's chooser, `Discard` drops it after asking in place, and nothing is dropped silently.
- [ ] A plugin's skill's call form reads `/<plugin name>:<skill name>` on Claude Code and `$<plugin name>:<skill name>` on Codex, always; a Claude Code skill packed for Codex reads `$claude:<name>` and a Codex skill packed for Claude Code `/codex:<name>`; only a skill made in the console reads `sidekicks:<name>`; of two folders of one origin sharing a name, the project one packs with `-2`.
- [ ] Editing the name of a folder of the console's own renames the folder; a name another of its own holds in the same place is refused under the name field as `skill.name_taken`, naming that folder, and nothing is renamed.
- [ ] The daemon serves the skill operations, and a write to a plugin's skill or a refused path answers with its typed refusal and changes nothing.
- [ ] A save in one window, and a folder changed on disk, reach the list and the composer's Skills group in every open window without a re-read.
- [ ] The composer's Skills group leaves out a skill only the other provider can run, and a skill Codex failed to load stays listed and grayed with its load error as the reason.

## Open Questions

None.

## References

- [Spec-004 §The provider command and skill surface](004-provider-driver-contract-and-capabilities.md#the-provider-command-and-skill-surface) — the driver's live per-binding read of a provider's own command-and-skill enumeration, which is the provider's answer about what it loaded, beside this spec's registry of what is on disk.
- [Spec-021 §The surface set](021-desktop-app-and-renderer.md#the-surface-set) — the icon rail and the console's surfaces this destination joins.
- [Spec-021 §Console Test Tiers](021-desktop-app-and-renderer.md#console-test-tiers) — the tiers a console change is proven by.
- [Spec-026](026-agent-definitions-and-peer-invocation.md) — the agent library beside this destination; a definition stays one file and every available skill reaches it through the pack. [Spec-026 §Browse plugins](026-agent-definitions-and-peer-invocation.md#browse-plugins) is where a plugin carrying skills is installed.
- [ADR-029](../decisions/029-five-rail-destinations.md) — the five rail destinations, their order, and the rule that sorts a future surface into a destination or a Settings page.
- [Claude wire reference §`system/init` command and skill enumeration](../reference/provider-wire/claude.md#systeminit-command-and-skill-enumeration--a-live-read-never-a-stored-registry) — Claude Code's own skill enumeration, names only, with no scope and no enabled axis.
- [Codex wire reference §`skills/*`](../reference/provider-wire/codex.md#skills--the-skill-surface) — Codex's skill surface: the grouped-per-directory read, the change notification, the required `description`, and the scope set.
- [Plan-026](../plans/026-skills.md) — the implementation plan for this spec.
- Codex's turn-input schema, read 2026-10-02 from `codex app-server generate-json-schema` at codex-cli `0.159.2`: `v2/TurnStartParams.json`'s `UserInput` has a `skill` variant, `{name, path}`, both required, beside `text`, `image`, `localImage`, `audio`, `localAudio` and `mention`.
- Provider measurements behind the front-matter and liveness rules above, taken 2026-09-13: Claude Code `2.1.270` reads the front matter it knows and drops unknown keys silently, folds custom commands into the skills registry, and picks up a written skill on a forced reload request in about 100 ms; codex-cli `0.154.0` (source tag `rust-v0.154.0`) parses `name`, `description` and `metadata.short-description`, ignores unknown keys, reads the optional `agents/openai.yaml` metadata file beside the entry file, has no custom slash commands, and pushes a change notification within about two seconds of a skill folder being written, after which the same live thread can invoke it.
