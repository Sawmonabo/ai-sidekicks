// What the repos section renders from, declared apart from the two classes that write it.
//
// SPLIT OUT ON THE SEAM THIS FAMILY ALREADY USES TWICE. `proposal-gate-model.ts` sits
// beside its reader and its acts for exactly this reason: the reading is what BOTH
// halves publish, so a shape declared inside either one makes the other import the
// class it collaborates with in order to name the value they share. Here that would
// have been a cycle — the reader hosts the selections and the selections publish the
// reading — and a shape module is the honest answer rather than a type-only import
// that a layering gate would have to be taught to forgive.
//
// EVERY FIELD IS A DIFFERENT KIND OF NOTHING, WHICH IS WHY THERE ARE SO MANY. Rule 8
// separates "not checked", "empty", "not loaded", and a refusal, and this shape is
// where that separation is paid for: a status, two refusal fields at two scopes, a
// read-position marker, and three per-workspace maps. Collapsing any pair would make
// one absence render as another.

import type {
  ExecutionMode,
  RepoMountReadResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceListResponse,
} from "@ai-sidekicks/contracts";
import type { ConsoleRefusal } from "../core/index.js";
import type { EphemeralCloneStatusRecord, WorktreeStatusRecord } from "./worktree-model.js";

/** One workspace row, exactly as `WorkspaceListResponse` spells it. */
export type RepoWorkspaceRow = WorkspaceListResponse["workspaces"][number];

/**
 * Everything the section renders from, in one immutable value.
 *
 * `status` is the read's own position, three-valued for the three absences rule 8
 * separates: `not-read` before the first read, `reading` while one is in flight,
 * `read` afterwards — this reader's spelling, not the `not-checked` the pure models
 * use for a question never put. A fourth "failed" member would collapse the refusal
 * in; it is its own field, so a partial answer — some read, one refused — survives.
 */
export interface RepoMountsReading {
  readonly status: "not-read" | "reading" | "read";
  readonly mounts: readonly RepoMountReadResponse[];
  readonly workspaces: readonly RepoWorkspaceRow[];
  /** Every worktree this session holds, in the order the status read returned them. */
  readonly worktrees: readonly WorktreeStatusRecord[];
  /**
   * Every ephemeral clone this session holds, in the order the same read returned them.
   *
   * ITS OWN FIELD, never folded into `worktrees`: the two record kinds are two shapes —
   * one mount-anchored over ten columns, the other workspace-anchored over nine — and
   * this console draws them as two lists (`RepoSection.tsx` owns that split). Keeping only
   * `worktrees` reported a session running in the `ephemeral clone` execution mode as
   * holding no execution root at all: the daemon's answer discarded rather than drawn.
   */
  readonly ephemeralClones: readonly EphemeralCloneStatusRecord[];
  /**
   * The instant this reading was taken, on the reader's own clock.
   *
   * Carried here rather than read off the wall clock by the cards that render an age,
   * because `Spec-023 §Rules every console surface obeys` forbids interval polling:
   * an age moves when the surface RE-READS and at no other time, where a card reading
   * `Date.now()` in its render body would move it on any unrelated re-render. Zero
   * before the first read, which no card renders against — every one is behind `read`.
   */
  readonly readAtMilliseconds: number;
  readonly capabilitiesByWorkspaceId: Readonly<
    Record<string, WorkspaceExecutionModeCapabilitiesReadResponse>
  >;
  /** The read's own failure, when the section as a whole could not be answered. */
  readonly refusal: ConsoleRefusal | undefined;
  /**
   * The root read's own failure, scoped to it.
   *
   * Its own field rather than folded into `refusal`, on the same rule the per-workspace
   * map follows: a session whose mounts and workspaces answered and whose roots did not
   * is a PARTIAL answer, and collapsing the two would either hide the gap or report the
   * whole section as unread when most of it is on screen.
   */
  readonly worktreeRefusal: ConsoleRefusal | undefined;
  /**
   * Whether the execution-root read was made at all.
   *
   * NEITHER OF THE TWO FIELDS ABOVE CAN SAY IT, which is why this one exists. A session
   * whose WORKSPACE list refused never reaches the root read, and that path publishes an
   * empty `ephemeralClones` with no `worktreeRefusal` — the same two values a served
   * session holding no clone publishes. Without this the clone list would report "this
   * session holds no ephemeral clone" over a question nobody put, which is rule 8's
   * `empty` standing in for `not-checked`.
   */
  readonly worktreeReadPosition: "not-made" | "made";
  /** Per workspace: the daemon's answer to a capabilities read or a mode switch. */
  readonly refusalByWorkspaceId: Readonly<Record<string, ConsoleRefusal>>;
  /**
   * Per workspace: the mode a switch is on the wire for, where one is.
   *
   * THE MODE AND NOT A BOOLEAN, because the picker has to SAY which switch it is
   * holding for — a group that greyed out while a participant watched, over a row still
   * showing the mode the workspace is bound as now, reports nothing at all about what
   * was pressed. A workspace with no entry is a workspace with nothing on the wire.
   *
   * KEYED PER WORKSPACE rather than one register for the section, because two
   * workspaces switching are two independent mutations on two rows: holding the
   * section's whole picker set because one row is waiting would refuse a press that
   * cannot collide with anything.
   */
  readonly pendingModeByWorkspaceId: Readonly<Record<string, ExecutionMode>>;
}

/** The reading before anything has been asked. Every absence in its unasked form. */
export const NOTHING_READ_YET: RepoMountsReading = {
  status: "not-read",
  mounts: [],
  workspaces: [],
  worktrees: [],
  ephemeralClones: [],
  readAtMilliseconds: 0,
  capabilitiesByWorkspaceId: {},
  refusal: undefined,
  worktreeRefusal: undefined,
  worktreeReadPosition: "not-made",
  refusalByWorkspaceId: {},
  pendingModeByWorkspaceId: {},
};
