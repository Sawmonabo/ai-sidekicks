// The worktree move a pick asked for and the daemon holds until the run ends, with the popover's
// read of the trees. The two are one hook because each feeds the other: a root picked before its
// branch was read keeps the read going, and the read names that root once it lands.

import { useState } from "react";

import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useWorktreeStatus, type WorktreeStatusBinding } from "./useWorktreeStatus.js";

/** A picked row: its name, and its branch, `undefined` for a root whose branch is not read yet. */
export interface MoveTarget {
  readonly name: string;
  readonly branchName: string | undefined;
}

/** The row a pick was pressed on: the repo root's, whichever path it was read with, or a tree's. */
export type PickedRow =
  | { readonly kind: "root" }
  | { readonly kind: "worktree"; readonly path: string };

/** A move the daemon holds until the run ends: its target, its row, and the tree it left. */
export interface PendingMove extends MoveTarget {
  readonly row: PickedRow;
  readonly fromName: string;
}

/** The move still held, the act that holds or drops one, and the trees' read. */
export interface HeldWorktreeMove extends WorktreeStatusBinding {
  /** The held move, `undefined` with none or once the run boundary applied it. */
  readonly pending: PendingMove | undefined;
  readonly holdMove: (move: PendingMove | undefined) => void;
}

/**
 * Hold the move a pick asked for while the session works in `currentName`, and read the
 * project's trees each time the popover opens and while a picked root waits to be named.
 */
export function useHeldWorktreeMove(
  bridge: PlatformBridge,
  projectId: ProjectId,
  sessionId: SessionId,
  isOpen: boolean,
  currentName: string,
): HeldWorktreeMove {
  const [pendingMove, setPendingMove] = useState<PendingMove | undefined>(undefined);
  // The move waits only until the session's listed branch is its target's, or, for a root picked
  // before its branch was read, until the listing leaves the one it was picked from.
  const isMoveApplied =
    pendingMove !== undefined &&
    (pendingMove.branchName === undefined
      ? pendingMove.fromName !== currentName
      : pendingMove.branchName === currentName);
  const pending = isMoveApplied ? undefined : pendingMove;
  const { reading, readAgain } = useWorktreeStatus(
    bridge,
    projectId,
    sessionId,
    isOpen,
    // A root picked before the read landed is named by that read, open or closed.
    pending !== undefined && pending.branchName === undefined,
  );
  // A root picked before its branch was read takes that branch's name once a read gives it, so a
  // fresh read on reopening leaves the chip on the name it last had. Set during the render, so
  // no pass commits the name the read already replaced.
  if (
    pending !== undefined &&
    pending.branchName === undefined &&
    reading.kind === "loaded" &&
    pending.name !== reading.status.repoRoot.branchName
  ) {
    setPendingMove({ ...pending, name: reading.status.repoRoot.branchName });
  }
  return { pending, holdMove: setPendingMove, reading, readAgain };
}
