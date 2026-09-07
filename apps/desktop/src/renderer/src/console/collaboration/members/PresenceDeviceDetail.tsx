// The devices behind one person's presence, and the four things that can be true
// instead.
//
// THE UNAUTHORIZED ARM IS NOT AN ERROR, and it is the reason this component exists
// rather than a `RefusalCard` in the row. `Spec-018` makes the aggregated summary the
// unauthorized-DEFAULT projection: a caller who may not see the fan-out has already
// been told everything they are entitled to, on the row that opened this. So
// `presence.permission_denied` renders as one sentence naming the summary they
// already have — no error tone, no retry, nothing withdrawn.
//
// EVERY OTHER REFUSAL IS AN ORDINARY ONE and renders as one, in place, with its code
// and its message verbatim. The distinction is drawn from the wire code by the model
// beside this file and never re-derived here.
//
// AND AN EMPTY DEVICE LIST IS AN ANSWER. A person can be a member of the session and
// on no device at all; that is what the offline row looks like from the inside, and
// rendering it as "nothing was read" would conflate a fact with a failure.

import { InlineRefusal, Nothing, WireFigure } from "../../primitives/index.js";
import {
  isPresenceDetailUnauthorized,
  presenceDetailRefusal,
  presenceDetailValue,
  type PresenceDetailReading,
} from "./presence-detail.js";

export interface PresenceDeviceDetailProps {
  readonly reading: PresenceDetailReading | undefined;
  /**
   * The aggregate the row is already showing.
   *
   * Carried so a disagreement between the two reads can be SAID rather than resolved:
   * the row's is the one that stands, and two reads of one fact that disagree is
   * itself worth putting on screen.
   */
  readonly aggregateOnTheRow: string;
}

export function PresenceDeviceDetail(props: PresenceDeviceDetailProps): React.JSX.Element {
  const { reading, aggregateOnTheRow } = props;
  const refusal = presenceDetailRefusal(reading);

  if (isPresenceDetailUnauthorized(refusal)) {
    return (
      <p className="meridian-roster-detail__summary-only">
        Per-device presence is an owner and operator reading. The state on this row is the
        aggregated summary, which is the whole of what this session shows you.
      </p>
    );
  }

  if (refusal !== undefined) {
    return <InlineRefusal code={refusal.code} detail={refusal.detail} />;
  }

  const detail = presenceDetailValue(reading);
  if (detail === undefined) {
    return <Nothing kind="not-loaded" title="Reading this person's devices." />;
  }

  return (
    <>
      {detail.aggregateState === aggregateOnTheRow ? null : (
        <p className="meridian-roster-detail__disagreement" role="status">
          The device read folds to <WireFigure value={detail.aggregateState} /> and the roster row
          says <WireFigure value={aggregateOnTheRow} />. The row is the one that stands.
        </p>
      )}
      {detail.devices.length === 0 ? (
        <Nothing
          kind="empty"
          placement="inline"
          title="On no device"
          detail="This person holds a membership in the session and has no device present in it."
        />
      ) : (
        <ul className="meridian-roster-detail__devices">
          {detail.devices.map((device) => (
            <li key={device.deviceId} className="meridian-roster-detail__device">
              <WireFigure value={device.deviceId} />
              <WireFigure value={device.state} />
              <WireFigure value={device.lastSeen} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
