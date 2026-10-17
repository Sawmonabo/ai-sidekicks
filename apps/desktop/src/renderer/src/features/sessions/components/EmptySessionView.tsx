// The view a window shows while it holds no session: the app's logo mark alone in the middle, and
// under it, after a move here off a session the background service does not hold, the one line
// saying so until the next act.

import "./EmptySessionView.css";

import { LogoMark } from "#renderer/components/LogoMark/LogoMark.js";
import { MissingTargetLine } from "#renderer/components/MissingTargetLine/MissingTargetLine.js";
import { useGoneSessionRaise } from "#renderer/store/window/hooks/useGoneSessionRaise.js";
import { type WindowStore } from "#renderer/store/window/store.js";

/** Props for `EmptySessionView`. */
export interface EmptySessionViewProps {
  readonly frameStore: WindowStore;
}

/** A view holding no session: the logo mark, and under it a gone session's line when raised. */
export function EmptySessionView(props: EmptySessionViewProps): React.JSX.Element {
  const raise = useGoneSessionRaise(props.frameStore);
  return (
    <div className="meridian-session-empty-view">
      <LogoMark />
      {raise === undefined ? null : (
        <MissingTargetLine target={raise.target} raisedKey={raise.raisedKey} />
      )}
    </div>
  );
}
