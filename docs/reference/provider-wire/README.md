# Provider Wire Reference

Measured reference for the wire surfaces of the two provider CLIs the local runtime daemon drives: the Codex `app-server` JSON-RPC protocol (`codex-driver`) and the Claude Code headless CLI (`claude-driver`). Each provider file records the CLI version its shapes were measured at and labels every claim on two independent axes — how much we **trust** the shape is correct and current (the TRUST axis), and **where the claim came from** (the orthogonal PROVENANCE axis).

These are **non-governance** reference docs (the `docs/reference/` tree): no status lifecycle, no cross-plan ownership-map row. They exist so that a spec or plan describing provider wire behavior cites a stable, version-anchored target instead of hand-transcribing shapes that rot as the CLIs move (both ship frequently). The provider drivers regenerate their own bindings from the provider binary at build time; these docs are the human-readable record, not the source of truth the code compiles against.

## Files

| File                     | Provider                       | Measured at         | Anchor                                                         |
| ------------------------ | ------------------------------ | ------------------- | -------------------------------------------------------------- |
| [`codex.md`](codex.md)   | Codex CLI (`codex app-server`) | `codex-cli 0.160.0` | the binary's own generated schema + the tagged upstream source |
| [`claude.md`](claude.md) | Claude Code headless CLI       | `2.1.287`           | a string census of the measured binary + the official docs census |

The app works with whatever provider version is installed. A missing or changed feature degrades that one feature and shows in the daemon's logs and the transcript, and is investigated when seen. The version in this table is the build a file's shapes were measured at, a record and not a requirement.

## The two axes: TRUST and PROVENANCE

Every wire claim in these files carries two labels. They answer different questions and **must not be collapsed into one scale** — that conflation is the mistake this vocabulary exists to prevent (see [Why the axes stay orthogonal](#why-the-axes-stay-orthogonal) below).

### TRUST — how sure are we the shape is correct and current at the measured version?

Four grades, most to least confident:

| Grade | Meaning |
| --- | --- |
| **Verified** | Reproduced against the measured binary this authoring pass — regenerated schema, string-census of the measured binary, or an observed runtime probe. |
| **Documented** | Stated in the vendor's official reference or changelog for the measured version, but not independently reproduced here. |
| **Derived** | Deduced from adjacent evidence (a sibling type, an enum member, a related method) rather than stated or reproduced directly. |
| **Provisional** | Asserted but unconfirmed at the measured version, or upstream-gated / under active development / explicitly hedged. Preserve the source's modal hedge — never upgrade a "may/should" to a "must/always". |

### PROVENANCE — where did the claim come from?

An orthogonal axis recording the source of each claim, most to least authoritative. Its top grade is **Generated schema** — the vendor's own binary emitting its exact protocol:

| Grade | Source |
| --- | --- |
| **Generated schema** | The provider binary's own schema/binding generator (Codex `app-server generate-json-schema` / `generate-ts`). **Canonical over prose docs**: when a generated shape and a prose doc disagree, the generated shape wins. |
| **Upstream source** | The vendor's own published source, read at a **release tag** (e.g. `openai/codex` `rust-v0.160.0`). Records what the generator cannot: runtime gating, attribute markers, and dispatcher behavior that never reaches a generated type. Cite the tag, never a branch — `main` is not a version. |
| **Official docs** | The vendor's published reference or changelog, cited by version anchor. |
| **Binary probe** | `--version` / `--help` output, an exit-code probe of an argument, a string census of the measured binary, or observed wire traffic. |
| **Live probe** | The installed build run through a session and read from outside it: a headless session's frames quoted as emitted, a terminal session driven in a pseudo-terminal, the request bodies a local logging proxy or mock model server recorded, and process, socket and file state read with `ps`, `netstat` and `lsof`. It is the same origin as a **Binary probe** of observed wire traffic, named for the session run rather than for the binary read. |
| **Cross-reference** | Deduction from adjacent in-repo evidence (a spec, an ADR, another in-repo reference). |

**Why tagged upstream source is a _provenance_ value and not a _trust_ grade.** A trust grade answers "how sure are we", and as one it would fold a source into a confidence scale — the exact conflation [Why the axes stay orthogonal](#why-the-axes-stay-orthogonal) rejects. A provenance value answers "where did it come from", and tagged upstream source is a genuinely distinct origin from the other five: it is not generator output, not a vendor prose page, not in-repo, and not something a probe of the installed binary can reach. Be precise about that last clause, because it is narrower than it first looks. A probe **can** establish that a gate exists — running Codex's default and `--experimental` generations against each other shows the notification unions identical while the request unions differ by 63 (at `0.160.0`), which is only explicable if something outside the schema does the filtering. What a probe cannot reach is the **rule**: which entries are marked, what the dispatcher does with the marker, and under what connection state. That is `transport.rs`, and recording it as **Binary probe** or **Cross-reference** would misstate where it came from and make it unre-verifiable. It is a PROVENANCE value only and changes no TRUST grade.

### Why the axes stay orthogonal

A **fifth TRUST grade, "schema-generated"**, ranked above Verified, is **rejected**. Schema generation is a _source_, not a _confidence level_: a generated shape is **Verified**-trust because it was reproduced at the measured version, and its origin is recorded independently as **Generated schema** provenance. Folding the two loses the cases where they move apart:

- **Same provenance, lower trust.** Codex's eleven `thread/realtime/*` **server notifications** are **Generated schema** provenance and **Verified** present in the default-generated `ServerNotification` union at `0.160.0` — and their trust is nonetheless **Provisional**, because the tagged upstream source shows every one of them carries an `#[experimental]` marker and is silently dropped for a connection that did not opt in (see [`codex.md`](codex.md#threadrealtime--realtime-voice-gated)). Provenance unchanged and top-of-axis; trust floored anyway. A single "schema-generated" grade could not express this — it would have read as maximum confidence in a surface a default connection never receives.
- **High provenance, only Documented trust.** Claude Code's `system/init` `capabilities` token list is **Verified** at `2.1.245` from a **Binary probe** (the string census reproduces the field's own description verbatim), but the vendor's statement about _which release_ each token first appears in is **Official docs** provenance and only **Documented** trust — the measured binary can show a token exists today, and cannot show when it arrived. Higher provenance, lower trust, on the same field.

So the rule is: **record trust and provenance separately; never derive one from the other.** Schema generation sits at the *top of the PROVENANCE axis*, never on the trust scale.

## Versions

- **Record the version measured.** Each provider file names the CLI version its shapes were measured at: Codex `0.160.0`, Claude Code `2.1.287`. A claim read at another build names that build. Where a behavior first appeared in a known release, the file records that release as a **version anchor** (the Claude changelog carries no dates, so version is the only stable anchor).
- **Any installed version runs; a feature degrades on its own.** No version is refused. An unrecognized, moved or missing surface degrades that one capability (to an emulated path or a typed refusal), the rest of the session keeps running, and the failure shows in the daemon's logs and the transcript, where it is investigated when seen. The driver-side statement lives with Spec-004 / Plan-003. A capability is decided by a **zero-turn probe of the running build**, never by comparing versions, because a version bounds availability from neither side — a censused registry is a lower bound on what answers, exactly as registry membership is an upper bound on it (`mcp_set_servers` answers `success` at `2.1.234`, `2.1.245`, and `2.1.246` while appearing in none of those builds' censused subtype registries).
- **A fact holds at the version it names.** Both CLIs ship often — Codex a minor every 1–2 weeks plus near-daily alphas; Claude a stream of point releases (four builds, `2.1.284` to `2.1.287`, landed on the authoring machine in the four days before `2.1.287` was measured). A consumer reads each claim as true at its measured version, not as a statement about whatever build is installed today.
- **Regenerate, don't transcribe.** Codex protocol claims are regenerated from the binary (command + version recorded in [`codex.md`](codex.md)); hand-transcription of the Codex wire is prohibited. Claude claims are censused from the measured binary and cross-checked against the docs, because `claude --help` is documented as non-authoritative (a flag's absence from `--help` does not mean it is unavailable) — see [`claude.md`](claude.md).
- **State the counting basis with any census number.** Method and notification counts in these files are taken over the **default (non-experimental) generation**, one entry per arm of the generated union root, keyed on that arm's `method` constant. `--experimental` generation yields larger numbers on the **request** roots but an identical set on `ServerNotification` (measured at `0.141.0`, `0.149.1`, `0.150.1`, `0.159.2` and `0.160.0`), so the two bases diverge per-root rather than uniformly and a differently-basised count is not comparable to these. A new census counts on this same basis or says which basis it used instead, and **measures both endpoints with one script in one run** — never one endpoint now and the other from memory, and never two endpoints counted by two different methods.

A census is a comparison, so the counting method, not just the count, has to be held fixed across the endpoints being compared. A source-declaration count and a generated-schema count are not the same number: at `0.160.0` the tagged upstream source declares **85** `ServerNotification` variants where the binary generates **83** (the two declared-but-ungenerated variants are named in [`codex.md`](codex.md)), and the same two-arm gap held at `0.150.1` (81 against 79). Each measurement is internally consistent on its own basis, so a mixed pair is caught only by re-measuring both endpoints with one script that counts top-level union arms.

## How consuming docs cite these files

- A spec or plan describing provider wire behavior adds a `Reference:` line linking the relevant provider file, rather than restating the shape inline. The link target is these files; keep the cite section-level (the measured version is stated in the file header) so it survives regeneration.
- **Driver fixture paths are cited as plain text, not links**: each provider file names the folder holding the captured-wire fixtures its driver tests its normalizer against.
- **Do not restate a provider version as a requirement in a governing doc.** A spec or plan cites the file, and the measured version lives in one place. A **version-anchored evidence** claim is the exception: "measured at `X`" records what a probe saw at that build and stays true whatever build is installed later.
