import { useCallback, useState } from "react";

import type { WorkflowRunsDeletePreviewResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { MILLISECONDS_PER_DAY } from "#renderer/lib/instant.js";
import type { Refusal } from "#renderer/lib/refusal/refusal.js";
import { callDaemon } from "#renderer/services/daemon/daemon-reply.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";

/** The ages `Delete runs older than…` offers, in days. */
export const DELETE_OLDER_THAN_DAYS = [7, 30, 90] as const;

/** One of the offered ages. */
export type DeleteOlderThanDays = (typeof DELETE_OLDER_THAN_DAYS)[number];

/** Where the act stands, from closed through the confirm it asks once to what it removed. */
export type DeleteOlderRunsState =
  | { readonly kind: "closed" }
  | { readonly kind: "choosing" }
  | { readonly kind: "previewing"; readonly days: DeleteOlderThanDays }
  | {
      readonly kind: "confirming";
      readonly days: DeleteOlderThanDays;
      readonly olderThan: string;
      readonly preview: WorkflowRunsDeletePreviewResponse;
    }
  | { readonly kind: "deleting"; readonly days: DeleteOlderThanDays }
  | { readonly kind: "deleted"; readonly deletedCount: number }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/** The act's state and the presses that move it. */
export interface DeleteOlderRunsHold {
  readonly state: DeleteOlderRunsState;
  readonly open: () => void;
  readonly close: () => void;
  readonly choose: (days: DeleteOlderThanDays) => void;
  readonly confirm: () => void;
}

/**
 * `Delete runs older than…`: pick an age, read how many runs would go and how many older ones stay
 * because they are kept or waiting, confirm once, and say how many went. The count said after is
 * the delete's own, since runs may start or end between the preview and the delete.
 */
export function useDeleteOlderRuns(bridge: PlatformBridge): DeleteOlderRunsHold {
  const clock = useClock();
  const [state, setState] = useState<DeleteOlderRunsState>({ kind: "closed" });
  const open = useCallback(() => {
    setState({ kind: "choosing" });
  }, []);
  const close = useCallback(() => {
    setState({ kind: "closed" });
  }, []);
  const choose = useCallback(
    (days: DeleteOlderThanDays) => {
      const olderThan = new Date(clock.now() - days * MILLISECONDS_PER_DAY).toISOString();
      setState({ kind: "previewing", days });
      void callDaemon(bridge, "workflow.runsDeletePreview", { olderThan }).then((reply) => {
        setState(
          reply.status === "refused"
            ? { kind: "refused", refusal: reply.refusal }
            : { kind: "confirming", days, olderThan, preview: reply.value },
        );
      });
    },
    [bridge, clock],
  );
  const confirm = useCallback(() => {
    if (state.kind !== "confirming") {
      return;
    }
    setState({ kind: "deleting", days: state.days });
    void callDaemon(bridge, "workflow.runsDelete", { olderThan: state.olderThan }).then((reply) => {
      setState(
        reply.status === "refused"
          ? { kind: "refused", refusal: reply.refusal }
          : { kind: "deleted", deletedCount: reply.value.deletedCount },
      );
    });
  }, [bridge, state]);
  return { state, open, close, choose, confirm };
}
