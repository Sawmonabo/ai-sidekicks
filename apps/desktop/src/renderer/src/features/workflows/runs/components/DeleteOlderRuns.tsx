import type { WorkflowRunsDeletePreviewResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import {
  DELETE_OLDER_THAN_DAYS,
  useDeleteOlderRuns,
  type DeleteOlderThanDays,
} from "../hooks/useDeleteOlderRuns.js";
import { useInlineConfirm } from "../hooks/useInlineConfirm.js";
import { runCountWords } from "../../words.js";
import { ActionButton } from "../../components/ActionButton.js";

/**
 * `Delete runs older than…` above the runs table: it names how many runs would go and that their
 * snapshot folders and repository pins go with them, says that a run marked Keep stays and a run
 * waiting on a person is never touched, and asks once. Escape closes the choice and the confirm as
 * their `Cancel` does. Nothing it deletes can be brought back.
 */
export function DeleteOlderRuns(props: { readonly bridge: PlatformBridge }): React.JSX.Element {
  const act = useDeleteOlderRuns(props.bridge);
  const { state } = act;
  switch (state.kind) {
    case "closed":
      return <ActionButton onClick={act.open}>Delete runs older than…</ActionButton>;
    case "choosing":
      return (
        <ConfirmGroup label="Delete runs older than" onCancel={act.close}>
          <span>Delete runs older than</span>
          {DELETE_OLDER_THAN_DAYS.map((days) => (
            <ActionButton
              key={days}
              onClick={() => {
                act.choose(days);
              }}
            >
              {daysWords(days)}
            </ActionButton>
          ))}
          <ActionButton onClick={act.close}>Cancel</ActionButton>
        </ConfirmGroup>
      );
    case "previewing":
    case "deleting":
      return (
        <p className="meridian-workflows-delete-older" role="status">
          {state.kind === "previewing"
            ? `Counting the runs older than ${daysWords(state.days)}…`
            : `Deleting the runs older than ${daysWords(state.days)}…`}
        </p>
      );
    case "confirming":
      return (
        <ConfirmGroup label="Confirm the delete" onCancel={act.close}>
          <span>{confirmSentence(state.days, state.preview)}</span>
          {state.preview.deleteCount === 0 ? null : (
            <ActionButton onClick={act.confirm}>
              {`Delete ${runCountWords(state.preview.deleteCount)}`}
            </ActionButton>
          )}
          <ActionButton onClick={act.close}>
            {state.preview.deleteCount === 0 ? "Close" : "Cancel"}
          </ActionButton>
        </ConfirmGroup>
      );
    case "deleted":
      return (
        <p className="meridian-workflows-delete-older" role="status">
          {`Deleted ${runCountWords(state.deletedCount)}`}
          <ActionButton onClick={act.close}>Close</ActionButton>
        </p>
      );
    case "refused":
      return (
        <div className="meridian-workflows-delete-older">
          <InlineRefusal code={state.refusal.code} detail={state.refusal.detail} />
          <ActionButton onClick={act.close}>Close</ActionButton>
        </div>
      );
  }
}

/** A step of the act drawn in place, which takes focus and closes on Escape. */
function ConfirmGroup(props: {
  readonly label: string;
  readonly onCancel: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const confirm = useInlineConfirm(props.onCancel);
  return (
    <div
      ref={confirm.ref}
      className="meridian-workflows-delete-older"
      role="group"
      aria-label={props.label}
      onKeyDown={confirm.onKeyDown}
    >
      {props.children}
    </div>
  );
}

/** The confirm's one sentence: what goes, and what stays and why. */
function confirmSentence(
  days: DeleteOlderThanDays,
  preview: WorkflowRunsDeletePreviewResponse,
): string {
  const stays =
    "A run marked Keep stays, and a run waiting on a person is never touched" +
    (preview.keptCount + preview.waitingCount === 0
      ? "."
      : ` (${formatCount(preview.keptCount)} kept, ${formatCount(preview.waitingCount)} waiting).`);
  return preview.deleteCount === 0
    ? `No run older than ${daysWords(days)} can be deleted. ${stays}`
    : `${deleteQuestion(preview.deleteCount, days)} Their steps and data go with them, and any ` +
        `snapshot folders and repository pins they hold. ${stays} This cannot be undone.`;
}

function deleteQuestion(deleteCount: number, days: DeleteOlderThanDays): string {
  return `Delete ${runCountWords(deleteCount)} older than ${daysWords(days)}?`;
}

function daysWords(days: DeleteOlderThanDays): string {
  return `${formatCount(days)} days`;
}
