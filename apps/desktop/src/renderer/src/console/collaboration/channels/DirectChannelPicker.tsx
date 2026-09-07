import { InlineRefusal, Nothing, WireFigure } from "../../primitives/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { type ChannelActivityLabels } from "../activity-model.js";
import { type CreateChannelDraft } from "./create-channel-draft.js";

/**
 * The other human a `direct` channel is with, and nothing else.
 *
 * ONE PICKER AND NO POLICY. A direct channel's membership is the immutable two-human
 * pair fixed at creation, and its audience is `humans-only` by the daemon's own rule —
 * so this arm offers no audience choice, no turn policy, no round-robin order, no
 * moderation setting and no per-agent cap. Those fields are ABSENT here rather than
 * disabled: a disabled field says the value could be set and is being withheld, and
 * on this arm there is no such value at all.
 *
 * THE PAIR IS THE VIEWER AND THE PICK, and the viewer is not pickable. A single
 * other-human picker is the whole control, because the caller is already one member of
 * every direct channel they can create. The two ids are canonicalized before they are
 * sent, so the pair does not depend on who was picked first.
 *
 * WHO IS OFFERED IS THE SESSION'S OWN ROSTER, minus this window. A person already in
 * a direct channel with the caller is still offered: whether a second one may exist is
 * the daemon's answer and it arrives as a refusal, not as a name quietly missing from
 * a list. `channel.not_found` against this control means the person chosen is no
 * longer a member, which is why the refusal renders here rather than under the submit.
 */
export function DirectChannelPicker(props: {
  readonly draft: CreateChannelDraft;
  readonly participantIds: readonly string[];
  readonly viewerParticipantId: string | undefined;
  readonly labels: ChannelActivityLabels;
  readonly refusal: ConsoleRefusal | undefined;
}): React.JSX.Element {
  const { draft, labels } = props;
  const candidates = props.participantIds.filter(
    (participantId) => participantId !== props.viewerParticipantId,
  );
  return (
    <div className="meridian-create-channel__direct">
      <p className="meridian-create-channel__field-note">
        A direct channel is <code>humans-only</code> — no agent in this session ever reads it — and
        the two people in it cannot change afterwards.
      </p>

      {props.viewerParticipantId === undefined ? (
        <Nothing
          kind="not-checked"
          placement="inline"
          title="Which participant this window is has not been read."
          detail="A direct channel is between this window's own participant and the one picked here, so the pair cannot be composed until that read answers."
        />
      ) : null}

      {candidates.length === 0 ? (
        <Nothing
          kind="empty"
          placement="inline"
          title="Nobody else is in this session yet."
          detail="A direct channel needs two people. Invite somebody, and they appear here."
        />
      ) : (
        <ul className="meridian-create-channel__candidates" aria-label="Who this channel is with">
          {candidates.map((participantId) => (
            <li key={participantId}>
              <button
                type="button"
                className="meridian-create-channel__candidate"
                aria-pressed={draft.otherParticipantId === participantId}
                onClick={() => {
                  draft.setOtherParticipantId(participantId);
                }}
              >
                <span>{labels.participantLabel(participantId)}</span>
                <WireFigure value={participantId} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {props.refusal === undefined ? null : (
        <InlineRefusal code={props.refusal.code} detail={props.refusal.detail} />
      )}
    </div>
  );
}
