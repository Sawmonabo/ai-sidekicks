// The `+` menu's "Start a workflow" entry: the composer's half of somebody else's body.
//
// WHAT THIS FILE OWNS AND WHAT IT DOES NOT. The seat, the reserved state, and the three
// inputs the picker is handed are the composer's; the picker itself, the definition
// enumeration it lists, and the start it dispatches are the workflows family's, and they
// arrive through that family's door as a LOADER. Nothing here authors a body.
//
// WHY THE SEAT AND NOT THE RAIL HOLDS THE BOUNDARY. The rail composes the whole accessory
// zone and would otherwise carry the one line that decides which chunk this body lands
// in, a decision no reader of that file is looking for. Here it is the file's subject.
//
// WHY A LOADER AT ALL. `apps/desktop/AGENTS.md` decides the registration form by asking
// whether a body is painted before a person acts, and this menu is closed until somebody
// presses the disclosure beside it — `PlusMenu` renders its panel only while open, so the
// picker is not merely hidden, it is absent from the tree. Imported statically it was in
// the entry chunk of every session all the same, which is a launch every session pays for
// and a menu many of them never open.
//
// AND THE `LoadedLazyBody` IS THE PROCESS'S, NOT THE MOUNT'S. What it memoises is a module
// promise and the settled body built over it, and both are facts about this renderer's
// module registry rather than about any one composer: two session views open in one window
// share one fetch, and closing the menu and reopening it re-renders a body that has already
// arrived. Held per mount instead, every remount of the composer would render the reserved
// state again for a module the registry already holds — a `lazy()` learns its value in a
// microtask however warm the promise underneath it is, which costs a committed frame. It is
// a `const` holding an instance rather than a mutable binding, which is the shape the
// package standard admits and every board in `seats/` already takes.
//
// NO IDLE WARM, AND THAT IS THE ARITHMETIC RATHER THAN AN OMISSION. `LazyBodyIdleWarm`
// walks a BOARD — the deck's panes, the frame's surfaces, a settings window's pages — and
// what those hold are destinations a person navigates to, one walk per window that has
// them. This is one seat inside a composer every session paints, so a walk armed for it
// would fetch this chunk in every window on every launch: the same charge the loader was
// introduced to remove, moved one frame later, for a menu many people never open. The load
// begins when the disclosure opens, which is the moment the body is asked for — and what
// stands in its place until it lands is the same sentence the picker itself shows while its
// definition read is in flight, so the two states read as one.

import { LoadedLazyBody } from "../../../../console/seats/index.js";
import { Nothing } from "../../../../console/primitives/index.js";
import type { GrowthPort } from "../../../../console/bridge/index.js";
// Through the workflows family's own door, which is how a renderer subtree outside the
// console reaches a console family at all. What comes through it is the loader and never
// the component: the door is on the eager graph, so a component would defer nothing.
import { workflowStartMenuBody } from "../../../../console/workflows/index.js";

export interface WorkflowStartSeatProps {
  /** The port both of the picker's wires ride, handed down untouched. */
  readonly growth: GrowthPort;
  /** The session a run would start in — the composer's own, never resolved here. */
  readonly sessionId: string;
  /** The originating channel, where this composer is addressed at one. */
  readonly channelId: string | undefined;
}

/**
 * What stands in the picker's place while its chunk is in flight.
 *
 * Supplied HERE rather than by the family that owns the body, on the rule
 * `seats/LazyBody.tsx` states: what a body reserves while it loads is a question about the
 * frame it loads inside, and that frame is the `+` panel this file mounts into.
 *
 * IT SAYS WHAT THE PICKER ITSELF SAYS while its definition read is in flight, so the two
 * states read as one rather than as a surface that flickered through a second sentence on
 * its way to the first.
 *
 * A camelCase REGION rather than a component, on `primitives/Nothing.tsx`' precedent: it
 * is one of this module's regions and not a body with a life of its own, and this module
 * is named for the one component it declares.
 */
function reservedPickerRegion(): React.JSX.Element {
  return <Nothing kind="not-loaded" title="Reading the workflows this session can start." />;
}

/** The one loader-backed body this seat mounts, memoised for this renderer process. */
const WORKFLOW_START_BODY = new LoadedLazyBody(workflowStartMenuBody, reservedPickerRegion);

/** Mount the workflows family's picker in the seat the `+` menu reserves for it. */
export function WorkflowStartSeat(props: WorkflowStartSeatProps): React.ReactNode {
  // Spread rather than forwarded field by field: the registration's context IS the body's
  // props, so a hand-written projection here would be a second declaration of one shape
  // that drifts the day the picker grows an input.
  return WORKFLOW_START_BODY.render(props);
}
