// Creating one channel, with its whole policy fixed at the moment it is created.
//
// THE JOB THIS SURFACE ACTUALLY HAS. Every part of a channel's policy is settled at
// creation and none of it can be edited afterwards — there is no configuration-update
// verb in V1 and no field on a channel is mutable once it exists. That makes the
// create moment the ONLY moment, and a person who does not know it is the only moment
// will discover it by getting it wrong. So the standing statement is as much of this
// surface's content as the fields are, and it sits above the control that commits.
//
// NO CONFIGURATION-UPDATE CONTROL EXISTS ANYWHERE, and that is not an omission this
// form is working around: `channel.configUpdate` is registered on no transport, and a
// control offered against it would claim a capability the plane does not have.
//
// TWO ARMS, NOT A WIZARD. The kind decides which fields exist. A `general` channel
// carries the five `ChannelConfig` members under one disclosure; a `direct` channel
// carries a single other-human picker and none of the five, because the wire's own
// validation couples them — a direct channel requires exactly two distinct humans and
// refuses every agent-turn member, and a general one refuses the pair. The fields are
// ABSENT on the direct arm rather than disabled: a disabled field says a value could
// be set here and is being withheld, which on that arm is untrue.
//
// ONE WIRE MUTATION PER EXPLICIT ACTION. Cancel sends nothing — it is renderer-local
// and there is nothing to withdraw — and Create sends exactly one `channel.create`,
// with the control settling into a working state while it is in flight. A second press
// reaches the coordinator's single-flight rule rather than the wire.
//
// WHERE EACH REFUSAL LANDS. `channel.name_reserved` marks the NAME field and names the
// reserved word, because that is the field a person has to change; `channel.not_found`
// on the direct arm means the person chosen is no longer a member, so it renders
// against the PICKER. Everything else renders under the submit control, verbatim —
// the daemon's own code and the daemon's own sentence, never a paraphrase.
// `channel.inactive` is deliberately not handled here: nothing this form does can
// reach an archived channel, and a branch for it would be a rendering for a refusal
// this surface cannot provoke.

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";

import {
  GROWTH_CHANNEL_KINDS,
  type ConsoleBridge,
  type GrowthChannelCreateReceipt,
} from "../../bridge/index.js";
import { InlineRefusal, WireFigure, formatDateTime } from "../../primitives/index.js";
import { useSubjectScopedState } from "../../store/index.js";
import { type ChannelActivityLabels } from "../activity-model.js";
import { WireMutationCoordinator, useWireMutation } from "../mutation-coordinator.js";
import {
  CHANNEL_NAME_RESERVED_CODE,
  CHANNEL_NOT_FOUND_CODE,
  channelCreateMutation,
} from "./channel-writes.js";
import { CreateChannelDraft } from "./create-channel-draft.js";
import { CreateChannelPolicyFields } from "./CreateChannelPolicyFields.js";
import { DirectChannelPicker } from "./DirectChannelPicker.js";

/**
 * The one subject this form's coordinator keys on.
 *
 * A form has one row, so the keyed-refusal machinery has one key. It reads as a noun
 * because the coordinator puts it in the sentence a second press earns.
 */
const CREATE_SUBJECT_KEY = "this new channel";

/** What a channel's creation fixes, in the order a person meets it. */
interface CreateTimeDecision {
  readonly label: string;
  readonly consequence: string;
}

/**
 * The decisions creation settles, each with what it settles.
 *
 * Prose above the fields rather than instead of them: the form collects the values and
 * this says what living with them means, because "fixed at creation" is only useful to
 * someone who knows what was fixed.
 */
const CREATE_TIME_DECISIONS: readonly CreateTimeDecision[] = [
  {
    label: "Name",
    consequence: `Chosen once. \`${MAIN_CHANNEL_NAME}\` is the session's own channel and is not a name a new channel may take.`,
  },
  {
    label: "Who it is for",
    consequence:
      "A channel either includes this session's agents or it is for people only. A channel's audience is settled by the daemon at creation and never inferred from who happens to be in it.",
  },
  {
    label: "How agents take turns",
    consequence:
      "Turn policy, ordering, moderation, and the per-agent turn cap belong to the channel, not to a run inside it. A channel whose rhythm turns out wrong is replaced, not reconfigured.",
  },
];

export interface CreateChannelProps {
  readonly bridge: ConsoleBridge;
  /** The session the channel is created in. `undefined` means nothing can be sent. */
  readonly sessionId: string | undefined;
  /** Which participant this window is, where that has been read. One half of a pair. */
  readonly viewerParticipantId: string | undefined;
  readonly participantIds: readonly string[];
  readonly labels: ChannelActivityLabels;
}

export function CreateChannel(props: CreateChannelProps): React.JSX.Element {
  const { bridge, sessionId } = props;
  // The draft is a store, so it is built by a hook's initializer and never in a render
  // body: a body would build a fresh one on every pass React discarded and every edit
  // in it would be lost. It notifies through its own emitter rather than React state,
  // so this render is re-run by a counter nothing reads — the value is not the point,
  // the notification is.
  const [draft] = useState(() => new CreateChannelDraft());
  const [, noteDraftEdited] = useReducer((edits: number) => edits + 1, 0);
  useEffect(() => draft.onChange(noteDraftEdited), [draft, noteDraftEdited]);

  const createCoordinator = useMemo(
    () =>
      new WireMutationCoordinator({
        perform: channelCreateMutation(bridge),
        describeWhat: "The channel",
      }),
    // Keyed on the subject, exactly as the list's own coordinator is: an unsettled
    // create in the session being left must not close the control in the one arrived
    // at, and its refusal must not render there either.
    [bridge, sessionId],
  );
  const create = useWireMutation(createCoordinator);
  const { value: receipt, publish: publishReceipt } = useSubjectScopedState<
    GrowthChannelCreateReceipt | undefined
  >(bridge, sessionId, () => undefined);

  useEffect(() => {
    return () => {
      createCoordinator.supersede();
    };
  }, [createCoordinator]);

  const readiness = draft.readiness(sessionId, props.viewerParticipantId);
  const isCreating = create.pendingKey !== undefined;
  const refusal = create.refusalByKey[CREATE_SUBJECT_KEY];
  const nameRefusal = refusal?.code === CHANNEL_NAME_RESERVED_CODE ? refusal : undefined;
  const pickerRefusal = refusal?.code === CHANNEL_NOT_FOUND_CODE ? refusal : undefined;
  const otherRefusal =
    nameRefusal === undefined && pickerRefusal === undefined ? refusal : undefined;

  const submit = useCallback(() => {
    const ready = draft.readiness(sessionId, props.viewerParticipantId);
    if (ready.status !== "ready") {
      return;
    }
    void createCoordinator.run(CREATE_SUBJECT_KEY, ready.request).then((settlement) => {
      // `undefined` is the refused arm — and the superseded one. Either way the reason
      // is on the coordinator's snapshot beside the control that asked, or there is no
      // control left to put one beside, and the draft keeps everything a person typed.
      if (settlement === undefined) {
        return;
      }
      publishReceipt(settlement);
      draft.reset();
    });
  }, [createCoordinator, draft, publishReceipt, sessionId, props.viewerParticipantId]);

  return (
    <section className="meridian-create-channel" aria-label="Creating a channel">
      <h3 className="meridian-create-channel__title">Creating a channel</h3>
      <p className="meridian-create-channel__standing">
        A channel&rsquo;s settings cannot be edited after it is created. There is no
        configuration-update control anywhere in the console because there is nothing behind one.
      </p>
      <dl className="meridian-create-channel__decisions">
        {CREATE_TIME_DECISIONS.map((decision) => (
          <div key={decision.label} className="meridian-create-channel__decision">
            <dt className="meridian-create-channel__decision-label">{decision.label}</dt>
            <dd className="meridian-create-channel__decision-consequence">
              {decision.consequence}
            </dd>
          </div>
        ))}
      </dl>

      <label className="meridian-create-channel__field">
        <span className="meridian-create-channel__field-label">Name</span>
        <input
          className="meridian-create-channel__text meridian-create-channel__name"
          value={draft.name}
          placeholder="What this channel is called"
          onChange={(event) => {
            draft.setName(event.target.value);
          }}
        />
        {readiness.status === "incomplete" && readiness.nameRefusal !== undefined ? (
          <span className="meridian-create-channel__field-refusal" role="status">
            {readiness.nameRefusal}
          </span>
        ) : null}
        {nameRefusal === undefined ? null : (
          <InlineRefusal code={nameRefusal.code} detail={nameRefusal.detail} />
        )}
      </label>

      <div
        className="meridian-create-channel__kinds"
        role="group"
        aria-label="What kind of channel"
      >
        {GROWTH_CHANNEL_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="meridian-create-channel__kind"
            aria-pressed={draft.kind === kind}
            onClick={() => {
              draft.setKind(kind);
            }}
          >
            {KIND_LABEL[kind]}
          </button>
        ))}
      </div>

      {draft.kind === "direct" ? (
        <DirectChannelPicker
          draft={draft}
          participantIds={props.participantIds}
          viewerParticipantId={props.viewerParticipantId}
          labels={props.labels}
          refusal={pickerRefusal}
        />
      ) : (
        <CreateChannelPolicyFields draft={draft} />
      )}

      {readiness.status === "incomplete" && readiness.missing.length > 0 ? (
        <p className="meridian-create-channel__incomplete">
          Still needed: {readiness.missing.join(", ")}.
        </p>
      ) : null}

      <div className="meridian-create-channel__actions">
        <button
          type="button"
          className="meridian-create-channel__submit"
          disabled={readiness.status !== "ready" || isCreating}
          aria-busy={isCreating}
          onClick={submit}
        >
          {isCreating ? "Creating…" : "Create"}
        </button>
        <button
          type="button"
          className="meridian-create-channel__cancel"
          disabled={isCreating}
          onClick={() => {
            draft.reset();
          }}
        >
          Cancel
        </button>
      </div>

      {otherRefusal === undefined ? null : (
        <InlineRefusal code={otherRefusal.code} detail={otherRefusal.detail} />
      )}

      {receipt === undefined ? null : (
        <p className="meridian-create-channel__receipt" role="status">
          Created <WireFigure value={receipt.channelId} />, now <WireFigure value={receipt.state} />{" "}
          as of <WireFigure value={formatDateTime(receipt.createdAt)} title={receipt.createdAt} />.
        </p>
      )}
    </section>
  );
}

/** How each kind reads on its control. Total over the closed two. */
const KIND_LABEL: Readonly<Record<string, string>> = {
  general: "A named channel",
  direct: "Between two people",
};
