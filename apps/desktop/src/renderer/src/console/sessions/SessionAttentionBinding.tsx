// The one attention read this window performs, for as long as the window is open.
//
// WHAT MOVED HERE AND WHY. The read used to live in `SessionsSurface`, which is a
// destination — so the rail's count stood while a person was looking at the sessions
// list and vanished the moment they navigated anywhere else. `Spec-023 §The icon
// rail` suppresses the count while the projection is UNREACHABLE, and a window that
// has simply moved to another destination is not an unreachable machine: the daemon
// is answering, this window is following it, and the honest number was being thrown
// away because of where the read happened to be mounted. It happens here now, on the
// frame-lifetime binding seat, so the count is live from the moment the window
// resolves a bridge until it tears down.
//
// AND IT IS STILL EXACTLY ONE READ. The destination consumes what this binding holds
// rather than opening its own — the notification centre renders the same reading the
// rail counts, so the panel and the badge cannot disagree about what needs a person,
// which two reads, however carefully written, eventually would.
//
// THE DIRECTORY COMES WITH IT, and that is a consequence rather than a second job.
// The attention wire is session-scoped and neither this binding nor that destination
// is, so the read is fanned out over the sessions this window can NAME — the node's
// directory merged with this window's own open set. Left on the destination, the
// directory would have been read twice per window: once here to address the fan-out
// and once there to draw the list. It is read once and provided, and the destination
// takes it from the same place it takes the reading.
//
// AND THE OS NOTIFICATION CAME WITH IT, for the reason that moved the count and one
// more. `Spec-019 §Required Behavior` requires attention-worthy states to surface
// "even when the user is not actively watching the timeline", and its §Default
// Behavior scopes the banner to whether the app is UNFOCUSED — neither says anything
// about which destination is open, and a notification whose whole purpose is to reach
// someone who is looking elsewhere was the one thing still mounted on the screen they
// had left. A person on the settings page got no banner and no OS notification for an
// approval that had just started waiting on them.
//
// ONE READ AND ONE EMITTER, not a second projection. The permission reading is taken
// here and PROVIDED, so the destination's notification centre renders the same answer
// this emitter acted on — two reads of one machine fact could disagree about whether
// the centre is the only surface these items reach. The global-only mute and the
// never-stale rules are unchanged and live where they already did: no preference
// filter and no quiet-hours rule is applied here (the control plane drops non-matching
// events before emission and the shell honours do-not-disturb), a withheld permission
// remembers the arrival without raising it, and the first settled read still raises
// nothing at all.
//
// NOTHING HERE POLLS AND NOTHING HERE RENDERS. The read re-runs when the session
// projections underneath it move, through the console's one push-driven read
// discipline; this component draws no markup and returns the subtree it was handed.

import { createContext, useContext, useMemo } from "react";

import { ConsoleRefusalError, refuse } from "../core/index.js";
// The seat's own props type rather than a second declaration of the same two
// members: this component IS a frame binding's mount, so its shape is the board's and
// a local copy would be one more thing to keep in step.
import type { FrameBindingProps } from "../seats/index.js";
import { useSessionDirectory, type SessionDirectoryState } from "../seats/index.js";
import { useOpenSessionIds } from "../store/index.js";
import {
  attentionProjectionReaderFor,
  useAttentionNotifications,
  useAttentionProjection,
  useOsNotificationDelivery,
  useRailAttentionPublisher,
  type AttentionReading,
  type OsNotificationDelivery,
} from "./notifications/index.js";
import { mergeSessionRows } from "./rows/session-directory-rows.js";
import type { SessionListRow } from "./rows/session-rows.js";

/** The subsystem a missing binding names as the author of its refusal. */
const SESSION_ATTENTION_ORIGIN = "session-attention-binding";

/**
 * What this window holds about the sessions it can name, read once.
 *
 * The five members are what the consumers between them need, and no more: the rail
 * counts the reading, this binding's own emitter raises what the delivery reading
 * permits, the destination renders the reading and its delivery arm and offers the
 * re-open, and both the list and the invitations fan-out are addressed by the same
 * session set this binding already merged to address its own read.
 */
export interface SessionAttention {
  /** The node's own session list, as the read settled it. */
  readonly directory: SessionDirectoryState;
  /** Every session this window can name — the directory merged with its open set. */
  readonly sessionIds: readonly string[];
  readonly reading: AttentionReading;
  /**
   * Whether an OS notification this window raises will reach anybody.
   *
   * Read here rather than on the destination so the emitter above and the centre
   * below act on ONE answer. Advisory in both places: it changes what the centre
   * says and whether the emitter spends a call, never whether the shell is the
   * authority on delivery, which it is.
   */
  readonly delivery: OsNotificationDelivery;
  /** Re-open or re-read the projection. Offered on the refused phase and nowhere else. */
  readonly retry: () => void;
}

const SessionAttentionContext = createContext<SessionAttention | undefined>(undefined);

/**
 * Perform the read for the frame's lifetime and provide it to whatever is below.
 *
 * MOUNTED BY THE COMPOSITION AND NEVER BY A ROUTE. The frame wraps its subtree in
 * every registered binding, so this component's lifetime is the window's — which is
 * the whole of what makes the count survive a navigation.
 */
export function SessionAttentionBinding(props: FrameBindingProps): React.JSX.Element {
  const { bridge, frameStore, sessionStoreRegistry } = props.context;
  const { growth } = bridge;
  const directory = useSessionDirectory(growth);
  const windowSessionIds = useOpenSessionIds(sessionStoreRegistry);
  // Memoised on the merged ids rather than on the directory object, so the read fires
  // once when the directory settles and not again on every later render.
  const sessionIds = useMemo(
    () => mergeSessionRows({ directory, windowSessionIds, projectedRows: [] }).map(sessionIdOf),
    [directory, windowSessionIds],
  );
  const projection = useAttentionProjection(
    useMemo(() => attentionProjectionReaderFor(growth, sessionIds), [growth, sessionIds]),
    sessionStoreRegistry,
  );
  // The rail's count, published from the read that knows it. `undefined` on every
  // phase but the answered one, so a window that cannot reach the projection shows no
  // badge rather than the last number it was given.
  useRailAttentionPublisher(frameStore, projection.reading);
  const delivery = useOsNotificationDelivery(growth);
  // The emission, on the window's lifetime rather than the sessions destination's.
  // What decides a banner is where the window was when the item arrived — never which
  // screen was open, which is the audience rule read backwards.
  useAttentionNotifications({
    reading: projection.reading,
    delivery,
    frameStore,
    bridge,
  });
  const held = useMemo<SessionAttention>(
    () => ({
      directory,
      sessionIds,
      reading: projection.reading,
      delivery,
      retry: projection.retry,
    }),
    [directory, sessionIds, delivery, projection],
  );
  return (
    <SessionAttentionContext.Provider value={held}>
      {props.children}
    </SessionAttentionContext.Provider>
  );
}

/**
 * What the binding above holds.
 *
 * RAISES RATHER THAN SUBSTITUTES. A surface reaching for a binding no composition
 * mounted is a wiring defect, and the honest answers a fallback could give are both
 * wrong: an empty reading would render "nothing needs you" over a projection nobody
 * read, and a second read here would be the second answer this binding exists to
 * prevent. It is the rule `useConsoleBridge` already follows one layer down.
 */
export function useSessionAttention(): SessionAttention {
  const held = useContext(SessionAttentionContext);
  if (held === undefined) {
    throw new ConsoleRefusalError(
      refuse(
        SESSION_ATTENTION_ORIGIN,
        "binding-unmounted",
        "This surface reads the window's attention binding, and no composition mounted one above it.",
      ),
    );
  }
  return held;
}

/**
 * One row's session id.
 *
 * Module-level rather than a lambda inside the memo above, on the rule the
 * destination's own copy states: a mount-lifetime cell naming a session is the shape
 * the console holds through its one subject-keyed holder, so a cell whose body writes
 * the word for a reason of its own is the shape a reader — and
 * `test/console/architecture/subject-state-chokepoint.test.ts` — has to stop and check.
 */
function sessionIdOf(row: SessionListRow): string {
  return row.sessionId;
}
