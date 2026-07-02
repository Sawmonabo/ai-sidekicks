# Provider Wire Reference

Version-pinned reference for the wire surfaces of the two provider CLIs the local runtime daemon drives: the Codex `app-server` JSON-RPC protocol (`codex-driver`) and the Claude Code headless CLI (`claude-driver`). Each provider file pins the shapes it documents to a specific CLI version and labels every claim on two independent axes — how much we **trust** the shape is correct and current (the TRUST axis), and **where the claim came from** (the orthogonal PROVENANCE axis).

These are **non-governance** reference docs (the `docs/reference/` tree): no status lifecycle, no cross-plan ownership-map row. They exist so that spec and plan amendments describing provider wire behavior cite a stable, version-anchored target instead of hand-transcribing shapes that rot as the CLIs move (both ship frequently). The provider drivers regenerate their own bindings from the pinned binary at build time; these docs are the human-readable pin, not the source of truth the code compiles against.

## Files

| File | Provider | Pinned version | Anchor |
| --- | --- | --- | --- |
| [`codex.md`](codex.md) | Codex CLI (`codex app-server`) | `codex-cli 0.141.0` | the binary's own generated schema |
| [`claude.md`](claude.md) | Claude Code headless CLI | `2.1.198` | the official docs census + changelog version anchors |

## The two axes: TRUST and PROVENANCE

Every wire claim in these files carries two labels. They answer different questions and **must not be collapsed into one scale** — that conflation is the mistake this vocabulary exists to prevent (see [Why the axes stay orthogonal](#why-the-axes-stay-orthogonal) below).

### TRUST — how sure are we the shape is correct and current at the pinned version?

Four grades, most to least confident:

| Grade | Meaning |
| --- | --- |
| **Verified** | Reproduced against the pinned binary this authoring pass — regenerated schema, string-census of the pinned binary, or an observed runtime probe. |
| **Documented** | Stated in the vendor's official reference or changelog for the pinned version, but not independently reproduced here. |
| **Derived** | Deduced from adjacent evidence (a sibling type, an enum member, a related method) rather than stated or reproduced directly. |
| **Provisional** | Asserted but unconfirmed at the pin, or upstream-gated / under active development / explicitly hedged. Preserve the source's modal hedge — never upgrade a "may/should" to a "must/always". |

### PROVENANCE — where did the claim come from?

An orthogonal axis recording the source of each claim, most to least authoritative. Its top grade is **Generated schema** — the vendor's own binary emitting its exact protocol:

| Grade | Source |
| --- | --- |
| **Generated schema** | The provider binary's own schema/binding generator (Codex `app-server generate-json-schema` / `generate-ts`). **Canonical over prose docs**: when a generated shape and a prose doc disagree, the generated shape wins (a docs hallucination was caught this way during verification). |
| **Official docs** | The vendor's published reference or changelog, cited by version anchor. |
| **Binary probe** | `--version` / `--help` output, a string-census of the pinned binary, or observed wire traffic. |
| **Cross-reference** | Deduction from adjacent in-repo evidence (a spec, an ADR, the campaign design census). |

### Why the axes stay orthogonal

A prior draft of this vocabulary proposed a **fifth TRUST grade, "schema-generated"**, ranked above Verified. That grade is **rejected and stays rejected.** Schema generation is a *source*, not a *confidence level*: a generated shape is **Verified**-trust because it was reproduced at the pin, and its origin is recorded independently as **Generated schema** provenance. Folding the two loses the cases where they move apart:

- **Same provenance, lower trust.** The Codex shapes in [`codex.md`](codex.md) are **Generated schema** provenance and **Verified** at `0.141.0` — but `0.142.5` is the current stable, a minor ahead. Read against that newer stable, the identical generated shapes are only **Provisional** (they may have drifted). Provenance unchanged; trust dropped. A single "schema-generated" grade could not express this.
- **High provenance, only Documented trust.** A Claude flag lifted verbatim from the official CLI reference is **Official docs** provenance but only **Documented** trust until a probe reproduces it.

So the rule is: **record trust and provenance separately; never derive one from the other.** The corpus's schema-generated notion is preserved — as the *top of the PROVENANCE axis*, not as a trust grade.

## Versioning and pinning policy

- **Pin to an exact version.** Each provider file names the CLI version its shapes were verified against and never floats. Codex pins to the installed `0.141.0`; Claude pins to `2.1.198`. Where a behavior first appeared in a known release, the file records that release as a **version anchor** (the Claude changelog carries no dates, so version is the only stable anchor).
- **Re-verify at authoring time, not once.** Both CLIs ship often — Codex a minor every 1–2 weeks plus near-daily alphas; Claude a stream of point releases. A doc consuming these pins re-verifies its own load-bearing claims against the then-current binary rather than trusting an audit date. Perishability is the default assumption.
- **Regenerate, don't transcribe.** Codex protocol claims are regenerated from the binary (command + version recorded in [`codex.md`](codex.md)); hand-transcription of the Codex wire is prohibited. Claude claims cite the docs census + changelog anchors, because `claude --help` is documented as non-authoritative (a flag's absence from `--help` does not mean it is unavailable) — see [`claude.md`](claude.md).

These three rules are adopted campaign-wide; the capability-enhancements design §3.4 is the provenance record for the audit that established them (`../../superpowers/specs/2026-07-01-capability-enhancements-design.md`).

## How consuming docs cite these files

- A spec or plan describing provider wire behavior adds a `Reference:` line linking the relevant provider file, rather than restating the shape inline. The link target is these files; keep the cite section-level (the pinned version is stated in the file header) so it survives regeneration.
- **Driver fixture paths are cited as plain text, not links.** The captured-wire fixtures the drivers test their normalizers against do not exist yet — they land with Plan-005 Phase 3. Each provider file names its fixtures path as text with that marker, so the cite records intent without a dangling link.
