# Claude Code Wire Reference

Pinned wire reference for the Claude Code headless CLI as driven by `claude-driver`. See the [family README](README.md) for the TRUST / PROVENANCE vocabulary this file uses.

## Version pin

| Field | Value |
| --- | --- |
| Pinned version | `2.1.198` (current stable at authoring) |
| Primary anchor | the official **docs census** (CLI reference + changelog **version anchors**) |
| Verified live | 2026-07-02 — CLI reference (`code.claude.com/docs/en/cli-reference`) + changelog (`github.com/anthropics/claude-code` `CHANGELOG.md`, the full-history file — version anchors below cite it, not the docs-site release notes, which truncate old versions) |

The Claude Code changelog **carries no dates** — entries are numbered by version only, so a behavior's floor is pinned by **version anchor** (the release it first appears in), never by date. `2.1.198` is the highest version present at authoring.

## The `--help` is non-authoritative rule

Unlike Codex (whose binary emits its own schema), Claude Code has no generated protocol dump, and its `--help` under-reports the surface. The CLI reference states this outright — quoted verbatim (Verified, Official docs, 2026-07-02):

> `claude --help` does not list every flag, so a flag's absence from `--help` does not mean it is unavailable.

**Consequence for this file:** the docs census governs, and `--help` is treated as a lower bound, not a census. Hidden-but-documented flags (`--permission-prompt-tool`, `--max-turns`, `--session-id`, and others below) are normal, not deprecations. When even the docs page omits a flag the binary honors (see [`--resume-session-at`](#gaps-recorded) below), the pinned binary itself is the anchor of last resort.

## CLI / wire surface

Flags and behaviors this project drives, each with its version anchor where one exists, its provenance, and its trust. "Docs" = the live CLI reference; "Changelog" = the versioned changelog; both fetched 2026-07-02. **Changelog anchors are earliest-mention anchors, not introduction floors** — most entries are fixes that presuppose the flag; a cell is an introduction only where the quoted entry itself introduces the flag.

| Surface | Version anchor | Provenance | Trust | Note |
| --- | --- | --- | --- | --- |
| `--agents` (JSON subagent defs) | introduced `2.0.0` (changelog: "Add subagents dynamically with `--agents` flag") | Official docs | Documented | Same field names as subagent frontmatter + a `prompt` field. |
| `--mcp-config` / `--strict-mcp-config` | `--mcp-config` introduced `0.2.75`; `--strict-mcp-config` mentions from `2.1.143` (changelog: "`/bg` now preserves `--mcp-config`, `--settings`, `--add-dir`, `--plugin-dir`, and `--strict-mcp-config`"; introduction not stated) | Official docs | Documented | `--strict-mcp-config` strips non-explicit inline `mcpServers`; since `2.1.153` it "no longer strips inline `mcpServers` from explicitly-passed agent definitions (`--agents` / SDK `agents`)" (changelog). The ephemeral-relaunch MCP-scoping path. |
| `--json-schema` (structured output) | mentions from `2.1.84` (introduction not stated in the changelog) | Official docs | Documented | Validated JSON output after the workflow; pairs with the structured-output result surface. |
| `--bg` / `--background` | mentions from `2.1.141` (`/bg` family; introduction not stated in the changelog) | Official docs | Documented | Background session creation. |
| `--resume`, `-r` | background-in-picker "As of `v2.1.144`" (docs) | Official docs | Documented | Resume by ID or name; ID search is scoped to the project dir + its git worktrees. |
| `--fork-session` | — | Official docs | Documented | On resume, mint a new session ID instead of reusing the original. |
| `--session-id` | — | Official docs | Documented | Pin a specific conversation session ID (must be a valid UUID) — deterministic session binding. |
| `--replay-user-messages` | — | Official docs | Documented | Re-emit stdin user messages on stdout for ack; requires `--input-format stream-json` + `--output-format stream-json`. The rewind targets (message UUIDs) appear on the wire only when this is set. |
| `--permission-prompt-tool` | — | Official docs | Documented | Names an MCP tool to handle permission prompts in non-interactive mode. |
| `--max-budget-usd` | — | Official docs | Documented | Native per-run USD cap (print mode): stops spending on API calls when the cap is reached. Wired as defense-in-depth beneath the daemon budget accountant, not as the authority. |
| `--max-turns` | — | Official docs | Documented | Caps agentic turns (print mode); errors at the limit. |
| `--safe-mode` | min-version `2.1.169` (docs) | Official docs | Documented | Disables customizations for troubleshooting; distinct from `--bare`. |
| `--enable-auto-mode` | **removed in `2.1.111`** (docs) | Official docs | Documented | A version-ceiling anchor: gone as of `2.1.111`; auto mode moved into the `Shift+Tab` cycle (`--permission-mode auto`). |

## Control protocol and result surface (design census)

The following are pinned to the capability-enhancements design §3.4 CLI-surface census (dated 2026-07-02, built partly from a `2.1.198` binary string-census). They were **not** present on the CLI reference / changelog pages fetched this pass — consistent with the `--help`-non-authoritative rule — so they carry **Cross-reference** provenance (design census), not Official-docs provenance, and **Derived** trust (deduced from the census's binary string-evidence, per this family's grade definitions — not vendor-stated, so never `Documented`). Re-verify against the pinned binary before treating any as load-bearing.

- **Control protocol.** A `control_request` / `control_response` envelope carrying `interrupt` and `set_permission_mode`; the `can_use_tool` round trip is the `--permission-prompt-tool` plumbing (`{tool_name, input}` → `{behavior: allow | deny, updatedInput?, message?}`).
- **Result census.** Result subtypes `success | error_max_turns | error_max_budget_usd | error_during_execution | error_max_structured_output_retries`; the `result` field is present only on `success`; trailing events (e.g. `prompt_suggestion`) can arrive **after** `result`, so the driver read-loop reads to EOF rather than breaking on `result`.
- **Mid-session retry taxonomy.** `system/api_retry` carries a typed error enum (`authentication_failed | oauth_org_not_allowed | billing_error | rate_limit | overloaded | invalid_request | model_not_found | server_error | max_output_tokens | unknown`) plus `retry_delay_ms`.

## Gaps recorded

Honest gaps between the design census and the live pages fetched 2026-07-02 — recorded rather than papered over:

- **`--resume-session-at`** (the message-UUID rewind target for the Claude session-time-travel leg, cited in the design §5.1 rollback mechanism) is **absent from the live CLI reference** fetched this pass. It is pinned to the design's `2.1.198` **binary string-census** (Binary probe provenance), not to the docs page. This is itself the `--help`-non-authoritative rule in action: a flag the census found in the binary that the public docs page does not list. `--fork-session` and `--session-id` (both docs-listed above) are the confirmed companions.
- **`--bare` becoming the print-mode default.** The design census (C-15) records that the docs state `--bare` "will become the default for `-p` in a future release" — a modal, forward-looking claim (hedge preserved as written). That exact sentence was **not** found on the CLI reference page fetched this pass; the page describes `--bare` as a minimal mode (skips hook/skill/plugin/MCP/memory auto-discovery; Bash + file-read + file-edit tools only). Treat the "future default" claim as **Provisional** and design-census-sourced until re-confirmed against the live docs. It matters because the flip would break OAuth headless driving (`--bare` strips OAuth/keychain), so it is a version floor/ceiling risk, not a routine flag.

## Driver fixtures

Captured-wire fixtures for the Claude event-normalizer are cited as text (they do not exist yet): `packages/runtime-daemon/src/provider/drivers/claude/__fixtures__/` — lands with Plan-005 Phase 3.

## Provenance

- Rows in [CLI / wire surface](#cli--wire-surface): **Official docs** provenance, **Documented** trust, pinned to `2.1.198` with the version anchors shown; verified live 2026-07-02.
- The `--help`-non-authoritative quote: **Verified** (fetched 2026-07-02).
- [Control protocol and result surface](#control-protocol-and-result-surface-design-census) and both [gaps](#gaps-recorded): **Cross-reference** / **Binary probe** provenance (design §3.4 census, `../../superpowers/specs/2026-07-01-capability-enhancements-design.md`), not reproduced live here; modal hedges preserved.
