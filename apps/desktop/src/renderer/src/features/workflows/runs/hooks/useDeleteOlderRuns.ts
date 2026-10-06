import { useCallback, useRef, useState } from "react";

import type { WorkflowRunsDeletePreviewResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { MILLISECONDS_PER_DAY } from "#renderer/lib/instant.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/** The ages `Delete runs older than…` offers, in days; the first is the one it opens on. */
export const DELETE_OLDER_THAN_DAYS = [30, 90, 365] as const;

/** One of the offered ages. */
export type DeleteOlderThanDays = (typeof DELETE_OLDER_THAN_DAYS)[number];

/** The count an age would delete, and the cut-off it was read for, which the delete sends. */
export interface DeleteOlderRunsPreview extends WorkflowRunsDeletePreviewResponse {
  readonly olderThan: string;
}

/**
 * Where the act stands: closed, open on an age with the count it would delete once read, or
 * done with the count the delete itself removed.
 */
export type DeleteOlderRunsState =
  | { readonly kind: "closed" }
  | {
      readonly kind: "open";
      readonly days: DeleteOlderThanDays;
      /** The count for `days`, once read; absent while it is being read. */
      readonly preview?: DeleteOlderRunsPreview;
      readonly isDeleting: boolean;
      /** Why the count or the delete was refused, said beside the choice. */
      readonly refusal?: Refusal;
    }
  | { readonly kind: "deleted"; readonly deletedCount: number };

/** The act's state and the presses that move it. */
export interface DeleteOlderRunsHold {
  readonly state: DeleteOlderRunsState;
  readonly open: () => void;
  readonly close: () => void;
  readonly choose: (days: DeleteOlderThanDays) => void;
  readonly confirm: () => void;
}

/**
 * `Delete runs older than…`: open on the first age and read how many runs it would delete, read
 * again for each age picked, confirm once, and say how many went. The count said after is the
 * delete's own, since runs may start or end between the count and the delete; a count for an age
 * no longer picked is dropped.
 */
export function useDeleteOlderRuns(bridge: PlatformBridge): DeleteOlderRunsHold {
  const clock = useClock();
  const [state, setState] = useState<DeleteOlderRunsState>({ kind: "closed" });
  // Which count read is the newest, so an answer for an age picked before it is dropped.
  const previewRound = useRef(0);
  const choose = useCallback(
    (days: DeleteOlderThanDays) => {
      const round = previewRound.current + 1;
      previewRound.current = round;
      const olderThan = new Date(clock.now() - days * MILLISECONDS_PER_DAY).toISOString();
      setState({ kind: "open", days, isDeleting: false });
      void callDaemon(bridge, "workflow.runsDeletePreview", { olderThan }).then((reply) => {
        if (previewRound.current !== round) {
          return;
        }
        setState(
          reply.status === "refused"
            ? { kind: "open", days, isDeleting: false, refusal: reply.refusal }
            : { kind: "open", days, isDeleting: false, preview: { olderThan, ...reply.value } },
        );
      });
    },
    [bridge, clock],
  );
  const open = useCallback(() => {
    choose(DELETE_OLDER_THAN_DAYS[0]);
  }, [choose]);
  const close = useCallback(() => {
    previewRound.current += 1;
    setState({ kind: "closed" });
  }, []);
  const confirm = useCallback(() => {
    if (state.kind !== "open" || state.preview === undefined || state.isDeleting) {
      return;
    }
    const { days, preview } = state;
    previewRound.current += 1;
    setState({ kind: "open", days, preview, isDeleting: true });
    void callDaemon(bridge, "workflow.runsDelete", { olderThan: preview.olderThan }).then(
      (reply) => {
        setState(
          reply.status === "refused"
            ? { kind: "open", days, preview, isDeleting: false, refusal: reply.refusal }
            : { kind: "deleted", deletedCount: reply.value.deletedCount },
        );
      },
    );
  }, [bridge, state]);
  return { state, open, close, choose, confirm };
}
