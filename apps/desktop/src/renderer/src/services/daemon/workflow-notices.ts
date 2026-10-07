// The machine's workflow stream, read. `workflow.subscribe` sends the start hold first and then
// every run, step, schedule and definition change, and each frame is parsed here against the
// contract's notification schema, so the workflows screens hold a typed notice or know a frame
// could not be read. An unreadable frame is recorded in the window's diagnostic capture and
// handed on as such, so its reader can read everything again rather than act on a guess. A stream
// that ends is opened again, and its reader told so: whatever moved in the gap went unheard, so it
// reads everything again then too. A re-open that throws is handed on as its refusal, and the next
// re-open that works as the stream opened again.

import {
  WorkflowSubscribeNotificationSchema,
  type WorkflowSubscribeNotification,
} from "@ai-sidekicks/contracts/workflow/subscription";

import type { Unsubscribe } from "#shared/preload-api.js";
import type { Clock } from "#renderer/lib/clock.js";
import { recordRefusedMemberPaths } from "#renderer/lib/diagnostic-capture/refused-member-record.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { openReopeningSubscription } from "../transport/reopening-subscription.js";
import { WORKFLOW_NOTICE_STREAM } from "#shared/daemon/streams.js";

/**
 * One frame of the workflow stream: a parsed notice, one that did not match the contract, word
 * that the stream ended and was opened again, so notices between the two were missed, or the
 * refusal of a re-open that threw, while the stream stays down and is tried again.
 */
export type WorkflowNoticeFrame =
  | { readonly kind: "notice"; readonly notice: WorkflowSubscribeNotification }
  | { readonly kind: "unreadable" }
  | { readonly kind: "reopened" }
  | { readonly kind: "reopenRefused"; readonly refusal: Refusal };

/**
 * Open the machine's workflow stream over every run this daemon ran, handing each frame on
 * parsed, and keep it open until released. Each open is reported to the transport's reconnect
 * signal like every stream opening. It never throws: an open that throws, the first included,
 * arrives as a `reopenRefused` frame and is tried again. `clock` times the waits between re-opens.
 */
export function subscribeWorkflowNotices(
  bridge: PlatformBridge,
  clock: Clock,
  onFrame: (frame: WorkflowNoticeFrame) => void,
): Unsubscribe {
  return openReopeningSubscription({
    signal: bridge.transportReconnect,
    clock,
    subject: WORKFLOW_NOTICE_STREAM,
    firstOpenFailure: "refuseAndRetry",
    open: (deliver, onEnded) =>
      bridge.daemon.subscribe(WORKFLOW_NOTICE_STREAM, {}, deliver, onEnded),
    onFrame: (payload) => {
      const parsed = WorkflowSubscribeNotificationSchema.safeParse(payload);
      if (parsed.success) {
        onFrame({ kind: "notice", notice: parsed.data });
        return;
      }
      recordRefusedMemberPaths({
        source: "services/daemon",
        kind: "notice-unreadable",
        subject: WORKFLOW_NOTICE_STREAM,
        issues: parsed.error.issues,
      });
      onFrame({ kind: "unreadable" });
    },
    // A refusal cleared is always followed by the re-open that cleared it, which says so.
    onReopenRefusal: (refusal) => {
      if (refusal !== undefined) {
        onFrame({ kind: "reopenRefused", refusal });
      }
    },
    onReopened: () => {
      onFrame({ kind: "reopened" });
    },
  });
}
