# Claude Code Wire Reference

Pinned wire reference for the Claude Code headless CLI as driven by `claude-driver`. See the [family README](README.md) for the TRUST / PROVENANCE vocabulary this file uses.

## Version pin

| Field | Value |
| --- | --- |
| Pinned version | `2.1.251` |
| Census target | the on-disk build `~/.local/share/claude/versions/2.1.251`, addressed by path. **Not** "the installed binary" — at the previous pin the launcher symlink had already moved to `2.1.246` mid-pass, so `claude --version` does not reliably name what was measured. |
| Census artifact | the **platform-native single-file build** (a 188 MB Mach-O arm64 executable with the CLI's JavaScript bundle embedded in it; it was 359 MB at `2.1.245`, so build size is not a stable identifier), not a loose `cli.js`. |
| Carried census | **This pin move re-verified the flag surface and every recorded literal, and did not re-run the schema-constructor extraction.** The sections whose evidence is that extraction — [Control-request registry](#control-request-registry-binary-census) (including the exactly-once counts, the permission-mode set, and the verbatim schema-description quotations), the [`system/init` capability description](#systeminit-capabilities--an-open-set-per-token), and [Result and stream surface](#result-and-stream-surface) — remain **measured at `2.1.245`** (with `2.1.234` / `2.1.246` where a probe names them) and are **carried**, not restamped. What was re-measured at `2.1.251`: every literal those sections record is still present in the binary as a literal token — quoted or bare, since a handful (`still_queued`, `rate_limits_available`, `subscription_type`, `buildTime`) are emitted as unquoted object keys in **both** builds, so a quoted-only check reports a deletion that did not happen. So no recorded member vanished across the hop. What is **not** re-established: the exactly-once arity, and the counterexample zero-counts — a raw string count is not the census that produced them (`rewind` and `compact` occur as quoted literals in both builds), so those stay `2.1.245` readings rather than being re-confirmed by a weaker instrument. |
| Supported floor | `2.1.234` — the oldest release `claude-driver` accepts. **Ratified 2026-08-26** by the [Spec-005](../../specs/005-provider-driver-contract-and-capabilities.md) provider-CLI version-tolerance amendment, which raised the mandated floor from `2.1.198` and is the normative home of this value; this table mirrors it. The nightly compatibility check's `floor` leg is **regression evidence** for this release, not enforcement of the floor: it installs `2.1.234` and checks that release's provider surfaces still answer, but it runs no daemon code and carries no below-floor arm, so it can pass while a daemon wrongly admits an older build. Admission is enforced at spawn by the driver gate (Plan-005 T3.23). |
| Primary anchor | a **string census of the pinned binary**, cross-checked against the official docs census (CLI reference + changelog **version anchors**) |
| Censused | flag surface and literal presence at `2.1.251`, 2026-08-28; the carried schema-constructor census at `2.1.245`, 2026-08-25 |
| Docs verified live | 2026-07-02 — CLI reference (`code.claude.com/docs/en/cli-reference`) + changelog (`github.com/anthropics/claude-code` `CHANGELOG.md`, the full-history file — version anchors below cite it, not the docs-site release notes, which truncate old versions) |

The Claude Code changelog **carries no dates** — entries are numbered by version only, so a behavior's floor is pinned by **version anchor** (the release it first appears in), never by date. Release cadence is the reason this file names a floor at all: six distinct builds (`2.1.234`, `2.1.235`, `2.1.245`, `2.1.246`, `2.1.247`, `2.1.251`) landed on the authoring machine inside eleven days, and at the previous pin's authoring the npm dist-tags were `stable` = `2.1.231`, `latest` = `2.1.246` — so `stable` and `latest` are **not** the same channel, and a doc that says "current" without saying which tag has said nothing.

**Census scope caveat — which artifact was read.** `@anthropic-ai/claude-code` on npm is a **wrapper**: it ships `cli-wrapper.cjs` plus an `install.cjs` postinstall, and the executable itself arrives as a platform-specific optional dependency (`@anthropic-ai/claude-code-<platform>-<arch>`). Installed with build scripts blocked, the wrapper refuses outright — "claude native binary not installed" — so there is no JavaScript-only channel to census. What this file reads is therefore the **native single-file build**, which embeds the JS bundle; the local census target and the platform package's `claude` binary are the same artifact class and byte size. Two consequences: a literal's presence in this census is evidence about the native build (the only one there is), and any CI job that wants to reproduce it must let the postinstall run — an `--ignore-scripts` install yields a wrapper that cannot even report its version. Where a substituted native implementation could differ (bundled search/glob tooling, for instance), a census result is evidence about tooling names, not about protocol shapes.

## The `--help` is non-authoritative rule

Unlike Codex (whose binary emits its own schema), Claude Code has no generated protocol dump, and its `--help` under-reports the surface. The CLI reference states this outright — quoted verbatim (Verified, Official docs, 2026-07-02):

> `claude --help` does not list every flag, so a flag's absence from `--help` does not mean it is unavailable.

**Consequence for this file:** the pinned binary governs, `--help` is a lower bound, and the docs census is the cross-check. Hidden-but-documented flags (`--permission-prompt-tool`, `--max-turns`, and others below) are normal, not deprecations. Re-verified at this pin: `--permission-prompt-tool`, `--max-turns`, `--resume-session-at` and `--rewind-files` are all absent from `2.1.251 --help` and all present in the binary.

**And the lower bound moves in both directions — `--session-id` surfaced at this pin.** At `2.1.245` it was one of this rule's worked examples; at `2.1.251` `--help` lists it outright (`--session-id <uuid>`), so it is no longer hidden and has been dropped from the example set above. Nothing about the flag changed; what changed is what `--help` chooses to print. A consumer must therefore not read a flag's arrival in `--help` as the flag's introduction, any more than it reads absence as unavailability.

**And the rule's converse, which matters just as much.** A string in the binary is **not** evidence a flag or subtype is available. `--enable-auto-mode` is documented as removed in `2.1.111` and still appears in the `2.1.251` census — twice, down from four times at `2.1.245`, which is drift in the bundle rather than in the flag's status — dead strings survive bundling. Every claim below therefore says which kind of evidence it rests on: registry membership, a dispatcher arm, an exit-code probe, or vendor prose. Presence alone is never promoted to availability.

## CLI / wire surface

Flags and behaviors this project drives, each with its version anchor where one exists, its provenance, and its trust. "Docs" = the live CLI reference; "Changelog" = the versioned changelog; both fetched 2026-07-02. **Changelog anchors are earliest-mention anchors, not introduction floors** — most entries are fixes that presuppose the flag; a cell is an introduction only where the quoted entry itself introduces the flag.

| Surface | Version anchor | Provenance | Trust | Note |
| --- | --- | --- | --- | --- |
| `--agents` (JSON subagent defs) | introduced `2.0.0` (changelog: "Add subagents dynamically with `--agents` flag") | Official docs | Documented | Same field names as subagent frontmatter + a `prompt` field. |
| `--mcp-config` / `--strict-mcp-config` | `--mcp-config` introduced `0.2.75`; `--strict-mcp-config` mentions from `2.1.143` (changelog: "`/bg` now preserves `--mcp-config`, `--settings`, `--add-dir`, `--plugin-dir`, and `--strict-mcp-config`"; introduction not stated) | Official docs | Documented | `--strict-mcp-config` strips non-explicit inline `mcpServers`; since `2.1.153` it "no longer strips inline `mcpServers` from explicitly-passed agent definitions (`--agents` / SDK `agents`)" (changelog). The ephemeral-relaunch MCP-scoping path. |
| `--json-schema` (structured output) | mentions from `2.1.84` (introduction not stated in the changelog) | Official docs | Documented | Validated JSON output after the workflow; pairs with the structured-output result surface. |
| `--bg` / `--background` | mentions from `2.1.140` (changelog: "Fixed `claude --bg` failing with 'connection dropped mid-request'…"; introduction not stated) | Official docs | Documented | Background session creation. |
| `--resume`, `-r` | background-in-picker "As of `v2.1.144`" (docs) | Official docs | Documented | Resume by ID or name; ID search is scoped to the project dir + its git worktrees. |
| `--fork-session` | present in the `2.1.251` census | Binary probe | Verified | On resume, mint a new session ID instead of reusing the original. |
| `--session-id` | — | Official docs | Documented | Pin a specific conversation session ID (must be a valid UUID) — deterministic session binding. |
| `--replay-user-messages` | — | Official docs | Documented | Re-emit stdin user messages on stdout for ack; requires `--input-format stream-json` + `--output-format stream-json`. The rewind targets (message UUIDs) appear on the wire only when this is set. |
| `--permission-prompt-tool` | — | Official docs | Documented | Names an MCP tool to handle permission prompts in non-interactive mode. |
| `--max-budget-usd` | — | Official docs | Documented | Native per-run USD cap (print mode): stops spending on API calls when the cap is reached. Wired as defense-in-depth beneath the daemon budget accountant, not as the authority. |
| `--max-turns` | — | Official docs | Documented | Caps agentic turns (print mode); errors at the limit. |
| `--safe-mode` | min-version `2.1.169` (docs) | Official docs | Documented | Disables customizations for troubleshooting; distinct from `--bare`. |
| `--resume-session-at` | present in the `2.1.251` census; absent from that build's `--help` and from the docs page | Binary probe | Verified | The message-UUID rewind target for the Claude session-time-travel leg. See [Gaps recorded](#gaps-recorded). |
| `--resume-drops-turn`, `--reply-on-resume`, `--no-session-persistence` | present in the `2.1.251` census | Binary probe | Verified | The resume-behavior family around `--resume` / `--fork-session`. Semantics are not asserted here — only that the flags exist at the pin. |
| `--rewind-files` | present in the `2.1.251` census | Binary probe | Verified | The file-side companion to conversation rewind. Its control-request counterpart `rewind_files` is explicitly refused in cloud-hosted sessions (see below), so treat it as host-context-dependent. |
| `--enable-auto-mode` | **removed in `2.1.111`** (docs); string still present in the `2.1.251` census | Official docs | Documented | A version-ceiling anchor: gone as of `2.1.111`; auto mode moved into the `Shift+Tab` cycle (`--permission-mode auto`). Its surviving string is this file's worked counterexample to reading presence as availability. |

## Control protocol and result surface

Everything below is reproduced from the pinned binary. At the previous pin this section was a design-census summary carrying **Cross-reference** provenance and **Derived** trust; the census replaces that lineage with direct observation, and each subsection states its own evidence kind.

### Control-request registry (binary census)

At `2.1.245` the control-request subtype registry is directly observable in the binary as a set of schema constructors. Each subtype below appears **exactly once** in that census (**Binary probe** provenance, **Verified** trust at `2.1.245`). This section is **carried** to the `2.1.251` pin rather than restamped: the schema-constructor extraction was not re-run, and what was re-measured at `2.1.251` is only that every subtype below still occurs as a quoted literal in the binary — the counterexample counts below are **not** re-established by that weaker check and stay `2.1.245` readings (see §Version pin, Carried census):

`interrupt`, `set_permission_mode`, `can_use_tool`, `set_model`, `get_usage`, `get_context_usage`, `get_session_cost`, `list_models`, `get_binary_version`, `apply_flag_settings`, `rewind_files`, `hook_callback`, `elicitation`, `request_user_dialog`, `mcp_message`.

This **upgrades the previous pin's design-census entry from Derived to Verified** for the three subtypes it named (`interrupt`, `set_permission_mode`, `can_use_tool`) and adds the rest. Counterexample hunt, run against the same census so the set above is not read as more than it is: `set_effort`, `rewind`, and `compact` are **absent** as control-request subtypes (count 0) — so the registry is not simply "every control verb one might expect". This reading is `2.1.245`-scoped and carried: it is a statement about the schema-constructor census, not about the binary's strings, and `rewind` and `compact` do occur as quoted literals in that build and in `2.1.251` alike — which is exactly why the pin move did not re-confirm it with a string count.

**Registry membership is not availability.** The dispatcher answers an unsupported subtype with a typed refusal rather than silence. Quoted verbatim from the `2.1.245` dispatcher arm for `get_usage`:

> get_usage is not supported in this context (onGetUsage callback not registered)

emitted as `{ type: "control_response", response: { subtype: "error", request_id, error } }`. A sibling arm shows the same shape for `get_context_usage`. Separately, a **cloud-hosted-session** gate rejects `rewind_files` outright and constrains `apply_flag_settings` ("apply_flag_settings keys not available in a cloud-hosted session: …"). So a driver must treat every control request as **feature-detected at call time**: send it, and classify the typed `control_response` error, rather than deciding availability from a version number.

**And the census is a lower bound, not an upper one** (added 2026-08-26; **Binary probe**, **Verified** at `2.1.234`, `2.1.245`, and `2.1.246`). The rule above says a censused subtype may still refuse. The converse is also true and is the sharper trap: a subtype **absent** from the census above may still answer. `mcp_set_servers` — the live server-set reconcile the SDK exposes as `setMcpServers` — appears in none of those three builds' censused subtype registries, and at all three it answers `{"subtype":"success","response":{"added":[],"removed":[],"errors":{}}}` over `-p --input-format stream-json` with no user message sent and no billed turn. Each probe was run beside a negative control (`zzq_nonexistent_subtype`, refused every time with the typed `Unsupported control request subtype: …`), so the successes are not an artifact of a dispatcher that accepts anything. The desired set sent was **empty**, so what is Verified here is that the subtype dispatches and returns the documented reconcile envelope; a non-empty mutation is outside this probe's reach and is measured by the consumer that performs one. Two consequences: this file's registry list is evidence about what the census could see, never a completeness claim; and neither presence nor absence in it may decide a capability — only the probe's own classified answer may.

#### Direction: some censused subtypes are refused BY NAME on the inbound channel

The rules above cover a censused subtype refusing for CONTEXT and an uncensused one answering anyway. There is a third case, and it is the one that breaks a probe (added 2026-08-30; **Binary probe**, **Verified** at `2.1.251`): a censused subtype can be refused **by name**, with the identical typed refusal the negative control draws.

Measured over `-p --input-format stream-json`, one subtype per process, no user message sent and no billed turn, each run beside the `zzq_nonexistent_subtype` negative control:

| Subtype sent INBOUND (daemon → CLI) | Answer |
| --- | --- |
| `can_use_tool`, `elicitation`, `request_user_dialog` | `Unsupported control request subtype: <name>` — the negative control's own refusal, differing only in the name |
| `get_binary_version`, `get_usage`, `get_context_usage`, `get_session_cost`, `list_models`, `mcp_set_servers` | `{"subtype":"success", …}` |

The three refused names are exactly the ones the CLI **raises** — they are its outbound questions to a host, and the permission prompt among them is what `--permission-prompt-tool` plumbs. So the registry census spans **both directions** of the channel, while the inbound dispatcher carries only one of them.

The consequence is sharper than the lower-bound rule above, and it is the one a capability probe must be built around: a name-level refusal is evidence about the **inbound dispatcher**, never about the capability. Probing `can_use_tool` inbound and reading its refusal as absence would withdraw a feature every one of these builds fully carries. A consumer probing this channel must first establish that the subtype it is probing is one the daemon **sends**.

The same three probes give the in-band **version** channel: `get_binary_version` returns `{ version, buildTime }` for the build that is actually running (`2.1.234` → `2026-08-17T01:20:38Z`, `2.1.245` → `2026-08-25T04:00:18Z`, `2.1.246` → `2026-08-25T18:33:51Z`). That is what a driver should read, because `claude --version` reports the launcher's current build — the same divergence recorded in §Version pin above, where the census target and `claude --version` came apart mid-pass.

`can_use_tool` remains the `--permission-prompt-tool` plumbing (`{tool_name, input}` → `{behavior: allow | deny, updatedInput?, message?}`); the census confirms a `{behavior: "cancelled"}` response arm alongside those.

The permission-mode value set at `2.1.245`, verbatim from the census (**Binary probe**, **Verified**): `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`, `dontAsk`.

#### `get_usage` is EXPERIMENTAL — two separate facts, do not collapse them

**(1) The control request itself is experimental.** Its own schema description, verbatim from the `2.1.245` census:

> Requests the structured /usage data: session cost/usage totals plus claude.ai plan rate-limit utilization when available. Experimental — the response shape may change.

The hedge is the vendor's and is preserved as written. **Trust: Provisional**, on Verified presence — the subtype is in the registry, its shape is disclaimed by the vendor, and its dispatcher can refuse at runtime. Never assume it; probe it and handle the typed refusal.

**(2) `rate_limits_available` is a field _inside_ the response, and it means something else.** It is not a feature-detect for whether the request exists. Verbatim from the same census:

> False when plan rate limits do not apply (API key, Bedrock, Vertex, or missing profile scope) — rate_limits will be null.

It sits beside `subscription_type` ("Claude.ai subscription type ('pro', 'max', 'team', 'enterprise') or null for API key / 3P provider sessions") and `rate_limits`, whose window keys at the pin are `five_hour`, `seven_day`, `seven_day_oauth_apps`, `seven_day_opus`, `seven_day_sonnet`, plus a `model_scoped` list. So the correct driver logic is two-stage: **first** discover whether `get_usage` answers at all (typed refusal or not), **then** read `rate_limits_available` to learn whether plan limits are even a concept for this session, and only then read `rate_limits`. Treating a `null` `rate_limits` as a failure would misreport every API-key session.

#### `system/init` `capabilities` — an open set, per-token

`2.1.245` carries a `capabilities` field on the init handshake whose own description states the contract, verbatim:

> Open set — ignore unknown values; check each capability for exactly the behavior you use. 'interrupt_receipt_v1' = the interrupt control_response success payload carries still_queued (uuids of async user messages that survive the interrupt). 'interrupt_cancel_queued_v1' = the interrupt control_request honors cancel_queued:true … 'queued_notifications' = the CLI accepts inbound queued_notification stream messages and drains them via ReadNotifications (the cloud session backend reads this from the persisted init event to decide whether it may send them). Absent on older CLIs.

This is the vendor's own statement of the per-capability degrade rule the [family README](README.md#versioning-and-pinning-policy) adopts: check each token for exactly the behavior used, ignore unknown ones, and expect the field itself to be missing on older builds. `still_queued`, `interrupt_cancel_queued_v1`, `queued_notification`, and `msg_lifecycle_v1` are all present as literals at the pin (**Binary probe**, **Verified**). Which release each token first appeared in is **Official docs** provenance and only **Documented** — a census of one build cannot date a token's arrival.

#### `system/init` command and skill enumeration — a live read, never a stored registry

Added 2026-08-31. **The grading split inside this section is load-bearing: two different legs of evidence back two different classes of claim, and they do not carry the same trust.** A reader citing from here must carry the split too.

Beyond `capabilities`, the init handshake carries five members that together are this provider's command-and-skill surface:

| Member | Shape as the shipped driver consumes it | Notes |
| --- | --- | --- |
| `slash_commands` | `string[]` | Interactively invocable command names, **without** a leading `/`. |
| `skills` | `string[]` | The provider's skill surface — names only. |
| `terminal_slash_commands` | `string[]` | A **separate** member, not merged with the above. |
| `fast_mode_state` | nullable string | See [Output speed](#output-speed--fast_mode_state-is-this-providers-positive-case) below. |
| `fast_mode_disabled_reason` | nullable string | Present only where the provider supplies one. |

**Leg 1 — literal presence. Binary probe, Verified at `2.1.251`, censused 2026-08-31** by string census of the on-disk native build named in [Version pin](#version-pin), with a negative control (`zzq_not_a_real_literal`, **0** occurrences) taken in the same pass, so the zero-versus-nonzero distinction is a measurement rather than an assumption:

| Literal | Matching string-lines |
| --- | --- |
| `slash_commands` | 12 — of which **3** are the `terminal_slash_commands` superstring, so **9** standalone |
| `terminal_slash_commands` | 3 |
| `fast_mode_state` | 8 |
| `fast_mode_disabled_reason` | 5 |
| `"skills":` (as an object key) | 4 — see the caveat below; the bare word `"skills"` matches 47 and is **not** the useful number |

**The column counts matching lines of `strings -a` output, not occurrences** — a single extracted line holding a literal twice contributes one. In a single-file build whose bundle lines run to thousands of characters that distinction is real, so the figures are lower bounds on occurrences and exact as line counts.

**The `skills` row is weaker evidence than its neighbours, and is marked so deliberately.** `fast_mode_state`, `fast_mode_disabled_reason`, and `terminal_slash_commands` are distinctive snake_case wire members — a hit is almost certainly the member. `skills` is an ordinary English word inside a 188 MB build that also ships skill-plugin machinery, tool descriptions, and prose; its bare-word count of 47 is dominated by matches that have nothing to do with the handshake. Narrowing to the object-key form `"skills":` gives **4**, which is the same arity as the other per-row members censused here (`supportsFastMode` 4, `supportedEffortLevels` 4). The looser number is reported rather than hidden, but it should not be read as four-way corroboration alongside the rows above it.

As with the members named in the Carried census row, most of these occur **bare** rather than quoted — a quoted-only check finds `"slash_commands"` only inside the unrelated `"tengu_stacked_slash_commands"` — so the counts above are deliberately substring-inclusive and the one overlap is stated rather than silently netted out.

**Leg 2 — the shapes, the vocabularies, and the invocability distinction. Cross-reference provenance, Derived trust.** Everything in the `Shape` and `Notes` columns comes from the shipped driver's `packages/runtime-daemon/src/provider/drivers/claude/lifecycle.ts#ClaudeHandshakeDeclaration`, which records these members as read from a live frame. **This pass observed no handshake frame.** No captured `system/init` fixture exists in the repository either — the files under the [driver fixtures](#driver-fixtures) path are the control-request census, the stream-surface census, and the turn-evidence transcripts, none of which carries a handshake. A string census proves a member name is *in the build*; it cannot prove the member is *emitted*, what type it carries, or what its values mean. Those claims are therefore **Derived**, and the [no-authless-probe gap](#gaps-recorded) applies to this family in full — the declaring handshake rides a turn-bearing exchange, so reaching a real one on this provider costs credentials and a billed turn.

**Two structural facts, because this is where the surface differs from the Codex one.** Neither is a defect; they are why a cross-provider normalization cannot be symmetric:

- **This enumeration publishes no scope and no enabled/disabled distinction.** There is no analogue of the Codex `SkillScope` (`user | repo | system | admin`) or of its required `enabled` boolean — see [`skills/*`](codex.md#skills--the-skill-surface). Names arrive as bare strings. A normalized cross-provider entry therefore has to type both axes optional even though Codex never omits either.
- **`terminal_slash_commands` is published under its own member and is not the same set.** The provider itself separates them, and a consumer that unions the two members offers, over the programmatic surface, commands that are not invocable there. The dispatch guard is built from `slash_commands` alone; the three sets are carried separately rather than merged or dropped.

**It is a live read held as driver-session state, never a stored registry — and it is refreshed, not pinned** (corrected at PR review 2026-08-31; the first version of this section said a consumer retains the enumeration for the binding's lifetime, which misdescribes the shipped driver). The handshake is the only place these names arrive and there is no enumeration RPC to re-read them from, but the held copy is **not** fixed at establishment. Per `packages/runtime-daemon/src/provider/drivers/claude/lifecycle.ts#ClaudeSessionLifecycle`, the driver keeps one entry per session and **re-records it wholesale on every handshake-bearing frame**: the inbound-frame router calls the observer whenever a frame carries a declaration, and the observer unconditionally overwrites the stored declaration together with its derived invocable-name set. The semantics are therefore **last-declaration-wins**, and because a `system/init` handshake rides each turn-bearing exchange, the held enumeration tracks the newest declaration rather than the first.

Three consequences worth stating, since they follow from that and not from the wire:

- **A refreshed declaration is visible to the next read, not to a cached one.** The normalized entry list is composed at read time from the stored raw declaration, so a later handshake changes what a subsequent read returns — the held state is what the provider most recently said.
- **Re-recording is scoped to the session's own thread.** The observer is reached only where the frame carries no subagent identity, so a child's handshake never overwrites the parent binding's enumeration.
- **A provider-session rotation invalidates rather than staleness-serves.** The held entry is keyed by the provider session id it was observed under, and a read whose current provider session does not match it returns nothing instead of the previous session's palette; the entry is dropped outright on teardown.

Nothing in the payload identifies its own origin, which is why a normalized entry has to carry the `(driverName, providerAccountId)` it was read under rather than deriving it later.

#### Output speed — `fast_mode_state` is this provider's positive case

Added 2026-08-31; the cross-provider framing corrected at PR review the same day. Claude publishes a declared output-speed state; Codex's method namespace publishes no such axis, but that provider **does** carry a participant-settable service-tier surface whose vendor fixtures describe one tier in output-rate terms — see [Output speed — a method-level negative beside a service-tier surface](codex.md#output-speed--a-method-level-negative-beside-a-service-tier-surface), which records the divergence between that wire surface and the corpus's `output_speed: false` declaration as a governing-spec question. So this is **not** cleanly a single-provider axis, and this section no longer claims it is: what is certain is that the two providers express speed-adjacent concepts in structurally different shapes — a declared state with a settable level vocabulary here, a per-turn routing override with no state read there.

**Literal presence: Binary probe, Verified at `2.1.251`**, censused 2026-08-31 — counts in the census table above, plus `supportsFastMode` at 4 occurrences as a per-model axis on the catalog read.

**The state vocabulary, and its deliberate asymmetry: Cross-reference, Derived.** Per the shipped normalizer in the same `lifecycle.ts`, the pinned provider **reports** three states — `on`, `cooldown`, `off` — while the **settable** vocabulary the driver publishes as `outputSpeedLevels` is two: `off` and `on`. A participant may not *request* a cooldown, but the provider may certainly *report* one. The two sets are different sizes on purpose, and a consumer that treats the reported vocabulary as the settable one constructs a request the provider has no way to honor. The shipped table is `packages/runtime-daemon/src/provider/driver-output-speed.ts#DRIVER_OUTPUT_SPEED_LEVELS`, which maps `claude` to `["off", "on"]` and `codex` to `[]` — the one place both sides of this axis are declared.

**Detection is `static`, and the declared state is the truth.** The axis is not probed: reading it live costs a request, and a probe on this project must be zero-turn. So the **declared state** is taken as the fact, never the request's acceptance.

**Verbatim is not unbounded, and a rejected reading is absent.** The declared value is carried verbatim, but it is parsed through a strict shape whose checks range over **length, emptiness, and NUL — never over membership in any vocabulary**. That is precisely what lets `cooldown`, and any level a later build invents, pass through untouched instead of being coerced into the settable set. A reading that fails those bounds becomes **absent — not degraded and not raw** — because the absent answer already has a meaning every reader handles, and inventing a placeholder would put a state the provider is not in on a participant's screen. The accompanying `output_speed_state_rejected` diagnostic carries the failing field and the offending **lengths only, never the values**, since those are the untrusted strings the parse just refused.

`fast_mode_disabled_reason` is present only where the provider supplies one; its absence means the provider gave none, never that there was none.

#### `list_models` and the per-model effort vocabulary

Added 2026-08-31. The control request `{"subtype": "list_models"}` answers `{"subtype": "success", …}` on the control channel; the `list_models` literal is present 5 times at `2.1.251` (**Binary probe**, **Verified**, censused 2026-08-31).

**The values below are Binary probe, Verified, measured 2026-08-30** by one live `claude -p --input-format stream-json` control request that is zero-turn (`num_turns` stays 0) — and they are **carried into this file rather than re-measured by it**. The reading's normative home is [Spec-005 §Provider Parameter Vocabularies](../../specs/005-provider-driver-contract-and-capabilities.md#provider-parameter-vocabularies), mirrored as the shipped golden vector `packages/runtime-daemon/src/provider/drivers/claude/capabilities.ts#CLAUDE_DECLARED_MODEL_CATALOG` (**Cross-reference**).

| Model | Effort levels |
| --- | --- |
| `claude-opus-5[1m]` | `low \| medium \| high \| xhigh \| max` |
| `claude-fable-5` | `low \| medium \| high \| xhigh \| max` |
| `claude-sonnet-5` | `low \| medium \| high \| xhigh \| max` |
| `claude-haiku-4-5-20251001` | **none — this model exposes no effort surface at all** |

**The absent row is the load-bearing one.** Three of four models publish the same five-value list; the fourth publishes no effort axis, and that absence is a declaration rather than a missing field. A provider-wide effort list is therefore wrong on this provider for the same structural reason it is wrong on Codex — the vocabulary is per-model and provider-published — though the two providers demonstrate it from opposite directions: Codex publishes three *different* lists, Claude publishes one list and one *absence*. See [`model/list`](codex.md#modellist--the-model-catalog-and-the-per-model-effort-vocabulary) for the Codex side, where the generated `ReasoningEffort` type is a non-empty string rather than an enum — the schema-level statement of the same rule.

**The reply carries five entries for four models.** `default` and `opus[1m]` both resolve to `claude-opus-5[1m]`; `default` is a reserved pointer, collapsed by the driver's `normalizeClaudeModelCatalog`. A consumer counting reply entries is not counting models.

The live read gates on two members **together** — an entry exposes effort only where `supportsEffort` is not `false` **and** `supportedEffortLevels` is a non-empty array — so a model can withhold the axis by either route. Both literals are present at the pin (`supportsEffort` 6, `supportedEffortLevels` 4). The per-model auxiliary axes `supportsAdaptiveThinking`, `supportsFastMode`, and `supportsAutoMode` (4 occurrences each) are published on the same rows and are deliberately **not** flattened into the effort axis; they are separate capabilities of the same model.

### Result and stream surface

**Result census** (Binary probe, Verified at `2.1.245`). Result subtypes `success | error_max_turns | error_max_budget_usd | error_during_execution | error_max_structured_output_retries`; the `result` field is present only on `success`; trailing events (e.g. `prompt_suggestion`) can arrive **after** `result`, so the driver read-loop reads to EOF rather than breaking on `result`. The structured-output failure carries its own prose: `error_max_structured_output_retries` fires when "the cloud agent called StructuredOutput but no attempt produced a surviving valid output".

**Mid-session retry taxonomy** (Binary probe, Verified at `2.1.245`). The emitted shape is `{ type: "system", subtype: "api_retry", attempt, max_retries, retry_delay_ms, error_status, error }` — note `error_status` alongside the typed `error`, and that the mapping arm is `system/api_error` → `system/api_retry`. The typed error members `authentication_failed`, `oauth_org_not_allowed`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `unknown` are present as literals; the union's exact arity is **Derived**, since a string census cannot prove a set is closed.

**Adjacent stream subtypes present at the pin** (Binary probe, Verified): `rate_limit_event`, `compact_boundary`, `command_lifecycle`, `queued_notification`, and the model-refusal pair `model_refusal_fallback` / `model_refusal_no_fallback`. `rate_limit_event` matters to the daemon's rate-limit surface: it is a **push** channel that does not require the experimental `get_usage` round trip, and is the preferred carrier where both are available.

### Client-side command interception on the programmatic input surface

**A message whose first non-whitespace byte is `/` is consumed by the CLI's own command layer and never reaches the model** (added 2026-08-29; **Binary probe**, **Verified** at `2.1.251` by live `claude -p --output-format stream-json` runs against the on-disk build). This is the behavior [Spec-005](../../specs/005-provider-driver-contract-and-capabilities.md) records at `2.1.245`, reproduced unchanged at this pin — so it is a standing property of this input surface, not a single-build regression.

The trap is that the interception is **not an error**. The stream carries a well-formed `result` frame with `subtype: "success"` and `is_error: false`, so every layer above reads a completed turn while the participant's words were never sent.

**Turn-evidence discriminants on the `result` frame**, measured in one pass — three runs, same build, same model, same session shape, differing only in the message body:

| `result` field | first word command-shaped | same text, one leading newline | ordinary prose |
| --- | --- | --- | --- |
| `num_turns` | `0` | `1` | `1` |
| `duration_api_ms` | `0` | `2473` | `2972` |
| `total_cost_usd` | `0` | `0.66676` | `0.67144` |
| `modelUsage` | `{}` (empty object) | one model key | one model key |
| `is_error` | `false` | `true` (that turn hit an unrelated provider-side refusal) | `false` |

Read the table for what it settles and, more importantly, for what it does not:

- **Positive turn evidence is what discriminates.** `num_turns > 0`, a non-empty `modelUsage`, a non-zero `duration_api_ms`, and a non-zero `total_cost_usd` move together on a real turn and are all zero-valued on an intercepted one. A consumer deciding whether a message reached the model reads these.
- **`is_error` does not discriminate, and neither does the assistant frame's model marker.** The intercepted run reported `is_error: false`; the neutralized run reported `is_error: true` because that particular turn hit a provider-side refusal. And the assistant message's `message.model` reads `<synthetic>` on **both** the intercepted run and a genuine turn that ends in an API error — so `<synthetic>` is evidence of a locally-composed frame, never evidence that no turn occurred. This is the sharp trap: the most obvious single field is the wrong one.
- **Corroborating markers, deliberately not decision inputs.** The intercepted turn additionally carries `is_meta: true` on its user frame and renders the CLI's own output inside a `<local-command-stdout>…</local-command-stdout>` wrapper (observed verbatim: `<local-command-stdout>Unknown command: /zzqnotarealcommand</local-command-stdout>`). Both are strong markers and are recorded here because they are real. Neither is a safe basis for a runtime check: the set of shapes a client-side command layer can emit is open, so a consumer that recognizes **dispatch** fails open the day the wrapper changes. Recognize the presence of a turn, never the shape of a dispatch.
- **The interception is not name-gated.** `/zzqnotarealcommand` is not a command this CLI has; it was intercepted anyway and answered `Unknown command:`. The dispatch decision is therefore made on the leading byte, upstream of any command-name lookup, and a consumer cannot avoid it by avoiding real command names.
- **One leading newline was sufficient to defeat it** at this pin — the middle column above is the same message body with a single `\n` prepended, and it produced a real, billed turn. What is Verified is that this transform worked on this build. The general claim that any whitespace prefix always defeats client-side interception is not something a probe of one build establishes, so it is not made here.

## Environment and update control

Environment keys present at `2.1.251` (Binary probe, Verified — all eight re-measured at this pin; the `CLAUDE_SECURESTORAGE_CONFIG_DIR` empty-value behavior below is carried from the `2.1.245` schema-constructor census) that a supervising daemon or CI job must know about:

| Key | Why it matters |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Relocates the configuration home — the basis for isolating a spawned session from the operator's own state. |
| `CLAUDE_SECURESTORAGE_CONFIG_DIR` | Relocates the **secure-storage** home specifically, and is the one key in its group whose **empty-string value is honored rather than skipped** — the census shows the env-collection loop `continue`s on an empty value for every key except this one, and the child-process command builder forwards it whenever it is defined at all, empty included. So "set but empty" is a meaningful, distinct state here. Treat clearing it and unsetting it as different acts. |
| `CLAUDE_CODE_OAUTH_TOKEN` | The long-lived headless credential (minted by `claude setup-token`). It is a credential: never echo it, never persist it, never write it to a workspace. |
| `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES` | Pin the running build for the life of a process. Required for any measurement to mean anything — an unpinned CLI can move mid-run, which is exactly how this pin's census target and `claude --version` came apart. **Presence-style gate: set to `1`.** |
| `requiredMinimumVersion`, `requiredMaximumVersion`, `autoUpdatesChannel` | The vendor's own managed version-gating keys. Their existence is why a floor/ceiling policy is expressible at all on this provider. |

## Gaps recorded

Honest gaps between what the pinned binary shows and what the vendor documents — recorded rather than papered over. The first two were opened at the previous pin and are now **partly closed by measurement**:

- **`--resume-session-at` — closed on the binary side, still open on the docs side.** At the pin before last this flag was known only from a design census. It is **Verified present** in the `2.1.251` binary and **Verified absent** from that same build's `--help` output — as it was at `2.1.245` — so the docs-vs-binary divergence is confirmed from both directions rather than asserted, and has now held across two pins. It remains **absent from the live CLI reference** fetched 2026-07-02. This is the `--help`-non-authoritative rule in action. `--rewind-files` is the confirmed companion; `--session-id` was one until `2.1.251` printed it in `--help`, and `--fork-session` likewise.
- **`--bare` becoming the print-mode default — still open, still Provisional.** The design census (C-15) records that the docs state `--bare` "will become the default for `-p` in a future release" — a modal, forward-looking claim (hedge preserved as written). That exact sentence was **not** found on the CLI reference page fetched 2026-07-02; the page describes `--bare` as a minimal mode (skips hook/skill/plugin/MCP/memory auto-discovery; Bash + file-read + file-edit tools only). The `--bare` literal is present at `2.1.251`, which says nothing about the default. Treat the "future default" claim as **Provisional** and design-census-sourced until re-confirmed against the live docs. It matters because the flip would break OAuth headless driving (`--bare` strips OAuth/keychain), so it is a version floor/ceiling risk, not a routine flag.
- **No authless protocol probe exists for this provider.** Claude Code's `-p` path needs credentials to reach a handshake, so — unlike Codex, whose `initialize` answers on a scratch home with no account — there is no way to observe Claude's stream-json handshake without a token. The nightly compatibility check therefore measures this provider through version reporting, argument-acceptance exit codes, and the control-request registry census, and reaches a real handshake only on the optional authenticated leg. Any claim about live Claude wire behavior in a governing doc must name which of those it rests on. **Narrowed 2026-08-29, not closed:** the [command-interception](#client-side-command-interception-on-the-programmatic-input-surface) section above rests on live **authenticated** `-p --output-format stream-json` runs against the pinned build, so this file now carries at least one directly-observed live-stream claim. The gap itself is unchanged — an authless handshake is still unreachable on this provider, so live-wire claims here cost real credentials and real billed turns to establish, and a consumer cannot reproduce them in CI without an account.

## Driver fixtures

Captured-wire fixtures for the Claude event-normalizer are cited as text (they do not exist yet): `packages/runtime-daemon/src/provider/drivers/claude/__fixtures__/` — lands with Plan-005 Phase 3.

## Provenance

- Rows in [CLI / wire surface](#cli--wire-surface) marked **Official docs**: pinned to the version anchors shown; docs verified live 2026-07-02. Rows marked **Binary probe** were reproduced against `2.1.251` on 2026-08-28 by string census of the on-disk native build, the method that also reproduced this file's recorded `--enable-auto-mode` count at `2.1.245` exactly — so the two pins' numbers are comparable.
- The `--help`-non-authoritative quote: **Official docs**, **Verified** (fetched 2026-07-02).
- [Client-side command interception on the programmatic input surface](#client-side-command-interception-on-the-programmatic-input-surface): **Binary probe** provenance, **Verified** at `2.1.251`, measured 2026-08-29 by three live `claude -p --output-format stream-json` runs against the on-disk build — command-shaped body, the same body with one prepended newline, and ordinary prose — read side by side from the recorded streams. The section's own text marks which of its statements are the measurement and which are the reading of it; the one general claim the measurement does not support (that any whitespace prefix defeats interception on any build) is explicitly withheld.
- [Control-request registry](#control-request-registry-binary-census), [Result and stream surface](#result-and-stream-surface), [Environment and update control](#environment-and-update-control), and all verbatim schema-description quotations: **Binary probe** provenance, **Verified** at `2.1.245` (the native single-file build described at that pin), censused 2026-08-25 by schema-constructor extraction, and **carried** to `2.1.251` — see the Carried census row in [Version pin](#version-pin) for exactly what the 2026-08-28 pass re-measured and what it did not. Vendor hedges are preserved verbatim; set-closure claims are marked **Derived** because a census cannot prove a set closed.
- [Direction: some censused subtypes are refused BY NAME on the inbound channel](#direction-some-censused-subtypes-are-refused-by-name-on-the-inbound-channel): **Binary probe** provenance, **Verified** at `2.1.251`, measured 2026-08-30 over `-p --input-format stream-json` with one subtype per process and a negative control on every run. What is Verified is the classified answer each subtype drew on the INBOUND channel; the reading that the three refused names are the CLI's own outbound questions is **Derived** from the registry entries and the `--permission-prompt-tool` plumbing recorded above.
- [`system/init` command and skill enumeration](#systeminit-command-and-skill-enumeration--a-live-read-never-a-stored-registry), [Output speed](#output-speed--fast_mode_state-is-this-providers-positive-case), and [`list_models` and the per-model effort vocabulary](#list_models-and-the-per-model-effort-vocabulary) (all added 2026-08-31): **two legs, two grades, and the sections say which is which.** Literal presence — every member name and its occurrence count — is **Binary probe**, **Verified** at `2.1.251`, censused 2026-08-31 by string census of the on-disk native build with a negative control in the same pass. The member shapes, the `on` / `cooldown` / `off` reported vocabulary, and the `slash_commands`-versus-`terminal_slash_commands` invocability distinction are **Cross-reference** provenance and **Derived** trust, read from the shipped `claude-driver` rather than from a frame: this pass observed no `system/init` handshake, no captured handshake fixture exists in-repo, and the [no-authless-probe gap](#gaps-recorded) applies to the family in full.
- The per-model effort **values** on [`list_models`](#list_models-and-the-per-model-effort-vocabulary): **Binary probe**, **Verified**, measured 2026-08-30 by one zero-turn control request, and **carried** into this file rather than re-measured by it — the normative home is [Spec-005 §Provider Parameter Vocabularies](../../specs/005-provider-driver-contract-and-capabilities.md#provider-parameter-vocabularies), with the shipped `CLAUDE_DECLARED_MODEL_CATALOG` golden vector as the **Cross-reference** mirror. The four-model reading includes one model publishing **no** effort surface, which is a declaration and not a gap in the measurement.
- The design-census lineage these entries superseded is recorded in the capability-enhancements design §3.4 (`../../superpowers/specs/2026-07-01-capability-enhancements-design.md`).
