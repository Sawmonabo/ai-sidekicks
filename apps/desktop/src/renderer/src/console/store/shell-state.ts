// What the shell knows about itself, and what that costs the window.
//
// The console's honest chrome has three facts behind it and they arrive together:
// which step of the daemon supervisor's own state machine this window is on, which
// protocol the handshake settled on, and the two ways an install can be quietly
// weaker than the default (a loopback transport, an unusable OS keystore). One
// value carries all three, because they are one report from one owner — the main
// process — and three slices would be three chances for a window to render a
// connection state from one report beside a keystore state from another.
//
// IT LIVES IN `store/` RATHER THAN IN `frame/`, and the reason is who reads it. The
// frame publishes it and renders most of it, but the palette reads it to say the
// window is read-only, a settings page reads it for the supervisor detail, and a
// view family reads it to disable a control it is about to offer — and `palette/`
// and every view family sit ABOVE `frame/` or below it in the console DAG, so a
// vocabulary declared there is one none of them may import. `store/` is the lowest
// family that owns the frame store this value is published into.
//
// NOTHING HERE READS A CLOCK, A TIMER, OR A WIRE. This module is the vocabulary and
// the two derivations every consumer shares; the subscription that fills it lives in
// `frame/shell-state/`, and the fold over open session stores lives there too.
//
// THE UNREPORTED ARM IS THE ONE THAT MAKES THIS HONEST. No bridge namespace carries
// the shell's status yet (`Plan-023 §Console growth slate`), so the ordinary state of
// a shipped window is "nobody has said". That is not `connected` and it is not
// `offline`: a window that synthesised `connected` from a call that happened to
// succeed would be doing exactly what `Spec-023 §Trust Stance` forbids, and one that
// assumed `offline` would disable every mutating control in a console that works.
// So the arm exists, it renders as the _not checked_ kind of nothing, and it blocks
// nothing.

import type { ConsoleRoute } from "../routing/index.js";
import type { SessionDegradedCause } from "./degradation.js";

/**
 * What the handshake settled, as `DaemonHelloAck` carries it.
 *
 * The members are the ack's own (`packages/contracts/src/jsonrpc-negotiation.ts`):
 * whether the daemon called this build compatible, the version it chose, its full
 * supported set where it sent one, and the reason string on the incompatible arm.
 * The console renders them and compares nothing — `Spec-023`'s version banner is a
 * rendering of a verdict the daemon reached, and a floor comparison performed here
 * would be the second source of truth the corpus forbids.
 */
export interface ShellNegotiation {
  readonly compatible: boolean;
  /** The daemon's chosen protocol version, verbatim. */
  readonly daemonProtocolVersion: string;
  /** The version this build proposed, verbatim. */
  readonly consoleProtocolVersion: string;
  /** The daemon's full supported set, where the refused ack carried one. */
  readonly daemonSupportedProtocols: readonly string[];
  /** The ack's own `reason`, present only on the incompatible arm. */
  readonly reason: string | undefined;
}

/**
 * Where this window stands with its local runtime.
 *
 * THE ONLY ENUMERATION OF THE SUPERVISOR'S STATES. A tuple beside this union would be
 * a second closed set free to disagree with it, and the union is the one a surface
 * actually narrows on. `Spec-023 §Daemon Supervision Lifecycle` numbers six steps and
 * these are its arms: `probing` is step 1's startup probe, `starting` step 2's spawn
 * and ten-second readiness wait, `version-incompatible` step 3, `connected` step 4's
 * live heartbeat, `reconnecting` step 5's backoff ladder, `offline` that ladder's
 * terminal after the fifth failed attempt, and `stopped` step 6's deliberate
 * shutdown — which is not a failure and does not read as one.
 *
 * A discriminated union rather than a state plus optional fields, because the fields
 * are not optional per state: a reconnecting window HAS an attempt and a connected
 * one does not, and a shape carrying `attempt?: number` would let a surface render
 * "attempt 3 of 5" beside "connected".
 */
export type ShellConnection =
  /** Nobody has reported. Renders as _not checked_; never as connected, never as down. */
  | { readonly kind: "unreported" }
  | { readonly kind: "probing" }
  | { readonly kind: "starting" }
  | { readonly kind: "connected" }
  | { readonly kind: "reconnecting"; readonly attempt: number; readonly attemptLimit: number }
  /** The handshake was refused. The facts are on `ShellState.negotiation`. */
  | { readonly kind: "version-incompatible" }
  | {
      readonly kind: "offline";
      readonly attemptLimit: number;
      /** The supervisor's last recorded exit or spawn failure, verbatim. */
      readonly lastError: string | undefined;
    }
  | { readonly kind: "stopped" };

/** Which transport reached the daemon. `loopback` is the visibly second-class one. */
export type ShellTransport = "os-local" | "loopback";

/** Whether long-lived auth material can be persisted at all on this host. */
export type ShellKeystoreState = "available" | "unavailable";

/**
 * The whole report, as one window holds it.
 *
 * Every member is `undefined` until something says otherwise, and `undefined` means
 * "unreported" rather than a default: a console that rendered `os-local` because
 * nothing had said would be claiming a transport posture it never read.
 */
export interface ShellState {
  readonly connection: ShellConnection;
  /**
   * What the handshake settled, on every arm it settled on.
   *
   * Beside the connection rather than inside its refused arm, because the daemon
   * answers `protocolVersion` on the ACCEPTED ack too and the daemon page names the
   * version a connected runtime speaks. One home for the handshake's facts means a
   * surface never has to ask which arm it may read the version from.
   */
  readonly negotiation: ShellNegotiation | undefined;
  /** The last heartbeat the supervisor observed, verbatim from the wire. */
  readonly lastHeartbeatAt: string | undefined;
  readonly transport: ShellTransport | undefined;
  readonly keystore: ShellKeystoreState | undefined;
  /**
   * The worst degraded cause standing across this window's open session stores.
   *
   * Folded from the stores the window already holds rather than reported by the
   * shell: `store/degradation.ts` owns the ladder and the stores own the causes, so
   * this is the one place the two meet a person. It is what "recovering, catching up"
   * is rendered from, and it clears when a re-pull completes and by nothing else.
   */
  readonly sessionRecovery: SessionDegradedCause | undefined;
}

/** What a window holds before anything has reported. The store is born on it. */
export const UNREPORTED_SHELL_STATE: ShellState = {
  connection: { kind: "unreported" },
  negotiation: undefined,
  lastHeartbeatAt: undefined,
  transport: undefined,
  keystore: undefined,
  sessionRecovery: undefined,
};

/**
 * The daemon methods registered `mutating: true`, and no others.
 *
 * `Spec-023 §Daemon Supervision Lifecycle` step 3 blocks mutating operations and
 * permits read-only subscriptions, and the classification is the daemon method
 * registry's own `mutating` flag rather than a judgement made here — these six are
 * the registrations carrying it (`packages/runtime-daemon/src/ipc/handlers/`). The
 * table is a closed tuple so "exactly these and no others" is countable, and so a
 * seventh mutating registration is a deliberate edit here rather than a control that
 * silently stays live through an outage.
 */
export const MUTATING_DAEMON_METHODS = [
  "session.create",
  "session.join",
  "driver.interruptRun",
  "driver.applyIntervention",
  "driver.respondToRequest",
  "driver.compactContext",
] as const;

/** One mutating method name. Derived from the tuple above. */
export type MutatingDaemonMethod = (typeof MUTATING_DAEMON_METHODS)[number];

/** Whether a method string is one of the six. Total over every string. */
export function isMutatingDaemonMethod(method: string): method is MutatingDaemonMethod {
  return (MUTATING_DAEMON_METHODS as readonly string[]).includes(method);
}

/**
 * Why a mutating control is closed, or `undefined` while nothing closes it.
 *
 * The two members are the console's own refusal fields — a code in mono and a
 * sentence — so a control renders this through the same `InlineRefusal` it renders a
 * daemon refusal through, and no surface grows a second shape for "the shell says
 * no".
 */
export interface ShellMutationBlock {
  readonly code: string;
  readonly detail: string;
}

/**
 * The cause a disabled control names, or `undefined` while none applies.
 *
 * Four codes rather than the three failures the design enumerates: `stopped` is a
 * deliberate shutdown and reads as one, and folding it into "offline" would report a
 * shell somebody turned off as a shell that could not be reached.
 */
export function shellMutationBlock(state: ShellState): ShellMutationBlock | undefined {
  const { connection } = state;
  switch (connection.kind) {
    case "unreported":
    case "connected":
      return undefined;
    case "probing":
    case "starting":
      return {
        code: "shell-disconnected",
        detail:
          "The local runtime is still starting, so nothing can be sent to it yet. Everything on screen is the last state this window was sent.",
      };
    case "reconnecting":
      return {
        code: "shell-disconnected",
        detail: `The local runtime is not connected — attempt ${String(connection.attempt)} of ${String(connection.attemptLimit)}. Everything on screen is the last state this window was sent.`,
      };
    case "version-incompatible":
      return {
        code: "shell-version-incompatible",
        detail:
          "The local runtime refused this build's protocol version, so mutating operations are blocked and reads continue. The banner says which side moves.",
      };
    case "offline":
      return {
        code: "shell-offline",
        detail: `The local runtime did not come back after ${String(connection.attemptLimit)} attempts. Everything on screen is the last state this window was sent, and a retry is offered on the banner.`,
      };
    case "stopped":
      return {
        code: "shell-stopped",
        detail:
          "The local runtime has been stopped. Everything on screen is the last state this window was sent; starting it again is a shell action, never a call.",
      };
  }
}

/**
 * The block that applies to ONE method, or `undefined` where none does.
 *
 * The seam every control that dispatches a daemon call goes through, so the
 * "exactly the six mutating methods, and no others" rule has one implementation: a
 * read stays live through every arm above, because a surface asking about
 * `session.read` is told nothing blocks it even while the shell is offline.
 */
export function shellBlockForMethod(
  state: ShellState,
  method: string,
): ShellMutationBlock | undefined {
  return isMutatingDaemonMethod(method) ? shellMutationBlock(state) : undefined;
}

/**
 * The half of {@link ShellState} the shell itself reports.
 *
 * A derived type rather than a second interface: the state is one value with two
 * owners — the shell's own report and the window's fold over its open session
 * stores — and writing the members out again would be the set declared twice.
 */
export type ShellReport = Omit<ShellState, "sessionRecovery">;

/**
 * Whether two reports say the same thing.
 *
 * The subscription that fills this state answers with a fresh object per frame, so
 * without a comparison every heartbeat would re-render the rail, the banner stack,
 * the chip, and every control that reads the block — for a value that did not move.
 * Written over the union rather than as a deep equality, so a new arm is a compile
 * error here rather than a silent "always different".
 */
export function shellReportsAreEqual(left: ShellReport, right: ShellReport): boolean {
  return (
    left.lastHeartbeatAt === right.lastHeartbeatAt &&
    left.transport === right.transport &&
    left.keystore === right.keystore &&
    shellNegotiationsAreEqual(left.negotiation, right.negotiation) &&
    shellConnectionsAreEqual(left.connection, right.connection)
  );
}

function shellConnectionsAreEqual(left: ShellConnection, right: ShellConnection): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "unreported":
    case "probing":
    case "starting":
    case "connected":
    case "stopped":
      return true;
    case "reconnecting":
      return (
        right.kind === "reconnecting" &&
        left.attempt === right.attempt &&
        left.attemptLimit === right.attemptLimit
      );
    case "offline":
      return (
        right.kind === "offline" &&
        left.attemptLimit === right.attemptLimit &&
        left.lastError === right.lastError
      );
    case "version-incompatible":
      return true;
  }
}

/** The handshake's facts, compared member by member. Absent equals absent. */
function shellNegotiationsAreEqual(
  left: ShellNegotiation | undefined,
  right: ShellNegotiation | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.compatible === right.compatible &&
    left.reason === right.reason &&
    left.consoleProtocolVersion === right.consoleProtocolVersion &&
    left.daemonProtocolVersion === right.daemonProtocolVersion &&
    left.daemonSupportedProtocols.length === right.daemonSupportedProtocols.length &&
    left.daemonSupportedProtocols.every(
      (version, position) => version === right.daemonSupportedProtocols[position],
    )
  );
}

/**
 * One supervisor state in a person's words.
 *
 * HERE RATHER THAN IN THE FRAME because two families render it — the frame's chip and
 * the local-runtime settings page's state row — and the console's family DAG runs one
 * way, so a sentence declared in `frame/` is one a view family cannot reach without
 * a second spelling of it. Its neighbour {@link shellMutationBlock} already carries
 * prose for the same reason.
 */
export function describeShellConnection(connection: ShellConnection): string {
  switch (connection.kind) {
    case "unreported":
      return "Local runtime";
    case "probing":
      return "Checking the local runtime";
    case "starting":
      return "Starting the local runtime";
    case "connected":
      return "Local runtime connected";
    case "reconnecting":
      return `Reconnecting — attempt ${String(connection.attempt)} of ${String(connection.attemptLimit)}`;
    case "version-incompatible":
      return "Version mismatch";
    case "offline":
      return "Local runtime offline";
    case "stopped":
      return "Local runtime stopped";
  }
}

/**
 * What a window with no report says about the runtime, in one place.
 *
 * Two surfaces render this absence — the frame's chip and the settings page's state
 * row — and it is one fact, so it has one spelling.
 */
export const UNREPORTED_SHELL_NOTICE: { readonly title: string; readonly detail: string } = {
  title: "Local runtime",
  detail:
    "This build has no channel carrying the supervisor's state, so this window has not been told whether the local runtime is running.",
};

/**
 * Where the supervisor's own detail lives, and what a control opening it promises.
 *
 * Named rather than written inline on the constant below, and deliberately NOT
 * exported: nothing outside this module names the shape, and a door line for a type
 * with no production reader is the dead export the barrel census fails.
 */
interface ShellDetailDestination {
  /** The settings section id, which the settings rail lists and this console owns. */
  readonly section: "daemon";
  /** That section as a route value — what a control navigates to, never a hash. */
  readonly route: ConsoleRoute;
  /** What the control opening it says it will do, for its accessible name. */
  readonly openLabel: string;
}

/** The section id, bound once so the route and the rail entry cannot spell it twice. */
const SHELL_DETAIL_SECTION = "daemon";

/**
 * The supervisor's detail page, as one value every reader of it shares.
 *
 * HERE FOR THE REASON ITS NEIGHBOURS ABOVE ARE HERE. The frame's chip navigates to
 * this page, and `frame/` may not import a view family at all — so the destination
 * cannot live beside the settings rail that renders it, and a literal spelled at the
 * chip would be one more surface deciding for itself where the supervisor lives.
 * `store/` is the lowest family the readers can reach and already owns the two
 * sentences both sides say.
 *
 * ITS COUPLING TO THE SETTINGS RAIL IS PINNED BY A TEST AND NOT BY AN IMPORT, which
 * is the direction the DAG leaves open: `settings/settings-sections.ts` is the closed
 * enumeration of section ids and it is deliberately a leaf, while consuming this
 * constant from there would make an exported `as const` tuple carry a property access
 * that `--isolatedDeclarations` cannot type. So `frame/shell-state/ShellChrome.test.tsx`
 * asserts that this section is one the rail lists, and a rename on either side fails
 * there rather than shipping a chip that opens a page nothing answers for.
 *
 * A ROUTE AND NOT AN ADDRESS. `#/settings/daemon` composed by hand would be a second
 * implementation of `routing/`'s own formatter, and the one place a segment could be
 * escaped differently from every other; a route value goes through the frame store,
 * and the hash follows from there.
 */
export const SHELL_DETAIL_DESTINATION: ShellDetailDestination = {
  section: SHELL_DETAIL_SECTION,
  route: { kind: "settings", page: SHELL_DETAIL_SECTION },
  openLabel: "open the local runtime page",
};
