import { useId } from "react";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import {
  DELETE_OLDER_THAN_DAYS,
  useDeleteOlderRuns,
  type DeleteOlderThanDays,
} from "../hooks/useDeleteOlderRuns.js";
import { useInlineConfirm } from "../hooks/useInlineConfirm.js";
import { runCountWords } from "../../words.js";
import { ActionButton } from "../../components/ActionButton.js";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";

/**
 * `Delete runs older than…` above the runs table: it opens in place on `30 days`, names how many
 * runs that age would delete and says that a run marked Keep stays and a run waiting on a person
 * is never touched, with `Cancel` first and the delete after it in the destructive face, so
 * nothing is deleted by a stray Enter. Escape closes it as `Cancel` does. Nothing it deletes can
 * be brought back.
 */
export function DeleteOlderRuns(props: { readonly bridge: PlatformBridge }): React.JSX.Element {
  const act = useDeleteOlderRuns(props.bridge);
  const { state } = act;
  switch (state.kind) {
    case "closed":
      return <ActionButton onClick={act.open}>Delete runs older than…</ActionButton>;
    case "deleted":
      return (
        <span className="meridian-workflows-delete-older">
          <ActionButton onClick={act.open}>Delete runs older than…</ActionButton>
          <AnnouncedLine
            element="span"
            words={`${runCountWords(state.deletedCount)} deleted · runs marked Keep stayed`}
            politeness="polite"
          />
        </span>
      );
    case "open": {
      const deleteCount = state.preview?.deleteCount;
      return (
        <DeleteOlderChoice days={state.days} onChoose={act.choose} onCancel={act.close}>
          {deleteCount === undefined ? null : (
            <span>
              {`${runCountWords(deleteCount)} would go. A run marked Keep stays, and a run ` +
                "waiting on a person is never touched."}
            </span>
          )}
          {state.refusal === undefined ? null : (
            <InlineRefusal code={state.refusal.code} detail={state.refusal.detail} />
          )}
          <ActionButton onClick={act.close}>Cancel</ActionButton>
          <ActionButton
            className="meridian-action-button--destructive"
            disabled={deleteCount === undefined || deleteCount === 0 || state.isDeleting}
            onClick={act.confirm}
          >
            {`Delete ${runCountWords(deleteCount ?? 0)}`}
          </ActionButton>
        </DeleteOlderChoice>
      );
    }
  }
}

/** The ages' words, as the age list reads them. */
const DELETE_OLDER_THAN_WORDS: Readonly<Record<DeleteOlderThanDays, string>> = {
  30: "30 days",
  90: "90 days",
  365: "a year",
};

/**
 * The act drawn in place: the age list under `Older than`, which takes focus when it opens so the
 * next key reaches it, and closes on Escape.
 */
function DeleteOlderChoice(props: {
  readonly days: DeleteOlderThanDays;
  readonly onChoose: (days: DeleteOlderThanDays) => void;
  readonly onCancel: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const ageId = useId();
  const confirm = useInlineConfirm(props.onCancel);
  return (
    <div
      ref={confirm.ref}
      className="meridian-workflows-delete-older"
      role="group"
      aria-label="Delete runs older than…"
      onKeyDown={confirm.onKeyDown}
    >
      <label htmlFor={ageId}>Older than</label>
      <select
        id={ageId}
        className="meridian-form__input"
        value={props.days}
        onChange={(event) => {
          const days = DELETE_OLDER_THAN_DAYS.find(
            (candidate) => String(candidate) === event.currentTarget.value,
          );
          if (days !== undefined) {
            props.onChoose(days);
          }
        }}
      >
        {DELETE_OLDER_THAN_DAYS.map((days) => (
          <option key={days} value={days}>
            {DELETE_OLDER_THAN_WORDS[days]}
          </option>
        ))}
      </select>
      {props.children}
    </div>
  );
}
