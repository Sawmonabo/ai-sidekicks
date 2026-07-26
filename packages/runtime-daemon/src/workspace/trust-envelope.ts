// Trust-envelope containment validator (Plan-009 Phase 1 T1.6) — the single
// place a `WorkspaceBind` request's execution root is proven to sit inside the
// session's declared local trust envelope before Phase 2 persists it as
// `workspaces.fs_root`.
//
// Spec coverage:
//   * `Spec-009 §Required Behavior` — "The system must reject path traversal or
//     workspace binding outside the declared local trust envelope."
//   * `Spec-009 §Local Trust Envelope (V1 Definition)` — the envelope of a
//     session is "the set of fully resolved canonical roots of its attached
//     repo mounts"; a root is inside iff "its fully resolved form (absolute,
//     symlink-resolved, platform-normalized) is path-contained within the fully
//     resolved canonical root of a repo mount attached to the same session",
//     with containment "path-component-boundary-aware (`/repo-evil` is not
//     within `/repo`) and case-folded on case-insensitive filesystems (Windows
//     tier per ADR-019)"; and `WorkspaceBind`'s optional `directory` is
//     "resolved against the mount's canonical root and containment is
//     re-checked AFTER symlink resolution", with "`..` traversal, absolute-path
//     redirection, and symlink escape outside the mount root" rejected.
//
// Invariant enforced here (canonical text in
// `docs/plans/009-repo-attachment-and-workspace-binding.md §Invariants`):
//   * I-009-3 — trust-envelope containment. This module owns the ENFORCEMENT
//     leg; T1.4's `TrustEnvelopeViolationError` owns the carrier leg. Every
//     value this module returns has been symlink-resolved by the filesystem and
//     then proven component-contained within a root the caller declared
//     admitted. There is no other successful exit.
//
// Bind-side only. Attach performs no containment check at all: attach IS
// envelope admission (`Spec-009 §Local Trust Envelope (V1 Definition)` — the
// resolved root JOINS the envelope), and validating it against an envelope
// would reject every first attach. This module is therefore reached from
// `WorkspaceBind` (Phase 2 T2.4) and from nowhere else.
//
// Daemon-PROVISIONED roots are outside its remit for a different reason. The
// same spec section admits Plan-010 worktrees and ephemeral clones under the
// daemon's execution-roots directory BY PROVENANCE — daemon-created
// derivatives of an admitted mount, never user-supplied paths — so the
// containment rule governs user-supplied bind paths only. Those roots sit
// outside the mount canonical root, so applying this validator defensively at
// the CP-009-2 `completeReprovision(workspaceId, fsRoot)` seam would refuse
// every worktree and ephemeral-clone root Plan-010 provisions.
//
// Two layers, because I-009-3 has two clauses
// --------------------------------------------------------------------------
// The invariant reads "within the canonical root of a repo mount attached to
// THE SAME SESSION". Both halves are checked, in order:
//
//   1. ADMISSION — `mountCanonicalRoot` must itself BE one of
//      `sessionEnvelopeRoots`. The envelope IS the set of attached canonical
//      roots (spec line: "the set of fully resolved canonical roots of its
//      attached repo mounts"), so membership is component EQUALITY, not
//      containment. This is what makes "attached to the same session"
//      structural rather than an assertion the caller makes about itself: a
//      mount id belonging to another session, or to a `detached` row, produces
//      an anchor the session's envelope does not contain, and the bind is
//      refused before the filesystem is touched.
//   2. CONTAINMENT — the resolved candidate must be inside that one anchor,
//      NOT merely inside some member of the envelope. `WorkspaceBind` is
//      mount-scoped (D-009-4, mount-first), and the spec resolves `directory`
//      against "the mount's canonical root" and rejects escape "outside the
//      MOUNT root". So `directory: "../other-mount/sub"` is refused even when
//      `other-mount` is itself attached to the same session and the result
//      would satisfy the looser envelope-wide reading.
//
// Layer 2 implies layer 1 by transitivity, so the accepted root is inside both
// the named mount and the session envelope.
//
// ORDER IS LOAD-BEARING: resolve, THEN contain
// --------------------------------------------------------------------------
// The filesystem resolves the candidate before any boundary arithmetic runs.
// Checking containment on the spelled path would admit the primary adversarial
// case — a symlink sitting INSIDE the mount whose target is outside it — since
// the spelling never leaves the mount while the file does.
//
// The candidate is joined WITHOUT `path.resolve`, and that is not a stylistic
// choice. `path.resolve` collapses `..` lexically, before the filesystem sees
// the path, so it silently renames the target: for a `link` inside the mount
// pointing outside it, `path.resolve(mount, "link/..")` yields `mount`, while
// the OS resolves the same string to the PARENT OF THE LINK'S TARGET — outside
// the mount. Handing the raw join to `realpath` lets the kernel apply `..` to
// the resolved target, which is the only interpretation that matches what a
// later `open()` on that path would reach.
//
// The anchor is never re-resolved, deliberately
// --------------------------------------------------------------------------
// `mountCanonicalRoot` is compared AS ADMITTED. Re-running `realpath` on it
// would be a security regression, not hardening: if the admitted root is later
// replaced by a symlink to an attacker-controlled directory, re-resolving both
// sides makes them agree again and the validator returns a root outside the
// envelope that was actually admitted. Comparing the resolved candidate against
// the root as admitted can only ever reject more — an anchor that is stale,
// aliased, or otherwise not what T1.5 produced fails closed.
//
// This is also why a non-absolute or non-canonical anchor needs no elaborate
// guard. T1.5's resolver postcondition is that a persisted `canonical_root` is
// absolute and `realpath`-ed; the absoluteness check below is a garbage-in
// refusal that keeps a relative anchor from being completed against the
// daemon's own working directory during the join, and everything else a
// malformed anchor could be simply fails containment.
//
// Comparison is component-wise
// --------------------------------------------------------------------------
// Both paths are split on the platform separator and compared component by
// component, which is what makes `/repo-evil` not-within `/repo` structurally
// rather than by remembering to append a separator to a string prefix.
//
// Case folding follows the injected path module's `sep` (win32 ⇒ case-folded),
// mirroring T1.5's derivation, so POSIX CI drives the Windows branch by
// injecting `path.win32` rather than waiting on a Windows runner. Folding is
// `toLowerCase`, never `toLocaleLowerCase`: under a Turkish locale the latter
// maps `I` to `ı`, which would fold two distinct components together — a
// widening of a security boundary keyed off the operator's locale.
//
// Folding per COMPONENT makes each component's mapping independent of its
// neighbours, so an anchor folds identically whether it stands alone or sits
// inside a longer candidate. That is defensive rather than a live fix: both
// separators are Unicode category Po, which terminates the context-sensitive
// mappings (Greek final sigma being the usual example) at the same places a
// whole-string fold would.
//
// Two accept-direction residuals are carried deliberately, both of them the
// cost of the Windows-tier folding the spec mandates. First, `toLowerCase` is
// Unicode default case conversion, not NTFS's upcase table: `ẞ` (U+1E9E) and
// `ß` both fold to `ß`, and `İ` (U+0130) folds to `i` + U+0307, so component
// names NTFS keeps distinct can alias under the fold. Second, Win10+ supports
// per-DIRECTORY case sensitivity (`fsutil file setCaseSensitiveInfo`, which
// WSL sets on the trees it creates), and inside such a directory win32 is
// genuinely case-sensitive — where folding is the unsafe direction by the rule
// stated next. `toUpperCase` is not the repair: it maps `ß` to `SS`, aliasing
// `ß` with `ss` and widening further than it narrows.
//
// A case-insensitive filesystem that is NOT win32 — macOS APFS in its default
// configuration — therefore compares case-SENSITIVELY here. That direction is
// safe: it can only refuse a bind whose spelling differs from the admitted
// root, never accept one that escapes. Folding on a case-sensitive filesystem
// would be the unsafe direction, since `/REPO` and `/repo` are genuinely
// different directories there.
//
// That sensitivity rarely bites, because both operands arrive spelled the way
// the FILESYSTEM spells them. Node documents `fsPromises.realpath` as resolving
// with the semantics of `fs.realpath.native`, which returns each component's
// on-disk name, so a candidate supplied as `/Repo/SUB` and an anchor admitted as
// `/repo/sub` reach the comparison identical. Benign mis-spelling is collapsed
// before containment runs; what the case-sensitive comparison still refuses is
// the residual named above — a genuine per-directory case-sensitivity island.
//
// The anchor's PROVENANCE is what makes that true, and it is worth stating
// rather than assuming: `mountCanonicalRoot` is not operator text. It is a value
// T1.5's resolver produced under this same primitive, so it carries on-disk
// spelling before it is ever admitted. The claim would not hold for an anchor
// persisted as typed.
//
// Note which direction this runs. Pre-collapsing spelling lets two GENUINELY
// IDENTICAL directories agree; it never lets a candidate that escapes the mount
// compare as contained. Comparing the resolved candidate against the anchor as
// admitted can still only ever reject more.
//
// The seam DEFAULT carries both halves, and is load-bearing rather than
// incidental: `node:fs`'s callback `realpath` and `realpathSync` are a
// JavaScript walk that preserves the CALLER's spelling AND collapses `..` inside
// its own walk instead of against a symlink's resolved target. Defaulting to
// either would break a mis-cased bind on APFS and reopen the `..` escape the
// ORDER IS LOAD-BEARING section exists to refuse. Both suites pin the default by
// identity, and pin the casing behavior behind a filesystem probe.
//
// Nothing needs migrating. Phase 1 persists no rows at all, so no stored
// `canonical_root` carries operator-supplied casing for a later phase to
// reconcile; Phase 2 begins writing values that are on-disk-spelled by
// construction.
//
// Failure is uniform, and one residual comes with it
// --------------------------------------------------------------------------
// Every refusal throws the argument-free `TrustEnvelopeViolationError`
// (`repo.outside_trust_envelope`): a foreign or malformed anchor, an escape, a
// `realpath` that fails because the candidate does not exist or cannot be
// traversed, and a resolved root that is not a directory — whether the `stat`
// reports a non-directory or fails outright. Fail-closed is the only available
// answer — neither containment nor usability can be PROVEN of a path the
// filesystem will not answer for, and T1.4 gives this code no channel through
// which a path could reach the wire.
//
// The residual: an execution root that has VANISHED — an unplugged volume, a
// deleted mount root — is an availability condition (`Spec-009 §Fallback
// Behavior`'s `stale` transition, I-009-7), and it surfaces from here as a
// trust-envelope refusal. The directory check WIDENS that residual rather than
// adding a second one: a root that disappears between the `realpath` and the
// `stat` is reported identically to one that was a regular file all along,
// because the carrier takes no arguments and cannot say which. T2.4 should probe
// root reachability through the T2.5 health projection BEFORE calling this
// validator, so an operational outage is reported as `stale` rather than
// masquerading as a security violation.
//
// The admission layer carries the same shape of residual. A bind naming a
// `detached` mount produces an anchor that no attached root matches, so it too
// arrives as `repo.outside_trust_envelope`. T2.4 should scope its envelope
// query to `state = 'attached'` and refuse a non-attached or unknown mount id
// with its own typed error first, so admission does not shadow two distinct
// client mistakes under one code.
//
// What the return value is, and is not
// --------------------------------------------------------------------------
// The returned string is the ONLY safe path to use downstream: it is the
// filesystem's resolution of the candidate, proven contained. Callers must
// persist and execute against exactly it, never re-derive a root by rejoining
// `mountCanonicalRoot` with the request's `directory` — the unresolved spelling
// is the thing that was never validated.
//
// It IS asserted to be a directory, and that is a containment question rather
// than a usability one once you follow where the value goes. Its only purpose is
// to become `workspaces.fs_root` — the root a process is later asked to run
// inside. A regular file that passes containment would persist a workspace that
// can never spawn anything, and nothing downstream would catch it: T2.4's bind
// flow resolves this path, refuses escapes, and writes it. Refusing at the one
// chokepoint that already proves things about this path is the fail-closed
// direction; the alternative is a row that looks bound and fails at first use.
// Plan-010's provisioned roots are unaffected — they never reach this module
// (see the daemon-PROVISIONED paragraph above).
//
// The guarantee is point-in-time, and that now covers two probes rather than
// one. Nothing here (or anywhere) prevents the filesystem from changing between
// validation and use: a directory can be replaced by a file, or removed, after
// the `stat` and before the spawn, exactly as a resolved path can be re-pointed
// after the `realpath`. TOCTOU hardening at the execution boundary is out of
// scope for a bind-time check.

import { realpath as realpathFromFilesystem, stat as statFromFilesystem } from "node:fs/promises";
import * as nodePath from "node:path";

import { TrustEnvelopeViolationError } from "./repo-errors.js";

// --------------------------------------------------------------------------
// Public input shape
// --------------------------------------------------------------------------

/**
 * One `WorkspaceBind` execution-root candidate, expressed entirely as strings.
 *
 * The validator performs no session or mount lookups of its own: it is handed
 * the roots the caller has already read, which keeps the security boundary
 * unit-testable without a database and keeps this module free of Phase 2
 * persistence concerns.
 */
export interface WorkspaceExecutionRootCandidate {
  /**
   * Canonical root of the repo mount named by the bind request — the anchor
   * the candidate must resolve inside.
   *
   * Absolute and `realpath`-ed by T1.5's postcondition. It is used AS GIVEN;
   * see the header on why re-resolving it would widen the boundary.
   */
  readonly mountCanonicalRoot: string;
  /**
   * `WorkspaceBindRequest.directory` — a mount-root-relative subdirectory.
   *
   * Absent (or empty) binds the mount root itself. A COMPLETE absolute value
   * is not refused outright: it replaces the anchor as the candidate and is
   * held to the same containment rule, so one that stays inside the mount is
   * admitted and one that redirects outside is refused. A win32 driveless
   * rooted form (`\evil`, `/evil`) IS refused up front — it names no volume,
   * so only the daemon's current drive could complete it, which is the same
   * daemon-side-state borrowing T1.5's resolver refuses. `..` is left for the
   * filesystem to apply after symlink resolution (header).
   */
  readonly directory?: string | undefined;
  /**
   * The session's declared trust envelope: the canonical roots of every repo
   * mount currently attached to the session the bind targets.
   *
   * `mountCanonicalRoot` must appear here — that membership is what proves the
   * anchor belongs to this session. An empty envelope admits nothing.
   */
  readonly sessionEnvelopeRoots: readonly string[];
}

// --------------------------------------------------------------------------
// Injected seams
// --------------------------------------------------------------------------
//
// Same seam DISCIPLINE as T1.5's resolver, plus a third seam the resolver has
// no counterpart for. Two are here for the resolver's reason: the win32 branch
// of a rule that only Windows can exercise (case folding, drive and UNC roots)
// is otherwise asserted nowhere in an ubuntu-only CI.
//
// The `stat` seam answers a question T1.5 never has to ask. The resolver hands
// its path to `git -C`, which fails on its own against a regular file and routes
// that failure to `vcs_error` — so what the path IS never needs establishing
// there. This module RETURNS its path for persistence instead of consuming it,
// so nothing downstream asks on its behalf, and it must ask itself.

/** `fs.promises.realpath` seam. Rejects with a Node `ErrnoException`. */
export type PathRealpathResolver = (path: string) => Promise<string>;

/**
 * `fs.promises.stat` seam, narrowed to the one question this module asks.
 *
 * Rejects with a Node `ErrnoException` for a path it cannot stat, which this
 * module treats exactly as it treats a non-directory.
 */
export type PathStatResolver = (path: string) => Promise<{ isDirectory(): boolean }>;

/**
 * The slice of `node:path` this module reads. A structural subset, so both
 * `path.win32` and `path.posix` satisfy it — which is the point of the seam.
 *
 * A same-named twin lives in `./repo-root-resolver.js` (T1.5), with the same
 * three members and the same purpose. The duplication is deliberate, and the
 * reason is now a CYCLE rather than a missing task-graph edge: the resolver
 * imports this module's component-comparison helpers for its own root
 * verification, so the edge runs T1.5 → T1.6, and importing the resolver's
 * copy back would close a real import cycle. (Hoisting both into a shared
 * module remains a file neither task owns.) Being structurally IDENTICAL, the
 * two are mutually assignable, so the duplication costs a doubled auto-import
 * suggestion and nothing else. Keep them identical: a member added to one
 * belongs in the other.
 *
 * That instruction governs SIX surfaces, not this interface alone. The pair
 * of modules duplicates:
 *
 *   1. this interface;
 *   2. the exported `PathRealpathResolver` alias above (byte-identical);
 *   3. the module-local `WINDOWS_PATH_SEPARATOR` constant below;
 *   4. the module-local `resolveDeps` defaulting helper below — the one entry
 *      that is NO LONGER byte-identical, since this module's copy also defaults
 *      the `stat` seam described above, which the resolver has no counterpart
 *      for. Shape and the `??`-per-member idiom still match, and a member added
 *      to the SHARED part still belongs in both;
 *   5. the win32 driveless-root rule — the resolver states it once, in
 *      `namesCompleteLocation`, and `joinCandidatePath` below re-spells it
 *      inline for its absolute `directory` arm (a parsed root longer than one
 *      character is the complete-location test in both places);
 *   6. the exported `DEFAULT_REALPATH` binding below.
 *
 * The first FIVE are PROSE-only twins: nothing assigns one copy to the other,
 * so no divergence between them is compile-visible and the instruction above is
 * the only enforcement they have. For the first four that is cheap — aliases
 * and defaulting boilerplate a reader compares at a glance, including the one
 * deliberate divergence entry 4 records. The fifth is a
 * CONTAINMENT rule, so divergence there changes which paths are admitted,
 * silently and only on Windows. It is the one a future editor most needs
 * flagged.
 *
 * The SIXTH is TEST-enforced instead. Each suite pins its own module's default
 * by identity against `node:fs/promises`' `realpath`, so drift in either module
 * fails that module's own suite; and because both pins name the same external
 * binding, the two defaults cannot silently diverge from each other either.
 * That matters beyond tidiness — the anchor-provenance argument in the header
 * above holds only while T1.5 resolves under the same primitive this module
 * does.
 *
 * The list did not shrink when the resolver started importing from here. The
 * component-comparison helpers below are SHARED, not duplicated: T1.5 calls the
 * same three functions this module's own boundary check calls, so its
 * `root_mismatch` verification and this module's bind-side containment agree by
 * construction. That is a third relationship, and the only one a COMPILER
 * enforces — the sixth twin is held by tests, the first five by this note alone.
 */
export interface PlatformPathModule {
  readonly sep: string;
  isAbsolute(path: string): boolean;
  parse(path: string): { readonly root: string };
}

/** Constructor-injectable primitives; every member defaults to the real one. */
export interface TrustEnvelopeValidatorDeps {
  /**
   * Defaults to `node:fs/promises.realpath`, which Node documents as resolving
   * "using the same semantics as the `fs.realpath.native()` function" and which
   * therefore returns each component's ON-DISK spelling.
   *
   * `node:fs`'s CALLBACK `realpath` is a different implementation and is not
   * interchangeable: Node lists "No case conversion is performed on
   * case-insensitive file systems" as the first documented difference, so a
   * mis-cased bind would keep the caller's spelling and be refused. It also
   * collapses `..` in its own walk rather than letting the kernel apply it to a
   * symlink's target, which is the escape the ORDER IS LOAD-BEARING section
   * above exists to refuse — so the choice of implementation is a containment
   * question here, not only a casing one. `DEFAULT_REALPATH` below is pinned.
   *
   * Three documented caveats of the native path, none load-bearing here:
   *   * musl-linked Linux needs procfs mounted at `/proc` for it to work at all;
   *     "Glibc does not have this restriction". An Alpine-container concern.
   *   * macOS and the BSDs fail with `ELOOP` past 32 symlinks in one resolution,
   *     "hardcoded and cannot be sidestepped" (libuv). Every realpath failure
   *     here is already a uniform `TrustEnvelopeViolationError`, so this arrives
   *     fail-closed like any other unresolvable candidate.
   *   * Windows shows "Inconsistent casing when using drive letters", alongside
   *     unresolvable ImDisk-style ramdisks and bypassed `subst` drives. The
   *     casing one is benign HERE because the win32 branch folds case; the other
   *     two resolve to a refusal, which is the safe direction.
   *
   * Primary sources, also in `Plan-009 §References`:
   *   * Node `fs` — https://nodejs.org/api/fs.html#fsrealpathnativepath-options-callback
   *   * libuv `uv_fs_realpath` — https://docs.libuv.org/en/v1.x/fs.html
   */
  readonly realpath: PathRealpathResolver;
  /**
   * Defaults to `node:fs/promises.stat`. Asked exactly one question: is the
   * RESOLVED root a directory?
   *
   * Injectable for the same reason `realpath` is. The win32 suite drives
   * resolved paths that exist on no POSIX host (`C:\Repos\App\Src`), so a
   * hard-wired real `stat` would `ENOENT`-fail every win32 acceptance test and
   * the seam would be untestable from CI.
   *
   * `stat` rather than `lstat`, and the distinction is immaterial: the probed
   * value is `realpath`'s OUTPUT, whose final component is already resolved, so
   * neither call can be looking at a symlink.
   */
  readonly stat: PathStatResolver;
  /**
   * Defaults to `node:path`, already bound to the host platform. Injected as
   * `path.win32` by the suite to drive case-folded comparison and win32 root
   * shapes from POSIX CI. Read by EVERY path operation in this module: unlike
   * T1.5, there is no backstop here that deliberately uses the real
   * `node:path`, because a mismatch between the seam and the anchor's spelling
   * fails containment rather than loosening it.
   */
  readonly platformPath: PlatformPathModule;
}

/** `path.win32.sep`. The discriminator for case-folded comparison. */
const WINDOWS_PATH_SEPARATOR = "\\";

/**
 * The realpath used when no seam is injected, exported so a test can assert
 * WHICH implementation it is.
 *
 * The pin is structural because the casing half of the contract is only
 * OBSERVABLE on a case-insensitive filesystem, and CI's daemon leg is
 * ubuntu-only. Identity against this binding fails everywhere.
 */
export const DEFAULT_REALPATH: PathRealpathResolver = realpathFromFilesystem;

function resolveDeps(partial: Partial<TrustEnvelopeValidatorDeps>): TrustEnvelopeValidatorDeps {
  return {
    realpath: partial.realpath ?? DEFAULT_REALPATH,
    stat: partial.stat ?? statFromFilesystem,
    platformPath: partial.platformPath ?? nodePath,
  };
}

// --------------------------------------------------------------------------
// Component-wise path comparison
// --------------------------------------------------------------------------
//
// The three functions below are exported for ONE consumer: T1.5's resolver
// (`./repo-root-resolver.js`), whose `root_mismatch` check must decide the same
// containment question this module's bind-side boundary decides. Sharing the
// implementation rather than re-spelling it is what keeps the two verdicts
// identical — a sixth prose-only twin of a CONTAINMENT rule is exactly the
// hazard the `PlatformPathModule` note above flags. `stripTrailingSeparators`
// stays module-private: it is a splitting detail of `toComparableComponents`
// and of the join below, and no caller outside this file needs it.

/**
 * Drops trailing separators so a root spelled with one (`/`, `C:\`,
 * `\\server\share\`) splits into the same components as one spelled without.
 * The filesystem root collapses to the empty string, which is exactly the
 * leading component every absolute POSIX path already carries.
 */
function stripTrailingSeparators(path: string, separator: string): string {
  let end = path.length;
  while (end > 0 && path.charAt(end - 1) === separator) {
    end -= 1;
  }
  return path.slice(0, end);
}

/**
 * The comparable form of a path: its components, case-folded where the INJECTED
 * module's separator is win32's — not where the host filesystem happens to be
 * case-insensitive. The two are different populations, and the module header's
 * APFS paragraph states why the gap is the safe direction rather than an
 * oversight.
 *
 * Splitting on the platform separator alone is deliberate. On win32 the
 * filesystem accepts `/` as well, but both values reaching this function in
 * production are separator-normalized — the anchor by T1.5's `realpath`, the
 * candidate by the `realpath` in the pipeline below — so a mixed-separator
 * value can only arrive from a caller that broke that postcondition, and it
 * fails containment rather than sliding past it.
 */
export function toComparableComponents(
  path: string,
  platformPath: PlatformPathModule,
): readonly string[] {
  const components = stripTrailingSeparators(path, platformPath.sep).split(platformPath.sep);
  if (platformPath.sep !== WINDOWS_PATH_SEPARATOR) {
    return components;
  }
  return components.map((component) => component.toLowerCase());
}

/**
 * Is `candidate` the same path as `anchor`, or beneath it?
 *
 * Component-wise, so a boundary can never be crossed mid-name: `/repo-evil`
 * has a first component of `repo-evil`, which is simply not `repo`.
 */
export function isContainedWithin(
  candidateComponents: readonly string[],
  anchorComponents: readonly string[],
): boolean {
  if (candidateComponents.length < anchorComponents.length) {
    return false;
  }
  for (let index = 0; index < anchorComponents.length; index += 1) {
    if (candidateComponents[index] !== anchorComponents[index]) {
      return false;
    }
  }
  return true;
}

/** Component equality — containment in both directions. */
export function componentsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && isContainedWithin(left, right);
}

// --------------------------------------------------------------------------
// TrustEnvelopeValidator
// --------------------------------------------------------------------------

/**
 * Proves a `WorkspaceBind` execution root is inside the session's declared
 * local trust envelope, or refuses the bind.
 *
 * Stateless and safe to share. Nothing is cached: an envelope verdict is a
 * statement about the filesystem at one instant, and a remembered one would
 * outlive the arrangement of symlinks it was computed from.
 */
export class TrustEnvelopeValidator {
  private readonly deps: TrustEnvelopeValidatorDeps;

  public constructor(deps: Partial<TrustEnvelopeValidatorDeps> = {}) {
    this.deps = resolveDeps(deps);
  }

  /**
   * Resolve and validate one bind candidate, returning the execution root to
   * persist as `workspaces.fs_root`.
   *
   * The returned root is symlink-resolved and proven contained within
   * `mountCanonicalRoot`, which is itself proven to be one of the session's
   * attached canonical roots. Callers use this value verbatim; re-deriving a
   * root from the request's `directory` discards the guarantee (header).
   *
   * @throws {TrustEnvelopeViolationError} on every refusal — a foreign or
   *   malformed anchor, an escape by traversal, symlink, or absolute
   *   redirection, any candidate the filesystem declines to resolve, and a
   *   resolved root that is not a directory (I-009-3; the fail-closed residual
   *   is documented in the header).
   */
  public async validateExecutionRoot(candidate: WorkspaceExecutionRootCandidate): Promise<string> {
    const { platformPath } = this.deps;
    const anchor = candidate.mountCanonicalRoot;

    // Step 1 — refuse a relative anchor before it can be completed against the
    // daemon's own working directory by the join below.
    if (!platformPath.isAbsolute(anchor)) {
      throw new TrustEnvelopeViolationError();
    }

    // Step 2 — admission. The anchor must BE one of the session's attached
    // canonical roots; see the header on why this is equality and why it runs
    // before the filesystem is touched.
    const anchorComponents = toComparableComponents(anchor, platformPath);
    const anchorIsAttachedToSession = candidate.sessionEnvelopeRoots.some(
      (envelopeRoot) =>
        platformPath.isAbsolute(envelopeRoot) &&
        componentsEqual(toComparableComponents(envelopeRoot, platformPath), anchorComponents),
    );
    if (!anchorIsAttachedToSession) {
      throw new TrustEnvelopeViolationError();
    }

    // Step 3 — join WITHOUT lexical normalization, so `..` reaches the
    // filesystem intact (header).
    const spelledCandidate = this.joinCandidatePath(anchor, candidate.directory);

    // Step 4 — the filesystem resolves symlinks and `..`. A path it will not
    // resolve is a path whose containment cannot be proven, so it is refused.
    let resolvedRoot: string;
    try {
      resolvedRoot = await this.deps.realpath(spelledCandidate);
    } catch {
      throw new TrustEnvelopeViolationError();
    }

    // Step 5 — the boundary check, on the RESOLVED form.
    if (!isContainedWithin(toComparableComponents(resolvedRoot, platformPath), anchorComponents)) {
      throw new TrustEnvelopeViolationError();
    }

    // Containment against an absolute anchor almost carries absoluteness with
    // it, but not for a BARE-ROOT anchor: `C:\` and `/` reduce to a single
    // component that a degenerate resolved value (`C:`, ``) also matches. A
    // real `realpath` cannot produce either, so this closes a broken-seam path
    // rather than a reachable one. It deliberately uses the INJECTED module —
    // T1.5's real-`node:path` backstop pattern would reject every win32 value
    // on a POSIX host, disabling the win32 tests instead of guarding them.
    if (!platformPath.isAbsolute(resolvedRoot)) {
      throw new TrustEnvelopeViolationError();
    }

    // Step 6 — the resolved root must be a DIRECTORY. Containment says where the
    // path is; this says whether it can serve as `workspaces.fs_root` at all,
    // and nothing downstream re-asks (header). A `stat` that throws is refused
    // for the same reason a `realpath` that throws is: an unprovable property is
    // not a satisfied one. Last, so every earlier refusal keeps its own cause.
    let resolvedRootStats: { isDirectory(): boolean };
    try {
      resolvedRootStats = await this.deps.stat(resolvedRoot);
    } catch {
      throw new TrustEnvelopeViolationError();
    }
    if (!resolvedRootStats.isDirectory()) {
      throw new TrustEnvelopeViolationError();
    }

    return resolvedRoot;
  }

  /**
   * The spelled candidate: the anchor, the anchor plus a relative
   * `directory`, or an absolute `directory` standing on its own.
   *
   * An empty `directory` binds the mount root, matching an absent one — the
   * anchor is a legitimate bind target, so there is nothing for the empty
   * string to mean instead.
   *
   * Trailing separators are stripped from the anchor before joining so a root
   * of `/` yields `/sub` rather than `//sub`, which POSIX leaves
   * implementation-defined.
   *
   * @throws {TrustEnvelopeViolationError} for a win32 absolute `directory`
   *   that names no volume.
   */
  private joinCandidatePath(anchor: string, directory: string | undefined): string {
    if (directory === undefined || directory.length === 0) {
      return anchor;
    }
    const { platformPath } = this.deps;
    if (platformPath.isAbsolute(directory)) {
      // `path.win32.isAbsolute` accepts any leading separator, so `\evil` and
      // `/evil` reach here naming no volume, and Windows would complete them
      // against the daemon's CURRENT DRIVE. Containment alone would still hold
      // the boundary, but the verdict on one identical request would become a
      // property of ambient host state — and its accept arm is unpinnable from
      // POSIX CI. T1.5 refuses the same shape on its own input for the same
      // reason; the parsed root separates the classes, since every complete
      // win32 root (`C:\`, `\\server\share\`) is longer than one character.
      if (
        platformPath.sep === WINDOWS_PATH_SEPARATOR &&
        platformPath.parse(directory).root.length <= 1
      ) {
        throw new TrustEnvelopeViolationError();
      }
      return directory;
    }
    return `${stripTrailingSeparators(anchor, platformPath.sep)}${platformPath.sep}${directory}`;
  }
}
