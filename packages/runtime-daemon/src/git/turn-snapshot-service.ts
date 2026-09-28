// Turn-snapshot service — the daemon-side owner of the per-run snapshot refs
// under `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>`.
//
// Two legs: the CAPTURE leg and the window-based RETENTION prune. The class, the
// git invocation layer, the ref builders and the diagnostic seam below are
// written once for both.
//
//   * the capture temp-index recipe (out-of-worktree `GIT_INDEX_FILE`, the
//     check-in leg's conversion pins plus `GIT_ATTR_NOSYSTEM=1` — see the closed
//     disposition table below for every knob and its setting — the single base
//     OID reused for tree base AND recorded parent, the untracked-embedded-repo
//     `160000` normalization with its unborn-`HEAD` skip, the encoding-pinned
//     `commit-tree`, the six-var host-independence env set), the
//     epoch-namespaced create-only ref write and its per-epoch idempotence.
//   * the execution epoch `<E>`: `0` before any rollback, advanced with each
//     accepted `run.rolled_back`. SUPPLIED by the caller and never derived here.
//
// ---------------------------------------------------------------------------
// The capture leg resolves NOTHING
// ---------------------------------------------------------------------------
//
// `executionRoot`, `runId`, `epoch` and `turnOrdinal` all arrive as parameters.
// The capture leg does not read `run_execution_contexts` or derive the epoch
// from rollback history. Every execution mode snapshots, so the capture takes
// no mode. The production call site — the run engine's turn boundary — owns
// every one of those resolutions.
//
// The RETENTION leg is the one exception: it reads `released_at` and
// `git_common_dir` from `run_execution_contexts` itself (see
// {@link TurnSnapshotService.sweepPrunableRuns}).
//
// ---------------------------------------------------------------------------
// The namespace is enforced at THIS layer, not by git
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
// is cruder still: set WITHOUT `GIT_DIR`, the pipeline's first leg (`rev-parse
// --verify HEAD` through `-C <root>`) refuses with `not a git repository`, exit
// 128 — observed on that leg and on `hash-object -w`.
//
// A later probe on git 2.50.1 generalized that finding rather than leaving it
// scoped to those two: `rev-parse --show-toplevel`, `rev-parse --git-dir`,
// `rev-parse --git-common-dir` and `status --porcelain` all draw the same
// refusal, so it is not a property of the legs happened to run. The same probe
// pinned the MECHANISM: an accessible-but-unreadable value (a mode-`111`
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
// not as the mechanism enforcing.
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
// written by this service. That bounds what the reading leg may claim — see
// {@link TurnSnapshotAlreadyCaptured}.
//
// ---------------------------------------------------------------------------
// The CAS is the arbiter; nothing pre-checks it
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
// others: the closing index reset honors it deliberately, and pinning there
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
//     a member to the finding above: `core.useReplaceRefs` was here and
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
//     these two legs by construction (and section below). Listed here because a
//     table claiming a closed population may not omit a knob merely because
//     another mechanism already closed it.
//   * `core.useReplaceRefs=false`, on every leg that INTERPRETS a recorded object
//     id: the destructive checkout, the delete pass's snapshot-tree listing, the
//     lineage parent read, the capture's index seed, and the snapshot message
//     read that recovers the skipped-repository trailer. `refs/replace/<oid>`
//     substitutes one object for another transparently, so a ref an attacker
//     cannot write is not the same protection as an object id an attacker cannot
//     redirect — and this service's whole restore-side safety argument is stated
//     in frozen object ids. Reproduced on git 2.50.1: with `git replace
//     <snapshotCommit> <attacker>`, the attacker commit carrying the SAME parent
//     and a different tree, every HEAD guard still passes — the parents compare
//     equal — while `ls-tree` of the frozen id enumerates the ATTACKER's paths
//     and `read-tree --reset -u` of it writes the ATTACKER's bytes at exit 0.
//     That is a restore reporting success having written something other than
//     what it verified, which is the one outcome the fail-closed posture exists
//     to prevent. Pinned, the same fixture restores the original tree. The
//     CAPTURE seed is in the set on its own measurement rather than by analogy,
//     because most seed damage is self-correcting: `update-index --add --remove`
//     re-lists and re-stats, so a phantom path from a replacement tree is dropped
//     again. The class that SURVIVES is a path both index-tracked and
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
//     identical on every host, so honoring it is what makes a restored worktree
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
//     `false` would degrade every host that does support them. Honoring it means
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
//     contract states. PINNED reproduces porcelain under a DIFFERENT config than
//     the host actually has, which is not a fix; it is a second opinion about the
//     operator's repository. The mechanism is this file's own stat-family row:
//     the scratch index a capture seeds carries NO stat data, so `update-index`
//     re-stats every listed path, and under a `true` pin each TRACKED file's mode
//     then comes from lstat — discarding the mode its base commit recorded. That
//     is the `100755 → 100644` cell, and it is the dangerous direction: a
//     recorded exec bit lost for a file the turn never meant to change. REASONED,
//     NOT MEASURED — the mechanism above is measured; this consequence of it is
//     not, for want of the host. On a bit-incapable filesystem (a `vfat`/`exFAT`
//     mount, or Windows, a V1 shipping tier) git's own probe writes
//     `core.fileMode=false` precisely because lstat cannot report the bit
//     truthfully. A `true` pin there would feed that fabrication into EVERY
//     tracked file's recorded mode, turning a per-turn annoyance into
//     recorded-bit loss across the snapshot. RESIDUAL, recorded rather than
//     closed: honoring the knob means a preference-set or stale `false` on a
//     capable filesystem loses a turn-created executable's bit, and records a
//     boundary `chmod` of a tracked file as that file's stale recorded mode. A
//     stale `false` is narrow — git's probe never writes it on a capable
//     filesystem, so it takes an explicit preference or a repository moved across
//     filesystems.
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
//     which is that finding's second correction: the sweep drives the
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
// rather than pinning or tolerating it.
//
//   * `core.sparseCheckout` (with `core.sparseCheckoutCone`, `index.sparse` and
//     `$GIT_DIR/info/sparse-checkout`). This was the table's largest RECORDED
//     RESIDUAL and is now closed, so the row records both the defect and its
//     closure — a reader checking the closure needs the shape of what it closed.
//
//     THE DEFECT, as measured before: the scratch index a capture seeded with
//     `read-tree <base>` carries no skip-worktree bits, so `ls-files -c` listed
//     every out-of-cone path and `--remove` dropped each one for being absent from
//     the worktree — the snapshot tree simply did not contain them. A restore of
//     that snapshot then removed those paths' index entries, and after the closing
//     reset `git status` reported the whole out-of-cone set as deleted. No pin
//     fixed it, because the defect was never on the checkout leg: as-shipped, `-c
//     core.sparseCheckout=false` and `--no-sparse-checkout` all produce
//     BYTE-IDENTICAL loss there, the `false` pin only suppressing git's `error:
//     Path … not uptodate` advisory. `--ignore-skip-worktree-entries` on the
//     check-in leg was a no-op for the same reason (identical tree): a freshly
//     seeded scratch index has no skip-worktree bits to protect.
//
//     THE CLOSURE (the amended capture bullet) inverts the seed instead of
//     pinning anything. In a detected sparse root the scratch index is seeded as
//     a COPY OF THE LIVE INDEX, which carries the skip-worktree bits, so
//     out-of-cone entries arrive already-staged at their recorded blobs and
//     `--remove` never sees them; the staging listing is then partitioned by
//     git's own sparsity matcher so `--remove` is never even offered an
//     out-of-cone path to re-stat. The snapshot tree is FULL — sparseness is a
//     checkout-time projection, not a property of the recorded state — which is
//     what makes the restore able to re-project it.
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
//     SCOPE. The exposure is a ROOT, not a mode — any execution root whose
//     `core.sparseCheckout` bit is set. A `bound-root` root IS the user's own
//     checkout, sparse whenever the user made it so; a `provisioned-worktree`
//     root reaches it too, by INHERITANCE, since `git worktree add` copies the
//     sparse state (driven by the suite, not assumed). So detection reads the
//     root: a mode-keyed detector would miss an inherited sparse root.
//
// RECORDED RESIDUAL — the honest failure mode closed by neither pin nor
// measurement, because its pin set is unbounded by construction.
//
//   * `filter.<name>.smudge` / `.clean` / `.required`, where `<name>` arrives from
//     an IN-TREE attribute but the driver commands live in HOST config. Measured:
//     with `*.secret filter=redact` in-tree, a host `filter.redact.smudge` rewrote
//     the restored bytes (`PLAINTEXT` in the odb, `SMUDGED` on disk). `-c
//     filter.redact.smudge=` neutralizes that ONE driver (measured — the restore
//     returns `PLAINTEXT`), but the name is chosen by the repository, so the set
//     of knobs to pin is unbounded and no closed pin set exists.
//
// ---------------------------------------------------------------------------
// Retention is WINDOW-BASED, and the git dir is the one that SURVIVES
// ---------------------------------------------------------------------------
//
// prunes "when the run's retention window closes (terminal state + the
// configured window)", which is two facts, not one. Terminal state alone does
// not prune: a rollback is a thing a user reaches for AFTER a run has finished,
// so deleting at the terminal event would make the snapshots useless exactly
// when they are wanted. So the mechanism is a SWEEP
// {@link TurnSnapshotService.sweepPrunableRuns} deletes every run whose window
// has closed — rather than a terminal-invoked callback, and that shape is also
// what makes the daemon-startup reconcile fall out for free: a window that
// elapsed while the daemon was down is just a candidate the first sweep finds.
// A terminal-invoked design would have had to reconstruct those misses.
//
// The ref ops run through `git --git-dir=<git_common_dir>` — the value
// `run_execution_contexts` recorded at context creation — and NEVER through
// `execution_root`. This is the whole reason that column exists (its DDL comment
// says so). Pruning through the execution root would therefore skip precisely
// the runs whose refs are still there, and would look like a working sweep while
// leaking every retired worktree's snapshots forever.
//
// Skip-and-enumerate, never fatal. A recorded `git_common_dir` that is gone at
// sweep time (the repository was removed) is not this sweep's failure — it is a
// run whose refs went with its repository. That run is SKIPPED, recorded in the
// pass's skip enumeration, and the pass continues; the per-run `try` sits INSIDE
// the loop for that reason, because one `EACCES` stranding every later candidate
// is the failure mode the never-fatal rule is written against.
//
// The git-dir skip vocabulary is two-way. git answers a removed repository, an
// `EACCES` on a live store, a missing `git` binary and a failure creating the
// daemon's own hook-neutralization directory with the SAME rejection, so the
// reason is attributed by a `stat` probe on the failure path — never by parsing
// git's stderr, and never by assuming. Absent is `git-dir-absent`, and
// present-but-unusable is `git-dir-unusable`, the fault arm. The probe fails
// TOWARD the fault (see `isPathProvablyAbsent`), because misreading an `EACCES`
// as a removal is the mistake that goes quiet.
//
// Deletion is a COMPARE-AND-SWAP, matching the capture leg's posture: the
// enumeration reads `<oid> <refname>` and each deletion names the oid it read
// (`update-ref --no-deref -d <ref> <oid>`), so a ref that changed between the two is
// refused rather than deleted (git 2.50.1: exit 1, "cannot lock ref"). Nothing
// should be able to move a snapshot ref — makes every write create-only — which is
// exactly why naming the oid costs nothing and why a refusal here is worth hearing
// about rather than steamrolling.
//
// RESIDUALS, recorded rather than closed:
//
//   * The candidate set is every terminal run whose window has closed, EVERY
//     tick, forever — so the per-tick spawn count grows with the daemon's
//     LIFETIME run count, not with the number of runs that have anything left to
//     prune: a daemon with five thousand historical runs spawns five thousand
//     `git for-each-ref` processes an hour to delete nothing, because nothing
//     memoizes an already-pruned run. `LIMIT` is not the missing bound: with
//     `ORDER BY released_at ASC` and no memo it re-reads the same oldest N rows
//     forever and starves everything behind them. This service holds no writer
//     for `run_execution_contexts` and deletes none of its rows.
//   * The same absent memo has a SECOND consequence, on the operator channel: a
//     run that is skipped rather than pruned re-enumerates in the
//     `retention-prune-skipped` diagnostic every tick, for as long as its row
//     lives. That is plan-compelled, not an oversight — the row requires a
//     removed-repository run "skipped and enumerated in the sweep diagnostic",
//     and a pass that skips it and says nothing would not be enumerating it. So
//     a daemon whose canonical repository was deleted warns hourly, forever,
//     over a set that stops growing but never empties (no retention owner for
//     the rows).
//   * Spawn count scales with (turns x epochs) per run, because the ratified
//     recipe is per-ref `update-ref -d` rather than a batched `--stdin`
//     transaction. Deviating would need a plan amendment; the batched form is
//     also all-or-nothing, where the per-ref form partially prunes and reports.
//   * `released_at <= <cutoff>` is a TEXT comparison, so it is chronological only
//     while the column holds fixed-width UTC `toISOString()` spellings. That is a
//     forward contract on the gate that stamps it.
//
// ---------------------------------------------------------------------------
// Capture NEVER throws into the turn boundary
// ---------------------------------------------------------------------------
//
// makes snapshots a recovery convenience, not a turn gate: "capture failure
// emits an OTel diagnostic and never blocks or fails the turn". So {@link
// TurnSnapshotService.captureTurnSnapshot} has no throwing path at all: the
// caller gets a typed result on every arm. THREE pieces carry that, not one,
// because the last two run where a `catch` cannot reach them:
//
//   * The ref-component validation runs first and returns a typed result
//     directly. It spawns nothing and touches nothing, so there is no rejection
//     for a `catch` to catch.
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
// Hook neutralization is STRUCTURAL
// ---------------------------------------------------------------------------
//
// Every git invocation goes through one private `#runGit` which prepends
// `-c core.hooksPath=<empty dir>` and `-c core.fsmonitor=false`, so the
// quantifier is discharged by there being no other way to reach git from here.
// The full rationale — why the second flag is not redundant, why the directory
// is created per invocation rather than once, and why the argv is an ARRAY and
// never a shell string — is at `./worktree-service.ts`'s header and is not
// repeated. The neutralization directory is spelled identically to that module's
// on purpose: two spellings would mean two directories, either of which a temp
// reaper could remove.
//
// The shell-free rule is load-bearing here in a way it is not for the sibling
// services, because the ratified recipe is written as a PIPE
// (`git ls-files … -z | git update-index … --stdin`). It is executed as two
// `execFile` invocations with the first's stdout handed to the second's stdin —
// same data, same order, no shell — and the listing travels as a Buffer rather
// than a string so a path git emitted as raw bytes survives the hop.
//

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { copyFile, lstat, mkdir, open, readFile, readlink, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Database, Statement } from "better-sqlite3";

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
interface TurnSnapshotGitInvocationOptions {
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
   * Written to the child's stdin, which is then closed. THREE legs supply one:
   * `update-index --add --remove -z --stdin` (the staging listing),
   * `sparse-checkout check-rules -z` (the candidate paths) and `commit-tree -F -`
   * (the snapshot message).
   *
   * stdin is closed on EVERY invocation, supplied or not, and that close is now
   * LOAD-BEARING rather than a belt. calls out the failure mode — `commit-tree`
   * reading its message from stdin and hanging wherever the daemon left stdin
   * open — and converted that leg from `-m` argv to `-F -` deliberately, so the
   * message is a stream this module writes and closes rather than an argv
   * element bounded by the platform's argument limit. The hang the spec names is
   * therefore reachable exactly when this contract is broken, which is why it is
   * stated here and not only at the call site.
   */
  readonly stdin?: Buffer;
}

/**
 * The git process seam.
 *
 * Takes the COMPLETE argv — `-C <dir>` included — and no working directory, so
 * the argv is the whole invocation. Same reasoning, and the same deliberate
 * non-import of the `GitFileExecutor`, that `./worktree-service.ts` records at
 * its own seam; this one differs by carrying stdin and an environment overlay,
 * which the snapshot recipe needs and that one does not.
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
 * tolerates an existing one, and `removePath` removes a file or a directory tree
 * and tolerates a missing one. The tolerance is load-bearing for the
 * scratch-index cleanup, which runs in a `finally` and must not turn a capture
 * failure into a second one. Reads do not come through here: the boundary is
 * "this interface is where the service writes", with ONE stated carve-out.
 *
 * THE CARVE-OUT is the sparse seed's index lock, and the discriminator is the
 * idempotence sentence above rather than the write/read line. Adding it here
 * would either break the invariant every other verb's tolerance rests on (the
 * `finally` cleanup is correct only because its verb tolerates a repeat) or force
 * a third verb documented as the exception to its own interface's opening line.
 * {@link TurnSnapshotService.#seedScratchIndexFromLiveIndex} calls `node:fs`
 * directly, exactly as `isPathProvablyAbsent` already does on the read side, and
 * its failure mode is exercised against a REAL held lock
 * rather than through an injected seam — which is the stronger test anyway,
 * since the protocol being honored is git's and not this module's.
 *
 * Paths are `string`: the one caller passes this module's own scratch-index
 * path, never a path decoded from a git listing.
 */
export interface TurnSnapshotFilesystem {
  createDirectory(path: string): Promise<void>;
  removePath(path: string): Promise<void>;
}

/**
 * The capture pipeline's steps, in execution order. Named on the failure result
 * and on the diagnostic so a caller — and an operator reading the diagnostic —
 * learns WHERE a capture stopped without this module echoing git's stderr.
 *
 * The sparse closure added exactly TWO members, slotted in execution order
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
 * Why one run's snapshot refs were not pruned. See {@link TurnSnapshotRetentionSkip}.
 *
 * The vocabulary splits FAULT from BOUNDARY: `git-dir-absent` is an outcome,
 * while the rest are conditions somebody acts on. Every one of them raises the
 * pass diagnostic; see {@link TurnSnapshotService.sweepPrunableRuns}.
 */
export type TurnSnapshotRetentionSkipReason =
  /** The `runId` is not safe as a ref path component — refused before any git call. */
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
   * The recorded `git_common_dir` is absent from disk — "the repo was removed",
   * which must be "skipped and enumerated in the sweep diagnostic". Nothing
   * memoizes it, so it re-enumerates on every tick for as long as its row lives;
   * the set a removed repository implicates is BOUNDED (the runs that were
   * executing in it), so the warn stays readable.
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
 * One run the sweep declined to finish, and why.
 *
 * The plan's obligation is that such a run is "skipped and enumerated in the
 * sweep diagnostic, never fatal", so this is the enumeration's element type and
 * it appears BOTH on the per-run result and on the pass's diagnostic.
 */
interface TurnSnapshotRetentionSkip {
  readonly runId: string;
  readonly reason: TurnSnapshotRetentionSkipReason;
  /** Free-form; the rejection's message when there was one. */
  readonly detail: string;
}

/**
 * What this service reports to the daemon's observability layer.
 *
 * Two kinds are required behavior: a failed capture emits a diagnostic and never
 * blocks or fails the turn, and skipped commitless embedded repositories are
 * enumerated in a diagnostic — which happens on a capture that otherwise
 * SUCCEEDED, hence its own kind rather than a field on `capture-failed`.
 *
 * The rest are operational. `scratch-index-cleanup-failed` covers a cleanup
 * that is best-effort by construction (it must never convert a completed capture
 * into a failure), where best-effort with no report is how a daemon leaks index
 * files into its own execution-roots directory for months without a signal. It
 * is deliberately NOT a `capture-failed`: the capture it follows may have fully
 * succeeded, and the outcome is reported by the RESULT, not here.
 *
 * Paths appear here deliberately. The no-path-echo rule governs typed errors
 * that reach the WIRE; a diagnostic is daemon-local observability, and
 * enumerating which repositories were skipped is its whole content.
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
       * ONE per sweep pass that skipped at least one run — the "skipped and
       * enumerated in the sweep diagnostic" obligation of plan row, spelled
       * as the plan spells it: a PASS-level enumeration, not a diagnostic
       * per skipped run.
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
       * Every skip of the pass. Non-empty by construction — the sweep does not
       * emit an empty enumeration.
       */
      readonly skipped: readonly TurnSnapshotRetentionSkip[];
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
       *     run AT ALL: its candidate read rejected, or the clock did not honor
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
   * The daemon's execution-roots directory. Two of this service's own
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
   * OPTIONAL, and that is the contract rather than a convenience.
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
   * Daemon configuration expressed as constructor config: the window has no
   * fixed number, and a daemon-side duration belongs in daemon config, not on
   * the wire.
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
   * instant.
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
   * TRIPWIRE: names an OTel diagnostic, and this package has no OpenTelemetry
   * substrate yet — this seam is the attachment point for one, and the default
   * is the interim sink `../pty/pty-host-selector.ts` uses for the same reason.
   * Replace the default, not the seam.
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
 * caller-resolved; see the header.
 */
export interface CaptureTurnSnapshotInput {
  /**
   * The run's execution root — the worktree or the main checkout (`bound-root`
   * mode). Resolved by the caller from the `run_execution_contexts` row; the
   * capture leg never reads that table itself (only the retention leg does, for
   * a different column and on a different trigger; see the header).
   */
  readonly executionRoot: string;
  /**
   * Interpolated into the ref path, so it is validated as a ref component before
   * any git call (see the header).
   *
   * Typed `string` rather than the `RunId` brand: `packages/contracts` declares
   * that brand TYPE-ONLY until ships its schema, and `./worktree-service.ts`
   * takes run provenance as a plain string for the same reason.
   */
  readonly runId: string;
  /**
   * The run's execution epoch: `0` before any rollback, advanced with each
   * accepted `run.rolled_back`. SUPPLIED, never derived: this service holds no
   * rollback history and cannot reconstruct it.
   */
  readonly epoch: number;
  /** The turn position this snapshot records. Non-negative integer. */
  readonly turnOrdinal: number;
}

/** A snapshot this call created. */
export interface TurnSnapshotCaptured {
  readonly outcome: "captured";
  /** `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>`. */
  readonly ref: string;
  /** The snapshot commit the ref now names. */
  readonly snapshotCommit: string;
  /**
   * The ONE base OID resolved at entry, used for both the tree base and the
   * recorded parent. Reported so a caller that compares it with the current
   * `HEAD` need not re-derive it from the commit object.
   */
  readonly baseCommit: string;
  /**
   * Untracked embedded repositories that could not be recorded as gitlinks —
   * empty on the ordinary capture. The same list is enumerated in the
   * diagnostic; it is repeated here so the caller can record it on the turn
   * without subscribing to the diagnostic sink.
   */
  readonly skippedEmbeddedRepositories: readonly string[];
}

/**
 * The create-only ref was already written — a retried or duplicated capture of
 * the same `(runId, epoch, turnOrdinal)`.
 */
interface TurnSnapshotAlreadyCaptured {
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
  | TurnSnapshotCaptureFailed;

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
 * The ref namespace root. `refs/heads/` is the surface this
 * deliberately is not: snapshots stay invisible to branch history, PR
 * preparation and diff attribution, so is unaffected.
 */
const SNAPSHOT_REF_ROOT = "refs/sidekicks/runs";

/**
 * The snapshot commit's message SUBJECT. FIXED — the same bytes for every
 * snapshot, per the `-m <fixed snapshot message>`.
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
 * RESIDUAL, recorded rather than closed: the ref is create-only, so a second
 * capture at the same turn does not overwrite the first, and the trailer a
 * restore reads is the FIRST capture's. If the skip list differed between them,
 * the protection follows the recorded snapshot rather than the worktree — which
 * is the same rule the rest of the restore follows, and the honest one: this
 * trailer is a fact about the snapshot, not about the worktree at restore time.
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
 *     preserved to the trailer and back, and a utf8 decode belongs only where a
 *     HUMAN reads the result.
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
 *     capture RESULT and a diagnostic, which are wire-facing values a human
 *     reads. The two trailers therefore carry different kinds of string.
 *
 * TYPE-PRESERVING: a path git listed with a TRAILING SLASH is recorded WITH it.
 * The slash is not decoration — it is git saying "a directory I did not descend
 * into", which for an `ls-files -o` listing means an embedded repository or
 * anything else `-o` refuses to walk. That distinction survives to the restore
 * because the two entry kinds need OPPOSITE exemption widths, and only the
 * capture can tell them apart: at restore time a boundary-time embedded
 * repository whose `.git` the turn removed is listed as its payload FILES, and
 * an exemption that matched the recorded name exactly would protect none of
 * them.
 *
 * Recording the slash costs no ambiguity: git spells repo-relative paths with
 * forward slashes and never emits a trailing one for a blob, so the suffix is a
 * free discriminator rather than a reserved character carved out of the path
 * space. It is also why the capture's subtraction cannot mistake a directory
 * candidate for a tree path — `ls-tree -r` lists blobs and gitlinks, both
 * slash-free, so a slash-suffixed candidate can never match one.
 *
 * RESIDUAL, the same one the sibling trailer records: the ref is create-only, so
 * a restore reads the FIRST capture's boundary set at that turn. The exemption
 * follows the recorded snapshot rather than the worktree, which is the honest
 * rule — this trailer is a fact about the snapshot.
 */
const SPARSE_BOUNDARY_PATHS_TRAILER = "Sparse-Boundary-Paths:";

/**
 * The daemon-owned author/committer identity stamped into every snapshot commit.
 *
 * Records both failure modes this closes: without explicit ident env,
 * `commit-tree` hard-fails (`Author identity unknown`) in a passwd-less daemon
 * or CI container, and silently stamps a passwd-derived OS ident elsewhere —
 * machine-dependent snapshot OIDs plus an identity leak into the object store.
 */
const SNAPSHOT_IDENTITY_NAME = "AI Sidekicks";
const SNAPSHOT_IDENTITY_EMAIL = "snapshots@ai-sidekicks.invalid";

// Spelled identically to `./worktree-service.ts`'s: both neutralize against the
// SAME directory under a shared execution-roots directory, and a second spelling
// would mean a second directory a reaper could remove out from under one of them.
const HOOK_NEUTRALIZATION_SEGMENT = ".hook-neutralization";

// Where the scratch indexes live. The temp index must sit OUTSIDE the worktree
// — a worktree-resident scratch index would surface to the capture pipeline's
// own `ls-files -o` listing and to the user's `git status` as stray untracked
// content. A dotted sibling of the per-mount root directories, so it can never
// collide with a mount id, exactly as the neutralization directory is; a
// `bound-root` root is the user's own checkout somewhere else entirely, which
// this placement is trivially outside of too.
const SNAPSHOT_INDEX_SEGMENT = ".snapshot-indexes";

// Per-invocation git timeout. Matched to `./worktree-service.ts`'s bound rather
// than to the resolver's metadata-read bound: the staging legs walk the whole
// worktree, which is `worktree add`'s order of work, not `rev-parse`'s.
const DEFAULT_TURN_SNAPSHOT_GIT_TIMEOUT_MS = 120_000;

/**
 * How long a run's snapshot refs outlive its terminal release: seven days.
 *
 * The number is chosen from the direction of the risk rather than from a
 * benchmark. Too SHORT loses a rollback the user still wanted, and loses it
 * silently — the refs are simply gone and reports "no snapshot", which reads
 * exactly like a run that never captured. So it errs long, and seven days is
 * the span over which "go back to before that turn" is still a thing somebody
 * says about a run.
 */
const DEFAULT_TURN_SNAPSHOT_RETENTION_WINDOW_MS: number = 7 * 24 * 60 * 60 * 1000;

/**
 * The largest retention window the constructor accepts: ECMAScript's own Date
 * range, ±8.64e15 ms of the epoch.
 *
 * A value the platform cannot represent does not announce itself, it degrades. A
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
// capture leg records for an untracked embedded repository.
const GITLINK_TREE_MODE = "160000";

// The `ls-files` exclude source of the capture listing, spelled once.
//
// It is the reason the recipe is plumbing rather than `git add -A`:
// `ls-files` consults NO other exclude source unless asked to, while porcelain
// also honors `core.excludesFile` and `$GIT_DIR/info/exclude` with no
// off-switch, and a developer's private ignore patterns are not project
// declarations (the Scope bullet of).
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

/**
 * The CHARACTER-CLASS half of "safe as a ref path component" — an
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
 *     not just this module's object writes. This module's behavior is unchanged
 *     — it still strips the variable, now through the spread rather than through
 *     a second literal — and the entry's original finding survives at the header
 *     above.
 *   * Local ref plumbing ignores it (empirically confirmed on git 2.50.1: a
 *     namespaced `update-ref` writes the unprefixed path, and `rev-parse` /
 *     `show-ref` / `for-each-ref` read it back from a clean environment); the
 *     namespace applies in the pack protocol, so this entry is here for a
 *     future leg that speaks it rather than for the legs that exist. The
 *     invariant's environment exposure is the redirector class above — see the
 *     header.
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
 * the retention prune enumerates with `for-each-ref`.
 *
 * Assumes a validated `runId` (see {@link isSafeRefComponent}); both builders
 * are private to this module and both call sites validate first.
 */
function buildRunSnapshotRefPrefix(runId: string): string {
  return `${SNAPSHOT_REF_ROOT}/${runId}/`;
}

/**
 * `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>` — the ref namespace pins,
 * with the `epoch-<E>` segment that makes create-only idempotence PER-EPOCH: a
 * post-rollback re-execution reuses turn ordinals, and without the segment its
 * capture would hit the superseded epoch's ref and silently resolve to the
 * wrong tree.
 */
function buildTurnSnapshotRef(runId: string, epoch: number, turnOrdinal: number): string {
  return `${buildRunSnapshotRefPrefix(runId)}epoch-${String(epoch)}/turn-${String(turnOrdinal)}`;
}

/**
 * Whether `value` is safe as a ref path component — the whole rule, of which
 * {@link SAFE_REF_COMPONENT_CHARACTER_PATTERN} is the alphabet.
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
 *   * Git's "cannot end with a dot" is a rule about the whole refname, and a
 *     `runId` is a MID-PATH component, so `run.` sails through as
 *     `refs/sidekicks/runs/run./epoch-0/turn-1`. It is refused here because a
 *     loose ref is a real directory path, and Win32 strips trailing dots from
 *     path components: `run.` and `run` are the same directory there, so two
 *     distinct runs would share one epoch namespace and the create-only CAS of
 *     would fire across runs that never collided on the ids the daemon issued.
 *   * A `.LOCK` suffix in any casing. git's rule is case-SENSITIVE, so `run.LOCK`
 *     is accepted (measured — the ref is created). It is refused here for the
 *     same filesystem reason one case down: git's own lock file for a sibling ref
 *     `refs/sidekicks/runs/run` is literally `run.lock` on disk, and on a
 *     case-insensitive filesystem — APFS and NTFS by default — a directory named
 *     `run.LOCK` is that path. `toLowerCase` compares the two spellings the
 *     filesystem would.
 *
 * None of this loosens. Run ids are event-sourced UUIDs, which contain no dots
 * at all, so every shape refused here costs a real caller nothing; the refusal
 * is a typed `validate-inputs` result before any git call.
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
 * EXPORTED, unlike the sibling services' private defaults, because suite's
 * injected-`HEAD`-advance case has to WRAP the production runner rather than
 * replace it: the assertion is that a real capture, run through the real
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
        `examined=${String(diagnostic.examinedRunCount)}`,
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
 * `null` for an unparseable clock — an injected `now` that did not honor the
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
 * decode at worst mis-classifies a path git will report again next turn.
 *
 * What deliberately does NOT appear on that list: the sparse partition and the
 * boundary subtraction read {@link splitNulTerminatedListingBytes} and key on
 * {@link listingEntryKey}, because each of them compares a listing entry against
 * the boundary set, where a mangled decode would make two DIFFERENT paths compare
 * equal and cost a file.
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
 * losing what porcelain keeps.
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
 * The same encoding is what {@link SPARSE_BOUNDARY_PATHS_TRAILER} records, so the
 * trailer holds exactly the bytes git listed: `latin1` is a bijection in BOTH
 * directions.
 */
function listingEntryKey(entry: Buffer): string {
  return entry.toString("latin1");
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
 * The prefix re-check is one of two guards on the DELETION side — `--no-deref` at
 * the deletion itself is the other — and it is not redundant with the validated
 * `runId` that built the pattern. Every entry that fails the check is dropped
 * before it can reach `update-ref -d`, so a listing that somehow named
 * `refs/heads/main` prunes nothing rather than deleting a branch.
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
// Helpers (pure, or read-only against the filesystem)
// --------------------------------------------------------------------------

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
 * A type-aware fingerprint of the entry at `path`, so two observations of one
 * path compare equal only when they saw the same kind of thing with the same
 * content.
 *
 * The answer is one of `absent`, `file:<sha256>`, `symlink:<sha256 of target>`,
 * `directory` or `other`, with `file:unreadable` and `symlink:unreadable` when
 * the entry exists but cannot be read. The type prefix keeps a file whose bytes
 * are `x` and a symlink whose target is `x` unequal. `lstat` is used rather than
 * `stat`, so a symlink is fingerprinted as itself, never as what it points at.
 * `directory` and `other` carry no hash: a directory whose contents changed, or
 * two different device nodes, compare equal.
 *
 * `absent` covers an `lstat` that failed for any reason, so a path unreadable on
 * both sides for different reasons compares equal; {@link isPathProvablyAbsent}
 * exists separately for callers that must tell those apart. It runs no git (an
 * `lstat`, a `readFile`, a `readlink`), so it works when git itself has failed.
 *
 * @consumedBy the turn checkpointer
 */
export async function fingerprintPath(path: string): Promise<string> {
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
 * Whether `path` is PROVABLY absent — the retention leg's discriminator between
 * a git dir that is gone and one it merely could not use.
 *
 * Treating every error as absence would be exactly wrong here: an `EACCES` on a
 * live repository would then read as a removal and go quiet, which is the fault
 * this taxonomy is drawn to surface. So only `ENOENT`
 * and `ENOTDIR` are absence; anything else — including a probe that failed for a
 * reason with no `code` at all — resolves `false` and lands the run in the
 * alarming `git-dir-unusable` arm. Fails toward the alarm, deliberately.
 *
 * The errno read is typed `string | undefined` rather than `unknown`, and the
 * type is doing work: under
 * `unknown`, a maintainer reaching for a NUMERIC errno — `code === 2` — compiles
 * to a permanently-false branch, and a genuinely-absent repository would then be
 * reported present and alarmed on. Typed, that spelling is a compile error.
 *
 * A READ, so it does not go through {@link TurnSnapshotFilesystem}, which is the
 * seam through which this service MUTATES.
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
}

interface RetentionCutoffParams {
  readonly released_before: string;
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
  // `null` when no `database` was supplied — capture-only wiring. Prepared ONCE
  // in the constructor, the idiom `../workspace/execution-root-service.ts` uses,
  // so a schema drift fails at construction rather than at the first sweep an
  // hour into the daemon's life.
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
    // deserve a refusal.
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
      // `released_at` is NULL for a run that is still open (gate stamps it at
      // run terminal), so a still-open run is never a candidate no matter how
      // old it is, and the cutoff the caller binds is already `now -
      // retentionWindow`.
      //
      // The `IS NOT NULL` clause is EXPLICIT rather than load-bearing: SQL's
      // three-valued logic already drops a NULL from the `<=` comparison, so the
      // clause states the intent and keeps the predicate readable rather than
      // resting the "a live run is never pruned" property on a subtlety.
      //
      // The comparison is TEXT `<=`; see the header for the fixed-width-UTC
      // constraint that makes it chronological. Ordered so a pass is
      // deterministic and the oldest release prunes first — with `run_id` as the
      // tiebreak, since two runs can release in the same millisecond.
      this.#selectPrunableRunsStmt = database.prepare<RetentionCutoffParams, PrunableRunRow>(
        `SELECT run_id, git_common_dir
           FROM run_execution_contexts
          WHERE released_at IS NOT NULL
            AND released_at <= @released_before
          ORDER BY released_at ASC, run_id ASC`,
      );

      // The per-run primitive's own resolution. Deliberately UNFILTERED by
      // `released_at`: the window is the SWEEP's predicate, while this statement
      // backs the primitive that an operator (or a future explicit-disposal path)
      // calls for one named run — see `pruneSnapshotsForRun`.
      this.#selectRunContextStmt = database.prepare<RunContextLookupParams, PrunableRunRow>(
        `SELECT run_id, git_common_dir
           FROM run_execution_contexts
          WHERE run_id = @run_id`,
      );
    }
  }

  // ------------------------------------------------------------------------
  // ------------------------------------------------------------------------

  /**
   * Record the execution root's project state — tracked plus non-ignored
   * untracked — as a snapshot commit under
   * `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>`.
   *
   * Every failure — an invalid input, a git leg, the ref write, even a
   * diagnostic sink that throws or rejects — becomes a typed `failed` result,
   * plus a diagnostic wherever the sink accepts one, because makes the turn
   * boundary complete regardless: snapshots are a recovery convenience, not a
   * turn gate.
   *
   * The recipe is the turn-boundary snapshot recipe, leg for leg. Its two non-obvious properties, both
   * spec-mirrored:
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
    if (
      !isSafeRefComponent(input.runId) ||
      !isNonNegativeInteger(input.epoch) ||
      !isNonNegativeInteger(input.turnOrdinal)
    ) {
      return this.#failCapture(input, null, "validate-inputs", "unusable ref components");
    }

    const ref: string = buildTurnSnapshotRef(input.runId, input.epoch, input.turnOrdinal);
    // Deliberately NOT the daemon's `mintUuidV7` (`ids/uuid-v7.ts`): this is a
    // collision-free filename for a scratch git index that is unlinked in the
    // same call. It is not an id of anything, and no row or event stores it.
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
      // honoring IN-TREE `.gitignore` rules only — see that constant for why
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
          // `true` re-hashes CRLF worktree bytes to LF blobs, changing blob, tree
          // and snapshot OIDs for identical worktree bytes. `core.safecrlf=false`
          // pins that same channel's VETO off, and it is a veto rather than a
          // conversion: measured on git 2.50.1, staging with the host setting
          // absent and staging with it pinned false produce the IDENTICAL tree.
          // What a host `core.safecrlf=true` adds is a fatal — check-in-time,
          // against an in-tree `*.txt text` and CRLF worktree bytes it exits
          // `fatal: CRLF would be replaced by LF`, so capture fails, the turn
          // runs uncovered, and the rollback that should have had a snapshot
          // answers `no_snapshot`. That is snapshot AVAILABILITY turning on host
          // config — the same class the OID pins close from the other side — so
          // the project's own declared normalization proceeds here without the
          // host's veto over it. `core.attributesFile=/dev/null` plus
          // `GIT_ATTR_NOSYSTEM=1` take the user and system attribute files out of
          // the conversion decision, while in-tree `.gitattributes` — a project
          // declaration, checked in and identical on every host — stays
          // deliberately honored. `core.fileMode` is deliberately NOT pinned
          // here, and the reason is this leg specifically: the seeded scratch
          // index carries no stat data, so `update-index` re-stats every listed
          // path, and a `fileMode=true` pin would therefore take each TRACKED
          // file's mode from lstat and discard the mode its base commit recorded.
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
   * `--verify` tightens the `git rev-parse HEAD` without changing the question:
   * it demands a single revision and prints nothing on a miss, where the bare
   * form echoes its own argument (`HEAD`) to stdout with a non-zero exit.
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
   * predicate.
   *
   * THE CONFIG BIT ALONE. `core.sparseCheckout` is what git itself consults
   * before applying skip-worktree semantics, and the rules file deliberately does
   * not join the predicate. Under this predicate the same root reaches the sparse
   * arm, the matcher below fails on it (`fatal: unable to load existing
   * sparse-checkout patterns`, exit 128 — measured, including for an EMPTY
   * candidate set), and the capture reports a typed `check-sparse-rules` failure.
   * Fail-closed, and a capture that did not happen is what makes safe by never
   * blocking the turn.
   *
   * ROOT-KEYED AND MODE-AGNOSTIC. Sparseness is read from the root, because it is
   * a property of the checkout and not of how the daemon came to be pointed at
   * it: a `provisioned-worktree` root INHERITS its main checkout's sparse
   * configuration (`worktree add` copies the sparse state). Reading the root is
   * what makes the answer correct without this module holding a table of which
   * modes can be sparse.
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
   * The protocol, honored exactly: create `<index>.lock` EXCLUSIVELY, do the
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
   * THE ORACLE, SPELLED ONCE: the capture partition's one matcher call, so the
   * argv is single-sourced exactly as {@link EXCLUDE_PER_DIRECTORY_GITIGNORE} and
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
   * names, and `update-index --add` has already silently dropped each of
   * them.
   *
   * The classification is FAIL-SAFE rather than unborn-specific, and BOUNDED
   * rather than total: an entry is skipped and enumerated when GIT ITSELF
   * refused to resolve its `HEAD`, or when the object id git reported is not
   * INSERTABLE IN THE SUPERPROJECT'S OBJECT FORMAT. The first covers the
   * commitless embedded repository the spec calls out — porcelain `git add -A`
   * hard-fails on it, so capture skipping honors capture-never-blocks — and any
   * other trailing-slash entry that is not a repository at all. The second is the
   * MIXED FORMAT case, where both repositories are healthy and their object
   * formats simply differ.
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
   * WHAT IS DELIBERATELY NOT A CLASSIFICATION: a `rev-parse` that EXITED ZERO
   * and printed something that is not an object id. git answered the question
   * there, so an unintelligible answer is a FAULT, and it refuses through the
   * capture funnel as a `normalize-embedded-repositories` failure — the same
   * disposition {@link requireObjectIdHexLength} already records one branch below
   * for a git whose object-format name this module has never been measured
   * against. Swallowed, it was the one silence in this pass with no downstream
   * detector: every later leg re-enters the same seam and fails loudly on its
   * own, but nothing re-checks a classification, so a RECORDABLE repository was
   * enumerated as unrecordable and the capture still reported success — a
   * snapshot narrowed with no signal that it had been.
   *
   * The remaining residual is stated rather than closed. A git INVOCATION that
   * REJECTS stays a classification, a transient rejection included, because
   * {@link TurnSnapshotGitRunner} makes rejections opaque to this module —
   * failure detection is by exit status alone — and reading a field off the
   * thrown value to tell an EAGAIN from an unborn `HEAD` is the one thing that
   * seam contract forbids.
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
      const embeddedRoot: string = join(executionRoot, embeddedPath);
      let headStdout: Buffer;
      try {
        headStdout = (await this.#runGit(["-C", embeddedRoot, "rev-parse", "--verify", "HEAD"], {}))
          .stdout;
      } catch {
        // The `try` now holds the INVOCATION and nothing else, so this arm is
        // reached only where git itself refused — see the docblock's bounded
        // classification and the residual it states.
        skipped.push(embeddedPath);
        continue;
      }
      // OUTSIDE the classification arm on purpose: git exited zero, so it
      // answered, and an answer that is not an object id throws into the capture
      // funnel instead of enumerating a recordable repository as unrecordable.
      const embeddedHead: string = this.#requireObjectId(headStdout);
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
   * THE MESSAGE TRANSPORT IS `-F -`, converted from `-m` argv and the
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
   * invocation, so the hang warns about is closed by the seam's contract rather
   * than by this call site's argv
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
   * The create-only ref write.
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
      // splits: there the same flagged create REFUSES over a dangling in-namespace
      // symref (refs-transaction hardening, lineage git 2.52's fix for `fetch`
      // clobbering dangling symrefs). The refusal lands in the `catch` below,
      // `#readRefIfPresent` finds nothing — a dangling symref does not resolve for
      // `show-ref --verify` — and the rethrow becomes the typed `failed` at
      // `write-ref`: fail-closed, diagnosed, and the turn proceeds, which is this
      // leg's posture for any capture that cannot be written. The flag is
      // load-bearing on BOTH versions and for one reason — it is what keeps
      // 2.50.1's success inside the namespace and keeps 2.54.0's refusal a refusal
      // rather than the branch-minting success above. holds either way; only the
      // outcome tag differs. A LIVE referent still refuses on both versions,
      // "reference already exists", and `#readRefIfPresent` below resolves through
      // it to whatever oid that name holds on disk. When the ref genuinely
      // predates this call — the ordinary case — that IS the pre-existing
      // already-captured reading, unchanged. It is not a claim the oid is one this
      // service wrote: an actor with repository write access can plant or repoint
      // an in-namespace ref by ordinary means, and this read reports what it finds
      // (see the header's boundary paragraph). What holds regardless is the part
      // this leg is responsible for — the refusal stays a refusal, and nothing
      // outside the namespace is written. For a direct ref — every ref this
      // service writes — the flag is a measured no-op, and the per-epoch
      // idempotence refusal is preserved.
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
  // Retention
  // ------------------------------------------------------------------------

  /**
   * Delete the snapshot refs of every run whose retention window has closed.
   *
   * The daemon's ONE retention trigger, and it serves both drivers with the
   * same code: a startup call is the "reconcile runs whose windows elapsed while
   * the daemon was down" pass — those runs are simply candidates the first sweep
   * finds — and a periodic call is the ongoing one.
   *
   * NEVER REJECTS on a runtime fault. This runs on a timer with nobody awaiting
   * it, where a rejection is an UNHANDLED rejection and Node's default
   * `--unhandled-rejections=throw` would take the daemon down over a removed
   * directory. So: a candidate read that fails becomes a `retention-sweep-failed`
   * diagnostic and an empty result, and a run that cannot be pruned is skipped,
   * enumerated in the pass's `retention-prune-skipped` diagnostic, and does not
   * strand the candidates behind it (the per-run `try` is INSIDE the loop).
   *
   * Every skip is enumerated in the pass diagnostic and on the RESULT: "a run
   * whose recorded `git_common_dir` is missing … is skipped and enumerated in
   * the sweep diagnostic".
   *
   * It DOES throw for one condition, and the asymmetry is the point: a service
   * constructed without a `database` cannot answer the retention question at
   * all. Returning an empty result there would make a mis-wired daemon
   * indistinguishable from a daemon with nothing to prune — silent forever,
   * which is the exact failure this leg's diagnostics exist to prevent. That is
   * a programmer error at the composition root.
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
      });
      for (const candidate of candidates) {
        examinedRunIds.push(candidate.run_id);
        const outcome: TurnSnapshotRetentionPruneResult = await this.#pruneRunRefs(
          candidate.run_id,
          candidate.git_common_dir,
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
      if (skipped.length > 0) {
        this.#emit({
          kind: "retention-prune-skipped",
          skipped,
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
   * the sweep's predicate (attaches it to "the run's retention window closes",
   * which is what the sweep asks), and this is the primitive underneath.
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
    return this.#pruneRunRefs(runId, row.git_common_dir);
  }

  /**
   * The ref ops, shared by both entry points above so the sweep never re-reads a
   * row it already has and the primitive never duplicates the recipe.
   *
   * The `runId` validation lives HERE rather than in the two callers, and that
   * is structural for the same reason `#runGit` is: this is the only path from
   * either entry point to a git invocation, so the "no caller-supplied string
   * reaches a ref path unvalidated" holds by there being nowhere else to go. It
   * covers the sweep's DB-sourced ids as well as the primitive's
   * caller-supplied one — the table is written gate with event-sourced UUIDs,
   * and the guard costs a regex either way.
   */
  async #pruneRunRefs(
    runId: string,
    gitCommonDir: string,
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
      // git's stderr — discipline in this same file, where a failed resolve
      // gets its own second question instead of folding into the absent case.
      // git answers this one rejection for a removed repository, an `EACCES` on
      // a live store, a missing `git` binary and a failure creating the daemon's
      // OWN hook-neutralization directory (`#runGit` creates it before
      // spawning), and the last three are faults where the first is an outcome.
      // One `stat` on the failure path buys the distinction; the happy path pays nothing.
      return this.#skipPrune(
        runId,
        await this.#classifyGitDirFailure(gitCommonDir),
        describeRejection(reason),
      );
    }

    const deletedRefs: string[] = [];
    for (const entry of parseSnapshotRefListing(listing.stdout, refPrefix)) {
      try {
        // `--no-deref` closes the THIRD channel here, and it is the second guard
        // on the delete side, beside the listing prefix re-check. They are not
        // interchangeable: the prefix check validates the name git REPORTED,
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
   * Which of the two git-dir skip reasons a failed enumeration earned. The
   * recorded dir belongs to a repository nobody was supposed to delete, so its
   * absence is news.
   *
   * The probe itself is contained: a `stat` that rejects for an exotic reason
   * resolves "not provably absent" (see {@link isPathProvablyAbsent}) and the
   * run lands in the fault arm, which is the direction that gets looked at.
   */
  async #classifyGitDirFailure(gitCommonDir: string): Promise<TurnSnapshotRetentionSkipReason> {
    return (await isPathProvablyAbsent(gitCommonDir)) ? "git-dir-absent" : "git-dir-unusable";
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
   * nothing else, so the quantifier holds structurally (see the header and
   * `./worktree-service.ts`'s fuller treatment).
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
