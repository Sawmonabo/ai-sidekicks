import {
  GROWTH_CHANNEL_AUDIENCES,
  GROWTH_CHANNEL_TURN_POLICIES,
  type GrowthChannelAudience,
  type GrowthChannelTurnPolicy,
} from "../../bridge/index.js";
import {
  CHANNEL_MODERATION_FIELDS,
  type ChannelModerationField,
  type CreateChannelDraft,
} from "./create-channel-draft.js";

/**
 * The five members of a channel's policy, under one disclosure that opens by default.
 *
 * ONE DISCLOSURE, OPEN. Name and kind are the two decisions everybody makes and the
 * policy is the one most people take the session's defaults for, so the five sit
 * together behind a summary a person can collapse — open, because a create-time
 * decision hidden behind a closed fold is a decision made by not looking.
 *
 * IT DOES NOT EXIST FOR A `direct` CHANNEL. The caller renders this component only on
 * the general arm: a direct channel carries no audience, no turn policy, no
 * round-robin order, no moderation setting and no per-agent cap, so the fields are
 * ABSENT rather than disabled — a disabled field claims the value could be set here
 * and is being withheld, which is a different and untrue statement.
 *
 * EVERY FIELD IS LABELLED FIXED AT CREATION, and that is the surface's real content:
 * V1 registers no channel-configuration mutation at all, so this is the only moment
 * any of it can be said. A person who does not know it is the only moment finds out
 * by getting it wrong.
 *
 * AN UNTOUCHED FIELD SENDS NOTHING. Each select carries an explicit "session default"
 * entry rather than a pre-picked value, because an absent member on this wire MEANS
 * the session's default and a console that filled one in would be choosing on the
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

      <label className="meridian-create-channel__field">
        <span className="meridian-create-channel__field-label">Who it is for</span>
        <select
          className="meridian-create-channel__select"
          value={draft.audience ?? ""}
          onChange={(event) => {
            draft.setAudience(readAudience(event.target.value));
          }}
        >
          <option value="">Session default</option>
          {GROWTH_CHANNEL_AUDIENCES.map((audience) => (
            <option key={audience} value={audience}>
              {audience}
            </option>
          ))}
        </select>
        <span className="meridian-create-channel__field-note">
          Fixed at creation. <code>participants</code> means this session&rsquo;s agents read it;{" "}
          <code>humans-only</code> means no agent ever does.
        </span>
      </label>

      <label className="meridian-create-channel__field">
        <span className="meridian-create-channel__field-label">How agents take turns</span>
        <select
          className="meridian-create-channel__select"
          value={draft.turnPolicy ?? ""}
          onChange={(event) => {
            draft.setTurnPolicy(readTurnPolicy(event.target.value));
          }}
        >
          <option value="">Session default</option>
          {GROWTH_CHANNEL_TURN_POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {policy}
            </option>
          ))}
        </select>
        <span className="meridian-create-channel__field-note">Fixed at creation.</span>
      </label>

      <label className="meridian-create-channel__field">
        <span className="meridian-create-channel__field-label">Round-robin order</span>
        <input
          className="meridian-create-channel__text"
          value={draft.roundRobinOrder}
          placeholder="Identifiers, separated by commas"
          onChange={(event) => {
            draft.setRoundRobinOrder(event.target.value);
          }}
        />
        <span className="meridian-create-channel__field-note">
          Fixed at creation. Left empty, the channel takes the session&rsquo;s own order.
        </span>
      </label>

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

/**
 * The picked option, read back against the vocabulary it was drawn from.
 *
 * A `<select>` has no null value, so "session default" is spelled as the empty string
 * — and rather than reading that sentinel and asserting the rest, each reader searches
 * the same tuple the options were rendered from. Nothing is cast: a value that is not
 * a member of the vocabulary is `undefined`, which is the session's default, which is
 * exactly what the empty entry means.
 */
function readAudience(value: string): GrowthChannelAudience | undefined {
  return GROWTH_CHANNEL_AUDIENCES.find((audience) => audience === value);
}

function readTurnPolicy(value: string): GrowthChannelTurnPolicy | undefined {
  return GROWTH_CHANNEL_TURN_POLICIES.find((policy) => policy === value);
}
