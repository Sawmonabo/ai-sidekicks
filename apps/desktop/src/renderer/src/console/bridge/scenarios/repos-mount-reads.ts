// The two entity-scoped `repo.*` reads this scenario answers, and the tables behind them.
//
// SPLIT OFF `repos-replies.ts` ON ITS OWN SEAM. That module holds the answers a call
// gets, and its answers divide the way the wire does: the SESSION-scoped ones are a
// constant per method, while these two name the thing they want and are computed per
// request. Together they had passed the size `apps/desktop/AGENTS.md` calls two jobs;
// apart, this file is the entity tables and their one reader, and the module next door
// is the session-scoped rows and the list that composes every reply.
//
// `ScenarioEngine.replyFor` matches on the method NAME, so a constant reply is one
// answer for every call of that method — right for `repo.workspaceList`, which is
// session-scoped, and wrong for `repo.mountRead` and
// `repo.executionModeCapabilitiesRead`, which each name the thing they want. Both are
// `resultFor` computations over the request, keyed by the tables below; a request
// naming no entity this scenario holds returns `undefined` and the fixture refuses,
// which is the honest answer for a scenario that scripts three mounts and is asked
// about a fourth.
//
// THREE MOUNTS, AND NO TWO OF THEM ARE ONE ROW WITH A DIFFERENT ID. The GIT mount is
// the ordinary healthy checkout. The PLAIN mount is `none`-vcs and `unreachable`,
// agreeing with the `workspace.stale` beat and with its workspace row's own
// `lastError`; its capabilities are the D-009-5 answer for a non-git mount —
// `read-only` alone, with a reason per excluded mode, which is the I-009-8 explicit
// gap. The DRIFTED mount is a git checkout whose root still resolves and is no longer
// the repository it was attached as. A fixture serving the git answer for all three
// would have drawn four execution modes on a mount that can host one, and would have
// left two of the three health verdicts unreachable.

import {
  DRIFTED_MOUNT_ID,
  DRIFTED_WORKSPACE_ID,
  GIT_MOUNT_ID,
  GIT_WORKSPACE_ID,
  NODE_ID,
  PLAIN_MOUNT_ID,
  PLAIN_WORKSPACE_ID,
  SESSION_ID,
} from "./repos-fixture-data.js";
import { secondsBeforeStart } from "./repos-beats.js";

/**
 * What `repo.mountRead` answers, per mount.
 *
 * The GIT mount's `localPath` and `canonicalRoot` differ on purpose: it was entered
 * from a nested subdirectory, which is the case that separates provenance from
 * resolved identity and the reason the card surfaces both. The PLAIN mount's agree,
 * because it was entered at its own root — the contrast is what makes the pair worth
 * scripting rather than one row twice.
 *
 * The plain mount is `unreachable`, agreeing with the `workspace.stale` beat and with
 * the `lastError` its workspace row carries below. Health is the one axis this read
 * alone carries, so a session whose every mount is healthy cannot reach the degraded
 * card at all.
 */
const MOUNT_READS_BY_MOUNT_ID: Readonly<Record<string, unknown>> = {
  [GIT_MOUNT_ID]: {
    id: GIT_MOUNT_ID,
    sessionId: SESSION_ID,
    nodeId: NODE_ID,
    localPath: "/Users/dev/code/ai-sidekicks/packages/contracts",
    canonicalRoot: "/Users/dev/code/ai-sidekicks",
    vcsType: "git",
    state: "attached",
    health: { status: "healthy", checkedAt: secondsBeforeStart(9) },
    attachedAt: secondsBeforeStart(53 * 60 + 11),
  },
  [PLAIN_MOUNT_ID]: {
    id: PLAIN_MOUNT_ID,
    sessionId: SESSION_ID,
    nodeId: NODE_ID,
    localPath: "/Users/dev/notes",
    canonicalRoot: "/Users/dev/notes",
    // `none`, which is `Spec-009`'s honest non-git classification (I-009-4) and not a
    // third "unknown" verdict: the resolver either found a repository or did not.
    vcsType: "none",
    state: "attached",
    health: { status: "unreachable", checkedAt: secondsBeforeStart(9) },
    // BEHIND THE SCENARIO'S OWN START, like every stamp in this file, and therefore
    // NOT the instant the `repo.attached` beat carries. The two are not one instant:
    // a beat's `occurredAt` is where the line sits in a replay window two seconds
    // wide, and this is the durable row's own field, which is what a card measures an
    // age against. Spelled as the beat's position, as it was, every card drew an age
    // in the future.
    attachedAt: secondsBeforeStart(23 * 60 + 4),
  },
  [DRIFTED_MOUNT_ID]: {
    id: DRIFTED_MOUNT_ID,
    sessionId: SESSION_ID,
    nodeId: NODE_ID,
    // Entered at its own root, and still resolving to it: the path is fine and the
    // repository behind it is not the one that was attached. That is what separates
    // this verdict from `unreachable` on the row above, where the path itself is the
    // thing that stopped answering.
    localPath: "/Users/dev/code/vendor-sdk",
    canonicalRoot: "/Users/dev/code/vendor-sdk",
    vcsType: "git",
    // STILL `attached`, which is the pairing that makes the row worth scripting: the
    // lifecycle axis says the mount is live in the session and the health axis says it
    // can never bind again, and a console collapsing the two into one chip would have
    // to pick one of those and be wrong about the other.
    state: "attached",
    health: { status: "identity_mismatch", checkedAt: secondsBeforeStart(9) },
    attachedAt: secondsBeforeStart(2 * 60 * 60 + 41),
  },
};

/**
 * What the workspace-scoped arm of `repo.executionModeCapabilitiesRead` answers.
 *
 * `defaultMode` is deliberately NOT the workspace's current mode: the git row below is
 * bound `branch` and the plain one `read-only`, while this field reports the default
 * for the next writable coding run — `worktree` on the git mount, which agrees with
 * neither. The picker labels the two separately and a reader who conflates them will
 * think one is wrong.
 *
 * The plain workspace is the D-009-5 answer for a `none` mount: `read-only` alone,
 * `read-only` as the default because no writable mode exists to default to, and a
 * reason for each excluded mode — I-009-8's explicit-gap mandate, which is the half a
 * surface renders when it explains why a control is not offered.
 */
const CAPABILITIES_BY_WORKSPACE_ID: Readonly<Record<string, unknown>> = {
  [GIT_WORKSPACE_ID]: {
    // All four, with no `restrictions` map at all, because a git mount restricts
    // nothing (D-009-5), and `worktree` the default per ADR-006.
    availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
    defaultMode: "worktree",
  },
  [DRIFTED_WORKSPACE_ID]: {
    // A GIT MOUNT'S FULL SET, unrestricted — because the capabilities read answers
    // what the MOUNT's kind admits and knows nothing about health. What withholds this
    // workspace's controls is the mount card's own posture, read off the health
    // verdict, and scripting a restriction here instead would put the console's reason
    // in the daemon's mouth.
    availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
    defaultMode: "worktree",
  },
  [PLAIN_WORKSPACE_ID]: {
    availableModes: ["read-only"],
    defaultMode: "read-only",
    restrictions: {
      branch: "This mount is not a git repository, so there is no branch to create.",
      worktree: "This mount is not a git repository, so no worktree can be added.",
      "ephemeral clone": "This mount is not a git repository, so there is nothing to clone.",
    },
  },
};

/**
 * What the MOUNT-scoped arm of the same read answers — the pre-bind preview.
 *
 * A SECOND TABLE AND NOT A REUSE OF THE ONE ABOVE, because the two arms answer two
 * questions: this one is "what could a workspace on this mount do", which is what the
 * bind form offers before any workspace exists, and the workspace-scoped one is "what
 * may this workspace do now". The values agree here because the mount's kind is what
 * decides both — but they agree by construction rather than by sharing a row, and a
 * fixture that shared one could not script a mount whose existing workspace has been
 * narrowed since it was bound.
 */
const CAPABILITIES_BY_MOUNT_ID: Readonly<Record<string, unknown>> = {
  [GIT_MOUNT_ID]: {
    availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
    defaultMode: "worktree",
  },
  [DRIFTED_MOUNT_ID]: {
    // The mount's KIND admits everything a git checkout admits, and this read knows
    // nothing about health. What withholds the bind control on that card is the card's
    // own posture, read off the health verdict — scripting a restriction here would put
    // the console's reason in the daemon's mouth.
    availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
    defaultMode: "worktree",
  },
  [PLAIN_MOUNT_ID]: {
    availableModes: ["read-only"],
    defaultMode: "read-only",
    restrictions: {
      branch: "This mount is not a git repository, so there is no branch to create.",
      worktree: "This mount is not a git repository, so no worktree can be added.",
      "ephemeral clone": "This mount is not a git repository, so there is nothing to clone.",
    },
  },
};

/**
 * The answer this table holds for the entity one request names, or `undefined`.
 *
 * The request reaches a computed reply as `unknown` and is read rather than cast: a
 * fixture that trusted the shape would throw from inside the settlement seam on a
 * malformed call, where the fixture's own "scripts no reply" refusal is the answer a
 * surface can act on. `undefined` reaches the caller as exactly that refusal.
 */
function answerFor(
  answersByEntityId: Readonly<Record<string, unknown>>,
  entityIdMember: string,
  request: unknown,
): unknown {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const requestedEntityId = (request as Readonly<Record<string, unknown>>)[entityIdMember];
  return typeof requestedEntityId === "string" ? answersByEntityId[requestedEntityId] : undefined;
}

/**
 * The mount this scenario holds for the id one request names, or `undefined`.
 *
 * `Spec-009`'s only health-carrying read, answered per mount.
 */
export function mountReadFor(request: unknown): unknown {
  return answerFor(MOUNT_READS_BY_MOUNT_ID, "repoMountId", request);
}

/**
 * The capabilities this scenario holds for the workspace one request names.
 *
 * The WORKSPACE-scoped arm of `repo.executionModeCapabilitiesRead` — the post-bind
 * question the mode picker asks. The mount-scoped arm is the pre-bind preview the bind
 * flow sends, and the request refuses if both are named, so the two never travel
 * together and this table answers only the one it is keyed for.
 */
export function capabilitiesFor(request: unknown): unknown {
  const mountAnswer = answerFor(CAPABILITIES_BY_MOUNT_ID, "repoMountId", request);
  const workspaceAnswer = answerFor(CAPABILITIES_BY_WORKSPACE_ID, "workspaceId", request);
  if (mountAnswer !== undefined && workspaceAnswer !== undefined) {
    // BOTH-PRESENT IS REFUSED RATHER THAN RESOLVED, which is what the request's own
    // exactly-one refinement does: a handler picking one would answer the narrower
    // per-workspace question to a pre-bind caller, silently.
    return undefined;
  }
  return mountAnswer ?? workspaceAnswer;
}
