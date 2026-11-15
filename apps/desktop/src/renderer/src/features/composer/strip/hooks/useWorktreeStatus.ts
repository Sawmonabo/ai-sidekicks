// The worktree popover's read of the project's checkout and trees, `worktree.status.read`, made
// each time the popover opens and again on `Try again` or after a removal. A read still out when
// the popover closes finishes while a picked root waits for its branch name, which the chip shows;
// otherwise it is abandoned, so nothing is read while the popover is closed and nothing pends.
// Each read that lands is handed to `onLoaded`, which names a waiting root.

import { useCallback, useEffect, useState } from "react";

import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorktreeStatusReadResponse } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/** Where the read stands. */
export type WorktreeStatusReading =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly status: WorktreeStatusReadResponse }
  | { readonly kind: "failed" };

/** When the trees are read: at each opening of the popover, and while a picked root waits. */
export interface WorktreeStatusAsk {
  readonly isOpen: boolean;
  /** How many times the popover has opened, counted where it opens; each opening reads afresh. */
  readonly openingCount: number;
  /** A picked root waits to be named by its branch, so a read out at the close still finishes. */
  readonly isRootNameAwaited: boolean;
}

/** The read, and the act that reads again. */
export interface WorktreeStatusBinding {
  readonly reading: WorktreeStatusReading;
  readonly readAgain: () => void;
}

/**
 * Read `projectId`'s trees for `sessionId` as `ask` says, handing each read that lands to
 * `onLoaded`, which needs no stable identity.
 */
export function useWorktreeStatus(
  bridge: PlatformBridge,
  projectId: ProjectId,
  sessionId: SessionId,
  ask: WorktreeStatusAsk,
  onLoaded: (status: WorktreeStatusReadResponse) => void,
): WorktreeStatusBinding {
  const [reading, setReading] = useState<WorktreeStatusReading>(LOADING);
  const [attempt, setAttempt] = useState(0);
  const latestOnLoaded = useLatestRef(onLoaded);
  const { openingCount } = ask;
  const isReadWanted = ask.isOpen || (ask.isRootNameAwaited && reading.kind === "loading");
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
      if (reply.status === "refused") {
        setReading(FAILED);
        return;
      }
      setReading({ kind: "loaded", status: reply.value });
      latestOnLoaded.current(reply.value);
    });
    return () => {
      read.abort();
    };
  }, [bridge, projectId, sessionId, isReadWanted, openingCount, attempt, latestOnLoaded]);
  const readAgain = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);
  return { reading, readAgain };
}

const LOADING: WorktreeStatusReading = { kind: "loading" };
const FAILED: WorktreeStatusReading = { kind: "failed" };
