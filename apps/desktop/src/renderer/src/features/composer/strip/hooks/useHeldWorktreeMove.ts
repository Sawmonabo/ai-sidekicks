// The worktree move a pick asked for and the daemon holds until the run ends. A root picked before
// its branch was read waits for the trees' read, which names it by that branch when it lands.

import { useCallback, useState } from "react";

/** A picked row: its name, and its branch, `undefined` for a root whose branch is not read yet. */
export interface MoveTarget {
  readonly name: string;
  readonly branchName: string | undefined;
}

/** The row a pick was pressed on: the repo root's, whichever path it was read with, or a tree's. */
export type PickedRow =
  | { readonly kind: "root" }
  | { readonly kind: "worktree"; readonly path: string };

/** Hold the move a pick asked for while the session works in `currentName`. */
export function useHeldWorktreeMove(currentName: string): HeldWorktreeMove {
  const [pendingMove, setPendingMove] = useState<PendingMove | undefined>(undefined);
  // The move waits only until the session's listed branch is its target's, or, for a root picked
  // before its branch was read, until the listing leaves the one it was picked from.
  const isMoveApplied =
    pendingMove !== undefined &&
    (pendingMove.branchName === undefined
      ? pendingMove.fromName !== currentName
      : pendingMove.branchName === currentName);
  const pending = isMoveApplied ? undefined : pendingMove;
  // Each read that lands names the root, so a fresh read on reopening leaves the chip on the name
  // it last had until the new read gives one.
  const nameRoot = useCallback((branchName: string) => {
    setPendingMove((held) =>
      held !== undefined && held.branchName === undefined && held.name !== branchName
        ? { ...held, name: branchName }
        : held,
    );
  }, []);
  return {
    pending,
    isRootNameAwaited: pending !== undefined && pending.branchName === undefined,
    holdMove: setPendingMove,
    nameRoot,
  };
}

/** A move the daemon holds until the run ends: its target, its row, and the tree it left. */
interface PendingMove extends MoveTarget {
  readonly row: PickedRow;
  readonly fromName: string;
}

/** The move still held, and the acts that hold, drop and name one. */
interface HeldWorktreeMove {
  /** The held move, `undefined` with none or once the run boundary applied it. */
  readonly pending: PendingMove | undefined;
  /** Whether the held move is to a root whose branch no read has named yet. */
  readonly isRootNameAwaited: boolean;
  /** Hold `move` until the run ends, or, given `undefined`, drop the move held. */
  readonly holdMove: (move: PendingMove | undefined) => void;
  /** Name a held move to a root by the branch a read of the trees found the root on. */
  readonly nameRoot: (branchName: string) => void;
}
