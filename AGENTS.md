# AGENTS.md

Cross-tool conventions for AI coding agents working in this repository (Claude Code, Codex CLI, Cursor, Aider, etc.). Tool-specific behavior lives in per-tool instruction files; conventions that must hold _across_ tools live here.

## Per-Tool Instruction Files

- `CLAUDE.md` (Claude Code) — checked into git at the project root; team-shared instructions for the Claude Code CLI
- Per-tool instruction files for other agents follow the file's home convention (e.g. `.codex/`, `.cursor/`)

When tool-specific guidance conflicts with this file, this file wins for _cross-tool conventions_ (the items below). Per-tool files own everything else.

## Research-Artifact Convention

Subagents conducting research (current-state checks, primary-source verification, version surveys, API-shape investigations) MUST write findings to:

```text
.agents/tmp/research/<topic>/<axis>.md
```

- `<topic>` — the consuming ADR / spec / plan / backlog item the research informs (e.g. `adr-023-ci-cd`, `bl-097-workflow-engine`)
- `<axis>` — one file per parallel-fan-out subagent (each axis owns its own file to avoid Read-modify-write races on shared files when subagents run concurrently)

`.agents/tmp/research/` is **gitignored** at repo root. The location is provider-neutral, outside the docs corpus, and never committed.

### Surface-Forward-Then-Delete Pattern

Research artifacts are transient drafting locations, not authoritative state.

1. **Draft** — subagents write findings (citations + extracted claims) under `.agents/tmp/research/<topic>/<axis>.md`
2. **Surface forward** — the parent agent extracts citations into the consuming ADR/spec/plan References section per the doc-type's citation pattern:
   - **ADRs**: `### Research Conducted` table — `Source | Type | Key Finding | URL/Location`
   - **Specs**: inline citations in body prose + per-section `### References` blocks
   - **Plans**: flat `## References` list at end of file
   - **Architecture / schema docs**: inline citation pattern matching neighboring docs
3. **Delete** — the agent that drafted a research file deletes it before the consuming-doc commit lands

**No hook enforces step 3.** Deletion is author discipline, not tooling: no pre-commit or CI job prunes `.agents/tmp/`, deliberately — an unconditional prune would shift responsibility off the drafting agent and weaken the surface-forward check that step 3 exists to force, and `.agents/tmp/` also holds working state that intentionally outlives a single commit (housekeeper manifests, smoke-test working directories, POC scaffolds), which a blanket prune would destroy. The obligation therefore reads as an obligation, never as a description of what the harness does: because nothing collects them, undeleted research files accumulate in a working checkout until an agent or the author removes them, and finding leftovers there is evidence of a missed step 3, not of a failed hook. Prune them by hand when you notice them.

### Why This Pattern

Tracked-but-transient research has empirically failed in this repo (two prior revisions). When research files persist, they accumulate inbound citations that split authoritative truth between the research file and the consuming doc. The 2026-04-25 audit found ~140+ inbound citations into `docs/research/` files that paralleled approved corpus docs.

The fix: research files live entirely outside the docs corpus (gitignored, provider-neutral location), and authority lives only in the consuming doc once citations are surfaced forward.

### Verification Before Deletion

Before deleting a research file, verify:

- (a) Zero inbound citations to `.agents/tmp/research/<file>` from anywhere in the docs corpus (trivially true by construction — gitignored top-level dirs cannot be linked from canonical docs)
- (b) Embed-log claims in the consuming doc match the actual subagent findings (anti-hallucination check — the extracted claim must be supported by the cited primary source the subagent surfaced)

## Citation Standard

Every non-trivial claim in a spec, ADR, plan, or architecture doc must cite a primary source — official documentation, upstream issue, original benchmark, RFC, vendor announcement, NIST/IETF/W3C publication.

A hostile reviewer should be able to follow every citation to a primary source that confirms the claim. If a citation cannot survive that test, tighten the wording or remove the claim.

When claims depend on recent data (post-knowledge-cutoff or fast-moving libraries), spawn the most capable model available as a research subagent and verify with `WebSearch` / `WebFetch` against current-year primary sources before recommendations land.

### Durable-Cite Rule (repo-internal citations)

Cite volatile targets by durable form, not raw line number:

- **Code under `packages/` + `apps/`** — `` `<path>.ts#<exportedSymbol>` `` (repo-relative path, `#`, an exported identifier or test name present in the file). New raw `` `<path>.ts:NNN` `` line-pins into these trees are denied by the docs-corpus gate.
- **Specs / plans / ADRs** (cited from code comments or docs) — `` `Spec-NNN §Heading` `` (backticked; § + the exact heading text; likewise `Plan-NNN §…` / `ADR-NNN §…`). The gate verifies the heading exists in the resolved doc. A label-less governance doc (domain / architecture / operations) takes the same anchor with its path in place of the token — `` `docs/<path>.md §Heading` `` — gate-verified the same way. A heading whose in-doc spelling carries inline code ticks is cited WITHOUT them (an inner backtick would terminate the anchor); the gate's normalize-match accepts either spelling.
- **Docs → docs** — markdown link + `#fragment` anchor (lychee-floored), or the same backticked §-anchor forms as above. Raw volatile line cites in `.md` citers are DENIED by the docs-corpus gate in every spelling — label colon (`Spec-NNN:LL`), the spaced / §-bridged / parenthesized colon variants (`Spec-NNN :LL`, `Spec-NNN §Heading:LL`, `Spec-NNN §Heading (:LL-MM, …)`) with the locator digits flush against the colon (colon-space quotes a section VALUE, not a line), a colon locator appended after a durable backticked anchor (`` `Spec-NNN §Heading`:LL ``, label and `docs/<path>.md §Heading` anchors alike), the task-coordinate colon (`Plan-NNN T4.5:LL`), docs-path colon (`docs/<path>.md:LL`, fragment-bearing included), markdown-link colon (`[text](<path>.md):LL` in any valid destination spelling — fragment, angle-bracketed, titled in any CommonMark title delimiter), explicitly relative `../` spellings (resolved against the citer), the `line LL` word forms, and wrap-split pairs (label or path ending one line, the locator opening the next). Pre-commit denies staged citers; CI re-denies corpus-wide on every PR.
- **Raw `:NNN` stays legal for frozen content** (`docs/archive/`, `docs/reference/`) — frozen trees never shift after landing, and the gate still floors those pins so a typo fails loudly. The 2026-07 corpus-wide sweep converted every legacy volatile line cite, so there is no grandfathered residue: a new raw line cite is a defect, not debt.
- **Md-deny exemptions** (each deliberate, each visible in review): fenced blocks (block-quoted fences included); lines carrying the `<!-- cite-shape-example -->` waiver marker (illustrative cite shapes in rule text and catalog rows, never live cites); `docs/superpowers/` campaign logs (dated design-time provenance) and `.claude/` harness docs (rule text) as citer trees; and — per namespace carve-out (1) below — plan grammar lines bearing the bold `**Spec coverage:**` / `**Verifies invariant:**` markers (exactly preflight Gate 4's parse boundary, marker-bearing table rows included; a marker-less plan table row is ordinary prose and stays denied).

A durable cite may carry a free advisory locator — e.g. `` `packages/contracts/src/session.ts#SessionSubscribeRequest` (near the wire-contract comment banner) `` — no gate reads the parenthetical. (That example is live: the gate verifies it on every commit.)

Three adjacent namespaces are deliberately OUTSIDE this rule: (1) plan Tasks-block cite grammar (`Spec-NNN row N`, AC forms, line hints) — preflight Gate 4 + the plan-readiness audit runbook own that lifecycle, and docs→docs cites retain all their existing forms; (2) ephemeral locators — reviewer finding-locations, subagent briefs, and housekeeper manifest line-ranges keep `file:line` (they anchor to a diff or a run, not to the corpus; committed EXAMPLES of them use the `<file>:<start>-<end>` placeholder shape, which no gate parses); (3) code→code cites in code comments — convention-forward `#symbol` is preferred for new ones, but no gate applies.

## Subagent Dispatch Convention

When dispatching parallel research subagents, ensure file targets are disjoint to avoid Read-modify-write race conditions on shared files (e.g., `docs/backlog.md`). When multiple tasks must touch the same file, dispatch serially.

## Model Policy

Model selection resolves through a cascade; each layer stays silent unless it expresses a deliberate deviation:

1. **Explicit override** — a `model:` parameter on a single dispatch, or a user directive for the session. Reserved for deliberate deviations.
2. **Agent definition** — `.claude/agents/*.md` declare `model: inherit`.
3. **Session model** — whatever the user selected for the running session.
4. **Harness default** — the vendor-curated frontier model, which updates automatically as new models ship.

In practice:

- **Omit `model` on dispatch.** Subagents inherit the session model for every role (research, audit, implementation, review). Pass `model:` only to deliberately deviate, and record why.
- **Default working model: the latest Opus at 1M context** (Opus 4.8 today) — the project's standing choice for substantive work. This names the _line_, never a pinned _version_: "the latest Opus" tracks each release (4.7 → 4.8 → …) and never rots, so it refines the no-model-by-name rule below (which bars a frozen `Opus 4.8` as a hard requirement) instead of contradicting it. It is a default, not a gate — an explicit `model:` override still wins for a deliberate per-role deviation (e.g., a cheaper tier for codebase search or other mechanical work).
- **No committed file may require a model by name.** Where calibrated work needs a quality floor, express it as a tier class ("refuse if you identify as a small/fast-tier model"), never as a name — a name freezes the then-current frontier and rots at the next model ship.
- **Attribution strings** (`Co-Authored-By:` trailers) derive from the running model's harness-provided identity. Dated examples are fine; hardcoded requirements are not.

Historical records (ADR decision logs, plan author rows, archived session narratives) keep the model names they were written with — they record provenance, not policy. Likewise, a separate tool's own root config (e.g. `.codex/config.toml`) may pin an operational model directly — there the `model` field is an optional override, so naming one is a deliberate per-tool choice, not one of this project's calibrated-work quality floors. Such operational tool config sits outside this rule's scope.

## Doc-First Discipline

Code execution is gated on the governing doc surface (specs, ADRs, plans, backlog items) being complete. Before a code-execution plan ships its first PR, every cross-referenced spec, ADR, and plan must have completed the status promotion its type's status lifecycle requires, and every blocking backlog item must be `completed` (or explicitly deferred with a named gate).

This discipline binds plan-task shipment: the plan's first PR as above, and every PR that adds or completes manifest-tracked tasks. Post-completion enhancements to shipped code (changes within the approved spec envelope) and repo tooling/infra work take the lighter lanes defined in `CONTRIBUTING.md` §How Code Lands: Work Classification. A change that would alter a plan invariant or a spec Required Behavior / Acceptance Criteria row is not an enhancement — the spec or plan amends first.

The full doc-first ordering for V1 lives in `docs/architecture/cross-plan-dependencies.md` (tier graph) and the per-plan Preconditions sections.
