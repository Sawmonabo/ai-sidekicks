// Turn-snapshot service — the daemon-side owner of the per-run snapshot refs
// under `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>` (Plan-010 Phase 5).
//
// This file landed in three passes. T5.1 authored the CAPTURE leg; T5.2
// EXTENDED it with the non-mutating `resolveRestoreTarget` plus the mutating
// `restoreToTurn`; T5.3 (here) adds the window-based RETENTION prune plus the
// sweeper driver at the foot of the file that the sanctioned wiring call in
// `../bootstrap/index.ts` invokes. The class, the git invocation layer, the ref
// builders and the diagnostic seam below are written once for all three.
//
// Spec coverage:
//   * `Spec-010 §Turn-Boundary Snapshots` — the capture temp-index recipe
//     (out-of-worktree `GIT_INDEX_FILE`, the check-in leg's conversion pins plus
//     `GIT_ATTR_NOSYSTEM=1` — see the closed disposition table below for the
//     whole knob population and each knob's one ruling, this leg's and the
//     checkout leg's alike, the single base OID reused for tree base AND
//     recorded parent, the untracked-embedded-repo `160000` normalization with
//     its unborn-`HEAD` skip, the encoding-pinned `commit-tree`, the six-var
//     host-independence env set), the epoch-namespaced create-only ref write and
//     its per-epoch idempotence, and the writable-modes-only applicability rule.
//   * `Spec-010 §Turn-Boundary Snapshots` — the RESTORE recipe: the fail-closed
//     `HEAD` precondition, the lineage walk with its no-fallthrough refusal, the
//     pinned `read-tree --reset -u` leg under the checkout-conversion pins, the
//     untracked-delete pass repeated to a FIXPOINT, the closing index-only
//     `read-tree --reset HEAD` (both of those spec spellings name a MUTABLE ref
//     that an earlier check already read, so both are issued against the
//     verified OID instead — see the sites), the collision-overwrite and
//     divergent-gitlink enumerations, and the convergent partial-restore
//     disposition.
//   * `Spec-010 §Turn-Boundary Snapshots` — the RETENTION prune: a run's
//     snapshot refs become prune-eligible once `run_execution_contexts`'s
//     `released_at` plus the configured window has elapsed (the window is daemon
//     configuration, and this service owns the mechanism because the V1 corpus
//     names no general run-retention owner — `Spec-006 §Retention Windows`
//     governs event-log compaction and `Spec-015 §Retention` governs SQLite
//     backup files, neither these refs); the sweep enumerates and deletes
//     through the recorded `git_common_dir`; and the ephemeral-clone disposal
//     boundary — a disposed clone takes its refs with it, and a later rollback
//     of that run proceeds conversation-only (campaign B2's recorded ruling).
//   * `Spec-004 §Required Behavior` — the execution epoch `<E>`: `0` before any
//     rollback, advanced with each accepted `run.rolled_back`. SUPPLIED by the
//     caller and never derived here (CP-010-12) — and the two-phase split, which
//     exists so the whole-rollback validation runs BEFORE the conversation leg,
//     with the bound restore then running under the caller's exclusive
//     execution-root tenancy.
//
// Verifies invariant: I-010-21 (snapshot refs live only under
// `refs/sidekicks/runs/…`, never `refs/heads/`, and are invisible to branch
// history — held on the write side by the create-only CAS plus `--no-deref`, and
// on the delete side by the listing prefix re-check plus `--no-deref`; the flag
// is what keeps each of those checks about the name this service validated
// rather than about wherever that name resolves), I-010-22 (create-only
// per-epoch refs: the write is a
// compare-and-swap against ref ABSENCE, so a retried or duplicated capture never
// repoints an existing ref and a post-rollback re-execution's identical ordinal
// mints a fresh ref under its own `epoch-<E>` segment), I-010-23 (fail-closed
// two-phase restore: the non-mutating resolve refuses unless `HEAD` equals the
// snapshot's recorded first parent, `restoreToTurn` RE-VERIFIES that at
// execution time before any mutation, a snapshot absent in its owning epoch's
// territory draws a typed no-snapshot refusal rather than a parent-epoch
// fallthrough, and a mid-sequence failure returns a convergent partial-restore
// result carrying both enumerations, never a silent success).
//
// Cross-plan obligations: CP-010-7 (this Plan-010-owned `src/git/` subtree),
// CP-010-12 (PURE CALLEE — see below).
//
// ---------------------------------------------------------------------------
// CP-010-12 — the capture and restore legs resolve NOTHING
// ---------------------------------------------------------------------------
//
// `executionRoot`, `runId`, `epoch`, `turnOrdinal` and `mode` all arrive as
// parameters. Neither the capture leg nor the restore leg reads
// `run_execution_contexts`, derives the epoch from rollback history, or infers
// the mode from the root's shape. The production call site — the Plan-004 run
// engine's turn boundary — is authored by the campaign's B9 bundle and owns
// every one of those resolutions.
//
// The RETENTION leg is the deliberate exception, and CP-010-12 carves it out in
// so many words: "the T5.3 retention leg's `released_at` / `git_common_dir`
// reads are a separate concern, outside this obligation". It is not a caller's
// question to answer — nothing outside this module knows which refs exist, and
// the sweep runs on a daemon cadence with no run in flight to be a callee OF.
// The `database` dependency is therefore OPTIONAL rather than required: a
// service wired for the turn boundary alone holds no handle at all, exactly as
// the capture leg always did, and the two retention entry points refuse loudly
// rather than answering emptily when it is absent (see
// {@link TurnSnapshotService.sweepPrunableRuns}).
//
// The `mode` self-guard is the one place the parameter is INTERPRETED rather
// than passed through, and it is deliberately a self-guard rather than a
// caller-side `if`: the Applicability bullet of `Spec-010 §Turn-Boundary
// Snapshots` makes "`read-only` runs snapshot nothing" a property of the
// mechanism, and a guard that lives only in the caller is one refactor away from
// a read-only run minting objects. It runs FIRST — before the base resolution,
// before the hook-neutralization directory, before the scratch-index directory —
// so the no-op is observable as zero git objects and zero refs rather than
// merely as an absent ref. It is also an ALLOWLIST over the writable modes named
// in that bullet, so a mode added to `ExecutionMode` later is inert here until
// somebody admits it deliberately (see {@link SNAPSHOT_APPLICABLE_MODES}).
//
// ---------------------------------------------------------------------------
// I-010-21 — the namespace is enforced at THIS layer, not by git
// ---------------------------------------------------------------------------
//
// Every ref this service writes is assembled by {@link buildTurnSnapshotRef}
// from a validated `runId` and two non-negative integers. The validation is not
// decoration: `refs/sidekicks/runs/<runId>/…` interpolates a caller-supplied
// string into a ref path, and a `runId` of `../../heads/main` would name a
// BRANCH. git's own `check-ref-format` rules do refuse that spelling ("refusing
// to update ref with bad name", confirmed on git 2.50.1), but a refusal that
// arrives from git is a capture FAILURE — which this service reports as a
// diagnostic and swallows — so relying on it would turn an invariant breach into
// a silent no-op rather than a typed refusal. The check runs before any git
// call, the same posture `./worktree-service.ts` takes for its `baseRef`
// leading-dash refusal.
//
// The second channel is the environment, and it threatens the invariant from a
// different direction than the ref PATH: an ambient `GIT_DIR` (or
// `GIT_WORK_TREE`) redirects the whole invocation at another repository, so a
// perfectly-spelled `refs/sidekicks/runs/…` would be written into a store the
// caller never named — empirically confirmed on git 2.50.1, where `-C <root>`
// does NOT win against it: `rev-parse --verify HEAD` resolves the redirected
// repository's `HEAD` and `write-tree` reports its index. `GIT_OBJECT_DIRECTORY`
// is cruder still: set WITHOUT `GIT_DIR`, the pipeline's first leg
// (`rev-parse --verify HEAD` through `-C <root>`) refuses with
// `not a git repository`, exit 128 — observed by T5.1 on that leg and on
// `hash-object -w`.
//
// A later probe on git 2.50.1 generalized that finding rather than leaving it
// scoped to those two: `rev-parse --show-toplevel`, `rev-parse --git-dir`,
// `rev-parse --git-common-dir` and `status --porcelain` all draw the same
// refusal, so it is not a property of the legs T5.1 happened to run. The same
// probe pinned the MECHANISM: an accessible-but-unreadable value (a mode-`111`
// directory) is ACCEPTED while an inaccessible one (absent, dangling symlink,
// regular file, mode-`000`, empty string) is refused, which makes it an
// accessibility test performed during repository setup rather than an object
// read. Both VARIABLE classes — the `GIT_DIR` redirectors above and
// `GIT_OBJECT_DIRECTORY` itself — are stripped by the environment builder below.
//
// `GIT_NAMESPACE` is on the strip list too, but honesty about WHY matters more
// than the tidy story: it does NOT relocate these writes. Local ref plumbing —
// `update-ref`, `rev-parse`, `show-ref`, `for-each-ref` — ignores it entirely
// (empirically confirmed on git 2.50.1: a namespaced `update-ref` lands at the
// unprefixed path and reads back from a clean environment). The namespace lives
// in the pack protocol, where `upload-pack`/`receive-pack` apply it. It is
// stripped as defense in depth for a leg that may one day speak that protocol,
// not as the mechanism enforcing I-010-21. See
// {@link SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS}.
//
// The third channel is the SYMBOLIC REF, and it threatens the invariant from a
// direction neither of the other two can see: a validated, in-namespace ref NAME
// that RESOLVES somewhere else. `git symbolic-ref refs/sidekicks/runs/<id>/… <target>`
// is a cheap, non-destructive write for anything sharing the repository — this
// product's own threat surface is several agents in one session and one repo —
// and the ref path it plants is perfectly well-formed, so every name-based guard
// this service has passes it. It reaches BOTH sides, and `--no-deref` is what
// closes each; the flag makes git act on the name rather than on its referent.
//
//   * DELETE. After the plant, `for-each-ref` reports an in-prefix name carrying
//     the BRANCH's oid — the name check passes, the oid parses, and the
//     compare-and-swap matches the very thing it is about to destroy. Unflagged,
//     `update-ref -d` then deletes `refs/heads/main`: measured on git 2.50.1,
//     exit 0, reported as a clean prune, a retention window after the run ended.
//     Flagged, the deletion lands on the symref itself and branch history is
//     byte-identical. See `#pruneRunRefs`.
//   * CREATE. git splits a symbolic-ref update into an update of its REFERENT and
//     transfers the must-not-exist check there, so the create-only CAS stops
//     guarding the validated name. A live referent refuses either way; a DANGLING
//     one does not — measured on git 2.50.1 and on git 2.54.0 alike, an unflagged
//     capture into a squatted turn path CREATES `refs/heads/evil` at the snapshot
//     commit and reports success. The UNFLAGGED breach is version-INVARIANT, which
//     is the whole reason the suite asserts `refs/heads/` outside any version
//     branch. Flagged, nothing outside the namespace is touched on any
//     git measured; WHAT the capture reports splits by version. On git 2.50.1 the
//     write lands at the validated name and the capture is `captured`; on git
//     2.54.0 the same flagged create is REFUSED over a dangling in-namespace
//     symref (refs-transaction hardening, lineage git 2.52's fix for `fetch`
//     clobbering dangling symrefs), the existence probe behind the CAS reads
//     nothing back, and the capture is the typed `failed` — fail-closed,
//     diagnosed, the turn unblocked. See `#writeCreateOnlyRef`.
//
// The two sides fail in opposite directions — the delete destroys an existing
// branch, the create mints a new one — which is why neither guard substitutes for
// the other and both invocations carry the flag.
//
// BOUNDARY, recorded so the flag is not read as more than it is. `--no-deref` and
// the create-only CAS are statements about where THIS service's writes land, not
// about the integrity of a ref store it shares. Anyone with repository write
// access already holds the ordinary spellings: `git update-ref
// refs/sidekicks/runs/<id>/epoch-<E>/turn-<N> <any-oid>` pre-plants or REPOINTS an
// in-namespace ref with no symref anywhere in it and no compare-and-swap guarding
// an overwrite, and `git symbolic-ref` rewrites one without a CAS either. There is
// no ref-store ACL at this layer to appeal to, so detecting the symref spelling on
// the read path would close one spelling of a channel that stays wide open in its
// plainest one — false confidence, bought with a mechanism. What the guards do
// buy: every write this service issues lands on a name it validated and inside the
// namespace, and an input it cannot make sense of becomes a typed refusal rather
// than a guess. What they do not buy: that a ref this service READS BACK was
// written by this service. That bounds what the two reading legs may claim — see
// {@link TurnSnapshotAlreadyCaptured} and
// {@link TurnSnapshotService.resolveRestoreTarget}.
//
// ---------------------------------------------------------------------------
// I-010-22 — the CAS is the arbiter; nothing pre-checks it
// ---------------------------------------------------------------------------
//
// `git update-ref --no-deref <ref> <commit> ""` — the trailing EMPTY old-value —
// is a compare-and-swap against ref absence (git 2.50.1: exit 128, "cannot lock
// ref …: reference already exists"), the flag keeping that "absence" a statement
// about `<ref>` itself for the reason the channel above gives. The capture
// pipeline runs unconditionally and
// the CAS decides; there is deliberately no "does the ref already exist" probe
// in front of it. A pre-check would be a SECOND arbiter racing the first, which
// is the read-then-write pattern `./worktree-service.ts`'s header refuses for
// the branch index for the same reason.
//
// The refusal is then INTERPRETED rather than parsed: on any `update-ref`
// failure the service asks `git show-ref --verify --hash <ref>`, and a ref that
// resolves is reported as idempotent success carrying the RECORDED OID — the one
// on disk, never the one this call just built. `--verify` plus a fully-qualified
// ref path keeps that read exact as defense in depth: the exit-status check in
// the runner and `#requireObjectId`'s hex pattern already refuse a bare
// `rev-parse`'s argument echo on a miss, so the flag is the third guard against
// a fabricated `already-captured`, not the sole one — the same posture the
// `GIT_NAMESPACE` entry above takes. Reading the ref rather than git's stderr
// also keeps the concurrent-capture race on the same path as the retry case:
// whoever lost the CAS reads the winner's OID.
//
// RESIDUAL, recorded rather than closed: because nothing pre-checks, a duplicate
// capture whose worktree has since changed writes a tree and a commit that no
// ref will ever point at. They are unreferenced objects, which is exactly what
// `git gc` collects, and the alternative — the pre-check — costs the arbiter.
//
// ---------------------------------------------------------------------------
// I-010-23 — the restore leg is fail-closed, and TWICE
// ---------------------------------------------------------------------------
//
// `Spec-004 §Required Behavior` needs the file-leg verdict BEFORE the
// conversation leg moves, because a refusal rejects the whole rollback
// intervention with no leg applied. That is why the restore path is two methods
// rather than one: {@link TurnSnapshotService.resolveRestoreTarget} is the
// non-mutating question (which snapshot, and may it be applied?) and
// {@link TurnSnapshotService.restoreToTurn} is the answer's application. The
// resolver spawns nothing but read commands — `show-ref`, `rev-parse` — so a
// refused resolve and an accepted one leave the execution root's worktree, index
// and refs byte-identical.
//
// The precondition is then checked FOUR times, and none of the three extras is
// redundant, because `HEAD` may move between any two of them: a Spec-011
// commit/push action landing in the execution root, most plausibly, or a user
// terminal open in the same worktree. The exclusive execution-root tenancy
// `Spec-004 §Required Behavior` puts around the intervention is the CALLER's
// (Plan-004, campaign B9), and it excludes other RUNS, not other processes; this
// module builds no tenancy machinery and instead re-asks the one question that
// matters at each point the answer could have changed:
//
//   * at the resolve, so the whole rollback can be refused before its
//     conversation leg moves;
//   * inside `restoreToTurn`, before the derivation — the plain TOCTOU guard;
//   * again after the derivation, because those listings are themselves a
//     window, and this side of `read-tree` a refusal still costs nothing;
//   * once more before the closing index reset, where the answer differs: the
//     worktree already holds snapshot content, so a moved `HEAD` is a
//     `partial_restore`, not a clean refusal.
//
// The first three refuse with NO mutation. The fourth is the one that would
// otherwise be silent, and `restoreToTurn`'s docblock spells out what it
// prevents. It is a check and not a lock, so the closing reset names the OID it
// just verified rather than the mutable name `HEAD` — which does not close the
// remaining window, but decides what a commit landing inside it looks like. The
// destructive checkout leg names its verified OID for the same reason, one name
// down: the resolver read the snapshot ref, so the checkout does not ask git to
// re-resolve it.
//
// Fail-closed means the equality must be ESTABLISHED, not merely
// un-contradicted: an unreadable `HEAD` and an unreadable recorded parent refuse
// exactly as a mismatch does. At the resolve and at the two pre-mutation checks
// that is the `head_moved` arm, carrying `null` for whichever side could not be
// read; at the post-mutation check it is `partial_restore` at `close-index`, like
// any other answer from that point on. Reading the older snapshot tree against
// a newer `HEAD` would leave the later commit in branch history while
// anti-diffing its files into the worktree as unstaged modifications —
// fabricated edit intent of exactly the kind the closing index reset exists to
// prevent.
//
// ---------------------------------------------------------------------------
// I-010-23 — the lineage walk NEVER falls through
// ---------------------------------------------------------------------------
//
// Same-run resurrection re-uses turn ordinals, so `turn-6` exists under as many
// `epoch-<E>` segments as the run has been rolled back. The walk picks the
// OWNING epoch — the newest whose `rewindBase` is strictly below the target
// position, positions at or below a rewind base inheriting from the parent epoch
// — and then resolves that epoch's ref and no other. When the owning epoch's ref
// is absent (a failure-tolerant capture left a gap), the answer is a typed
// no-snapshot refusal: resolving the superseded parent epoch's same-ordinal ref
// would restore a tree from an execution the user rolled back, which is the
// silent wrong answer this refusal exists to make impossible.
//
// The `epochLineage` is the CALLER's (CP-010-12) — derived from the Plan-004 run
// engine's durable epoch/intervention records — and the owner is selected by
// MAXIMUM epoch among the candidates rather than by list position, so an
// unsorted lineage yields the same owner rather than a plausible wrong one.
//
// ---------------------------------------------------------------------------
// The partial-restore enumerations are OBSERVED, not bookkept
// ---------------------------------------------------------------------------
//
// `read-tree --reset -u` updates the working tree as it applies, not
// transactionally: a required smudge filter erroring on a later path leaves the
// earlier paths — an overwritten colliding ignored file among them — on disk,
// with the index NOT written (exit 128; empirically confirmed on git 2.50.1, and
// the reason the index is no use as evidence here). So the sequence derives its
// PROSPECTIVE collision-overwrite and gitlink-divergence sets before mutating —
// recording each candidate's on-disk state at that moment — and, at a failure,
// reports the subset whose on-disk state actually CHANGED.
//
// That observation is deliberately git-free (one TYPE-AWARE path fingerprint per
// candidate, for BOTH candidate sets): it runs on the failure path, where the
// git seam is the thing that just failed, and an enumeration that needed a
// working git could empty-wash exactly the report Plan-004 maps to its
// `files-partially-restored` disposition. Type-aware because bytes alone cannot
// see a destroyed dangling symlink or a symlink replaced by a byte-identical
// file — see {@link fingerprintPath}. The gitlink set reached this standard by
// correction rather than design: it carried a `stat`-based presence boolean,
// which read a symlink-to-directory as a directory and dropped the destroyed
// symlink out of the report.
//
// The rule's one deliberate consequence, recorded rather than hidden: a
// submodule that is PRESENT but divergent is enumerated on a completed restore
// (the spec's report of the gitlink boundary) and is not enumerated on a
// partial restore that never reached it, because `submodule.recurse=false` means
// the failed sequence applied nothing at that path. Materializing an absent
// gitlink as an empty directory IS such an effect, and is observed as one.
//
// Note also what these two enumerations are NOT: a census of everything the
// sequence touched. They are two effect classes, so both can be empty on a
// `partial_restore` that rewrote the whole worktree — see
// {@link TurnSnapshotPartialRestore}, which states the exact reading a Plan-004
// consumer needs.
//
// ---------------------------------------------------------------------------
// The gitlink boundary cuts BOTH ways
// ---------------------------------------------------------------------------
//
// `submodule.recurse=false` is usually described as "the restore does not reach
// inside a submodule". The delete pass inherits the same boundary from the other
// direction, and this one is easy to miss: `ls-files -o` does not descend into a
// path the index holds as a `160000` gitlink — empirically confirmed on git
// 2.50.1, including the case where the working copy there is an ORDINARY
// directory, which is what a turn that removed an embedded repository's `.git`
// leaves behind. Post-boundary untracked content inside such a path therefore
// survives the restore, where the same content anywhere else is deleted. The
// path is reported in `divergentGitlinks`, which is the caller's whole signal
// that the boundary applied there.
//
// ---------------------------------------------------------------------------
// Host-config knobs — the CLOSED disposition table
// ---------------------------------------------------------------------------
//
// This service has exactly TWO legs that touch worktree content: the check-in
// leg (`update-index --add --remove`, which hashes worktree bytes into the
// snapshot tree) and the destructive checkout leg (`read-tree --reset -u`,
// which writes them back). Every other invocation moves object ids or reads
// listings.
//
// Four rounds of external review each found ONE more host-config knob able to
// change what this service does — `core.safecrlf`, then `core.eol`, then
// `core.fileMode`, then `core.useReplaceRefs`. Four for four is not bad luck.
// The first three were a population being ACCUMULATED from review findings
// rather than derived, so the closure claim was never checkable; it is now
// derived, and it names its source.
//
// The fourth arrived AFTER that derivation and is the more instructive one,
// because the enumeration had already caught the knob — and filed it OUT of
// population under repository identity, on a reading of its name rather than a
// measurement of its effect. A derived population is only as closed as its
// classification. `core.useReplaceRefs` does not decide whether a usable root
// exists; it decides whether an object read inside a perfectly usable one
// returns the object that was asked for. Enumerating a knob and then
// misfiling it fails the same closure claim that omitting it does, and it fails
// it more quietly, because the name appears in the table and so reads as
// adjudicated. Each out-of-population bullet below therefore states the
// MECHANISM it claims inertness from, so a reader can falsify the claim instead
// of the label.
//
// That finding also widened the table's own subject. "Two legs touch worktree
// content" is still true, and it is not the whole exposure: an invocation that
// merely INTERPRETS a recorded object id is a leg whose answer the host can
// change, which is why the pinned row below is scoped by leg rather than by
// which leg writes bytes.
//
// The third finding fixed the table's METHOD, and the row records it: a knob
// that reaches these legs is not thereby a knob to pin. `core.fileMode` was
// pinned on the half of the evidence a review finding arrived with, and
// measuring the other half — what the pin does to files ALREADY TRACKED at the
// base commit — reversed the disposition to honored. A disposition here needs
// the whole matrix, not the cell that motivated the question. The fourth
// finding is that method applied to a knob needing the pin on SOME legs and not
// others: the closing index reset honours it deliberately, and pinning there
// would have been the `core.fileMode` mistake in a new place.
//
// ENUMERATION SOURCE — the variable listing of `git help --config` on git
// 2.50.1: 62 variables under `core.*`, plus `index.*` (6), `submodule.*` (12),
// `filter.*` (2) and `i18n.*` (2), those being the other namespaces either leg
// reaches. Re-running that command and counting those namespaces is how a
// reader checks this table rather than trusting it. (The listing's grand total
// is deliberately not quoted: it depends on how parameterized `<name>` entries
// are counted, so it is not reproducible the way the per-namespace counts are.)
//
// IN POPULATION — a knob is in scope when, holding the worktree bytes and the
// repository fixed, it can change (a) the BYTES either leg hashes or writes,
// (b) the SET OF PATHS either leg hashes or writes, or (c) whether either leg
// SUCCEEDS, the availability class `core.safecrlf` established. Everything in
// scope carries exactly one recorded disposition below.
//
// OUT OF POPULATION by stated criterion rather than row by row, because these
// are large families whose members are individually inert here:
//
//   * OBJECT ENCODING AND STORAGE LAYOUT — `core.compression`,
//     `core.looseCompression`, `core.bigFileThreshold`, `core.fsync`,
//     `core.fsyncMethod`, `core.fsyncObjectFiles`, `core.createObject`,
//     `core.deltaBaseCacheLimit`, `core.packedGitLimit`,
//     `core.packedGitWindowSize`, `core.commitGraph`, `core.multiPackIndex`,
//     `core.splitIndex`, `index.version`, `index.skipHash`,
//     `index.recordEndOfIndexEntries`, `index.recordOffsetTable`,
//     `index.threads`, and `core.sharedRepository` (permissions on the files git
//     WRITES into the repository, never a worktree path's mode). These decide
//     how bytes are STORED, never which bytes or which paths; a tree OID is a
//     function of content and mode alone. Spot-measured all the same — see the
//     stat-family row below, whose sweep drove eight of these through the
//     check-in leg for identical tree OIDs.
//   * PORCELAIN AND UI SURFACES this module never invokes — `core.pager`,
//     `core.editor`, `core.askPass`, `core.commentChar`, `core.commentString`,
//     `core.abbrev`, `core.whitespace`, `core.notesRef`, `core.logAllRefUpdates`,
//     `core.warnAmbiguousRefs`, `i18n.logOutputEncoding`. Also `core.quotePath`,
//     which is a path-DISPLAY knob and cannot reach a `-z` listing at all (every
//     listing leg here passes `-z`, which is what makes that structural rather
//     than lucky).
//   * REPOSITORY IDENTITY — `core.bare`, `core.worktree`,
//     `core.repositoryFormatVersion`. These decide whether there is a usable
//     execution root at all, not what these legs do inside one. The family lost
//     a member to the round-4 finding above: `core.useReplaceRefs` was here and
//     is now PINNED below, because it changes what an object read RETURNS inside
//     a root that is perfectly usable.
//   * REF STORAGE FORM — `core.preferSymlinkRefs`, stated apart from the family
//     above rather than filed with it, since the point of that finding is that a
//     bullet's mechanism has to cover its members. This one decides whether a
//     ref is written as a filesystem symlink instead of a `ref:` file; git reads
//     both, every ref leg here goes through `update-ref`/`show-ref`/
//     `for-each-ref`, and the value a ref RESOLVES to is unchanged by how it is
//     spelled on disk.
//   * TRANSPORT, PROXY, HOOK-ADJACENT AND PLATFORM knobs neither leg reaches —
//     `core.gitProxy`, `core.sshCommand`, `core.alternateRefsCommand`,
//     `core.alternateRefsPrefixes`, `core.filesRefLockTimeout`,
//     `core.packedRefsTimeout`, `core.fsmonitorHookVersion`,
//     `core.hideDotFiles`, `core.unsetenvvars`, `core.restrictinheritedhandles`,
//     `core.maxTreeDepth` (a recursion BOUND, measured identical at 4096), and
//     the whole `submodule.*` namespace other than `submodule.recurse`, which is
//     pinned below — the rest configure fetch and update of DECLARED submodules,
//     and this module neither fetches nor updates one.
//
// A knob in population and absent from this table is a gap in it, and a pin
// added below without a measurement is a claim, not a closure.
//
// Every "measured" below is git 2.50.1; the suite re-drives the behavioral ones
// on whatever git CI runs (2.54 at time of writing).
//
// PINNED — the value is forced, so the host cannot reach the outcome.
//
//   * `core.autocrlf=false`, BOTH legs. Check-in: a host `input` or `true`
//     re-hashes CRLF worktree bytes to LF blobs, so identical worktree bytes
//     yield different blob, tree and snapshot OIDs. Checkout: the pin is ALSO
//     what makes the next row load-bearing — measured, a host `core.autocrlf=true`
//     writes CRLF whatever `core.eol` says, and only under this pin does the
//     checkout follow `core.eol` at all.
//   * `core.eol=lf`, CHECKOUT leg only. Measured against an in-tree `*.txt text`:
//     under the pin above, host `core.eol=crlf` restores CRLF and `lf` restores
//     LF, so without this the restored bytes are the host's decision — exactly
//     the class the other pins close. `lf` and not `native`, because `native`
//     resolved to LF on the measuring host only by being a LF host and would
//     restore CRLF on Windows for bytes captured as LF. The check-in leg does NOT
//     carry it: measured, staging with the host at `core.eol=crlf` and staging
//     with `core.eol=lf` pinned produce the IDENTICAL tree OID (the `text`
//     attribute's clean filter normalizes on the way in either way).
//   * `core.safecrlf=false`, CHECK-IN leg only. A veto rather than a conversion —
//     measured, present-or-pinned-false produce the identical tree — so what a
//     host `core.safecrlf=true` adds is a FATAL, turning snapshot AVAILABILITY
//     into a host-config question. The restore checkouts never consult it
//     (measured), so it is not pinned there.
//   * `core.attributesFile=/dev/null` plus `GIT_ATTR_NOSYSTEM=1`, BOTH legs. Takes
//     the user and system attribute files out of the conversion decision, leaving
//     only the in-tree declaration below.
//   * `submodule.recurse=false`, CHECKOUT leg. Bounds the path SET rather than any
//     path's bytes: the checkout stops at a gitlink. Its two-way consequence has
//     its own header section above.
//   * `i18n.commitEncoding=utf-8`, PINNED ELSEWHERE — on the `commit-tree` leg,
//     which is neither of the two content legs and so touches no worktree byte or
//     path. It is here because it reaches the same OUTCOME from the other end: a
//     host `i18n.commitEncoding` writes an `encoding` header into the commit
//     object, changing the snapshot OID for identical project state. Listed for
//     the same reason as the row below — the table adjudicates both `i18n.*`
//     variables it claims to enumerate, and `i18n.logOutputEncoding` is out of
//     population as a porcelain surface.
//   * `core.hooksPath=<empty dir>` and `core.fsmonitor=false`, PINNED ELSEWHERE —
//     `#runGit` prepends both to every invocation this module makes, so they cover
//     these two legs by construction (D-010-10, and see the I-010-10 section
//     below). Listed here because a table claiming a closed population may not
//     omit a knob merely because another mechanism already closed it.
//   * `core.useReplaceRefs=false`, on every leg that INTERPRETS a recorded object
//     id: the destructive checkout, the delete pass's snapshot-tree listing, the
//     lineage parent read, the capture's index seed, and the snapshot message
//     read that recovers the skipped-repository trailer. `refs/replace/<oid>`
//     substitutes one object for another transparently, so a ref an attacker
//     cannot write is not the same protection as an object id an attacker cannot
//     redirect — and this service's whole restore-side safety argument is stated
//     in frozen object ids.
//     Reproduced on git 2.50.1: with `git replace <snapshotCommit> <attacker>`,
//     the attacker commit carrying the SAME parent and a different tree, every
//     HEAD guard still passes — the parents compare equal — while `ls-tree` of
//     the frozen id enumerates the ATTACKER's paths and `read-tree --reset -u` of
//     it writes the ATTACKER's bytes at exit 0. That is a restore reporting
//     success having written something other than what it verified, which is the
//     one outcome I-010-23's fail-closed posture exists to prevent. Pinned, the
//     same fixture restores the original tree.
//     The CAPTURE seed is in the set on its own measurement rather than by
//     analogy, because most seed damage is self-correcting: `update-index --add
//     --remove` re-lists and re-stats, so a phantom path from a replacement tree
//     is dropped again. The class that SURVIVES is a path both index-tracked and
//     ignored-by-rule, which only the seed can carry into the snapshot (`ls-files
//     -o` will not list it, being ignored). Measured with exactly that path and a
//     replace ref on the base commit: porcelain `add -A` keeps it, the unpinned
//     pipeline silently loses it, the pinned pipeline matches porcelain — so the
//     pin is what holds the `add -A` tree equivalence the capture contract is
//     stated in, and its absence would be silent data loss rather than a fault.
//     NOT pinned, each measured on the same fixtures rather than assumed:
//       - `rev-parse HEAD` (the observed head) and the ref reads `show-ref
//         --verify --hash` and `for-each-ref %(objectname)`. These RESOLVE refs
//         rather than interpret objects; a replace ref on the resolved commit
//         leaves all three outputs unchanged.
//       - `commit-tree -p <base>` and `update-ref`'s written value both record
//         the literal id supplied, not the replacement (measured identical with
//         and without the pin), and `update-ref -d`'s CAS old-value compares ref
//         values on that same footing.
//       - THE CLOSING INDEX RESET, `read-tree --reset <expectedHead>`, is the one
//         leg measurably redirected and DELIBERATELY HONORED anyway. Unpinned it
//         loads the replacement tree, pinned it loads the original — and
//         PORCELAIN AGREES WITH THE UNPINNED ANSWER, because `rev-parse
//         HEAD^{tree}` and `git reset -q` go through the replace ref too. Pinning
//         would leave the index disagreeing with what every other git command in
//         that worktree calls HEAD, which `git status` then reports as fabricated
//         STAGED modifications (`D  extra.txt`, `M  tracked.txt`) where the
//         honoring close reports those same paths unstaged, byte-identical to
//         `git reset -q`. This leg's contract is "leave the index where porcelain
//         would", not "interpret a snapshot id", so it follows the host on the
//         same standard `core.symlinks` and `core.fileMode` follow it elsewhere.
//         The pin belongs to the id being INTERPRETED, not to the command name.
//
// DELIBERATELY HONORED — the host is allowed to decide, and the reason is that
// the alternative is worse than the exposure.
//
//   * IN-TREE `.gitattributes`, both legs. A project declaration, checked in and
//     identical on every host, so honouring it is what makes a restored worktree
//     byte-identical to any porcelain checkout of the project. This covers `text`,
//     `eol=`, `working-tree-encoding=` and `filter=` NAMES alike — measured for
//     `working-tree-encoding=UTF-16LE`, where the odb blob is UTF-8 and the
//     restored worktree file is UTF-16LE, which is the declared and correct
//     answer.
//   * `core.protectNTFS` / `core.protectHFS`, checkout leg. These are a PATH-SET
//     effect, and the only one in this table whose honest disposition is "leave it
//     alone": they REFUSE tree paths that alias `.git` on case-folding or
//     name-mangling filesystems. Pinning them off to make the checkout more
//     deterministic would open a hole — a hostile snapshot tree writing into
//     `.git` — so determinism loses to the guard here, deliberately.
//   * `core.ignorecase` / `core.precomposeUnicode`, both legs. `git init` writes
//     both from a PROBE of the filesystem (measured: both `true` on the macOS
//     host), so they state what the filesystem does rather than what the host
//     prefers. A pin would contradict the filesystem, not the operator.
//   * `core.symlinks`, CHECKOUT leg. Measured: default restores `link.txt` as a
//     symlink; `-c core.symlinks=false` restores it as a REGULAR file whose
//     content is the target path. Not pinned in either direction, because the
//     value is a filesystem CAPABILITY: pinning `true` on a filesystem without
//     symlink support makes the checkout fail rather than restore, and pinning
//     `false` would degrade every host that does support them. Honouring it means
//     the restore reproduces what a porcelain checkout produces on that host,
//     which is this table's standard everywhere else. Measured irrelevant on the
//     check-in leg: with and without the knob the staged tree is identical,
//     `120000` mode included.
//   * `core.fileMode`, CHECK-IN leg — the fourth member of the probe-written
//     capability family above (`core.ignorecase`, `core.precomposeUnicode`,
//     `core.symlinks`), and the only knob in this table that decides a tree
//     entry's MODE rather than its bytes. It was briefly pinned to `true` here on
//     a review finding, and MEASURING THE OTHER HALF reversed that. The four
//     cells, git 2.50.1 on a capable filesystem, repo-level `core.fileMode=false`,
//     a turn that `chmod 644`s a tracked `100755` file and creates a new `0755`
//     one:
//
//         entry                pinned true   unpinned   add -A false   add -A unset
//         tracked  tool.sh       100644       100755      100755         100644
//         created  created.sh    100755       100644      100644         100755
//
//     Read the columns, not the rows. UNPINNED is byte-identical to porcelain
//     `git add -A` under the same host config in all four cells — the measured
//     trees were the same OID — and `add -A` tree equivalence is the capture
//     contract `Spec-010 §Turn-Boundary Snapshots` states. PINNED reproduces
//     porcelain under a DIFFERENT config than the host actually has, which is not
//     a fix; it is a second opinion about the operator's repository.
//     The mechanism is this file's own stat-family row: the scratch index a
//     capture seeds carries NO stat data, so `update-index` re-stats every listed
//     path, and under a `true` pin each TRACKED file's mode then comes from lstat
//     — discarding the mode its base commit recorded. That is the `100755 →
//     100644` cell, and it is the dangerous direction: a recorded exec bit lost
//     for a file the turn never meant to change.
//     REASONED, NOT MEASURED — the mechanism above is measured; this consequence
//     of it is not, for want of the host. On a bit-incapable filesystem (a
//     `vfat`/`exFAT` mount, or Windows, a V1 shipping tier per `ADR-019`) git's
//     own probe writes `core.fileMode=false` precisely because lstat cannot
//     report the bit truthfully. A `true` pin there would feed that fabrication
//     into EVERY tracked file's recorded mode, turning a per-turn annoyance into
//     recorded-bit loss across the snapshot.
//     RESIDUAL, recorded rather than closed: honouring the knob means a
//     preference-set or stale `false` on a capable filesystem loses a
//     turn-created executable's bit, and records a boundary `chmod` of a tracked
//     file as that file's stale recorded mode. Both are exactly what porcelain
//     `add -A` does under that config, so equivalence holds by construction and
//     the snapshot is never worse than the repository it came from. A stale
//     `false` is narrow — git's probe never writes it on a capable filesystem, so
//     it takes an explicit preference or a repository moved across filesystems.
//
// MEASURED-IRRELEVANT — reachable in principle, measured not to reach these legs.
//
//   * `core.eol` on the check-in leg, and `core.symlinks` on the check-in leg —
//     both measured above, both identical tree OIDs.
//   * `core.fileMode` on the CHECKOUT leg. `read-tree --reset -u` writes the
//     TREE's mode to disk regardless of it. Measured under a repo-level
//     `core.fileMode=false`, in five shapes chosen to be the ones that could
//     diverge — target absent; present at `0644` with identical content;
//     present at `0644` with different content; a pre-restore index already
//     holding `100755` against a `0644` disk; and the reverse direction, a
//     `100644` tree against a disk file carrying the exec bit — the restored
//     mode followed the tree in all five (exec bit ON for the first four, and
//     STRIPPED in the fifth). Re-running each with `-c core.fileMode=true`
//     produced identical results, so a pin would be inert here whatever the
//     check-in leg decides. Recorded separately from the honored row above
//     because it answers a different question — that row says why the knob is
//     honored where it DOES reach, this one says the restore direction was
//     checked and the knob does not reach it at all.
//   * `core.untrackedCache`. The two `ls-files` legs that fix the delete-pass and
//     collision path sets are the only place it could change a path SET; measured
//     with it `false` and `true` after a `status` populated the cache, both
//     `ls-files -o` and `ls-files -o -i` returned identical listings.
//   * THE STAT-COMPARISON FAMILY — `core.checkStat`, `core.trustctime`,
//     `core.ignoreStat` and `core.preloadIndex` (`core.fsmonitor` belongs to it
//     by mechanism but is PINNED above, and carries that disposition instead).
//     One mechanism closes the family, which is why it is one row: these knobs
//     only ever decide when git may TRUST cached index stat data instead of
//     re-reading a file, and the scratch index this service stages into has
//     none — it is seeded by a bare `read-tree`, which writes no stat data at
//     all. Measured with `ls-files
//     --debug` on an index seeded by a bare `read-tree` — every entry reports
//     `ctime: 0:0`, `mtime: 0:0`, `dev: 0`, `ino: 0`, `size: 0`, against real
//     values in the repository's own index — so `update-index --add --remove`
//     re-stats and re-hashes every listed path unconditionally. Confirmed by
//     tree-OID identity across a same-size content change with the original
//     mtime restored (the input designed to fool a stat comparison) under
//     `core.trustctime=false`, `core.checkStat=minimal`, `core.ignoreStat=true`,
//     `core.preloadIndex=false`, `core.splitIndex=true`, `index.version=2`,
//     `index.skipHash=true`, `core.bigFileThreshold=1`, `core.compression=0`,
//     `core.looseCompression=0`, `core.fsyncMethod=writeout-only`,
//     `core.quotePath=false`, `core.sharedRepository=group` and
//     `core.maxTreeDepth=4096` — all fourteen identical to the unpinned
//     baseline. Being a property of a freshly seeded scratch index rather than of
//     any one knob, this also covers the stat knobs a future git adds.
//     `core.useReplaceRefs=false` was in this sweep and has been REMOVED from it,
//     which is the round-4 finding's second correction: the sweep drives the
//     CHECK-IN leg with no replace ref present, so its identity result cleared
//     nothing about object interpretation and citing it here read as a closure it
//     never performed. Its single disposition is the PINNED row above.
//   * `core.excludesFile` — STRUCTURAL, not measured, and flagged as such
//     because this section's other rows carry identity measurements and this one
//     cannot be read as if it did. It would otherwise be in population: it can
//     widen the ignore set, which is a PATH-SET effect on the check-in listing
//     and both delete passes. What rules it out is the argv itself — all three
//     listing legs pass `--exclude-per-directory=.gitignore` and no other
//     exclude source, and that flag does not consult it. The evidence is
//     therefore the invocation, which is stronger than a measurement rather than
//     weaker: a measurement would show it inert for the arguments tested, while
//     the argv shows it unreachable for all of them. See
//     {@link EXCLUDE_PER_DIRECTORY_GITIGNORE}, where that same agreement is
//     load-bearing for a different reason.
//   * `core.checkRoundtripEncoding`. Only reachable at all with an in-tree
//     `working-tree-encoding` declaration, which is a DELIBERATELY HONORED row
//     above. Measured with `*.txt working-tree-encoding=UTF-16LE` in-tree: host-
//     unset and `-c core.checkRoundtripEncoding=UTF-16LE` produce the identical
//     tree at exit 0. The one refusal reachable in that fixture — `fatal: BOM is
//     prohibited in 'wt.txt' if encoded as UTF-16LE` — fires identically with
//     the knob UNSET, so it belongs to the in-tree attribute's own BOM rule and
//     not to the host.
//
// READ AS INPUT — the host decides, and this service ASKS what it decided
// rather than pinning or tolerating it. One family, added by T6.1.
//
//   * `core.sparseCheckout` (with `core.sparseCheckoutCone`, `index.sparse` and
//     `$GIT_DIR/info/sparse-checkout`). This was the table's largest RECORDED
//     RESIDUAL and is now closed, so the row records both the defect and its
//     closure — a reader checking the closure needs the shape of what it closed.
//
//     THE DEFECT, as measured before T6.1: the scratch index a capture seeded
//     with `read-tree <base>` carries no skip-worktree bits, so `ls-files -c`
//     listed every out-of-cone path and `--remove` dropped each one for being
//     absent from the worktree — the snapshot tree simply did not contain them.
//     A restore of that snapshot then removed those paths' index entries, and
//     after the closing reset `git status` reported the whole out-of-cone set as
//     deleted. No pin fixed it, because the defect was never on the checkout leg:
//     as-shipped, `-c core.sparseCheckout=false` and `--no-sparse-checkout` all
//     produce BYTE-IDENTICAL loss there, the `false` pin only suppressing git's
//     `error: Path … not uptodate` advisory. `--ignore-skip-worktree-entries` on
//     the check-in leg was a no-op for the same reason (identical tree): a freshly
//     seeded scratch index has no skip-worktree bits to protect.
//
//     THE CLOSURE (`Spec-010 §Turn-Boundary Snapshots`, the amended capture
//     bullet; I-010-24) inverts the seed instead of pinning anything. In a
//     detected sparse root the scratch index is seeded as a COPY OF THE LIVE
//     INDEX, which carries the skip-worktree bits, so out-of-cone entries arrive
//     already-staged at their recorded blobs and `--remove` never sees them; the
//     staging listing is then partitioned by git's own sparsity matcher so
//     `--remove` is never even offered an out-of-cone path to re-stat. The
//     snapshot tree is FULL — sparseness is a checkout-time projection, not a
//     property of the recorded state — which is what makes the restore able to
//     re-project it.
//
//     Each co-tenant knob therefore has its own disposition now, because this
//     service reads all four rather than being merely exposed to them:
//
//       - `core.sparseCheckout` is the WHOLE detection predicate, read with
//         `config --type=bool --default=false --get`. The rules file is
//         deliberately not part of it: a set bit with an unreadable rules file
//         must reach the sparse arm so the matcher's own failure becomes a typed
//         capture failure, where an "is it really sparse?" heuristic would
//         silently take the non-sparse path and drop exactly what porcelain keeps
//         (measured — the worktree still holds the out-of-cone content).
//       - `core.sparseCheckoutCone` and `$GIT_DIR/info/sparse-checkout` are
//         DELEGATED, not read. `sparse-checkout check-rules -z` in its live-rules
//         form is the oracle, so cone-ness, pattern syntax and negation semantics
//         are resolved by the same code git resolves them with. This is the one
//         disposition that cannot be got right by reimplementation: the gitignore
//         machinery this module already runs (`--exclude-per-directory`) answers
//         a DIFFERENT question and over-includes under negation (measured — `/*`
//         plus `!/a/b/` scores `a/b/deep.txt` includable, and the cone does not).
//       - `index.sparse` is TOLERATED. A sparse index expands on demand for the
//         `ls-files` legs and git says so on stderr; this module reads stderr on
//         no leg (see {@link TurnSnapshotGitInvocationResult}), so the advisory is
//         structurally unable to become a failure. The listing content is
//         unaffected.
//
//     SCOPE, restated because the row's previous one was wrong in a way worth
//     recording: it read "the exposure is `in_place` mode on a user's canonical
//     repository", and `in_place` names no member of {@link ExecutionMode} at
//     all. The exposure is not a mode, it is a ROOT — any execution root whose
//     `core.sparseCheckout` bit is set. Canonically that is a `branch`-mode root,
//     which IS the user's own checkout and is therefore sparse whenever the user
//     made it so; a `worktree`-mode root reaches it too, by INHERITANCE, since
//     `git worktree add` copies the sparse state (driven by the suite, not
//     assumed); and an `ephemeral clone` starts full, which is a fact about how
//     the daemon creates it rather than a rule this module may rely on. Which is
//     exactly why detection reads the ROOT and never `input.mode` — a mode-keyed
//     detector would have inherited the old sentence's error as behaviour.
//
//     The residual this closure does NOT remove is MATERIALIZATION, and it is
//     stated rather than hidden: the restore's `read-tree --reset -u` writes every
//     path the CURRENT sparse definition admits, so a definition that changed
//     between capture and restore projects the full snapshot tree differently than
//     the capture-time one did. That is git's projection of a full tree through the
//     live definition, which is the correct behaviour and also an effect no result
//     arm names.
//
//     What the restore reports about it is an OBSERVATION, taken TWICE, under the
//     same observed-not-bookkept discipline the collision and gitlink enumerations
//     follow — and for the same reason they do. Before the checkout, in the
//     pre-mutation window, the restore reads which snapshot-tracked paths the LIVE
//     definition scores OUT of cone and are nevertheless sitting on disk, and
//     records a fingerprint for each. At report time it re-reads them and emits
//     only the ones that changed. So the diagnostic names paths the restore
//     actually DISCARDED, and a sequence that refused before the checkout — or
//     whose checkout failed at the spawn — emits nothing, because it discarded
//     nothing. Reporting the pre-mutation candidate list on that path would have
//     been a bookkept claim about work that did not happen, which is the exact
//     defect the sibling enumerations were written to avoid.
//
//     The honest limit of the reading: a definition WIDENED at restore time makes
//     the newly-admitted paths IN cone, so their materialization is ordinary
//     projection and this enumeration does not name them — the reported slice is
//     the out-of-cone-yet-present one the re-projection removes. See the suite's
//     sparse cases, which drive the closure rather than characterizing the loss.
//
//     Widening is ordinary in exactly one direction, though, and DESTRUCTIVE in
//     the other: a newly-admitted snapshot path whose place on disk is held by a
//     RECORDED BOUNDARY path is written over content the trailer promised to keep,
//     by the checkout itself, before any exemption is consulted. That case is
//     refused pre-mutation rather than reported — see
//     {@link TurnSnapshotService.#deriveBoundaryObstructions} for the three
//     shapes and for why a diagnostic would not have satisfied I-010-24.
//
// RECORDED RESIDUALS — the honest failure modes, closed by neither pin nor
// measurement. The family above used to be the other member of this section;
// what remains is the one whose pin set is unbounded by construction.
//
//   * `filter.<name>.smudge` / `.clean` / `.required`, where `<name>` arrives from
//     an IN-TREE attribute but the driver commands live in HOST config. Measured:
//     with `*.secret filter=redact` in-tree, a host `filter.redact.smudge` rewrote
//     the restored bytes (`PLAINTEXT` in the odb, `SMUDGED` on disk). `-c
//     filter.redact.smudge=` neutralizes that ONE driver (measured — the restore
//     returns `PLAINTEXT`), but the name is chosen by the repository, so the set
//     of knobs to pin is unbounded and no closed pin set exists. This is the same
//     mechanism the partial-restore section names as the archetypal mid-checkout
//     failure, seen from the bytes side rather than the failure side.
//
// ---------------------------------------------------------------------------
// Retention is WINDOW-BASED, and the git dir is the one that SURVIVES
// ---------------------------------------------------------------------------
//
// `Spec-010 §Turn-Boundary Snapshots` prunes "when the run's retention window
// closes (terminal state + the configured window)", which is two facts, not one.
// Terminal state alone does not prune: a rollback is a thing a user reaches for
// AFTER a run has finished, so deleting at the terminal event would make the
// snapshots useless exactly when they are wanted. So the mechanism is a SWEEP —
// {@link TurnSnapshotService.sweepPrunableRuns} deletes every run whose window
// has closed — rather than a terminal-invoked callback, and that shape is also
// what makes the daemon-startup reconcile fall out for free: a window that
// elapsed while the daemon was down is just a candidate the first sweep finds.
// A terminal-invoked design would have had to reconstruct those misses.
//
// The ref ops run through `git --git-dir=<git_common_dir>` — the value
// `run_execution_contexts` recorded at context creation — and NEVER through
// `execution_root`. This is the whole reason that column exists (its DDL comment
// says so). A `worktree`-mode root is physically retired by T2.2 when the
// workspace is done with it, which can happen long before the retention window
// closes; the refs, meanwhile, live in the SHARED common object store and are
// perfectly reachable from the canonical repository. Pruning through the
// execution root would therefore skip precisely the runs whose refs are still
// there, and would look like a working sweep while leaking every retired
// worktree's snapshots forever.
//
// Skip-and-enumerate, never fatal. A recorded `git_common_dir` that is gone at
// sweep time (the repository was removed) is not this sweep's failure — it is a
// run whose refs went with its repository. That run is SKIPPED, recorded in the
// pass's skip enumeration, and the pass continues; the per-run `try` sits INSIDE
// the loop for that reason, because one `EACCES` stranding every later candidate
// is the failure mode the never-fatal rule is written against.
//
// The skip vocabulary is three-way where a single `git-dir-unusable` would have
// been one line shorter, and the third arm is what keeps the other two honest.
// git answers a removed repository, a disposed clone, an `EACCES` on a live
// store, a missing `git` binary and a failure creating the daemon's own
// hook-neutralization directory with the SAME rejection, so the reason is
// attributed by a `stat` probe on the failure path plus the row's
// `execution_mode` — never by parsing git's stderr, and never by assuming.
// Absent-and-a-clone is `clone-disposed`, absent-otherwise is `git-dir-absent`,
// and present-but-unusable is `git-dir-unusable`, the fault arm. The probe fails
// TOWARD the fault (see `isPathProvablyAbsent`), because misreading an `EACCES`
// as a disposal is the mistake that goes quiet.
//
// The clone-disposal boundary is the same fact from the other side. In
// `ephemeral clone` mode the recorded common dir is the CLONE's own git dir, so
// the snapshot refs share the clone's disposal lifecycle: an `on_run_complete`
// disposal (T2.3) takes them with it, possibly before the retention window
// closes, and a later rollback of that run proceeds CONVERSATION-ONLY — the
// ruling campaign B2 recorded, with the file-leg disposition carried on the
// intervention outcome by Plan-004. Neither disposal nor sweep is a retention
// violation: a disposed clone leaves nothing to restore into, and the sweep
// fires only after the window. Concretely, the sweep then finds the recorded
// common dir gone and reports `clone-disposed` — the plan row's "the sweep then
// finds nothing to delete", which is why that arm alone does not raise the pass
// warn (see `sweepPrunableRuns`). On a clone-mode daemon it is otherwise EVERY
// run the daemon ever executed, arriving hourly, forever.
//
// Deletion is a COMPARE-AND-SWAP, matching the capture leg's posture: the
// enumeration reads `<oid> <refname>` and each deletion names the oid it read
// (`update-ref --no-deref -d <ref> <oid>`), so a ref that changed between the two is
// refused rather than deleted (git 2.50.1: exit 1, "cannot lock ref"). Nothing
// should be able to move a snapshot ref — I-010-22 makes every write create-only
// — which is exactly why naming the oid costs nothing and why a refusal here is
// worth hearing about rather than steamrolling.
//
// RESIDUALS, recorded rather than closed:
//
//   * The candidate set is every terminal WRITABLE run whose window has closed,
//     EVERY tick, forever — so the per-tick spawn count grows with the daemon's
//     LIFETIME run count, not with the number of runs that have anything left to
//     prune: a daemon with five thousand historical runs spawns five thousand
//     `git for-each-ref` processes an hour to delete nothing. Nothing memoizes an
//     already-pruned run, because the only durable key available is `released_at`
//     and a terminal-source rollback CLEARS and re-stamps it (the table's own DDL
//     comment); a memo keyed on it would go stale in exactly the case that
//     matters. `LIMIT` is not the missing bound either: with `ORDER BY
//     released_at ASC` and no memo it re-reads the same oldest N rows forever and
//     starves everything behind them. The one bound that IS sound is taken —
//     `read-only` runs can never have captured a ref, so the predicate excludes
//     them. Row retention for `run_execution_contexts` has no owner in the V1
//     corpus and is not this service's to invent: it holds no writer for that
//     table.
//   * The same absent memo has a SECOND consequence, on the operator channel: a
//     run that is skipped rather than pruned re-enumerates in the
//     `retention-prune-skipped` diagnostic every tick, for as long as its row
//     lives. That is plan-compelled, not an oversight — the row requires a
//     removed-repository run "skipped and enumerated in the sweep diagnostic",
//     and a pass that skips it and says nothing would not be enumerating it. So
//     a daemon whose canonical repository was deleted warns hourly, forever,
//     over a set that stops growing but never empties (no retention owner for
//     the rows). Only the `clone-disposed` arm is exempted, and that exemption
//     buys silence only where the set would otherwise grow without bound — see
//     {@link NON_ALARMING_SKIP_REASONS}.
//   * Spawn count scales with (turns x epochs) per run, because the ratified
//     recipe is per-ref `update-ref -d` rather than a batched `--stdin`
//     transaction. Deviating would need a plan amendment; the batched form is
//     also all-or-nothing, where the per-ref form partially prunes and reports.
//   * `released_at <= <cutoff>` is a TEXT comparison, so it is chronological only
//     while the column holds fixed-width UTC `toISOString()` spellings. That is a
//     forward contract on the T3.2 gate that stamps it, spelled the same way
//     `./ephemeral-clone-service.ts` spells its own `expires_at` contract.
//   * The sweep takes no lock against a concurrent rollback re-opening a run
//     whose window had already closed. The exposure is a rollback issued in the
//     same moment as a sweep of a run the retention policy had already released,
//     and its outcome splits by WHICH SIDE of the resolve the deletion lands on:
//     before it, the ordinary answer for a missing snapshot — a typed
//     no-snapshot/`ref-absent` refusal with nothing applied; between the resolve
//     and the application, the correct tree still applies, because the resolve
//     froze the snapshot's OID into the target and both legs downstream of it
//     name that OID, while the commit object outlives its last ref until `gc`.
//     Deleting the ref removes a NAME, not the snapshot. Never a wrong tree
//     either way; both sides are driven by one case in the retention suite,
//     "applies a snapshot whose ref the prune deleted inside the
//     resolve→restore window". There is a composite THIRD shape, recorded
//     because it is the one place the deletion still bites: a deletion inside
//     that window costs nothing until some UNRELATED step fails, and the
//     resulting partial restore is then terminal for its target, because the
//     fresh rollback's resolve refuses `ref-absent`. See
//     {@link TurnSnapshotPartialRestore}.
//
// ---------------------------------------------------------------------------
// Capture NEVER throws into the turn boundary
// ---------------------------------------------------------------------------
//
// `Spec-010 §Turn-Boundary Snapshots` makes snapshots a recovery convenience,
// not a turn gate: "capture failure emits an OTel diagnostic and never blocks or
// fails the turn". So {@link TurnSnapshotService.captureTurnSnapshot} has no
// throwing path at all: the caller gets a typed result on every arm. THREE
// pieces carry that, not one, because the last two run where a `catch` cannot
// reach them:
//
//   * The mode allowlist and the ref-component validation run first and return
//     typed results directly. They spawn nothing and touch nothing, so there is
//     no rejection for a `catch` to catch.
//   * ONE `try` with a step cursor wraps every fallible leg — the scratch-index
//     directory, each git invocation, the ref write — so the caller's `failed`
//     result names the step. A cursor rather than a list of `catch`es, because a
//     leg added later inherits the reporting instead of needing its own.
//   * The `finally` and the diagnostic sink are guarded in turn, because both run
//     where that `catch` cannot see them: a `finally` runs after it has already
//     produced the result, and the sink is called from inside the failure
//     reporter itself. The `finally` takes its own `try`; the sink takes a `try`
//     AND an attached `.catch`, since its `(diagnostic) => void` type admits an
//     async implementation whose rejection no `try` would ever see (see `#emit`).
//
// Two statements sit between the validation and the `try` — building the ref
// string and minting the scratch-index path — and are deliberately outside it.
// Both are total on inputs the validation has already accepted (string
// concatenation and `randomUUID`), which is what lets the `try` start below them
// without leaving a hole in the contract.
//
// ---------------------------------------------------------------------------
// I-010-10 — hook neutralization is STRUCTURAL (D-010-10)
// ---------------------------------------------------------------------------
//
// Every git invocation goes through one private `#runGit` which prepends
// `-c core.hooksPath=<empty dir>` and `-c core.fsmonitor=false`, so the
// quantifier is discharged by there being no other way to reach git from here.
// The full rationale — why the second flag is not redundant, why the directory
// is created per invocation rather than once, and why the argv is an ARRAY and
// never a shell string — is at `./worktree-service.ts`'s header and is not
// repeated. The neutralization directory is spelled identically to that module's
// and `./ephemeral-clone-service.ts`'s on purpose: three spellings would mean
// three directories, any of which a temp reaper could remove.
//
// The shell-free rule is load-bearing here in a way it is not for the sibling
// services, because the ratified recipe is written as a PIPE
// (`git ls-files … -z | git update-index … --stdin`). It is executed as two
// `execFile` invocations with the first's stdout handed to the second's stdin —
// same data, same order, no shell — and the listing travels as a Buffer rather
// than a string so a path git emitted as raw bytes survives the hop.
//
// Refs: Plan-010 (worktree lifecycle and execution modes), Spec-010
// (§Turn-Boundary Snapshots — the normative recipe), Spec-004 (§Required
// Behavior — the execution epoch), Plan-006 (the daemon's event log, which
// snapshots deliberately do NOT append to: a snapshot is a git fact, and
// `Spec-006` registers no snapshot event).

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { isAbsolute, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Database, Statement } from "better-sqlite3";

import type { ExecutionMode } from "@ai-sidekicks/contracts";

import {
  DEFAULT_GIT_EXECUTABLE,
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
} from "../workspace/repo-root-resolver.js";

// --------------------------------------------------------------------------
// Injected seams
// --------------------------------------------------------------------------

/**
 * Captured stdio from one SUCCESSFUL git invocation — a rejection carries its
 * own shape (see {@link TurnSnapshotGitRunner}), so nothing here describes one.
 *
 * `stdout` is a BUFFER, unlike the sibling services' string-typed results. The
 * capture pipeline's `-z` listings are byte streams — git emits path names
 * verbatim, and a path that is not valid UTF-8 would come back from a string
 * decode with replacement characters and be handed to `update-index --stdin` as
 * a path that does not exist.
 *
 * `stderr` is the EXIT-0 diagnostic channel, and it is on this shape precisely
 * because this module refuses to read it: `update-index --add --remove -z
 * --stdin` writes `Ignoring path nested/` and exits 0 on every capture that
 * contains an untracked embedded repository, so failure detection here is by
 * exit status alone. Surfacing that text on the success shape is what makes the
 * rule falsifiable — a wrapping runner can read the chatter off an invocation
 * this module treated as a success — rather than a claim only the prose makes.
 * A string, not a Buffer: it is human-facing text, never re-fed to a child.
 */
export interface TurnSnapshotGitInvocationResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** Per-invocation bounds and inputs. */
export interface TurnSnapshotGitInvocationOptions {
  /** Wall-clock ceiling; the child is killed past it. */
  readonly timeoutMs: number;
  /**
   * Variables layered over the module's own git environment, AFTER its strip
   * list is applied — `GIT_INDEX_FILE` at the scratch index, `GIT_ATTR_NOSYSTEM`
   * on the staging legs, and the six-var author/committer set on `commit-tree`.
   *
   * Per-invocation rather than per-service because the recipe is not uniform:
   * `GIT_INDEX_FILE` must reach the index-touching legs and must NOT reach the
   * `rev-parse HEAD` this module runs INSIDE an embedded repository.
   */
  readonly environmentOverrides?: Readonly<Record<string, string>>;
  /**
   * Written to the child's stdin, which is then closed. FOUR legs supply one:
   * `update-index --add --remove -z --stdin` (the staging listing),
   * `sparse-checkout check-rules -z` (the candidate paths), `update-index
   * --force-remove -z --stdin` (the restore's boundary-set index pre-drop) and
   * `commit-tree -F -` (the snapshot message).
   *
   * stdin is closed on EVERY invocation, supplied or not, and that close is now
   * LOAD-BEARING rather than a belt. `Spec-010 §Turn-Boundary Snapshots` calls
   * out the failure mode — `commit-tree` reading its message from stdin and
   * hanging wherever the daemon left stdin open — and T6.1 converted that leg
   * from `-m` argv to `-F -` deliberately, so the message is a stream this
   * module writes and closes rather than an argv element bounded by the
   * platform's argument limit. The hang the spec names is therefore reachable
   * exactly when this contract is broken, which is why it is stated here and not
   * only at the call site.
   */
  readonly stdin?: Buffer;
}

/**
 * The git process seam.
 *
 * Takes the COMPLETE argv — `-C <dir>` included — and no working directory, so
 * the argv is the whole invocation. Same reasoning, and the same deliberate
 * non-import of Plan-009's `GitFileExecutor`, that `./worktree-service.ts` and
 * `./ephemeral-clone-service.ts` each record at their own seam; this one differs
 * from both by carrying stdin and an environment overlay, which the snapshot
 * recipe needs and neither of theirs does.
 *
 * Rejections are opaque to this module: nothing reads a field off the thrown
 * value. Failure detection is BY EXIT STATUS ONLY, and that is not a stylistic
 * preference — `update-index --add --remove -z --stdin` writes
 * `Ignoring path nested/` to stderr and exits 0 on every capture that contains
 * an untracked embedded repository (confirmed on git 2.50.1), so a leg check
 * keyed on non-empty stderr would report a failure on exactly the input the
 * normalization pass below exists to handle.
 */
export type TurnSnapshotGitRunner = (
  argv: readonly string[],
  options: TurnSnapshotGitInvocationOptions,
) => Promise<TurnSnapshotGitInvocationResult>;

/**
 * The seam through which this service MUTATES the filesystem — and only that.
 *
 * Every verb is idempotent: `createDirectory` creates leading directories and
 * tolerates an existing one, `removePath` removes a file or a directory tree and
 * tolerates a missing one, `removeDirectoryIfEmpty` removes a directory only
 * when the removal is unambiguous and tolerates both a missing and a still-
 * populated one. The tolerance is load-bearing twice: for the scratch-index
 * cleanup, which runs in a `finally` and must not turn a capture failure into a
 * second one, and for the restore leg's directory pruning, where a directory
 * that turns out to still hold snapshot content is the ordinary case rather than
 * an error.
 *
 * The restore leg's OBSERVATIONS — the collision and gitlink path fingerprints
 * — deliberately do not come through here. They are reads, they
 * run on the failure path where a seam is the least trustworthy thing available,
 * and seaming them would hand every implementor (the suite's two capture-only
 * doubles included) verbs it has no opinion about. The boundary is therefore
 * "this interface is where the service writes", with ONE stated carve-out.
 *
 * THE CARVE-OUT is the sparse seed's index lock (T6.1), and the discriminator is
 * the idempotence sentence above rather than the write/read line. Copying the
 * live index under git's own lockfile protocol requires an EXCLUSIVE create of
 * `<index>.lock` — non-idempotent BY DESIGN, since a create that finds the file
 * already there is the contention signal the protocol is made of. Adding it here
 * would either break the invariant every other verb's tolerance rests on (the
 * `finally` cleanup and the restore's directory pruning are correct only because
 * their verbs tolerate a repeat) or force a fourth verb documented as the
 * exception to its own interface's opening line. So
 * {@link TurnSnapshotService.#seedScratchIndexFromLiveIndex} calls `node:fs`
 * directly, exactly as `fingerprintPath` and `isPathProvablyAbsent` already do
 * on the read side, and its failure mode is exercised against a REAL held lock
 * rather than through an injected seam — which is the stronger test anyway,
 * since the protocol being honoured is git's and not this module's.
 *
 * Paths are `string`, deliberately and with a known cost. A path name that is
 * not valid UTF-8 reaches these verbs with replacement characters, so the
 * removal silently finds nothing — the complete fix is Buffer-typed paths
 * throughout, which is not taken while this seam stays three narrow mutation
 * verbs whose every implementor (the suite's doubles included) would have to
 * carry the wider type for a case none of them exercises. The delete pass
 * compensates where it matters, by detecting a listing that did not change
 * instead of trusting that its removals removed (see
 * {@link splitNulTerminatedListing} for the same boundary on the capture side,
 * where the listing never gets decoded at all).
 */
export interface TurnSnapshotFilesystem {
  createDirectory(path: string): Promise<void>;
  removePath(path: string): Promise<void>;
  /**
   * Remove `path` when it is an EMPTY directory; a non-empty or absent one is a
   * no-op. Never recursive — the restore leg prunes directories its own
   * deletions emptied, and a recursive form here would delete the snapshot
   * content that made the directory non-empty in the first place.
   */
  removeDirectoryIfEmpty(path: string): Promise<void>;
}

/**
 * The capture pipeline's steps, in execution order. Named on the failure result
 * and on the diagnostic so a caller — and an operator reading the diagnostic —
 * learns WHERE a capture stopped without this module echoing git's stderr.
 *
 * {@link TurnSnapshotRestoreStep} is the restore sequence's own step vocabulary,
 * a SIBLING type rather than a growth of this one: `failedStep` on the restore
 * result is pinned name-identical to Plan-004's wire arms, and a shared union
 * would leak capture steps into a restore disposition.
 *
 * T6.1's sparse closure added exactly TWO members, slotted in execution order
 * rather than overloaded onto neighbours, because each is a distinct thing an
 * operator does about a failure:
 *
 *   * `detect-sparse-root` — the `core.sparseCheckout` read failed, which is a
 *     repository whose config could not be read at all. Never "not sparse": an
 *     unreadable predicate that defaulted to the non-sparse pipeline would drop
 *     exactly the content the closure exists to keep.
 *   * `check-sparse-rules` — git's sparsity matcher failed or is unavailable
 *     (`check-rules` predates no git this daemon supports on paper, but a
 *     below-2.41 binary reports an unknown subcommand, and an unreadable rules
 *     file reports `fatal: unable to load existing sparse-checkout patterns`).
 *     Both are fail-closed here rather than a degrade to an unpartitioned
 *     listing, which would be the shipped defect wearing a new name.
 *
 * The re-sourced seed keeps the shipped `seed-index` name deliberately. A sparse
 * root seeds from a copy of the LIVE index instead of `read-tree <base>`, but it
 * is the same step doing the same job at the same point in the sequence, and
 * splitting it would make one operator-visible failure into two spellings of
 * "the scratch index could not be seeded".
 */
export type TurnSnapshotCaptureStep =
  | "validate-inputs"
  | "prepare-scratch-index"
  | "resolve-base"
  | "detect-sparse-root"
  | "seed-index"
  | "list-paths"
  | "check-sparse-rules"
  | "stage-paths"
  | "normalize-embedded-repositories"
  | "write-tree"
  | "commit-tree"
  | "write-ref";

/**
 * The restore sequence's steps, in execution order — the vocabulary
 * `failedStep` speaks on the `partial_restore` arm, naming the command that
 * stopped so Plan-004's intervention outcome can say WHICH leg left the tree
 * where it is.
 *
 * The first two are pre-mutation by construction — with ONE qualification T6.1
 * added and did not want to leave implied. `derive-enumerations` now also
 * performs the sparse boundary set's INDEX PRE-DROP, which writes the index; a
 * failure there still leaves index and worktree untouched, because the drop is a
 * single `update-index --force-remove` invocation and git's index write is
 * atomic (lock, write, rename), so it either applied whole or not at all. What
 * the qualification costs is the stronger reading: a SUCCEEDED drop ahead of a
 * later failed step is reported by that later step, not by this one. The
 * property the spec's sentence protects — nothing is half-applied where a
 * failure is reported — survives; the property "no bytes moved at all under this
 * name" no longer does, and the drop is deliberately not given a step of its own
 * because Plan-004's wire mapping froze this vocabulary at five. The step's three
 * REFUSALS are all upstream of that drop — an undecodable trailer, the sparse
 * vintage gate and the boundary-obstruction guard all throw from inside the
 * read-only derivation — so each of them does still leave index and worktree
 * byte-identical, which is the stronger reading and the one the suite pins. The
 * last three
 * are the
 * pinned three-step of `Spec-010 §Turn-Boundary Snapshots`, in the order that
 * spec fixes: the delete pass must run while the index still holds the SNAPSHOT
 * tree, and `close-index` must run after it. Swapped, the close returns the
 * index to the branch tip and every captured-untracked file the restore just
 * materialized becomes a deletion candidate — a restore that silently deletes
 * the files it was asked to bring back.
 *
 * Two of the five need their reachability stated, because the vocabulary is
 * wider than the set `failedStep` actually reports:
 *
 *   * `verify-head` is NEVER a reported `failedStep`. It is the step cursor's
 *     initial value, and the restore's three `HEAD` reads all refuse through the
 *     `head_moved` ARM (or, for the last one, through `close-index`) rather than
 *     through this name. It stays in the union so the vocabulary covers the
 *     whole sequence rather than only its fallible-by-command half.
 *   * `close-index` is reachable THREE ways: the closing `read-tree` itself
 *     failing, and — from the post-mutation `HEAD` check that runs immediately
 *     before it (see {@link TurnSnapshotService.restoreToTurn}) — a `HEAD` that
 *     MOVED or a `HEAD` that could not be READ. The latter two are not git
 *     failures at all, and they differ from each other in whether a fresh
 *     rollback can recover, so the diagnostic detail names which one happened.
 */
export type TurnSnapshotRestoreStep =
  | "verify-head"
  | "derive-enumerations"
  | "read-tree"
  | "delete-untracked"
  | "close-index";

/**
 * Why one run's snapshot refs were not pruned. See {@link TurnSnapshotRetentionSkip}.
 *
 * The vocabulary splits FAULT from BOUNDARY: `clone-disposed` and
 * `git-dir-absent` are outcomes, while the rest are conditions somebody acts on.
 * The warn gate is drawn one notch tighter than that split — only
 * `clone-disposed` is silent, because only it is unbounded — so "the pass
 * diagnostic can quiesce" is a claim about a clone-mode daemon specifically. See
 * {@link NON_ALARMING_SKIP_REASONS} and
 * {@link TurnSnapshotService.sweepPrunableRuns}.
 */
export type TurnSnapshotRetentionSkipReason =
  /** The `runId` is not safe as a ref path component (I-010-21) — refused before any git call. */
  | "unsafe-run-id"
  /** No `run_execution_contexts` row names this run, so no git dir to prune through. */
  | "run-context-absent"
  /**
   * The `run_execution_contexts` read itself FAILED — a closed handle racing a
   * shutdown, a schema fault. Deliberately not `run-context-absent`: "I found
   * nothing" and "I could not look" are the two answers this leg must never
   * conflate, and only this one means the prune must be retried. Carries a
   * `retention-sweep-failed` diagnostic alongside, as the sweep's equivalent does.
   */
  | "run-context-unreadable"
  /**
   * An `ephemeral clone`-mode run whose recorded git dir is GONE — the T2.3
   * `on_run_complete` disposal took the refs with it, since they lived in the
   * clone's own object store. The expected boundary, not a fault: the plan row
   * reads "the sweep then finds nothing to delete", and a later rollback of that
   * run proceeds conversation-only (campaign B2). Excluded from the pass warn.
   */
  | "clone-disposed"
  /**
   * The recorded `git_common_dir` is absent from disk in a mode that does NOT
   * dispose its store — the plan row's "the repo was removed", which that row
   * requires to be "skipped and enumerated in the sweep diagnostic". So this one
   * DOES raise the pass warn, unlike `clone-disposed`.
   *
   * The distinction is SET SIZE, not report frequency — nothing memoizes on
   * either side, so both classes re-enumerate on every tick for as long as their
   * rows live (residual 1). But a removed repository implicates a BOUNDED set:
   * the runs that were executing in it when it vanished, a number that stops
   * growing the moment it does. Disposed clones are unbounded and growing —
   * every clone-mode run the daemon ever finishes adds one, forever. A warn that
   * says the same bounded thing until somebody deals with it is a warn; one that
   * grows without limit under normal operation is what drowns it.
   */
  | "git-dir-absent"
  /**
   * The recorded `git_common_dir` EXISTS and still could not be enumerated — a
   * permissions fault, a corrupt store, a missing `git` binary, or a failure
   * creating the daemon's own hook-neutralization directory. A genuine fault,
   * and the one that raises the pass warn.
   */
  | "git-dir-unusable"
  /**
   * The enumeration succeeded and at least one `update-ref -d` did not. The
   * refs that WERE deleted are still reported — this leg partially prunes and
   * says so, rather than pretending the pass was atomic.
   */
  | "ref-delete-failed";

/**
 * The skip reasons that do not raise the pass warn. A pass whose skips are all
 * in this set emits no `retention-prune-skipped` diagnostic at all, which is the
 * whole of "the warn can quiesce"; every skip is on the sweep RESULT either way.
 *
 * `git-dir-absent` is deliberately NOT a member even though it is equally an
 * outcome rather than a fault: the T5.3 row names that case specifically and
 * requires it "skipped and enumerated in the sweep diagnostic", and the set of
 * runs a removed repository implicates is BOUNDED — where disposed clones
 * accumulate one per clone-mode run, without limit, as the design works. Neither
 * side memoizes, so both re-report every tick; only the size differs, and the
 * unbounded one is what would drown the channel (see the reason's own docblock
 * and residual 1 in the header).
 *
 * COUPLED to the diagnostic's `disposedCloneCount`, which counts the skips whose
 * reason IS in this set — `skipped.length - actionableSkips.length`, where
 * `actionableSkips` is the complement. A second member here means renaming that
 * field, because it would no longer be counting only clones.
 */
const NON_ALARMING_SKIP_REASONS: ReadonlySet<TurnSnapshotRetentionSkipReason> =
  new Set<TurnSnapshotRetentionSkipReason>(["clone-disposed"]);

/**
 * One run the sweep declined to finish, and why.
 *
 * The plan's obligation is that such a run is "skipped and enumerated in the
 * sweep diagnostic, never fatal", so this is the enumeration's element type and
 * it appears BOTH on the per-run result and on the pass's diagnostic.
 */
export interface TurnSnapshotRetentionSkip {
  readonly runId: string;
  readonly reason: TurnSnapshotRetentionSkipReason;
  /** Free-form; the rejection's message when there was one. */
  readonly detail: string;
}

/**
 * What this service reports to the daemon's observability layer.
 *
 * Two kinds are spec-named: `Spec-010 §Turn-Boundary Snapshots` requires the
 * failure diagnostic ("capture failure emits an OTel diagnostic and never blocks
 * or fails the turn") and requires the skipped commitless embedded repositories
 * to be "enumerated in the capture diagnostic" — which happens on a capture that
 * otherwise SUCCEEDED, hence its own kind rather than a field on `capture-failed`.
 *
 * The rest are operational rather than spec-named.
 * `embedded-repositories-preserved` is the restore-side mirror of the skip
 * enumeration, and exists because the skip has a consequence the spec did not
 * anticipate: those repositories had to be protected from the restore's own
 * delete pass, and a daemon that silently declines to delete something owes an
 * operator the list. `scratch-index-cleanup-failed` covers a cleanup that is
 * best-effort by construction (it must never convert a completed capture into a
 * failure), where best-effort with no report is how a daemon leaks index files
 * into its own execution-roots directory for months without a signal. It is
 * deliberately NOT a `capture-failed`: the capture it follows may have fully
 * succeeded, and the outcome is reported by the RESULT, not here.
 *
 * Paths appear here deliberately. The `error-contracts.md` no-path-echo rule
 * governs typed errors that reach the WIRE; a diagnostic is daemon-local
 * observability, and enumerating which repositories were skipped is the whole
 * content of the obligation.
 */
export type TurnSnapshotDiagnostic =
  | {
      readonly kind: "capture-failed";
      readonly runId: string;
      readonly epoch: number;
      readonly turnOrdinal: number;
      /** `null` only when the inputs were refused before a ref could be built. */
      readonly ref: string | null;
      readonly failedStep: TurnSnapshotCaptureStep;
      /** Free-form; the rejection's message when there was one. */
      readonly detail: string;
    }
  | {
      readonly kind: "embedded-repositories-skipped";
      readonly runId: string;
      readonly epoch: number;
      readonly turnOrdinal: number;
      readonly ref: string;
      /**
       * Worktree-relative paths of untracked embedded repositories that could
       * not be recorded as gitlinks. Two measured causes, both non-blocking by
       * design: an unborn `HEAD` has no commit OID to record (porcelain
       * `git add -A` hard-fails on that input — `does not have a commit checked
       * out`, exit 128 on git 2.50.1), and a HEALTHY embedded repository whose
       * object format differs from the superproject's has an OID the
       * superproject index cannot hold (`update-index --cacheinfo` exit 129 on
       * git 2.50.1). Capture skips and enumerates in both, because capture never
       * blocks the turn.
       */
      readonly skippedPaths: readonly string[];
    }
  | {
      /**
       * The RESTORE side of the kind above: the skipped embedded repositories a
       * restore protected from its own delete pass.
       *
       * A DIAGNOSTIC rather than a field on the restore result, and the choice is
       * forced rather than preferred. `TurnSnapshotRestoreResult` is the shape
       * T3.13 froze for Plan-004's rollback consumer; adding a member to its
       * success arm changes a contract this task has no authority over, for
       * information that arm's consumer does not act on. The observability layer
       * is where "the daemon deliberately did not touch these paths" belongs, and
       * emitting it as the mirror of `embedded-repositories-skipped` means the two
       * halves of one lifecycle read the same way in a log: capture could not
       * record these, restore did not delete them.
       *
       * Emitted only when the set is non-empty and only after the delete pass has
       * run, so its presence means protection was actually exercised.
       */
      readonly kind: "embedded-repositories-preserved";
      readonly runId: string;
      /** The OWNING epoch — the resolved ref's own `epoch-<E>` segment. */
      readonly epoch: number;
      /** The target position — the resolved ref's own `turn-<N>` segment. */
      readonly turnOrdinal: number;
      readonly ref: string;
      /**
       * Worktree-relative paths recorded by the capture's
       * `Skipped-Embedded-Repositories` trailer, which the delete pass left alone
       * along with everything beneath them.
       */
      readonly preservedPaths: readonly string[];
    }
  | {
      /**
       * The materialized out-of-cone paths a sparse restore DISCARDED from the
       * worktree — the residual the host-config table's sparse row names,
       * reported instead of hidden.
       *
       * A snapshot tree is FULL: the capture records out-of-cone content because
       * sparseness is a checkout-time projection, not a property of the recorded
       * state. `read-tree --reset -u` then re-projects that tree through the cone
       * that is live AT RESTORE TIME, which is the correct behaviour and is also
       * the one restore effect a caller has no other way to learn about — a path
       * the live definition excludes can still be sitting in the worktree (the
       * cone widened and then narrowed again without a checkout, or git could not
       * un-materialize it), and the re-projection removes it while neither result
       * arm names the path.
       *
       * OBSERVED, never bookkept, which is this module's standing discipline for
       * a restore effect (see the header's partial-restore section), and observed
       * TWICE. Before the checkout, three facts fix the candidate set: the paths
       * the snapshot tree tracks, the ones git's matcher scores out-of-cone under
       * the LIVE definition, and the ones actually present on disk (a path in the
       * first two and absent from disk is the ordinary unmaterialized case and is
       * never a candidate). Each candidate's pre-mutation
       * {@link fingerprintPath} is recorded. At report time each is re-read, and
       * only the changed ones are named — so this says what the restore DID,
       * never what it was going to do.
       *
       * The second observation is what makes the arm safe on the failure path. A
       * `partial_restore` that refused at window two, or whose checkout failed at
       * the spawn, discarded nothing: every candidate fingerprints equal and the
       * diagnostic is not emitted at all. One that got past the checkout and
       * failed at `delete-untracked` or `close-index` reports the real set. The
       * candidate list alone could not tell those apart.
       *
       * A DIAGNOSTIC and not a result field, for the reason
       * `embedded-repositories-preserved` states at length: T3.13 froze
       * `TurnSnapshotRestoreResult` for Plan-004's consumer, and this task has no
       * authority to grow a union that consumer switches on. Emitted at most ONCE
       * per restore — on the success tail after the last leg that can fail, or
       * from the failure reporter, never both.
       */
      readonly kind: "sparse-out-of-cone-materialized";
      readonly runId: string;
      /** The OWNING epoch — the resolved ref's own `epoch-<E>` segment. */
      readonly epoch: number;
      /** The target position — the resolved ref's own `turn-<N>` segment. */
      readonly turnOrdinal: number;
      readonly ref: string;
      /**
       * Worktree-relative, sorted. Snapshot-tracked paths that the live sparse
       * definition scores OUT of cone, that were observed materialized before the
       * checkout, and whose on-disk state the restore then changed. Never empty
       * — an empty set is not emitted.
       */
      readonly materializedPaths: readonly string[];
    }
  | {
      readonly kind: "scratch-index-cleanup-failed";
      readonly runId: string;
      readonly epoch: number;
      readonly turnOrdinal: number;
      /** The scratch index that survived. Daemon-local, never a worktree path. */
      readonly scratchIndexPath: string;
      /** Free-form; the rejection's message when there was one. */
      readonly detail: string;
    }
  | {
      /**
       * A restore that stopped mid-sequence — the `partial_restore` result's
       * operational half. The RESULT carries the disposition Plan-004 maps
       * (`failedStep` plus the two enumerations); this carries the one thing the
       * result deliberately does not, the rejection's `detail`, exactly as
       * `capture-failed` does for the capture leg.
       *
       * The line this module draws is FAULT versus REFUSAL, not failure versus
       * success. A `head_moved` re-verify, an absent snapshot and unusable
       * inputs are contract answers the caller acts on — refusals — and are not
       * diagnosed. A restore that stopped mid-sequence is a fault, and so is the
       * `probe-failed` resolution below: both mean the daemon could not do what
       * it was asked, which is what an operator is paged about.
       *
       * `detail` is therefore the operator's WHOLE channel here, and the two
       * `close-index` failures that are not git rejections carry a written detail
       * for that reason: `failedStep` cannot distinguish a `HEAD` that moved (this
       * target is finished) from one that could not be read (a fresh rollback may
       * well succeed), and the difference decides what to do next.
       */
      readonly kind: "restore-failed";
      readonly runId: string;
      /** The OWNING epoch — the resolved ref's own `epoch-<E>` segment. */
      readonly epoch: number;
      /** The target position — the resolved ref's own `turn-<N>` segment. */
      readonly turnOrdinal: number;
      readonly ref: string;
      readonly failedStep: TurnSnapshotRestoreStep;
      /** Free-form; the rejection's message when there was one. */
      readonly detail: string;
      /** As on the result: observed, required, empty-when-none. */
      readonly overwrittenIgnoredPaths: readonly string[];
      readonly divergentGitlinks: readonly string[];
    }
  | {
      /**
       * The resolver could not ASK the repository — the ref probe failed and so
       * did a bare `rev-parse --git-dir` against the same root, which is a
       * vanished execution root, an `EACCES`, or no git binary at all.
       *
       * A fault, not a refusal, which is why it is diagnosed where the three
       * other `no_snapshot` reasons are not: reporting "no snapshot" for a
       * question nobody could put would otherwise be the daemon's quietest
       * possible failure. The caller still refuses the whole rollback either
       * way, so the diagnostic is the ONLY signal this condition produces.
       */
      readonly kind: "restore-probe-failed";
      readonly runId: string;
      /** The OWNING epoch the walk selected before the probe failed. */
      readonly epoch: number;
      /** The target position — the ref's own `turn-<N>` segment. */
      readonly turnOrdinal: number;
      readonly ref: string;
      /** Free-form; what was attempted, since the rejection itself is swallowed. */
      readonly detail: string;
    }
  | {
      /**
       * ONE per sweep pass that skipped at least one run — the "skipped and
       * enumerated in the sweep diagnostic" obligation of the T5.3 plan row,
       * spelled as the plan spells it: a PASS-level enumeration, not a
       * diagnostic per skipped run.
       *
       * Deliberately so. The operational fact an operator acts on is "this
       * daemon has N runs it can no longer prune", and N separate lines is the
       * shape that gets filtered out as noise on the day N is large — which is
       * the day it matters. The per-run primitive stays quiet and returns its
       * skip on the RESULT; a direct caller reads it there.
       *
       * Carries no `runId` / `epoch` / `turnOrdinal`: a pass spans runs and no
       * turn at all. {@link warnDiagnostic} branches on that rather than
       * rendering `epoch=undefined`.
       */
      readonly kind: "retention-prune-skipped";
      /**
       * The skips an operator can act on. Non-empty by construction — the sweep
       * does not emit an empty enumeration — and deliberately NOT every skip of
       * the pass: see `disposedCloneCount`.
       */
      readonly skipped: readonly TurnSnapshotRetentionSkip[];
      /**
       * How many candidates were skipped because their ephemeral clone had been
       * disposed. A COUNT rather than an enumeration, and that is the whole
       * point: on a clone-mode daemon EVERY run ever executed ends here, nothing
       * memoizes an already-seen one (see the header's residuals), and by the
       * plan's own ruling there is nothing to act on — so enumerating them would
       * bury the actionable skips beside them under a list that only grows. The
       * sweep RESULT still carries every one of them in full.
       */
      readonly disposedCloneCount: number;
      /** How many runs the pass examined, so the skip count reads as a proportion. */
      readonly examinedRunCount: number;
    }
  | {
      /**
       * A retention read FAILED, so a prune that should have been decided was
       * not. TWO legs emit this kind, because it is one fault seen at two
       * scopes, and the `runId` field is what tells them apart:
       *
       *   * {@link TurnSnapshotService.sweepPrunableRuns} — the sweep could not
       *     run AT ALL: its candidate read rejected, or the clock did not honour
       *     its contract. No `runId`; the pass never got far enough to name one.
       *     This is the daemon's ONLY signal for that condition, because the
       *     sweep returns an empty result and never throws (a background leg on a
       *     timer, where a rejection is an unhandled one) — so an unreported
       *     candidate read would be a retention policy that silently stopped
       *     applying.
       *   * {@link TurnSnapshotService.pruneSnapshotsForRun} — ONE run's
       *     `run_execution_contexts` row was unreadable. That leg also returns a
       *     typed `run-context-unreadable` skip, so the emission is not its only
       *     channel; it exists so the identical fault reaches a subscriber by the
       *     same path from both entry points rather than only through a return
       *     value nothing is subscribed to. Carries `runId`.
       *
       * Distinct from the enumeration above either way, which reports runs
       * skipped inside a pass that otherwise worked.
       */
      readonly kind: "retention-sweep-failed";
      /** Free-form; the rejection's message when there was one. */
      readonly detail: string;
      /**
       * The run whose row could not be read — present ONLY on the per-run
       * emitter, where the fault is attributable, and absent on the sweep's,
       * where no single run is implicated. Optional rather than nullable so the
       * sweep's payload is byte-unchanged by its addition.
       */
      readonly runId?: string;
    };

export interface TurnSnapshotServiceDeps {
  /**
   * The daemon's execution-roots directory (D-010-6). Two of this service's own
   * directories hang off it: the shared hook-neutralization directory (empty, by
   * contract) and the scratch-index directory the temp-index recipe requires to
   * live OUTSIDE the worktree.
   *
   * Absolute by contract, as it is for `./worktree-service.ts`. Not re-validated
   * here; the daemon's configuration layer owns that check.
   */
  readonly executionRootsDirectory: string;
  /**
   * The daemon's SQLite handle, for the RETENTION leg alone — the only leg that
   * reads `run_execution_contexts` (`released_at`, `git_common_dir`).
   *
   * OPTIONAL, and that is the contract rather than a convenience. CP-010-12
   * makes capture and restore pure callees that hold no database handle at all,
   * so a service constructed for the turn boundary passes none and is unchanged
   * by this leg's existence. Prepared statements are built here only when a
   * handle IS supplied; {@link TurnSnapshotService.sweepPrunableRuns} and
   * {@link TurnSnapshotService.pruneSnapshotsForRun} throw when it was not,
   * because a retention sweep that answers "nothing to prune" on a mis-wired
   * daemon is indistinguishable from one that is working (see those methods).
   */
  readonly database?: Database;
  /**
   * How long a run's snapshot refs outlive its terminal release, in
   * milliseconds. Defaults to
   * {@link DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS}.
   *
   * Daemon configuration expressed as constructor config, following T2.3's
   * ephemeral-clone TTL exactly: `Spec-010 §Turn-Boundary Snapshots` calls the
   * window "configured" without fixing a number, and the corpus-true home for a
   * Plan-010 daemon-side duration is daemon config, not the wire.
   */
  readonly retentionWindowMs?: number;
  /** Git process seam; defaults to {@link runTurnSnapshotGitWithExecFile}. */
  readonly git?: TurnSnapshotGitRunner;
  /** Filesystem seam; defaults to `node:fs/promises`. */
  readonly filesystem?: TurnSnapshotFilesystem;
  /** Per-invocation git timeout; defaults to two minutes. */
  readonly gitCommandTimeoutMs?: number;
  /**
   * The turn-boundary instant, stamped into the snapshot commit's author and
   * committer dates. Injectable for tests.
   *
   * MUST return `Date.prototype.toISOString()` form. The value is converted to
   * git's raw `<unix-seconds> +0000` spelling, so the OFFSET never varies with
   * the host's timezone: author and committer dates are commit-object fields and
   * therefore OID inputs, and a `-0700` host would otherwise mint a different
   * snapshot OID than a `+0000` one for identical project state at the identical
   * instant (`Spec-010 §Turn-Boundary Snapshots`).
   *
   * The RETENTION leg reads the same clock for its window arithmetic, and the
   * `toISOString()` requirement is load-bearing a second time there: the
   * candidate predicate is a TEXT comparison against `released_at`, which is
   * chronological only between fixed-width UTC spellings.
   */
  readonly now?: () => string;
  /**
   * Where capture diagnostics go. Defaults to a `console.warn` rendering.
   *
   * TRIPWIRE: `Spec-010 §Turn-Boundary Snapshots` names an OTel diagnostic, and
   * this package has no OpenTelemetry substrate yet — this seam is the
   * attachment point for one, and the default is the interim sink
   * `../pty/pty-host-selector.ts` uses for the same reason. Replace the default,
   * not the seam.
   *
   * A sink that throws is contained, and so is an `async` one that rejects —
   * this return type ADMITS a promise-returning implementation, which is what an
   * OTel exporter tends to be. See {@link TurnSnapshotService}'s `#emit`. Capture
   * never throws into the turn boundary (see the header), and an observability
   * failure is the last thing that should break a run.
   */
  readonly emitDiagnostic?: (diagnostic: TurnSnapshotDiagnostic) => void;
}

// --------------------------------------------------------------------------
// Inputs and results
// --------------------------------------------------------------------------

/**
 * Inputs for {@link TurnSnapshotService.captureTurnSnapshot}. Every field is
 * caller-resolved (CP-010-12); see the header.
 */
export interface CaptureTurnSnapshotInput {
  /**
   * The run's execution root — the worktree, the main checkout (`branch` mode)
   * or the ephemeral clone. Resolved by the caller from the
   * `run_execution_contexts` row (D-010-5); the capture leg never reads that
   * table itself (CP-010-12 — only the retention leg does, for a different
   * column and on a different trigger; see the header).
   */
  readonly executionRoot: string;
  /**
   * The run this snapshot belongs to. Interpolated into the ref path, so it is
   * validated as a ref component before any git call (I-010-21; see the header).
   *
   * Typed `string` rather than the `RunId` brand: `packages/contracts` declares
   * that brand TYPE-ONLY until Plan-005 T4.2 ships its schema, and
   * `./worktree-service.ts` takes run provenance as a plain string for the same
   * reason.
   */
  readonly runId: string;
  /**
   * The run's execution epoch — `Spec-004 §Required Behavior`: `0` before any
   * rollback, advanced with each accepted `run.rolled_back`. SUPPLIED, never
   * derived: this service holds no rollback history and cannot reconstruct it.
   */
  readonly epoch: number;
  /** The turn position this snapshot records. Non-negative integer. */
  readonly turnOrdinal: number;
  /**
   * The run's execution mode, read by the caller from the same
   * `run_execution_contexts` row it read the root from. `read-only` returns the
   * typed no-op; `branch` / `worktree` / `ephemeral clone` run the pipeline (the
   * Applicability bullet of `Spec-010 §Turn-Boundary Snapshots`).
   */
  readonly mode: ExecutionMode;
}

/** A snapshot this call created. */
export interface TurnSnapshotCaptured {
  readonly outcome: "captured";
  /** `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>` (I-010-21). */
  readonly ref: string;
  /** The snapshot commit the ref now names. */
  readonly snapshotCommit: string;
  /**
   * The ONE base OID resolved at entry, used for both the tree base and the
   * recorded parent. Reported because the restore leg's fail-closed precondition
   * (T5.2 / I-010-23) is "current `HEAD` equals this", and a caller that wants to
   * know whether a later restore is still possible should not have to re-derive
   * it from the commit object.
   */
  readonly baseCommit: string;
  /**
   * Untracked embedded repositories that could not be recorded as gitlinks —
   * empty on the ordinary capture. The same list is enumerated in the diagnostic
   * (`Spec-010 §Turn-Boundary Snapshots`); it is repeated here so the caller can
   * record it on the turn without subscribing to the diagnostic sink.
   */
  readonly skippedEmbeddedRepositories: readonly string[];
}

/**
 * The create-only ref was already written — a retried or duplicated capture of
 * the same `(runId, epoch, turnOrdinal)` (I-010-22). Idempotent SUCCESS.
 */
export interface TurnSnapshotAlreadyCaptured {
  readonly outcome: "already-captured";
  readonly ref: string;
  /**
   * The RECORDED OID — read back off the ref, never the commit this call built.
   * That distinction is the invariant: the first successful write wins, and a
   * later capture of the same turn under the same epoch never repoints the ref
   * at later file state.
   *
   * Bounded, per the header's symref BOUNDARY paragraph: this is whatever the
   * ref names ON DISK at read time, which under a co-resident writer holding
   * repository write access need not be an OID this service ever recorded.
   */
  readonly snapshotCommit: string;
}

/**
 * The mode does not snapshot: nothing was captured, and nothing was written — no
 * git object, no ref, no directory (the Applicability bullet of `Spec-010
 * §Turn-Boundary Snapshots`).
 */
export interface TurnSnapshotNotApplicable {
  readonly outcome: "not-applicable";
  /**
   * `read-only-mode` is the spec-named case. `mode-not-snapshot-capable` is the
   * ALLOWLIST's default arm — reported for a mode that reaches
   * {@link SNAPSHOT_APPLICABLE_MODES} without being on it, which today is
   * unreachable and after a future `ExecutionMode` member is the deliberate
   * inert answer. Two reasons rather than one because the arms are not the same
   * fact: one is a decision the spec made, the other is a decision nobody has
   * made yet.
   */
  readonly reason: "read-only-mode" | "mode-not-snapshot-capable";
  readonly mode: ExecutionMode;
}

/**
 * Capture did not complete. The turn boundary completes anyway — this result is
 * a report, never a signal to retry or to fail the turn.
 */
export interface TurnSnapshotCaptureFailed {
  readonly outcome: "failed";
  /** `null` when the inputs were refused before a ref could be built. */
  readonly ref: string | null;
  /** Which step stopped. The detail travels on the diagnostic, not here. */
  readonly failedStep: TurnSnapshotCaptureStep;
}

/** Every outcome {@link TurnSnapshotService.captureTurnSnapshot} can report. */
export type TurnSnapshotCaptureResult =
  | TurnSnapshotCaptured
  | TurnSnapshotAlreadyCaptured
  | TurnSnapshotNotApplicable
  | TurnSnapshotCaptureFailed;

/**
 * One epoch of a run's execution lineage: the epoch number and the position it
 * rewound TO (`Spec-004 §Required Behavior`; `0` for the run's first epoch,
 * which rewound from nothing).
 *
 * Both fields are the CALLER's (CP-010-12) — the Plan-004 run engine derives the
 * ordered list from its durable epoch / intervention records. This service holds
 * no rollback history and could not reconstruct one.
 */
export interface TurnSnapshotEpochLineageEntry {
  readonly epoch: number;
  /**
   * The position this epoch rewound to. Positions at or BELOW it belong to the
   * parent epoch (the prefix an epoch inherits); positions strictly above it are
   * this epoch's own territory.
   */
  readonly rewindBase: number;
}

/** Inputs for {@link TurnSnapshotService.resolveRestoreTarget}. */
export interface ResolveRestoreTargetInput {
  /** The run's execution root, caller-resolved exactly as at capture. */
  readonly executionRoot: string;
  /** The run whose snapshots are being resolved (a validated ref component). */
  readonly runId: string;
  /** The turn position the rollback targets. Non-negative integer. */
  readonly targetPosition: number;
  /**
   * The run's execution lineage. Order is not relied upon: the owning epoch is
   * the MAXIMUM epoch whose `rewindBase` is strictly below `targetPosition`, so
   * an unsorted list resolves the same owner rather than a plausible wrong one.
   */
  readonly epochLineage: readonly TurnSnapshotEpochLineageEntry[];
}

/** The resolver's minted fields; see {@link TurnSnapshotRestoreTarget}. */
interface RestoreTargetFields {
  readonly executionRoot: string;
  readonly runId: string;
  readonly targetPosition: number;
  readonly owningEpoch: number;
  readonly ref: string;
  readonly snapshotCommit: string;
  readonly expectedHead: string;
}

/**
 * Every target {@link mintRestoreTarget} has produced, and the authoritative
 * answer {@link TurnSnapshotRestoreTarget.isMinted} gives.
 *
 * A registry rather than an instance check, because BOTH of the checks a class
 * can make about itself are defeatable from JavaScript:
 *
 *   * `private constructor` is a compile-time-only modifier — it erases at emit,
 *     so `Reflect.construct(TurnSnapshotRestoreTarget, [fields])`,
 *     `new (TurnSnapshotRestoreTarget as any)(fields)` and a JS subclass calling
 *     `super(fields)` all run the constructor body;
 *   * every one of those installs the private field too, so a `#field in value`
 *     brand check accepts all three.
 *
 * Membership is added at exactly one place — the mint below — and there is no
 * exported handle on this set, so a caller outside this FILE cannot forge a
 * member at all. `WeakSet` so a target that goes out of scope is collectable;
 * nothing here ever needs to enumerate the live set.
 *
 * Module-scoped, not per-service: a target minted by one {@link
 * TurnSnapshotService} is legitimately applied by another (the suite's recording
 * and fault-injecting runners are separate instances), and the object already
 * carries the execution root and ref it was resolved against.
 */
const mintedRestoreTargets: WeakSet<object> = new WeakSet();

/**
 * The module-private mint, assigned by the class's static block below — the one
 * way a {@link TurnSnapshotRestoreTarget} comes into existence, and the one place
 * {@link mintedRestoreTargets} gains a member.
 *
 * A module-level function rather than a static factory because the resolver
 * lives on a DIFFERENT class ({@link TurnSnapshotService}), which a `private`
 * constructor and a private static factory alike would both keep out. The
 * static block is what reaches the private constructor; the binding it writes
 * is not exported, so the mint stays inside this file.
 *
 * Definite-assignment (`!`) because the assignment happens at class-evaluation
 * time, which the compiler cannot see through.
 */
let mintRestoreTarget!: (fields: RestoreTargetFields) => TurnSnapshotRestoreTarget;

/**
 * An accepted resolution — the snapshot exists in its owning epoch's territory
 * and the fail-closed `HEAD` precondition held at resolve time (I-010-23).
 *
 * This whole object is what {@link TurnSnapshotService.restoreToTurn} BINDS, so
 * it carries every input that leg needs: a caller cannot hand the applier a root
 * and a ref that were never resolved together.
 *
 * A sealed CLASS rather than an interface, because that binding is only worth
 * something if it cannot be faked. The applier drives `read-tree --reset -u
 * <ref>` against the root on this object, so a hand-built
 * `{outcome: "resolved", ref: "refs/heads/main", executionRoot: "/somewhere"}`
 * would be an arbitrary checkout of an arbitrary ref into an arbitrary
 * directory, wearing this module's authority and its hook neutralization. Three
 * mechanisms close that, and they close different holes:
 *
 *   * the private field makes the type NOMINAL — a structurally identical
 *     object literal is not assignable to it, so the forgery does not compile;
 *   * {@link TurnSnapshotRestoreTarget.isMinted} is re-checked at the top of
 *     `restoreToTurn`, and it asks {@link mintedRestoreTargets} rather than
 *     asking the value about itself. That covers the FORGING caller the type
 *     system cannot see: the JS caller, the `as` cast, and the three paths that
 *     reach the erased-at-emit `private constructor` and would therefore
 *     satisfy any self-reported brand — `Reflect.construct`, `new (X as
 *     any)()`, and a subclass `super()`;
 *   * the mint freezes the instance, because `readonly` erases at emit exactly
 *     as the constructor's privacy does. That covers the MUTATING caller:
 *     without it, a holder of a genuine target could reassign `ref` after the
 *     resolve and drive the applier at a ref nobody resolved. Membership
 *     proves the object's provenance; the freeze is what makes its field
 *     values carry that provenance too.
 *
 * The cost is that a target cannot be serialized and rehydrated across a process
 * boundary. Nothing needs to, and that is a contract fact rather than a hope:
 * `Spec-004 §Required Behavior` makes recovery from an incomplete file leg a
 * FRESH rollback intervention that re-runs both legs, and restart reconciliation
 * re-dispatches rather than resuming a held resolution (Plan-004 T3.13). A
 * target's lifetime is one intervention, in one process.
 */
export class TurnSnapshotRestoreTarget {
  /**
   * COMPILE-TIME nominality, and nothing else: a private instance member is what
   * makes this class type unassignable from a structurally identical object
   * literal, so the forgery does not compile. It has no runtime reader by design —
   * {@link TurnSnapshotRestoreTarget.isMinted} tests {@link
   * mintedRestoreTargets} membership instead, because a brand FIELD is installed
   * by every constructor path including the forged ones.
   */
  // eslint-disable-next-line no-unused-private-class-members -- type-level use only; see above
  readonly #mintedByResolver = true as const;

  readonly outcome = "resolved" as const;
  readonly executionRoot: string;
  readonly runId: string;
  /** The position asked for — the resolved ref's `turn-<N>` segment. */
  readonly targetPosition: number;
  /** The epoch that OWNS that position — the ref's `epoch-<E>` segment. */
  readonly owningEpoch: number;
  readonly ref: string;
  readonly snapshotCommit: string;
  /**
   * The snapshot's recorded first parent (`<ref>^`) — the value `HEAD` must
   * equal. Checked FOUR times in all: once at resolve time, then three more
   * inside `restoreToTurn` (at entry, after the derivation, and before the
   * closing index reset — the TOCTOU guards; see
   * {@link TurnSnapshotService.restoreToTurn} for what each window costs).
   *
   * The last of those checks also USES it: the closing reset is spelled with this
   * OID rather than with the name `HEAD`, so the comparison and the command
   * cannot end up talking about different commits.
   */
  readonly expectedHead: string;

  private constructor(fields: RestoreTargetFields) {
    this.executionRoot = fields.executionRoot;
    this.runId = fields.runId;
    this.targetPosition = fields.targetPosition;
    this.owningEpoch = fields.owningEpoch;
    this.ref = fields.ref;
    this.snapshotCommit = fields.snapshotCommit;
    this.expectedHead = fields.expectedHead;
  }

  /**
   * Whether `value` is a target THIS MODULE minted.
   *
   * {@link mintedRestoreTargets} membership, which is a claim about PROVENANCE
   * rather than about shape: the set gains a member only in the mint, and no
   * handle on it leaves this file, so a value outside this module cannot be
   * forged into a `true` here. That is a stronger statement than either
   * `instanceof` (defeated by a reassigned prototype, and satisfied by a
   * subclass) or a `#mintedByResolver in value` brand check (satisfied by
   * `Reflect.construct` and by a subclass `super()` call, both of which reach the
   * erased-at-emit `private constructor`) can make.
   *
   * A `static` because a caller outside this module has no other way to ask —
   * the registry is not exported, and the whole point is that it is not.
   */
  static isMinted(value: unknown): value is TurnSnapshotRestoreTarget {
    return typeof value === "object" && value !== null && mintedRestoreTargets.has(value);
  }

  static {
    mintRestoreTarget = (fields: RestoreTargetFields): TurnSnapshotRestoreTarget => {
      const target = new TurnSnapshotRestoreTarget(fields);
      // `readonly` erases at emit; the freeze is what holds the
      // resolved-together binding against a MUTATING caller (the registry only
      // covers a forging one). Complete because every field is a primitive.
      Object.freeze(target);
      mintedRestoreTargets.add(target);
      return target;
    };
  }
}

/**
 * The fail-closed precondition did not hold: branch history advanced past the
 * snapshot, or one of the two sides could not be read at all.
 *
 * `null` on either side means "could not be read", which refuses for the same
 * reason a mismatch does — the equality must be ESTABLISHED (I-010-23), never
 * merely un-contradicted.
 */
export interface TurnSnapshotResolutionHeadMoved {
  readonly outcome: "head_moved";
  readonly ref: string;
  readonly owningEpoch: number;
  readonly expectedHead: string | null;
  readonly observedHead: string | null;
}

/**
 * No snapshot to restore. NEVER a fallthrough: an absent ref in the owning
 * epoch's territory refuses here rather than resolving a superseded parent
 * epoch's same-ordinal ref (I-010-23).
 */
export interface TurnSnapshotResolutionNoSnapshot {
  readonly outcome: "no_snapshot";
  /** `null` when the inputs were refused before a ref could be built. */
  readonly ref: string | null;
  /** `null` when no epoch in the lineage owns the target position. */
  readonly owningEpoch: number | null;
  /**
   * Why. `ref-absent` is the spec's gap case (a failure-tolerant capture left
   * one); `no-owning-epoch` is a target position no epoch's territory contains;
   * `unusable-inputs` is a caller whose run id or positions could not name a ref
   * at all; `probe-failed` is the honest answer when the repository could not be
   * ASKED — see {@link TurnSnapshotService.resolveRestoreTarget}.
   *
   * All four ride this one arm deliberately: `Spec-004 §Required Behavior`
   * rejects the whole intervention on EVERY non-resolved arm, so the behavioural
   * set is unchanged, and Plan-004 T3.13 pins the union's OUTCOME names (an
   * accepted resolution plus the two named refusals) while leaving this reason
   * vocabulary service-local. A reason keeps the distinction an operator needs
   * without widening what the caller must branch on.
   */
  readonly reason: "ref-absent" | "no-owning-epoch" | "unusable-inputs" | "probe-failed";
}

/**
 * Every outcome {@link TurnSnapshotService.resolveRestoreTarget} can report.
 *
 * The `outcome` values on this union and on {@link TurnSnapshotRestoreResult}
 * are SNAKE_CASE while every other discriminant in this file is kebab
 * (`already-captured`, `not-applicable`, `mode-not-snapshot-capable`). That is
 * not an oversight and must not be normalized: `head_moved`, `no_snapshot`,
 * `restored` and `partial_restore` are pinned name-identical to the arms
 * Plan-004 T3.13 maps onto its `RollbackInterventionResult` disposition, so the
 * mapping is an identity rather than a rename. A tidying pass over these four
 * strings would silently break a cross-plan contract that compiles fine.
 */
export type TurnSnapshotResolution =
  | TurnSnapshotRestoreTarget
  | TurnSnapshotResolutionHeadMoved
  | TurnSnapshotResolutionNoSnapshot;

/**
 * The restore ran to completion: the pinned three-step applied and the index was
 * closed back to `HEAD`.
 *
 * Both enumerations are REQUIRED and empty-when-none — the field names are
 * pinned name-identical to Plan-004's wire arms so the T3.13 mapping is an
 * identity, never a rename.
 *
 * What this arm ATTESTS, per the header's symref BOUNDARY paragraph: that
 * I-010-23's fail-closed preconditions all held, and that the tree this service
 * wrote is the one the resolve verified — the checkout names that OID. It is not
 * an attestation that the ref store went unmodified by a co-resident writer
 * meanwhile; nothing at this layer can observe that.
 */
export interface TurnSnapshotRestored {
  readonly outcome: "restored";
  /**
   * The ref this restore RESOLVED from — reported for correlation, not as a live
   * handle. It may already be gone: the T5.3 prune can delete it inside the
   * resolve→application window and the restore still succeeds, because the
   * tree-ish actually applied is {@link TurnSnapshotRestored.snapshotCommit}. See
   * the retention residuals in the header.
   */
  readonly ref: string;
  readonly snapshotCommit: string;
  /**
   * Ignored untracked paths that collided with snapshot-tracked content and were
   * overwritten by the `read-tree --reset -u` leg. Restore wins by design; the
   * enumeration is what keeps the loss observable rather than silent. Colliding
   * means occupying a path the checkout has to have, so it covers a shared path
   * and either direction of segment-boundary PREFIX obstruction — see
   * `#deriveProspectiveRestoreEffects` for the three measured shapes.
   */
  readonly overwrittenIgnoredPaths: readonly string[];
  /**
   * Superproject paths whose `160000` gitlink diverges from the snapshot's —
   * including one whose working copy is absent and therefore materializes as an
   * empty directory. Interior submodule state is out of contract
   * (`submodule.recurse=false`), so divergence is REPORTED, never half-restored.
   */
  readonly divergentGitlinks: readonly string[];
}

/**
 * An execution-time re-verify refused (I-010-23's TOCTOU guard). `restoreToTurn`
 * returns this arm from EITHER of its two pre-mutation checks, and the arm does
 * not distinguish them, because the caller's answer is identical for both:
 *
 *   * at entry — `HEAD` moved between the resolve and the dispatch (the wide
 *     window Plan-004 T3.13 mandates a guard for);
 *   * after the derivation — `HEAD` moved DURING the dispatch, while the
 *     enumerations were being listed.
 *
 * NOTHING was mutated on either path; that is the load-bearing half. The third
 * `HEAD` re-check sits after mutation has begun and therefore CANNOT report
 * here — it reports {@link TurnSnapshotPartialRestore} at `close-index`.
 */
export interface TurnSnapshotRestoreHeadMoved {
  readonly outcome: "head_moved";
  readonly ref: string;
  readonly expectedHead: string;
  /** `null` when `HEAD` could not be read — fail-closed, same as a mismatch. */
  readonly observedHead: string | null;
}

/**
 * The sequence stopped mid-flight. Plan-004 maps this arm to the distinct
 * `files-partially-restored` disposition; it is never collapsed into
 * `files-unrestored` and never empty-washed.
 *
 * The SEQUENCE is convergent by construction — every command drives toward the
 * declarative snapshot-tree target, so re-running it re-runs to the fixpoint —
 * but that is a property of the commands, not a promise that recovery always
 * succeeds: a fresh rollback first has to pass
 * {@link TurnSnapshotService.resolveRestoreTarget} again, and TWO different
 * things can stop it there, so this arm has two terminal shapes rather than one:
 *
 *   * TERMINAL BY PRECONDITION — `close-index` reached by a MOVED `HEAD`. The
 *     resolve refuses `head_moved` from then on, and the partial state stands
 *     until whoever moved `HEAD` deals with it.
 *   * TERMINAL BY LIFETIME — ANY `failedStep` whose ref the T5.3 retention prune
 *     has since deleted. The resolve then refuses `no_snapshot`/`ref-absent`,
 *     because there is no longer an OID to freeze, and the partial state stands
 *     with no snapshot left to re-apply. Not tied to one step, unlike the other:
 *     a deletion inside the resolve→application window is survivable by the
 *     APPLICATION (the checkout names the frozen OID, and the commit outlives
 *     its last name), so it costs nothing unless some unrelated step fails and
 *     sends the caller back through the resolve. See the header's retention
 *     residuals.
 *
 * Every other `failedStep` leaves both the precondition and the ref intact and
 * re-runs cleanly — including the other non-git `close-index` failure, a `HEAD`
 * that could not be READ, which is an environmental fault rather than a changed
 * precondition. Those two `close-index` causes are not distinguishable from
 * `failedStep` alone; the diagnostic detail is where they part, and that is why
 * its wording is branched at the site.
 *
 * WHAT THE ENUMERATIONS ARE, exactly — they are two effect CLASSES, never a
 * census of everything the sequence touched:
 *
 *   * both are empty when the failure preceded any mutation, AND equally when
 *     the derivation simply found no candidate in either class. A `read-tree`
 *     that rewrote the whole worktree and then a delete pass that failed reports
 *     two empty arrays if the tree held no colliding ignored path and no
 *     gitlink. "Both empty" therefore does NOT mean "nothing was mutated", and a
 *     consumer rendering it as "no files were changed" would be wrong;
 *   * on THIS arm a candidate is reported only when its on-disk state actually
 *     changed, where {@link TurnSnapshotRestored} reports the prospective set
 *     verbatim. So a collision whose ignored bytes happened to equal the
 *     snapshot's is enumerated on a completed restore and not on a partial one,
 *     and a present-but-divergent submodule likewise (`submodule.recurse=false`
 *     means the failed sequence applied nothing at that path). The asymmetry is
 *     deliberate: on the failure path the git seam is the thing that just
 *     failed, so the evidence is git-free observation rather than intent.
 */
export interface TurnSnapshotPartialRestore {
  readonly outcome: "partial_restore";
  readonly ref: string;
  /** Which command stopped. The detail travels on the diagnostic, not here. */
  readonly failedStep: TurnSnapshotRestoreStep;
  readonly overwrittenIgnoredPaths: readonly string[];
  readonly divergentGitlinks: readonly string[];
}

/**
 * Every outcome {@link TurnSnapshotService.restoreToTurn} can report — three
 * arms, exactly the three Plan-004 T3.13 maps (`restored → files-restored`,
 * `partial_restore → files-partially-restored`, `head_moved → files-unrestored`).
 *
 * A fourth arm would be unmapped at that call site, which is why the one input
 * this union deliberately does NOT describe — a `target` this service never
 * minted — is a throw rather than an outcome (see
 * {@link TurnSnapshotService.restoreToTurn}). The snake_cased names are pinned;
 * see {@link TurnSnapshotResolution}.
 *
 * `ref` means the same thing on ALL THREE arms, and it is not a live handle: it
 * is the ref the restore RESOLVED from, reported for correlation. The T5.3
 * retention prune can delete it inside the resolve→application window, on any
 * arm — see {@link TurnSnapshotRestored.ref} for why a restore nonetheless
 * succeeds across that deletion, and the header's retention residuals for what
 * it costs a RETRY.
 */
export type TurnSnapshotRestoreResult =
  | TurnSnapshotRestored
  | TurnSnapshotRestoreHeadMoved
  | TurnSnapshotPartialRestore;

/**
 * What one {@link TurnSnapshotService.pruneSnapshotsForRun} did to one run.
 *
 * A FLAT record rather than a discriminated union, deliberately. The three
 * outcomes this leg produces are not disjoint: a prune can delete four refs and
 * then be refused on the fifth, and a union would have to either lose the four
 * or grow a third arm that carries both halves anyway. Flat also makes the
 * idempotent case read as what it is — `deletedRefs: []` with `skipped: null`,
 * the same shape a first prune of a run with no refs produces, because those two
 * situations are genuinely the same situation.
 */
export interface TurnSnapshotRetentionPruneResult {
  readonly runId: string;
  /**
   * Full ref paths deleted by THIS call, in enumeration order. Empty on an
   * idempotent re-prune, on a run that never captured, and on a skip that
   * happened before any deletion.
   */
  readonly deletedRefs: readonly string[];
  /** `null` when the prune completed; otherwise why it stopped. */
  readonly skipped: TurnSnapshotRetentionSkip | null;
}

/** What one {@link TurnSnapshotService.sweepPrunableRuns} pass did. */
export interface TurnSnapshotRetentionSweepResult {
  /**
   * Every run whose window had closed at this pass's cutoff — the candidate set,
   * skips included. Reported so a caller can tell "nothing was eligible" from
   * "everything eligible was skipped", which the two lists below cannot.
   */
  readonly examinedRunIds: readonly string[];
  /** The subset that completed with no skip. */
  readonly prunedRunIds: readonly string[];
  /**
   * Every ref this pass deleted, across all runs. Attribution needs no separate
   * field: each path carries its own `refs/sidekicks/runs/<runId>/…` segment.
   */
  readonly deletedRefs: readonly string[];
  /** The enumeration the `retention-prune-skipped` diagnostic carries. */
  readonly skipped: readonly TurnSnapshotRetentionSkip[];
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/**
 * The ref namespace root (I-010-21). `refs/heads/` is the surface this
 * deliberately is not: snapshots stay invisible to branch history, PR
 * preparation and diff attribution, so `Spec-011` is unaffected.
 */
const SNAPSHOT_REF_ROOT = "refs/sidekicks/runs";

/**
 * The modes that snapshot — the Applicability bullet of `Spec-010
 * §Turn-Boundary Snapshots`, spelled as an ALLOWLIST.
 *
 * A denylist (`mode === "read-only"`) reads the same today and fails open
 * tomorrow: a mode added to `ExecutionMode` for some future execution surface
 * would start capturing by default, in a root nobody wrote this recipe against,
 * and the first report of it would be objects in a stranger's store. The
 * allowlist fails INERT instead — the new mode gets the typed no-op until
 * somebody adds it here on purpose. The trade-off is accepted deliberately: a
 * genuinely writable mode that nobody admits here silently stops snapshotting,
 * which costs a recovery convenience, where the denylist's failure costs a
 * guarantee.
 */
const SNAPSHOT_APPLICABLE_MODES: ReadonlySet<ExecutionMode> = new Set<ExecutionMode>([
  "worktree",
  "branch",
  "ephemeral clone",
]);

/**
 * The snapshot commit's message SUBJECT. FIXED — the same bytes for every
 * snapshot, per `Spec-010 §Turn-Boundary Snapshots`'s `-m <fixed snapshot
 * message>`.
 *
 * Deliberately carries no run id, epoch or ordinal: the message is a commit-object
 * field and therefore an OID input, and IDENTITY content in it would make two
 * snapshots of byte-identical project state at the identical instant hash
 * differently. The identity of a snapshot is its REF, which carries all three.
 *
 * The prohibition is on identity, not on content as such — which is what leaves
 * room for {@link SKIPPED_EMBEDDED_REPOSITORIES_TRAILER} below. A trailer
 * derived from PROJECT STATE keeps the property the prohibition protects: two
 * captures of byte-identical project state still produce byte-identical
 * messages, and so still hash identically.
 */
const SNAPSHOT_COMMIT_MESSAGE = "sidekicks: turn-boundary snapshot";

/**
 * The trailer key naming the embedded repositories the CAPTURE could not record,
 * written into the snapshot commit's message as a second paragraph.
 *
 * It exists because those paths are the one class the restore has no authority
 * over, and the restore had no way to know which they were. A skipped embedded
 * repository is absent from the snapshot tree, so the delete pass lists it as
 * post-boundary untracked content and removes it RECURSIVELY — measured on git
 * 2.50.1: `ls-files -o --exclude-per-directory=.gitignore` names the skipped
 * repository as `nested/`, and the pass destroys the directory, its payload, and
 * a `.git` holding the only copy of its history. The pass is right to delete an
 * embedded repository the TURN created; it is wrong to delete one the capture
 * declined to record. Nothing on disk at restore time distinguishes them, so the
 * knowledge has to be carried FROM the capture, and the snapshot commit is the
 * only thing the restore already reads that the capture already writes.
 *
 * Three properties, each load-bearing:
 *
 *   * WRITTEN ONLY WHEN THE SKIP LIST IS NON-EMPTY. The overwhelmingly common
 *     capture skips nothing, and its message must stay the fixed bytes above so
 *     its OID stays what it was — the host-config table's determinism claims and
 *     the suite's host-config-independent OID case are stated on that message.
 *     A trailer present on every capture would change every snapshot OID in the
 *     repository to buy nothing for the 99% case.
 *   * JSON-ENCODED. Paths are arbitrary bytes; a newline in one would otherwise
 *     forge a trailer boundary, and a path could then be read as a key. Inside a
 *     JSON string a newline is `\n` — inert — so the trailer is exactly one
 *     line no matter what the worktree contains.
 *   * SORTED. The message is an OID input, so an unstable order would make two
 *     captures of identical project state hash differently and break the
 *     idempotence the create-only ref write depends on. `ls-files` order is
 *     stable in practice; sorting makes it stable by construction.
 *
 * RESIDUAL, recorded rather than closed: the ref is create-only (I-010-22), so a
 * second capture at the same turn does not overwrite the first, and the trailer
 * a restore reads is the FIRST capture's. If the skip list differed between
 * them, the protection follows the recorded snapshot rather than the worktree —
 * which is the same rule the rest of the restore follows, and the honest one:
 * this trailer is a fact about the snapshot, not about the worktree at restore
 * time.
 */
const SKIPPED_EMBEDDED_REPOSITORIES_TRAILER = "Skipped-Embedded-Repositories:";

/**
 * The trailer key naming the SPARSE BOUNDARY PATHS a capture observed — the
 * out-of-cone content that existed at the turn boundary and that the snapshot
 * tree therefore does not track.
 *
 * Its job is the mirror of the trailer above's, for a class the restore likewise
 * has no other way to learn about. In a sparse root the capture keeps out-of-cone
 * content by seeding from the live index, but two kinds of out-of-cone path have
 * nothing in that index to keep: an UNTRACKED one (`ls-files -o` lists it,
 * `write-tree` cannot record it because staging never re-stats an out-of-cone
 * path) and an INTENT-TO-ADD one (`git add -N --sparse`, which leaves the `-o`
 * listing and which `write-tree` omits — measured on git 2.50.1). Both are
 * content the user has on disk that the snapshot does not hold, so the restore's
 * two destructive legs would each destroy them: `read-tree --reset -u` removes
 * the intent-to-add path's file because the index holds an entry the snapshot
 * tree lacks, and the untracked-delete pass removes the untracked one as
 * post-boundary content. Neither is post-boundary. The capture is the only place
 * that knows, so it writes what it saw.
 *
 * Three properties, and the FIRST differs from the sibling trailer's on purpose:
 *
 *   * WRITTEN UNCONDITIONALLY IN A SPARSE ROOT, empty set spelled `[]`, and
 *     NEVER in a non-sparse one. This is the closure's FORMAT MARKER, not
 *     bookkeeping. A restore in a sparse root that finds no trailer cannot tell a
 *     pre-closure snapshot (out-of-cone content lost, boundary set unknown) from
 *     a post-closure capture that observed an empty boundary set — the vintages
 *     are indistinguishable and their correct handling is opposite — so presence
 *     has to mean "a sparse-aware capture wrote this" all by itself. Conditioning
 *     it on non-emptiness would make the common case exactly the undecidable one.
 *     The non-sparse pipeline stays byte-identical to its pre-closure self for
 *     the reason the sibling trailer's own first property gives: every existing
 *     snapshot OID and every determinism claim in the host-config table is stated
 *     on that message.
 *   * JSON-ENCODED and SORTED, for the sibling trailer's reasons exactly — a
 *     newline inside a path would otherwise forge a trailer boundary, and the
 *     message is an OID input so the order has to be stable by construction.
 *   * LATIN1-ENCODED, which is what makes the JSON above a BYTE record rather
 *     than a text one, and it is the property the rest of this closure rests on.
 *     Every path here is a git path, which is BYTES — POSIX admits any byte but
 *     NUL and `/` — and `latin1` is the one Node encoding that is a bijection on
 *     arbitrary bytes ({@link listingEntryKey}). A `utf8` trailer collapses every
 *     invalid sequence onto U+FFFD, so two DISTINCT boundary paths, or a boundary
 *     path and an unrelated tracked one, are recorded as the same string — and
 *     every restore-side decision keyed on this set (the delete exemption, the
 *     index pre-drop and its snapshot-tree exclusion, the obstruction guard) then
 *     compares them EQUAL. The destructive direction of that aliasing is the
 *     pre-drop's exclusion firing spuriously, which leaves a boundary path's
 *     index entry in place for `read-tree --reset -u` to unlink. So the bytes are
 *     preserved to the trailer and back, and the utf8 decode happens only where a
 *     HUMAN reads the result (see {@link decodeSparseBoundaryPathKey}).
 *
 *     Two consequences worth stating rather than discovering. The JSON is still
 *     valid and still one line — `JSON.stringify` escapes every code point below
 *     U+0020, the newline included, and emits U+0080–U+00FF literally, which the
 *     message's own UTF-8 encoding then carries losslessly. And "SORTED" becomes
 *     BYTE-LEXICOGRAPHIC by construction: a JS code-unit sort over latin1 strings
 *     IS a sort over the bytes, so the OID-stability the sort exists for holds on
 *     the same terms it always did.
 *   * ORDERED AFTER {@link SKIPPED_EMBEDDED_REPOSITORIES_TRAILER} whenever both
 *     are present. Trailer order is message bytes and therefore OID bytes; fixing
 *     it here is what keeps two captures of identical project state identical.
 *     The sibling trailer stays UTF-8 TEXT, deliberately: its contents reach the
 *     capture RESULT and a diagnostic, which are wire-facing values a human and
 *     Plan-004 both read, and its own consumer ({@link isPreservedListingEntry})
 *     compares them against decoded listing strings. The two trailers therefore
 *     carry different kinds of string, which {@link readJsonPathArrayTrailer}
 *     states at the one place both are read.
 *
 * TYPE-PRESERVING: a path git listed with a TRAILING SLASH is recorded WITH it.
 * The slash is not decoration — it is git saying "a directory I did not descend
 * into", which for an `ls-files -o` listing means an embedded repository or
 * anything else `-o` refuses to walk. That distinction survives to the restore
 * because the two entry kinds need OPPOSITE exemption widths, and only the
 * capture can tell them apart: at restore time a boundary-time embedded
 * repository whose `.git` the turn removed is listed as its payload FILES, and
 * an exemption that matched the recorded name exactly would protect none of
 * them. See {@link classifySparseBoundaryPaths} for the split and
 * {@link isSparseBoundaryListingEntry} for what each kind then protects.
 *
 * Recording the slash costs no ambiguity: git spells repo-relative paths with
 * forward slashes and never emits a trailing one for a blob, so the suffix is a
 * free discriminator rather than a reserved character carved out of the path
 * space. It is also why the capture's subtraction cannot mistake a directory
 * candidate for a tree path — `ls-tree -r` lists blobs and gitlinks, both
 * slash-free, so a slash-suffixed candidate can never match one.
 *
 * RESIDUAL, the same one the sibling trailer records: the ref is create-only
 * (I-010-22), so a restore reads the FIRST capture's boundary set at that turn.
 * The exemption follows the recorded snapshot rather than the worktree, which is
 * the honest rule — this trailer is a fact about the snapshot.
 */
const SPARSE_BOUNDARY_PATHS_TRAILER = "Sparse-Boundary-Paths:";

/**
 * The daemon-owned author/committer identity stamped into every snapshot commit.
 *
 * Not the user's. `Spec-010 §Turn-Boundary Snapshots` records both failure modes
 * this closes: without explicit ident env, `commit-tree` hard-fails
 * (`Author identity unknown`) in a passwd-less daemon or CI container, and
 * silently stamps a passwd-derived OS ident elsewhere — machine-dependent
 * snapshot OIDs plus an identity leak into the object store.
 */
const SNAPSHOT_IDENTITY_NAME = "AI Sidekicks";
const SNAPSHOT_IDENTITY_EMAIL = "snapshots@ai-sidekicks.invalid";

// The empty directory `core.hooksPath` points at (I-010-10 / D-010-10). Spelled
// identically to `./worktree-service.ts`'s and `./ephemeral-clone-service.ts`'s:
// all three neutralize against the SAME directory under a shared execution-roots
// directory, and a third spelling would mean a third directory a reaper could
// remove out from under one of them.
const HOOK_NEUTRALIZATION_SEGMENT = ".hook-neutralization";

// Where the scratch indexes live. `Spec-010 §Turn-Boundary Snapshots` requires
// the temp index OUTSIDE the worktree — a worktree-resident scratch index would
// surface to the capture pipeline's own `ls-files -o` listing, to the restore's
// untracked-delete pass, and to the user's `git status` as stray untracked
// content. A dotted sibling of the per-mount root directories, so it can never
// collide with a mount id, exactly as the neutralization directory is; a
// `branch`-mode root is the user's own checkout somewhere else entirely, which
// this placement is trivially outside of too.
const SNAPSHOT_INDEX_SEGMENT = ".snapshot-indexes";

// Per-invocation git timeout. Matched to `./worktree-service.ts`'s bound rather
// than to the resolver's metadata-read bound: the staging legs walk the whole
// worktree, which is `worktree add`'s order of work, not `rev-parse`'s.
const DEFAULT_TURN_SNAPSHOT_GIT_TIMEOUT_MS = 120_000;

/**
 * How long a run's snapshot refs outlive its terminal release: seven days.
 *
 * INVENTED rather than ratified, and said plainly for the reason
 * `./ephemeral-clone-service.ts` says it of its own invocation ceiling:
 * `Spec-010 §Turn-Boundary Snapshots` fixes that a window exists and that it is
 * CONFIGURED, not what it is. The number is chosen from the direction of the
 * risk rather than from a benchmark. Too SHORT loses a rollback the user still
 * wanted, and loses it silently — the refs are simply gone and Plan-004 reports
 * "no snapshot", which reads exactly like a run that never captured. Too LONG
 * costs object-store growth, which is visible as disk and is recoverable by
 * shortening the window. So it errs long, and seven days is the span over which
 * "go back to before that turn" is still a thing somebody says about a run.
 *
 * Exported so a composition root expresses a configured override as a delta from
 * this default rather than re-spelling it — the shape and the reason
 * {@link DEFAULT_EPHEMERAL_CLONE_TTL_MS} established in T2.3.
 */
export const DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS: number = 7 * 24 * 60 * 60 * 1000;

/**
 * The largest retention window the constructor accepts: ECMAScript's own Date
 * range, ±8.64e15 ms of the epoch.
 *
 * The bound exists for the same reason {@link MAXIMUM_TIMER_DELAY_MS} does — a
 * value the platform cannot represent does not announce itself, it degrades. A
 * window above this passes a finite-and-positive check and then makes
 * `now - window` unrepresentable, so `#retentionCutoff`'s `toISOString()` throws
 * `RangeError: Invalid time value` on EVERY sweep. The sweep's own `try`
 * contains that throw, which is the bad part: one accepted configuration
 * disables retention indefinitely while the daemon keeps reporting a sweep that
 * ran. `Number.MAX_SAFE_INTEGER` — a plausible "keep everything" spelling — is
 * exactly this input, and it is the vector the bound is written against.
 *
 * The bound is NOT the whole defense, only the half that can be checked once.
 * It constrains the window, and the window is one of two terms; a clock that
 * returns an instant far from the epoch can put the difference out of range with
 * a window this check accepted (measured: a `1900-01-01` clock against a window
 * at exactly this ceiling). `#retentionCutoff` carries the other half.
 */
const MAXIMUM_RETENTION_WINDOW_MS = 8_640_000_000_000_000;

/**
 * How often the daemon runs the retention sweep: hourly.
 *
 * Lives here rather than in `../bootstrap/index.ts` because it is Plan-010
 * configuration and that file is Plan-007's — the wiring call there passes a
 * cadence through, it does not own one. Neither direction of error is severe, which is
 * why the value is unceremonious: too frequent spends a handful of git spawns on
 * an empty candidate set, and too rare lets refs outlive their window by up to
 * one cadence, which is a rounding error against a seven-day window.
 */
export const DEFAULT_TURN_SNAPSHOT_SWEEP_CADENCE_MS: number = 60 * 60 * 1000;

// stdout ceiling. Eight times `./worktree-service.ts`'s, because the `-z`
// listing this module reads is one NUL-terminated path per tracked-or-untracked
// file in the worktree — a repository large enough to overflow 8 MiB of
// `status --porcelain` is nowhere near the largest that can overflow 8 MiB of
// path listing. An overflow is a rejection, which the funnel reports as a
// `list-paths` failure: a capture that did not happen, never a capture that
// silently omitted the tail of the worktree.
const GIT_STDIO_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// A resolved object id, SHA-1 or SHA-256. Checked before an OID is interpolated
// into a later argv, so a leg that returned something other than an id — an
// echoed argument, a warning — stops the pipeline instead of naming a bogus
// object two commands later.
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Hex length per `rev-parse --show-object-format` name. Because that pattern
// admits BOTH widths, an object id valid on its own terms can still be
// un-insertable in a given repository — see
// {@link TurnSnapshotService.#normalizeEmbeddedRepositories}, where the two are
// compared. An unrecognized name throws rather than defaulting: a third object
// format would change what `update-index --cacheinfo` accepts, and assuming
// SHA-1 there would resurrect the whole-capture failure that comparison exists
// to prevent.
const OBJECT_ID_HEX_LENGTHS: ReadonlyMap<string, number> = new Map<string, number>([
  ["sha1", 40],
  ["sha256", 64],
]);

// git's superproject submodule representation ([gitsubmodules]) — the mode the
// capture leg records for an untracked embedded repository and the mode the
// restore leg reads back out of the snapshot tree to derive its gitlink
// enumeration. Spelled once; the two legs must agree or the enumeration silently
// covers nothing.
const GITLINK_TREE_MODE = "160000";

// The `ls-files` exclude source, spelled once. Three legs pass it — the capture
// listing, the restore's collision derivation and the restore's delete pass —
// and they must AGREE or the module's central safety argument dissolves: the
// delete pass is safe because it lists exactly what the derivation and the
// capture consider ignorable, so a snapshot-declared `node_modules` is protected
// in every pass. Two legs on `.gitignore` and a third on some other exclude
// source would delete content the capture deliberately never recorded.
//
// It is also the reason the recipe is plumbing rather than `git add -A`:
// `ls-files` consults NO other exclude source unless asked to, while porcelain
// also honours `core.excludesFile` and `$GIT_DIR/info/exclude` with no
// off-switch, and a developer's private ignore patterns are not project
// declarations (the Scope bullet of `Spec-010 §Turn-Boundary Snapshots`).
const EXCLUDE_PER_DIRECTORY_GITIGNORE = "--exclude-per-directory=.gitignore";

// The pin that makes an object read return the object that was asked for,
// spelled once for the same reason the exclude source above is: the legs that
// carry it have to agree, and a reader checking the host-config table's
// `core.useReplaceRefs` row needs one grep to see exactly which legs those are.
//
// `refs/replace/<oid>` substitutes objects transparently, so an id this service
// froze and verified is not, by itself, an id git will hand back. Scope is
// deliberately per-leg rather than prepended in `#runGit` beside the two hook
// knobs: the closing index reset is measurably redirected too and must NOT carry
// this, because porcelain is redirected identically there and the leg's contract
// is to leave the index where porcelain would. See the PINNED row in the
// host-config table for the full leg-by-leg measurement.
const USE_REPLACE_REFS_PIN: readonly string[] = ["-c", "core.useReplaceRefs=false"];

// The record terminator every `-z` stream this module writes ends each entry
// with. See {@link joinNulTerminatedListing}.
const NUL_TERMINATOR: Buffer = Buffer.from([0]);

// The field separator in a `ls-tree -z` record, as a BYTE — the tree listing is
// split on the buffer, so the separator has to be one too. See
// {@link parseSnapshotTreeListing} for why the first occurrence is always the
// real separator.
const TAB_SEPARATOR_BYTE: number = 0x09;

// The config key that IS the sparse-root predicate. Spelled once so the
// host-config table's `READ AS INPUT` row and the detection leg cannot drift
// apart — the table's claim is about this exact key and no other.
const CORE_SPARSE_CHECKOUT_KEY = "core.sparseCheckout";

// How many times the sparse seed re-tries git's index lock, and how long it
// waits between attempts.
//
// A FIXED, SMALL budget on purpose. The lock is held for the duration of one
// git index write — microseconds to a few milliseconds — so a contended
// acquisition is almost always a concurrent `git status` from the user's own
// terminal, and it clears immediately. What the budget must NOT do is wait out a
// STALE lock (a crashed git leaves the file behind, and nothing here is entitled
// to remove it): that is a repository an operator has to unblock, and a capture
// that ground on it for seconds would spend the turn boundary's latency budget
// to arrive at the same typed failure. Deliberately not clock-injected — the
// delay is a real sleep of a few tens of milliseconds, below the resolution at
// which a test would want to control it, and the contention arm the suite drives
// holds a REAL lock file rather than simulating one.
const SPARSE_SEED_INDEX_LOCK_ATTEMPTS = 4;
const SPARSE_SEED_INDEX_LOCK_RETRY_DELAY_MS = 25;

// Ceiling on the untracked-delete pass (`Spec-010 §Turn-Boundary Snapshots`
// requires repetition to a FIXPOINT, not a fixed count).
//
// It cannot be reached by the pinned listing: every non-final pass strictly
// shrinks the untracked set and deleting files never adds ignore rules, so the
// spec's own termination argument bounds the real work far below this.
//
// It is also NOT the guard against the seam that reports a deletion it did not
// perform — the no-progress check in `#deleteUntrackedToFixpoint` catches that on
// the second pass, where this ceiling would first walk the whole worktree sixty
// more times under the caller's exclusive hold. What survives that check and
// still fails to converge is a seam whose removals keep producing NEW untracked
// content, and this bound is what stops a daemon spinning forever inside a
// rollback on it. Exceeding it is a `delete-untracked` failure, which is to say a
// loud one.
const UNTRACKED_DELETE_PASS_LIMIT = 64;

/**
 * The CHARACTER-CLASS half of "safe as a ref path component" (I-010-21) — an
 * allowlisted alphabet with an alphanumeric first character.
 *
 * It is half of the rule and not the rule: `.` is in the class, so this pattern
 * alone admits several dot spellings that must not reach a ref path. The rest of
 * the rule is composed in {@link isSafeRefComponent}, which is where the reasons
 * live. Do not test against this constant directly.
 *
 * What the class alone does close, by construction rather than by enumeration:
 * no path separator, no `@{`, no control character, no space, no leading dash,
 * no leading dot, and no character outside `[A-Za-z0-9._-]` at all.
 */
const SAFE_REF_COMPONENT_CHARACTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A component may not contain `..` anywhere — see {@link isSafeRefComponent}. */
const CONSECUTIVE_DOTS = "..";

/**
 * The `.lock` suffix git reserves, lowercased for a case-INSENSITIVE compare —
 * see {@link isSafeRefComponent}.
 */
const RESERVED_REF_LOCK_SUFFIX = ".lock";

/**
 * Variables stripped from the git environment IN ADDITION to
 * {@link DISCOVERY_REDIRECTING_GIT_ENV_KEYS}, which is IMPORTED rather than
 * re-spelled (two copies of a security fact drift — see that export).
 *
 * Each entry earns its place against an invariant this module carries:
 *
 *   * `GIT_ALTERNATE_OBJECT_DIRECTORIES` — the snapshot tree and commit would be
 *     resolved from an object store that is not the execution root's, and a ref
 *     pointing at an object the repository cannot reach is a snapshot that
 *     restores nowhere. Its louder counterpart `GIT_OBJECT_DIRECTORY` is NO
 *     LONGER listed here, having moved into the imported
 *     {@link DISCOVERY_REDIRECTING_GIT_ENV_KEYS}: that list's owner re-probed it
 *     on git 2.50.1 and found it bending repository DISCOVERY for every consumer,
 *     not just this module's object writes. This module's behaviour is unchanged
 *     — it still strips the variable, now through the spread rather than through
 *     a second literal — and the entry's original finding survives at the header
 *     above.
 *   * `GIT_NAMESPACE` — defense in depth, and deliberately NOT claimed as the
 *     enforcement of I-010-21. Local ref plumbing ignores it (empirically
 *     confirmed on git 2.50.1: a namespaced `update-ref` writes the unprefixed
 *     path, and `rev-parse` / `show-ref` / `for-each-ref` read it back from a
 *     clean environment); the namespace applies in the pack protocol, so this
 *     entry is here for a future leg that speaks it rather than for the legs
 *     that exist. The invariant's environment exposure is the redirector class
 *     above — see the header.
 *   * `GIT_INDEX_FILE` — belt to the braces. Every index-touching leg sets it
 *     explicitly, so an ambient value can only reach the legs that do not use an
 *     index; stripping it keeps "the temp index is the only index this service
 *     touches" true of the whole invocation set rather than of most of it.
 *
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` are deliberately NOT here. Host
 * config is neutralized by the ratified `-c` pins — which outrank every config
 * source — and stripping the pointers as well would reach past both the spec
 * recipe and the plan row into config the daemon has no mandate over.
 *
 * EXPORTED for the suite's census, the same reason and the same shape as
 * `../workspace/repo-root-resolver.ts`'s own list: the suite keeps an
 * independent literal roster and pins the two together by set equality, so a key
 * added here and nowhere else fails rather than going silently unasserted. The
 * assertion is not circular — the roster is a second spelling, not a read of
 * this one — and the behavioral half of the coverage (a real capture run under
 * an ambient `GIT_DIR` and `GIT_OBJECT_DIRECTORY`, the two entries that
 * demonstrably redirect it) does not consult either list.
 */
export const SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS: readonly string[] = [
  ...DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_INDEX_FILE",
];

/**
 * The strip list keyed for case-insensitive lookup, and rebuilt-by-omission for
 * the Windows reason `../workspace/repo-root-resolver.ts` documents at its own
 * copy: a process that inherited `Git_Dir` would carry it past a
 * `delete environment["GIT_DIR"]` and hand it to the child, where a
 * case-insensitive process environment block makes git read it as `GIT_DIR` and
 * point the whole capture at another repository. `toUpperCase` rather than the
 * locale-sensitive variant, which maps `I` to `ı` under a Turkish locale and
 * would stop matching at all.
 */
const SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS_UPPERCASED = new Set(
  SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS.map((key) => key.toUpperCase()),
);

// --------------------------------------------------------------------------
// Ref builders
// --------------------------------------------------------------------------

/**
 * `refs/sidekicks/runs/<runId>/` — every snapshot ref of one run, and the prefix
 * T5.3's retention prune enumerates with `for-each-ref`.
 *
 * Assumes a validated `runId` (see {@link isSafeRefComponent}); both builders
 * are private to this module and both call sites validate first.
 */
function buildRunSnapshotRefPrefix(runId: string): string {
  return `${SNAPSHOT_REF_ROOT}/${runId}/`;
}

/**
 * `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>` — the ref namespace
 * `Spec-010 §Turn-Boundary Snapshots` pins, with the `epoch-<E>` segment that
 * makes create-only idempotence PER-EPOCH (I-010-22): a post-rollback
 * re-execution reuses turn ordinals, and without the segment its capture would
 * hit the superseded epoch's ref and silently resolve to the wrong tree.
 */
function buildTurnSnapshotRef(runId: string, epoch: number, turnOrdinal: number): string {
  return `${buildRunSnapshotRefPrefix(runId)}epoch-${String(epoch)}/turn-${String(turnOrdinal)}`;
}

/**
 * Whether `value` is safe as a ref path component (I-010-21) — the whole rule,
 * of which {@link SAFE_REF_COMPONENT_CHARACTER_PATTERN} is the alphabet.
 *
 * Composed as four explicit checks rather than folded into one regex on purpose:
 * this is a security predicate, and the negative lookaheads that would express
 * the dot rules inline are the kind of thing a reader verifies by trusting
 * rather than by reading. Each check below states which shape it refuses and
 * why, and the four split cleanly in two — the first pair are refusals git
 * itself makes, the second pair are this module's own narrowing.
 *
 * REFUSED BY GIT TOO, and hoisted here because of WHERE git refuses. Both were
 * admitted by the character class alone, and the docblock that class carried
 * before claimed otherwise (`run..1` matched it); both are measured on git
 * 2.50.1 against the full ref path this module builds:
 *
 *   * `..` ANYWHERE — `run..1` yields `refs/sidekicks/runs/run..1/epoch-0/turn-1`,
 *     which `check-ref-format` refuses and `update-ref` refuses ("refusing to
 *     update ref with bad name"). That refusal arrives from git, several spawns
 *     into a capture — and capture SWALLOWS its failures into a diagnostic, so
 *     relying on it converts a typed refusal into a silent no-op. The same
 *     reasoning the header gives for `../../heads/main`, applied to the spelling
 *     the pattern actually let through.
 *   * A `.lock` SUFFIX — `run.lock` is refused by both, git applying the rule
 *     per slash-separated component rather than to the last one only. Suffix and
 *     not substring: `a.lock.b` is accepted by git and stays accepted here
 *     (measured), because narrowing past git's own rule buys nothing.
 *
 * THIS MODULE'S OWN NARROWING — git ACCEPTS both of these, so neither is an echo
 * of a git rule and each needs its own reason (both measured on git 2.50.1:
 * `check-ref-format` and `update-ref` accept them, and the ref is created):
 *
 *   * A TRAILING DOT. git's "cannot end with a dot" is a rule about the whole
 *     refname, and a `runId` is a MID-PATH component, so `run.` sails through as
 *     `refs/sidekicks/runs/run./epoch-0/turn-1`. It is refused here because a
 *     loose ref is a real directory path, and Win32 strips trailing dots from
 *     path components: `run.` and `run` are the same directory there, so two
 *     distinct runs would share one epoch namespace and the create-only CAS of
 *     I-010-22 would fire across runs that never collided on the ids the daemon
 *     issued.
 *   * A `.LOCK` suffix in any casing. git's rule is case-SENSITIVE, so `run.LOCK`
 *     is accepted (measured — the ref is created). It is refused here for the
 *     same filesystem reason one case down: git's own lock file for a sibling ref
 *     `refs/sidekicks/runs/run` is literally `run.lock` on disk, and on a
 *     case-insensitive filesystem — APFS and NTFS by default — a directory named
 *     `run.LOCK` is that path. `toLowerCase` compares the two spellings the
 *     filesystem would.
 *
 * None of this loosens I-010-21. Run ids are event-sourced UUIDs, which contain
 * no dots at all, so every shape refused here costs a real caller nothing; the
 * refusal is a typed `validate-inputs` result before any git call.
 */
function isSafeRefComponent(value: string): boolean {
  return (
    SAFE_REF_COMPONENT_CHARACTER_PATTERN.test(value) &&
    !value.includes(CONSECUTIVE_DOTS) &&
    !value.endsWith(".") &&
    !value.toLowerCase().endsWith(RESERVED_REF_LOCK_SUFFIX)
  );
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// --------------------------------------------------------------------------
// Default seam implementations
// --------------------------------------------------------------------------

/**
 * The environment every git invocation runs under: the daemon's own, minus the
 * strip list, plus the locale pin, the prompt block, and the caller's overlay.
 *
 * Read at CALL time rather than captured at construction, so a daemon that
 * mutates its own environment is followed rather than snapshotted — the
 * `../workspace/repo-root-resolver.ts` posture.
 *
 * The overlay is applied AFTER the strip, which is what lets this module set
 * `GIT_INDEX_FILE` on the legs that need it while the strip keeps an inherited
 * one off the legs that do not.
 */
function buildTurnSnapshotGitEnvironment(
  overrides: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS_UPPERCASED.has(key.toUpperCase())) {
      continue;
    }
    environment[key] = value;
  }
  environment["LC_ALL"] = "C";
  environment["LANG"] = "C";
  // No leg here authenticates, but a git that decided to prompt would block on a
  // terminal the daemon does not have until the timeout fires.
  environment["GIT_TERMINAL_PROMPT"] = "0";
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      environment[key] = value;
    }
  }
  return environment;
}

/**
 * `execFile` with an argv ARRAY — never a shell string — carrying the stdin and
 * environment overlay the snapshot recipe needs.
 *
 * EXPORTED, unlike the sibling services' private defaults, because the T5.1
 * suite's injected-`HEAD`-advance case has to WRAP the production runner rather
 * than replace it: the assertion is that a real capture, run through the real
 * process seam, still records the base it resolved at entry when `HEAD` moves
 * between two of its legs. A suite that reimplemented the runner would be
 * asserting that against its own reimplementation.
 */
export const runTurnSnapshotGitWithExecFile: TurnSnapshotGitRunner = (
  argv: readonly string[],
  options: TurnSnapshotGitInvocationOptions,
): Promise<TurnSnapshotGitInvocationResult> => {
  return new Promise<TurnSnapshotGitInvocationResult>((resolve, reject) => {
    const child = execFile(
      DEFAULT_GIT_EXECUTABLE,
      [...argv],
      {
        encoding: "buffer",
        timeout: options.timeoutMs,
        maxBuffer: GIT_STDIO_MAX_BUFFER_BYTES,
        env: buildTurnSnapshotGitEnvironment(options.environmentOverrides),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const stderrText: string = stderr.toString("utf8");
        if (error !== null) {
          reject(Object.assign(error, { stderr: stderrText }));
          return;
        }
        resolve({ stdout, stderr: stderrText });
      },
    );
    const childStdin = child.stdin;
    if (childStdin !== null) {
      // A child that exits before draining its stdin — `update-index` refusing
      // its arguments, say — makes this write EPIPE. That is the invocation's
      // failure, already travelling on the exit status the callback rejects
      // with; an unhandled `error` event here would crash the daemon instead.
      childStdin.on("error", () => {
        /* see above */
      });
      if (options.stdin !== undefined) {
        childStdin.write(options.stdin);
      }
      childStdin.end();
    }
  });
};

const DEFAULT_TURN_SNAPSHOT_FILESYSTEM: TurnSnapshotFilesystem = {
  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async removePath(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
  async removeDirectoryIfEmpty(path: string): Promise<void> {
    try {
      await rmdir(path);
    } catch (reason: unknown) {
      // `rmdir` is the whole mechanism: it refuses a populated directory rather
      // than emptying it, so the "only when unambiguous" half of the contract is
      // the kernel's rather than a read-then-delete race of ours. `ENOTEMPTY`
      // (POSIX) and `EEXIST` (some platforms report the same condition this way)
      // are the ordinary answer — a directory that still holds snapshot content —
      // and `ENOENT` means a recursive removal already took it. Anything else —
      // an `EACCES`, most plausibly — is a real failure of the delete pass and
      // travels to the funnel.
      const code: string | undefined = (reason as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT") {
        return;
      }
      throw reason;
    }
  },
};

/**
 * See {@link TurnSnapshotServiceDeps.emitDiagnostic}'s TRIPWIRE.
 *
 * Renders the identity every kind shares and hands the WHOLE record over as the
 * second argument rather than formatting per-kind. Deliberate: a per-kind
 * `switch` puts a rendering branch behind every future diagnostic member, and
 * the one that gets forgotten is silently the one nobody reads. This shape also
 * matches what the OTel sink replacing it will want — a message plus a
 * structured attribute bag — so the swap is not a rewrite.
 */
function warnDiagnostic(diagnostic: TurnSnapshotDiagnostic): void {
  // The retention kinds are PASS-scoped: a sweep spans runs and no turn at all,
  // so the shared identity line below has nothing to render for them and would
  // print `run=undefined epoch=undefined turn=undefined`. The branch is an
  // early return rather than a widened template so the per-turn rendering is
  // byte-unchanged for the kinds that do carry an identity.
  if (diagnostic.kind === "retention-prune-skipped") {
    console.warn(
      `turn-snapshot ${diagnostic.kind}: ` +
        `skipped=${String(diagnostic.skipped.length)} of ` +
        `examined=${String(diagnostic.examinedRunCount)} ` +
        `disposed-clones=${String(diagnostic.disposedCloneCount)}`,
      diagnostic,
    );
    return;
  }
  if (diagnostic.kind === "retention-sweep-failed") {
    console.warn(`turn-snapshot ${diagnostic.kind}: ${diagnostic.detail}`, diagnostic);
    return;
  }
  console.warn(
    `turn-snapshot ${diagnostic.kind}: run=${diagnostic.runId} ` +
      `epoch=${String(diagnostic.epoch)} turn=${String(diagnostic.turnOrdinal)}`,
    diagnostic,
  );
}

/** The failure funnel's `detail`, without assuming the rejection is an `Error`. */
function describeRejection(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}

/**
 * `Date.prototype.toISOString()` form to git's raw `<unix-seconds> +0000`.
 *
 * The FIXED offset is the point: `git-commit-tree` resolves author and committer
 * dates from the environment, timezone included, and both are commit-object
 * fields — so an ISO string carrying the host's offset would mint a different
 * snapshot OID on a `-0700` machine than on a `+0000` one for the identical
 * instant. The raw spelling is git's own internal format and is accepted
 * verbatim (confirmed on git 2.50.1), which also sidesteps every ambiguity in
 * git's ISO parser.
 *
 * `null` for an unparseable clock — an injected `now` that did not honour the
 * contract — which the funnel reports as a `commit-tree` failure rather than
 * stamping an `Invalid Date`.
 */
function toRawGitDate(isoInstant: string): string | null {
  const milliseconds: number = Date.parse(isoInstant);
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  return `${String(Math.floor(milliseconds / 1000))} +0000`;
}

/**
 * Split a NUL-terminated `ls-files -z` listing into worktree-relative paths.
 *
 * Splits on the BUFFER rather than on a decoded string so a path git emitted as
 * raw non-UTF-8 bytes round-trips to `update-index --stdin` unchanged — the
 * capture leg hands the whole listing Buffer to that child's stdin and never
 * decodes it on the way.
 *
 * The per-entry STRINGS this returns are a different matter, and what remains on
 * that list is now a short and deliberate set: nothing that decides membership
 * against the byte-keyed sparse boundary set decodes any more. Capture uses these
 * strings at exactly one site — {@link TurnSnapshotService.#normalizeEmbeddedRepositories},
 * classifying trailing-slash entries as embedded repositories — where a mangled
 * decode at worst mis-classifies a path git will report again next turn. Restore
 * uses them at two: the collision derivation, which tests an ignored-file listing
 * against the DECODED snapshot-tree paths, and {@link parseCachedStateListing},
 * whose records the discarded-subset diagnostic matches against those same decoded
 * paths. Both compare a decode against a decode — like against like — and both
 * fail by UNDER-reporting a diagnostic rather than by destroying content, which is
 * what makes the decode tolerable there rather than merely convenient.
 *
 * What deliberately does NOT appear on that list: the sparse partition, the
 * boundary subtraction, {@link parseSnapshotTreeListing}, the boundary index
 * pre-drop, and the delete pass all read {@link splitNulTerminatedListingBytes}
 * and key on {@link listingEntryKey}, because each of them compares a listing
 * entry against the boundary set, where a mangled decode would make two DIFFERENT
 * paths compare equal and cost a file. The delete pass is the instructive one: it
 * still needs a path STRING because the filesystem seam is string-typed, so it
 * keys its exemption and its no-progress check on the bytes and hands only the
 * removal the decoded text. A mangled decode there makes the removal a silent
 * no-op, which is why that pass detects a listing that did not change rather than
 * trusting its own deletions — see {@link TurnSnapshotFilesystem} for why the seam
 * is not Buffer-typed instead.
 */
function splitNulTerminatedListing(listing: Buffer): readonly string[] {
  const entries: string[] = [];
  let start = 0;
  for (let index = 0; index < listing.length; index += 1) {
    if (listing[index] === 0) {
      if (index > start) {
        entries.push(listing.toString("utf8", start, index));
      }
      start = index + 1;
    }
  }
  // A listing that did not end in NUL is not a shape git produces; tolerated
  // rather than refused, because dropping a trailing path would silently omit it
  // from the snapshot.
  if (start < listing.length) {
    entries.push(listing.toString("utf8", start));
  }
  return entries;
}

/**
 * The same split as {@link splitNulTerminatedListing}, stopping one step short:
 * BUFFER SLICES, never decoded.
 *
 * This exists because the sparse partition turns the staging stdin from a
 * pass-through into a SUBSET, and that changes what a decode costs. Today the
 * whole listing Buffer is handed to `update-index --stdin` untouched, so a path
 * git emitted as raw non-UTF-8 bytes round-trips unchanged and the decoded
 * strings are only ever used for classification. A partition built on those
 * strings would re-encode them: a non-UTF-8 path decodes to replacement
 * characters, fails to match git's own echo of its bytes, and is dropped from
 * the snapshot — a silent loss, in the one leg whose entire purpose is to stop
 * losing what porcelain keeps. {@link parseSnapshotTreeListing} joined that
 * argument on the restore side: its paths are compared against the boundary set,
 * and a comparison is only as exact as its least exact side.
 *
 * So the partition runs end to end on bytes. `slice` shares the parent Buffer's
 * memory rather than copying, which is exactly right here: the slices are read,
 * concatenated and discarded inside one capture.
 */
function splitNulTerminatedListingBytes(listing: Buffer): readonly Buffer[] {
  const entries: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < listing.length; index += 1) {
    if (listing[index] === 0) {
      if (index > start) {
        entries.push(listing.subarray(start, index));
      }
      start = index + 1;
    }
  }
  // Same tolerance, and the same reason, as the string form: dropping a trailing
  // path would silently omit it from the snapshot.
  if (start < listing.length) {
    entries.push(listing.subarray(start));
  }
  return entries;
}

/**
 * Re-join listing entries into the NUL-TERMINATED form git's `-z` readers want.
 *
 * TERMINATED, not separated: `update-index -z --stdin` and `sparse-checkout
 * check-rules -z` both read records ending in NUL, and a final entry without one
 * is the shape the splitter above tolerates on input rather than the shape
 * anything should be handed.
 */
function joinNulTerminatedListing(entries: readonly Buffer[]): Buffer {
  if (entries.length === 0) {
    return Buffer.alloc(0);
  }
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(entry, NUL_TERMINATOR);
  }
  return Buffer.concat(parts);
}

/**
 * A BYTE-EXACT map key for a listing entry.
 *
 * `latin1` and not `utf8`, deliberately and for the only reason that matters
 * here: it is the one Node encoding that is a bijection on arbitrary bytes, so
 * two entries share a key exactly when they share their bytes. A `utf8` key
 * collapses every invalid sequence onto U+FFFD, which would make two DIFFERENT
 * un-decodable paths compare equal — and this key decides which paths reach the
 * snapshot.
 *
 * These strings USED to be module-local scratch. They are not any more: the same
 * encoding is what {@link SPARSE_BOUNDARY_PATHS_TRAILER} records, so a key minted
 * here at capture is the key matched at restore, one commit message and any
 * number of processes later. That is the property the whole boundary closure
 * rests on, and it holds because `latin1` is a bijection in BOTH directions —
 * {@link decodeSparseBoundaryPathKey} is the only sanctioned way back out, and it
 * exists for RENDERING, never for comparing.
 */
function listingEntryKey(entry: Buffer): string {
  return entry.toString("latin1");
}

/**
 * One `ls-files -o` entry the delete pass may remove, in BOTH representations.
 *
 * A record rather than a string because that pass needs both and the choice is
 * not one a reader should have to make per line: its exemption test and its
 * no-progress fingerprint are DECISIONS and run on {@link key}, while the removal
 * itself and the failure message are a syscall and a sentence and run on
 * {@link text}. Collapsing to one of them silently breaks the other half — a
 * key-only pass hands `rm` a `latin1` mojibake, a text-only pass lets two
 * byte-distinct paths borrow each other's exemption.
 */
interface DeletableListingEntry {
  /** {@link listingEntryKey} spelling: the entry's bytes, for every comparison. */
  readonly key: string;
  /** The decoded entry, for {@link TurnSnapshotFilesystem} and for humans. */
  readonly text: string;
}

/** One `<oid> <refname>` line of the retention leg's `for-each-ref` listing. */
interface SnapshotRefListingEntry {
  readonly objectId: string;
  readonly ref: string;
}

/**
 * Parse `for-each-ref --format=%(objectname) %(refname)` output, keeping only
 * well-formed lines whose ref really is under `expectedPrefix`.
 *
 * The prefix re-check is one of two I-010-21 guards on the DELETION side —
 * `--no-deref` at the deletion itself is the other — and it is not redundant with
 * the validated `runId` that built the pattern. git's pattern matching is the
 * only thing standing between the argv this module assembled and the ref set it
 * is about to delete, and this module's whole posture on that invariant (see the
 * header) is that it enforces the namespace at THIS layer rather than trusting
 * git to. Every entry that fails the check is dropped before it can reach
 * `update-ref -d`, so a listing that somehow named `refs/heads/main` prunes
 * nothing rather than deleting a branch.
 *
 * The two guards answer different questions and neither covers the other's: this
 * one judges the NAME git reported, while the flag governs what that name is
 * allowed to resolve to. A symbolic ref planted in-namespace passes here on the
 * merits.
 *
 * Lines are decoded as UTF-8 and split on the FIRST space, which is exact for
 * this format: `git check-ref-format` forbids spaces in a refname, so the
 * separator cannot appear on the right-hand side. A line that does not parse —
 * a truncated read, a non-UTF-8 refname that is by construction not one of ours
 * — is DROPPED rather than refused: the effect is a ref that survives this pass
 * and is enumerated again by the next one, where refusing the whole run would
 * strand every ref beside it for the same reason.
 */
function parseSnapshotRefListing(
  listing: Buffer,
  expectedPrefix: string,
): readonly SnapshotRefListingEntry[] {
  const entries: SnapshotRefListingEntry[] = [];
  for (const line of listing.toString("utf8").split("\n")) {
    const separatorIndex: number = line.indexOf(" ");
    if (separatorIndex <= 0) {
      continue;
    }
    const objectId: string = line.slice(0, separatorIndex);
    const ref: string = line.slice(separatorIndex + 1);
    if (!OBJECT_ID_PATTERN.test(objectId) || !ref.startsWith(expectedPrefix)) {
      continue;
    }
    entries.push({ objectId, ref });
  }
  return entries;
}

// --------------------------------------------------------------------------
// Restore helpers (pure, or read-only against the filesystem)
// --------------------------------------------------------------------------

/**
 * The owning epoch for `targetPosition`, or `null` when no epoch's territory
 * contains it (I-010-23's lineage walk).
 *
 * "The newest epoch whose `rewindBase` is STRICTLY below the target": a position
 * at or below a rewind base is the prefix that epoch inherited from its parent,
 * so it belongs to the parent. Selected by MAXIMUM epoch rather than by list
 * position, so an unsorted lineage cannot silently yield a different owner than
 * a sorted one — the caller's ordering is a convenience here, never the rule.
 */
function selectOwningEpoch(
  epochLineage: readonly TurnSnapshotEpochLineageEntry[],
  targetPosition: number,
): number | null {
  let owningEpoch: number | null = null;
  for (const entry of epochLineage) {
    if (entry.rewindBase >= targetPosition) {
      continue;
    }
    if (owningEpoch === null || entry.epoch > owningEpoch) {
      owningEpoch = entry.epoch;
    }
  }
  return owningEpoch;
}

/** Every lineage entry must be able to name a ref segment and a position. */
function isUsableEpochLineage(epochLineage: readonly TurnSnapshotEpochLineageEntry[]): boolean {
  return epochLineage.every(
    (entry) => isNonNegativeInteger(entry.epoch) && isNonNegativeInteger(entry.rewindBase),
  );
}

/** One `git ls-tree -r -z` record. */
interface SnapshotTreeEntry {
  /** `100644`, `120000`, `160000` (a gitlink), … */
  readonly mode: string;
  readonly objectId: string;
  /**
   * Worktree-relative, DECODED — for rendering, for the filesystem seam, and for
   * the decode-to-decode comparisons that are documented as such. Not for
   * deciding whether this entry is the same path as a boundary record.
   */
  readonly path: string;
  /**
   * The same path as {@link listingEntryKey} bytes: the form every membership
   * test uses. Equal keys mean equal bytes; equal {@link path}s do not.
   */
  readonly pathKey: string;
}

/**
 * Parse `git ls-tree -r -z` — `<mode> SP <type> SP <object> TAB <path>` per
 * NUL-terminated record.
 *
 * `-z` is what makes this parseable at all: without it git QUOTES paths
 * containing unusual bytes, and the collision derivation below would then miss
 * exactly the paths whose names are hardest to reason about. A record that does
 * not carry the expected separators is skipped rather than guessed at — it would
 * be a git that changed its plumbing format, and a fabricated path would
 * silently widen or narrow an enumeration.
 *
 * Split on the BUFFER and carry BOTH representations, because this listing sits
 * on both sides of the byte-exactness line. Its paths are matched against the
 * byte-keyed boundary set — the pre-drop's snapshot-tree exclusion and the
 * obstruction guard's ancestor test both do it — and a decoded path there would
 * make an unrelated tracked file compare EQUAL to a boundary path whose bytes it
 * merely resembles once U+FFFD has eaten both. The same paths are also rendered
 * and handed to the filesystem, which needs text. So the record carries `pathKey`
 * for every decision and `path` for everything a human or a syscall sees, and no
 * caller has to remember which one it is holding.
 *
 * The split point is unambiguous on bytes: the header before it is ASCII and
 * contains no TAB, so the FIRST 0x09 is the separator even when the path itself
 * contains one — which `-z` output does not quote.
 */
function parseSnapshotTreeListing(listing: Buffer): readonly SnapshotTreeEntry[] {
  const entries: SnapshotTreeEntry[] = [];
  for (const record of splitNulTerminatedListingBytes(listing)) {
    const tabIndex: number = record.indexOf(TAB_SEPARATOR_BYTE);
    if (tabIndex < 0) {
      continue;
    }
    const fields: readonly string[] = record.subarray(0, tabIndex).toString("latin1").split(" ");
    const mode: string | undefined = fields[0];
    const objectId: string | undefined = fields[2];
    if (mode === undefined || objectId === undefined) {
      continue;
    }
    const pathBytes: Buffer = record.subarray(tabIndex + 1);
    entries.push({
      mode,
      objectId,
      path: pathBytes.toString("utf8"),
      pathKey: listingEntryKey(pathBytes),
    });
  }
  return entries;
}

/** One `git ls-files -t -z` record: a status tag and the path it describes. */
interface CachedStateEntry {
  /** `H` (materialized), `S` (skip-worktree), `M` (unmerged), … */
  readonly tag: string;
  /** Worktree-relative, as git emitted it. */
  readonly path: string;
}

/**
 * Parse `git ls-files -t -z` — `<tag> SP <path>` per NUL-terminated record.
 *
 * The tag is returned rather than interpreted, exactly as
 * {@link parseSnapshotTreeListing} returns every record and lets its caller pick:
 * which tags MEAN something is the consumer's question, and the one consumer here
 * wants `H`.
 *
 * A record that does not carry the expected separator is skipped rather than
 * guessed at, and unlike the tree listing the direction of that skip is knowable:
 * a dropped record is a path its consumer will not see as materialized, so the
 * discarded-subset diagnostic UNDER-reports. That is the safe direction for a
 * channel whose whole discipline is to avoid over-claiming, and it is why the
 * skip is tolerable here rather than merely conventional.
 */
function parseCachedStateListing(listing: Buffer): readonly CachedStateEntry[] {
  const entries: CachedStateEntry[] = [];
  for (const record of splitNulTerminatedListing(listing)) {
    if (record.length < 2 || record[1] !== " ") {
      continue;
    }
    entries.push({ tag: record.slice(0, 1), path: record.slice(2) });
  }
  return entries;
}

/**
 * The paths {@link SKIPPED_EMBEDDED_REPOSITORIES_TRAILER} recorded, out of a raw
 * `cat-file commit` body. An absent trailer is an empty list.
 *
 * Absent-collapses-to-empty is correct HERE and is not the general rule — see
 * {@link parseSparseBoundaryPaths}, whose absent case is a refusal. The
 * difference is what the two trailers mean by absence: this one is written only
 * when the skip list is non-empty, so no trailer IS the empty list, while the
 * sparse trailer is written unconditionally in a sparse root, so no trailer means
 * the capture was not sparse-aware. See {@link readJsonPathArrayTrailer} for the
 * fail-closed rule they share on a malformed value.
 *
 * The strings here are TEXT — decoded paths, the same kind the capture RESULT and
 * the preserved-entry check already carry. That differs from the sibling reader
 * below, whose strings are byte keys; the divergence and its reason live in
 * {@link readJsonPathArrayTrailer}.
 */
function parseSkippedEmbeddedRepositories(commitObject: Buffer): readonly string[] {
  return (
    readJsonPathArrayTrailer(
      commitObject,
      SKIPPED_EMBEDDED_REPOSITORIES_TRAILER,
      "skipped-embedded-repository",
    ) ?? []
  );
}

/**
 * The paths {@link SPARSE_BOUNDARY_PATHS_TRAILER} recorded, or `null` when the
 * snapshot carries no such trailer at all.
 *
 * THREE outcomes where the sibling decoder has two, and the third is the whole
 * point. `null` (absent) and `[]` (present and empty) are different facts about
 * the SNAPSHOT'S VINTAGE, and their correct handling is opposite:
 *
 *   * In a sparse restore root, ABSENT means the snapshot's out-of-cone
 *     disposition is unknown — either a pre-closure capture that lost the content
 *     or a root that was not sparse when it was captured — and the restore
 *     REFUSES at `derive-enumerations`, before anything is written. Reading it as
 *     the empty set would hand the delete pass full authority over exactly the
 *     content the trailer exists to protect, which is the failure mode the
 *     sibling decoder's fail-closed rule already names in the other direction.
 *   * In a NON-sparse restore root, absent is the ordinary answer for the
 *     overwhelming majority of snapshots ever captured, and the empty set is the
 *     correct reading: there is no boundary set because there was no cone.
 *
 * Collapsing the two would force one of those to be wrong. Present-but-
 * undecodable throws in both roots, exactly as the sibling does.
 *
 * The strings here are BYTE KEYS, not text: `latin1`, exactly as
 * {@link listingEntryKey} mints them, because every restore-side consumer
 * compares them against a listing and a comparison is only as exact as its least
 * exact side. Render one only through {@link decodeSparseBoundaryPathKey}.
 */
function parseSparseBoundaryPaths(commitObject: Buffer): readonly string[] | null {
  return readJsonPathArrayTrailer(commitObject, SPARSE_BOUNDARY_PATHS_TRAILER, "sparse-boundary");
}

/**
 * The shared reader behind the two trailer decoders above: the JSON string array
 * at `key`, or `null` when the message carries no line with that key.
 *
 * FAIL-CLOSED on a malformed value, which is the one interesting decision here.
 * Returning `null` for an unparseable body would be the tolerant reading and is
 * exactly wrong for both callers: each list is a DO-NOT-DELETE set, so an absent
 * list is not a neutral default but full authority to destroy the content the
 * trailer exists to protect. A body carrying the key and not a decodable array is
 * a snapshot this code does not understand, and the safe answer to that is to
 * refuse the restore rather than to proceed with the protection silently
 * disabled. The throw lands at `derive-enumerations`, which is pre-mutation — the
 * refusal costs nothing on disk.
 *
 * The commit body is located by the FIRST blank line, per git's object format:
 * everything before it is headers (`tree`, `parent`, `author`, `committer`, and
 * possibly `encoding` or a multi-line `gpgsig` whose continuations are
 * space-prefixed), everything after is the message. Scanning the whole object
 * instead would let a header value ending in a trailer key be read as one.
 *
 * ONE reader, TWO kinds of string, and this is the place to know it. The commit
 * object is decoded as UTF-8 here because that is what it IS — the message was
 * written as UTF-8 bytes — but what the recovered code points MEAN is the
 * caller's fact, not this function's. {@link parseSkippedEmbeddedRepositories}
 * gets TEXT: its writer stringified decoded paths, and its consumers render them
 * and compare them against decoded listing entries.
 * {@link parseSparseBoundaryPaths} gets BYTE KEYS: its writer stringified
 * `latin1` keys, so each recovered code point is one path byte and
 * `Buffer.from(key, "latin1")` is the original path. The asymmetry survives this
 * function untouched — U+0080–U+00FF make the round trip through
 * `JSON.stringify` → UTF-8 message bytes → `toString("utf8")` → `JSON.parse`
 * unchanged, and every code point below U+0020 is escaped, so no path byte can
 * forge the newline that would end the trailer.
 */
function readJsonPathArrayTrailer(
  commitObject: Buffer,
  key: string,
  description: string,
): readonly string[] | null {
  const text: string = commitObject.toString("utf8");
  const separator: number = text.indexOf("\n\n");
  if (separator < 0) {
    return null;
  }
  for (const line of text.slice(separator + 2).split("\n")) {
    if (!line.startsWith(key)) {
      continue;
    }
    const encoded: string = line.slice(key.length).trim();
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch {
      throw new Error(`turn-snapshot could not decode the snapshot's ${description} trailer`);
    }
    if (!Array.isArray(decoded) || decoded.some((path) => typeof path !== "string")) {
      throw new Error(`turn-snapshot ${description} trailer was not an array of paths`);
    }
    return decoded as readonly string[];
  }
  return null;
}

/**
 * The object-id hex length a repository uses, from `rev-parse
 * --show-object-format`. See {@link OBJECT_ID_HEX_LENGTHS}.
 *
 * Throwing on an unrecognized name is deliberate: it reaches the capture funnel
 * as a `normalize-embedded-repositories` failure, which is the honest report for
 * a git whose object formats this module has never been measured against.
 */
function requireObjectIdHexLength(stdout: Buffer): number {
  const format: string = stdout.toString("utf8").trim();
  const hexLength: number | undefined = OBJECT_ID_HEX_LENGTHS.get(format);
  if (hexLength === undefined) {
    throw new Error(`git reported an unrecognized object format: ${format}`);
  }
  return hexLength;
}

/**
 * Every PROPER ancestor directory of a git-spelled repo-relative path, outermost
 * first: `a/b/c` yields `a` and `a/b`, and a single-segment path yields none.
 *
 * Splitting on `/` is what makes the restore leg's obstruction test respect
 * SEGMENT boundaries — `foo` is an ancestor of `foo/a` and is not one of
 * `foobar/a`, which a raw string-prefix test would get backwards. Both listings
 * this compares come from git itself (`ls-tree -r` and `ls-files`), and git
 * spells repo-relative paths with forward slashes on every platform, so no
 * host separator enters the comparison — which is also why `dirname` is not the
 * tool here.
 */
function collectProperAncestorDirectories(path: string): readonly string[] {
  const segments: readonly string[] = path.split("/");
  const ancestors: string[] = [];
  for (let boundary = 1; boundary < segments.length; boundary += 1) {
    ancestors.push(segments.slice(0, boundary).join("/"));
  }
  return ancestors;
}

/** Append `value` to the list `index` holds at `path`, creating the list once. */
function appendToPathIndex<Value>(index: Map<string, Value[]>, path: string, value: Value): void {
  const existing: Value[] | undefined = index.get(path);
  if (existing === undefined) {
    index.set(path, [value]);
    return;
  }
  existing.push(value);
}

/**
 * Whether an `ls-files -o` entry names a path the CAPTURE put outside this
 * restore's write authority — the delete pass's exemption test.
 *
 * `entry` arrives in listing spelling, so a directory carries the trailing slash
 * git adds to a path it did not descend into; it is stripped before comparing,
 * because {@link classifySparseBoundaryPaths} has already moved that slash from
 * the path text into the KIND — both of its sets hold slash-free names, and the
 * trailer keeps the slash only so the kind survives the round trip.
 *
 * AT or BENEATH, on SEGMENT boundaries, for the reason
 * {@link collectProperAncestorDirectories} states in the other direction: a bare
 * `startsWith` would make recorded `nested` protect an unrelated `nested-copy/`,
 * which is over-protection — content the restore is supposed to delete surviving
 * because of a shared name prefix. The `/` in the test is what keeps the
 * exemption to the recorded subtree.
 *
 * TEXT on both sides, unlike {@link isSparseBoundaryListingEntry}, which compares
 * byte keys. Not an inconsistency: this predicate's recorded list arrives from
 * {@link parseSkippedEmbeddedRepositories}, whose trailer holds decoded paths
 * because they also reach the capture RESULT, so decoded-against-decoded is like
 * against like here. The residual that leaves — two un-decodable nested
 * repositories aliasing onto one recorded entry — is over-protection of a path
 * the capture already declared out-of-snapshot, and closing it means changing
 * that trailer's encoding and the wire-facing values it feeds.
 */
function isPreservedListingEntry(entry: string, preservedPaths: readonly string[]): boolean {
  const path: string = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  return preservedPaths.some((preserved) => path === preserved || path.startsWith(`${preserved}/`));
}

/**
 * The recorded sparse boundary set, SPLIT BY THE ENTRY KIND the capture saw.
 *
 * The trailer is one JSON array; this is that array read ONCE into the two kinds
 * its consumers must treat differently, so no consumer re-derives the split and
 * they cannot drift apart. See {@link SPARSE_BOUNDARY_PATHS_TRAILER} for why the
 * kinds are distinguishable at all.
 *
 * A SET for the file kind, whose consumers test exact membership per listing
 * entry on every delete pass; an ARRAY for the directory kind, whose consumer has
 * to scan, exactly as {@link isPreservedListingEntry}'s does and for the same
 * reason. Directory names are stored SLASH-STRIPPED — the slash did its work at
 * classification time and every comparison downstream is against a stripped
 * listing path.
 *
 * Both members hold BYTE KEYS ({@link listingEntryKey} spelling), never text,
 * because every one of this type's consumers is a membership test and a
 * membership test on decoded paths answers the wrong question — see
 * {@link SPARSE_BOUNDARY_PATHS_TRAILER}. The three consumers, all byte-keyed:
 * the delete exemption ({@link isSparseBoundaryListingEntry}), the index pre-drop
 * ({@link isSparseBoundaryIndexPath}), and the obstruction guard.
 */
interface SparseBoundarySet {
  readonly filePaths: ReadonlySet<string>;
  readonly directoryPaths: readonly string[];
}

/** The boundary set of a snapshot that recorded none. */
const EMPTY_SPARSE_BOUNDARY_SET: SparseBoundarySet = {
  filePaths: new Set<string>(),
  directoryPaths: [],
};

/**
 * Split the decoded trailer array into {@link SparseBoundarySet}'s two kinds.
 *
 * PURE, and deliberately downstream of {@link parseSparseBoundaryPaths} rather
 * than folded into it: that decoder's three-way answer — absent, present-empty,
 * malformed — is the sparse VINTAGE gate, and this classification must not be
 * able to blur it. An empty array in, an empty set of both kinds out; `null`
 * never reaches here.
 *
 * A zero-length name after stripping (`""`, or a bare `"/"` — neither is a shape
 * `ls-files` produces) is DROPPED rather than kept or refused. Kept as a
 * directory name it would prefix-match the entire worktree and exempt every
 * untracked path from the delete pass, which is the failure mode with the widest
 * blast radius available here; refusing would fail a restore over an entry that
 * names nothing. Dropping costs exactly nothing real, because no listing entry
 * can ever equal it.
 *
 * `recordedPaths` are BYTE KEYS and the kind test still works on them, because
 * the trailing slash is 0x2F and no byte of a multi-byte UTF-8 sequence can be
 * 0x2F — the same property that lets git split its own paths on `/`. So the kind
 * survives whatever the path's bytes are, decodable or not.
 */
function classifySparseBoundaryPaths(recordedPaths: readonly string[]): SparseBoundarySet {
  const filePaths = new Set<string>();
  const directoryPaths: string[] = [];
  for (const recordedPath of recordedPaths) {
    if (recordedPath.endsWith("/")) {
      const directoryPath: string = recordedPath.slice(0, -1);
      if (directoryPath.length > 0) {
        directoryPaths.push(directoryPath);
      }
      continue;
    }
    if (recordedPath.length > 0) {
      filePaths.add(recordedPath);
    }
  }
  return { filePaths, directoryPaths };
}

/**
 * Whether an `ls-files -o` entry names a path the capture recorded as a SPARSE
 * BOUNDARY path — the delete pass's other exemption test.
 *
 * A SEPARATE predicate from {@link isPreservedListingEntry}, and THREE-WAY where
 * that one has a single rule. What the capture recorded decides the width, and
 * the three cases are:
 *
 *   * A skipped embedded repository ({@link isPreservedListingEntry}) is a
 *     REPOSITORY. Deleting `nested/src/a.ts` one path at a time destroys it as
 *     completely as deleting `nested/`, so the exemption covers everything
 *     beneath it.
 *   * A boundary FILE entry is a PATH, and its exemption is EXACT. The capture
 *     recorded the identity of one out-of-cone file, and that file is exactly
 *     what the restore may not delete. Matching subtrees for this kind would
 *     over-protect in the direction that matters: it cannot, because a file has
 *     no subtree — which is precisely why the kinds are recorded separately
 *     instead of the whole set taking one width.
 *   * A boundary DIRECTORY entry is a SUBTREE, for the same reason the skipped
 *     repository is. `ls-files -o` emits a trailing-slash entry only for a
 *     directory it did NOT descend into, so the capture could not enumerate what
 *     was inside; path identity for that entry IS the subtree, and there is no
 *     narrower true statement available about it. The concrete case: a
 *     boundary-time out-of-cone embedded repository, recorded as `nested/`, whose
 *     turn removed its `.git` — the restore's listing now descends and emits
 *     `nested/payload.txt`, which an exact-path exemption would not cover, and
 *     the delete pass would take the boundary-time payload the trailer exists to
 *     keep.
 *
 * NAMED RESIDUAL, the cost of that third case: a file the TURN created INSIDE a
 * boundary-time non-descended directory is post-boundary content that this
 * exemption nonetheless protects. It is the same over-protection the skipped-
 * repository exemption already accepts, bounded to directories git refused to
 * walk, and it is the survivable direction — the alternative deletes
 * boundary-time content. Turn-created out-of-cone files ANYWHERE ELSE are still
 * deleted exactly as their in-cone counterparts are, which is the I-010-24
 * property this closure must not trade away, and the suite pins it with a
 * turn-created file inside a boundary-time PLAIN directory.
 *
 * THE TRAILING SLASH IS HANDLED ASYMMETRICALLY, and the asymmetry is the whole
 * content of the kind distinction at match time:
 *
 *   * The FILE arm requires the listing entry to be SLASH-FREE. A trailing slash
 *     in an `ls-files -o` entry is git saying "this is a DIRECTORY I did not
 *     descend into", so a slash-suffixed entry standing at a recorded boundary
 *     FILE path is not that file — it is a directory the TURN created where the
 *     file used to be, most plausibly an embedded repository. Stripping first and
 *     matching the file set anyway exempted that directory WHOLE, on the strength
 *     of a name it merely inherited, which is the exact-path width this docblock
 *     claims being quietly false.
 *   * The DIRECTORY arm accepts BOTH spellings, because there the slash is not
 *     evidence: git emits it only for a directory it refused to walk, so the same
 *     boundary-time directory is spelled `nested/` in one listing and reached as
 *     `nested/payload.txt` (slash-free, and beneath) in the next. Requiring the
 *     slash on this arm would under-exempt, and under-exemption on this arm is
 *     deletion of boundary-time content — the failure the trailer exists to stop.
 *
 * SECOND NAMED RESIDUAL, the mirror of the first and deliberately retained: a
 * FILE the turn created at a recorded boundary DIRECTORY path is exempted by the
 * directory arm's equality case. Distinguishing it would mean requiring the slash
 * on that arm, which is the destructive trade just refused. Over-protection of a
 * turn-created path is survivable; deletion of boundary-time content is not.
 *
 * `entryKey` is a {@link listingEntryKey} byte key and both of this set's members
 * are too — the exemption is decided on bytes, never on decoded text, so two
 * paths that merely COLLAPSE to the same string cannot borrow each other's
 * protection.
 */
function isSparseBoundaryListingEntry(entryKey: string, boundarySet: SparseBoundarySet): boolean {
  const isDirectorySpelling: boolean = entryKey.endsWith("/");
  const pathKey: string = isDirectorySpelling ? entryKey.slice(0, -1) : entryKey;
  return (
    (!isDirectorySpelling && boundarySet.filePaths.has(pathKey)) ||
    isWithinSparseBoundaryDirectory(pathKey, boundarySet)
  );
}

/**
 * Whether `pathKey` is AT or BENEATH a recorded boundary DIRECTORY, on segment
 * boundaries — the directory kind's width, spelled once for the two legs that
 * must agree on it.
 *
 * Shared by the delete exemption and the index pre-drop deliberately: those two
 * legs are the same statement about one path made to two mechanisms ("the restore
 * has no authority to destroy this"), and a width that drifted between them would
 * mean the pre-drop unstaging something the delete pass then removes, or the
 * reverse. The `/` in the prefix test is the segment boundary
 * {@link collectProperAncestorDirectories} argues for from the other side:
 * recorded `nested` must not reach `nested-copy/a.txt`.
 */
function isWithinSparseBoundaryDirectory(pathKey: string, boundarySet: SparseBoundarySet): boolean {
  return boundarySet.directoryPaths.some(
    (directoryPath) => pathKey === directoryPath || pathKey.startsWith(`${directoryPath}/`),
  );
}

/**
 * Whether an INDEX path falls inside the recorded boundary set — the pre-drop's
 * membership test.
 *
 * The exemption's width, minus the slash question: git's index holds files, so an
 * index path is never slash-suffixed and the file arm is a plain exact match. The
 * directory arm is shared outright with {@link isSparseBoundaryListingEntry},
 * equality case included, so a boundary directory that the turn REPLACED with a
 * tracked file is unstaged rather than left for `read-tree` to overwrite.
 */
function isSparseBoundaryIndexPath(pathKey: string, boundarySet: SparseBoundarySet): boolean {
  return (
    boundarySet.filePaths.has(pathKey) || isWithinSparseBoundaryDirectory(pathKey, boundarySet)
  );
}

/**
 * A boundary byte key rendered back to TEXT, for a human.
 *
 * The one sanctioned exit from the byte-keyed world, and it exists so the rest of
 * the closure never needs another: refusal detail, diagnostics and log lines all
 * come through here, and nothing that DECIDES anything does. `latin1` back to
 * bytes is exact; the `utf8` decode after it is lossy in precisely the way that is
 * fine for a message and fatal for a comparison.
 */
function decodeSparseBoundaryPathKey(pathKey: string): string {
  return Buffer.from(pathKey, "latin1").toString("utf8");
}

/**
 * A TYPE-AWARE fingerprint of whatever is at `path` — the restore leg's evidence
 * for "this colliding ignored path was overwritten".
 *
 * One string per observable state, never `null`, and the type is half the value:
 * a fingerprint that carried bytes alone answered "same bytes?" when the
 * question is "same THING?", and the two differ in exactly the cases this
 * enumeration exists to catch. Both were measured on git 2.50.1 and both are
 * driven by the suite:
 *
 *   * A DANGLING SYMLINK destroyed by the restore. Reading it fails (`ENOENT`
 *     through the link), and reading what replaced it — a directory the checkout
 *     needed — fails too (`EISDIR`). A bytes-only fingerprint scored that
 *     `null` → `null`, compared them EQUAL, and dropped a destroyed ignored path
 *     out of a `partial_restore` report whose whole job is to name it.
 *   * A LIVE SYMLINK replaced by a regular file with byte-identical content. A
 *     bytes-only fingerprint follows the link, hashes the target's bytes, and
 *     scores the two sides equal — so a link the restore replaced with the
 *     snapshot's own file goes unreported. `lstat` and not `stat` for this
 *     reason: every probe here is about the entry AT the path, never about what
 *     it points at.
 *
 * The arms are prefixed rather than bare hashes, so the two arms that DO carry a
 * hash cannot collide across types: a file whose bytes are `x` and a symlink
 * whose target is `x` are different observations and compare unequal. The two
 * hashless arms are coarser by construction and say so — `directory` and `other`
 * each describe a state rather than identify one — and each is a NAMED residual
 * rather than an oversight:
 *
 *   * `other` (fifo, socket, device) collides with a different `other`. Not
 *     reachable as a restore EFFECT: `read-tree --reset -u` writes regular files,
 *     symlinks and the directories that hold them, never a device node, so
 *     scoring `other` on both sides means the restore did not touch that path.
 *   * `directory` collides with a directory whose CONTENTS changed. Reachable —
 *     it is exactly what replaced the dangling symlink above — and left coarse on
 *     purpose: the enumerated paths are the ones the checkout named as blockers,
 *     which are blobs in the snapshot tree, and hashing a directory instead would
 *     be a recursive walk on the failure path, where the rule is to observe
 *     cheaply and never to become the failure being reported.
 *
 * `absent` is the answer for a path with nothing observable, an `lstat` that
 * failed for any reason included — the same fail-to-absent posture
 * {@link pathExists} takes, and the reason
 * {@link isPathProvablyAbsent} exists separately for the retention leg, where
 * that collapse would be wrong. It is a deliberate residual here: a path
 * unreadable before AND after for two DIFFERENT reasons compares equal and is
 * not enumerated. The alternative — reporting every unreadable path as
 * overwritten — would fabricate data loss out of an `EACCES`.
 *
 * Deliberately git-free (an `lstat`, a `readFile`, a `readlink`): it runs on the
 * failure path, where the git seam is the thing that just failed.
 */
async function fingerprintPath(path: string): Promise<string> {
  let entry: Stats;
  try {
    entry = await lstat(path);
  } catch {
    return "absent";
  }
  if (entry.isSymbolicLink()) {
    try {
      return `symlink:${hashBytes(Buffer.from(await readlink(path), "utf8"))}`;
    } catch {
      return "symlink:unreadable";
    }
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  if (!entry.isFile()) {
    return "other";
  }
  try {
    return `file:${hashBytes(await readFile(path))}`;
  } catch {
    return "file:unreadable";
  }
}

/** The one hash spelling {@link fingerprintPath}'s arms share. */
function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * What the boundary-obstruction guard needs to know about a path: is a DIRECTORY
 * there, is something else there, is nothing there — or could this not be
 * settled at all.
 *
 * A SEPARATE observer from {@link fingerprintPath}, and the fourth arm is the
 * entire reason. That one collapses every `lstat` rejection onto `"absent"`,
 * which is right for a fingerprint (an unreadable path compares unequal to
 * whatever replaces it, so a destroyed path is still reported) and exactly wrong
 * here: this answer decides whether a DESTRUCTIVE checkout is refused, so
 * reading `EACCES` as "nothing is there" would fail OPEN in a guard whose only
 * job is to fail closed. `"unreadable"` is therefore its own arm and its consumer
 * treats it as obstruction.
 *
 * `ENOENT` and `ENOTDIR` are the two rejections that really do mean "not on
 * disk" — the second is what `lstat` says when an ancestor of the path is a file
 * — and they are the only two read as absence.
 *
 * `lstat` and not `stat`, so a SYMLINK is its own thing rather than whatever it
 * points at. A symlink where a boundary FILE entry was recorded answers
 * `"non-directory"`, which is the fail-closed reading and also the measured one:
 * on git 2.50.1 `read-tree --reset -u` unlinks a symlink standing where the
 * snapshot needs a directory (the link's TARGET survives; the link itself, which
 * is the boundary-time content, does not).
 */
type BoundaryPathPresence = "absent" | "directory" | "non-directory" | "unreadable";

async function probeBoundaryPathPresence(path: string): Promise<BoundaryPathPresence> {
  let entry: Stats;
  try {
    entry = await lstat(path);
  } catch (reason) {
    const code: string | undefined = (reason as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
  }
  return entry.isDirectory() ? "directory" : "non-directory";
}

/** Whether anything exists at `path`. Any error — including `ENOENT` — is `false`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `path` is PROVABLY absent — the retention leg's discriminator between
 * a git dir that is gone and one it merely could not use.
 *
 * A separate helper rather than `!(await pathExists(path))`, and the difference
 * is the whole reason it exists: `pathExists` treats every error as absence,
 * which is right for the restore leg's directory observations and exactly wrong
 * here. An `EACCES` on a live repository would then read as a disposal and go
 * quiet, which is the fault this taxonomy is drawn to surface. So only `ENOENT`
 * and `ENOTDIR` are absence; anything else — including a probe that failed for a
 * reason with no `code` at all — resolves `false` and lands the run in the
 * alarming `git-dir-unusable` arm. Fails toward the alarm, deliberately.
 *
 * The errno read is typed `string | undefined` (this file's established form, at
 * the `rmdir` funnel) rather than `unknown`, and the type is doing work: under
 * `unknown`, a maintainer reaching for a NUMERIC errno — `code === 2` — compiles
 * to a permanently-false branch, and a genuinely-absent repository would then be
 * reported present and alarmed on. Typed, that spelling is a compile error.
 *
 * A READ, so it does not go through {@link TurnSnapshotFilesystem}, which is the
 * seam through which this service MUTATES — the same boundary the restore leg's
 * observations respect.
 */
async function isPathProvablyAbsent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (reason: unknown) {
    const code: string | undefined = (reason as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/**
 * A colliding ignored path plus the on-disk state the failure is measured
 * against.
 *
 * The fingerprint is a non-nullable {@link fingerprintPath} arm, and the absence
 * of `| null` is load-bearing rather than tidy: the nullable form made "could
 * not read either side" compare EQUAL to "could not read either side" for two
 * entirely different reasons, which is how a destroyed dangling symlink went
 * unreported. `absent` is one arm among several here, not the type's escape
 * hatch.
 */
interface ProspectiveCollision {
  readonly path: string;
  readonly fingerprintBeforeRestore: string;
}

/**
 * A divergent gitlink plus the on-disk state the failure is measured against.
 *
 * The same non-nullable {@link fingerprintPath} arm {@link ProspectiveCollision}
 * records, and for a sharper version of the same reason. This field was a
 * `presentBeforeRestore: boolean` filled by a `stat`, which FOLLOWS symlinks, so
 * a symlink pointing at a directory scored `true` — indistinguishable from a
 * real directory — and the failure report skipped every `true`. A restore that
 * replaced that symlink with a materialized gitlink directory and then failed
 * later therefore destroyed a symlink and enumerated nothing. That is round-2's
 * `stat`-follows-symlink defect recurring at a second consumer, which is why the
 * fix is the type rather than the call site: a boolean cannot express the
 * distinction, so any consumer of one is one edit away from re-introducing it.
 */
interface ProspectiveGitlinkDivergence {
  readonly path: string;
  readonly fingerprintBeforeRestore: string;
}

/**
 * A snapshot-tracked path the LIVE sparse definition excludes that was sitting
 * MATERIALIZED on disk before the checkout, plus the state its later removal is
 * measured against.
 *
 * The third member of the same family, carrying the same non-nullable
 * {@link fingerprintPath} arm for the same reason, and it is a CANDIDATE rather
 * than a conclusion. The set this seeds is the checkout's re-projection of a full
 * tree through a narrower live cone, which discards the path from the worktree —
 * so it is a real restore effect and belongs in the report. But it is an effect
 * of the CHECKOUT, and a sequence that refused before the checkout ran (or whose
 * checkout failed at the spawn) discarded nothing. Reporting the pre-mutation
 * candidate list on that path would be a bookkept claim about work that did not
 * happen, which is the failure the collision and gitlink enumerations already
 * solved by re-observing at report time. This carries the fingerprint so it can
 * be held to the same standard rather than to a weaker one.
 */
interface ProspectiveMaterialization {
  readonly path: string;
  readonly fingerprintBeforeRestore: string;
}

/** What the pre-mutation derivation produces; see the header. */
interface ProspectiveRestoreEffects {
  readonly collisions: readonly ProspectiveCollision[];
  readonly gitlinkDivergences: readonly ProspectiveGitlinkDivergence[];
  /**
   * Paths the CAPTURE recorded as skipped embedded repositories, and therefore
   * paths outside this restore's write authority — see
   * {@link SKIPPED_EMBEDDED_REPOSITORIES_TRAILER}. Carried alongside the two
   * enumerations because it is derived from the same object read and consumed in
   * the same sequence, not because it is an "effect": nothing happens at these
   * paths, which is the entire point.
   */
  readonly preservedEmbeddedRepositories: readonly string[];
  /**
   * Paths the CAPTURE recorded as its sparse boundary set, already split by entry
   * kind — see {@link SPARSE_BOUNDARY_PATHS_TRAILER} and
   * {@link classifySparseBoundaryPaths}. The delete pass's other exemption, and
   * carried here for the reason above: same object read, same sequence.
   *
   * Classified ONCE, here, rather than per consumer: three legs read it (the
   * delete-pass exemption, the index pre-drop and the obstruction guard) and they
   * ask the two kinds different questions — the guard's two shapes are per-kind,
   * while the exemption and the pre-drop share a width they must not drift apart
   * on ({@link isWithinSparseBoundaryDirectory}). Re-deriving the split at each
   * site is exactly the drift this carries a type to prevent.
   */
  readonly sparseBoundarySet: SparseBoundarySet;
  /**
   * Snapshot-tracked paths the LIVE sparse definition scores out of cone and that
   * were observed materialized before the checkout — the diagnostic's CANDIDATE
   * set, not its payload. Sorted, empty in a non-sparse root. Each carries the
   * pre-mutation fingerprint the emission re-observes against, so what is
   * reported is the subset the restore actually discarded. See
   * {@link ProspectiveMaterialization} and the `sparse-out-of-cone-materialized`
   * arm of {@link TurnSnapshotDiagnostic}.
   */
  readonly materializedOutOfCone: readonly ProspectiveMaterialization[];
  /**
   * The LIVE-index entries the pre-drop is about to remove — recorded boundary
   * paths the index holds and the snapshot tree does not. Raw `-z` listing bytes
   * rather than decoded names, so the invocation that consumes them feeds git
   * back the exact bytes git produced (the capture partition's discipline, for
   * the same reason: no path here is ever reconstructed from a decode).
   *
   * DERIVED here and applied by the caller, which is not a stylistic split. This
   * is the derivation's one mutating consequence, and the sequence puts a second
   * `HEAD` read between the derivation and the first mutation precisely so that
   * a `HEAD` moving during the listings refuses with NOTHING applied. Performing
   * the drop inside the derivation would make that `head_moved` arm — frozen by
   * Plan-004's wire mapping as the "refused before any mutation" answer — report
   * a refusal it had already half-acted on.
   *
   * Non-empty only for a snapshot that RECORDED a boundary set, whatever the
   * restore root's own sparsity now is — the same membership scope
   * {@link sparseBoundarySet} carries, because the two are halves of one
   * protection.
   */
  readonly droppableBoundaryIndexEntries: readonly Buffer[];
}

/** The derivation's value before it has run — a failure here reports all empty. */
const NO_PROSPECTIVE_RESTORE_EFFECTS: ProspectiveRestoreEffects = {
  collisions: [],
  gitlinkDivergences: [],
  preservedEmbeddedRepositories: [],
  sparseBoundarySet: EMPTY_SPARSE_BOUNDARY_SET,
  materializedOutOfCone: [],
  droppableBoundaryIndexEntries: [],
};

/**
 * The capture leg's cone partition of one `-z` listing.
 *
 * BOTH HALVES ARE BYTES, and the out-of-cone half being bytes is the repair
 * rather than a symmetry. `inConeListing` is a REBUILT `-z` stream ready for
 * `update-index --stdin`, made from the original listing's own byte slices;
 * `outOfConeEntries` are those same slices, VERBATIM — trailing slash included,
 * nothing decoded, nothing stripped. They stay bytes because the subtraction that
 * consumes them is a set operation against another git listing, and a decode
 * there maps every invalid sequence onto U+FFFD and so can make two DIFFERENT
 * paths compare equal. See {@link TurnSnapshotService.#deriveSparseBoundaryPaths}
 * for what that cost, and {@link listingEntryKey} for the keying that avoids it.
 */
interface SparseListingPartition {
  readonly inConeListing: Buffer;
  readonly outOfConeEntries: readonly Buffer[];
}

/**
 * One refusal reason from the boundary-obstruction guard: a recorded boundary
 * path standing where the checkout is about to write, and the snapshot paths that
 * would displace it.
 *
 * `displacedBy` holds only paths that WILL materialize at this restore — see
 * {@link TurnSnapshotService.#deriveBoundaryObstructions}. Naming a path that the
 * live cone leaves unwritten would make the refusal's one operator-facing channel
 * point at something that was never the cause.
 */
interface BoundaryObstruction {
  readonly path: string;
  readonly displacedBy: readonly string[];
}

/**
 * How many displacers the refusal names per obstruction before it starts
 * counting. Small on purpose: the first few carry the diagnosis, and the rest
 * only carry size.
 */
const NAMED_DISPLACERS_PER_OBSTRUCTION = 3;

/**
 * The obstruction refusal's detail, bounded — the two halves are bounded
 * DIFFERENTLY because only one of them amplifies.
 *
 * Every obstructing boundary path is named, with no cap. That list is the
 * operator's action item, and capping it would cost one refused restore per
 * batch to discover the next names; for a guard whose whole job is standing in
 * front of data destruction, a truncated action list is the wrong trade. Its
 * size is bounded by the recorded boundary set — a string this very snapshot
 * already carries in its commit message and this very call already decoded, so
 * naming all of it re-emits a quantity the system holds anyway.
 *
 * The displacers are only evidence, and they are a PRODUCT: shape (i) fires for
 * every proper ancestor, so a boundary file sitting high in the tree is
 * displaced by its entire subtree, and the string would then grow with the
 * REPOSITORY rather than with the trailer. It has nowhere to be truncated
 * downstream — `detail` reaches {@link TurnSnapshotPartialRestore} and the
 * `restore-failed` diagnostic verbatim, and both sibling pre-mutation refusals
 * are fixed-length strings, so this is the one message that could grow at all.
 */
function describeBoundaryObstructions(obstructions: readonly BoundaryObstruction[]): string {
  return obstructions
    .map((obstruction) => {
      const named: readonly string[] = obstruction.displacedBy.slice(
        0,
        NAMED_DISPLACERS_PER_OBSTRUCTION,
      );
      const unnamedCount: number = obstruction.displacedBy.length - named.length;
      const evidence: string =
        unnamedCount === 0 ? named.join(", ") : `${named.join(", ")}, and ${unnamedCount} more`;
      return `${obstruction.path} (displaced by ${evidence})`;
    })
    .join("; ");
}

// --------------------------------------------------------------------------
// Retention reads (`run_execution_contexts`)
// --------------------------------------------------------------------------

/**
 * One prune candidate. Column-cased, matching the sibling services' row shapes —
 * these are SQL result columns, not this module's identifiers.
 */
interface PrunableRunRow {
  readonly run_id: string;
  readonly git_common_dir: string;
  /**
   * `string` rather than `ExecutionMode`, matching
   * `./ephemeral-clone-service.ts`'s row shapes: the DDL's CHECK constrains the
   * column, but a row type is what SQLite handed back, not a parse of it. The
   * comparison happens against the annotated constants below.
   */
  readonly execution_mode: string;
}

/**
 * The two `run_execution_contexts` modes this leg reasons about, written as
 * annotated constants rather than inline literals — the idiom (and the reason)
 * `./ephemeral-clone-service.ts` states at its own pair: `'ephemeral clone'`
 * carries a SPACE, and a typo in it would silently make the disposal arm
 * unreachable rather than failing anywhere.
 */
const EPHEMERAL_CLONE_EXECUTION_MODE: ExecutionMode = "ephemeral clone";
const READ_ONLY_EXECUTION_MODE: ExecutionMode = "read-only";

interface RetentionCutoffParams {
  readonly released_before: string;
  readonly excluded_mode: ExecutionMode;
}

interface RunContextLookupParams {
  readonly run_id: string;
}

/**
 * The retention entry points' refusal when the service was constructed without a
 * `database`. A message rather than a bare `TypeError`, because the recovery is
 * a wiring change in a composition root and the reader of this string is
 * whoever wired it.
 */
const RETENTION_WITHOUT_DATABASE_MESSAGE =
  "TurnSnapshotService: the retention leg needs a `database` dependency " +
  "(construct with `database` to call sweepPrunableRuns / pruneSnapshotsForRun)";

// --------------------------------------------------------------------------
// TurnSnapshotService
// --------------------------------------------------------------------------

/**
 * Owns the `refs/sidekicks/runs/…` namespace and every git invocation that
 * writes into it.
 *
 * Stateless between calls by design: each capture resolves its own base, mints
 * its own scratch index and removes it again, so two concurrent captures — of
 * different runs, or of the same run's different turns — share nothing but the
 * hook-neutralization directory, which is empty by contract.
 */
export class TurnSnapshotService {
  readonly #hookNeutralizationDirectory: string;
  readonly #snapshotIndexDirectory: string;
  readonly #git: TurnSnapshotGitRunner;
  readonly #filesystem: TurnSnapshotFilesystem;
  readonly #gitCommandTimeoutMs: number;
  readonly #now: () => string;
  readonly #emitDiagnostic: (diagnostic: TurnSnapshotDiagnostic) => void;
  readonly #retentionWindowMs: number;
  // `null` when no `database` was supplied — the capture/restore-only wiring
  // CP-010-12 describes. Prepared ONCE in the constructor, the idiom
  // `./ephemeral-clone-service.ts` and `../workspace/execution-root-service.ts`
  // both use, so a schema drift fails at construction rather than at the first
  // sweep an hour into the daemon's life.
  readonly #selectPrunableRunsStmt: Statement<RetentionCutoffParams, PrunableRunRow> | null;
  readonly #selectRunContextStmt: Statement<RunContextLookupParams, PrunableRunRow> | null;

  constructor(deps: TurnSnapshotServiceDeps) {
    this.#hookNeutralizationDirectory = join(
      deps.executionRootsDirectory,
      HOOK_NEUTRALIZATION_SEGMENT,
    );
    this.#snapshotIndexDirectory = join(deps.executionRootsDirectory, SNAPSHOT_INDEX_SEGMENT);
    this.#git = deps.git ?? runTurnSnapshotGitWithExecFile;
    this.#filesystem = deps.filesystem ?? DEFAULT_TURN_SNAPSHOT_FILESYSTEM;
    this.#gitCommandTimeoutMs = deps.gitCommandTimeoutMs ?? DEFAULT_TURN_SNAPSHOT_GIT_TIMEOUT_MS;
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#emitDiagnostic = deps.emitDiagnostic ?? warnDiagnostic;

    // REFUSED rather than normalized, and refused HERE rather than at the first
    // sweep an hour into the daemon's life. The window is the only input to this
    // leg whose bad values fail OPEN: a zero or negative one puts the cutoff at
    // or after `now`, so `released_at <= @released_before` matches every terminal
    // run and the first sweep deletes snapshots the policy meant to keep —
    // silently, because nothing failed. `NaN` and `Infinity` fail closed but
    // opaquely, throwing "Invalid time value" from inside the sweep's own `try`
    // every tick while retention never actually runs. Both are a config typo
    // (`DEFAULT_… / 0`, a units mix-up, a subtraction the wrong way), and both
    // deserve the same answer the sweep cadence gives one.
    //
    // The UPPER bound joins them for a third failure direction that reads like
    // the opposite of a typo: `Number.MAX_SAFE_INTEGER` spelled as "keep
    // everything". It is finite and positive, so the first two clauses pass it,
    // and it then makes every cutoff unrepresentable — see
    // {@link MAXIMUM_RETENTION_WINDOW_MS} for why that is worse than a throw.
    const retentionWindowMs: number =
      deps.retentionWindowMs ?? DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS;
    if (
      !Number.isFinite(retentionWindowMs) ||
      retentionWindowMs <= 0 ||
      retentionWindowMs > MAXIMUM_RETENTION_WINDOW_MS
    ) {
      throw new RangeError(
        "TurnSnapshotService: retentionWindowMs must be a positive finite number of " +
          `milliseconds no greater than ${String(MAXIMUM_RETENTION_WINDOW_MS)} ` +
          `(received ${String(retentionWindowMs)})`,
      );
    }
    this.#retentionWindowMs = retentionWindowMs;

    const database: Database | undefined = deps.database;
    if (database === undefined) {
      this.#selectPrunableRunsStmt = null;
      this.#selectRunContextStmt = null;
    } else {
      // The candidate predicate, and the whole of "the window has closed":
      // `released_at` is NULL for a run that is still open (the T3.2 gate stamps
      // it at run terminal), so a still-open run is never a candidate no matter
      // how old it is, and the cutoff the caller binds is already
      // `now - retentionWindow`.
      //
      // The `IS NOT NULL` clause is EXPLICIT rather than load-bearing: SQL's
      // three-valued logic already drops a NULL from the `<=` comparison, so the
      // clause states the intent and keeps the predicate readable rather than
      // resting the "a live run is never pruned" property on a subtlety.
      //
      // `read-only` runs are excluded at the PREDICATE rather than skipped later:
      // {@link SNAPSHOT_APPLICABLE_MODES} guarantees they never captured a ref,
      // so every one of them would cost a `git for-each-ref` spawn to enumerate
      // nothing — and would inflate `examinedRunCount`, the denominator an
      // operator reads the skip list against. Bound rather than interpolated, so
      // the excluded mode is one typed constant and not a hand-typed literal.
      //
      // The comparison is TEXT `<=`; see the header for the fixed-width-UTC
      // constraint that makes it chronological. Ordered so a pass is
      // deterministic and the oldest release prunes first — with `run_id` as the
      // tiebreak, since two runs can release in the same millisecond.
      this.#selectPrunableRunsStmt = database.prepare<RetentionCutoffParams, PrunableRunRow>(
        `SELECT run_id, git_common_dir, execution_mode
           FROM run_execution_contexts
          WHERE released_at IS NOT NULL
            AND released_at <= @released_before
            AND execution_mode <> @excluded_mode
          ORDER BY released_at ASC, run_id ASC`,
      );

      // The per-run primitive's own resolution. Deliberately UNFILTERED by
      // `released_at` AND by mode: the window is the SWEEP's predicate and the
      // read-only exclusion is the sweep's economy, while this statement backs
      // the primitive that an operator (or a future explicit-disposal path)
      // calls for one named run — see `pruneSnapshotsForRun`. A read-only run
      // reached that way enumerates nothing, which is the honest answer.
      this.#selectRunContextStmt = database.prepare<RunContextLookupParams, PrunableRunRow>(
        `SELECT run_id, git_common_dir, execution_mode
           FROM run_execution_contexts
          WHERE run_id = @run_id`,
      );
    }
  }

  // ------------------------------------------------------------------------
  // Capture (T5.1)
  // ------------------------------------------------------------------------

  /**
   * Record the execution root's project state — tracked plus non-ignored
   * untracked — as a snapshot commit under
   * `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>`.
   *
   * NEVER THROWS. Every failure — an invalid input, a git leg, the ref write,
   * even a diagnostic sink that throws or rejects — becomes a typed `failed`
   * result, plus a diagnostic wherever the sink accepts one, because
   * `Spec-010 §Turn-Boundary Snapshots` makes the turn boundary complete
   * regardless: snapshots are a recovery convenience, not a turn gate.
   *
   * The recipe is `Spec-010 §Turn-Boundary Snapshots`'s, leg for leg. Its two
   * non-obvious properties, both spec-mirrored:
   *
   *   * ONE base OID, resolved once at entry and passed to both `read-tree` and
   *     `commit-tree -p`. Handing symbolic `HEAD` to both legs lets them
   *     re-resolve independently, which records an old-`HEAD` TREE under a
   *     new-`HEAD` PARENT if the branch moves mid-capture — a snapshot whose
   *     restore precondition can never be satisfied by the state it came from.
   *   * The untracked-embedded-repo normalization pass. `update-index --add`
   *     silently DROPS the trailing-slash directory entry `ls-files -o` reports
   *     for a non-ignored embedded repository (`Ignoring path nested/`, exit 0),
   *     so the bare pipeline would omit a whole repository that existed at the
   *     boundary. Each is re-recorded as a `160000` gitlink — porcelain
   *     `git add -A`'s own representation — and one whose `HEAD` yields no OID
   *     the superproject index can hold (commitless, or a differing object
   *     format) is skipped and enumerated.
   */
  async captureTurnSnapshot(input: CaptureTurnSnapshotInput): Promise<TurnSnapshotCaptureResult> {
    // The mode self-guard runs FIRST — see the header. Nothing above this line
    // touches the filesystem or spawns git, which is what makes the read-only
    // no-op assertable as an unchanged object count and an unchanged ref count.
    // An ALLOWLIST, so an unrecognized mode is inert rather than captured; see
    // {@link SNAPSHOT_APPLICABLE_MODES}.
    if (!SNAPSHOT_APPLICABLE_MODES.has(input.mode)) {
      return {
        outcome: "not-applicable",
        reason: input.mode === "read-only" ? "read-only-mode" : "mode-not-snapshot-capable",
        mode: input.mode,
      };
    }

    if (
      !isSafeRefComponent(input.runId) ||
      !isNonNegativeInteger(input.epoch) ||
      !isNonNegativeInteger(input.turnOrdinal)
    ) {
      return this.#failCapture(input, null, "validate-inputs", "unusable ref components");
    }

    const ref: string = buildTurnSnapshotRef(input.runId, input.epoch, input.turnOrdinal);
    const scratchIndexPath: string = join(this.#snapshotIndexDirectory, `${randomUUID()}.index`);
    // The cursor the funnel reports. Advanced immediately before each leg, so a
    // leg added later inherits the reporting rather than needing its own catch —
    // and it starts on the FIRST statement inside the `try`, not on the first
    // git leg: the scratch-index directory is where an EACCES on the daemon's
    // own execution-roots directory lands, and reporting that as `resolve-base`
    // would send an operator to look at the repository.
    let step: TurnSnapshotCaptureStep = "prepare-scratch-index";

    try {
      await this.#filesystem.createDirectory(this.#snapshotIndexDirectory);

      step = "resolve-base";
      const baseCommit: string = await this.#resolveBaseCommit(input.executionRoot);

      step = "detect-sparse-root";
      const isSparseRoot: boolean = await this.#detectSparseRoot(input.executionRoot);

      step = "seed-index";
      if (isSparseRoot) {
        // The closure's inversion, and the reason it is a SEED change rather than
        // a staging change. `read-tree <base>` builds an index with no
        // skip-worktree bits, so every out-of-cone path is a live entry the
        // staging leg would re-stat, find absent from the worktree, and
        // `--remove` — which is precisely how the shipped pipeline lost them.
        // Copying the LIVE index carries the bits, so out-of-cone entries arrive
        // already staged at the blobs the user's index records, and `write-tree`
        // records them without this pipeline ever hashing a byte of out-of-cone
        // content. `<base>` is not the right source for a further reason the pin
        // below cannot fix: the live index legitimately differs from `HEAD` at
        // out-of-cone paths (a `git add --sparse` earlier in the run), and only
        // the live index knows what those entries are.
        await this.#seedScratchIndexFromLiveIndex(input.executionRoot, scratchIndexPath);
      } else {
        // The pin is load-bearing HERE, not decorative-by-symmetry with the restore
        // legs: a replace ref on the base commit seeds the scratch index from the
        // replacement's tree, and while the re-listing below corrects most of that,
        // a path both index-tracked and ignored-by-rule is carried by the seed
        // ALONE and is silently dropped. Measured against porcelain `add -A`; see
        // the host-config table's `core.useReplaceRefs` row.
        await this.#runGit(
          ["-C", input.executionRoot, ...USE_REPLACE_REFS_PIN, "read-tree", baseCommit],
          {
            environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath },
          },
        );
      }

      step = "list-paths";
      // `-c` re-lists the temp index's seeded base paths so `--add --remove`
      // re-stats each one (staging tracked modifications AND deletions), while
      // `-o` plus {@link EXCLUDE_PER_DIRECTORY_GITIGNORE} lists untracked files
      // honouring IN-TREE `.gitignore` rules only — see that constant for why
      // the exclude source is pinned rather than left to porcelain, and for the
      // two restore legs that must spell it identically.
      const fullListing: Buffer = (
        await this.#runGit(
          ["-C", input.executionRoot, "ls-files", "-co", EXCLUDE_PER_DIRECTORY_GITIGNORE, "-z"],
          { environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath } },
        )
      ).stdout;

      step = "check-sparse-rules";
      // In a non-sparse root this is the identity partition and costs no spawn:
      // every path is in cone, and the staging stdin below is the same Buffer the
      // shipped pipeline handed over. In a sparse root it is git's own matcher
      // deciding, never this module's.
      const partition: SparseListingPartition = isSparseRoot
        ? await this.#partitionListingByCone(input.executionRoot, fullListing)
        : { inConeListing: fullListing, outOfConeEntries: [] };
      const listing: Buffer = partition.inConeListing;

      step = "stage-paths";
      await this.#runGit(
        [
          "-C",
          input.executionRoot,
          // `core.autocrlf=false` pins check-in conversion off — git's own
          // default, neutralized by pinning: a host `core.autocrlf=input` or
          // `true` re-hashes CRLF worktree bytes to LF blobs, changing blob,
          // tree and snapshot OIDs for identical worktree bytes.
          // `core.safecrlf=false` pins that same channel's VETO off, and it is a
          // veto rather than a conversion: measured on git 2.50.1, staging with
          // the host setting absent and staging with it pinned false produce the
          // IDENTICAL tree. What a host `core.safecrlf=true` adds is a fatal —
          // check-in-time, against an in-tree `*.txt text` and CRLF worktree
          // bytes it exits `fatal: CRLF would be replaced by LF`, so capture
          // fails, the turn runs uncovered, and the rollback that should have
          // had a snapshot answers `no_snapshot`. That is snapshot AVAILABILITY
          // turning on host config — the same class the OID pins close from the
          // other side — so the project's own declared normalization proceeds
          // here without the host's veto over it.
          // `core.attributesFile=/dev/null` plus `GIT_ATTR_NOSYSTEM=1` take the
          // user and system attribute files out of the conversion decision,
          // while in-tree `.gitattributes` — a project declaration, checked in
          // and identical on every host — stays deliberately honoured.
          // `core.fileMode` is deliberately NOT pinned here, and the reason is
          // this leg specifically: the seeded scratch index carries no stat data,
          // so `update-index` re-stats every listed path, and a `fileMode=true`
          // pin would therefore take each TRACKED file's mode from lstat and
          // discard the mode its base commit recorded. Measured — see the
          // header's row for the four-cell matrix — and the unpinned column is
          // byte-identical to `git add -A` under the same host config, which is
          // the equivalence `Spec-010 §Turn-Boundary Snapshots` actually asks
          // for.
          //
          // This is the only leg that pins them because it is the only leg that
          // hashes worktree bytes: the gitlink insert below passes a literal OID
          // through `--cacheinfo` and reads no content, `write-tree` and
          // `commit-tree` hash objects the index already holds, and `safecrlf` is
          // a check-in check the restore checkouts never consult (measured).
          "-c",
          "core.autocrlf=false",
          "-c",
          "core.safecrlf=false",
          "-c",
          "core.attributesFile=/dev/null",
          "update-index",
          "--add",
          "--remove",
          "-z",
          "--stdin",
        ],
        {
          environmentOverrides: {
            GIT_INDEX_FILE: scratchIndexPath,
            GIT_ATTR_NOSYSTEM: "1",
          },
          stdin: listing,
        },
      );

      step = "normalize-embedded-repositories";
      const skippedEmbeddedRepositories: readonly string[] =
        await this.#normalizeEmbeddedRepositories(input.executionRoot, scratchIndexPath, listing);

      step = "write-tree";
      const treeObjectId: string = this.#requireObjectId(
        (
          await this.#runGit(["-C", input.executionRoot, "write-tree"], {
            environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath },
          })
        ).stdout,
      );

      // The boundary set, derived from the tree that was just written and folded
      // under this step rather than given one of its own — it is the write-tree
      // result being read back, not a new stage of the pipeline, and the capture
      // vocabulary grows by exactly the two members the closure needs.
      //
      // OUT-OF-CONE MINUS RECORDED, and both halves are necessary. The listing's
      // out-of-cone entries include paths the live-index seed already carries
      // (every ordinary skip-worktree entry), and those are IN the snapshot tree
      // — recording them would exempt the restore from touching content it holds
      // a copy of. What remains after subtracting the tree is exactly the class
      // the trailer exists for: out-of-cone paths the snapshot could not record,
      // which is untracked ones plus intent-to-add ones (`write-tree` omits an
      // intent-to-add entry — measured on git 2.50.1).
      //
      // The subtraction runs on the partition's raw listing slices, not on
      // decoded names, and the decode happens on its far side; see the leg.
      const sparseBoundaryPaths: readonly string[] | null = isSparseRoot
        ? await this.#deriveSparseBoundaryPaths(
            input.executionRoot,
            treeObjectId,
            partition.outOfConeEntries,
          )
        : null;

      step = "commit-tree";
      const snapshotCommit: string = await this.#commitSnapshotTree(
        input.executionRoot,
        treeObjectId,
        baseCommit,
        skippedEmbeddedRepositories,
        sparseBoundaryPaths,
      );

      step = "write-ref";
      const recordedCommit: string | null = await this.#writeCreateOnlyRef(
        input.executionRoot,
        ref,
        snapshotCommit,
      );
      if (recordedCommit !== null) {
        return { outcome: "already-captured", ref, snapshotCommit: recordedCommit };
      }

      if (skippedEmbeddedRepositories.length > 0) {
        this.#emit({
          kind: "embedded-repositories-skipped",
          runId: input.runId,
          epoch: input.epoch,
          turnOrdinal: input.turnOrdinal,
          ref,
          skippedPaths: skippedEmbeddedRepositories,
        });
      }

      return {
        outcome: "captured",
        ref,
        snapshotCommit,
        baseCommit,
        skippedEmbeddedRepositories,
      };
    } catch (reason: unknown) {
      return this.#failCapture(input, ref, step, describeRejection(reason));
    } finally {
      // The scratch index is per-capture and never outlives it, on the failure
      // path as much as the success one — otherwise a daemon that fails captures
      // accumulates index files in its own execution-roots directory forever.
      // The seam's removal tolerates a missing path, so a failure BEFORE the
      // index was written costs nothing here.
      //
      // Its OWN try/catch, because a `finally` is the one place a rejection
      // escapes the funnel above: an EPERM/EBUSY from an antivirus scanner or a
      // filesystem seam that throws would replace the typed result on EVERY arm
      // — including the failure arm, where the diagnostic has already been
      // emitted and the report would be thrown away — and break the
      // never-throws contract from the one statement written to be
      // inconsequential. Best-effort, and reported rather than silent: an
      // undeletable scratch index is a real operational condition.
      try {
        await this.#filesystem.removePath(scratchIndexPath);
      } catch (reason: unknown) {
        this.#emit({
          kind: "scratch-index-cleanup-failed",
          runId: input.runId,
          epoch: input.epoch,
          turnOrdinal: input.turnOrdinal,
          scratchIndexPath,
          detail: describeRejection(reason),
        });
      }
    }
  }

  // ------------------------------------------------------------------------
  // Internals — capture legs
  // ------------------------------------------------------------------------

  /**
   * `<base>` — resolved ONCE, used for both the tree base and the recorded
   * parent (see {@link TurnSnapshotService.captureTurnSnapshot}).
   *
   * `--verify` tightens `Spec-010`'s `git rev-parse HEAD` without changing the
   * question: it demands a single revision and prints nothing on a miss, where
   * the bare form echoes its own argument (`HEAD`) to stdout with a non-zero
   * exit. The exit status is what this module reads either way; the flag plus
   * the {@link OBJECT_ID_PATTERN} check make an echoed argument unable to reach
   * a later argv even if a future git changed that.
   *
   * An unborn `HEAD` — an execution root with no commits — lands here as a
   * `resolve-base` failure, which is the honest answer: there is no parent to
   * record, so there is no snapshot to restore against.
   */
  async #resolveBaseCommit(executionRoot: string): Promise<string> {
    const result = await this.#runGit(["-C", executionRoot, "rev-parse", "--verify", "HEAD"], {});
    return this.#requireObjectId(result.stdout);
  }

  /**
   * Whether `executionRoot` is a SPARSE root — the closure's whole detection
   * predicate (I-010-24).
   *
   * THE CONFIG BIT ALONE. `core.sparseCheckout` is what git itself consults
   * before applying skip-worktree semantics, and the rules file deliberately does
   * not join the predicate. A "bit set AND the rules parse" test reads as the
   * more careful one and is the dangerous one: with the bit set and the rules
   * file deleted, git leaves every out-of-cone path materialized on disk and
   * porcelain `add -A` still records it (measured on git 2.50.1), so classifying
   * that root as non-sparse would run the `read-tree <base>` seed and drop
   * exactly the content porcelain keeps — silently, and only in a repository that
   * is already in a broken state. Under this predicate the same root reaches the
   * sparse arm, the matcher below fails on it (`fatal: unable to load existing
   * sparse-checkout patterns`, exit 128 — measured, including for an EMPTY
   * candidate set), and the capture reports a typed `check-sparse-rules` failure.
   * Fail-closed, and a capture that did not happen is what
   * `Spec-010 §Turn-Boundary Snapshots` makes safe by never blocking the turn.
   *
   * ROOT-KEYED AND MODE-AGNOSTIC. Nothing here consults `input.mode`, because
   * sparseness is a property of the checkout and not of how the daemon came to be
   * pointed at it: a `worktree`-mode root INHERITS its main checkout's sparse
   * configuration (`worktree add` copies the sparse state), while an ephemeral
   * clone starts full. Reading the root is what makes both answers correct
   * without this module holding a table of which modes can be sparse.
   *
   * `--type=bool --default=false` rather than exit-code interpretation. This
   * module's git seam reports failure BY EXIT STATUS ONLY and rejections are
   * opaque to it (see {@link TurnSnapshotGitRunner}), so a bare `--get` — which
   * exits 1 for an unset key and 128 for an unreadable config — would make "not
   * sparse" and "could not read this repository's config" the same observation.
   * With a default supplied, an unset key is a clean `false` at exit 0 and a
   * genuine read failure is the only rejection left, which is what lets it be
   * reported as a typed `detect-sparse-root` failure instead of being mistaken
   * for a non-sparse root.
   */
  async #detectSparseRoot(executionRoot: string): Promise<boolean> {
    const result = await this.#runGit(
      [
        "-C",
        executionRoot,
        "config",
        "--type=bool",
        "--default=false",
        "--get",
        CORE_SPARSE_CHECKOUT_KEY,
      ],
      {},
    );
    return result.stdout.toString("utf8").trim() === "true";
  }

  /**
   * Seed the scratch index as a COPY OF THE LIVE INDEX, taken under git's own
   * lockfile protocol.
   *
   * The copy is the closure (see the call site); the LOCK is what makes it
   * trustworthy. A git index write is lock-write-rename, so a copy taken without
   * the lock can read a file being replaced underneath it — an index that is
   * torn, or simply gone between `stat` and `open`. Taking git's own lock is the
   * only serialization available, because it is the one every other git process
   * in the repository already respects; a lock of this module's own invention
   * would exclude nothing.
   *
   * The protocol, honoured exactly: create `<index>.lock` EXCLUSIVELY, do the
   * work, then release WITHOUT writing. `wx` is the create — an existing lock
   * makes it `EEXIST`, which is the contention signal rather than an error to
   * work around, and this leg never removes a lock it did not create. Releasing
   * by unlinking the lock and leaving the index alone is git's "rollback": the
   * rename that would have replaced the index never happens, so a reader that
   * observes this whole sequence sees no change at all.
   *
   * The index path comes from `rev-parse --git-path index`, never from
   * `<root>/.git/index`. A LINKED WORKTREE keeps its index under
   * `<main>/.git/worktrees/<id>/index`, so the naive spelling would lock and copy
   * the MAIN checkout's index — a different worktree's staged state recorded as
   * this one's snapshot, and a lock taken against a repository nobody is
   * contending for. git answers the question for both layouts, and it answers
   * RELATIVELY for a main checkout (`.git/index`) and ABSOLUTELY for a linked one
   * (measured on git 2.50.1), which is why the result is resolved against the
   * execution root rather than used as given.
   *
   * Contention gets a brief fixed retry and then becomes a typed `seed-index`
   * failure through the ordinary envelope — see
   * {@link SPARSE_SEED_INDEX_LOCK_ATTEMPTS} for why the budget is small.
   */
  async #seedScratchIndexFromLiveIndex(
    executionRoot: string,
    scratchIndexPath: string,
  ): Promise<void> {
    const reportedIndexPath: string = (
      await this.#runGit(["-C", executionRoot, "rev-parse", "--git-path", "index"], {})
    ).stdout
      .toString("utf8")
      .trim();
    if (reportedIndexPath === "") {
      throw new Error("git did not report an index path for the execution root");
    }
    const liveIndexPath: string = isAbsolute(reportedIndexPath)
      ? reportedIndexPath
      : join(executionRoot, reportedIndexPath);
    const lockPath = `${liveIndexPath}.lock`;

    let lockHandle: FileHandle | null = null;
    for (let attempt = 0; attempt < SPARSE_SEED_INDEX_LOCK_ATTEMPTS; attempt += 1) {
      try {
        lockHandle = await open(lockPath, "wx");
        break;
      } catch (reason: unknown) {
        // Only `EEXIST` is contention. An `EACCES` or a vanished git directory is
        // a fault this leg has no retry for, and grinding through the budget
        // before reporting it would delay the turn boundary for nothing.
        if ((reason as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
          throw reason;
        }
        if (attempt === SPARSE_SEED_INDEX_LOCK_ATTEMPTS - 1) {
          throw new Error(
            "turn-snapshot could not acquire the repository index lock to seed the scratch index",
            { cause: reason },
          );
        }
        await delay(SPARSE_SEED_INDEX_LOCK_RETRY_DELAY_MS);
      }
    }
    if (lockHandle === null) {
      throw new Error("turn-snapshot could not acquire the repository index lock");
    }
    try {
      await copyFile(liveIndexPath, scratchIndexPath);
    } finally {
      // Release, never commit: close the handle and unlink the lock, leaving the
      // real index exactly as it was found. In its own `try` so a failed close
      // cannot strand the lock, which would block every subsequent git command in
      // the user's repository — a far worse outcome than a failed capture.
      try {
        await lockHandle.close();
      } finally {
        await rm(lockPath, { force: true });
      }
    }
  }

  /**
   * Score CANDIDATES against this root's live sparsity rules, returning the keys
   * of the ones git considers IN CONE.
   *
   * THE ORACLE, SPELLED ONCE. Both sparse legs call it — the capture partition
   * and the restore's discarded-subset derivation — and their answers are
   * load-bearing against each other: capture decides what a snapshot OMITS and
   * restore decides what it may DISCARD, which is one question asked twice and
   * has to be asked of the same matcher. Two spellings that drifted (a
   * `--rules-file` on one side and a live read on the other) would put the legs
   * on different definitions of the cone with every test still green, so the argv
   * is single-sourced exactly as {@link EXCLUDE_PER_DIRECTORY_GITIGNORE} and
   * {@link USE_REPLACE_REFS_PIN} are.
   *
   * `sparse-checkout check-rules -z` in its LIVE-RULES form: no `--rules-file`,
   * so the rules are the ones git would apply to this root right now, cone-ness
   * and negation semantics included. Reimplementing that test is the mistake this
   * method exists to avoid, and the near miss is instructive — the module already
   * runs gitignore machinery (`--exclude-per-directory`) and it answers a
   * DIFFERENT question. Measured on git 2.50.1 with `/*` plus `!/a/b/`, the
   * ignore machinery scores `a/b/deep.txt` includable while the cone does not, so
   * a listing partitioned by exclude rules would stage out-of-cone content and
   * lose the property this closure is for.
   *
   * FAIL-CLOSED, never a degrade. Every rejection — an unreadable rules file, a
   * git too old to know the subcommand — propagates to the caller's step funnel,
   * because the only alternative is to proceed on an unpartitioned answer. INVOKED
   * UNCONDITIONALLY for the same reason, EMPTY candidate set included: a sparse
   * root whose rules vanished must fail rather than trivially succeed at
   * partitioning nothing. NO caller guards on candidate emptiness — the
   * obstruction guard scores an empty conflict set rather than skipping the
   * spawn — and making that one place a reader can check is half of why this is
   * extracted.
   *
   * KEYS, not paths: the far-side membership test must run {@link
   * listingEntryKey} over the same bytes. Measured — `check-rules -z` echoes input
   * bytes VERBATIM, unaffected by `core.quotePath`, emitting the in-cone subset —
   * so keying on the echo is a byte-exact identity rather than a decode.
   *
   * CANDIDATE PROVENANCE IS THE CALLER'S, and the three callers split two ways —
   * TWO byte-exact, ONE decode-to-decode:
   *
   *   * The capture partition supplies the original listing's own Buffer slices,
   *     so no path in that leg is ever reconstructed from a decode.
   *   * The obstruction guard supplies `Buffer.from(<tree pathKey>, "latin1")`,
   *     which restores the tree listing's ORIGINAL bytes rather than re-encoding a
   *     decode. It sits on this side because its answer gates a REFUSAL against a
   *     byte-keyed boundary set, and a decode there could score the wrong path's
   *     materialization.
   *   * The discarded-subset diagnostic supplies `Buffer.from(<decoded tree
   *     path>, "utf8")`, where byte-exactness is unattainable AND unneeded: both
   *     sides of that comparison are decoded strings out of one `ls-tree`, so the
   *     round trip is decode-to-decode and cannot introduce a mismatch the tree
   *     listing did not already carry — and its output is a diagnostic, not an
   *     authority over anything on disk.
   *
   * This is a CLOSED list; a fourth caller has to state which side of it it lands
   * on.
   */
  async #scoreInConeKeys(
    executionRoot: string,
    candidates: readonly Buffer[],
  ): Promise<ReadonlySet<string>> {
    const matcherOutput: Buffer = (
      await this.#runGit(["-C", executionRoot, "sparse-checkout", "check-rules", "-z"], {
        stdin: joinNulTerminatedListing(candidates),
      })
    ).stdout;
    return new Set<string>(splitNulTerminatedListingBytes(matcherOutput).map(listingEntryKey));
  }

  /**
   * Split a `-z` listing into the IN-CONE staging stream and the out-of-cone
   * paths, using git's own sparsity matcher.
   *
   * The matcher call is {@link #scoreInConeKeys}, which carries the live-rules
   * form, the fail-closed rule and the byte-exact echo this leg rests on. What is
   * local here is the CONSEQUENCE of a rejection: it surfaces as a
   * `check-sparse-rules` failure, and it may not degrade because the only
   * alternative is to stage the unpartitioned listing, which is the shipped defect
   * exactly.
   *
   * ALL BYTES, both directions AND both outputs. Candidates go in as the original
   * listing's own slices; the staging stream is rebuilt from those ORIGINAL slices
   * rather than from git's output; and the out-of-cone half is those same slices
   * handed on untouched. No path is reconstructed from a decode at any point, and
   * nothing here decodes at all — nor does anything downstream: the subtraction
   * runs on bytes and the trailer RECORDS the byte keys, so an out-of-cone path's
   * identity survives from this split to the restore that must not delete it. See
   * {@link splitNulTerminatedListingBytes} and {@link #deriveSparseBoundaryPaths}.
   *
   * The trailing slash is likewise carried through rather than stripped here: it
   * is the capture's only record of an entry git refused to descend, the restore
   * needs it to choose an exemption width, and stripping it at the earliest
   * possible moment is what made it unrecoverable. See
   * {@link SPARSE_BOUNDARY_PATHS_TRAILER}.
   *
   * Under `index.sparse=true` the `ls-files` legs make git print a sparse-index
   * expansion advisory on stderr. This module reads stderr on no leg, so the
   * advisory is structurally unable to become a failure; see the host-config
   * table's row.
   */
  async #partitionListingByCone(
    executionRoot: string,
    listing: Buffer,
  ): Promise<SparseListingPartition> {
    const entries: readonly Buffer[] = splitNulTerminatedListingBytes(listing);
    const inConeKeys: ReadonlySet<string> = await this.#scoreInConeKeys(executionRoot, entries);

    const inConeEntries: Buffer[] = [];
    const outOfConeEntries: Buffer[] = [];
    for (const entry of entries) {
      (inConeKeys.has(listingEntryKey(entry)) ? inConeEntries : outOfConeEntries).push(entry);
    }
    return { inConeListing: joinNulTerminatedListing(inConeEntries), outOfConeEntries };
  }

  /**
   * The boundary set: the out-of-cone paths the snapshot tree does NOT hold.
   *
   * Reads the written tree back with `ls-tree -r --name-only -z` and subtracts.
   * The read carries {@link USE_REPLACE_REFS_PIN} for the same reason the restore
   * legs' object reads do: this INTERPRETS an object id, and a replace ref on the
   * freshly written tree would hand back a different path set — which here would
   * silently widen or narrow the trailer, and the trailer is both an OID input to
   * the commit and the restore's authority over what it may delete.
   *
   * THE SUBTRACTION IS BYTE-EXACT, keyed through {@link listingEntryKey} on both
   * sides — the candidates' own listing slices against the tree listing's own
   * slices, never a decoded string against a decoded string. What a `utf8`-keyed
   * subtraction cost is specific and destructive: on a POSIX repository holding
   * two DISTINCT out-of-cone names with invalid UTF-8 byte sequences, both decode
   * to U+FFFD-bearing strings, so a tracked path could compare equal to an
   * unrelated untracked or intent-to-add boundary path and SUBTRACT it away. The
   * omitted path then reaches the restore unprotected: for an intent-to-add entry
   * the pre-drop skips it and `read-tree --reset -u` unlinks its only on-disk
   * copy. Keying on bytes makes the two paths distinct again, which is what the
   * capture partition's all-bytes discipline was for and what this leg used to
   * throw away one line before spending it.
   *
   * NOT DECODED AFTER THE SUBTRACTION EITHER — the survivors leave here as the
   * SAME {@link listingEntryKey} byte keys the subtraction ran on, and the trailer
   * records those. The trailer is JSON and JSON is text, but `latin1` makes those
   * two facts compatible: the key IS a string, one code point per path byte, and
   * it survives `JSON.stringify` → UTF-8 message → `JSON.parse` unchanged.
   *
   * Decoding here instead used to leave a stated residual, and this is what
   * closed it. A non-UTF-8 survivor was RECORDED as its U+FFFD-replaced spelling,
   * so two distinct un-decodable survivors collapsed into one trailer entry — and
   * worse, a survivor could collide with an unrelated TRACKED path once both were
   * decoded, which is the direction the restore's index pre-drop reads as "the
   * snapshot holds this, leave the index alone" and then lets `read-tree --reset
   * -u` unlink the boundary path's only on-disk copy. The aliasing was called
   * protective on the strength of the delete exemption alone; the pre-drop's
   * exclusion made it destructive. Byte keys end to end remove the collapse rather
   * than reasoning about which side of it is safe.
   */
  async #deriveSparseBoundaryPaths(
    executionRoot: string,
    treeObjectId: string,
    outOfConeEntries: readonly Buffer[],
  ): Promise<readonly string[]> {
    const treeListing: Buffer = (
      await this.#runGit(
        [
          "-C",
          executionRoot,
          ...USE_REPLACE_REFS_PIN,
          "ls-tree",
          "-r",
          "--name-only",
          "-z",
          treeObjectId,
        ],
        {},
      )
    ).stdout;
    const recordedKeys = new Set<string>(
      splitNulTerminatedListingBytes(treeListing).map(listingEntryKey),
    );
    return outOfConeEntries.map(listingEntryKey).filter((entryKey) => !recordedKeys.has(entryKey));
  }

  /**
   * The untracked-embedded-repo normalization pass.
   *
   * The trailing-slash entries in the listing are the directories `ls-files`
   * does not descend into — a non-ignored embedded git repository is the case
   * `Spec-010 §Turn-Boundary Snapshots` names, and `update-index --add` has
   * already silently dropped each of them.
   *
   * The classification is FAIL-SAFE rather than unborn-specific: any such entry
   * whose `rev-parse HEAD` does not yield an object id INSERTABLE IN THE
   * SUPERPROJECT'S OBJECT FORMAT is skipped and enumerated. That covers the
   * commitless embedded repository the spec calls out — porcelain `git add -A`
   * hard-fails on it, so capture skipping honours capture-never-blocks — any
   * other trailing-slash entry that is not a repository at all, and the MIXED
   * FORMAT case, where both repositories are healthy and their object formats
   * simply differ.
   *
   * That last one is why the skip test is a predicate and not a `try` around the
   * insert. Measured on git 2.50.1: a SHA-1 embedded `HEAD` offered to a
   * SHA-256 superproject (and the converse) makes `update-index --cacheinfo`
   * exit 129 — `error: option 'cacheinfo' expects <mode>,<sha1>,<path>` — which
   * unguarded fails the WHOLE capture at `normalize-embedded-repositories` and
   * leaves every later rollback with no snapshot to restore. Widening a `catch`
   * over the insert would swallow index-lock and I/O failures with it, turning
   * an infrastructure fault into a silent one-path skip; comparing formats up
   * front skips exactly the case that is genuinely un-insertable and leaves the
   * insert free to fail loudly for every other reason.
   *
   * `GIT_INDEX_FILE` is deliberately absent from both `rev-parse` overlays, for
   * two different reasons. The `HEAD` one runs INSIDE the embedded repository,
   * where pointing at the superproject's scratch index would be a category error
   * even though it is harmless. The `--show-object-format` one runs in the
   * superproject but reads a repository-format fact, not index state, so an
   * index overlay would suggest a dependency that is not there.
   */
  async #normalizeEmbeddedRepositories(
    executionRoot: string,
    scratchIndexPath: string,
    listing: Buffer,
  ): Promise<readonly string[]> {
    const skipped: string[] = [];
    let superprojectObjectIdLength: number | null = null;
    for (const entry of splitNulTerminatedListing(listing)) {
      if (!entry.endsWith("/")) {
        continue;
      }
      const embeddedPath: string = entry.slice(0, -1);
      let embeddedHead: string;
      try {
        embeddedHead = this.#requireObjectId(
          (
            await this.#runGit(
              ["-C", join(executionRoot, embeddedPath), "rev-parse", "--verify", "HEAD"],
              {},
            )
          ).stdout,
        );
      } catch {
        skipped.push(embeddedPath);
        continue;
      }
      // Resolved LAZILY and once: a listing with no trailing-slash entry is the
      // overwhelmingly common case and must not pay for a git invocation, and a
      // repository's object format cannot change under a single capture. This
      // call failing is INFRASTRUCTURE, not a classification — it propagates and
      // fails the capture, exactly like the insert below. Only a successfully
      // resolved format that DISAGREES is a skip.
      if (superprojectObjectIdLength === null) {
        superprojectObjectIdLength = requireObjectIdHexLength(
          (await this.#runGit(["-C", executionRoot, "rev-parse", "--show-object-format"], {}))
            .stdout,
        );
      }
      if (embeddedHead.length !== superprojectObjectIdLength) {
        skipped.push(embeddedPath);
        continue;
      }
      // `<mode>,<object>,<path>` is a direct index insert, and the gitlink mode is
      // git's superproject submodule representation — the same entry porcelain
      // staging writes. The object lives in the EMBEDDED repository's store and is
      // absent from the superproject's; git records the gitlink anyway (confirmed
      // on git 2.50.1), exactly as it does for a submodule whose objects were
      // never fetched.
      await this.#runGit(
        [
          "-C",
          executionRoot,
          "update-index",
          "--add",
          "--cacheinfo",
          `${GITLINK_TREE_MODE},${embeddedHead},${embeddedPath}`,
        ],
        { environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath } },
      );
    }
    return skipped;
  }

  /**
   * `commit-tree` under the encoding pin and the six-var host-independence env
   * set, so the snapshot OID is a function of project state and the turn-boundary
   * instant alone.
   *
   * `i18n.commitEncoding` pinned to UTF-8 — git's default — because a host that
   * set it to anything else writes an `encoding` header into the commit object,
   * changing the OID for identical project state. The six variables are the
   * author and committer name, email and DATE: the dates are commit-object
   * fields too, so ident env alone would still leak the host's wall-clock
   * timezone into every snapshot OID.
   *
   * `skippedEmbeddedRepositories` and `sparseBoundaryPaths` are the two pieces of
   * capture-time knowledge the restore cannot re-derive, and this is where both
   * are persisted — see {@link SKIPPED_EMBEDDED_REPOSITORIES_TRAILER} and
   * {@link SPARSE_BOUNDARY_PATHS_TRAILER} for what each protects and why a commit
   * message is the right carrier. The determinism contract survives them intact:
   * each trailer is a function of PROJECT STATE (which repositories are there and
   * unrecordable; which out-of-cone paths existed at the boundary), so two
   * captures of identical state still produce identical messages and identical
   * OIDs, and a NON-SPARSE capture that skipped nothing produces the exact bytes
   * it produced before either existed.
   *
   * THE MESSAGE TRANSPORT IS `-F -`, converted from `-m` argv by T6.1, and the
   * conversion is a correctness fix rather than a tidy-up. A message is an OID
   * input, and under `-m` its bytes were argv bytes — bounded by the platform's
   * argument limit (~32 KB on Windows, and it is the whole command line that is
   * bounded, not the one element). The sparse trailer is an enumeration of
   * worktree paths with no bound of its own, so a repository with enough
   * out-of-cone content would have turned a capture into a spawn failure whose
   * cause is invisible from every leg's argv. Streaming the message removes the
   * bound instead of raising it.
   *
   * The stream is byte-equivalent to the `-m` spellings it replaces, verified by
   * OID on git 2.50.1 for both the one- and two-paragraph forms, and the suite
   * pins that equivalence rather than leaving it to inspection. Two properties
   * carry it: git joins successive `-m` values with a BLANK LINE, which is what
   * `\n\n` between paragraphs reproduces, and git terminates the message it
   * builds from `-m` with a single newline, which is what the trailing `\n`
   * reproduces (an unterminated stream mints a DIFFERENT commit — measured, and
   * the precise reason this is spelled as a join-plus-terminate rather than a
   * join). `-F -` reads until EOF, and the seam closes the child's stdin on every
   * invocation, so the hang `Spec-010 §Turn-Boundary Snapshots` warns about is
   * closed by the seam's contract rather than by this call site's argv — see
   * {@link TurnSnapshotGitInvocationOptions.stdin}.
   */
  async #commitSnapshotTree(
    executionRoot: string,
    treeObjectId: string,
    baseCommit: string,
    skippedEmbeddedRepositories: readonly string[],
    sparseBoundaryPaths: readonly string[] | null,
  ): Promise<string> {
    const stampedDate: string | null = toRawGitDate(this.#now());
    if (stampedDate === null) {
      throw new Error("turn-snapshot clock did not return an ISO-8601 instant");
    }
    // Each trailer sorted for OID stability, and each present under its own
    // recorded rule: the skip list only when non-empty, the sparse set whenever
    // the root is sparse (`null` here means it is not). `JSON.stringify` of a
    // `string[]` is total — no throwing input exists — so no guard is owed here.
    //
    // ORDER IS FIXED, skipped before sparse, because trailer order is message
    // bytes and therefore OID bytes.
    //
    // The two lists are DIFFERENT KINDS OF STRING and both sorts are still total:
    // the skip list holds decoded paths, the sparse list holds `latin1` byte keys
    // ({@link SPARSE_BOUNDARY_PATHS_TRAILER}), so the second sort is a code-unit
    // sort over one-code-point-per-byte strings — byte order exactly, which is
    // the stronger form of the stability this sort exists for. Every code point a
    // key can hold survives `JSON.stringify` (control bytes escaped, U+0080–U+00FF
    // literal) and the UTF-8 encoding of the message declared just above.
    const paragraphs: string[] = [SNAPSHOT_COMMIT_MESSAGE];
    if (skippedEmbeddedRepositories.length > 0) {
      paragraphs.push(
        `${SKIPPED_EMBEDDED_REPOSITORIES_TRAILER} ${JSON.stringify(
          [...skippedEmbeddedRepositories].sort(),
        )}`,
      );
    }
    if (sparseBoundaryPaths !== null) {
      paragraphs.push(
        `${SPARSE_BOUNDARY_PATHS_TRAILER} ${JSON.stringify([...sparseBoundaryPaths].sort())}`,
      );
    }
    const result = await this.#runGit(
      [
        "-C",
        executionRoot,
        "-c",
        "i18n.commitEncoding=utf-8",
        "commit-tree",
        treeObjectId,
        "-p",
        baseCommit,
        "-F",
        "-",
      ],
      {
        environmentOverrides: {
          GIT_AUTHOR_NAME: SNAPSHOT_IDENTITY_NAME,
          GIT_AUTHOR_EMAIL: SNAPSHOT_IDENTITY_EMAIL,
          GIT_AUTHOR_DATE: stampedDate,
          GIT_COMMITTER_NAME: SNAPSHOT_IDENTITY_NAME,
          GIT_COMMITTER_EMAIL: SNAPSHOT_IDENTITY_EMAIL,
          GIT_COMMITTER_DATE: stampedDate,
        },
        // Blank-line joined, newline terminated. See the docblock: both halves
        // are what make this byte-equivalent to the `-m` form it replaces.
        stdin: Buffer.from(`${paragraphs.join("\n\n")}\n`, "utf8"),
      },
    );
    return this.#requireObjectId(result.stdout);
  }

  /**
   * The create-only ref write (I-010-22).
   *
   * Returns `null` when this call wrote the ref, or the RECORDED OID when the
   * CAS found one already there — the idempotent-success arm. Any other failure
   * (the ref does not resolve either) propagates to the funnel.
   *
   * See the header for why the existence probe runs only AFTER the CAS refuses,
   * and why it reads the ref rather than git's stderr.
   */
  async #writeCreateOnlyRef(
    executionRoot: string,
    ref: string,
    snapshotCommit: string,
  ): Promise<string | null> {
    try {
      // The trailing EMPTY old-value is the compare-and-swap against absence,
      // and `--no-deref` is what keeps that check on the name this service
      // VALIDATED. Without it git splits a symbolic-ref update into an update of
      // its referent and moves the must-not-exist check there — so the CAS stops
      // guarding the namespace the moment the name resolves elsewhere. Existing
      // referents were never the exposure (the check refuses on them either way);
      // a DANGLING one is: measured on git 2.50.1 and on git 2.54.0 alike,
      // planting
      // `symbolic-ref refs/sidekicks/runs/<id>/epoch-0/turn-<next> refs/heads/evil`
      // with no such branch makes the unflagged create write `refs/heads/evil` at
      // the snapshot commit and exit 0 — a daemon write outside the namespace,
      // reported as a successful capture. The turn path is guessable from inside
      // the run, which is what makes it plantable in advance.
      //
      // WITH the flag, measured on the same version: the write lands on the
      // validated in-namespace name (replacing the planted pointer with an
      // ordinary snapshot ref), `refs/heads/` is untouched, and the capture is a
      // truthful `captured` — the snapshot ref really does hold the snapshot
      // commit. That last sentence is version-scoped, and git 2.54.0 is where it
      // splits: there the same flagged create REFUSES over a dangling
      // in-namespace symref (refs-transaction hardening, lineage git 2.52's fix
      // for `fetch` clobbering dangling symrefs). The refusal lands in the `catch`
      // below, `#readRefIfPresent` finds nothing — a dangling symref does not
      // resolve for `show-ref --verify` — and the rethrow becomes the typed
      // `failed` at `write-ref`: fail-closed, diagnosed, and the turn proceeds,
      // which is this leg's posture for any capture that cannot be written. The
      // flag is load-bearing on BOTH versions and for one reason — it is what
      // keeps 2.50.1's success inside the namespace and keeps 2.54.0's refusal a
      // refusal rather than the branch-minting success above. I-010-21 holds
      // either way; only the outcome tag differs. A LIVE referent still refuses on
      // both versions, "reference already exists", and `#readRefIfPresent` below
      // resolves through it to whatever oid that name holds on disk. When the ref
      // genuinely predates this call — the ordinary case — that IS the
      // pre-existing already-captured reading, unchanged. It is not a claim the
      // oid is one this service wrote: an actor with repository write access can
      // plant or repoint an in-namespace ref by ordinary means, and this read
      // reports what it finds (see the header's boundary paragraph). What holds
      // regardless is the part this leg is responsible for — the refusal stays a
      // refusal, and nothing outside the namespace is written. For a direct ref
      // — every ref this service writes — the flag is a measured no-op, and the
      // per-epoch idempotence refusal (I-010-22) is preserved.
      await this.#runGit(
        ["-C", executionRoot, "update-ref", "--no-deref", ref, snapshotCommit, ""],
        {},
      );
      return null;
    } catch (reason: unknown) {
      const recorded: string | null = await this.#readRefIfPresent(executionRoot, ref);
      if (recorded !== null) {
        return recorded;
      }
      throw reason instanceof Error ? reason : new Error(describeRejection(reason));
    }
  }

  /**
   * The OID `revision` names, or `null` when it does not resolve.
   *
   * The restore leg's read primitive: `HEAD`, `<commit>^` and an embedded
   * repository's `HEAD` all arrive here. `null` rather than a throw because every
   * caller has a named arm for "could not be read", and a throw would turn a
   * fail-closed refusal into an exception the two public methods promise not to
   * raise. There are three such arms, one per caller class: `head_moved` with a
   * `null` side (the resolve and the two pre-mutation checks), `partial_restore`
   * at `close-index` (the post-mutation check, where no refusal is free any more),
   * and a gitlink counted as divergent (the enumeration probes).
   *
   * `--verify` for the reason {@link TurnSnapshotService.captureTurnSnapshot}'s
   * base resolution takes it: the bare form echoes its own argument on a miss,
   * and {@link OBJECT_ID_PATTERN} then has to be the only thing standing between
   * an echo and a later argv.
   *
   * `configPins` exists because the callers split on the round-4 predicate and
   * the split is not visible from in here: reading `HEAD` RESOLVES a ref, while
   * reading `<commit>^` INTERPRETS an object, and only the second can be
   * redirected by a replace ref (measured both ways). Defaulting to none keeps
   * every ref-resolving caller unpinned and makes the one pinned call site state
   * its own reason, rather than this helper quietly pinning reads whose
   * disposition the host-config table records as unpinned.
   */
  async #readRevisionIfPresent(
    gitDirectory: string,
    revision: string,
    configPins: readonly string[] = [],
  ): Promise<string | null> {
    try {
      const result = await this.#runGit(
        ["-C", gitDirectory, ...configPins, "rev-parse", "--verify", revision],
        {},
      );
      return this.#requireObjectId(result.stdout);
    } catch {
      return null;
    }
  }

  /**
   * Whether the execution root answers git at all.
   *
   * `rev-parse --git-dir` is the cheapest question with a repository-shaped
   * answer: it reads no ref, walks no tree, and fails for exactly the conditions
   * that make a ref probe uninformative — a vanished root, a directory that is
   * not a repository, an unreadable one, or no git binary. Used ONLY to
   * interpret a ref probe that already failed (see
   * {@link TurnSnapshotService.resolveRestoreTarget}), so the ordinary resolve
   * spawns nothing extra.
   */
  async #isRepositoryAskable(executionRoot: string): Promise<boolean> {
    try {
      await this.#runGit(["-C", executionRoot, "rev-parse", "--git-dir"], {});
      return true;
    } catch {
      return false;
    }
  }

  /** The recorded OID, or `null` when the ref does not resolve. */
  async #readRefIfPresent(executionRoot: string, ref: string): Promise<string | null> {
    try {
      // `--verify` against a FULLY-QUALIFIED ref path: no abbreviation, no
      // search path, no echo of the argument on a miss.
      const result = await this.#runGit(
        ["-C", executionRoot, "show-ref", "--verify", "--hash", ref],
        {},
      );
      return this.#requireObjectId(result.stdout);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------
  // Restore (T5.2)
  // ------------------------------------------------------------------------

  /**
   * Resolve which snapshot a rollback to `targetPosition` would restore, and
   * whether it MAY be restored — without touching anything (I-010-23).
   *
   * `Spec-004 §Required Behavior` runs this before the conversation leg moves,
   * because a refusal rejects the whole rollback intervention with no leg
   * applied. Every command it spawns is a read (`show-ref`, `rev-parse`), so the
   * execution root's worktree, index and refs are byte-identical afterwards on
   * every arm — refused and accepted alike. (The daemon's own
   * hook-neutralization directory is created, as it is for every invocation in
   * this module; that is daemon-local, outside the execution root, and is what
   * makes the reads hook-free.)
   *
   * NEVER THROWS: each of the three reads has a named landing arm.
   *
   *   * the ref itself — absent is `no_snapshot`/`ref-absent`, and UNREADABLE is
   *     `no_snapshot`/`probe-failed`, below;
   *   * the recorded first parent (`<commit>^`) — unreadable is `head_moved`
   *     with `expectedHead: null`;
   *   * the current `HEAD` — unreadable is `head_moved` with
   *     `observedHead: null`.
   *
   * The last two are the fail-closed posture stated as code: the precondition
   * must be ESTABLISHED, so an unanswerable question refuses exactly as a
   * mismatch does.
   *
   * The first splits because the two conditions are not the same fact and the
   * caller's operator needs them apart. A `show-ref` that fails says nothing
   * about WHY: an absent ref (exit 1 — the spec's capture-gap case) and an
   * unaskable repository (a vanished execution root, an `EACCES`, no git binary)
   * arrive identically. So a failed ref probe is followed by a bare
   * `rev-parse --git-dir` against the same root: if THAT answers, the repository
   * was askable and the ref is genuinely absent; if it does not, the honest
   * report is `probe-failed` plus a diagnostic, because "no snapshot" for a
   * question nobody could put is the daemon's quietest possible failure. The
   * second probe reads only an exit status, so it holds for any runner rather
   * than only for the `execFile` default (the seam reads no field off a
   * rejection anywhere in this module). Its RESIDUAL, recorded rather than
   * closed: a failure isolated to the one ref — a permission bit on a single
   * loose ref file — still reports `ref-absent`, because the repository does
   * answer.
   *
   * A second RESIDUAL, from the header's symref BOUNDARY paragraph: the accepted
   * arm reports the OID the snapshot ref names AT RESOLVE TIME. It attests that
   * the fail-closed preconditions held against that OID, not that the ref store
   * was unmodified by a co-resident writer — an actor with repository write
   * access can repoint an in-namespace ref by ordinary means, and this leg reads
   * what it finds. Freezing the OID into the minted target is what confines that
   * exposure to the resolve: {@link TurnSnapshotService.restoreToTurn} applies the
   * OID checked HERE, so a later repoint cannot redirect the checkout.
   */
  async resolveRestoreTarget(input: ResolveRestoreTargetInput): Promise<TurnSnapshotResolution> {
    if (
      !isSafeRefComponent(input.runId) ||
      !isNonNegativeInteger(input.targetPosition) ||
      !isUsableEpochLineage(input.epochLineage)
    ) {
      return { outcome: "no_snapshot", ref: null, owningEpoch: null, reason: "unusable-inputs" };
    }

    const owningEpoch: number | null = selectOwningEpoch(input.epochLineage, input.targetPosition);
    if (owningEpoch === null) {
      return { outcome: "no_snapshot", ref: null, owningEpoch: null, reason: "no-owning-epoch" };
    }

    // The ONE ref this walk will look at. No second lookup exists in this
    // method, which is how "never a fallthrough to a superseded parent epoch's
    // same-ordinal ref" is discharged — structurally, not by a policy check.
    const ref: string = buildTurnSnapshotRef(input.runId, owningEpoch, input.targetPosition);
    const snapshotCommit: string | null = await this.#readRefIfPresent(input.executionRoot, ref);
    if (snapshotCommit === null) {
      if (!(await this.#isRepositoryAskable(input.executionRoot))) {
        this.#emit({
          kind: "restore-probe-failed",
          runId: input.runId,
          epoch: owningEpoch,
          turnOrdinal: input.targetPosition,
          ref,
          detail: "the execution root did not answer `rev-parse --git-dir`",
        });
        return { outcome: "no_snapshot", ref, owningEpoch, reason: "probe-failed" };
      }
      return { outcome: "no_snapshot", ref, owningEpoch, reason: "ref-absent" };
    }

    // `<commit>^` rather than `<ref>^`: the ref is create-only, so the two agree,
    // and asking the OID keeps the question independent of the ref one more time.
    //
    // PINNED, and this is the guard's own integrity rather than the checkout's: a
    // replace ref on the snapshot commit answers `^` with the REPLACEMENT's
    // parent (measured — an attacker commit with a different parent returns that
    // parent here), and this value is the left-hand side of every `head_moved`
    // comparison below. Unpinned, an attacker chooses both what the guard
    // compares and what the checkout writes.
    const expectedHead: string | null = await this.#readRevisionIfPresent(
      input.executionRoot,
      `${snapshotCommit}^`,
      USE_REPLACE_REFS_PIN,
    );
    const observedHead: string | null = await this.#readRevisionIfPresent(
      input.executionRoot,
      "HEAD",
    );
    if (expectedHead === null || observedHead === null || expectedHead !== observedHead) {
      return { outcome: "head_moved", ref, owningEpoch, expectedHead, observedHead };
    }

    // The ONE mint. See {@link TurnSnapshotRestoreTarget}: the applier accepts
    // nothing this line did not produce.
    return mintRestoreTarget({
      executionRoot: input.executionRoot,
      runId: input.runId,
      targetPosition: input.targetPosition,
      owningEpoch,
      ref,
      snapshotCommit,
      expectedHead,
    });
  }

  /**
   * Apply a resolved snapshot to its execution root — the mutating half of
   * I-010-23.
   *
   * Takes the resolution ITSELF rather than a root plus a ref, so the applier
   * cannot be handed a pair that was never resolved together. Runs under the
   * caller's exclusive execution-root tenancy (`Spec-004 §Required Behavior`,
   * Plan-004 campaign B9); this module builds no tenancy machinery and instead
   * re-verifies the one thing that tenancy cannot promise about the window
   * BEFORE it opened — that `HEAD` is still the snapshot's recorded parent.
   *
   * NEVER THROWS for any target this service minted — and the exception proves
   * the rule rather than weakening it. A value that is not one is rejected by a
   * THROW: an `as` cast, a JS caller, or any of the constructor paths that survive
   * emit (see {@link TurnSnapshotRestoreTarget} and {@link mintedRestoreTargets}).
   * There are exactly three result arms and all three are wire-pinned statements
   * about a worktree, so reporting `head_moved` or `partial_restore` for a forged
   * input would tell Plan-004 something false about a tree this call never
   * touched, while adding a fourth arm would leave T3.13's mapping incomplete. A
   * caller that can reach the throw is one that bypassed the type system.
   *
   * The sequence, in the order `Spec-010 §Turn-Boundary Snapshots` pins:
   *
   *   1. `verify-head` — the TOCTOU re-verify. A moved (or unreadable) `HEAD`
   *      refuses with NO mutation.
   *   2. `derive-enumerations` — read-only listings that fix the PROSPECTIVE
   *      collision-overwrite and gitlink-divergence sets, plus the on-disk state
   *      a later failure is measured against. For a snapshot that RECORDED a
   *      sparse boundary set — whatever this root's own sparsity now is — the
   *      step's NAME also covers the boundary-path pre-drop, which fires on
   *      recorded-set membership in any root and is not a listing: it is
   *      enumerated with the rest here and applied after the window read below,
   *      so it is the first mutation in the sequence rather than part of the
   *      read-only block. See {@link #dropBoundaryPathsFromLiveIndex}.
   *   3. `read-tree` — the destructive checkout, which `Spec-010 §Turn-Boundary
   *      Snapshots` spells `read-tree --reset -u <ref>` and this issues against
   *      the resolved OID (see the site), under the checkout-conversion
   *      pins, which extend the capture leg's host-config-independence class to
   *      the smudge path: a host `*.txt eol=crlf` would otherwise restore
   *      different bytes than were captured. In-tree `.gitattributes` stays
   *      honoured, so attribute-affected paths restore to git-canonical worktree
   *      form — identical to any porcelain checkout of the project.
   *   4. `delete-untracked` — the post-snapshot untracked sweep, repeated to a
   *      fixpoint.
   *   5. `close-index` — the index-only reset the spec spells `read-tree --reset
   *      HEAD`, issued against the just-verified OID rather than the name — as
   *      step 3 is, and for the same reason: both spec spellings are MUTABLE
   *      names read by an earlier check, so naming them again would be a
   *      check-then-act (see either site).
   *
   * Steps 4 and 5 are ordered, not merely sequenced: the delete pass is safe
   * only while the index still holds the SNAPSHOT tree, which is what makes
   * every captured file index-tracked and therefore not a deletion candidate.
   *
   * Step 2 carries THREE pre-mutation refusals, all typed, all landing at
   * `derive-enumerations` with nothing written: an undecodable trailer, a sparse
   * root whose snapshot predates the boundary closure, and a recorded boundary
   * path the checkout would destroy ({@link #deriveBoundaryObstructions}). They
   * are grouped there for one reason — a refusal that costs nothing on disk is
   * only available BEFORE step 3, so every question whose wrong answer is
   * destructive has to be asked while the derivation is still read-only.
   *
   * `HEAD` is read THREE times, and the two extra reads are the reason step 1's
   * name is not the whole story. The caller's exclusive tenancy covers the
   * intervention, but nothing stops a user terminal in the same execution root
   * from committing, and the two windows that opens have different answers:
   *
   *   * BETWEEN the derivation and `read-tree` — still pre-mutation, so the
   *     answer is the same `head_moved` refusal step 1 gives, with nothing
   *     applied. Without this read the derivation's own listings (an `ls-tree`
   *     and an `ls-files`) are the window, and it is wide enough to lose. "With
   *     nothing applied" is what orders the boundary pre-drop AFTER this read
   *     rather than at the derivation's tail: it is a mutation, and putting it on
   *     the far side would make this arm report a refusal it had already acted
   *     on.
   *   * BETWEEN `read-tree` and `close-index` — the worktree already holds
   *     snapshot content, so the honest answer is `partial_restore` at
   *     `close-index`. Closing the index against the MOVED `HEAD` instead is the
   *     precise incoherence step 5 exists to prevent (confirmed on git 2.50.1):
   *     the newer commit stays in branch history while its files are anti-diffed
   *     into the worktree as ordinary UNSTAGED modifications — fabricated edit
   *     intent, indistinguishable from a human undoing that commit by hand, and
   *     reported as `restored`. Closing it against the stale `expectedHead` and
   *     reporting `restored` anyway is better in the worktree and still wrong in
   *     the arm: it claims a rollback completed against a precondition that had
   *     already failed. Refusing leaves the index at the snapshot tree, which
   *     `git status` shows as loudly staged: a visibly half-applied rollback
   *     rather than a plausible lie. A `HEAD` that cannot be READ here refuses
   *     the same way and through the same arm, but it is a different situation —
   *     an environmental fault rather than a changed precondition, so a fresh
   *     rollback may simply work — which is why the two carry different
   *     diagnostic details.
   *
   * That third read is a check, not a lock, and the two are not the same thing:
   * a commit landing between it and the spawn it guards is undetectable from
   * here. Step 5's argv is spelled with the OID for exactly that residue — see
   * the site — which decides what the undetectable case LOOKS like, not whether
   * it can happen.
   */
  async restoreToTurn(target: TurnSnapshotRestoreTarget): Promise<TurnSnapshotRestoreResult> {
    if (!TurnSnapshotRestoreTarget.isMinted(target)) {
      throw new TypeError("turn-snapshot restore target was not minted by resolveRestoreTarget");
    }

    // The cursor the failure reporter names, advanced immediately before each
    // leg — the capture funnel's discipline, for the same reason: a leg added
    // later inherits the reporting instead of needing its own `catch`.
    let step: TurnSnapshotRestoreStep = "verify-head";
    // Empty until the derivation runs, so a failure before it reports both
    // enumerations empty — which is the truth: nothing had been mutated.
    let prospectiveEffects: ProspectiveRestoreEffects = NO_PROSPECTIVE_RESTORE_EFFECTS;

    try {
      const observedHead: string | null = await this.#readRevisionIfPresent(
        target.executionRoot,
        "HEAD",
      );
      if (observedHead !== target.expectedHead) {
        return {
          outcome: "head_moved",
          ref: target.ref,
          expectedHead: target.expectedHead,
          observedHead,
        };
      }

      step = "derive-enumerations";
      prospectiveEffects = await this.#deriveProspectiveRestoreEffects(target);

      // Window one, closed. Still pre-mutation, so this refuses exactly as the
      // first read does; the cursor is deliberately left where it is, since the
      // `head_moved` arm names no step.
      const headBeforeCheckout: string | null = await this.#readRevisionIfPresent(
        target.executionRoot,
        "HEAD",
      );
      if (headBeforeCheckout !== target.expectedHead) {
        return {
          outcome: "head_moved",
          ref: target.ref,
          expectedHead: target.expectedHead,
          observedHead: headBeforeCheckout,
        };
      }

      // The boundary pre-drop — the sequence's FIRST mutation, and therefore
      // placed on this side of the read above rather than inside the derivation
      // that enumerated it. The cursor stays `derive-enumerations` deliberately:
      // the step vocabulary is frozen at five members, and this belongs to the
      // enumeration leg by contract even though it runs after the window closes.
      // Empty — and so a no-op — whenever the snapshot recorded no boundary set,
      // which is every snapshot a non-sparse capture ever produced.
      await this.#dropBoundaryPathsFromLiveIndex(
        target.executionRoot,
        prospectiveEffects.droppableBoundaryIndexEntries,
      );

      step = "read-tree";
      await this.#runGit(
        [
          "-C",
          target.executionRoot,
          "-c",
          "core.autocrlf=false",
          // `core.eol` decides the line ending the SMUDGE path writes for a path
          // the attributes declare `text`, and the pin above is what hands it that
          // decision: measured on git 2.50.1 against an in-tree `*.txt text`, a
          // host `core.autocrlf=true` produces CRLF whatever `core.eol` says,
          // while under the `false` pin the restored bytes follow `core.eol`
          // exactly — host `crlf` writes CRLF, `lf` writes LF. So without this
          // second pin the previous line does not close the checkout channel; it
          // merely moves the host's control of it one knob along.
          //
          // `lf` and not `native`, which is the same measurement's other half:
          // `native` resolved to LF here only because the measuring host is a LF
          // host, so it would restore CRLF on Windows for bytes captured as LF.
          // The snapshot's blobs are git-canonical, and this is the value that
          // spells them back byte-identically on every host.
          "-c",
          "core.eol=lf",
          "-c",
          "submodule.recurse=false",
          "-c",
          "core.attributesFile=/dev/null",
          // Without this, the verified OID below is not the tree that gets
          // written: a `refs/replace/<snapshotCommit>` entry substitutes an
          // attacker's commit transparently, and one built with the SAME parent
          // passes every HEAD guard above (measured on git 2.50.1 — the unpinned
          // leg writes the attacker's bytes at exit 0 and the restore reports
          // success). Freezing the id is necessary and not sufficient; this is
          // the other half.
          ...USE_REPLACE_REFS_PIN,
          "read-tree",
          "--reset",
          "-u",
          // The verified OID, not the name — the same check-then-act reasoning
          // the closing reset below documents, applied to the destructive leg.
          // `resolveRestoreTarget` read the ref once and froze what it resolved
          // to; re-naming the ref here would let git re-resolve a MUTABLE name
          // across a window that already spans two `HEAD` re-verifies and the
          // derivation's own spawns. A commit is a valid tree-ish, so outside
          // that window the two spellings are the same command; `Spec-010
          // §Turn-Boundary Snapshots` spells the leg with the ref, and this is
          // that value resolved one step earlier — the very OID step 2 above
          // enumerated against, so what is written and what was enumerated can
          // no longer disagree.
          //
          // It also decouples the leg from the ref's LIFETIME. A ref deleted
          // between the resolve and here (the T5.3 retention prune is the only
          // thing that deletes one) no longer starves the checkout: the commit
          // object outlives its last name until `gc`, so the resolved snapshot
          // still applies instead of reporting `partial_restore` at `read-tree`
          // for a retention-bookkeeping event that changed no tree.
          target.snapshotCommit,
        ],
        { environmentOverrides: { GIT_ATTR_NOSYSTEM: "1" } },
      );

      step = "delete-untracked";
      await this.#deleteUntrackedToFixpoint(
        target.executionRoot,
        prospectiveEffects.preservedEmbeddedRepositories,
        prospectiveEffects.sparseBoundarySet,
      );

      // Emitted HERE rather than at the derivation, because this is the point at
      // which the protection was actually exercised: a restore that refused at
      // window one deleted nothing, and reporting "preserved" for a pass that
      // never ran would be a claim about work that did not happen.
      if (prospectiveEffects.preservedEmbeddedRepositories.length > 0) {
        this.#emit({
          kind: "embedded-repositories-preserved",
          runId: target.runId,
          epoch: target.owningEpoch,
          turnOrdinal: target.targetPosition,
          ref: target.ref,
          preservedPaths: prospectiveEffects.preservedEmbeddedRepositories,
        });
      }

      step = "close-index";
      // Window two. Past this point the worktree already holds snapshot content,
      // so a moved `HEAD` is no longer refusable with "nothing applied" — it is
      // a partial restore, and these are the two `close-index` failures that are
      // not git failures. See the method docblock for why REFUSING here beats
      // closing the index anyway, either against the moved `HEAD` or against the
      // stale `expectedHead`.
      const headBeforeClose: string | null = await this.#readRevisionIfPresent(
        target.executionRoot,
        "HEAD",
      );
      if (headBeforeClose !== target.expectedHead) {
        return this.#failRestore(
          target,
          "close-index",
          // Two causes, distinguished because their RECOVERY properties are
          // opposite and this string is the operator's only channel: a moved
          // `HEAD` is terminal for this target (the fresh rollback has to resolve
          // against the new history), while an unreadable one is an environmental
          // fault that may well retry clean against the same target.
          headBeforeClose === null
            ? "HEAD could not be read before the closing index reset"
            : "HEAD moved between the checkout and the closing index reset",
          prospectiveEffects,
        );
      }

      // Index-only — no `-u`. The leg above left the REAL index at the snapshot
      // tree, so every captured-untracked file would otherwise surface as a
      // staged addition against `HEAD`; this returns them to untracked status
      // and tracked edits to ordinary unstaged modifications, worktree bytes
      // untouched. No conversion pins: nothing is written to the working tree.
      //
      // Reset to the OID, not to the name `HEAD`: the comparison above is a
      // check-then-act on a MUTABLE name, and the gap between it and this spawn
      // is real work (a directory create and a process launch). Letting git
      // re-resolve `HEAD` inside that gap is what would close the index against a
      // commit nobody verified. The OID is not a different value — it IS the
      // `HEAD` just read, so outside the race the two spellings are the same
      // command; `expectedHead` reached this object through
      // {@link OBJECT_ID_PATTERN}, so it is a validated object id and never
      // caller text. `Spec-010 §Turn-Boundary Snapshots` spells the leg
      // `read-tree --reset HEAD`; this is that value, resolved one step earlier.
      //
      // It does NOT close the race — nothing at this layer can, since the check
      // has already passed. It changes what the unclosable window produces: the
      // index lands on the verified commit's tree — loud in the worktree column,
      // and in the staged column whenever the intervening commit changed the
      // tree — instead of the newer commit's files anti-diffed into the worktree
      // as plausible hand edits. Either way the call still returns `restored`,
      // because it has no way to know: the improvement is in what an operator
      // then sees, not in the arm.
      await this.#runGit(
        ["-C", target.executionRoot, "read-tree", "--reset", target.expectedHead],
        {},
      );

      // LAST, after every leg that can still fail. Emitting it before
      // `close-index` — where it sat — meant a refusal at window two, or a throw
      // from the closing reset, routed to the failure reporter and emitted the
      // identical payload a second time: two diagnostics for one restore, and the
      // duplication itself leaked which arm was taken, which the arm's own
      // docblock forbids. `embedded-repositories-preserved` above is the
      // precedent for the other half of the rule — it lives only on the success
      // tail, because only the success tail proves its pass ran. Here the
      // failure tail DOES need its own emission (the checkout can succeed and a
      // later leg fail), so the fix is placement rather than exclusivity, and the
      // re-observation is what makes the two mutually exclusive in practice.
      //
      // The closing reset above is index-only, so re-observing after it sees the
      // same worktree the checkout left.
      await this.#emitMaterializedOutOfCone(target, prospectiveEffects);

      return {
        outcome: "restored",
        ref: target.ref,
        snapshotCommit: target.snapshotCommit,
        // The completed `read-tree --reset -u` re-materialized every
        // snapshot-tracked path, so the prospective set IS the applied set here.
        // Reported verbatim rather than re-observed, so a colliding file whose
        // ignored content happened to be byte-identical to the snapshot's is
        // still enumerated: the enumeration is of paths the restore overwrote,
        // not of paths whose bytes visibly changed.
        overwrittenIgnoredPaths: prospectiveEffects.collisions.map((collision) => collision.path),
        divergentGitlinks: prospectiveEffects.gitlinkDivergences.map(
          (divergence) => divergence.path,
        ),
      };
    } catch (reason: unknown) {
      return this.#failRestore(target, step, describeRejection(reason), prospectiveEffects);
    }
  }

  // ------------------------------------------------------------------------
  // Internals — restore legs
  // ------------------------------------------------------------------------

  /**
   * The PROSPECTIVE enumerations, derived before anything is mutated.
   *
   * A collision is an ignored untracked path on disk (`ls-files -o -i` on the
   * same `--exclude-per-directory=.gitignore` pipeline as capture, so
   * project-declared rules only) that the `read-tree --reset -u` leg will
   * destroy. Equality with a snapshot-tracked path is only ONE of the three ways
   * that happens, because the checkout replaces a whole OBSTRUCTING file or
   * directory rather than merging around it. All three are measured on git
   * 2.50.1, and in each the checkout exits 0 while taking the ignored content
   * with it:
   *
   *   1. SAME PATH — the snapshot tracks a file at the ignored path, and writes
   *      over it.
   *   2. FILE OVER DIRECTORY — an ancestor of the ignored path is a
   *      snapshot-tracked FILE (snapshot has file `foo`; disk has ignored
   *      `foo/a`). The directory is removed whole and the file written in its
   *      place, so everything beneath it goes with it.
   *   3. DIRECTORY OVER FILE — the ignored path is an ancestor directory of some
   *      snapshot-tracked path (ignored file `foo`; snapshot tracks `foo/a`).
   *      The checkout needs a directory there, so the file is unlinked.
   *
   * Prefix obstruction is the same never-silent overwrite `Spec-010
   * §Turn-Boundary Snapshots` names as the exact-path case, so it is enumerated
   * the same way: in all three shapes the reported path — and the fingerprint
   * taken against it — is the IGNORED one, the content being destroyed, never
   * the snapshot path that displaced it. Ancestry is tested segment-wise (see
   * {@link collectProperAncestorDirectories}), so `foo` collides with `foo/a`
   * and never with `foobar/a`. What does NOT collide is a SIBLING: ignored
   * `foo/b` beside snapshot-tracked `foo/a` shares a directory the checkout
   * merely populates, and survives byte-identically.
   *
   * A TRAILING SLASH is git spelling a directory it will not descend into — an
   * ignored embedded repository — and it is enumerated under its slash-stripped
   * name, through shapes 1 and 2 only. Measured: such a directory is destroyed
   * whole, `.git` included, when the snapshot puts a file at or above its path,
   * and is merged into with its payload and `.git` intact when the snapshot only
   * holds paths BENEATH it. Shape 3 is a file-only obstruction for that reason.
   * Its `fingerprintBeforeRestore` is {@link fingerprintPath}'s `directory` arm
   * — the correct before-state for a path that held no file bytes to begin with,
   * and one that compares UNEQUAL to the `file:<hash>` a snapshot file
   * displacing it leaves behind, which is what makes shapes 1 and 2 observable
   * at that path rather than washing out.
   *
   * "Untracked" there is an INDEX fact, not a disk fact: `ls-files -o` lists a
   * path only while it is absent from the current index, so a path that is both
   * index-tracked and ignored-by-rule never appears and is never enumerated.
   * That is the intended reading, not a hole — the spec's collision case is
   * ignored content the run created OUTSIDE git's tracking that the snapshot
   * tree happens to track, and an index-tracked path is by construction content
   * the run committed, whose overwrite is the ordinary restore, not a
   * user-data collision. A fixture reproducing the collision therefore has to
   * `git rm --cached` the path; content-only ignoring is not enough.
   *
   * `160000` entries are filtered out of the TRACKED set, so they never fire
   * shapes 1 and 2: this leg writes no file bytes at a gitlink path — under
   * `submodule.recurse=false` it materializes an empty directory and stops —
   * and those two shapes report an ignored path a snapshot FILE overwrote.
   *
   * It does need a DIRECTORY there, though, so every `160000` entry seeds
   * `snapshotRequiredDirectories` with its own path AND its ancestors, and shape
   * 3 enumerates whatever clearing room for that directory unlinks. Measured on
   * git 2.50.1: an ignored FILE holding a snapshot gitlink's own path (file
   * `sub`, gitlink at `sub`) and one holding an ancestor directory of a deeper
   * gitlink (file `sub`, gitlink at `sub/mod`) are both unlinked by the
   * checkout, and both are reported — under the ignored path being destroyed,
   * with {@link fingerprintPath}'s `file:<hash>` arm as the before-state, on the
   * same contract shapes 1-3 carry everywhere else.
   *
   * Shape 3's `!isDirectoryEntry` guard is what keeps that exact. An ignored
   * DIRECTORY at a gitlink path is not a collision because it is not destroyed:
   * measured on git 2.50.1 with an ignored embedded repository at a snapshot
   * gitlink's path, the checkout exits 0 leaving the directory, its payload and
   * its `.git` untouched — the directory the gitlink wants is already there, and
   * this leg does not descend into it. That path's disposition is the divergence
   * enumeration's below: reported through `divergentGitlinks` when the embedded
   * `HEAD` disagrees with the snapshot's, and reported nowhere when it agrees,
   * because then nothing moved. Ignored content merely BENEATH a materialized
   * gitlink directory is likewise neither enumerated nor deleted (measured) —
   * the checkout's side of the same `submodule.recurse=false` boundary the
   * delete pass meets from `ls-files -o`.
   *
   * Gitlink divergence is per `160000` entry in the snapshot tree: the working
   * copy's embedded `HEAD` is resolved and compared, and anything that is not an
   * exact match — a moved submodule, a directory that is not a repository, an
   * absent one — is divergent. Each candidate's on-disk state is recorded here
   * because materializing an ABSENT gitlink as an empty directory is the effect
   * this leg most often has at a gitlink path, and the failure observation needs
   * a before-state to see it. Recorded as a {@link fingerprintPath} arm rather
   * than as a presence boolean: the boolean came from a symlink-FOLLOWING `stat`
   * and so could not distinguish a directory from a symlink pointing at one,
   * which silently excused the destruction of the symlink from the report.
   *
   * The skipped-repository trailer is read here too, in the same pre-mutation
   * window and for the same reason the enumerations are: it constrains what the
   * later legs are allowed to do, so it has to exist before any of them run, and
   * a malformed one has to be able to refuse while nothing has been written.
   */
  async #deriveProspectiveRestoreEffects(
    target: TurnSnapshotRestoreTarget,
  ): Promise<ProspectiveRestoreEffects> {
    // An OID-INTERPRETATION read, so it carries the pin: an unpinned `cat-file`
    // would hand back the replacement commit's message, and an attacker who can
    // plant a replace ref could then blank the trailer and re-arm the delete pass
    // against the very repositories it protects.
    const commitObject: Buffer = (
      await this.#runGit(
        [
          "-C",
          target.executionRoot,
          ...USE_REPLACE_REFS_PIN,
          "cat-file",
          "commit",
          target.snapshotCommit,
        ],
        {},
      )
    ).stdout;
    const preservedEmbeddedRepositories: readonly string[] =
      parseSkippedEmbeddedRepositories(commitObject);

    // The sparse vintage gate. Read here, in the same pre-mutation window and for
    // the same reason the trailer above is: it constrains what the later legs may
    // do, so it has to exist before any of them run, and a refusal has to be able
    // to fire while nothing has been written.
    const isSparseRoot: boolean = await this.#detectSparseRoot(target.executionRoot);
    const recordedBoundaryPaths: readonly string[] | null = parseSparseBoundaryPaths(commitObject);
    if (isSparseRoot && recordedBoundaryPaths === null) {
      // REFUSED, not degraded, and the two vintages this covers are why. A
      // trailer-less snapshot in a sparse root is either a pre-closure capture —
      // whose out-of-cone content was never recorded and whose boundary set is
      // therefore unknowable — or a capture taken while this root was NOT sparse,
      // which the user made sparse afterwards. The two are indistinguishable from
      // here and their safe handling is the same: proceeding would run the delete
      // pass with no boundary exemption at all, and the pre-drop over an empty
      // recorded set — the pre-drop is scoped by set MEMBERSHIP, not by this root
      // test, and an absent trailer is precisely an absent input to it —
      // destroying out-of-cone content the user still has on disk. The
      // throw lands at `derive-enumerations`, pre-mutation, so the refusal costs
      // nothing on disk — the whole reason this read is here and not later.
      throw new Error(
        "turn-snapshot refuses a snapshot with no sparse-boundary trailer in a sparse execution root",
      );
    }
    // A non-sparse root reads an absent trailer as the empty set, which is the
    // correct reading THERE: there is no boundary set because there is no cone.
    // See {@link parseSparseBoundaryPaths} for why the decoder distinguishes the
    // two rather than making this the only reading.
    //
    // Classified into its two entry kinds ONCE, here, because three legs below
    // consume it and each needs a different kind. The classification is pure and
    // deliberately downstream of the vintage gate above, which is the only place
    // absent-versus-empty may be decided.
    const sparseBoundarySet: SparseBoundarySet = classifySparseBoundaryPaths(
      recordedBoundaryPaths ?? [],
    );

    const treeListing: Buffer = (
      await this.#runGit(
        [
          "-C",
          target.executionRoot,
          // Same predicate as the checkout leg: this INTERPRETS the frozen id, so
          // an unpinned listing would enumerate a replacement tree's paths and
          // hand the failure report a candidate set describing a different
          // snapshot than the one about to be written.
          ...USE_REPLACE_REFS_PIN,
          "ls-tree",
          "-r",
          "-z",
          target.snapshotCommit,
        ],
        {},
      )
    ).stdout;
    const treeEntries: readonly SnapshotTreeEntry[] = parseSnapshotTreeListing(treeListing);
    const snapshotTrackedPaths = new Set<string>(
      treeEntries.filter((entry) => entry.mode !== GITLINK_TREE_MODE).map((entry) => entry.path),
    );
    // Shape 3's side of the test, derived once instead of per ignored path.
    // Membership means "the checkout has to have a directory here", which is
    // exactly what an ignored FILE sitting there obstructs.
    const snapshotRequiredDirectories = new Set<string>();
    for (const trackedPath of snapshotTrackedPaths) {
      for (const ancestor of collectProperAncestorDirectories(trackedPath)) {
        snapshotRequiredDirectories.add(ancestor);
      }
    }
    // A gitlink needs a directory AT ITS OWN PATH — the empty one the checkout
    // materializes under `submodule.recurse=false` — as well as along the way to
    // it, so each `160000` entry seeds both. Deliberately NOT added to
    // `snapshotTrackedPaths`: this leg writes no file bytes at a gitlink path, so
    // shapes 1 and 2 (an ignored path a snapshot FILE overwrites) must not fire
    // there, while shape 3 (an ignored file unlinked to clear a directory's
    // place) must.
    for (const entry of treeEntries) {
      if (entry.mode !== GITLINK_TREE_MODE) {
        continue;
      }
      snapshotRequiredDirectories.add(entry.path);
      for (const ancestor of collectProperAncestorDirectories(entry.path)) {
        snapshotRequiredDirectories.add(ancestor);
      }
    }

    const ignoredListing: Buffer = (
      await this.#runGit(
        ["-C", target.executionRoot, "ls-files", "-o", "-i", EXCLUDE_PER_DIRECTORY_GITIGNORE, "-z"],
        {},
      )
    ).stdout;

    const collisions: ProspectiveCollision[] = [];
    for (const entry of splitNulTerminatedListing(ignoredListing)) {
      const isDirectoryEntry: boolean = entry.endsWith("/");
      const path: string = isDirectoryEntry ? entry.slice(0, -1) : entry;
      const obstructed: boolean =
        snapshotTrackedPaths.has(path) ||
        collectProperAncestorDirectories(path).some((ancestor) =>
          snapshotTrackedPaths.has(ancestor),
        ) ||
        (!isDirectoryEntry && snapshotRequiredDirectories.has(path));
      if (!obstructed) {
        continue;
      }
      collisions.push({
        path,
        fingerprintBeforeRestore: await fingerprintPath(join(target.executionRoot, path)),
      });
    }

    const gitlinkDivergences: ProspectiveGitlinkDivergence[] = [];
    for (const entry of treeEntries) {
      if (entry.mode !== GITLINK_TREE_MODE) {
        continue;
      }
      const gitlinkPath: string = join(target.executionRoot, entry.path);
      const observedCommit: string | null = await this.#resolveEmbeddedHead(gitlinkPath);
      if (observedCommit === entry.objectId) {
        continue;
      }
      gitlinkDivergences.push({
        path: entry.path,
        fingerprintBeforeRestore: await fingerprintPath(gitlinkPath),
      });
    }

    // THE OBSTRUCTION GUARD, and it comes first among the sparse legs because it
    // is the only one that can REFUSE. Still read-only, still pre-mutation: the
    // throw lands at `derive-enumerations` with the index and the worktree
    // untouched, exactly as the vintage gate above does.
    const obstructions: readonly BoundaryObstruction[] = await this.#deriveBoundaryObstructions(
      target.executionRoot,
      isSparseRoot,
      sparseBoundarySet,
      treeEntries,
    );
    if (obstructions.length > 0) {
      throw new Error(
        "turn-snapshot refuses a restore whose checkout would destroy recorded sparse-boundary content: " +
          describeBoundaryObstructions(obstructions),
      );
    }

    // The three sparse legs, and they are scoped DIFFERENTLY on purpose — the one
    // asymmetry in this closure worth stating outright, because the symmetric
    // reading is the plausible one and it loses data.
    //
    // The DIAGNOSTIC leg keys on the LIVE definition: it reports what the live
    // cone is about to discard, so it is meaningless in a root that has no cone,
    // and it is the only leg here whose EXISTENCE turns on the matcher.
    //
    // The OBSTRUCTION guard above is scoped BOTH ways, and needs to be. Which
    // boundary paths it must consider is a fact about the SNAPSHOT (the recorded
    // set, like the drop leg below), while whether a conflicting snapshot path
    // actually gets written is a fact about the LIVE cone (the matcher, like the
    // diagnostic leg above) — a conflict the live projection leaves unwritten
    // destroys nothing and must not refuse a restore. Root-gating its membership
    // half would miss the shape where a capture recorded a boundary path and the
    // user then disabled sparse checkout, which is the shape where EVERY snapshot
    // path materializes and the destruction is total.
    //
    // The DROP leg keys on the RECORDED SET ALONE — membership plus absence from
    // the snapshot tree, no matcher, no live definition, no root test. It has to,
    // for the same reason the delete-pass exemption it pairs with does: both
    // exist to keep boundary-time content alive, the recorded set is what fixes
    // that content's identity at CAPTURE time, and a cone edit between capture
    // and restore must never turn boundary-time content into a deletion
    // candidate. Root-gating this one would break exactly that pairing. A capture
    // records path P, the user disables sparse checkout, and the restore then
    // skips the drop while still exempting P from the delete pass — so
    // `read-tree --reset -u` finds a live-index entry the snapshot tree lacks and
    // deletes P from disk before the exemption is ever consulted. The exemption
    // cannot save a file the checkout already unlinked.
    //
    // Nothing is spent in the ordinary non-sparse case: a snapshot captured in a
    // non-sparse root carries no trailer, the decode reads that as the empty set,
    // and {@link #deriveDroppableBoundaryIndexEntries} returns on it without
    // spawning anything. Only a trailer-BEARING snapshot reaches the listing.
    const materializedOutOfCone: readonly ProspectiveMaterialization[] = isSparseRoot
      ? await this.#deriveMaterializedOutOfCone(target.executionRoot, treeEntries)
      : [];
    // ENUMERATED here, applied by the caller after the second `HEAD` read — see
    // the field's docblock, and {@link #dropBoundaryPathsFromLiveIndex} for why
    // the split exists. Nothing else in this derivation depends on the drop
    // having happened: the materialization set above is filtered to
    // snapshot-tracked paths, and a droppable boundary path is by construction
    // one the snapshot tree does NOT track.
    const droppableBoundaryIndexEntries: readonly Buffer[] =
      await this.#deriveDroppableBoundaryIndexEntries(
        target.executionRoot,
        sparseBoundarySet,
        treeEntries,
      );

    return {
      collisions,
      gitlinkDivergences,
      preservedEmbeddedRepositories,
      sparseBoundarySet,
      materializedOutOfCone,
      droppableBoundaryIndexEntries,
    };
  }

  /**
   * Recorded boundary paths the CHECKOUT ITSELF would destroy — the restore's
   * pre-mutation refusal reason, and the half of the boundary protection neither
   * the index pre-drop nor the delete-pass exemption can supply.
   *
   * WHY A THIRD LEG EXISTS. The other two each stop one destructive mechanism:
   * the pre-drop removes the index entry that would make `read-tree --reset -u`
   * unlink a boundary path it holds, and the exemption stops the delete pass from
   * removing an untracked one. Neither reaches the case where the boundary path
   * and a SNAPSHOT path want the same place on disk. There is no index entry to
   * drop — the index caches `foo/bar`, not `foo` — and the delete pass runs after
   * the checkout, so its exemption arrives to protect a file that was unlinked two
   * legs ago. The checkout does this at exit 0 and says nothing.
   *
   * THREE DESTRUCTIVE SHAPES, each measured on git 2.50.1, each stated in terms
   * of what the CAPTURE recorded. The shape SET is not invented here: it mirrors
   * the collision taxonomy [Spec-010 §Turn-Boundary Snapshots] measured for
   * IGNORED paths, which enumerates the three ways `read-tree --reset -u`
   * destroys an obstructing path rather than merging around it — a snapshot file
   * AT the path, a snapshot file at an ANCESTOR of it, and the path standing as
   * an ancestor DIRECTORY of a snapshot path. Boundary paths meet the same
   * checkout through the same mechanism, so the taxonomy transfers whole and the
   * set is complete for the same reason that one is: it covers both directions of
   * the file/directory conflict plus the ancestor direction, which is every way a
   * single checkout can need a path's place.
   *
   *   1. A boundary FILE entry `P` standing where the snapshot needs a DIRECTORY,
   *      because the tree holds something strictly beneath `P`. The checkout
   *      unlinks the file and creates the directory. The tree entry beneath may be
   *      a blob (`P/bar`) or a GITLINK — a gitlink needs the empty directory the
   *      checkout materializes under `submodule.recurse=false`, and measured, an
   *      ordinary file standing at a gitlink's own path is unlinked to make room
   *      for it.
   *   2. A boundary DIRECTORY entry `P/` standing where the snapshot holds a BLOB
   *      at `P`. Measured: the directory is removed WHOLE, its untracked payload
   *      with it, and the blob written in its place — the same destruction the
   *      collision enumeration reports for an ignored directory, arriving at a
   *      path the trailer promised to keep.
   *   3. A boundary entry of EITHER kind whose proper ANCESTOR is a snapshot BLOB.
   *      The checkout needs a file at the ancestor, so it removes the directory
   *      standing there WHOLE and everything beneath goes with it — including a
   *      boundary path several segments down. A SPARSE root is what makes this
   *      reachable rather than exotic: an out-of-cone tracked blob at `P` is
   *      skip-worktree and so absent from disk, the turn is free to `mkdir P` and
   *      write `P/child` into the space it left, and `ls-files -o` then records
   *      `P/child` in the boundary set while the tree keeps its cached blob at `P`
   *      — the very persistence I-010-24 requires of out-of-cone cached entries.
   *      Measured end to end on that fixture: `ls-files -o` reports `P/child`, and
   *      after a widening the checkout writes file `P` at exit 0 with `P/child`
   *      gone. A GITLINK at an ancestor is NOT a displacer, for the same reason it
   *      is not one in shape 2: it wants a DIRECTORY at that path, which is what
   *      is already there, so the checkout merges rather than removes. That carve
   *      is belt-and-braces rather than load-bearing, and no test drives it,
   *      because the case is unreachable from a capture: git does not descend into
   *      an embedded repository, so `ls-files -o` reports nothing beneath a
   *      gitlink and no boundary path can be recorded under one in the first
   *      place. It is written anyway, because the carve costs one comparison and
   *      the unreachability is a property of the CAPTURE leg that a future change
   *      there could quietly retire.
   *
   * WHAT IS NOT A SHAPE, stated because each is the plausible false positive:
   *
   *   * A boundary DIRECTORY entry whose STRICT DESCENDANTS materialize. Measured:
   *      the checkout merges into the directory, leaving its payload and its
   *      `.git` intact. Refusing there would refuse the ordinary sparse restore.
   *   * A conflicting tree path that will NOT materialize. Under the live sparse
   *      projection an out-of-cone blob is never written, so nothing displaces the
   *      boundary path and there is nothing to refuse.
   *   * A tree path AT a boundary FILE path. Structurally unreachable rather than
   *      tolerated: the capture derives the boundary set by SUBTRACTING the whole
   *      `ls-tree -r` listing (blobs and gitlinks alike), so a recorded boundary
   *      FILE path is by construction absent from that snapshot's tree. The
   *      DIRECTORY kind is the deliberate exception and the reason shape 2 exists
   *      — a recorded `P/` carries a trailing slash that no `ls-tree -r` path
   *      does, so the subtraction cannot cancel it against a blob at `P`.
   *
   * WHY REFUSE RATHER THAN REPORT AND PROCEED. I-010-24 says boundary-time
   * out-of-cone content SURVIVES the restore on disk; a diagnostic naming what was
   * destroyed would satisfy the enumeration half of that sentence and violate the
   * survival half. The `restore wins, with enumeration` precedent belongs to
   * IGNORED paths, which the snapshot contract excludes from the outset — boundary
   * paths are that contract's protected subject, so the precedent does not reach
   * them. The refusal is typed, lands at `derive-enumerations` and costs nothing
   * on disk, which is the same disposition the sparse vintage gate already has.
   *
   * MATERIALIZATION IS ASKED, NOT ASSUMED, and asked differently per entry kind —
   * this is where a plausible implementation fails open. A GITLINK always
   * materializes: measured, git never marks a gitlink skip-worktree (`ls-files -t`
   * reports `H` for an out-of-cone one) and the checkout makes its directory
   * whatever the cone says, so scoring gitlinks through the matcher would score
   * the destructive case out of cone and wave it through. Only BLOBS are scored,
   * and only in a sparse root — in a non-sparse one every tree path materializes,
   * which is exactly the widened-cone case this guard exists for.
   *
   * DISK IS CONSULTED LAST, and only for boundary paths that already conflict by
   * PATH SHAPE against a MATERIALIZING displacer. A path nothing is about to
   * displace needs no `lstat`, and the whole worktree walk this avoids would be
   * the pre-mutation path's most expensive read. The probe is
   * {@link probeBoundaryPathPresence} rather than {@link fingerprintPath}, because
   * an unreadable path has to count as obstruction here; see that observer.
   *
   * The matcher call does NOT guard on an empty candidate set, so
   * {@link #scoreInConeKeys}'s "the oracle answers or the sequence refuses" rule
   * survives this third caller intact: a sparse root whose rules file vanished
   * fails here as it fails everywhere else. What DOES gate it is the recorded set
   * being empty, which is a fact about the snapshot rather than about the matcher.
   *
   * EVERY PATH COMPARISON HERE IS BYTE-EXACT — the recorded set's keys against
   * {@link SnapshotTreeEntry.pathKey}, the ancestor walk over those same keys, the
   * matcher scored on `latin1`-restored bytes. The decode happens twice and both
   * times at the exit: the obstruction's `path` and its `displacedBy` names are
   * read by a human out of a refusal detail. ORDER is taken on the keys before
   * that decode, so the message stays a function of repository state rather than
   * of which spelling survived a decode.
   *
   * NAMED RESIDUAL, in the fail-open direction and pre-existing rather than
   * introduced: the presence probe addresses the filesystem, whose seam is
   * string-typed, so a boundary path whose bytes are not valid UTF-8 is probed at
   * its DECODED spelling. That path answers `absent`, no obstruction is recorded
   * for it, and the guard waves through a checkout that may destroy it. It is
   * unreachable on a filesystem that rejects non-UTF-8 names (APFS does, at
   * `creat`), and closing it means a Buffer-typed filesystem seam — see
   * {@link TurnSnapshotFilesystem}. Stated here because this guard's posture is
   * otherwise fail-closed and a reader is owed the exception.
   */
  async #deriveBoundaryObstructions(
    executionRoot: string,
    isSparseRoot: boolean,
    boundarySet: SparseBoundarySet,
    treeEntries: readonly SnapshotTreeEntry[],
  ): Promise<readonly BoundaryObstruction[]> {
    if (boundarySet.filePaths.size === 0 && boundarySet.directoryPaths.length === 0) {
      return [];
    }
    const boundaryDirectoryPaths = new Set<string>(boundarySet.directoryPaths);

    // Shape 1 and shape 2 candidates, by path shape alone — no matcher, no disk.
    // Kept apart rather than in one map keyed by path, because a forged trailer
    // may record both `a` and `a/` and the two kinds then ask opposite questions
    // of the same path.
    const fileBoundaryDisplacers = new Map<string, SnapshotTreeEntry[]>();
    const directoryBoundaryDisplacers = new Map<string, SnapshotTreeEntry[]>();
    const blobEntriesByPathKey = new Map<string, SnapshotTreeEntry>();
    for (const entry of treeEntries) {
      for (const ancestor of collectProperAncestorDirectories(entry.pathKey)) {
        if (boundarySet.filePaths.has(ancestor)) {
          appendToPathIndex(fileBoundaryDisplacers, ancestor, entry);
        }
      }
      // A gitlink AT a boundary directory destroys nothing: the directory the
      // gitlink wants is already there, and this leg does not descend into it
      // (measured — the checkout leaves such a directory, its payload and its
      // `.git` untouched). Only a blob displaces.
      if (entry.mode !== GITLINK_TREE_MODE) {
        blobEntriesByPathKey.set(entry.pathKey, entry);
        if (boundaryDirectoryPaths.has(entry.pathKey)) {
          appendToPathIndex(directoryBoundaryDisplacers, entry.pathKey, entry);
        }
      }
    }

    // Shape 3 candidates, walked from the BOUNDARY side rather than the tree side
    // — the shape's displacer sits ABOVE the boundary path, so the tree loop above
    // never passes through it. Its displacers are appended into the SAME per-kind
    // maps instead of a third one, because shape 3 asks nothing new about the
    // boundary path itself: whichever kind was recorded is the kind that must
    // still be standing on disk for there to be anything to destroy. That keeps
    // the presence probe, the sort, and the `displacedBy` merge below identical,
    // and it puts these displacers inside the SINGLE oracle batch scored next.
    // At most one ancestor can match — git cannot hold a blob at both `a` and
    // `a/b` — but the walk is written for the general case rather than that proof.
    for (const [boundaryPathKey, displacers] of [
      ...[...boundarySet.filePaths].map(
        (boundaryPathKey): readonly [string, Map<string, SnapshotTreeEntry[]>] => [
          boundaryPathKey,
          fileBoundaryDisplacers,
        ],
      ),
      ...boundarySet.directoryPaths.map(
        (boundaryPathKey): readonly [string, Map<string, SnapshotTreeEntry[]>] => [
          boundaryPathKey,
          directoryBoundaryDisplacers,
        ],
      ),
    ]) {
      for (const ancestor of collectProperAncestorDirectories(boundaryPathKey)) {
        const shadowingBlob: SnapshotTreeEntry | undefined = blobEntriesByPathKey.get(ancestor);
        if (shadowingBlob !== undefined) {
          appendToPathIndex(displacers, boundaryPathKey, shadowingBlob);
        }
      }
    }

    const conflictingBlobPathKeys: readonly string[] = [
      ...new Set<string>(
        [...fileBoundaryDisplacers.values(), ...directoryBoundaryDisplacers.values()]
          .flat()
          .filter((entry) => entry.mode !== GITLINK_TREE_MODE)
          .map((entry) => entry.pathKey),
      ),
    ];
    const inConeKeys: ReadonlySet<string> | null = isSparseRoot
      ? await this.#scoreInConeKeys(
          executionRoot,
          // `latin1` back to bytes, which restores the ORIGINAL `ls-tree` bytes
          // rather than a re-encoding of a decode — the matcher echoes what it is
          // given, so its keys land in the same alphabet as `pathKey`.
          conflictingBlobPathKeys.map((pathKey) => Buffer.from(pathKey, "latin1")),
        )
      : null;
    const willMaterialize = (entry: SnapshotTreeEntry): boolean =>
      entry.mode === GITLINK_TREE_MODE || inConeKeys === null || inConeKeys.has(entry.pathKey);

    const obstructions: { readonly pathKey: string; readonly obstruction: BoundaryObstruction }[] =
      [];
    for (const [boundaryPathKey, displacers, obstructingPresence] of [
      ...[...fileBoundaryDisplacers].map(
        ([pathKey, entries]) => [pathKey, entries, "non-directory"] as const,
      ),
      ...[...directoryBoundaryDisplacers].map(
        ([pathKey, entries]) => [pathKey, entries, "directory"] as const,
      ),
    ]) {
      // `filter` already copies, so the sort cannot reorder the map's own array.
      const materializingDisplacers: readonly SnapshotTreeEntry[] = displacers
        .filter(willMaterialize)
        .sort((left, right) => (left.pathKey < right.pathKey ? -1 : 1));
      if (materializingDisplacers.length === 0) {
        continue;
      }
      const presence: BoundaryPathPresence = await probeBoundaryPathPresence(
        join(executionRoot, decodeSparseBoundaryPathKey(boundaryPathKey)),
      );
      // `unreadable` obstructs whatever kind was recorded — see the probe.
      if (presence !== obstructingPresence && presence !== "unreadable") {
        continue;
      }
      obstructions.push({
        pathKey: boundaryPathKey,
        obstruction: {
          path: decodeSparseBoundaryPathKey(boundaryPathKey),
          displacedBy: materializingDisplacers.map((entry) => entry.path),
        },
      });
    }
    // Sorted so the refusal's message is a function of the repository state and
    // not of `ls-tree` ordering; the suite asserts on it. On the KEYS, so the
    // order is the paths' byte order and no decode can perturb it.
    return obstructions
      .sort((left, right) => (left.pathKey < right.pathKey ? -1 : 1))
      .map((entry) => entry.obstruction);
  }

  /**
   * The CANDIDATES for the discarded-subset diagnostic: snapshot-tracked paths
   * the LIVE cone excludes that are on disk right now, each carrying the state
   * its removal will be measured against.
   *
   * OBSERVED, never bookkept, and that discipline is why this returns candidates
   * rather than an answer. The three facts readable at this moment (what the
   * snapshot tracks, what the matcher scores out of cone, what `ls-files -c`
   * reports as materialized rather than skip-worktree) say what the checkout is
   * ABOUT TO discard. What it actually discarded is a different question, and it
   * is settled at emission by re-fingerprinting — the standard the collision and
   * gitlink enumerations already hold themselves to, arrived at here for the same
   * reason: a `partial_restore` that never reached these paths must not report
   * them. Nothing here changes what the checkout does; no result arm grows. See
   * the `sparse-out-of-cone-materialized` arm of {@link TurnSnapshotDiagnostic}.
   *
   * "On disk" is asked of the INDEX, not of the filesystem, and deliberately: git
   * marks an unmaterialized out-of-cone entry skip-worktree (`ls-files -t` spells
   * it `S`), so the index already holds the answer for every tracked path and a
   * per-path `lstat` would buy nothing but a worktree walk on the pre-mutation
   * path. A path the snapshot tracks that is absent from the live index entirely
   * is not materialized either, and falls out of the same test. The per-candidate
   * {@link fingerprintPath} that follows IS a filesystem read, but only over the
   * paths that survived that test — the walk this avoids is the whole tree.
   *
   * FAIL-CLOSED like every other matcher call: a failure here is a
   * `derive-enumerations` failure, pre-mutation. Degrading to "report nothing"
   * would be defensible for a diagnostic and is not taken, because the same
   * matcher answer feeds nothing else here and a matcher that cannot answer is
   * the condition the whole sparse arm refuses on.
   *
   * The candidates are rebuilt with `Buffer.from(path)` from tree-listing paths
   * that {@link parseSnapshotTreeListing} already decoded, which is a deliberate
   * departure from the capture partition's all-bytes discipline: byte-exactness is
   * unattainable here — the strings arrive decoded — and unneeded, because both
   * sides of the comparison below come from that one `ls-tree`, making the round
   * trip decode-to-decode. See {@link #scoreInConeKeys} on candidate provenance.
   * The capture side has NO such departure left: its subtraction runs on listing
   * bytes end to end, and the one decode there happens after it, at the trailer.
   *
   * NO EARLY RETURN ON AN EMPTY CANDIDATE SET, and that is the point rather than
   * an oversight. A snapshot tree with no non-gitlink path (an empty base commit;
   * a tree holding only submodules) would otherwise skip the ONLY oracle call the
   * restore side makes, so a sparse root whose rules file had vanished — or a git
   * below the 2.41 `check-rules` floor — would restore BLIND in exactly the shape
   * where nothing is left to fail on later. The capture side has never had such a
   * guard either, and since both legs now reach the matcher through
   * {@link #scoreInConeKeys}, which guards nothing, "the oracle answers or the
   * sequence refuses" is enforced by STRUCTURE rather than by two call sites
   * independently remembering to. The cost is one spawn on a shape that is nearly
   * always empty anyway, and `check-rules` exits 0 on an empty candidate set in a
   * healthy sparse root (driven by the suite, not assumed).
   */
  async #deriveMaterializedOutOfCone(
    executionRoot: string,
    treeEntries: readonly SnapshotTreeEntry[],
  ): Promise<readonly ProspectiveMaterialization[]> {
    const snapshotPaths: readonly string[] = treeEntries
      .filter((entry) => entry.mode !== GITLINK_TREE_MODE)
      .map((entry) => entry.path);
    const candidates: readonly Buffer[] = snapshotPaths.map((path) => Buffer.from(path, "utf8"));
    const inConeKeys: ReadonlySet<string> = await this.#scoreInConeKeys(executionRoot, candidates);

    // `-c` alone lists every cached path; `--sparse` is deliberately absent, so a
    // sparse index is expanded and skip-worktree entries are reported. The `-t`
    // form is what carries the disposition: `H` is materialized, `S` is
    // skip-worktree, and only the former is content the checkout will overwrite.
    const materializedPaths = new Set<string>(
      parseCachedStateListing(
        (await this.#runGit(["-C", executionRoot, "ls-files", "-c", "-t", "-z"], {})).stdout,
      )
        .filter((entry) => entry.tag === "H")
        .map((entry) => entry.path),
    );

    const discardable: readonly string[] = snapshotPaths
      .filter(
        (path) =>
          !inConeKeys.has(listingEntryKey(Buffer.from(path, "utf8"))) &&
          materializedPaths.has(path),
      )
      .sort();

    const observed: ProspectiveMaterialization[] = [];
    for (const path of discardable) {
      observed.push({
        path,
        fingerprintBeforeRestore: await fingerprintPath(join(executionRoot, path)),
      });
    }
    return observed;
  }

  /**
   * The LIVE-index entries the pre-drop will remove: recorded boundary paths the
   * index holds and the snapshot tree does not. READ-ONLY — see
   * {@link #dropBoundaryPathsFromLiveIndex}, which applies them.
   *
   * The `ls-files -c` read is deliberately taken here rather than at apply time,
   * with the derivation's other listings, so the whole enumeration is fixed in
   * one window. Re-reading it after the second `HEAD` check would widen the set
   * to entries staged during the derivation, which is content this restore never
   * measured and must not silently unstage.
   *
   * MEMBERSHIP-SCOPED, NOT ROOT-SCOPED, and the early return below is what makes
   * that affordable. The caller does not ask whether this root is sparse: the
   * predicate is "the RECORDED set holds this path and the snapshot tree does
   * not", both of which are facts about the SNAPSHOT. A root that stopped being
   * sparse between capture and restore still holds the live-index entries the
   * capture recorded, and `read-tree --reset -u` still deletes them — sparseness
   * is not what makes that dangerous, the index/tree disagreement is. Gating on
   * the live root would also split this leg from the delete-pass exemption it
   * exists to complete, which is already membership-scoped; see the call site.
   *
   * Cost in the ordinary non-sparse restore is zero rather than small. A snapshot
   * captured in a non-sparse root carries no trailer, an absent trailer decodes
   * to the empty set THERE, and a set empty in BOTH kinds returns before the
   * listing spawns. A snapshot that recorded only DIRECTORY entries now reaches
   * the listing where it used to return early — one `ls-files -c -z` on a shape
   * that previously had no protection at all, which is the trade the widening
   * below is.
   * So the leg is reached only by a trailer-BEARING snapshot, and nothing about
   * the non-sparse pipeline's spawn sequence changes.
   *
   * That also leaves the LEGACY residual exactly where it was, which is the point
   * worth checking rather than assuming. A pre-closure snapshot captured in a
   * sparse root carries no trailer either; restored into a root that is no longer
   * sparse it decodes empty, this leg no-ops, and the sequence behaves precisely
   * as it did before the closure — its out-of-cone content was never recorded, so
   * there is nothing here that could protect it. Only a trailer-BEARING snapshot
   * gains the drop in a non-sparse root. (The same legacy snapshot restored into a
   * still-SPARSE root is refused outright by the vintage gate; see the call site.)
   *
   * THE RECORDED SET'S FULL WIDTH, both kinds — {@link isSparseBoundaryIndexPath},
   * which is the delete-pass exemption's width minus the slash question an index
   * path cannot raise. Taking only `filePaths` here read as a shape-of-the-data
   * argument and was a hole: `ls-files -o` emits a trailing-slash entry ONLY for a
   * directory it did not descend into, and it descends the moment the index holds
   * anything at or beneath that directory (measured on git 2.50.1), so at CAPTURE
   * time a recorded directory provably has no index entry inside it. The flaw is
   * that this leg runs at RESTORE time, and the turn is free to change the fact in
   * between: remove the embedded `.git` that made git refuse to descend, `git add`
   * something beneath it, and the index now holds a path under a recorded boundary
   * directory that the snapshot tree does not — precisely the index/tree
   * disagreement `read-tree --reset -u` resolves by UNLINKING. The narrow, named,
   * uncovered residual was therefore a live data-loss path, and matching the
   * exemption's width closes it.
   *
   * The DIRECTORY arm's equality case (an index entry AT the recorded directory
   * path, not beneath it) is included rather than carved out, even though the
   * brief for this leg is "strictly beneath". Two reasons, and the second is why
   * it is not merely harmless: a file the turn created where the boundary
   * directory stood is exactly the shape the exemption already protects — the two
   * legs are one statement made to two mechanisms and a width that drifted between
   * them would unstage what the delete pass then removes — and the outcome of
   * including it is an UNSTAGE, never a delete. The tree exclusion below still
   * fires first for anything the snapshot itself holds.
   *
   * THE TREE EXCLUSION STAYS, and widening the membership is exactly why it must.
   * A snapshot-tree path beneath a recorded boundary directory is content the
   * checkout is SUPPOSED to write — the ordinary sparse restore of a directory
   * whose payload the capture could not enumerate — so dropping its index entry
   * would leave the checkout to merge it back in from a tree it no longer knows is
   * missing, or worse, strand it. The predicate is "the recorded set holds this
   * path and the snapshot tree does NOT", and only the first half moved.
   *
   * BYTE-KEYED on both halves. The live index entry is keyed with
   * {@link listingEntryKey}, the recorded set already holds byte keys, and the
   * exclusion set is built from {@link SnapshotTreeEntry.pathKey} rather than from
   * decoded paths. A `utf8` key here was the second live data-loss path: a tracked
   * snapshot path byte-DISTINCT from a boundary path but decode-IDENTICAL to it
   * (both collapsing onto U+FFFD) made the exclusion fire for the boundary entry,
   * which then kept its index entry and lost its only on-disk copy to the
   * checkout. Bytes cannot alias.
   */
  async #deriveDroppableBoundaryIndexEntries(
    executionRoot: string,
    boundarySet: SparseBoundarySet,
    treeEntries: readonly SnapshotTreeEntry[],
  ): Promise<readonly Buffer[]> {
    if (boundarySet.filePaths.size === 0 && boundarySet.directoryPaths.length === 0) {
      return [];
    }
    // Every tree path, gitlinks INCLUDED: a gitlink is snapshot-recorded too — it
    // is simply filtered out of the tracked set the collision shapes use — so it
    // must not be dropped here.
    const recordedPathKeys = new Set<string>(treeEntries.map((entry) => entry.pathKey));

    const cachedListing: Buffer = (
      await this.#runGit(["-C", executionRoot, "ls-files", "-c", "-z"], {})
    ).stdout;
    const droppable: Buffer[] = [];
    for (const entry of splitNulTerminatedListingBytes(cachedListing)) {
      const pathKey: string = listingEntryKey(entry);
      if (isSparseBoundaryIndexPath(pathKey, boundarySet) && !recordedPathKeys.has(pathKey)) {
        droppable.push(entry);
      }
    }
    return droppable;
  }

  /**
   * Drop the enumerated boundary entries from the LIVE index, in one invocation,
   * before anything destructive runs.
   *
   * This is the half of the boundary-set protection the delete-pass exemption
   * cannot provide, because the two destructive legs destroy that content by
   * different mechanisms. The delete pass removes an UNTRACKED boundary path as
   * post-boundary content, and the exemption stops it. `read-tree --reset -u`
   * removes a boundary path the LIVE INDEX holds and the snapshot tree does not,
   * because that is what resetting to a tree means — and it does so before the
   * delete pass ever runs, so no exemption there can reach it. Two shapes land in
   * that second case, and both are ordinary user actions inside a sparse root:
   *
   *   * INTENT-TO-ADD (`git add -N --sparse`). The capture recorded the path as a
   *     boundary path precisely because `write-tree` omits such an entry, so the
   *     index-versus-tree disagreement is guaranteed rather than incidental.
   *   * TURN-STAGED (`git add --sparse` DURING the turn, after the boundary). The
   *     capture saw an untracked out-of-cone path; the user then staged it. The
   *     rollback's whole promise is to return the tree to the boundary, which
   *     means the staging is undone — not that the file is deleted.
   *
   * "Inside a sparse root" describes where those entries are CREATED, not where
   * this leg runs. The restore root's own sparsity is never consulted: what the
   * index holds outlives the config bit, so a user who disables sparse checkout
   * between capture and restore still arrives here with the entry, and skipping
   * the drop would delete the file. See the enumeration's docblock and the call
   * site for why the pairing with the delete-pass exemption forces that scope.
   *
   * ONE `update-index --force-remove -z --stdin` invocation, and both properties
   * of that spelling are load-bearing. `--force-remove` drops the INDEX entry and
   * leaves the file on disk, which is exactly the transition wanted (the path
   * returns to untracked, where the delete-pass exemption then protects it).
   * SINGLE invocation because git's index write is atomic — lock, write, rename —
   * so a failure leaves index and worktree untouched and the `derive-enumerations`
   * failure it reports is truthful. A per-path loop would have a half-applied
   * middle.
   *
   * CALLED AFTER THE SECOND `HEAD` READ, and that placement is the reason this is
   * a method of its own rather than the derivation's last statement. This is the
   * sequence's FIRST mutation, and the read in front of it exists so that a
   * `HEAD` moving while the derivation's listings ran refuses with nothing
   * applied — an arm Plan-004's wire mapping freezes as exactly that. Dropping
   * inside the derivation would have that refusal fire against an index this call
   * had already edited: a `head_moved` result reporting no mutation, next to a
   * user's unstaged intent-to-add entry that this code removed.
   *
   * Runs under the `derive-enumerations` step cursor with no step of its own: the
   * restore vocabulary is frozen at five members by Plan-004's wire mapping (see
   * {@link TurnSnapshotRestoreStep}, whose docblock carries the qualification this
   * makes necessary). The multi-reachable `close-index` is the precedent — one
   * step name already covers three distinguishable conditions there, and the
   * diagnostic `detail` is what tells them apart, which is what the thrown message
   * below does here.
   *
   * NO `GIT_INDEX_FILE` OVERLAY. This is the one index-touching leg in the module
   * that must reach the REAL index; pointing it at a scratch file would drop
   * entries from a temporary nobody reads and leave the live index exactly as
   * destructive as before.
   */
  async #dropBoundaryPathsFromLiveIndex(
    executionRoot: string,
    droppableEntries: readonly Buffer[],
  ): Promise<void> {
    if (droppableEntries.length === 0) {
      return;
    }
    try {
      await this.#runGit(["-C", executionRoot, "update-index", "--force-remove", "-z", "--stdin"], {
        stdin: joinNulTerminatedListing(droppableEntries),
      });
    } catch (reason: unknown) {
      // Re-thrown with the leg NAMED, because `derive-enumerations` covers three
      // things now (the object reads, the vintage gate and this drop) and the
      // diagnostic `detail` is the operator's only way to tell which stopped.
      throw new Error(
        `turn-snapshot could not drop sparse boundary paths from the index: ${describeRejection(reason)}`,
        { cause: reason },
      );
    }
  }

  /**
   * The embedded `HEAD` at `gitlinkPath`, or `null` when there is no repository
   * there to ask.
   *
   * The `.git` probe in front is not an optimization: `git -C <dir>` ASCENDS to
   * the enclosing repository when `<dir>` is an ordinary directory, so a
   * submodule path whose working copy was replaced by a plain directory would
   * otherwise report the SUPERPROJECT's `HEAD` as the embedded one. A `.git`
   * entry — the directory form, or the `gitdir:` file form a real submodule uses
   * — is what distinguishes the two.
   *
   * This probe KEEPS its symlink-following `stat`, adjudicated rather than
   * inherited, and it is the one consumer in this file that wants follow
   * semantics. The question the probe asks is not "is there an entry named
   * `.git`" but "is there a repository reachable through it", and only the
   * follow answers that. Measured on git 2.50.1, both directions:
   *   * a DANGLING `.git` symlink — `lstat` says present, `stat` says absent.
   *     Under `lstat` the probe would pass and `git -C` would ascend and return
   *     the superproject's `HEAD` at exit 0, i.e. the exact false match the
   *     probe exists to prevent, now dressed as a successful read.
   *   * a `.git` symlink to a REAL git dir — both agree present, and `git -C`
   *     returns the embedded repository's own `HEAD`, which is the right answer
   *     and the one the follow preserves.
   * So the fail-to-absent collapse is correct here for the same reason it is
   * correct in {@link fingerprintPath}: an unreadable probe resolves `null`,
   * which routes to "no repository there" rather than to a fabricated match.
   */
  async #resolveEmbeddedHead(gitlinkPath: string): Promise<string | null> {
    if (!(await pathExists(join(gitlinkPath, ".git")))) {
      return null;
    }
    return this.#readRevisionIfPresent(gitlinkPath, "HEAD");
  }

  /**
   * The untracked-delete pass, repeated to a FIXPOINT.
   *
   * One pass under-deletes, and the spec says why: the listing honours ignore
   * rules that post-snapshot untracked ignore files themselves supply, so a
   * turn-created untracked `.gitignore` shields what it ignores through the very
   * pass that deletes the `.gitignore`. Pass two then sees the un-hidden
   * content. Termination is the spec's argument — every non-final pass strictly
   * shrinks the untracked set and deleting files never adds ignore rules — with
   * {@link UNTRACKED_DELETE_PASS_LIMIT} standing behind it for the case that
   * argument does not cover.
   *
   * There are therefore TWO ways out other than the fixpoint, and they report
   * different things because they are different failures:
   *
   *   * NO PROGRESS — this pass's deletable set is byte-identical to the previous
   *     pass's, so the deletions did not delete and repeating is pointless. It
   *     fails immediately, naming a stuck path. The concrete case is a path name
   *     that is not valid UTF-8: the listing is split on the BUFFER and every
   *     DECISION here keeps those bytes, but the entry is decoded before it
   *     reaches {@link TurnSnapshotFilesystem}, so such a name arrives with
   *     replacement characters, `rm` finds nothing there, `force` swallows it, and
   *     git lists the same path forever. The complete fix is Buffer-typed paths
   *     through the seam, deliberately not taken while that seam stays
   *     mutation-only and three-verb — the capture leg keeps the same discipline
   *     and the same boundary (see {@link splitNulTerminatedListing}). What is NOT
   *     acceptable is grinding through every remaining pass — each one a full
   *     worktree walk under the caller's exclusive hold — before failing.
   *   * THE CEILING — {@link UNTRACKED_DELETE_PASS_LIMIT} passes each of which
   *     did change the listing. Unreachable through the pinned listing, and left
   *     standing behind the no-progress check for the shape it does not cover: a
   *     seam whose removals have side effects that keep producing NEW untracked
   *     content. Its off-by-one is recorded rather than closed: the final pass
   *     deletes and then throws without re-listing, so a cascade that converged
   *     on exactly the last pass is reported `partial_restore` despite being
   *     fully restored. That direction is the safe one — it under-claims success
   *     on an input the spec's own argument says cannot occur, and Spec-004's
   *     recovery is a fresh rollback that converges on its first pass — and the
   *     alternative is a git spawn on every ceiling failure to confirm a state
   *     nothing else needs.
   *
   * The pass cannot over-delete: at delete time the index still holds the
   * snapshot tree — tracked AND captured-untracked files, their `.gitignore`s
   * and any captured embedded repository's gitlink included — so only
   * post-snapshot untracked content is ever a candidate, and snapshot-declared
   * ignored paths (`node_modules`, build artifacts) are protected in every pass
   * by the {@link EXCLUDE_PER_DIRECTORY_GITIGNORE} pipeline.
   *
   * One BLIND SPOT, empirically established on git 2.50.1 rather than reasoned
   * about: `ls-files -o` does not descend into a path the index holds as a
   * `160000` gitlink, even when the working copy there is an ordinary directory
   * (a turn that deleted an embedded repository's `.git` and left its files).
   * So post-boundary untracked content inside a snapshot-gitlink path SURVIVES
   * the restore. That is the `submodule.recurse=false` boundary showing up as a
   * deletion that does not happen, where the divergence enumeration is the same
   * boundary showing up as a restore that does not happen; the path is reported
   * in `divergentGitlinks` either way, which is the whole signal the caller gets.
   *
   * The pass CAN over-delete in exactly one way, and `preservedPaths` is that
   * hole closed. An embedded repository the capture SKIPPED is absent from the
   * snapshot tree, so it looks identical to one the turn created: `ls-files -o`
   * names it `nested/` and the recursive removal above takes it whole — `.git`,
   * un-captured history and all. The two cases are indistinguishable on disk at
   * restore time, which is why the discriminator is carried from the capture in
   * the snapshot commit's own message ({@link
   * SKIPPED_EMBEDDED_REPOSITORIES_TRAILER}) rather than probed for here. The rule
   * the exemption expresses: THE DELETE PASS'S AUTHORITY IS THE SNAPSHOT, and a
   * path the capture declared out-of-snapshot is a path this pass has no
   * authority to delete. A turn-created nested repository is unaffected — it is
   * on no recorded list, and it is still deleted.
   *
   * Protection extends BENEATH each recorded path, on segment boundaries. The
   * listing usually names the repository itself, but a turn that removed its
   * `.git` makes `ls-files -o` descend and enumerate the payload file by file,
   * and deleting `nested/src/a.ts` one path at a time destroys the repository
   * just as completely as deleting `nested/`.
   *
   * NAMED RESIDUAL of the boundary exemption's byte-exactness, in the
   * fail-CLOSED direction: a turn-created path whose bytes are not valid UTF-8
   * used to alias onto a recorded boundary path once both decoded to U+FFFD and
   * was exempted by accident. It is now correctly deletable — and the removal
   * above cannot delete it, for the seam reason the no-progress bullet states, so
   * this pass stalls and the restore reports `partial_restore` at
   * `delete-untracked`. A restore that used to succeed by protecting the wrong
   * thing now fails honestly instead, which is the right side of that trade; the
   * shape is unreachable on a filesystem that rejects non-UTF-8 names (APFS does)
   * and closes entirely with a Buffer-typed seam.
   */
  async #deleteUntrackedToFixpoint(
    executionRoot: string,
    preservedPaths: readonly string[],
    sparseBoundarySet: SparseBoundarySet,
  ): Promise<void> {
    let previousDeletable: string | null = null;
    for (let pass = 0; pass < UNTRACKED_DELETE_PASS_LIMIT; pass += 1) {
      const listing: Buffer = (
        await this.#runGit(
          ["-C", executionRoot, "ls-files", "-o", EXCLUDE_PER_DIRECTORY_GITIGNORE, "-z"],
          {},
        )
      ).stdout;
      // BOTH termination checks run on the DELETABLE subset, not on the raw
      // listing, and that is the whole interlock rather than a refinement of it.
      // A preserved path is listed on every pass forever — it is never deleted —
      // so against the raw listing the empty check could never fire and the
      // byte-equality check would report "no progress" the moment the deletable
      // work finished. A correct restore would fail at `delete-untracked` purely
      // for having protected something.
      const deletable: readonly DeletableListingEntry[] = splitNulTerminatedListingBytes(listing)
        .map(
          (entry): DeletableListingEntry => ({
            key: listingEntryKey(entry),
            text: entry.toString("utf8"),
          }),
        )
        .filter(
          (entry) =>
            // TEXT against the skipped-repository list, KEY against the boundary
            // set, because the two trailers carry different kinds of string —
            // see {@link readJsonPathArrayTrailer}. Each comparison is like
            // against like, which is the only property either one needs.
            !isPreservedListingEntry(entry.text, preservedPaths) &&
            // The sparse exemption joins the DELETABLE computation, not the removal
            // site, and for exactly the interlock reason above: a boundary path is
            // never deleted either, so against the raw listing it would keep the
            // empty check from ever firing and make the byte-equality check report
            // "no progress" the moment the deletable work finished. A correct
            // restore of a sparse root would then fail at `delete-untracked` purely
            // for having protected something.
            !isSparseBoundaryListingEntry(entry.key, sparseBoundarySet),
        );
      if (deletable.length === 0) {
        return;
      }
      // Fingerprinted on the KEYS: two passes that listed byte-different paths
      // which merely decode alike are progress, and a decoded fingerprint would
      // call them a stall.
      const deletableKey: string = deletable.map((entry) => entry.key).join("\0");
      if (previousDeletable !== null && deletableKey === previousDeletable) {
        throw new Error(
          `turn-snapshot untracked-delete made no progress at ${deletable[0]?.text ?? "(unnamed path)"}`,
        );
      }
      previousDeletable = deletableKey;

      const emptiedDirectories = new Set<string>();
      for (const entry of deletable) {
        // A TRAILING SLASH is git reporting a directory it does not descend
        // into — a nested repository the turn created, the class `clean -ffd`'s
        // second `-f` exists for. The removal is recursive either way, which is
        // what takes such a directory whole; for a plain file it is an unlink.
        // It is also why the exemption has to filter BEFORE this line: there is
        // no partial form of this removal to fall back on.
        const relativePath: string = entry.text.endsWith("/")
          ? entry.text.slice(0, -1)
          : entry.text;
        await this.#filesystem.removePath(join(executionRoot, relativePath));
        const parent: string = dirname(relativePath);
        if (parent !== "." && parent !== "" && parent !== "/") {
          emptiedDirectories.add(parent);
        }
      }
      await this.#pruneEmptiedDirectories(executionRoot, emptiedDirectories);
    }
    throw new Error("turn-snapshot untracked-delete pass did not reach a fixpoint");
  }

  /**
   * Remove the directories the deletions emptied, walking each one's ancestors
   * up to — never including — the execution root.
   *
   * `removeDirectoryIfEmpty` is the guard: a directory that still holds snapshot
   * content is left alone by the kernel's own emptiness check rather than by a
   * read-then-delete race of ours. The walk climbs because deleting
   * `nested/deep/created.txt` empties `nested/deep` AND then `nested`, and stops
   * at `.` because the execution root is the caller's, not this leg's, to remove.
   */
  async #pruneEmptiedDirectories(
    executionRoot: string,
    directories: ReadonlySet<string>,
  ): Promise<void> {
    for (const directory of directories) {
      let current: string = directory;
      while (current !== "." && current !== "" && current !== "/") {
        await this.#filesystem.removeDirectoryIfEmpty(join(executionRoot, current));
        current = dirname(current);
      }
    }
  }

  /**
   * The one place a mid-sequence restore failure is reported: observe, diagnose,
   * then the typed result.
   *
   * The observation is deliberately git-free — one typed path fingerprint per
   * candidate — because it runs on the failure path, where the git seam is the
   * thing that just failed. An enumeration that needed a working git would
   * empty-wash exactly the report `Spec-010 §Turn-Boundary Snapshots` requires
   * never be empty-washed.
   *
   * BOTH candidate sets now apply one standard: an effect counts as applied when
   * {@link fingerprintPath} no longer matches the pre-mutation arm. For a
   * collision that means a vanished file included (its ignored content is gone
   * either way), and a path whose TYPE changed under identical bytes included
   * too, which a bytes-only comparison could not see.
   *
   * For a gitlink the shared standard replaces a `stat`-based "was it already a
   * directory?" boolean, and it changes three answers, each in the direction of
   * reporting a real effect the old form hid:
   *   * a SYMLINK to a directory, which `stat` could not tell from a directory,
   *     is now reported when the restore replaced it (the round-4 finding);
   *   * a divergent submodule directory the failed restore DELETED is now
   *     reported, where the boolean's `continue` skipped it as "present before";
   *   * a gitlink path holding a file whose bytes changed is now reported.
   * The one answer that must NOT change is preserved: a present-but-divergent
   * submodule the sequence never touched fingerprints `directory` on both sides,
   * compares equal, and stays unreported — because `submodule.recurse=false`
   * means the failed sequence applied nothing at that path (see the header).
   */
  async #failRestore(
    target: TurnSnapshotRestoreTarget,
    failedStep: TurnSnapshotRestoreStep,
    detail: string,
    prospectiveEffects: ProspectiveRestoreEffects,
  ): Promise<TurnSnapshotPartialRestore> {
    const overwrittenIgnoredPaths: string[] = [];
    for (const collision of prospectiveEffects.collisions) {
      const fingerprintNow: string = await fingerprintPath(
        join(target.executionRoot, collision.path),
      );
      if (fingerprintNow !== collision.fingerprintBeforeRestore) {
        overwrittenIgnoredPaths.push(collision.path);
      }
    }

    const divergentGitlinks: string[] = [];
    for (const divergence of prospectiveEffects.gitlinkDivergences) {
      const fingerprintNow: string = await fingerprintPath(
        join(target.executionRoot, divergence.path),
      );
      if (fingerprintNow !== divergence.fingerprintBeforeRestore) {
        divergentGitlinks.push(divergence.path);
      }
    }

    // The third re-observation, held to the standard the two above set: the
    // candidates were fixed before the checkout, and only the ones whose on-disk
    // state actually changed are reported. A sequence that failed at the
    // `read-tree` spawn leaves them all untouched and emits nothing — the checkout
    // is what discards an out-of-cone path, so a checkout that never ran discarded
    // none. A sequence that failed at `delete-untracked` or `close-index` has a
    // completed checkout behind it and reports the real set.
    await this.#emitMaterializedOutOfCone(target, prospectiveEffects);

    this.#emit({
      kind: "restore-failed",
      runId: target.runId,
      epoch: target.owningEpoch,
      turnOrdinal: target.targetPosition,
      ref: target.ref,
      failedStep,
      detail,
      overwrittenIgnoredPaths,
      divergentGitlinks,
    });

    return {
      outcome: "partial_restore",
      ref: target.ref,
      failedStep,
      overwrittenIgnoredPaths,
      divergentGitlinks,
    };
  }

  // ------------------------------------------------------------------------
  // Retention (T5.3)
  // ------------------------------------------------------------------------

  /**
   * Delete the snapshot refs of every run whose retention window has closed.
   *
   * The daemon's ONE retention trigger, and it serves both the plan's drivers
   * with the same code: a startup call is the "reconcile runs whose windows
   * elapsed while the daemon was down" pass — those runs are simply candidates
   * the first sweep finds — and the periodic call on the daemon cadence is the
   * ongoing one. Both are driven by {@link registerTurnSnapshotRetentionSweep}
   * at the foot of this file, which `../bootstrap/index.ts` calls.
   *
   * NEVER REJECTS on a runtime fault. This runs on a timer with nobody awaiting
   * it, where a rejection is an UNHANDLED rejection and Node's default
   * `--unhandled-rejections=throw` would take the daemon down over a removed
   * directory. So: a candidate read that fails becomes a `retention-sweep-failed`
   * diagnostic and an empty result, and a run that cannot be pruned is skipped,
   * enumerated in the pass's `retention-prune-skipped` diagnostic, and does not
   * strand the candidates behind it (the per-run `try` is INSIDE the loop).
   *
   * THE WARN CAN QUIESCE, and it has to be able to. Nothing memoizes an
   * already-skipped run (the header's first residual), so a skip class that
   * recurs by construction would fire this diagnostic every hour forever with a
   * list that only grows — and the genuine `EACCES` would be the line nobody
   * reads. So a pass whose skips are ALL disposed ephemeral clones emits
   * nothing, and a pass that emits reports those clones as a count beside the
   * skips an operator can act on. The plan row's "a run whose recorded
   * `git_common_dir` is missing … is skipped and enumerated in the sweep
   * diagnostic" is honored for exactly the case it names — a removed
   * REPOSITORY, `git-dir-absent` — while the clone-disposal boundary follows
   * the row's own other clause for it, "the sweep then finds nothing to delete".
   * Every skip of every class is on the RESULT regardless.
   *
   * It DOES throw for one condition, and the asymmetry is the point: a service
   * constructed without a `database` cannot answer the retention question at
   * all. Returning an empty result there would make a mis-wired daemon
   * indistinguishable from a daemon with nothing to prune — silent forever,
   * which is the exact failure this leg's diagnostics exist to prevent. That is
   * a programmer error at the composition root, on the same footing as the
   * un-minted-restore-target refusal in `restoreToTurn`. It is refused twice
   * over: the wiring call in `../bootstrap/index.ts` will not build a sweeper
   * without a handle at all, and {@link registerTurnSnapshotRetentionSweep}
   * contains the throw if one reaches it anyway, rather than letting a timer
   * callback carry it to the process.
   */
  async sweepPrunableRuns(): Promise<TurnSnapshotRetentionSweepResult> {
    // OUTSIDE the `try`, deliberately: this is the wiring-defect throw described
    // above, and the funnel below exists to swallow runtime faults, not to
    // convert a mis-wired daemon into a quiet no-op.
    const selectPrunableRuns = this.#selectPrunableRunsStmt;
    if (selectPrunableRuns === null) {
      throw new TypeError(RETENTION_WITHOUT_DATABASE_MESSAGE);
    }

    const examinedRunIds: string[] = [];
    const prunedRunIds: string[] = [];
    const deletedRefs: string[] = [];
    const skipped: TurnSnapshotRetentionSkip[] = [];

    try {
      const cutoff: string | null = this.#retentionCutoff();
      if (cutoff === null) {
        // Widened past "the clock is bad": the cutoff also fails to exist when a
        // representable clock and a constructor-accepted window differ into a
        // value outside Date's range, and a message naming only the clock would
        // send that reader hunting the wrong term.
        throw new Error("turn-snapshot retention cutoff is not a representable instant");
      }
      const candidates: readonly PrunableRunRow[] = selectPrunableRuns.all({
        released_before: cutoff,
        excluded_mode: READ_ONLY_EXECUTION_MODE,
      });
      for (const candidate of candidates) {
        examinedRunIds.push(candidate.run_id);
        const outcome: TurnSnapshotRetentionPruneResult = await this.#pruneRunRefs(
          candidate.run_id,
          candidate.git_common_dir,
          candidate.execution_mode,
        );
        deletedRefs.push(...outcome.deletedRefs);
        if (outcome.skipped === null) {
          prunedRunIds.push(candidate.run_id);
        } else {
          skipped.push(outcome.skipped);
        }
      }
    } catch (reason: unknown) {
      // The candidate read, the clock, and anything `#pruneRunRefs` did not
      // already convert into a skip. Its own `try` is per-ref, so a leak from
      // there is a fault in this module rather than in the repository — and it
      // still must not reject into a timer callback.
      this.#emit({ kind: "retention-sweep-failed", detail: describeRejection(reason) });
    } finally {
      // A `finally`, not a tail statement: a pass that failed halfway still
      // skipped the runs it skipped, and losing that enumeration would report
      // the fault while hiding which runs it stranded.
      //
      // The partition, and the gate: an expected-absence skip never RAISES the
      // diagnostic and is never enumerated in it, only counted. See the method
      // docblock for why a diagnostic that cannot go quiet is a diagnostic
      // nobody reads.
      const actionableSkips: TurnSnapshotRetentionSkip[] = skipped.filter(
        (entry: TurnSnapshotRetentionSkip): boolean => !NON_ALARMING_SKIP_REASONS.has(entry.reason),
      );
      if (actionableSkips.length > 0) {
        this.#emit({
          kind: "retention-prune-skipped",
          skipped: actionableSkips,
          disposedCloneCount: skipped.length - actionableSkips.length,
          examinedRunCount: examinedRunIds.length,
        });
      }
    }

    return { examinedRunIds, prunedRunIds, deletedRefs, skipped };
  }

  /**
   * Delete one run's snapshot refs, whatever its retention window says.
   *
   * The idempotent per-run primitive; the sweep runs the same ref ops through
   * `#pruneRunRefs` with the row it already read, so the row lookup below is
   * reached only from HERE. A second prune of an already-pruned run enumerates
   * nothing and therefore deletes nothing, returning empty `deletedRefs` with
   * `skipped: null`. It is idempotent by
   * CONSTRUCTION rather than by a guard — there is no "was this already pruned"
   * state anywhere, which is also why a run that never captured and a run pruned
   * an hour ago produce the identical answer.
   *
   * UNCONDITIONAL on the window, and that division is deliberate: the window is
   * the sweep's predicate (`Spec-010 §Turn-Boundary Snapshots` attaches it to
   * "the run's retention window closes", which is what the sweep asks), and this
   * is the primitive underneath — the same split `./ephemeral-clone-service.ts`
   * makes between its TTL-driven `cleanupTick` and its unconditional `dispose`.
   * The consequence, stated rather than hidden: calling this for a LIVE run
   * deletes that run's snapshots and its rollback then has nothing to restore
   * into. Nothing in the daemon does that today — the sweeper is the only
   * trigger, and CP-010-12 keeps retention out of the B9 turn-boundary caller.
   *
   * Never rejects on a runtime fault, for the sweep's reasons; the missing-
   * `database` throw is the same programmer-error path documented on
   * {@link TurnSnapshotService.sweepPrunableRuns}.
   */
  async pruneSnapshotsForRun(runId: string): Promise<TurnSnapshotRetentionPruneResult> {
    const selectRunContext = this.#selectRunContextStmt;
    if (selectRunContext === null) {
      throw new TypeError(RETENTION_WITHOUT_DATABASE_MESSAGE);
    }

    let row: PrunableRunRow | undefined;
    try {
      row = selectRunContext.get({ run_id: runId });
    } catch (reason: unknown) {
      // "I could not look" — a closed handle racing a shutdown, a schema fault.
      // Its OWN reason, because a caller switching on the vocabulary would
      // otherwise conclude the run has no execution context and there was
      // nothing to prune, when the refs are still there and the prune must be
      // retried. Diagnosed as well as returned, matching what the sweep does
      // with its own failed candidate read: the two are the same fault.
      const detail: string = describeRejection(reason);
      // `runId` is what makes this emission attributable — the sweep's emitter
      // of the same kind is pass-scoped and omits it.
      this.#emit({ kind: "retention-sweep-failed", detail, runId });
      return this.#skipPrune(runId, "run-context-unreadable", detail);
    }
    if (row === undefined) {
      // Not a fault: a run the daemon has no execution context for has no
      // recorded git dir, so there is no repository to prune IN. Reported as a
      // skip rather than as an empty success, because "I found nothing" and "I
      // could not look" are the two answers this leg must never conflate.
      return this.#skipPrune(runId, "run-context-absent", "no run_execution_contexts row");
    }
    return this.#pruneRunRefs(runId, row.git_common_dir, row.execution_mode);
  }

  /**
   * The ref ops, shared by both entry points above so the sweep never re-reads a
   * row it already has and the primitive never duplicates the recipe.
   *
   * The `runId` validation lives HERE rather than in the two callers, and that
   * is structural for the same reason `#runGit` is: this is the only path from
   * either entry point to a git invocation, so I-010-21's "no caller-supplied
   * string reaches a ref path unvalidated" holds by there being nowhere else to
   * go. It covers the sweep's DB-sourced ids as well as the primitive's
   * caller-supplied one — the table is written by the T3.2 gate with
   * event-sourced UUIDs, and the guard costs a regex either way.
   */
  async #pruneRunRefs(
    runId: string,
    gitCommonDir: string,
    executionMode: string,
  ): Promise<TurnSnapshotRetentionPruneResult> {
    if (!isSafeRefComponent(runId)) {
      return this.#skipPrune(runId, "unsafe-run-id", "run id is not a safe ref path component");
    }
    const refPrefix: string = buildRunSnapshotRefPrefix(runId);

    // `--git-dir=<git_common_dir>`, NEVER the execution root — see the header.
    // The pattern's trailing slash scopes the match to this run's own segment
    // (confirmed on git 2.50.1: a sibling `run-AB` is not matched by a
    // `run-A/` pattern), and the format carries the oid each deletion needs.
    let listing: TurnSnapshotGitInvocationResult;
    try {
      listing = await this.#runGit(
        [
          `--git-dir=${gitCommonDir}`,
          "for-each-ref",
          "--format=%(objectname) %(refname)",
          refPrefix,
        ],
        {},
      );
    } catch (reason: unknown) {
      // The plan's named skip: "a run whose recorded `git_common_dir` is missing
      // or invalid at sweep time (the repo was removed) is skipped and
      // enumerated in the sweep diagnostic, never fatal". git reports it as
      // `fatal: not a git repository`, exit 128.
      //
      // ATTRIBUTED rather than assumed, and by a probe rather than by parsing
      // git's stderr — the T5.2 discipline in this same file, where a failed
      // resolve gets its own second question instead of folding into the absent
      // case. git answers this one rejection for a removed repository, a
      // disposed clone, an `EACCES` on a live store, a missing `git` binary and
      // a failure creating the daemon's OWN hook-neutralization directory
      // (`#runGit` creates it before spawning), and the last three are faults
      // where the first two are outcomes. One `stat` on the failure path buys
      // the distinction; the happy path pays nothing.
      return this.#skipPrune(
        runId,
        await this.#classifyGitDirFailure(gitCommonDir, executionMode),
        describeRejection(reason),
      );
    }

    const deletedRefs: string[] = [];
    for (const entry of parseSnapshotRefListing(listing.stdout, refPrefix)) {
      try {
        // `--no-deref` closes I-010-21's THIRD channel here, and it is the second
        // guard on the delete side, beside the listing prefix re-check. They are
        // not interchangeable: the prefix check validates the name git REPORTED,
        // while `update-ref -d` acts on what that name RESOLVES to, and those
        // differ for one input — a symbolic ref planted inside the run namespace
        // (`git symbolic-ref refs/sidekicks/runs/<id>/epoch-0/turn-9
        // refs/heads/main` — a cheap, non-destructive write available to anything
        // sharing the repo, which is this product's own threat surface). Nothing
        // upstream can catch it: `for-each-ref` resolves `%(objectname)` THROUGH
        // the symref, so the listing entry is a 40-hex oid at an in-prefix name
        // and the parser rightly accepts it, and the compare-and-swap matches
        // because the oid it names is already the referent's.
        //
        // Measured on git 2.50.1 rather than taken from the flag's description.
        // WITHOUT it, `update-ref -d <symref> <referent tip>` deletes
        // `refs/heads/main` and leaves the symref dangling — exit 0, reported as
        // a clean prune, a week after release and outside any approval path.
        // WITH it, the same command deletes the symref ITSELF and `refs/heads/`
        // is byte-identical afterwards. For a direct ref — every ref this service
        // writes — it is a no-op, also measured. So the flag costs nothing on the
        // path that exists and closes the one a hostile write opens.
        await this.#runGit(
          [
            `--git-dir=${gitCommonDir}`,
            "update-ref",
            "--no-deref",
            "-d",
            entry.ref,
            entry.objectId,
          ],
          {},
        );
      } catch (reason: unknown) {
        // STOPS at the first refusal rather than pressing on through the rest.
        // One run's refs share one git dir and one lock domain, so a failure at
        // ref K is overwhelmingly the same condition at ref K+1 — a read-only
        // directory, a removal mid-pass — and pressing on would spend a doomed
        // process per remaining ref. Nothing durable is lost: the leg is
        // idempotent, so the next sweep re-enumerates exactly what survived.
        // The refs already deleted are still reported, because they really were.
        return {
          runId,
          deletedRefs,
          skipped: {
            runId,
            reason: "ref-delete-failed",
            detail: `${entry.ref}: ${describeRejection(reason)}`,
          },
        };
      }
      deletedRefs.push(entry.ref);
    }
    return { runId, deletedRefs, skipped: null };
  }

  /**
   * Which of the three git-dir skip reasons a failed enumeration earned.
   *
   * The mode is the second half of the answer and the DDL says why: for
   * `ephemeral clone` the recorded common dir is the clone's OWN git dir, whose
   * lifecycle is the clone's, so its absence is the T2.3 disposal working. For
   * every other mode the recorded dir belongs to a repository nobody was
   * supposed to delete, so the same absence is news.
   *
   * The probe itself is contained: a `stat` that rejects for an exotic reason
   * resolves "not provably absent" (see {@link isPathProvablyAbsent}) and the
   * run lands in the fault arm, which is the direction that gets looked at.
   */
  async #classifyGitDirFailure(
    gitCommonDir: string,
    executionMode: string,
  ): Promise<TurnSnapshotRetentionSkipReason> {
    if (!(await isPathProvablyAbsent(gitCommonDir))) {
      return "git-dir-unusable";
    }
    return executionMode === EPHEMERAL_CLONE_EXECUTION_MODE ? "clone-disposed" : "git-dir-absent";
  }

  /** A prune that deleted nothing, carrying why. */
  #skipPrune(
    runId: string,
    reason: TurnSnapshotRetentionSkipReason,
    detail: string,
  ): TurnSnapshotRetentionPruneResult {
    return { runId, deletedRefs: [], skipped: { runId, reason, detail } };
  }

  /**
   * `now - retentionWindow`, in the spelling `released_at` is compared against,
   * or `null` when that difference is not a representable instant.
   *
   * The subtraction runs on MILLISECONDS and the comparison on the re-serialized
   * ISO string, so the window arithmetic is never a string operation — which is
   * what keeps a month or year boundary from being a special case.
   *
   * The `null` channel covers BOTH ways the difference goes bad, because they
   * are the same observation and deserve one mechanism rather than two. A clock
   * that did not return an ISO-8601 instant makes `Date.parse` `NaN`, and a
   * difference outside ECMAScript's Date range is `NaN` once constructed; asking
   * the constructed Date for `getTime()` detects the union exactly (measured
   * against `toISOString()`'s own throw across both boundaries and both
   * overflow directions — zero disagreements). The range half is the defense
   * {@link MAXIMUM_RETENTION_WINDOW_MS} cannot provide: the constructor bounds
   * the window, but the window is one of two terms, and a clock far enough from
   * the epoch overflows a window that bound accepted.
   *
   * `null` rather than a throw because the caller already has the channel, and
   * routing here keeps the failure a reported skip instead of a `RangeError`
   * raised from inside the sweep's own `try` — the shape that let one accepted
   * configuration disable retention silently.
   */
  #retentionCutoff(): string | null {
    const cutoff = new Date(Date.parse(this.#now()) - this.#retentionWindowMs);
    if (Number.isNaN(cutoff.getTime())) {
      return null;
    }
    return cutoff.toISOString();
  }

  // ------------------------------------------------------------------------
  // Internals — plumbing
  // ------------------------------------------------------------------------

  /**
   * The single git entry point. Prepends the two hook-neutralization flags and
   * nothing else, so I-010-10's quantifier holds structurally (see the header
   * and `./worktree-service.ts`'s fuller treatment).
   */
  async #runGit(
    argv: readonly string[],
    options: {
      readonly environmentOverrides?: Readonly<Record<string, string>>;
      readonly stdin?: Buffer;
    },
  ): Promise<TurnSnapshotGitInvocationResult> {
    await this.#filesystem.createDirectory(this.#hookNeutralizationDirectory);
    return this.#git(
      [
        "-c",
        `core.hooksPath=${this.#hookNeutralizationDirectory}`,
        "-c",
        "core.fsmonitor=false",
        ...argv,
      ],
      {
        timeoutMs: this.#gitCommandTimeoutMs,
        ...(options.environmentOverrides === undefined
          ? {}
          : { environmentOverrides: options.environmentOverrides }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      },
    );
  }

  /**
   * Re-observe the materialization candidates and emit the subset the restore
   * actually discarded.
   *
   * RE-OBSERVED, not replayed, and that is the whole content of this method. The
   * candidate list was fixed before the checkout; what this reports is the part
   * of it whose on-disk state then CHANGED, measured with the same
   * {@link fingerprintPath} standard the collision and gitlink enumerations use.
   * A `partial_restore` that never reached the checkout — a refusal at the second
   * `HEAD` read, a `read-tree` that failed at the spawn — leaves every candidate
   * byte-identical, so nothing is emitted and no claim is made about work that
   * did not happen. The ordinary success case moves every one of them (the
   * re-projection un-materializes the out-of-cone path, so its fingerprint goes
   * from `file:<hash>` to `absent`), which is why the discipline costs nothing in
   * the case it is most often exercised on.
   *
   * A path that reappeared byte-identical would be omitted, which is the correct
   * reading here and differs from the collision enumeration's: a collision
   * reports paths the restore OVERWROTE, so identical bytes still count, while
   * this reports paths the restore DISCARDED from the worktree, and a path still
   * sitting there in the same state was not discarded.
   *
   * Factored because BOTH restore tails call it and the rule has to be the same
   * on each — a different standard on one would make the diagnostic report which
   * arm the restore took rather than what it did to the worktree. Empty in every
   * non-sparse root by construction, so a non-sparse restore's diagnostic stream
   * is byte-unchanged by this closure. Called ONCE per restore: on the success
   * tail it sits after the last leg that can fail, so a late failure routes to
   * the reporter instead of adding a second emission of the same payload.
   */
  async #emitMaterializedOutOfCone(
    target: TurnSnapshotRestoreTarget,
    prospectiveEffects: ProspectiveRestoreEffects,
  ): Promise<void> {
    const discardedPaths: string[] = [];
    for (const candidate of prospectiveEffects.materializedOutOfCone) {
      const fingerprintNow: string = await fingerprintPath(
        join(target.executionRoot, candidate.path),
      );
      if (fingerprintNow !== candidate.fingerprintBeforeRestore) {
        discardedPaths.push(candidate.path);
      }
    }
    if (discardedPaths.length === 0) {
      return;
    }
    this.#emit({
      kind: "sparse-out-of-cone-materialized",
      runId: target.runId,
      epoch: target.owningEpoch,
      turnOrdinal: target.targetPosition,
      ref: target.ref,
      materializedPaths: discardedPaths,
    });
  }

  /** See {@link OBJECT_ID_PATTERN}. Throws into the funnel on anything else. */
  #requireObjectId(stdout: Buffer): string {
    const candidate: string = stdout.toString("utf8").trim();
    if (!OBJECT_ID_PATTERN.test(candidate)) {
      throw new Error("git did not report an object id");
    }
    return candidate;
  }

  /** The one place a capture failure is reported: diagnostic, then typed result. */
  #failCapture(
    input: CaptureTurnSnapshotInput,
    ref: string | null,
    failedStep: TurnSnapshotCaptureStep,
    detail: string,
  ): TurnSnapshotCaptureFailed {
    this.#emit({
      kind: "capture-failed",
      runId: input.runId,
      epoch: input.epoch,
      turnOrdinal: input.turnOrdinal,
      ref,
      failedStep,
      detail,
    });
    return { outcome: "failed", ref, failedStep };
  }

  /**
   * Diagnostics are best-effort. A sink that throws must not become the
   * turn-blocking failure the whole capture path is written to avoid — and on
   * the failure path it would arrive from inside the failure reporter itself.
   *
   * The `try` contains the SYNCHRONOUS half. `Promise.resolve(…).catch(…)`
   * contains the other half, which the `try` cannot see: the seam is declared
   * `(diagnostic) => void`, and TypeScript's void-return assignability admits an
   * `async` implementation — an OTel exporter, most likely — whose returned
   * promise nobody is holding. A transient export failure then rejects a promise
   * with no handler, and Node's default `--unhandled-rejections=throw` takes the
   * daemon down: precisely the turn-blocking outcome this method exists to
   * prevent, arriving by the one path a `try` misses. Repo-wide ESLint is
   * non-type-aware, so `no-misused-promises` is not standing here either.
   */
  #emit(diagnostic: TurnSnapshotDiagnostic): void {
    try {
      void Promise.resolve(this.#emitDiagnostic(diagnostic)).catch(() => {
        // See the docblock: an async sink's rejection is swallowed as well.
      });
    } catch {
      // See the docblock: swallowed on purpose.
    }
  }
}

// --------------------------------------------------------------------------
// The retention sweeper driver (T5.3)
// --------------------------------------------------------------------------
//
// OWNED HERE, called from `../bootstrap/index.ts`. That split is the shape
// `docs/architecture/cross-plan-dependencies.md` §2 sanctions for this edit and
// the Plan-026 precedent it names: the `register…` function lives in the owning
// plan's own namespace (CP-010-7 grants Plan-010 this `src/git/` subtree
// outright), and only the CALL wires into the Plan-007-owned bootstrap file.
//
// An earlier draft of this task put the whole driver in `bootstrap/index.ts` and
// argued that a typed collaborator there "would make this Plan-007 file import
// Plan-010's module — ownership by the back door". That argument was WRONG and is
// recorded here rather than quietly dropped: the same §2 row sanctions Plan-006
// constructing an `EventLogService` inside that very file and calls it "a wiring
// call, not ownership". Importing a plan's module into `bootstrap/index.ts` IS
// the sanctioned shape; what would be ownership is the driver body, which is why
// it lives here.

/** What a composition root hands {@link registerTurnSnapshotRetentionSweep}. */
export interface TurnSnapshotRetentionSweepRegistration {
  /**
   * One retention pass. In production this is
   * `() => turnSnapshotService.sweepPrunableRuns()`, bound at the sanctioned
   * wiring call in `../bootstrap/index.ts`.
   *
   * A BARE CALLABLE rather than a {@link TurnSnapshotService}, on grounds that
   * survive the relocation above: this is a lifecycle driver, and the two things
   * it actually guarantees — that a rejecting sweeper cannot reach the process
   * and that a THROWING one cannot either — are then assertable with plain
   * functions instead of a cast against a class that makes one of them
   * unreachable by construction. It does NOT assume the sweeper honours
   * `sweepPrunableRuns`'s never-rejects posture: a rejection inside a timer
   * callback with nobody awaiting it is an unhandled rejection that takes the
   * daemon down. The cost, accepted: the type system does not stop a composition
   * root binding the wrong callable — mitigated by there being exactly one
   * production binding site, in the file the ownership map points at.
   */
  readonly runRetentionSweep: () => Promise<unknown>;
  /**
   * How often the periodic sweep runs, in milliseconds. Daemon configuration;
   * defaults to {@link DEFAULT_TURN_SNAPSHOT_SWEEP_CADENCE_MS}, the same way the
   * retention window defaults on the service.
   *
   * MUST be a positive integer no larger than {@link MAXIMUM_TIMER_DELAY_MS}.
   * Refused rather than normalized — see the `@throws` on the function.
   */
  readonly sweepCadenceMs?: number;
  /**
   * Where a sweep that REJECTED is reported. Defaults to a `console.warn`
   * rendering, the same interim sink the daemon's other diagnostic seams use
   * until an OpenTelemetry substrate exists.
   *
   * Reports the SEAM's failures only. A sweep that ran and skipped some runs
   * reports that through the service's own diagnostic sink; this hears about the
   * sweep that could not run at all — a mis-wired sweeper, most plausibly.
   */
  readonly reportSweepFailure?: (reason: unknown) => void;
}

/** The shutdown half of {@link registerTurnSnapshotRetentionSweep}. */
export interface TurnSnapshotRetentionSweepHandle {
  /**
   * Stops the periodic sweep.
   *
   * Idempotent, and by `clearInterval` itself being a no-op on a timer already
   * cleared rather than by a flag this object keeps — a flag would be state
   * nothing could observe, which is a worse thing to maintain than the property
   * it claims to provide. A sweep already IN FLIGHT runs to completion: it holds
   * no resource this handle owns, and cancelling a half-finished ref deletion
   * would leave exactly the partial state the leg's idempotence exists to make
   * harmless anyway.
   */
  dispose(): void;
}

/**
 * The largest delay Node's timers accept before wrapping. A delay above this —
 * like a delay below `1`, fractional ones included — is silently coerced to
 * `1 ms`, which is why the cadence guard has an upper bound at all.
 */
const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Start the turn-snapshot retention sweeper: one immediate reconcile pass, then
 * a periodic sweep on the supplied cadence, until the returned handle is
 * disposed.
 *
 * ORDERING OBLIGATION, and it is the caller's. This must run AFTER database
 * migrations have been applied, because the sweeper reads
 * `run_execution_contexts` on its very first pass. The wiring call in
 * `../bootstrap/index.ts` takes an already-open handle for that reason, which
 * discharges the obligation by construction rather than by comment.
 *
 * The two drivers the Plan-010 T5.3 row names are both here:
 *
 *   * the DAEMON-STARTUP RECONCILE — the immediate pass, which prunes runs whose
 *     retention windows elapsed while the daemon was down. Kicked off ASYNC and
 *     NON-BLOCKING: retention is housekeeping, and a daemon that waited on a git
 *     walk before opening its listeners would have made a background concern into
 *     a startup latency. A failure is diagnosed, never thrown.
 *   * the PERIODIC SWEEP on the daemon-owned cadence.
 *
 * Overlapping ticks are suppressed. A sweep still in flight when the next tick
 * fires causes that tick to be skipped rather than a second concurrent pass: two
 * sweeps enumerate the same refs and race each other's deletions, and on a daemon
 * whose sweep is slower than its cadence the passes would otherwise pile up
 * without bound. The skipped tick costs nothing — the next one re-enumerates
 * whatever is left, the sweep being idempotent.
 *
 * The interval is `unref`'d, so a composition root that forgets to `dispose()`
 * cannot by itself keep the process alive at shutdown. It is a safety net and not
 * a substitute: an undisposed sweeper still fires for as long as anything else
 * holds the loop open.
 *
 * @throws RangeError when `sweepCadenceMs` is present and is not a positive
 * integer of at most {@link MAXIMUM_TIMER_DELAY_MS} milliseconds.
 */
export function registerTurnSnapshotRetentionSweep(
  registration: TurnSnapshotRetentionSweepRegistration,
): TurnSnapshotRetentionSweepHandle {
  // Resolved first, then validated: an absent cadence is the DEFAULT and not a
  // refusal, which is what makes the cadence daemon config on the same footing
  // as the retention window.
  const sweepCadenceMs: number =
    registration.sweepCadenceMs ?? DEFAULT_TURN_SNAPSHOT_SWEEP_CADENCE_MS;
  // Every arm here is one of Node's timer coercions, and they are the reason for
  // the shape of the check rather than a tidier `> 0`. A delay of `0`, a negative
  // one, `NaN`, `Infinity`, a FRACTIONAL one below `1`, and one ABOVE
  // 2147483647 all become a 1 ms interval — so a plausible monthly cadence
  // (`DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS * 4` = 2419200000) would pass a
  // positive-and-finite check and then spawn `git for-each-ref` against every
  // historical run a thousand times a second. Refused rather than normalized,
  // because a daemon that quietly reinterprets a monthly cadence as 1 ms is worse
  // than one that will not start.
  if (
    !Number.isInteger(sweepCadenceMs) ||
    sweepCadenceMs < 1 ||
    sweepCadenceMs > MAXIMUM_TIMER_DELAY_MS
  ) {
    throw new RangeError(
      "registerTurnSnapshotRetentionSweep: sweepCadenceMs must be a positive integer of at " +
        `most ${String(MAXIMUM_TIMER_DELAY_MS)} milliseconds (received ${String(sweepCadenceMs)})`,
    );
  }

  // Guarded in turn, on BOTH halves, because this is called from inside a `.catch`
  // handler: whatever escapes here rejects the promise that handler settles, with
  // no further handler attached — the unhandled rejection this whole wrapper
  // exists to prevent, arriving by the one path a `try` around the sweep would
  // miss. A synchronous throw is the `catch` below. An ASYNCHRONOUS rejection is
  // the attached `.catch`, and it needs one because the seam is typed
  // `(reason: unknown) => void`: void-return assignability accepts an `async`
  // reporter, whose returned promise the surrounding `try` cannot see, let alone
  // contain. `Promise.resolve(…)` wraps the call so a reporter returning nothing
  // — which the type invites and erased types permit — does not make `.catch` a
  // TypeError. This is the turn-snapshot service's own `#emit` idiom, for the
  // same reason and in the same order.
  const reportSweepFailure = (reason: unknown): void => {
    try {
      const report: ((reason: unknown) => void) | undefined = registration.reportSweepFailure;
      if (report === undefined) {
        console.warn("turn-snapshot retention sweep failed", reason);
        return;
      }
      void Promise.resolve(report(reason)).catch(() => {
        /* an async reporter's rejection must not become the failure it was reporting */
      });
    } catch {
      /* a reporter that throws must not become the failure it was reporting */
    }
  };

  let sweepInFlight = false;
  const runSweepGuarded = (): void => {
    if (sweepInFlight) {
      return;
    }
    sweepInFlight = true;
    try {
      // `Promise.resolve(…)` rather than the returned promise directly: the seam
      // is typed `() => Promise<unknown>`, and an implementation that returned a
      // thenable — or nothing at all, which erased types permit at a JS call site
      // — would otherwise make `.catch` a TypeError right here.
      void Promise.resolve(registration.runRetentionSweep())
        .catch(reportSweepFailure)
        .finally(() => {
          sweepInFlight = false;
        });
    } catch (reason: unknown) {
      // A sweeper that threw SYNCHRONOUSLY, before returning a promise at all —
      // which no `.catch` can ever see, since there is no promise to attach one
      // to. That is a NON-`async` implementation of the seam; it is NOT the
      // Plan-010 missing-`database` wiring defect, whose `TypeError` is raised
      // inside an `async` method and therefore always arrives as a REJECTION on
      // the `.catch` path above. Both guards exist because those are two
      // different paths, and the one that carries the known production defect is
      // the other one.
      sweepInFlight = false;
      reportSweepFailure(reason);
    }
  };

  runSweepGuarded();

  const sweepInterval: NodeJS.Timeout = setInterval(runSweepGuarded, sweepCadenceMs);
  sweepInterval.unref();

  return {
    dispose(): void {
      clearInterval(sweepInterval);
    },
  };
}
