# ADR-037: Claude Code Mods Are An Optional Terminal Bridge, Not The Daemon's Path

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

**Its standing on 2026-09-21.** Early access. User modules load only when `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is set or the rollout flag `tengu_plugin_hooks_modules` (default off) is on, and never where policy disables hooks. Each plugin runs in its own hooks worker, a worker thread with shared buffers (the binary logs "hooks worker spawned (one for every plugin)"); a plugin that crashes its worker is unloaded, one that overruns is flagged runaway. The contract file opens with "EARLY ACCESS: this surface may change between releases without notice." The hooks and plugins reference pages of the official docs do not mention modules. The proposal issue's community update of 2026-09-09 says "We're shipping in N weeks." Codex has classic hooks and nothing like this.

**The daemon's path to the providers today.** One long-lived provider process per session ([ADR-033](033-one-claude-process-per-session-one-codex-service-per-account.md)). Claude Code is driven in print mode over the `stream-json` wire, with the provider's classic settings hooks (a `PreToolUse` deny, a `PostToolUse` hold, `additionalContext` on the events that carry it), its control requests (`can_use_tool`, `get_usage`, in-process tool servers over `mcp_message`) and its own `--resume`. Codex is driven over its app-server protocol with dynamic tools, `turn/steer`, `turn/interrupt` and `thread/resume`. Every behaviour the console design settled in September rests on these two published surfaces: the pause boundary, one messaging tool served to both providers, account moves by copy and native resume, limits reads that spend no turn ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior), [Spec-014](../specs/014-multi-agent-channels-and-orchestration.md), [Spec-026 §Credential-home health observation](../specs/026-provider-accounts-and-credential-homes.md#credential-home-health-observation)).

**What was measured for this record, on this machine, 2026-09-21, Claude Code 2.1.278.**

| Step | Command | Result |
| --- | --- | --- |
| Validate a three-hook module (`session.start`, `tool.call`, `turn.start`, each calling `$.fs.write`) | `claude plugin validate <plugin>` | passed; the validator names the hooks and the `$` calls |
| Run it headless | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p '…read note.txt… reply with only the colour…' --model haiku --no-session-persistence --plugin-dir <plugin> --allowedTools Read --max-turns 2 --output-format json` in a scratch folder | reply `green`, 2 turns, $0.029, 4.4 s |
| `session.start` | marker file written by the hook | `surface: null`, `isInteractive: false` |
| `tool.call` | marker file | saw `tool: "Read"` with `file_path` and `tool_use_id`; the answer carried `ref`, `result`, `text` |
| `turn.start` | marker file | `text`, `turnId` |

So modules load and fire under `-p`, with no surface and no person at the prompt, exactly as the contract states for `session.start` ("null for a `-p` run or the SDK"; "false for a `-p` run or the SDK"). A string in the binary, `Function hook reached executeHooksOutsideREPL` followed by `Function hooks should only be used in REPL context (Stop hooks)`, belongs to the classic hook runner's handling of `function`-typed hook entries and does not gate module loading; a reading that took it as "mods are REPL only" was wrong.

**Two gaps a parallel investigation proposed mods for, checked.**

- _Steer._ A user message written on the `stream-json` wire while a turn runs is folded into the running turn; the CLI names the mechanism `absorbed_mid_turn`, measured on 2.1.269 on 2026-09-11, and the console design draws a message sent mid-turn as the transcript's last row until the agent takes it. The classic `PostToolUse` hook's `additionalContext` is a second channel that reaches the model mid-turn under `-p`. A mod would add a third (`tool.call`, appending to the answer's `text`, which the `cdx` mod uses for "context on the next tool result mid-turn"). No mod is needed for steer. The Claude driver's capability table still declares `steer: false` with a comment that no mid-turn injection exists; that comment predates the probe and is stale.
- _Compaction._ `session.compact` lets a mod rewrite or replace the messages compaction keeps, and the classic `PreCompact` hook exists too. `lcm`, cited as the mod that replaces compaction, is seven classic hooks and an MCP server by its own README, not a module. The console design keeps the provider's own `/compact` on both providers, which is the rule to use what the provider has before building beside it.

## Problem Statement

Should any part of the daemon's control path to Claude Code be built on mods, and where, if anywhere, does a mod belong in this product?

### Trigger

A community list of mods and a parallel investigation proposing a mod for compaction, a mod for steer and a Sidekicks pane inside Claude Code, arriving while the console design that settles messaging, accounts and provider switching was being carried into the specs.

---

## Decision

**The daemon's path to Claude Code stays the published headless surface, the same shape as its Codex path; mods enter the product in one place only, an optional plugin that runs inside a person's terminal Claude Code sessions to reach the daemon, shipped after the daemon's own messaging, tested on every Claude Code pin, and never required: each behaviour it adds has a daemon-side method that stands without it and stays documented.**

The optional plugin, the terminal bridge, has two hooks:

1. On `session.start` it registers `SendToSession` and `ListSessions` with `$.tool.register`, answered against the daemon's local socket, so a terminal Claude Code session lists the daemon's sessions and messages one by name, and the daemon draws the row on the receiving session as it does for any message. **Method without the plugin:** the receiving session's own address, offered as `Copy address` in the console's inspector; a terminal session that writes to it reaches the session as Claude Code's own peer delivery, which the daemon reads off the session's stream and draws as the same row.
2. On `session.receive` with origin `peer` it hands a delivery the daemon did not send to the daemon first, so it is registered and drawn before the model reads it. **Method without the plugin:** the daemon reads the peer frame off the stream, as above; the message is drawn a moment later rather than before delivery, and nothing is lost.

**The reply path the address method rests on, and what Windows changes.** The address works both ways, and neither direction depends on the plugin. The daemon delivers into a terminal Claude Code session on the address that provider's own live-session registry gives — the per-process file it writes under its configuration folder while a session runs — and it reads that session's answer off the session's own record rather than expecting the provider to route one back, because it routes none: the daemon's own stream for a session this product started, and for a session the person typed in a terminal the provider's own transcript file, whose path the same registry entry gives, read only from the daemon's own message onward and paired to it by the message id the provider records on the reply, lines landing within a quarter second of the moment they carry ([claude.md §A reply comes back when the message asks for one, and the transcript pairs it to its prompt](../reference/provider-wire/claude.md#a-reply-comes-back-when-the-message-asks-for-one-and-the-transcript-pairs-it-to-its-prompt)). Nothing is added to the message to ask for a reply and nothing is asked of the person's terminal, so what is drawn is what that session actually said; `not delivered` is the registry entry's status turning idle with no record of the message ([claude.md §A message from another session arrives on the session's own address](../reference/provider-wire/claude.md#a-message-from-another-session-arrives-on-the-sessions-own-address)). The daemon's own inbox, in its run directory, is the `from` on every delivery, so a far model that chooses to send back reaches it and that send is drawn once. **Windows changes the address object and nothing else**: the provider's inbox is a Unix domain socket on macOS and Linux and a named pipe on native Windows, which its own documentation puts at `2.1.234` or later there, and the daemon's inbox on that platform is a named pipe too — so delivery, the address offered as `Copy address`, and the hook rule that keeps a send on the one path all read the same on every platform, with a `\\.\pipe\` name standing where a socket path stands. Nothing here has been measured on Windows; that run is owed before the messaging work lands there.

Not chosen now: a read-only Sidekicks pane drawn inside terminal Claude Code (a distribution feature, deferred until mods are stable), and any mod in the driver's own path (compaction, steer, permissions), which stay on the published surface.

### Thesis — Why This Option

- **Two providers, one shape.** The daemon serves both providers through what each publishes; a mod exists on one of them, and building the core on it would leave Codex on a different path or the product tied to one vendor's beta.
- **Everything the design asked for is already reachable.** Steer, pause, permissions, limits, resume and messaging are measured on the published surfaces of both providers. The one thing no daemon-side method does well is reaching a session from inside someone's terminal Claude Code by name, and that is where the plugin goes.
- **The plugin is additive by construction.** It registers two tools and forwards one event; nothing in the daemon imports it or waits for it. With the flag off, the plugin invalid, or the contract changed, the terminal session behaves as Claude Code does on its own and the address path stands.
- **It is measured, not assumed.** The contract and a live run agree that modules load headless and see the events named; the validator reports what a module hooks before any session loads it, which is the pre-flight the build unit runs on each pin bump.

### Antithesis — The Strongest Case Against

- A mod sees every engine event, more than the wire ever will; a daemon that read the engine through a mod could show more and fake less (compaction, the exact tool arguments before permission, the model's own turn steps).
- Anthropic says it ships in weeks; building on it early puts the product ahead rather than behind.
- One worker thread per plugin is cheap, and the built-in `diff` and `agents-md` mods show the API carrying real product features.

### Synthesis — Why It Still Holds

- The wire is enough for what the design asks, and the design is the contract. Where the wire is thinner than the engine, the difference today is compaction detail the product does not draw and turn steps the transcript already streams.
- "Weeks" is a plan, not a release. The flag is off by default, the contract says it changes without notice, `sec-default` can refuse a user-tier `tool.register` on managed machines, and Codex is untouched by any of it. A core that depends on it would be one flag flip from broken, on one provider.
- Cheap is not the question; ownership is. A behaviour the daemon owns on both providers is kept once; a behaviour inside one vendor's plugin runtime is kept for as long as that runtime keeps its shape. The bridge is worth that upkeep because it is small and optional; the core is not.

---

## Alternatives Considered

### Option A: Published surface for the core; one optional terminal bridge plugin with a daemon-side method under each hook (Chosen)

- **What:** As decided above.
- **Steel man:** Both providers on one shape; the single real gap filled by the single tool that fills it well; nothing to undo if the plugin runtime moves.
- **Weaknesses:** Two ways to reach a hosted session from a terminal, one of them better; the plugin's tests run against a moving contract; on managed machines the organization may withhold `tool.register` and the plugin silently offers less.

### Option B: Build the Claude driver's control path on a mod (compaction through `session.compact`, steer through `tool.call` answers, permissions through `tool.call` deny) (Rejected)

- **What:** Register the daemon as a mod in every hosted Claude Code session and drive it through `$`.
- **Steel man:** The richest possible view of the engine, ahead of the wire, with Anthropic's own typed contract.
- **Why rejected:** Claude-only; off by default and gated by a rollout flag and by policy; a contract that changes without notice this month; and every behaviour it would replace is measured on the published surface already (steer folded mid-turn, `PostToolUse` context, `can_use_tool`, the provider's own `/compact`). It also duplicates the classic hooks the daemon already registers.

### Option C: A read-only Sidekicks pane inside terminal Claude Code (Deferred)

- **What:** A mod drawing the daemon's sessions, worktrees and Remote Control state beside a terminal transcript through `$.ui`.
- **Steel man:** Reaches people who never open the desktop app; the `diff` mod shows a pane of this kind is what the API is for.
- **Why deferred:** Distribution, not a capability the design needs; the UI half of the contract is the part most likely to move, and the terminal bridge above gives those sessions the daemon's reach without a pane. Revisit when the docs page exists and the flag is on by default.

### Option D: No plugin anywhere; `Copy address` and the stream-side peer frame only (Kept as the standing method, not chosen alone)

- **What:** A terminal session reaches a hosted session only by pasting its address.
- **Steel man:** Zero dependency on the plugin runtime; nothing to test on a pin bump.
- **Why not alone:** A terminal Claude Code cannot see the daemon's sessions by name, so messaging from a terminal stays a copy-and-paste act. This option is exactly what stands when the plugin is absent, so it is documented as the method under each hook rather than rejected.

### Option E: Write each hosted session's entry into the person's own Claude Code sessions folder so terminal sessions list them by name (Rejected)

- **What:** The daemon copies a session's true entry into `~/.claude/sessions/` while it runs.
- **Steel man:** Names appear in the terminal's own list with no plugin at all.
- **Why rejected:** The daemon never writes into the person's own provider home (Spec-026), and Claude Code's identity checks on those entries are unmeasured.

---

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | A hooks module loads and fires in a terminal Claude Code session with the flag on, and `$.tool.register` on `session.start` lists the tools by turn one. | The contract's `session.start` note ("The first is awaited: a `$.tool.register` is listed by turn one"), and measured on this machine on 2026-09-21 at 2.1.278: a tool registered on `session.start` was in the `init` tool list by turn one, the model called it and the module's own hook answered. | The bridge offers the tools a turn late; the address method stands. |
| 2 | A hooks module can reach the daemon's local socket, through `$.process.run` or `$.http.fetch`. | Measured on this machine on 2026-09-21 at 2.1.278: `$.http.fetch(url, { socketPath })` reached a Unix socket and answered `200`, and `$.process.run` of `curl --unix-socket` worked as the fallback; a socket path longer than 104 bytes fails on macOS with an error that names a typo instead. | The bridge shells out to the `sidekicks` command instead; if neither works the plugin is not shipped and Option D stands. |
| 3 | A peer delivery that reaches a hosted session without the daemon arrives as a user frame on that session's stream, readable by the daemon. | Observed on the Claude stream during the September messaging probes: a user frame with `origin.kind = "peer"`. | The receiving row would be missing until the model's reply reveals it; the bridge's second hook then becomes the only path and the plugin stops being optional, which would reopen this record. |
| 4 | The flag can be off, or a managed machine's `sec-default` can withhold `tool.register` from the user tier. | Binary strings (`canLoadUserHooksModules`, the rollout flag default false) and `sec-default`'s published README row for `tool.register`. | Nothing: this is the case the daemon-side method exists for. |
| 5 | The contract may change between releases. | Its own header line. | The plugin fails validation on a pin bump; the bridge unit's check fails loudly and the plugin is fixed or withdrawn while the core is untouched. |

---

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| The contract changes and the module no longer validates or fires. | High this year | Low | `claude plugin validate` and the headless probe above run on every Claude Code pin bump; a red run names the hook. | Fix or withdraw the plugin; the daemon-side method under each hook is the product's behaviour meanwhile. |
| The flag is off on the person's machine, or policy disables hooks. | High until general availability | Low | `session.start` never fires, so the bridge's tools are absent from the session's tool list. | The address method; the console's inspector offers `Copy address` regardless. |
| A managed machine's `sec-default` refuses the user-tier `tool.register`. | Medium on Team and Enterprise | Low | The registration returns the refusal by name; the bridge logs it once. | The address method. |
| The worker crashes and the plugin is unloaded mid-session. | Low | Low | The tools disappear from the session's tool list. | The address method for the rest of that session. |
| The daemon's socket path exceeds 104 bytes on macOS. | Medium on a deep run directory | Low | The plugin's first `$.http.fetch` fails at `session.start`; the daemon refuses to bind a longer path with a plain error. | The daemon keeps its run directory short; the plugin falls back to the address method. |
| Someone builds a daemon behaviour that only works with the plugin loaded. | Medium over time | High | Review against this record; a dependency-cruiser rule, added with the plugin, that nothing in the daemon imports from its folder. | Refuse in review; the daemon never requires the plugin. |

## Reversibility Assessment

- **Reversal cost:** Hours. Delete the plugin folder and its build unit; no daemon code references it.
- **Blast radius:** Terminal Claude Code sessions lose the by-name tools and fall back to the address method. Nothing else changes.
- **Migration path:** None needed; the daemon-side methods are already the documented behaviour.
- **Point of no return:** None while this record holds. It would appear the day a daemon behaviour required the plugin, which the failure-mode row above exists to prevent.

## Consequences

### Positive

- One shape for both providers, on surfaces each vendor publishes and documents.
- Terminal Claude Code sessions reach the daemon's sessions by name where the plugin loads, and by address everywhere else.
- A measured, re-runnable check on every Claude Code pin bump for what the plugin runtime does, so drift is seen before it is felt.

### Negative (accepted trade-offs)

- Two documented ways to do one thing, the plugin's and the address's; accepted because the second is what stands when the first cannot load.
- A small plugin kept against a moving contract; accepted because it is optional and its check is cheap.
- The stale `steer: false` comment in the Claude driver stays until that file is next edited; accepted because the design already draws the measured behaviour and the fix belongs with the driver's own unit.

### Unknowns

- Whether Anthropic keeps `socketPath` on `$.http.fetch` in the stable contract; the bridge unit keeps `$.process.run` as its fallback.
- What Anthropic ships as the stable form, and whether `tool.register` stays open to user-tier plugins by default; the record is revisited when the docs page appears.

---

## Decision Validation

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [x] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| The headless probe above and `claude plugin validate` pass on the pinned Claude Code | Green on every pin bump | Re-run the two commands in the table above | Each pin bump |
| A terminal Claude Code session with the plugin lists the daemon's sessions and a message lands as a row on the target | Both true | Manual run against a live daemon | When the bridge unit lands |
| The same terminal session with the flag unset still reaches a hosted session by its address and the row is drawn from the stream | True | Manual run with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` unset | When the bridge unit lands |
| Daemon code paths that import from or wait on the plugin | Zero | A `dependency-cruiser` rule added with the plugin forbids imports from its folder; review against this record | Every pull request |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Installed Claude Code 2.1.278 binary, strings | Primary research | Rollout flag `tengu_plugin_hooks_modules` default false, override `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`; `canLoadUserHooksModules` also requires hooks not policy-disabled; one hooks worker thread per plugin; crash unloads, overrun flags runaway; the `--smol` spawn is the built-in module bundler | `~/.local/share/claude/versions/2.1.278`, read 2026-09-21 |
| Function hooks type contract, written by Claude Code 2.1.277 | Documentation | 92 events; `session.start` carries `surface: null` and `isInteractive: false` for a `-p` run or the SDK; `tool.call` may deny or answer; `session.compact` may rewrite or skip; `session.receive` carries origin `peer`; "EARLY ACCESS: this surface may change between releases without notice" | https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts, read 2026-09-21 |
| Built-in mods and their README | Documentation | Four mods ship in the binary with source; `claude --plugin-dir` loads one from source; `claude plugin test` runs a mod's tests against the engine's own `$` | https://github.com/anthropics/claude-code/tree/main/mods, read 2026-09-21 |
| `sec-default` README | Documentation | The outermost seat on managed machines; refuses a user-tier `tool.register` while managed settings hold `allowedMcpServers`; continues past the user tier for classic hooks, managed prompt content and settings reads | https://github.com/anthropics/claude-code/blob/main/mods/sec-default/README.md, read 2026-09-21 |
| Proposal issue "Mods - make Claude 10x more extensible" | Community discussion | Opened 2026-09-03; the 2026-09-09 update names the product "Claude Mods", offers `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` for testing and says "shipping in N weeks" | https://github.com/anthropics/claude-code/issues/91870, read 2026-09-21 |
| Claude Code hooks reference and plugins reference | Documentation | Neither page mentions hooks modules, function hooks or `$`; the hooks page lists five hook types (command, http, mcp_tool, prompt, agent) and `additionalContext` on `PostToolUse` among others | https://code.claude.com/docs/en/hooks and https://code.claude.com/docs/en/plugins-reference, read 2026-09-21 |
| Community list of mods | Community discussion | The catalogue the parallel investigation drew from; entries are plugin manifests, not all of them modules | https://github.com/karanb192/awesome-claude-code-mods, read 2026-09-21 |
| `lcm` README | Community discussion | Seven classic hooks (`PreCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `PostToolUse`, `PostToolUseFailure`) plus an MCP server; not a hooks module | https://github.com/lossless-claude/lcm, read 2026-09-21 |
| `cdx` README | Community discussion | A hooks module registering 21 tools on `session.start`, talking to its CLI through `$.process.run`, adding context on the next tool result mid-turn, and running headless with `surface === null` | https://github.com/RedesignedRobot/cdx, read 2026-09-21 |
| Headless module probe | Primary research | The table in Context: validation passed; `session.start`, `tool.call` and `turn.start` fired under `-p` | This record, 2026-09-21 |
| Headless bridge probe | Primary research | A tool registered on `session.start` was listed by turn one and served by the module; `$.http.fetch(url, { socketPath })` reached a Unix socket, with a 104-byte path limit on macOS; under the daemon's stream-json wire the module's `tool.call` hook ran before the `can_use_tool` request left the process; with the flag unset nothing loaded and validation still passed | This record, 2026-09-21 |
| Mid-turn delivery probe on 2.1.269 | Primary research | A `stream-json` user message written mid-turn is consumed into the running turn under the reason `absorbed_mid_turn` | Measured on this machine 2026-09-11; carried into [Spec-003 §Driver-Level Steer Mechanics](../specs/003-queue-steer-pause-resume.md#driver-level-steer-mechanics) |

### Related ADRs

- [ADR-033: One Claude Code Process Per Session, One Codex Service Per Account](033-one-claude-process-per-session-one-codex-service-per-account.md) — the process the daemon drives and the wire it drives it on; this record keeps that path and adds nothing inside the process.

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-09-21 | Accepted | Decided with the console design after the headless probe; revisit when the docs page for mods exists or the flag is on by default. |
