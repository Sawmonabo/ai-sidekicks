// The repos family's daemon seam: four `repo.*` calls, parsed, and one refusal shape.
//
// `SidekicksBridge.daemon.call` is a single generic door — a branded method name in,
// `unknown` out, until Plan-007 lands its discriminated unions. That leaves two jobs
// nobody above this file should be doing twice: naming the method, and turning the
// `unknown` reply into a value with a type. Both live here, once, so the reader
// beside this file holds parsed responses and the cards hold nothing else.
//
// EVERY REPLY IS PARSED BY THE CONTRACT'S OWN SCHEMA. `packages/contracts/src/repo.ts`
// and `worktree.ts` own these shapes and validate them in both directions on the
// daemon side; parsing here is the renderer's half of that, and it is what makes a
// `RepoMountReadResponse` in this console a value the wire actually sent rather than
// a cast over an `unknown`. A reply that does not parse is a REFUSAL, never a
// half-rendered card.
//
// THE METHOD NAMES ARE BRANDED ONCE, HERE. `DaemonMethod` is a Tier-1 brand
// (`packages/contracts/src/desktop-bridge.ts`) whose whole purpose is to make every
// call site acknowledge that the method-to-params mapping is still a stub. Four
// bindings at the top of one module is that acknowledgement written down; the same
// assertion sprinkled through a component tree would be four places to fix when
// Plan-007 replaces the brand with a real union, and the compiler would flag none of
// them.
//
// WHY THE REJECTION NORMALIZER IS HERE AND NOT IN `core/`. It is the FIRST of its
// kind in the console — `src/shared/wire-errors.ts` normalizes a rejection into an
// `Error`, which is the three legacy renderer families' currency, and nothing yet
// normalizes one into the console's own `ConsoleRefusal`. `apps/desktop/AGENTS.md`
// hoists a helper on its SECOND use, so it lives in the family that needed it first
// and moves down to `core/` the moment a second family calls a daemon method.

import {
  ExecutionModeSelectResponseSchema,
  RepoMountReadResponseSchema,
  WorkspaceExecutionModeCapabilitiesReadResponseSchema,
  WorkspaceListResponseSchema,
  type DaemonMethod,
  type ExecutionMode,
  type ExecutionModeSelectResponse,
  type RepoMountId,
  type RepoMountReadResponse,
  type SessionId,
  type WorkspaceExecutionModeCapabilitiesReadResponse,
  type WorkspaceId,
  type WorkspaceListResponse,
} from "@ai-sidekicks/contracts";
import { isWireErrorEnvelope, lossyStringify } from "../../../../shared/wire-errors.js";
import { isConsoleRefusal, refuse, type ConsoleRefusal } from "../core/index.js";
import type { ConsoleBridge } from "../bridge/index.js";

/** The subsystem every refusal this module raises names as its author. */
export const REPO_READS_REFUSAL_ORIGIN = "repos";

/**
 * Why a repos call failed on the console's side of the wire.
 *
 * Two members, closed, and neither overlaps a DAEMON code: a daemon refusal keeps
 * its own code verbatim (`repo.not_found`, `workspace.busy`, …) and is never
 * re-labelled with one of these. These name the two failures that are the
 * console's own to describe — a reply that did not match the contract, and a
 * rejection carrying no code at all.
 */
export const REPO_READ_REFUSAL_CODES = ["reply-unparseable", "call-rejected"] as const;

/** One console-side repos refusal code. Derived, so the vocabulary is declared once. */
export type RepoReadRefusalCode = (typeof REPO_READ_REFUSAL_CODES)[number];

/** A parsed reply, or the refusal that stands in its place. Never both, never neither. */
export type RepoCallOutcome<TValue> =
  | { readonly status: "read"; readonly value: TValue }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * The four method names, branded once.
 *
 * `Spec-023 §Console Design (Meridian)` §10.1 and §10.2 name six controls across the
 * two sections; `repo.attach`, `repo.workspaceBind`, and `repo.detach` are not among
 * these four for three different reasons, each recorded where the surface that would
 * call it lives: attach needs a node roster this section does not read, bind needs
 * the directory picker attach would open, and detach is offered by no renderer
 * surface at all in V1 (`Spec-009 §Detach Semantics (V1 Definition)`).
 */
const MOUNT_READ_METHOD = "repo.mountRead" as DaemonMethod;
const WORKSPACE_LIST_METHOD = "repo.workspaceList" as DaemonMethod;
const CAPABILITIES_READ_METHOD = "repo.executionModeCapabilitiesRead" as DaemonMethod;
const EXECUTION_MODE_SELECT_METHOD = "repo.executionModeSelect" as DaemonMethod;

/** Minimal parse surface, so this module composes schemas without importing zod. */
interface ReplyParser<TValue> {
  parse(reply: unknown): TValue;
}

/** One mount, with the freshly probed health verdict only this read carries. */
export async function readRepoMount(
  bridge: ConsoleBridge,
  repoMountId: RepoMountId,
): Promise<RepoCallOutcome<RepoMountReadResponse>> {
  return callRepoMethod(bridge, MOUNT_READ_METHOD, { repoMountId }, RepoMountReadResponseSchema);
}

/**
 * Every workspace in the session.
 *
 * SESSION-SCOPED, and it is also how the section learns which mounts exist: there is
 * no `repo.mountList` on the wire, and `workspaces.repo_mount_id` is NOT NULL under
 * the mount-first funnel, so the workspace roster names every mount that has one —
 * which, per `Spec-009 §Default Behavior`, is every mount, since attach always mints
 * a default `read-only` workspace.
 */
export async function readSessionWorkspaces(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<RepoCallOutcome<WorkspaceListResponse>> {
  return callRepoMethod(
    bridge,
    WORKSPACE_LIST_METHOD,
    // The one place the console re-narrows a session id. The store holds it as a
    // plain string because it arrived from the wire as one; `SessionId` is a
    // compile-time marker over that same opaque value, and the console never mints
    // one — it forwards the one it was given.
    { sessionId: sessionId as SessionId },
    WorkspaceListResponseSchema,
  );
}

/**
 * Which modes this workspace may take now.
 *
 * The WORKSPACE-scoped arm of the two the one method admits — the post-bind question.
 * The mount-scoped arm answers the pre-bind question and belongs to the bind flow,
 * and the request refuses if both are named, so the two are never sent together.
 */
export async function readExecutionModeCapabilities(
  bridge: ConsoleBridge,
  workspaceId: WorkspaceId,
): Promise<RepoCallOutcome<WorkspaceExecutionModeCapabilitiesReadResponse>> {
  return callRepoMethod(
    bridge,
    CAPABILITIES_READ_METHOD,
    { workspaceId },
    WorkspaceExecutionModeCapabilitiesReadResponseSchema,
  );
}

/**
 * Record one explicit mode switch.
 *
 * EXACTLY ONE MUTATION per switch. `Spec-010 §Interfaces And Contracts` forbids a
 * client-sequenced select-then-prepare chain, so this function sends the select and
 * stops — the workspace's own `ready -> provisioning -> ready` transition is what the
 * row renders next, on its existing id.
 */
export async function selectExecutionMode(
  bridge: ConsoleBridge,
  workspaceId: WorkspaceId,
  executionMode: ExecutionMode,
): Promise<RepoCallOutcome<ExecutionModeSelectResponse>> {
  return callRepoMethod(
    bridge,
    EXECUTION_MODE_SELECT_METHOD,
    { workspaceId, executionMode },
    ExecutionModeSelectResponseSchema,
  );
}

async function callRepoMethod<TValue>(
  bridge: ConsoleBridge,
  method: DaemonMethod,
  params: unknown,
  parser: ReplyParser<TValue>,
): Promise<RepoCallOutcome<TValue>> {
  let reply: unknown;
  try {
    reply = await bridge.sidekicks.daemon.call(method, params);
  } catch (error) {
    return { status: "refused", refusal: refusalFromRejection(method, error) };
  }
  try {
    return { status: "read", value: parser.parse(reply) };
  } catch (error) {
    return {
      status: "refused",
      refusal: refuse(
        REPO_READS_REFUSAL_ORIGIN,
        "reply-unparseable" satisfies RepoReadRefusalCode,
        `${method} answered with a shape the contract does not admit: ${lossyStringify(error)}`,
      ),
    };
  }
}

/**
 * Turn a rejection into the console's one refusal shape, keeping the daemon's own
 * code wherever the rejection carries one.
 *
 * Three arms, most specific first:
 *   1. A value that already IS a `ConsoleRefusal`, or an error carrying one — the
 *      fixture bridge's `FixtureBridgeError` and every other `ConsoleRefusalError`
 *      arrive this way, and re-labelling them would lose the origin they name.
 *   2. A typed wire envelope — `repo.not_found`, `repo.outside_trust_envelope`,
 *      `workspace.busy`, and every other daemon code. The code and the message pass
 *      through VERBATIM (rule 9: the console never paraphrases the daemon), and the
 *      origin becomes this family so a refusal three layers from here still names
 *      where it surfaced.
 *   3. Anything else, rendered through the total stringifier, under the one code the
 *      console owns for "the call was rejected and said nothing machine-readable".
 */
export function refusalFromRejection(method: string, rejection: unknown): ConsoleRefusal {
  const carried: unknown =
    rejection instanceof Error && "refusal" in rejection
      ? (rejection as { readonly refusal: unknown }).refusal
      : rejection;
  if (isConsoleRefusal(carried)) {
    return carried;
  }
  if (isWireErrorEnvelope(rejection)) {
    return refuse(REPO_READS_REFUSAL_ORIGIN, rejection.code, rejection.message);
  }
  return refuse(
    REPO_READS_REFUSAL_ORIGIN,
    "call-rejected" satisfies RepoReadRefusalCode,
    `${method} was rejected: ${lossyStringify(rejection)}`,
  );
}
