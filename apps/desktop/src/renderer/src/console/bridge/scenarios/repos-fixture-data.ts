// The repos scenario's cast: its identifiers, its two agents, and its three
// attachments.
//
// Split out of `repos.ts` when that file passed the size the structure rules set,
// and split along THIS seam rather than an arbitrary one: what a scenario IS
// divides into the record the beats and the replies are two views of, the beats
// themselves, and the answers a call gets. The identifiers below are named by both
// of the other two — a beat states that a worktree was created and a reply states
// where it is — so a copy in either would be the drift this file exists to make
// impossible.
//
// THE IDS ARE UUID-SHAPED, WHICH THIS SCENARIO ORIGINALLY ARGUED THEY NEED NOT BE.
// The premise of that argument was that "no console module parses one" — and the
// repos section does: it parses every `repo.*` reply with the contract's own schema
// (`packages/contracts/src/repo.ts`), and `RepoMountIdSchema` / `WorkspaceIdSchema` /
// `SessionIdSchema` / `NodeIdSchema` are UUID-formatted. A readable id here would be
// a value the wire cannot carry, which is the one thing a fixture may never script.
// Legibility moves to the NAMES, which is where a failing assertion reads them; what
// reaches the screen is what the daemon would actually send.

import {
  NodeIdSchema,
  ParticipantIdSchema,
  RepoMountIdSchema,
  RunIdSchema,
  SessionIdSchema,
  WorkspaceIdSchema,
  type NodeId,
  type ParticipantId,
  type RepoMountId,
  type RunId,
  type SessionId,
  type WorkspaceId,
} from "@ai-sidekicks/contracts";

// BRANDED WHERE THE CORPUS REGISTERS A BRAND FOR THE AXIS, `: string` WHERE IT DOES
// NOT, AND MINTED THROUGH THE SCHEMA RATHER THAN `as`-CAST. A scenario constant is
// where a fixture chooses the bytes, and a cast asserts a brand without checking it —
// so a malformed id surfaced at the first `.strict()` reply that carried it, which
// takes the whole reply down and names the reply rather than the value. Parsing at
// declaration fails the module instead, naming the constant. The worktree, clone,
// branch-context, artifact, attachment, and manifest ids below carry no registered
// brand, so they keep the explicit `: string` — a brand invented here would be a
// second vocabulary for one the corpus has not minted.
export const SESSION_ID: SessionId = SessionIdSchema.parse("9f2c4a10-0000-4000-8000-000000000001");
export const NODE_ID: NodeId = NodeIdSchema.parse("9f2c4a10-0000-4000-8000-000000000002");
export const GIT_MOUNT_ID: RepoMountId = RepoMountIdSchema.parse(
  "9f2c4a10-0000-4000-8000-000000000003",
);
export const PLAIN_MOUNT_ID: RepoMountId = RepoMountIdSchema.parse(
  "9f2c4a10-0000-4000-8000-000000000004",
);
export const GIT_WORKSPACE_ID: WorkspaceId = WorkspaceIdSchema.parse(
  "9f2c4a10-0000-4000-8000-000000000005",
);
export const PLAIN_WORKSPACE_ID: WorkspaceId = WorkspaceIdSchema.parse(
  "9f2c4a10-0000-4000-8000-000000000006",
);
// The THIRD mount and its default workspace — a git checkout whose root still
// resolves and is no longer the repository it was attached as. It is a mount of its
// own rather than a re-verdicting of one of the two above, because the health verdict
// it carries is reachable from neither: `identity_mismatch` requires a persisted
// identity anchor, which the plain-directory mount has none of, and the git mount
// above is the one healthy row the section's ordinary state is drawn from.
export const DRIFTED_MOUNT_ID: RepoMountId = RepoMountIdSchema.parse(
  "9f2c4a10-0000-4000-8000-000000000007",
);
export const DRIFTED_WORKSPACE_ID: WorkspaceId = WorkspaceIdSchema.parse(
  "9f2c4a10-0000-4000-8000-000000000008",
);
// The FOURTH mount and its default workspace, and the only pair no read answers for
// until an act has been sent: they are what `repo.attach` mints. Declared here beside
// the three the session opens with rather than in the mutation table, because they are
// identifiers of the same cast — an id the attach reply names and the workspace card
// then reads is one entity, and two spellings of it would be exactly the drift this
// module exists to prevent. Nothing renders them until the dialog has been used.
export const ATTACHED_MOUNT_ID: RepoMountId = RepoMountIdSchema.parse(
  "9f2c4a10-0000-4000-8000-000000000009",
);
export const ATTACHED_WORKSPACE_ID: WorkspaceId = WorkspaceIdSchema.parse(
  "9f2c4a10-0000-4000-8000-00000000000a",
);
// The people and agents in the session. Wire-declared UUIDs rather than readable
// placeholders: the wire-truth predicate presents each beat to the strict contract
// layer as the whole envelope it claims to be, and a beat whose actor is not the
// UUID the contract declares is a beat no daemon could emit.
export const PARTICIPANT_YOU: ParticipantId = ParticipantIdSchema.parse(
  "9f2c4a10-0000-4000-8000-000000000010",
);
export const AGENT_IMPLEMENTER: string = "9f2c4a10-0000-4000-8000-000000000011";
export const AGENT_REVIEWER: string = "9f2c4a10-0000-4000-8000-000000000012";
// One execution root per agent, which is what makes the worktree surface a list rather
// than a row.
export const IMPLEMENTER_WORKTREE_ID: string = "9f2c4a10-0000-4000-8000-000000000020";
export const REVIEWER_WORKTREE_ID: string = "9f2c4a10-0000-4000-8000-000000000021";
// The third execution root, and the only one of the OTHER kind. Clone transitions
// are not separately evented — no `clone.*` type is in the census — so a clone
// reaches a surface through `repo.worktreeStatusRead` and through nothing else,
// which is exactly why a scenario that scripted none left that whole list
// undrawable.
export const EPHEMERAL_CLONE_ID: string = "9f2c4a10-0000-4000-8000-000000000022";
// The fourth root, and the only SWEPT one. `cleanedAt` decides a clone's disposition
// ahead of its deadline, and a fixture whose every clone was unswept could not reach
// the reclaimed reading at all — which is the arm that says the files are gone rather
// than hedging that they may be.
export const RECLAIMED_CLONE_ID: string = "9f2c4a10-0000-4000-8000-000000000023";
// The two roots a PREPARE mints, and the branch context the worktree one carries.
// Distinct from the four above for `ATTACHED_MOUNT_ID`'s reason: a prepare that
// answered with a root the session already holds would be indistinguishable from a
// reuse, which is the one distinction the reuse-check control exists to draw.
export const PREPARED_WORKTREE_ID: string = "9f2c4a10-0000-4000-8000-000000000024";
export const PREPARED_CLONE_ID: string = "9f2c4a10-0000-4000-8000-000000000025";
export const IMPLEMENTER_RUN_ID: RunId = RunIdSchema.parse("9f2c4a10-0000-4000-8000-000000000030");
// One branch context per worktree, because `branch_contexts` upserts a row per
// `(workspace, worktree)` binding: two roots in one workspace are two contexts, and a
// fixture answering both with one would let a gate render the other root's branch.
export const IMPLEMENTER_BRANCH_CONTEXT_ID: string = "9f2c4a10-0000-4000-8000-000000000040";
export const REVIEWER_BRANCH_CONTEXT_ID: string = "9f2c4a10-0000-4000-8000-000000000041";
export const PREPARED_BRANCH_CONTEXT_ID: string = "9f2c4a10-0000-4000-8000-000000000042";

/**
 * The two branch names three replies state, and the diff plane compares between.
 *
 * HERE BECAUSE THREE MODULES NAME THEM, which is this file's own rule: the branch
 * context carries the base and the head, the worktree row carries the same head as its
 * `branchName` — a comment there already says the two must be one string — and the diff
 * plane scripts the run-attributed change set as the comparison BETWEEN them. Written
 * as literals in three places they drift in exactly the direction nothing catches: a
 * fixture whose diff is taken over a base its own branch context denies.
 *
 * Only these two are hoisted. The reviewer's branch and the two clones' are named by
 * one reply each, and a constant with one reader is a level of indirection rather than
 * a defence against drift.
 */
export const GIT_MOUNT_BASE_BRANCH: string = "develop";
export const IMPLEMENTER_BRANCH: string = "feat/rate-limit-wiring";
export const DIFF_ARTIFACT_ID: string = "9f2c4a10-0000-4000-8000-000000000050";
export const PINNED_ATTACHMENT_ID: string = "9f2c4a10-0000-4000-8000-000000000051";
export const REPLICATING_ATTACHMENT_ID: string = "9f2c4a10-0000-4000-8000-000000000052";
export const EXPIRED_ATTACHMENT_ID: string = "9f2c4a10-0000-4000-8000-000000000053";
// The MANIFEST each diff artifact hangs off, and the second diff a workspace-level
// create mints.
//
// TWO IDS PER DIFF, BECAUSE THE CREATE MINTS TWO ROWS. `DiffArtifactCreateResponse`
// answers with a `diffArtifactId` AND the `artifactManifestId` its computed payload was
// written under, and the bytes are reached by the manifest — so a fixture carrying one
// id for both could not answer the payload read at all without teaching a surface that
// a diff artifact and its manifest are the same row.
//
// AND TWO DIFFS, BECAUSE THE CREATE HAS TWO ARMS. The run-attributed arm is the diff the
// implementer's run produced — the one the `diff.created` beat above already names — and
// the workspace-fallback arm is a diff taken over the git workspace with no run to
// attribute it to. A scenario answering both arms with one change set could not show
// that the console tells the two attributions apart.
export const DIFF_MANIFEST_ID: string = "9f2c4a10-0000-4000-8000-000000000054";
export const WORKSPACE_DIFF_ARTIFACT_ID: string = "9f2c4a10-0000-4000-8000-000000000055";
export const WORKSPACE_DIFF_MANIFEST_ID: string = "9f2c4a10-0000-4000-8000-000000000056";

/**
 * Where the git workspace's runs execute, and the checkout that encloses it.
 *
 * TWO CONSTANTS BECAUSE TWO REPLIES STATE THEM and the pair is the subject of the
 * three-path disclosure: the workspace roster reports the bound root as that
 * workspace's `fsRoot`, and the execution-context read reports the same bound root
 * beside the normalized checkout root the snapshot service operates on. Written as
 * literals in both places they would drift in exactly the direction the disclosure
 * reads, which is how the fixture came to state one directory spelled two ways and
 * call it three roots that differ.
 *
 * THE BOUND ROOT IS NESTED INSIDE THE CHECKOUT ROOT, WHICH IS THE CASE THE DISCLOSURE
 * EXISTS FOR. `Spec-010 §Turn-Boundary Snapshots` names it: a workspace bound at a
 * subdirectory of its checkout normalizes to the enclosing working-tree TOP LEVEL,
 * because capture is cwd-scoped while restore updates the whole tree — so the two
 * values are genuinely different facts about one binding rather than two spellings of
 * one path. The relationship is what the scenario asserts; byte inequality alone would
 * have passed against the trailing-`/.` fixture that stated nothing.
 *
 * AND THE CHECKOUT IS A DIFFERENT TOP LEVEL FROM THE MOUNT'S OWN ROOT, which is what
 * makes all three rows differ. That spec's branch-mode sentence admits it directly:
 * the execution root is the participant's own live working tree, main checkout or
 * linked worktree, whichever the workspace bound. Neither of the two daemon-created
 * worktrees this scenario holds is reused for it — one is held by an active run and
 * the other was provisioned for `worktree` mode, and a branch-mode binding sharing
 * either would double-book a root the busy rule keys on.
 */
export const GIT_WORKSPACE_CHECKOUT_ROOT: string = "/Users/dev/code/ai-sidekicks-develop";
/** The subdirectory of that checkout this workspace is bound at. */
export const GIT_WORKSPACE_BOUND_ROOT: string = `${GIT_WORKSPACE_CHECKOUT_ROOT}/packages/contracts`;

/** One agent in the cast, with the execution root the worktree beats give it. */
export interface ReposScenarioAgent {
  readonly agentId: string;
  readonly name: string;
  readonly driverName: string;
  readonly modelId: string;
  readonly worktreeId: string;
  /** When the attach beat fires, in scenario time. Its wire stamp is derived from it. */
  readonly attachedAtMs: number;
}

/**
 * The two agents, and the execution root each one holds.
 *
 * One table rather than a literal per beat, on the flagship scenario's rule: an
 * `agent.attached` payload and the worktree beats that follow it are views of one
 * record, and two hand-written copies of one agent drift in exactly the direction
 * nothing catches. The drivers are deliberately mixed — a repos fixture whose whole
 * cast runs one provider cannot show what a two-provider session's roots look like.
 */
export const REPOS_AGENTS: readonly ReposScenarioAgent[] = [
  {
    agentId: AGENT_IMPLEMENTER,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
    worktreeId: IMPLEMENTER_WORKTREE_ID,
    attachedAtMs: 80,
  },
  {
    agentId: AGENT_REVIEWER,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    worktreeId: REVIEWER_WORKTREE_ID,
    attachedAtMs: 120,
  },
];

/** One attachment, and where its payload stands on this node. */
export interface ReposScenarioAttachment {
  readonly artifactId: string;
  readonly replicationStatus: string;
  /** When the publish beat fires, in scenario time. Its wire stamp is derived from it. */
  readonly atMs: number;
}

/**
 * The three attachments, and where each one's payload stands on this node.
 *
 * `Spec-014 §Fallback Behavior` requires an unresolved attachment to sit in its
 * declared position carrying its own cause, so the three rows below are three
 * different causes rather than three copies of one — a pinned payload the console
 * can open, one the publisher has not finished replicating, and one whose bytes are
 * no longer obtainable and whose remedy is a re-publish while the publisher is
 * online. `replicationStatus` is the additive member a relay-pinned
 * `artifact.published` carries per `Spec-006 §Artifact and Diff Publication (artifact_publication)`.
 */
export const REPOS_ATTACHMENTS: readonly ReposScenarioAttachment[] = [
  {
    artifactId: PINNED_ATTACHMENT_ID,
    replicationStatus: "pinned",
    atMs: 1360,
  },
  {
    artifactId: REPLICATING_ATTACHMENT_ID,
    replicationStatus: "pending_replication",
    atMs: 1400,
  },
  {
    artifactId: EXPIRED_ATTACHMENT_ID,
    replicationStatus: "expired",
    atMs: 1440,
  },
];

/** The sequence the first `agent.attached` beat takes. One beat precedes it. */
export const FIRST_AGENT_SEQUENCE: number = 2;

/** The sequence the first `worktree.created` beat takes. Seven beats precede it. */
export const FIRST_WORKTREE_SEQUENCE: number = 8;

/** The sequence the first attachment's `artifact.published` beat takes. */
export const FIRST_ATTACHMENT_SEQUENCE: number = 17;
