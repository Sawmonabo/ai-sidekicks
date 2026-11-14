// The worktree popover's read of the project's checkout and trees, `worktree.status.read`, made
// each time the popover opens and again on `Try again` or after a removal. A read still out when
// the popover closes finishes while a picked root waits for its branch name, which the chip shows;
// otherwise it is abandoned, so nothing is read while the popover is closed and nothing pends.

import { useCallback, useEffect, useState } from "react";

import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorktreeStatusReadResponse } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/** Where the read stands. */
export type WorktreeStatusReading =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly status: WorktreeStatusReadResponse }
  | { readonly kind: "failed" };

/** The read, and the act that reads again. */
export interface WorktreeStatusBinding {
  readonly reading: WorktreeStatusReading;
  readonly readAgain: () => void;
}

/**
 * Read `projectId`'s trees for `sessionId` each time the popover opens, and while
 * `isRootNameAwaited` (a picked root waits to be named by its branch) until that read answers.
 */
export function useWorktreeStatus(
  bridge: PlatformBridge,
  projectId: ProjectId,
  sessionId: SessionId,
  isOpen: boolean,
  isRootNameAwaited: boolean,
): WorktreeStatusBinding {
  const [reading, setReading] = useState<WorktreeStatusReading>(LOADING);
  const [attempt, setAttempt] = useState(0);
  // Counted so each opening reads afresh even while a read for a waiting root is still out.
  const [openingCount, setOpeningCount] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setOpeningCount((count) => count + 1);
    }
  }
  const isReadWanted = isOpen || (isRootNameAwaited && reading.kind === "loading");
  useEffect(() => {
    if (!isReadWanted) {
      return undefined;
    }
    const read = new AbortController();
    setReading(LOADING);
    void callDaemon(
      bridge,
      "worktree.status.read",
      { projectId, sessionId },
      { signal: read.signal },
    ).then((reply) => {
      if (read.signal.aborted) {
        return;
      }
      setReading(reply.status === "served" ? { kind: "loaded", status: reply.value } : FAILED);
    });
    return () => {
      read.abort();
    };
  }, [bridge, projectId, sessionId, isReadWanted, openingCount, attempt]);
  const readAgain = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);
  return { reading, readAgain };
}

const LOADING: WorktreeStatusReading = { kind: "loading" };
const FAILED: WorktreeStatusReading = { kind: "failed" };
