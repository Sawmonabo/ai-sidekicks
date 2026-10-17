# ADR-035: Claude Code Mods Are An Optional Terminal Bridge, Not The Daemon's Path

| Field         | Value                               |
| ------------- | ----------------------------------- |
| **Status**    | `accepted`                          |
| **Type**      | `Type 1 (two-way door)`             |
| **Domain**    | Provider Drivers, Session Messaging |
| **Date**      | 2026-09-21                          |
| **Author(s)** | Claude (AI-assisted)                |
| **Reviewers** | Sawmon Abo                          |

---

## Context

**What a Claude Code mod is.** A mod is a Claude Code plugin whose `hooks/hooks.json` names a TypeScript module (`{"modules": ["./register.ts"]}`) exporting `register(on, options)`. Each hook is a function `($, e, next)`: it receives one of the engine's events, can rewrite the event on the way in, rewrite the answer on the way out, answer the event itself, or refuse it. `$` is the engine's own interface, with nouns for tools, prompts, commands, turns, sessions, agents, the UI, models, files, a small store, HTTP, processes, the clock, settings and MCP; the published contract lists 92 events, from `tool.call` and `prompt.submit` through `session.compact`, `turn.step`, `ui.render` and `session.receive` (a peer's or a Remote Control delivery). Hooks nest by tier in registration order: an organization's `prepend` tier wraps the person's `user` tier, which wraps `append`, and the built-in `sec-default` mod sits outermost on managed machines to keep classic hooks, managed prompt content, settings reads and policy-provided tools out of a person's mods' reach. Anthropic calls the mechanism "function hooks" and the product "Claude Mods"; four mods ship inside the binary (`sec-default`, `diff`, `telemetry`, `agents-md`), with their source published.

**Its standing at Claude Code 2.1.300.** Mods are on by default in the terminal from Claude Code 2.1.287, which ignores `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` at any value; the official docs describe them in full (overview, reference, interface, API, test, troubleshoot and administration pages). What turns them off is the person's `disableAllHooks`, a start with `--safe-mode` or `--bare`, the managed settings `allowManagedModsOnly` and `allowManagedHooksOnly`, a refusal from an organization's policy mod, or Anthropic's own rollout switch served off, which turns installed mods off remotely. A mod runs in a hooks worker, a worker thread with shared buffers; a hook gets 10 seconds of its own execution time and is skipped past it, a mod that crashes the worker is unloaded, and after three untraced crashes every installed mod is unloaded until `/reload-plugins` or a new session. The contract file 2.1.300 writes still opens with "EARLY ACCESS: this surface may change between releases without notice.", and the docs' own per-version notes show the surface still moving. Codex has classic hooks and nothing like this.

**The daemon's path to the providers.** One long-lived Claude Code process per session and one Codex service per account ([ADR-031](031-one-claude-process-per-session-one-codex-service-per-account.md)). Claude Code is driven in print mode over the `stream-json` wire, with hooks the daemon registers for the session in its `initialize` request and answers over the wire (a `PreToolUse` deny, a `PostToolUse` hold, `additionalContext` on the events that carry it), its control requests (`can_use_tool`, `get_usage`, `apply_flag_settings`) and its own `--resume`. Codex is driven over its app-server protocol with `turn/steer`, `turn/interrupt` and `thread/resume`, and with the daemon's hooks as tool-hook rows on each conversation's `thread/start`. The daemon's own tools, the session tools among them, reach Claude Code and Codex on the daemon's one shared MCP tool server, `sidekicks`: Claude Code as an in-process server, Codex through one `url` entry per session. Every behavior the console design describes rests on these two published surfaces: the pause boundary, the daemon's own tools served to Claude Code and Codex, an account switch applied in place from the session's next request, limits reads that spend no turn ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior), [Spec-014](../specs/014-multi-agent-orchestration.md), [Spec-025 §Credential-home health observation](../specs/025-provider-accounts-and-credential-homes.md#credential-home-health-observation)).

**What was measured for this record, on this machine, on Claude Code 2.1.278 unless a row names another build.**

| Step | Command | Result |
| --- | --- | --- |
| Validate a three-hook module (`session.start`, `tool.call`, `turn.start`, each calling `$.fs.write`) | `claude plugin validate <plugin>` | passed; the validator names the hooks and the `$` calls |
| Run it headless | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (set for this 2.1.278 run; 2.1.287 and later ignore it) `claude -p '…read note.txt… reply with only the color…' --model haiku --no-session-persistence --plugin-dir <plugin> --allowedTools Read --max-turns 2 --output-format json` in a scratch folder | reply `green`, 2 turns, $0.029, 4.4 s |
| `session.start` | marker file written by the hook | `surface: null`, `isInteractive: false` |
| `tool.call` | marker file | saw `tool: "Read"` with `file_path` and `tool_use_id`; the answer carried `ref`, `result`, `text` |
| `turn.start` | marker file | `text`, `turnId` |
| Mods on by default (measured on Claude Code 2.1.300, in a throwaway home, never signed in) | A plugin whose `hooks/hooks.json` names a module with a `session.start` hook, installed through `claude plugin marketplace add` and `claude plugin install`, then `claude -p` with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` unset and no `env` in any settings file, and again with it set to `0` | the module loaded on Claude Code's built-in default and its `session.start` fired in both runs |
| What Claude Code's own plugin commands write (measured on Claude Code 2.1.300, in a throwaway home) | `claude plugin marketplace add <folder>`, `claude plugin install`, then `claude plugin uninstall` and `claude plugin marketplace remove` | `marketplace add` created `~/.claude/settings.json` with the marketplace under `extraKnownMarketplaces`, `install` added it under `enabledPlugins`, and the two removals emptied both keys, leaving `{"enabledPlugins":{},"extraKnownMarketplaces":{}}` where the file had held neither |

So modules load and fire under `-p`, with no surface and no person at the prompt, exactly as the contract states for `session.start` ("null for a `-p` run or the SDK"; "false for a `-p` run or the SDK"). A string in the binary, `Function hook reached executeHooksOutsideREPL` followed by `Function hooks should only be used in REPL context (Stop hooks)`, belongs to the classic hook runner's handling of `function`-typed hook entries and does not gate module loading.

**Two gaps mods were proposed for, checked.**

- _Steer._ A user message written on the `stream-json` wire while a turn runs is folded into the running turn; the CLI names the mechanism `absorbed_mid_turn`, measured on 2.1.269 on 2026-09-11, and the console design draws a message sent mid-turn as the transcript's last row until the agent takes it. The classic `PostToolUse` hook's `additionalContext` is a second channel that reaches the model mid-turn under `-p`. A mod would add a third (`tool.call`, appending to the answer's `text`, which the `cdx` mod uses for "context on the next tool result mid-turn"). No mod is needed for steer. The Claude driver declares `steer: true` and delivers a steer this way.
- _Compaction._ `session.compact` lets a mod rewrite or replace the messages compaction keeps, and the classic `PreCompact` hook exists too. `lcm`, cited as the mod that replaces compaction, is seven classic hooks and an MCP server by its own README, not a module. The console design keeps the provider's own `/compact` on Claude Code and Codex, which is the rule to use what the provider has before building beside it.

## Problem Statement

Should any part of the daemon's control path to Claude Code be built on mods, and where, if anywhere, does a mod belong in this product?

### Trigger

A community list of mods, and proposals for a mod for compaction, a mod for steer and a Sidekicks pane inside Claude Code, set against the console design's messaging, accounts and provider switching.

---

## Decision

**The daemon's path to Claude Code stays the published headless surface, the same shape as its Codex path; mods enter the product in one place only, an optional plugin that runs inside a person's terminal Claude Code sessions to reach the daemon, shipped after the daemon's own messaging, working with whatever Claude Code is installed, and never required: each behavior it adds has a daemon-side method that stands without it and stays documented, and the one thing it draws is a look-only view of what the desktop already shows, whose one control opens a session in the app.**

The optional plugin, the terminal bridge, has hooks and one look-only pane:

1. On `session.start` it gives the terminal Claude Code session its own entry for the daemon's shared `sidekicks` tool server, so the session holds the same session tools a hosted Claude Code session holds — every one but `session_remind`, which is Codex's alone, Claude Code keeping its own `ScheduleWakeup` — under the same rules text as the connection's instructions ([Spec-014 §Session Tool Texts](../specs/014-multi-agent-orchestration.md#session-tool-texts)). The daemon mints that entry only to a caller that passes the second socket's caller check, and the entry carries no more standing than a hosted session's. The terminal session lists the daemon's sessions and messages one by name or id, and the daemon draws the row on the receiving session as it does for any message. A call the terminal session's model makes there is an ordinary tool call under that session's own permission mode, with no gate of the app's own, and what the message causes follows the receiving session's own level. The plugin itself calls no session tool: a call a mod makes on its own raises no permission prompt, so it would step outside that mode. **Method without the plugin:** the receiving session's own address, offered as `Copy address` in the console's inspector; a terminal session that writes to it reaches the session as Claude Code's own peer delivery, which the daemon reads off the session's stream and draws as the same row.
2. On `session.receive` with origin `peer` it hands a delivery the daemon did not send to the daemon first, over the daemon's second socket, so it is registered and drawn before the model reads it. The hand-off is a hint: its row is drawn once it matches the peer frame the daemon reads off the receiving session's stream, and a hand-off that matches nothing draws nothing, so no caller can draw a message that never arrived. **Method without the plugin:** the daemon reads the peer frame off the stream, as above; the message is drawn a moment later rather than before delivery, and nothing is lost.
3. It registers the command `/sidekicks`, which opens a look-only Sidekicks pane in the terminal session (`$.ui.open({ id: "sidekicks", title: "Sidekicks" })`) and closes it on a second press. The pane draws one row per session of the daemon (its title, its provider, and its state in the words the desktop's sessions list uses), under each session its agents (name, a mark of the provider running it, and its state), and one last row with Remote Control's state. Each session row carries one control, an `Open in app` button, which runs `sidekicks open` with that session's address through `$.process.run`, so the app opens on that session; it is a button because a `Link` takes no keyboard focus, and a button is what the keyboard and screen reader mode reach. The address carries only the session id, and the app treats it as untrusted input from any program, parsed in its main process and only navigated to, a session its list lacks reading `That session is not here.`, so the button adds no trust boundary. A run that fails, for want of the `sidekicks` command on the `PATH` Claude Code sees or under a policy mod that refuses `process.run`, reads one line on the row: `Couldn't open the app: <the command's reason>`. Nothing else on the pane is a control: sending, stopping and approving stay in the app, under its approval card and stop control, or with the terminal session, which holds the session tools through the bridge. It reads the daemon over the same socket as the hooks, the daemon's second socket, which serves the plugin over HTTP and nothing else and is guarded as the daemon's own socket is: it makes the daemon socket's caller check, with the same exceptions, and takes the daemon token as `Authorization: Bearer <token>` on every request, which the plugin reads with `$.fs.read` from the run folder it finds with `$.env.get`, reading it again after a `401` ([Security Architecture §Local Daemon Authentication](../architecture/security-architecture.md#local-daemon-authentication)); in a WSL 2 distribution the WSL server's bridge socket does the same with its caller check, and on Windows, where no documented call names an AF_UNIX peer, the socket is guarded by the token and its access list until the probe owed before unit `windows` settles the check ([Windows Service Probes](../operations/windows-service-probes.md) P53). Its one held read is `session.overview.read {afterRevision}`, which the daemon answers as soon as its sessions list or any session's agent list moves past `afterRevision`, or after 10 seconds with nothing changed, with `{revision, sessions: [{id, title, provider, state, agents: [{name, provider, state}]}], remoteControl: {state}}` built from the projections behind `session.subscribe` and `agent.subscribe`, never from a second store. On each answer the plugin redraws and sends the next held read; no timer runs, because `$.http.fetch` resolves only once a body has been read and cannot stream, so a held read is the event-driven form that API allows, and the 10-second hold sits inside the 30 seconds Claude Code gives each fetch. The socket's path is absolute and under 100 bytes: a mod's fetch refuses a relative `socketPath`, the contract caps it near 100 bytes, and the daemon's own bind on macOS takes no more than 104. With the daemon unreachable the pane shows one line, `The Sidekicks app is not running.`, and tries again 10 seconds later. Where it draws is Claude Code's own placement: docked beside the transcript in full-screen mode, inline above the prompt on the main screen, drawn from 110 columns once asked for; it draws only in interactive sessions, never under `-p`. It stores nothing. Budget, for one open pane on a daemon with 10 sessions: one held request in flight, at most 6 a minute while nothing changes, each answer under 4 KB, and no work while the pane is closed. **Method without the plugin:** the desktop's own sessions list and agent tree, which the pane only mirrors. `session.overview.read` is an ordinary daemon read that does not depend on mods; it is built with the bridge plugin, after the daemon's session list and agent list projections.

**The switch that puts the bridge into a person's terminal Claude Code.** Claude Code's settings on the desktop carry `Use Sidekicks in terminal Claude Code`, off by default. Turning it on runs Claude Code's own `claude plugin marketplace add` over the plugin folder the app ships and `claude plugin install`; turning it off runs Claude Code's own `claude plugin uninstall` and `claude plugin marketplace remove`; both go through `provider.terminalPlugin.update {provider, place?, enabled}`, one switch per place where Claude Code is installed on a Windows computer with a WSL 2 distribution, and while they run the switch reads `Installing…` or `Removing…` beside it, and a failure reads `Couldn't install the plugin: <Claude Code's reason>` or `Couldn't remove the plugin: <Claude Code's reason>` with `Try again`, the switch going back to where it was. Claude Code's own commands write its settings file, `extraKnownMarketplaces` and `enabledPlugins` in `~/.claude/settings.json`; the app writes nothing there and sets no `env` key. It touches only what it added: the marketplace entry and the plugin, by their own names. Every other setting, plugin and marketplace the person has stays exactly as it was, and turning the switch off removes nothing the person added; Claude Code's own removal leaves its two keys emptied, `{"enabledPlugins":{},"extraKnownMarketplaces":{}}` where the file had held neither. The plugin loads wherever Claude Code runs mods, which it does by default; without the switch or without the plugin, nothing is drawn and nothing else changes.

**The reply path the address method rests on, and what Windows changes.** The address works both ways, and neither direction depends on the plugin. The daemon delivers into a terminal Claude Code session on the address that provider's own live-session registry gives — the per-process file it writes under its configuration folder while a session runs — and it reads that session's answer off the session's own record rather than expecting the provider to route one back, because it routes none: the daemon's own stream for a session this product started, and for a session the person typed in a terminal the provider's own transcript file, whose path the same registry entry gives, read only from the daemon's own message onward and paired to it by the message id the provider records on the reply, lines landing within a quarter second of the moment they carry ([claude.md §A reply comes back when the message asks for one, and the transcript pairs it to its prompt](../reference/provider-wire/claude.md#a-reply-comes-back-when-the-message-asks-for-one-and-the-transcript-pairs-it-to-its-prompt)). Nothing is added to the message to ask for a reply and nothing is asked of the person's terminal, so what is drawn is what that session actually said; `not delivered` is the registry entry's status turning idle with no record of the message ([claude.md §A message from another session arrives on the session's own address](../reference/provider-wire/claude.md#a-message-from-another-session-arrives-on-the-sessions-own-address)). The daemon's own inbox, in Claude Code's own socket folder, is the `from` on every delivery and the frame's `from-session` names the sending session by its id, so a far model that chooses to send back reaches the daemon naming the session it answers, and that send is drawn once, and a message the receiver's inbox drops is reported back to it as a `peer_message_status` frame, which Claude Code sends only to a `from` inside that folder ([provider-wire reference, claude.md §A message from another session arrives on the session's own address](../reference/provider-wire/claude.md#a-message-from-another-session-arrives-on-the-sessions-own-address)). **Windows changes the address object and nothing else**: the provider's inbox is a Unix domain socket on macOS and Linux and a named pipe on native Windows, which its own documentation puts at `2.1.234` or later there, and the daemon's inbox on that platform is a named pipe too — so delivery, the address offered as `Copy address`, and the hook rule that keeps a send on the one path all read the same on every platform, with a `\\.\pipe\` name standing where a socket path stands. Windows is unmeasured; the messaging work measures it before it ships on Windows.

Not chosen: any mod in the driver's own path (compaction, steer, permissions), which stays on the published surface.

### Thesis — Why This Option

- **One shape for every provider.** The daemon serves Claude Code and Codex through what each publishes; a mod exists on Claude Code alone, and building the core on it would leave Codex on a different path or the product tied to one vendor's beta.
- **Everything the design asked for is already reachable.** Steer, pause, permissions, limits, resume and messaging are measured on the published surfaces of Claude Code and Codex. The one thing no daemon-side method does well is reaching a session from inside someone's terminal Claude Code by name, and that is where the plugin goes.
- **The plugin is additive by construction.** It registers its tools, forwards one event and draws one look-only pane from an ordinary daemon read; nothing in the daemon imports it or waits for it. With mods off, the plugin invalid, or the contract changed, the terminal session behaves as Claude Code does on its own, the address path stands, and the desktop still shows everything the pane would.
- **It is measured, not assumed.** The contract and a live run agree that modules load headless and see the events named; the validator reports what a module hooks before any session loads it. The plugin works with whatever Claude Code is installed, and nothing is re-checked on a version or pin bump; a change that breaks it shows in the daemon's logs and is investigated when seen.

### Antithesis — The Strongest Case Against

- A mod sees every engine event, more than the wire ever will; a daemon that read the engine through a mod could show more and fake less (compaction, the exact tool arguments before permission, the model's own turn steps).
- Mods are on by default and documented; building on them now puts the product ahead rather than behind.
- One worker thread per plugin is cheap, and the built-in `diff` and `agents-md` mods show the API carrying real product features.

### Synthesis — Why It Still Holds

- The wire is enough for what the design asks, and the design is the contract. Where the wire is thinner than the engine, the difference is compaction detail the product does not draw and turn steps the transcript already streams.
- On by default is not stable. The contract still says it changes without notice and the docs' per-version notes show it moving; a person's `disableAllHooks`, an organization's managed settings or policy mod, or Anthropic's remote rollout switch turns mods off; `sec-default` can refuse a user-tier `tool.register` on managed machines; and Codex is untouched by any of it. A core that depends on it would be one switch from broken, on one provider.
- Cheap is not the question; ownership is. A behavior the daemon owns on every provider is kept once; a behavior inside one vendor's plugin runtime is kept for as long as that runtime keeps its shape. The bridge is worth that upkeep because it is small and optional; the core is not.

---

## Alternatives Considered

### Option A: Published surface for the core; one optional terminal bridge plugin with a daemon-side method under each hook (Chosen)

- **What:** As decided above: the hooks, the look-only `/sidekicks` pane with `Open in app` on each session row, and the settings switch that installs and removes them through Claude Code's own commands.
- **Steel man:** Every provider on one shape; the single real gap filled by the single tool that fills it well; nothing to undo if the plugin runtime moves.
- **Weaknesses:** Two ways to reach a hosted session from a terminal, one of them better; the plugin's tests run against a moving contract; on managed machines the organization may withhold `tool.register` and the plugin silently offers less.

### Option B: Build the Claude driver's control path on a mod (compaction through `session.compact`, steer through `tool.call` answers, permissions through `tool.call` deny) (Rejected)

- **What:** Register the daemon as a mod in every hosted Claude Code session and drive it through `$`.
- **Steel man:** The richest possible view of the engine, ahead of the wire, with Anthropic's own typed contract.
- **Why rejected:** Claude-only; turned off by a person's `disableAllHooks`, by an organization's policy or by Anthropic's remote rollout switch; a contract that says it may change without notice; and every behavior it would replace is measured on the published surface already (steer folded mid-turn, `PostToolUse` context, `can_use_tool`, the provider's own `/compact`). It also duplicates the classic hooks the daemon already registers.

### Option C: A look-only Sidekicks pane inside terminal Claude Code (Chosen, as part of Option A)

- **What:** A mod drawing the daemon's sessions, their agents and Remote Control's state beside a terminal transcript through `$.ui`, opened with `/sidekicks` and redrawn from one held daemon read.
- **Steel man:** Reaches people who never open the desktop app; the `diff` mod shows a pane of this kind is what the API is for.
- **Weaknesses:** The UI half of the contract is the part most likely to move: the contract file still says "EARLY ACCESS" and the docs' per-version notes show it moving. Accepted because the pane is optional behind the same switch as the rest of the bridge, a contract change that breaks it shows in the daemon's logs and is investigated when seen, and the pane can leave the plugin's next release while the hooks stay.

### Option D: No plugin anywhere; `Copy address` and the stream-side peer frame only (Kept as the standing method, not chosen alone)

- **What:** A terminal session reaches a hosted session only by pasting its address.
- **Steel man:** Zero dependency on the plugin runtime; nothing that a change to that runtime can break.
- **Why not alone:** A terminal Claude Code cannot see the daemon's sessions by name, so messaging from a terminal stays a copy-and-paste act. This option is exactly what stands when the plugin is absent, so it is documented as the method under each hook rather than rejected.

### Option E: Write each hosted session's entry into the person's own Claude Code sessions folder so terminal sessions list them by name (Rejected)

- **What:** The daemon copies a session's true entry into `~/.claude/sessions/` while it runs.
- **Steel man:** Names appear in the terminal's own list with no plugin at all.
- **Why rejected:** The app writes nothing into the person's own provider home: the terminal switch runs Claude Code's own plugin commands, which write their own entries, and Claude Code's identity checks on a session entry written by another program are unmeasured.

---

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | A hooks module loads and fires in a terminal Claude Code session wherever Claude Code runs mods, and `$.tool.register` on `session.start` lists the tools by turn one. | The contract's `session.start` note ("The first is awaited: a `$.tool.register` is listed by turn one"), and measured on this machine on 2026-09-21 at 2.1.278: a tool registered on `session.start` was in the `init` tool list by turn one, the model called it and the module's own hook answered. | The bridge offers the tools a turn late; the address method stands. |
| 2 | A hooks module can reach the daemon's second socket, the plugin's HTTP socket, through `$.process.run` or `$.http.fetch`. | Measured on this machine on 2026-09-21 at 2.1.278: `$.http.fetch(url, { socketPath })` reached a Unix socket and answered `200`, and `$.process.run` of `curl --unix-socket` worked as the fallback. On 2.1.300 a relative `socketPath` is refused (`takes an absolute path`), an absolute 127-byte path reached its socket, and the contract caps the path near 100 bytes, so the daemon keeps it absolute and under 100 bytes, inside the 104 bytes its own bind takes on macOS. | The bridge shells out to the `sidekicks` command instead; if neither works the plugin is not shipped and Option D stands. |
| 3 | Both directions of a message between a hosted session and a terminal Claude Code session are readable by the daemon without the plugin: a peer delivery reaches the hosted session as a user frame on its stream, and a terminal session's reply is read off that session's own transcript file, paired to the daemon's message by the message id the provider records, with no instruction line added to the message. | Observed on the Claude stream during the September messaging probes: a user frame with `origin.kind = "peer"`; measured on 2.1.278 on 2026-09-21, the transcript record of a peer message carries `origin.kind: "peer"` and the inbound `msg_id`, the chain to the reply is unbroken by `parentUuid`, and lines land on disk 63–226 ms after the time they carry ([claude.md §A reply comes back when the message asks for one, and the transcript pairs it to its prompt](../reference/provider-wire/claude.md#a-reply-comes-back-when-the-message-asks-for-one-and-the-transcript-pairs-it-to-its-prompt)). | The receiving row would be missing until the model's reply reveals it, or a terminal session's reply would go unread; the bridge's second hook then becomes the only path and the plugin stops being optional. |
| 4 | Mods can be off (a person's `disableAllHooks`, `--safe-mode` or `--bare`, the managed `allowManagedModsOnly` or `allowManagedHooksOnly`, an organization's policy mod, or Anthropic's rollout switch served off), or a managed machine's `sec-default` can withhold `tool.register` from the user tier. | The mods overview's "Turn mods on or off" and the troubleshooting page's refusal messages, and `sec-default`'s published README row for `tool.register`. | Nothing: this is the case the daemon-side method exists for. |
| 5 | The contract may change between releases. | Its own header line. | A change that breaks the plugin shows in the daemon's logs and is investigated when seen; the plugin is fixed or withdrawn while the core is untouched. |

---

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| The contract changes and the module no longer validates or fires. | High | Low | A module that no longer loads or fires shows in the daemon's logs, naming the hook, and is investigated when seen. | Fix or withdraw the plugin; the daemon-side method under each hook is the product's behavior meanwhile. |
| Mods are off on the person's machine: `disableAllHooks`, a managed setting or policy mod, or Anthropic's rollout switch served off. | High | Low | `session.start` never fires, so the bridge's tools are absent from the session's tool list. | The address method; the console's inspector offers `Copy address` regardless. |
| A managed machine's `sec-default` refuses the user-tier `tool.register`. | Medium on Team and Enterprise | Low | The registration returns the refusal by name; the bridge logs it once. | The address method. |
| The worker crashes and the plugin is unloaded mid-session. | Low | Low | The tools disappear from the session's tool list. | The address method for the rest of that session. |
| Another process of the person's, or a command a session runs, calls the daemon's second socket to mint a tool-server entry or draw a message. | Medium | Medium | The caller check refuses a caller in the daemon's tree with `auth.callerRefused`, and a request without the token is answered `401`. | The second socket makes the daemon socket's caller check, with its exceptions, and takes the daemon token as `Authorization: Bearer <token>`; a minted entry carries no more standing than a hosted session's; a peer hand-off draws a row only once it matches the peer frame read off the receiving session's stream. On Windows the token and the socket's access list guard it until P53 settles how its caller is read. |
| The path of the daemon's second socket is relative or reaches 100 bytes. | Medium on a deep run directory | Low | The plugin's first `$.http.fetch` is refused at `session.start`; the daemon refuses to bind a path past 104 bytes on macOS with a plain error. | The daemon keeps its socket path absolute and under 100 bytes; the plugin falls back to the address method. |
| An organization's policy refuses web fetch, which refuses every mod's `$.http.fetch`. | Medium on Team and Enterprise | Low | The held read fails, so the pane reads `The Sidekicks app is not running.` while the daemon runs; whether a `socketPath` request counts is unmeasured. | The desktop's own sessions list and agent tree; the session tools and the address method are untouched. |
| An organization's `strictKnownMarketplaces` lacks the directory source, so `claude plugin marketplace add` refuses the plugin folder. | Low | Low | The switch's run fails with Claude Code's own reason. | The switch shows that failure with the reason and stays off; the address method stands. |
| `Open in app` cannot run `sidekicks open`: the command is not on the `PATH` Claude Code sees, or a policy mod refuses `process.run`. | Medium | Low | The run's own error. | The row reads `Couldn't open the app: <the command's reason>`; the person opens the app themselves. |
| Someone builds a daemon behavior that only works with the plugin loaded. | Medium over time | High | Review against this record: no crate under `crates/` names the plugin's folder, through `include_str!`, `include_bytes!` or a path, held in review with no checker. | Refuse in review; the plugin reaches the daemon only over the daemon's second socket, through its hooks' calls and the held read, and no daemon behavior waits on the plugin. |
| The contract's UI half changes and the pane no longer draws. | High | Low | A pane that no longer draws shows in the daemon's logs and is investigated when seen. | The pane leaves the plugin's next release and the hooks stay; the desktop shows the same sessions and agents. |
| Turning the terminal switch off removes something the person set themselves. | Low | Medium | The switch's own tests: every setting, plugin and marketplace the switch did not add reads the same before on and after off, and its own two keys are left as Claude Code's removal empties them. | The switch runs only Claude Code's own `claude plugin uninstall` and `claude plugin marketplace remove`, naming its own plugin and marketplace; the app writes nothing to the settings file. |

## Reversibility Assessment

- **Reversal cost:** Hours. Delete the plugin folder, its build unit and the settings switch; no daemon code references the plugin, and `session.overview.read` stays an ordinary daemon read or is deleted with it.
- **Blast radius:** Terminal Claude Code sessions lose the by-name tools and the pane and fall back to the address method. Nothing else changes.
- **Migration path:** None needed; the daemon-side methods are already the documented behavior.
- **Point of no return:** None. It would appear the day a daemon behavior required the plugin, which the failure-mode row above exists to prevent.

## Consequences

### Positive

- One shape for every provider, on surfaces each vendor publishes and documents.
- Terminal Claude Code sessions reach the daemon's sessions by name where the plugin loads, and by address everywhere else.
- A plugin that stops working shows in the daemon's logs while every behavior keeps its daemon-side method.

### Negative (accepted trade-offs)

- Two documented ways to do one thing, the plugin's and the address's; accepted because the second is what stands when the first cannot load.
- A small plugin kept against a moving contract; accepted because it is optional and its check is cheap.

### Unknowns

- Whether Anthropic keeps `socketPath` on `$.http.fetch`, which reaches the daemon's second socket, once the contract drops its early-access line; the bridge unit keeps `$.process.run` as its fallback.
- Whether `tool.register` stays open to user-tier plugins by default.
- Whether an organization's web-fetch policy refuses a `socketPath` request as it refuses a network one.
- Whether `sidekicks open` run from the pane opens the app on the session; no app was reachable from the probe's throwaway home.
- The pane drawn in a real interactive terminal; the probes ran headless, where modules load but no pane draws, so a live interactive run is the build's check.
- Windows, where no run behind this record took place.

---

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| The headless probe above and `claude plugin validate` pass on the installed Claude Code | Green | Run the two commands in the table above | When the bridge unit lands |
| A terminal Claude Code session with the plugin lists the daemon's sessions and a message lands as a row on the target | Both true | Manual run against a live daemon | When the bridge unit lands |
| The same terminal session with mods off still reaches a hosted session by its address and the row is drawn from the stream | True | Manual run with `disableAllHooks` set | When the bridge unit lands |
| `/sidekicks` opens the pane, a change on the daemon redraws it without a keypress, and `Open in app` opens the app on that session from the keyboard | True | Manual interactive run against a live daemon with 10 sessions, counting held reads and answer sizes against the budget in §Decision | When the bridge unit lands |
| The terminal switch turned on and then off leaves every setting, plugin and marketplace it did not add as it was, and the app writes nothing to the settings file | Unchanged, but for `enabledPlugins` and `extraKnownMarketplaces` as Claude Code's removal empties them | Diff of `~/.claude/settings.json` and the plugin and marketplace lists before on and after off | When the switch lands |
| Daemon code paths that name or wait on the plugin | Zero | Review against this record: no crate under `crates/` names the plugin's folder, through `include_str!`, `include_bytes!` or a path | Every change |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Installed Claude Code 2.1.300 binary, strings | Primary research | The rollout check reads only the flag `tengu_plugin_hooks_modules`, on by default; `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` survives only in pass-through name lists; `$.http.fetch` forwards `socketPath` | `~/.local/share/claude/versions/2.1.300` |
| Function hooks type contract, written by Claude Code 2.1.277 | Documentation | 92 events; `session.start` carries `surface: null` and `isInteractive: false` for a `-p` run or the SDK; `tool.call` may deny or answer; `session.compact` may rewrite or skip; `session.receive` carries origin `peer`; "EARLY ACCESS: this surface may change between releases without notice" | https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts, read 2026-09-21 |
| Built-in mods and their README | Documentation | Four mods ship in the binary with source; `claude --plugin-dir` loads one from source; `claude plugin test` runs a mod's tests against the engine's own `$` | https://github.com/anthropics/claude-code/tree/main/mods, read 2026-09-21 |
| `sec-default` README | Documentation | The outermost mod on managed machines; refuses a user-tier `tool.register` while managed settings hold `allowedMcpServers`; continues past the user tier for classic hooks, managed prompt content and settings reads | https://github.com/anthropics/claude-code/blob/main/mods/sec-default/README.md, read 2026-09-21 |
| Mods overview | Documentation | "Mods are on by default. In the terminal, use Claude Code v2.1.287 or later"; v2.1.287 and later ignores `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`, so `0` does not keep mods off; what turns mods off | https://code.claude.com/docs/en/plugins/mods/overview |
| Mods reference and interface pages | Documentation | The pane's elements, focus and keys (a pane takes keyboard focus; Tab moves between controls and Enter presses); redraws on `$.ui.invalidate`; 30 seconds and 4 MiB per fetch; `socketPath` absolute, near 100 bytes at most | https://code.claude.com/docs/en/plugins/mods/reference and https://code.claude.com/docs/en/plugins/mods/interface |
| Manage mods for your organization, and troubleshooting | Documentation | An organization's policy that refuses WebFetch refuses every mod's `$.http.fetch`; a policy mod can refuse `process.run`; the rollout switch served off turns installed mods off remotely; a hook's 10-second budget and the worker's crash rules | https://code.claude.com/docs/en/plugins/mods/admin and https://code.claude.com/docs/en/plugins/mods/troubleshoot |
| Plugin commands reference | Documentation | `marketplace add` and `install` write the user settings file by default; `uninstall` and `marketplace remove` take them out again | https://code.claude.com/docs/en/plugins/cli-reference |
| Community list of mods | Community discussion | The catalog the mod proposals drew from; entries are plugin manifests, not all of them modules | https://github.com/karanb192/awesome-claude-code-mods, read 2026-09-21 |
| `lcm` README | Community discussion | Seven classic hooks (`PreCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `PostToolUse`, `PostToolUseFailure`) plus an MCP server; not a hooks module | https://github.com/lossless-claude/lcm, read 2026-09-21 |
| `cdx` README | Community discussion | A hooks module registering 21 tools on `session.start`, talking to its CLI through `$.process.run`, adding context on the next tool result mid-turn, and running headless with `surface === null` | https://github.com/RedesignedRobot/cdx, read 2026-09-21 |
| Headless module probe | Primary research | The table in Context: validation passed; `session.start`, `tool.call` and `turn.start` fired under `-p` | This record, 2026-09-21 |
| Headless bridge probe | Primary research | A tool registered on `session.start` was listed by turn one and served by the module; `$.http.fetch(url, { socketPath })` reached a Unix socket; under the daemon's stream-json wire the module's `tool.call` hook ran before the `can_use_tool` request left the process | This record, 2026-09-21 |
| Mods default and plugin-commands probe, Claude Code 2.1.300 | Primary research | The two 2.1.300 rows in Context: a mod loaded with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` unset and set to `0`; Claude Code's own install and removal commands write and empty `extraKnownMarketplaces` and `enabledPlugins` | This record, throwaway homes |
| Pane probe, Claude Code 2.1.300 | Primary research | A pane takes buttons, a text field and a dropdown and redraws live; a button press ran a process in 5 ms; a `Link` took no keyboard focus; a relative `socketPath` was refused and an absolute 127-byte one reached its socket; the pane docked from 110 columns; another installed mod can answer a pane's press in its place | This record, throwaway homes, never signed in |
| Mid-turn delivery probe on 2.1.269 | Primary research | A `stream-json` user message written mid-turn is consumed into the running turn under the reason `absorbed_mid_turn` | Measured on this machine 2026-09-11; carried into [Spec-003 §Driver-Level Steer Mechanics](../specs/003-queue-steer-pause-resume.md#driver-level-steer-mechanics) |

### Related ADRs

- [ADR-031: One Claude Code Process Per Session, One Codex Service Per Account](031-one-claude-process-per-session-one-codex-service-per-account.md) — the process the daemon drives and the wire it drives it on; this record keeps that path and adds nothing inside the process.
