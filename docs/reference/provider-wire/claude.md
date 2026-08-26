# Claude Code Wire Reference

Pinned wire reference for the Claude Code headless CLI as driven by `claude-driver`. See the [family README](README.md) for the TRUST / PROVENANCE vocabulary this file uses.

## Version pin

| Field | Value |
| --- | --- |
| Pinned version | `2.1.245` |
| Census target | the on-disk build `~/.local/share/claude/versions/2.1.245`, addressed by path. **Not** "the installed binary" — the launcher symlink had already moved to `2.1.246` mid-pass, so `claude --version` does not name what was measured. |
| Census artifact | the **platform-native single-file build** (a 359 MB Mach-O arm64 executable with the CLI's JavaScript bundle embedded in it), not a loose `cli.js`. |
| Verified-equivalent build | `2.1.246`. Scoped, not blanket: the control-request subtype registry, the `system/init` capability tokens, the result-subtype set, and the auth / auto-update environment keys are unchanged between the two. Anything not in that list was measured only at `2.1.245`. |
| Supported floor | `2.1.234` — the oldest release `claude-driver` accepts. **Ratified 2026-08-26** by the [Spec-005](../../specs/005-provider-driver-contract-and-capabilities.md) provider-CLI version-tolerance amendment, which raised the mandated floor from `2.1.198` and is the normative home of this value; this table mirrors it. The nightly compatibility check's `floor` leg now exercises enforcement rather than gathering evidence for a pending decision. |
| Primary anchor | a **string census of the pinned binary**, cross-checked against the official docs census (CLI reference + changelog **version anchors**) |
| Censused | 2026-08-25 |
| Docs verified live | 2026-07-02 — CLI reference (`code.claude.com/docs/en/cli-reference`) + changelog (`github.com/anthropics/claude-code` `CHANGELOG.md`, the full-history file — version anchors below cite it, not the docs-site release notes, which truncate old versions) |

The Claude Code changelog **carries no dates** — entries are numbered by version only, so a behavior's floor is pinned by **version anchor** (the release it first appears in), never by date. Release cadence is the reason this file names a floor at all: four distinct builds (`2.1.234`, `2.1.235`, `2.1.245`, `2.1.246`) landed on the authoring machine inside eight days, and the npm dist-tags at authoring were `stable` = `2.1.231`, `latest` = `2.1.246` — so `stable` and `latest` are **not** the same channel, and a doc that says "current" without saying which tag has said nothing.

**Census scope caveat — which artifact was read.** `@anthropic-ai/claude-code` on npm is a **wrapper**: it ships `cli-wrapper.cjs` plus an `install.cjs` postinstall, and the executable itself arrives as a platform-specific optional dependency (`@anthropic-ai/claude-code-<platform>-<arch>`). Installed with build scripts blocked, the wrapper refuses outright — "claude native binary not installed" — so there is no JavaScript-only channel to census. What this file reads is therefore the **native single-file build**, which embeds the JS bundle; the local census target and the platform package's `claude` binary are the same artifact class and byte size. Two consequences: a literal's presence in this census is evidence about the native build (the only one there is), and any CI job that wants to reproduce it must let the postinstall run — an `--ignore-scripts` install yields a wrapper that cannot even report its version. Where a substituted native implementation could differ (bundled search/glob tooling, for instance), a census result is evidence about tooling names, not about protocol shapes.

## The `--help` is non-authoritative rule

Unlike Codex (whose binary emits its own schema), Claude Code has no generated protocol dump, and its `--help` under-reports the surface. The CLI reference states this outright — quoted verbatim (Verified, Official docs, 2026-07-02):

> `claude --help` does not list every flag, so a flag's absence from `--help` does not mean it is unavailable.

**Consequence for this file:** the pinned binary governs, `--help` is a lower bound, and the docs census is the cross-check. Hidden-but-documented flags (`--permission-prompt-tool`, `--max-turns`, `--session-id`, and others below) are normal, not deprecations. Re-verified at this pin: `--resume-session-at` and `--rewind-files` are both absent from `2.1.245 --help` and both present in the binary.

**And the rule's converse, which matters just as much.** A string in the binary is **not** evidence a flag or subtype is available. `--enable-auto-mode` is documented as removed in `2.1.111` and still appears four times in the `2.1.245` census — dead strings survive bundling. Every claim below therefore says which kind of evidence it rests on: registry membership, a dispatcher arm, an exit-code probe, or vendor prose. Presence alone is never promoted to availability.

## CLI / wire surface

Flags and behaviors this project drives, each with its version anchor where one exists, its provenance, and its trust. "Docs" = the live CLI reference; "Changelog" = the versioned changelog; both fetched 2026-07-02. **Changelog anchors are earliest-mention anchors, not introduction floors** — most entries are fixes that presuppose the flag; a cell is an introduction only where the quoted entry itself introduces the flag.

| Surface | Version anchor | Provenance | Trust | Note |
| --- | --- | --- | --- | --- |
| `--agents` (JSON subagent defs) | introduced `2.0.0` (changelog: "Add subagents dynamically with `--agents` flag") | Official docs | Documented | Same field names as subagent frontmatter + a `prompt` field. |
| `--mcp-config` / `--strict-mcp-config` | `--mcp-config` introduced `0.2.75`; `--strict-mcp-config` mentions from `2.1.143` (changelog: "`/bg` now preserves `--mcp-config`, `--settings`, `--add-dir`, `--plugin-dir`, and `--strict-mcp-config`"; introduction not stated) | Official docs | Documented | `--strict-mcp-config` strips non-explicit inline `mcpServers`; since `2.1.153` it "no longer strips inline `mcpServers` from explicitly-passed agent definitions (`--agents` / SDK `agents`)" (changelog). The ephemeral-relaunch MCP-scoping path. |
| `--json-schema` (structured output) | mentions from `2.1.84` (introduction not stated in the changelog) | Official docs | Documented | Validated JSON output after the workflow; pairs with the structured-output result surface. |
| `--bg` / `--background` | mentions from `2.1.140` (changelog: "Fixed `claude --bg` failing with 'connection dropped mid-request'…"; introduction not stated) | Official docs | Documented | Background session creation. |
| `--resume`, `-r` | background-in-picker "As of `v2.1.144`" (docs) | Official docs | Documented | Resume by ID or name; ID search is scoped to the project dir + its git worktrees. |
| `--fork-session` | present in the `2.1.245` census | Binary probe | Verified | On resume, mint a new session ID instead of reusing the original. |
| `--session-id` | — | Official docs | Documented | Pin a specific conversation session ID (must be a valid UUID) — deterministic session binding. |
| `--replay-user-messages` | — | Official docs | Documented | Re-emit stdin user messages on stdout for ack; requires `--input-format stream-json` + `--output-format stream-json`. The rewind targets (message UUIDs) appear on the wire only when this is set. |
| `--permission-prompt-tool` | — | Official docs | Documented | Names an MCP tool to handle permission prompts in non-interactive mode. |
| `--max-budget-usd` | — | Official docs | Documented | Native per-run USD cap (print mode): stops spending on API calls when the cap is reached. Wired as defense-in-depth beneath the daemon budget accountant, not as the authority. |
| `--max-turns` | — | Official docs | Documented | Caps agentic turns (print mode); errors at the limit. |
| `--safe-mode` | min-version `2.1.169` (docs) | Official docs | Documented | Disables customizations for troubleshooting; distinct from `--bare`. |
| `--resume-session-at` | present in the `2.1.245` census; absent from that build's `--help` and from the docs page | Binary probe | Verified | The message-UUID rewind target for the Claude session-time-travel leg. See [Gaps recorded](#gaps-recorded). |
| `--resume-drops-turn`, `--reply-on-resume`, `--no-session-persistence` | present in the `2.1.245` census | Binary probe | Verified | The resume-behavior family around `--resume` / `--fork-session`. Semantics are not asserted here — only that the flags exist at the pin. |
| `--rewind-files` | present in the `2.1.245` census | Binary probe | Verified | The file-side companion to conversation rewind. Its control-request counterpart `rewind_files` is explicitly refused in cloud-hosted sessions (see below), so treat it as host-context-dependent. |
| `--enable-auto-mode` | **removed in `2.1.111`** (docs); string still present in the `2.1.245` census | Official docs | Documented | A version-ceiling anchor: gone as of `2.1.111`; auto mode moved into the `Shift+Tab` cycle (`--permission-mode auto`). Its surviving string is this file's worked counterexample to reading presence as availability. |

## Control protocol and result surface

Everything below is reproduced from the pinned binary. At the previous pin this section was a design-census summary carrying **Cross-reference** provenance and **Derived** trust; the census replaces that lineage with direct observation, and each subsection states its own evidence kind.

### Control-request registry (binary census)

At `2.1.245` the control-request subtype registry is directly observable in the binary as a set of schema constructors. Each subtype below appears **exactly once** in the census (**Binary probe** provenance, **Verified** trust at `2.1.245`):

`interrupt`, `set_permission_mode`, `can_use_tool`, `set_model`, `get_usage`, `get_context_usage`, `get_session_cost`, `list_models`, `get_binary_version`, `apply_flag_settings`, `rewind_files`, `hook_callback`, `elicitation`, `request_user_dialog`, `mcp_message`.

This **upgrades the previous pin's design-census entry from Derived to Verified** for the three subtypes it named (`interrupt`, `set_permission_mode`, `can_use_tool`) and adds the rest. Counterexample hunt, run against the same census so the set above is not read as more than it is: `set_effort`, `rewind`, and `compact` are **absent** as control-request subtypes (count 0) — so the registry is not simply "every control verb one might expect".

**Registry membership is not availability.** The dispatcher answers an unsupported subtype with a typed refusal rather than silence. Quoted verbatim from the `2.1.245` dispatcher arm for `get_usage`:

> get_usage is not supported in this context (onGetUsage callback not registered)

emitted as `{ type: "control_response", response: { subtype: "error", request_id, error } }`. A sibling arm shows the same shape for `get_context_usage`. Separately, a **cloud-hosted-session** gate rejects `rewind_files` outright and constrains `apply_flag_settings` ("apply_flag_settings keys not available in a cloud-hosted session: …"). So a driver must treat every control request as **feature-detected at call time**: send it, and classify the typed `control_response` error, rather than deciding availability from a version number.

**And the census is a lower bound, not an upper one** (added 2026-08-26; **Binary probe**, **Verified** at `2.1.234`, `2.1.245`, and `2.1.246`). The rule above says a censused subtype may still refuse. The converse is also true and is the sharper trap: a subtype **absent** from the census above may still answer. `mcp_set_servers` — the live server-set reconcile the SDK exposes as `setMcpServers` — appears in none of those three builds' censused subtype registries, and at all three it answers `{"subtype":"success","response":{"added":[],"removed":[],"errors":{}}}` over `-p --input-format stream-json` with no user message sent and no billed turn. Each probe was run beside a negative control (`zzq_nonexistent_subtype`, refused every time with the typed `Unsupported control request subtype: …`), so the successes are not an artifact of a dispatcher that accepts anything. The desired set sent was **empty**, so what is Verified here is that the subtype dispatches and returns the documented reconcile envelope; a non-empty mutation is outside this probe's reach and is measured by the consumer that performs one. Two consequences: this file's registry list is evidence about what the census could see, never a completeness claim; and neither presence nor absence in it may decide a capability — only the probe's own classified answer may.

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

### Result and stream surface

**Result census** (Binary probe, Verified at `2.1.245`). Result subtypes `success | error_max_turns | error_max_budget_usd | error_during_execution | error_max_structured_output_retries`; the `result` field is present only on `success`; trailing events (e.g. `prompt_suggestion`) can arrive **after** `result`, so the driver read-loop reads to EOF rather than breaking on `result`. The structured-output failure carries its own prose: `error_max_structured_output_retries` fires when "the cloud agent called StructuredOutput but no attempt produced a surviving valid output".

**Mid-session retry taxonomy** (Binary probe, Verified at `2.1.245`). The emitted shape is `{ type: "system", subtype: "api_retry", attempt, max_retries, retry_delay_ms, error_status, error }` — note `error_status` alongside the typed `error`, and that the mapping arm is `system/api_error` → `system/api_retry`. The typed error members `authentication_failed`, `oauth_org_not_allowed`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `unknown` are present as literals; the union's exact arity is **Derived**, since a string census cannot prove a set is closed.

**Adjacent stream subtypes present at the pin** (Binary probe, Verified): `rate_limit_event`, `compact_boundary`, `command_lifecycle`, `queued_notification`, and the model-refusal pair `model_refusal_fallback` / `model_refusal_no_fallback`. `rate_limit_event` matters to the daemon's rate-limit surface: it is a **push** channel that does not require the experimental `get_usage` round trip, and is the preferred carrier where both are available.

## Environment and update control

Environment keys present at `2.1.245` (Binary probe, Verified) that a supervising daemon or CI job must know about:

| Key | Why it matters |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Relocates the configuration home — the basis for isolating a spawned session from the operator's own state. |
| `CLAUDE_SECURESTORAGE_CONFIG_DIR` | Relocates the **secure-storage** home specifically, and is the one key in its group whose **empty-string value is honored rather than skipped** — the census shows the env-collection loop `continue`s on an empty value for every key except this one, and the child-process command builder forwards it whenever it is defined at all, empty included. So "set but empty" is a meaningful, distinct state here. Treat clearing it and unsetting it as different acts. |
| `CLAUDE_CODE_OAUTH_TOKEN` | The long-lived headless credential (minted by `claude setup-token`). It is a credential: never echo it, never persist it, never write it to a workspace. |
| `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES` | Pin the running build for the life of a process. Required for any measurement to mean anything — an unpinned CLI can move mid-run, which is exactly how this pin's census target and `claude --version` came apart. **Presence-style gate: set to `1`.** |
| `requiredMinimumVersion`, `requiredMaximumVersion`, `autoUpdatesChannel` | The vendor's own managed version-gating keys. Their existence is why a floor/ceiling policy is expressible at all on this provider. |

## Gaps recorded

Honest gaps between what the pinned binary shows and what the vendor documents — recorded rather than papered over. The first two were opened at the previous pin and are now **partly closed by measurement**:

- **`--resume-session-at` — closed on the binary side, still open on the docs side.** At the previous pin this flag was known only from a design census. It is now **Verified present** in the `2.1.245` binary and **Verified absent** from that same build's `--help` output, so the docs-vs-binary divergence is confirmed from both directions rather than asserted. It remains **absent from the live CLI reference** fetched 2026-07-02. This is the `--help`-non-authoritative rule in action. `--fork-session` and `--session-id` are the confirmed companions.
- **`--bare` becoming the print-mode default — still open, still Provisional.** The design census (C-15) records that the docs state `--bare` "will become the default for `-p` in a future release" — a modal, forward-looking claim (hedge preserved as written). That exact sentence was **not** found on the CLI reference page fetched 2026-07-02; the page describes `--bare` as a minimal mode (skips hook/skill/plugin/MCP/memory auto-discovery; Bash + file-read + file-edit tools only). The `--bare` literal is present at `2.1.245`, which says nothing about the default. Treat the "future default" claim as **Provisional** and design-census-sourced until re-confirmed against the live docs. It matters because the flip would break OAuth headless driving (`--bare` strips OAuth/keychain), so it is a version floor/ceiling risk, not a routine flag.
- **No authless protocol probe exists for this provider.** Claude Code's `-p` path needs credentials to reach a handshake, so — unlike Codex, whose `initialize` answers on a scratch home with no account — there is no way to observe Claude's stream-json handshake without a token. The nightly compatibility check therefore measures this provider through version reporting, argument-acceptance exit codes, and the control-request registry census, and reaches a real handshake only on the optional authenticated leg. Any claim about live Claude wire behavior in a governing doc must name which of those it rests on.

## Driver fixtures

Captured-wire fixtures for the Claude event-normalizer are cited as text (they do not exist yet): `packages/runtime-daemon/src/provider/drivers/claude/__fixtures__/` — lands with Plan-005 Phase 3.

## Provenance

- Rows in [CLI / wire surface](#cli--wire-surface) marked **Official docs**: pinned to the version anchors shown; docs verified live 2026-07-02. Rows marked **Binary probe** were reproduced against `2.1.245` on 2026-08-25.
- The `--help`-non-authoritative quote: **Official docs**, **Verified** (fetched 2026-07-02).
- [Control-request registry](#control-request-registry-binary-census), [Result and stream surface](#result-and-stream-surface), [Environment and update control](#environment-and-update-control), and all verbatim schema-description quotations: **Binary probe** provenance, **Verified** at `2.1.245` (the native single-file build described in [Version pin](#version-pin)), censused 2026-08-25. Vendor hedges are preserved verbatim; set-closure claims are marked **Derived** because a census cannot prove a set closed.
- The design-census lineage these entries superseded is recorded in the capability-enhancements design §3.4 (`../../superpowers/specs/2026-07-01-capability-enhancements-design.md`).
