// The card behind a cast chip: who this participant is, and what they are doing.
//
// `Spec-023 §The surface set` puts four facts here — role, presence since, current
// run, paying account — and `participant-card-model.ts` settles which of them this
// console can answer and which it states as absences. This file renders; it decides
// nothing.
//
// IT REPLACES THE ID IN A `title`. The chip's name used to carry the participant id as
// its tooltip, which is a hover affordance that answers a question nobody asked: an
// identifier is not who somebody is. The id is still here — it is a wire figure in the
// card, in mono, selectable — and the hover now shows the four facts the design names.
//
// EVERY ABSENCE IS ITS OWN SENTENCE. A fact no wire reaches renders through
// `Nothing kind="not-checked"`, which says the console has not asked rather than that
// the answer is nothing. Collapsing the two is what `Spec-023 §Meridian, the design
// language` rule 8 forbids.

import { DerivedFigure, Nothing, WireFigure } from "../../primitives/index.js";
import { type SessionStore } from "../../store/index.js";
import { useParticipantCardReading } from "./participant-card-model.js";

export interface ParticipantCardProps {
  readonly sessionStore: SessionStore;
  readonly participantId: string;
  /** The name the wire gave this participant, or `undefined` where it named none. */
  readonly label: string | undefined;
}

export function ParticipantCard(props: ParticipantCardProps): React.JSX.Element {
  const reading = useParticipantCardReading(props.sessionStore, props.participantId);

  return (
    <div className="meridian-participant-card">
      <p className="meridian-participant-card__name">
        <WireFigure value={props.label ?? props.participantId} />
      </p>
      {props.label === undefined ? null : (
        // The id beside the name rather than instead of it. Two participants admitted
        // in the same millisecond share a prefix long enough that the chip's ellipsis
        // truncates both to the same string, so the id is what tells them apart.
        <p className="meridian-participant-card__id">
          <WireFigure value={props.participantId} />
        </p>
      )}
      <dl className="meridian-participant-card__facts">
        <dt>Role</dt>
        <dd>
          {reading.role === undefined ? (
            <Nothing
              kind="not-checked"
              placement="inline"
              title="No roster entry names a role."
              detail="The session's membership slice carries no parseable role for this participant."
            />
          ) : (
            <WireFigure value={reading.role} />
          )}
        </dd>
        <dt>Presence since</dt>
        <dd>
          <Nothing
            kind="not-checked"
            placement="inline"
            title="Presence has not been read."
            detail="No presence read reaches this console, so how long somebody has been here is not known."
          />
        </dd>
        <dt>Current run</dt>
        <dd>
          {reading.currentRun === undefined ? (
            <Nothing
              kind="not-checked"
              placement="inline"
              title="No run of theirs is going."
              detail="Nothing attributed to this participant is queued, starting, running, paused, or waiting."
            />
          ) : (
            <span className="meridian-participant-card__run">
              <WireFigure value={reading.currentRun.id} />
              <DerivedFigure text={reading.currentRun.state ?? "state not reported"} />
            </span>
          )}
        </dd>
        <dt>Paying account</dt>
        <dd>
          <Nothing
            kind="not-checked"
            placement="inline"
            title="No receipt has been read."
            detail="The bar reads the session's committed figure, which carries no per-account decomposition."
          />
        </dd>
      </dl>
    </div>
  );
}
