// Typed carriers for the five canonical `repo.*` error codes (Plan-009
// Phase 1 T1.4 — the first file in the Plan-009-owned `workspace/`
// directory).
//
// Spec coverage:
//   * `Spec-009 §Fallback Behavior` — "If canonical root resolution fails,
//     repo attach must fail explicitly rather than guessing." The explicit
//     failure is `RepoRootResolutionError`.
//   * `Spec-009 §Required Behavior` + `Spec-009 §Local Trust Envelope (V1
//     Definition)` — "The system must reject path traversal or workspace
//     binding outside the declared local trust envelope"; `..` traversal,
//     absolute-path redirection, and symlink escape are "rejected with the
//     typed `repo.outside_trust_envelope` error". The rejection is
//     `TrustEnvelopeViolationError`.
//   * `Spec-009 §Detach Semantics (V1 Definition)` — "Detach is refused with
//     `repo.detach_conflict` while any dependent workspace is `busy` ...
//     There is no force-detach in V1." The refusal is
//     `RepoDetachConflictError`.
//   * `error-contracts.md §Repo` — the ratified five-row registry (D-009-3)
//     these classes carry. Every code string and notional HTTP status below
//     is quoted from that table.
//
// Invariants carried here (canonical text in
// `docs/plans/009-repo-attachment-and-workspace-binding.md §Invariants`):
//   * I-009-2 (explicit resolution failure) — this module owns the CARRIER
//     leg: a typed class permanently fixed to `repo.root_resolution_failed`.
//     The never-guess-a-root enforcement binds on T1.5's resolver.
//   * I-009-3 (trust-envelope containment) — carrier leg only. The
//     symlink-resolved, component-boundary-aware containment check binds on
//     T1.6's validator.
//
// Why these extend `DaemonDomainError` rather than plain `Error`. The base
// (`packages/runtime-daemon/src/ipc/domain-error.ts`) is projected by a
// SINGLE `instanceof` branch in `mapJsonRpcError`, so all five reach the
// wire with no per-class mapper edit — ever: `code` becomes the envelope's
// `data.type` and `detail` becomes `data.fields` (through the substrate's
// `sanitizeFields` seam). This is the path Plan-009 ratifies rather than an
// implementation liberty. `Plan-009 §Preconditions` records BL-143 as a
// landed Phase 3 precondition because "without it, T3.6's wire assertions
// observe anonymous `-32603` errors instead of the ratified `repo.*` codes",
// and Phase 3 T3.6 consumes both that projection branch and "thrown
// domain-error classes ← this plan Phase 1 T1.4". Consistent with that,
// `jsonrpc-error-mapping.ts` is named nowhere in Plan-009 as a file any
// phase edits — only as a substrate it consumes.
//
// `jsonRpcCode` is set on exactly one carrier. `RepoMountNotFoundError` rides
// `-32602 InvalidParams`, which is not a choice this file makes: the base
// class fixes the rule — "a not-found namespace error rides `-32602`, like
// `session.not_found`", a supplied id that does not resolve being structurally
// a param-shape failure — and BL-143 landed `repo.not_found` at `-32602` as
// its worked example on both sides of the wire, in the daemon's
// `jsonrpc-error-mapping` suite and the SDK's `jsonRpcClient` suite. Pinning
// it here is what keeps Phase 3 from editing a Phase 1 carrier.
//
// The other four stay UNSET. None is a not-found shape, and no numeric is
// ratified for their rows. `error-contracts.md §Numeric Code Space (per
// JSON-RPC 2.0 §5.1)` bars MINTING numerics in the reserved range, not
// selecting a standard one, so what binds here is the absence of a ratified
// selection rather than that section. Unset yields the mapper's documented
// `-32603` default carrying the dotted identifier in `data.type` — the same
// ratified shape as the `gdpr.*` rows, where consumers "MUST discriminate on
// `data.type`" and the numeric stays coarse. `httpStatus` IS fixed per class,
// verbatim from the `error-contracts.md §Repo` status column, for the
// control-plane / observability symmetry the base class documents.
//
// Message discipline. `error-contracts.md §Repo` requires that
// `repo.outside_trust_envelope` and `repo.root_resolution_failed` messages
// "MUST NOT echo the attempted path", and Plan-009 T1.4 extends the ban to
// `fields`. Rather than leave that to throw-site discipline, NO class here
// accepts a caller-supplied message. That part is absolute: every message is
// derived from the class and its own arguments, so no prose channel exists.
//
// Beyond that the guarantee is uneven, and deliberately strongest on the two
// carriers the §Repo ban actually names. `RepoRootResolutionError` admits only
// a closed three-member enum and `TrustEnvelopeViolationError` admits nothing
// at all, so for those two no channel exists that a path could travel. The
// id-bearing pair is weaker by construction: `RepoMountNotFoundError` and
// `RepoAlreadyAttachedError` interpolate an unconstrained `string` id into
// both `message` and `detail`. They rest on those ids being opaque
// identifiers rather than paths — the daemon's internal convention is
// plain-string ids — with `sanitizeErrorMessage` / `sanitizeFields` as the
// enforcing layer should a caller ever pass something path-shaped. For the two
// named codes the substrate is the second layer, as the registry preamble
// describes it; for the id-bearing pair it is the first.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import { DaemonDomainError } from "../ipc/domain-error.js";

/**
 * The five canonical dotted identifiers of the `error-contracts.md §Repo`
 * registry (D-009-3), quoted verbatim.
 *
 * Type-bound locally rather than imported from `packages/contracts`: the
 * strings are daemon-internal in Phase 1, and Plan-009 T1.4 defers the
 * hoist-to-contracts decision to Phase 3, where SDK consumption first makes
 * them a shared cross-surface vocabulary.
 *
 * Note the asymmetry between the compile-time and instance-level surfaces.
 * Each `super()` call below pins its literal with `satisfies RepoErrorCode`,
 * so a mistyped code fails to compile — but the base declares `code` as
 * `string` and the subclasses deliberately do not redeclare it (under
 * `useDefineForClassFields` an uninitialized redeclaration is emitted as a
 * field and would clobber the value the base constructor just assigned).
 * Instances therefore expose `code: string`; consumers discriminate by
 * `instanceof`, never by narrowing `code`.
 */
export type RepoErrorCode =
  | "repo.not_found"
  | "repo.root_resolution_failed"
  | "repo.outside_trust_envelope"
  | "repo.already_attached"
  | "repo.detach_conflict";

/**
 * Runtime companion to `RepoErrorCode`, in `error-contracts.md §Repo` row
 * order. Exported so the suite can pin set-equality against the codes the
 * carriers actually emit, catching a registry row that gains no carrier and a
 * carrier that mints an unregistered code. Set-equality alone cannot see a
 * carrier the suite forgot to enumerate, so the suite pairs it with a census
 * of this module's exported constructors.
 *
 * Annotated explicitly: the package inherits `isolatedDeclarations` from the
 * root `tsconfig.base.json`, under which an un-annotated exported const
 * fails TS9010.
 */
export const REPO_ERROR_CODES: readonly RepoErrorCode[] = [
  "repo.not_found",
  "repo.root_resolution_failed",
  "repo.outside_trust_envelope",
  "repo.already_attached",
  "repo.detach_conflict",
];

/**
 * Why canonical-root resolution failed. Closed and non-path-bearing, so the
 * discriminant is safe to carry all the way to the wire — the same shape as
 * the ratified `transport.invalid_protocol_version` `{ reason }` payload.
 *
 * The member set is fixed by Plan-009 T1.4 to exactly these three. Note what
 * is deliberately NOT a member: "path is not a git repository" is not a
 * failure at all but the `Spec-009 §Fallback Behavior` plain-directory
 * classification, which T1.5 resolves to `vcsType: "none"`. A `git` binary
 * that is absent or fails routes to `vcs_error`, never to that fallback, so
 * a missing toolchain cannot silently reclassify a real repository.
 */
export type RepoRootResolutionReason = "path_not_found" | "not_readable" | "vcs_error";

/**
 * Fixed, path-free message per resolution-failure reason. A lookup rather
 * than interpolation, so the text cannot vary with throw-site input. Typing
 * it as a total `Record` over the union makes a future reason without a
 * message a compile error rather than an `undefined` message.
 */
const ROOT_RESOLUTION_MESSAGES: Record<RepoRootResolutionReason, string> = {
  path_not_found: "canonical repository root resolution failed: the supplied path does not exist",
  not_readable: "canonical repository root resolution failed: the supplied path is not readable",
  vcs_error:
    "canonical repository root resolution failed: the version-control root query did not complete",
};

/**
 * `repo.not_found` — "Repo mount does not exist" (`error-contracts.md
 * §Repo`, notional HTTP 404).
 *
 * Carries the unresolved mount id, mirroring the `SessionNotFoundError`
 * `{ sessionId }` precedent. This code is not one of the two the §Repo
 * no-echo ban names, and the id it interpolates is an opaque identifier by
 * daemon convention rather than by type — see the header's message-discipline
 * note on why the substrate is the enforcing layer for this carrier.
 */
export class RepoMountNotFoundError extends DaemonDomainError {
  /** The mount id that did not resolve. Projects to `data.fields.repoMountId`. */
  readonly repoMountId: string;

  constructor(repoMountId: string) {
    super(`repo mount ${repoMountId} does not exist`, {
      code: "repo.not_found" satisfies RepoErrorCode,
      // The one carrier with a ratified numeric — see the header. A supplied
      // id that does not resolve is a param-shape failure, not an internal
      // one, exactly as `session.not_found` is treated.
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      httpStatus: 404,
      detail: { repoMountId },
    });
    this.repoMountId = repoMountId;
  }
}

/**
 * `repo.root_resolution_failed` — "Canonical repository root could not be
 * resolved for the supplied path; attach fails explicitly rather than
 * guessing" (`error-contracts.md §Repo`, notional HTTP 422;
 * `Spec-009 §Fallback Behavior`). Carrier leg of I-009-2.
 *
 * The closed `reason` is the ONLY constructor argument. Because §Repo bars
 * this code's message from echoing the attempted path, the throw site is
 * given no channel to put one in — the attempted path stays in the
 * resolver's own scope and never enters the carrier.
 */
export class RepoRootResolutionError extends DaemonDomainError {
  /** Non-path-bearing failure discriminant. Projects to `data.fields.reason`. */
  readonly reason: RepoRootResolutionReason;

  constructor(reason: RepoRootResolutionReason) {
    super(ROOT_RESOLUTION_MESSAGES[reason], {
      code: "repo.root_resolution_failed" satisfies RepoErrorCode,
      httpStatus: 422,
      detail: { reason },
    });
    this.reason = reason;
  }
}

/**
 * `repo.outside_trust_envelope` — "Path or workspace binding resolves
 * outside the session's declared local trust envelope"
 * (`error-contracts.md §Repo`, notional HTTP 403;
 * `Spec-009 §Local Trust Envelope (V1 Definition)`). Carrier leg of I-009-3.
 *
 * Deliberately argument-free, and deliberately more conservative than the
 * registry requires. §Repo bars paths from this code's `message` and
 * Plan-009 T1.4 bars them from `fields` — but a NON-path discriminant would
 * not breach that ban: a violation-kind enum, the session id, or the mount id
 * would all be admissible. None is admitted because none is needed at this
 * layer. T1.6's validator distinguishes traversal, symlink escape, prefix
 * collision, and absolute escape in its own assertions, which never cross the
 * wire, and no consumer has asked to discriminate them on the envelope.
 *
 * Accepting nothing is what makes the ban structural rather than advisory,
 * and it leaves the widening decision to whoever first has a real consumer
 * for it — adding a parameter later is additive, whereas retracting a leaky
 * one after Phase 3 ships is not.
 */
export class TrustEnvelopeViolationError extends DaemonDomainError {
  constructor() {
    super(
      "workspace binding rejected: the resolved execution root is outside the session's declared local trust envelope",
      {
        code: "repo.outside_trust_envelope" satisfies RepoErrorCode,
        httpStatus: 403,
      },
    );
  }
}

/**
 * `repo.already_attached` — "The resolved canonical root is already actively
 * attached to this session on the same owning node" (`error-contracts.md
 * §Repo`, notional HTTP 409; the D-009-7 node-scoped active-mount
 * uniqueness refusal). Thrown by the Phase 2 attach service.
 *
 * Carries the conflicting mount's id rather than the canonical root, so the
 * refusal identifies the conflict without naming the path that caused it. As
 * with `RepoMountNotFoundError`, the id is opaque by daemon convention rather
 * than by type; the header's message-discipline note covers the residual.
 */
export class RepoAlreadyAttachedError extends DaemonDomainError {
  /** Id of the active mount already holding the canonical root. Projects to `data.fields.conflictingRepoMountId`. */
  readonly conflictingRepoMountId: string;

  constructor(conflictingRepoMountId: string) {
    super(
      `repo attach refused: the resolved canonical root is already actively attached on this node (repo mount ${conflictingRepoMountId})`,
      {
        code: "repo.already_attached" satisfies RepoErrorCode,
        httpStatus: 409,
        detail: { conflictingRepoMountId },
      },
    );
    this.conflictingRepoMountId = conflictingRepoMountId;
  }
}

/**
 * `repo.detach_conflict` — "Detach refused while a dependent workspace is
 * `busy`; no force-detach in V1" (`error-contracts.md §Repo`, notional HTTP
 * 409; `Spec-009 §Detach Semantics (V1 Definition)`). Thrown by the Phase 2
 * detach service.
 *
 * Carries the busy workspace ids so a client can name what to finish or
 * cancel. Both the own field and the wire `detail` hold copies, so a caller
 * that keeps mutating its array cannot retroactively rewrite an error that
 * has already been thrown.
 */
export class RepoDetachConflictError extends DaemonDomainError {
  /** Ids of the dependent workspaces still `busy`. Projects to `data.fields.busyWorkspaceIds`. */
  readonly busyWorkspaceIds: readonly string[];

  constructor(busyWorkspaceIds: readonly string[]) {
    super(
      `repo detach refused: ${busyWorkspaceIds.length} dependent workspace(s) still busy; there is no force-detach in V1`,
      {
        code: "repo.detach_conflict" satisfies RepoErrorCode,
        httpStatus: 409,
        detail: { busyWorkspaceIds: [...busyWorkspaceIds] },
      },
    );
    this.busyWorkspaceIds = [...busyWorkspaceIds];
  }
}
