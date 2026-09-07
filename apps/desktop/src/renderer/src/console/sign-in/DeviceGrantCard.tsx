// The Device Authorization Grant, finished to the same degree as the passkey path.
//
// `Spec-023 §Fallback Behavior` fixes the shape: a browser hand-off with a loopback
// capture at `localhost:<port>/callback`, and never an in-app credential form. So
// this card renders the address and the code and offers exactly one control — the
// hand-off — and it collects nothing. There is no field here, and there is no field
// anywhere in this family, which is the point rather than an omission: a form that
// took a code would be this window handling a credential the main process confines.
//
// THE WAIT IS NOT A POLL. Pressing the control opens the system browser and then
// awaits main's loopback listener once. Nothing on this card ticks, nothing re-reads,
// and the console's no-interval-polling rule is met by there being no interval.
//
// Both figures render through `WireFigure`, which is the console's one wire-figure
// chokepoint: they are strings a machine produced and a person retypes, so they are
// rendered verbatim in mono and never reformatted, split, or spaced for looks.

import { WireFigure } from "../primitives/index.js";
import { DEVICE_GRANT_NOTE } from "./sign-in-copy.js";
import type { DeviceGrantHandoff } from "../bridge/index.js";

export interface DeviceGrantCardProps {
  readonly handoff: DeviceGrantHandoff;
  /** The browser is open and this window is waiting on the loopback callback. */
  readonly isWaiting: boolean;
  readonly onOpenBrowser: () => void;
}

export function DeviceGrantCard(props: DeviceGrantCardProps): React.JSX.Element {
  return (
    <div className="meridian-device-grant" aria-label="Continue in a browser">
      <p className="meridian-sign-in__note">{DEVICE_GRANT_NOTE}</p>
      <dl className="meridian-device-grant__figures">
        <dt className="meridian-device-grant__label">Address</dt>
        <dd className="meridian-device-grant__value">
          <WireFigure value={props.handoff.verificationUri} />
        </dd>
        <dt className="meridian-device-grant__label">Code</dt>
        <dd className="meridian-device-grant__value">
          <WireFigure value={props.handoff.userCode} />
        </dd>
      </dl>
      {props.isWaiting ? (
        <p className="meridian-device-grant__waiting" role="status">
          Waiting for the browser to finish.
        </p>
      ) : (
        <button type="button" className="meridian-sign-in__act" onClick={props.onOpenBrowser}>
          Open the browser
        </button>
      )}
    </div>
  );
}
