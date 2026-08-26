# Provider Wire Reference

Version-pinned reference for the wire surfaces of the two provider CLIs the local runtime daemon drives: the Codex `app-server` JSON-RPC protocol (`codex-driver`) and the Claude Code headless CLI (`claude-driver`). Each provider file pins the shapes it documents to a specific CLI version and labels every claim on two independent axes — how much we **trust** the shape is correct and current (the TRUST axis), and **where the claim came from** (the orthogonal PROVENANCE axis).

These are **non-governance** reference docs (the `docs/reference/` tree): no status lifecycle, no cross-plan ownership-map row. They exist so that spec and plan amendments describing provider wire behavior cite a stable, version-anchored target instead of hand-transcribing shapes that rot as the CLIs move (both ship frequently). The provider drivers regenerate their own bindings from the pinned binary at build time; these docs are the human-readable pin, not the source of truth the code compiles against.

## Files

| File                   | Provider                       | Pinned version      | Supported floor | Anchor                                                   |
| ---------------------- | ------------------------------ | ------------------- | --------------- | -------------------------------------------------------- |
| [`codex.md`](codex.md) | Codex CLI (`codex app-server`) | `codex-cli 0.149.1` | `0.141.0`       | the binary's own generated schema + the tagged upstream source |
| [`claude.md`](claude.md) | Claude Code headless CLI     | `2.1.245`           | `2.1.234`       | a string census of the pinned binary + the official docs census |

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
| **Upstream source** | The vendor's own published source, read at a **release tag** (e.g. `openai/codex` `rust-v0.149.1`). Records what the generator cannot: runtime gating, attribute markers, and dispatcher behavior that never reaches a generated type. Cite the tag, never a branch — `main` is not a pin. |
| **Official docs** | The vendor's published reference or changelog, cited by version anchor. |
| **Binary probe** | `--version` / `--help` output, an exit-code probe of an argument, a string census of the pinned binary, or observed wire traffic. |
| **Cross-reference** | Deduction from adjacent in-repo evidence (a spec, an ADR, the campaign design census). |

**Why a fifth _provenance_ value and not a fifth _trust_ grade.** The two are not the same move. A trust grade answers "how sure are we", and adding one there would have folded a source into a confidence scale — the exact conflation [Why the axes stay orthogonal](#why-the-axes-stay-orthogonal) rejects, and that rejection stands unchanged. A provenance value answers "where did it come from", and tagged upstream source is a genuinely distinct origin from all four others: it is not generator output, not a vendor prose page, not in-repo, and not something a probe of the installed binary can reach. Be precise about that last clause, because it is narrower than it first looks. A probe **can** establish that a gate exists — running Codex's default and `--experimental` generations against each other shows the notification unions identical while the request unions differ by 55, which is only explicable if something outside the schema does the filtering. What a probe cannot reach is the **rule**: which entries are marked, what the dispatcher does with the marker, and under what connection state. That is `transport.rs`, and recording it as **Binary probe** or **Cross-reference** would misstate where it came from and make it unre-verifiable. Adding it here leaves the TRUST axis at four grades and touches nothing on it.

### Why the axes stay orthogonal

A prior draft of this vocabulary proposed a **fifth TRUST grade, "schema-generated"**, ranked above Verified. That grade is **rejected and stays rejected.** Schema generation is a _source_, not a _confidence level_: a generated shape is **Verified**-trust because it was reproduced at the pin, and its origin is recorded independently as **Generated schema** provenance. Folding the two loses the cases where they move apart:

- **Same provenance, lower trust.** Codex's eight `thread/realtime/*` **server notifications** are **Generated schema** provenance and **Verified** present in the default-generated `ServerNotification` union at `0.149.1` — and their trust is nonetheless **Provisional**, because the tagged upstream source shows every one of them carries an `#[experimental]` marker and is silently dropped for a connection that did not opt in (see [`codex.md`](codex.md#threadrealtime--realtime-voice-gated)). Provenance unchanged and top-of-axis; trust floored anyway. A single "schema-generated" grade could not express this — it would have read as maximum confidence in a surface a default connection never receives.
- **High provenance, only Documented trust.** Claude Code's `system/init` `capabilities` token list is **Verified** at `2.1.245` from a **Binary probe** (the string census reproduces the field's own description verbatim), but the vendor's statement about _which release_ each token first appears in is **Official docs** provenance and only **Documented** trust — the pinned binary can show a token exists today, and cannot show when it arrived. Higher provenance, lower trust, on the same field.

So the rule is: **record trust and provenance separately; never derive one from the other.** The corpus's schema-generated notion is preserved — as the *top of the PROVENANCE axis*, not as a trust grade.

## Versioning and pinning policy

- **Pin to an exact version.** Each provider file names the CLI version its shapes were verified against and never floats. Codex pins to `0.149.1`; Claude pins to `2.1.245`. Where a behavior first appeared in a known release, the file records that release as a **version anchor** (the Claude changelog carries no dates, so version is the only stable anchor).
- **Name the floor separately from the pin.** The pin is what was verified; the **floor** is the oldest CLI the driver accepts. They move independently: a re-pin bumps what was measured without necessarily raising what is supported. Both are stated in [Files](#files) above and both are exercised by the nightly check below.
- **Above the pin, degrade per feature; below the floor, refuse.** A CLI newer than the pin is not a refusal condition — an unrecognized or moved surface degrades that one capability (to an emulated path or a typed refusal) and the rest of the session keeps running. A CLI older than the floor is refused outright, because the floor is chosen as the oldest release whose shapes the driver can still speak at all. This is an all-or-nothing-free policy: version tolerance is decided per capability, never per session. Its governance home is [ADR-023 §Decision Log](../../decisions/023-v1-ci-cd-and-release-automation.md#decision-log) (the row that registers the nightly check); the driver-side normative statement lives with Spec-005 / Plan-005.
- **Re-verify at authoring time, not once.** Both CLIs ship often — Codex a minor every 1–2 weeks plus near-daily alphas; Claude a stream of point releases (four distinct builds landed on the authoring machine inside eight days at this pin). A doc consuming these pins re-verifies its own load-bearing claims against the then-current binary rather than trusting an audit date. Perishability is the default assumption.
- **Regenerate, don't transcribe.** Codex protocol claims are regenerated from the binary (command + version recorded in [`codex.md`](codex.md)); hand-transcription of the Codex wire is prohibited. Claude claims are censused from the pinned binary and cross-checked against the docs, because `claude --help` is documented as non-authoritative (a flag's absence from `--help` does not mean it is unavailable) — see [`claude.md`](claude.md).
- **State the counting basis with any census number.** Method and notification counts in these files are taken over the **default (non-experimental) generation**, one entry per arm of the generated union root, keyed on that arm's `method` constant. `--experimental` generation yields larger numbers on the **request** roots but an identical set on `ServerNotification` (measured at `0.149.1`), so the two bases diverge per-root rather than uniformly and a differently-basised count is not comparable to these. Any future bump re-derives on this same basis or says which basis it used instead — and derives a delta by **set difference against both generations**, not by subtracting two remembered totals. That is not a hypothetical: the first draft of this re-pin was written the second way and had four of its eight census numbers wrong (both endpoints on `ClientRequest` and on `ServerNotification`, one of the two deltas with them), which set difference caught and arithmetic on remembered totals would not have.

These rules are adopted campaign-wide; the capability-enhancements design §3.4 is the provenance record for the audit that established the first version of them (`../../superpowers/specs/2026-07-01-capability-enhancements-design.md`).

## How the pin is kept honest

`.github/workflows/provider-compat.yml` runs nightly and on demand. It installs each provider CLI from the npm registry at the floor, at the pin, and at `latest`, with the auto-updater disabled, and probes the protocol shapes these files assert — for Codex, a real `initialize` handshake plus `account/read` against a scratch `CODEX_HOME`; for Claude, the version, an argument-acceptance probe, and the control-request registry census. A drift is reported by opening or updating a single tracking issue, never by silently passing. Two properties make its results readable: every `latest` leg prints the version it actually resolved to, and every leg states which install channel it measured.

**What a drift report means.** A `latest` leg failing is a signal to re-verify and re-pin these files — it is not a build break. A **floor** leg failing is the serious one: it means the oldest supported CLI can no longer do what the driver assumes, and the floor itself has to move.

## How consuming docs cite these files

- A spec or plan describing provider wire behavior adds a `Reference:` line linking the relevant provider file, rather than restating the shape inline. The link target is these files; keep the cite section-level (the pinned version is stated in the file header) so it survives regeneration.
- **Driver fixture paths are cited as plain text, not links.** The captured-wire fixtures the drivers test their normalizers against do not exist yet — they land with Plan-005 Phase 3. Each provider file names its fixtures path as text with that marker, so the cite records intent without a dangling link.
- **Do not restate a pinned version number in a governing doc.** A spec or plan that hardcodes "Claude Code 2.1.245" acquires a copy that this file's next re-pin cannot reach. Cite the file and let the version live in one place.
