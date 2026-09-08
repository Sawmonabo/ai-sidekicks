import { InlineRefusal } from "../../primitives/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { type ChannelLifecycleAction } from "./channel-writes.js";
import { ChannelArchiveConfirmation } from "./ChannelArchiveConfirmation.js";

/**
 * What one row's lifecycle controls are wired to.
 *
 * Handed down as one object rather than as six loose props, so a row cannot be given
 * a pending flag from one round and a dismiss from another.
 */
export interface ChannelRowLifecycle {
  /** This row's own move, where it is the one in flight. */
  readonly pendingAction: ChannelLifecycleAction | undefined;
  /** Some row's move is in flight — this one's, or a neighbour's. */
  readonly isAnyPending: boolean;
  readonly refusal: ConsoleRefusal | undefined;
  readonly onAct: (action: ChannelLifecycleAction) => void;
  readonly onDismissRefusal: () => void;
}

/**
 * Mute, unmute, and archive, offered on the row they are about.
 *
 * ELIGIBILITY IS NEVER DERIVED HERE. Whether this caller may mute, unmute or archive
 * anything is the daemon's answer, and it arrives as a refusal rendered beside the
 * control that asked for it. Nothing in this component computes a permission, reads a
 * role, or hides a control to avoid provoking an answer — hiding one would replace a
 * refusal a person can act on with a control they cannot find.
 *
 * WHAT IT DOES PROJECT IS THE ROW'S OWN WIRE STATE, which is a different thing: a
 * muted row offers Unmute and an active one offers Mute, because those two are
 * opposites and offering both would be offering one act that is already done. The
 * archived row is rendered by the caller without this component at all — there is
 * nothing to unmute on a terminal row, and offering it would suggest the channel
 * could come back.
 *
 * A DIRECT ROW IS OFFERED THESE EXACTLY AS ANY OTHER ROW IS, and the pair gating is
 * met one layer up rather than here: a `direct` channel the caller is outside of is
 * omitted from the reply, so there is no row for a control to sit on. A caller-side
 * check would be the console re-deriving a filter the daemon already applied, over
 * data the daemon deliberately did not send.
 *
 * EVERY CONTROL ON THE LIST CLOSES WHILE ONE MOVE IS UNSETTLED, not only this row's:
 * the coordinator behind them applies one at a time, and a control that leads only to
 * that refusal is worse than a control that waits.
 */
export function ChannelRowControls(props: {
  readonly channelLabel: string;
  readonly isMuted: boolean;
  readonly lifecycle: ChannelRowLifecycle;
}): React.JSX.Element {
  const { lifecycle } = props;
  const toggleAction: ChannelLifecycleAction = props.isMuted ? "unmute" : "mute";
  return (
    <div className="meridian-channel-row__acts">
      <button
        type="button"
        className="meridian-channel-row__act"
        disabled={lifecycle.isAnyPending}
        aria-label={`${props.isMuted ? "Unmute" : "Mute"} ${props.channelLabel}`}
        onClick={() => {
          lifecycle.onAct(toggleAction);
        }}
      >
        {lifecycle.pendingAction === toggleAction
          ? props.isMuted
            ? "Unmuting…"
            : "Muting…"
          : props.isMuted
            ? "Unmute"
            : "Mute"}
      </button>
      <ChannelArchiveConfirmation
        channelLabel={props.channelLabel}
        isAnyPending={lifecycle.isAnyPending}
        isArchiving={lifecycle.pendingAction === "archive"}
        onConfirm={() => {
          lifecycle.onAct("archive");
        }}
      />
      {lifecycle.refusal === undefined ? null : (
        <InlineRefusal
          code={lifecycle.refusal.code}
          detail={lifecycle.refusal.detail}
          action={
            <button
              type="button"
              className="meridian-channel-row__refusal-dismiss"
              onClick={lifecycle.onDismissRefusal}
            >
              Dismiss
            </button>
          }
        />
      )}
    </div>
  );
}
