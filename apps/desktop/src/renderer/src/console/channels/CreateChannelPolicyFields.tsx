import { type CreateChannelDraft } from "./create-channel-draft.js";
import { CHANNEL_MODERATION_FIELDS, type ChannelModerationField } from "./create-channel-fields.js";

/**
 * The two members of a channel's policy, under one disclosure that opens by default.
 *
 * ONE DISCLOSURE, OPEN. The name is the decision everybody makes and the policy is the
 * one most people take the session's defaults for, so the two sit together behind a
 * summary a person can collapse — open, because a create-time decision hidden behind a
 * closed fold is a decision made by not looking.
 *
 * EVERY FIELD IS LABELLED FIXED AT CREATION, and that is the surface's real content:
 * V1 registers no channel-configuration mutation at all, so this is the only moment
 * any of it can be said. A person who does not know it is the only moment finds out
 * by getting it wrong.
 *
 * AN UNTOUCHED FIELD SENDS NOTHING, because an absent member on this wire MEANS the
 * session's default and a console that filled one in would be choosing on the
 * person's behalf and reporting it as their choice.
 */
export function CreateChannelPolicyFields(props: {
  readonly draft: CreateChannelDraft;
}): React.JSX.Element {
  const { draft } = props;
  return (
    <details className="meridian-create-channel__policy" open>
      <summary className="meridian-create-channel__policy-summary">
        How this channel runs — every one of these is fixed at creation
      </summary>

      <fieldset className="meridian-create-channel__field">
        <legend className="meridian-create-channel__field-label">Moderation</legend>
        {CHANNEL_MODERATION_FIELDS.map((field) => (
          <label key={field} className="meridian-create-channel__check">
            <input
              type="checkbox"
              checked={draft.moderationValue(field) ?? false}
              onChange={(event) => {
                draft.setModeration(field, event.target.checked);
              }}
            />
            <span>{MODERATION_LABEL[field]}</span>
          </label>
        ))}
        <span className="meridian-create-channel__field-note">
          Fixed at creation. Touch neither and the channel takes the session&rsquo;s own moderation.
        </span>
      </fieldset>

      <label className="meridian-create-channel__field">
        <span className="meridian-create-channel__field-label">Turns per agent</span>
        <input
          className="meridian-create-channel__text"
          inputMode="numeric"
          value={draft.turnsPerAgent}
          placeholder="No cap"
          onChange={(event) => {
            draft.setTurnsPerAgent(event.target.value);
          }}
        />
        <span className="meridian-create-channel__field-note">
          Fixed at creation. A cap belongs to the channel, never to a run inside it.
        </span>
      </label>
    </details>
  );
}

/** How each moderation member reads. Total over the closed two. */
const MODERATION_LABEL: Readonly<Record<ChannelModerationField, string>> = {
  preTurnGate: "Hold each agent turn for review before it is taken",
  postTurnReview: "Flag each agent turn for review after it is taken",
};
