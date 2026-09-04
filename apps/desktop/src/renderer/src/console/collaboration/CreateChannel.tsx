// What creating a channel would fix, and why the console cannot offer it yet.
//
// THE JOB THIS SURFACE ACTUALLY HAS. Every part of a channel's policy is fixed at
// creation and none of it can be edited afterwards — there is no configuration-
// update verb in V1 and no field on a channel is mutable once it exists. That makes
// the create moment the ONLY moment, and a person who does not know it is the only
// moment will discover it by getting it wrong. So the standing statement is the
// surface's real content, and it is worth rendering whether or not a form sits
// under it.
//
// WHY THERE IS NO FORM UNDER IT TODAY. `channel.create` is registered on no
// transport: it is not a daemon method, not a control-plane procedure, and not a
// growth-port operation with a slate row behind it, so a submit control here would
// have nowhere to send what a person typed. Fields collecting a value that can go
// nowhere are worse than no fields — they read as a feature that is broken rather
// than as one that has not landed — and drawing them disabled makes the same claim
// with a tooltip. So the absence is rendered as an absence, in the one shape that
// says which absence it is: nobody asked, because the console has nothing to ask
// with.
//
// THE ABSENCE IS `not-checked`, NOT `empty` AND NOT `error`. Nothing failed and
// nothing came back empty. The console never put the question, because no verb
// exists to put it with, and conflating that with either of the others is exactly
// what the five kinds of nothing are for.
//
// WHEN THE VERB LANDS, this file grows the form the policy statement already
// describes: a name refused against the reserved bootstrap name, a kind choice, the
// per-agent turn policy for a general channel, and a single other-participant
// picker for a direct one whose pair is canonicalized before it is sent.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";

import { Nothing } from "../primitives/index.js";

/** What a channel's creation fixes, in the order a person meets it. */
interface CreateTimeDecision {
  readonly label: string;
  readonly consequence: string;
}

/**
 * The decisions creation settles, each with what it settles.
 *
 * Prose rather than form fields on purpose: this is a statement about the shape of
 * the act, and rendering it as labelled inputs would be the console claiming it can
 * collect them. Each line names a decision and what living with it means, because
 * "fixed at creation" is only useful to someone who knows what was fixed.
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

export function CreateChannel(): React.JSX.Element {
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
      <Nothing
        kind="not-checked"
        placement="surface"
        title="This console cannot create a channel yet."
        detail="No transport registers a channel-creation call, so nothing was asked of the daemon. The form lands here with the call, and the settings above are what it will ask for."
      />
    </section>
  );
}
