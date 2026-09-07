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
//
// THE REPORTED CHIP IS A CONTROL, BECAUSE THE DESIGN ALREADY PROMISED ONE. `Spec-023`
// §Tray and daemon lifecycle puts the supervisor's detail "one click away" and this
// chip is the click: rendered as inert content it made a claim — attempt counts, the
// last heartbeat, the stop and restart controls — that a person could only reach by
// guessing their way through Settings. So the reported arms wrap the chip in a real
// button whose accessible name says where it goes, and the visible label stays the
// state so the name CONTAINS what a person reads rather than replacing it.
//
// WHERE IT GOES IS NOT THIS COMPONENT'S DECISION. The chip is handed the navigation,
// so it holds no route, no store, and no opinion about which surface answers for the
// supervisor — and the settings section it lands on is declared once in
// `store/shell-state.ts`, where the settings rail reads the same id.
//
// THE UNREPORTED ARM STAYS INERT. It is an absence rather than a state, `Nothing`
// carries its own title and detail, and a button around "nobody has said" would offer
// a detail page for a supervisor this build has no channel to ask about.

import { Chip, Nothing, type ChipTone } from "../../primitives/index.js";
import {
  SHELL_DETAIL_DESTINATION,
  UNREPORTED_SHELL_NOTICE,
  describeShellConnection,
  type ShellConnection,
} from "../../store/index.js";

export interface DaemonChipProps {
  readonly connection: ShellConnection;
  /** Open the supervisor's own page. Supplied, never decided here. */
  readonly onOpenDetail: () => void;
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
    <button type="button" className="meridian-shell-state__detail" onClick={props.onOpenDetail}>
      <Chip
        tone={chipToneFor(props.connection)}
        label={describeShellConnection(props.connection)}
      />
      <span className="meridian-visually-hidden">{` — ${SHELL_DETAIL_DESTINATION.openLabel}`}</span>
    </button>
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
