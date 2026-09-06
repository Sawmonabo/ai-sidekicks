// The supervisor's own state, in one chip, inside the window.
//
// The tray carries the same truth outside the window and is main-process work on a
// later phase (`T-023r-3-x`); this is the in-window half, so a person who never
// looks at the tray is not the last to know. Both render the SAME supervisor state
// machine — startup probe, spawn and readiness wait, version-incompatible, live
// heartbeat, crash with backoff, shutdown — and this component invents no state that
// machine does not have.
//
// THE TWO-HUE RULE DECIDES THE TONE, and it is stricter than it first looks.
// Reconnecting is not amber: the supervisor drives the backoff ladder and no person
// is needed while it does, so amber there would spend the "you are needed" hue on a
// wait nobody can shorten. Red is spent on the two states that ARE failures — the
// refused handshake and the runtime that did not come back — and on nothing else.
// Connected is neutral, which is the point: a healthy window carries no colour.

import { Chip, Nothing, type ChipTone } from "../../primitives/index.js";
import {
  UNREPORTED_SHELL_NOTICE,
  describeShellConnection,
  type ShellConnection,
} from "../../store/index.js";

export interface DaemonChipProps {
  readonly connection: ShellConnection;
}

/** One chip carrying the supervisor's state, or the absence where none was reported. */
export function DaemonChip(props: DaemonChipProps): React.JSX.Element {
  if (props.connection.kind === "unreported") {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title={UNREPORTED_SHELL_NOTICE.title}
        detail={UNREPORTED_SHELL_NOTICE.detail}
      />
    );
  }
  return (
    <Chip tone={chipToneFor(props.connection)} label={describeShellConnection(props.connection)} />
  );
}

/** Which of the four tones one supervisor state earns. Total over the union. */
function chipToneFor(connection: ShellConnection): ChipTone {
  switch (connection.kind) {
    case "unreported":
    case "probing":
    case "starting":
    case "connected":
    case "reconnecting":
    case "stopped":
      return "neutral";
    case "version-incompatible":
    case "offline":
      return "failure";
  }
}
