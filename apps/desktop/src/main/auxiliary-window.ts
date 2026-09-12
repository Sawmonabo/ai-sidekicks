// The auxiliary-window factory.
//
// An auxiliary window is the same locked `BrowserWindow` as the main one, at a
// window route: `./window.ts` owns HOW a window is constructed and loaded, and
// this module owns WHICH window opens and on what. The split is along that seam
// and not along file size — every line here is about admitting a launch
// descriptor, and none of it is about window construction, which is why
// `constructLockedWindow` stays where the build-time `webPreferences`
// assertion can keep covering exactly one literal.

import { type BrowserWindow } from "electron";
import { z } from "zod";

// Deep import, deliberately. The contracts barrel re-exports 24 modules, none
// of which Rollup can drop: every schema is a top-level factory call, which a
// bundler must treat as potentially side-effectful. Importing the barrel for
// one branded id put 233 kB of unreachable wire schemas into the main-process
// bundle — a startup-path cost on a process that is meant to stay light on the
// machine. The `./session` subpath is declared in
// `packages/contracts/package.json` with the same three conditions as the
// barrel, so source resolution under vitest and dist resolution in a build both
// behave exactly as they do for `.`.
import { SessionIdSchema } from "@ai-sidekicks/contracts/session";

import {
  formatAuxiliaryFragment,
  type AuxiliaryRouteTarget,
} from "../shared/auxiliary-route-fragment.js";
import {
  IMPLEMENTED_AUXILIARY_ROUTES,
  isAuxiliaryRouteName,
  type AuxiliaryRouteName,
} from "../shared/auxiliary-routes.js";
import {
  constructLockedWindow,
  prepareAndLoad,
  resolveRendererDocumentUrl,
  type LockedWindowOptions,
  type WindowLoadOptions,
} from "./window.js";

// The closed route set and the implemented subset live in
// `../shared/auxiliary-routes.ts` and the fragment shape in its sibling
// `../shared/auxiliary-route-fragment.ts`, both of which the renderer imports
// too — see the first module's header for why the "which routes exist" answer
// cannot live in a main-process registry. The name is re-exported here so a
// caller reaching for the window factory needs no second import for the type of
// the thing it opens.
export type { AuxiliaryRouteName } from "../shared/auxiliary-routes.js";

/**
 * What to open an auxiliary window on: the route, the pane context a detach
 * carries, and the handle the shell minted for the window itself.
 *
 * Two shapes, not one optional bag, because the two routes do not take the same
 * context: a detached agent console is meaningless without the agent it is a
 * console FOR, so on that route an `agentId` is required the moment any context
 * is present. The menu-bar path carries no context at all — it has no pane to
 * read one from — and opens the bare route, leaving the choice to the auxiliary
 * renderer's own context picker.
 *
 * `windowId` is the DETACH path's member and the menu-bar path's absence. The
 * shell mints a handle when a deck asks for a window and keeps a slot for the
 * pane it took; stamping that handle into the route is the only thing that
 * tells the window which window it is, and therefore the only thing that lets
 * it address the shell about itself rather than closing itself and leaving the
 * deck holding a placeholder. A menu-bar window has no deck slot behind it, so
 * it carries none — and the grammar refuses one on a bare route, so a caller
 * cannot ask for a handle without saying what the window is a view of.
 */
export type AuxiliaryWindowLaunch =
  | { readonly route: "timeline"; readonly sessionId?: string; readonly windowId?: string }
  | {
      readonly route: "agent-console";
      readonly sessionId?: string;
      readonly agentId?: string;
      readonly windowId?: string;
    };

/**
 * Refusal raised when a launch descriptor does not validate.
 *
 * A distinct class rather than a bare `Error` so a caller can tell a rejected
 * descriptor from a window that failed to construct, and so the message can
 * stay free of the offending value — an id that failed a shape check is
 * untrusted input, and echoing it into a log is how untrusted input reaches a
 * log reader.
 */
export class InvalidAuxiliaryWindowLaunchError extends Error {
  public constructor(reason: string) {
    super(`invalid auxiliary window launch: ${reason}`);
    this.name = "InvalidAuxiliaryWindowLaunchError";
  }
}

/** An admitted launch: the geometry it opens at, and its route fragment. */
interface ResolvedAuxiliaryLaunch {
  readonly geometry: LockedWindowOptions;
  readonly routeFragment: string;
}

/**
 * The size each auxiliary route opens at.
 *
 * Main-process data, so it lives in the main process. Window geometry is
 * meaningless to the renderer bundle — it cannot size its own window — and a
 * value shipped into a bundle that has no use for it is a shared module earning
 * its name by holding everything rather than by holding what is shared.
 *
 * A TOTAL `Record` over the closed route set, deliberately: adding a route to
 * `AUXILIARY_ROUTE_NAMES` is a compile error here until its size is decided, so
 * a new route cannot reach a window through a silent default. The same totality
 * on `AUXILIARY_ROUTE_LABELS` (shared) and the menu's accelerator record makes
 * that true at all three sites a route needs a decision.
 *
 * The timeline is wide because it renders a full-width event stream; the agent
 * console is taller than it is wide because it renders a single column.
 */
const AUXILIARY_WINDOW_GEOMETRY: Record<AuxiliaryRouteName, LockedWindowOptions> = {
  timeline: { width: 1100, height: 760 },
  "agent-console": { width: 980, height: 720 },
};

// The two id validators.
//
// `SessionIdSchema` is the contracts package's own branded schema and is used
// verbatim. `AgentId` has no canonical brand yet — its home is the unshipped
// `packages/contracts/src/orchestration.ts`, and minting a second branded
// schema here would be the duplicate source of truth that contracts file's
// existing branded-id doctrine forbids — so the agent id is UUID-shape
// validated at the seam, the same treatment `provider-driver.ts` gives its own
// `agentId` member for the same reason. Nothing here re-implements a check the
// corpus already exports.
const AgentIdShapeSchema = z.string().uuid();

/**
 * The shell's own window handle, held to a shape rather than taken on trust.
 *
 * It is OPAQUE to everything downstream — the console addresses focus, close
 * and return by it and never parses it — so there is no canonical schema to
 * reuse and nothing here decodes it. What this bounds is the one property the
 * fragment cares about: a handle is a single route segment, and a value
 * carrying a separator, a control character, or an unbounded length is a
 * payload rather than a handle. The check runs in the main process for
 * `resolveAuxiliaryLaunch`'s stated reason — the fragment is the one part of
 * the loaded URL a caller controls — and it refuses before a window exists
 * rather than after one is pointed at a route.
 */
const WindowHandleShapeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Validates a launch descriptor and renders it as a route fragment.
 *
 * Runs to completion BEFORE any window is constructed, so a malformed
 * descriptor costs a throw and not a live `BrowserWindow` already pointed at a
 * URL the renderer then has to defend itself against. Every id is checked by
 * shape in the main process — the trusted side — rather than taken on the
 * caller's word, because the fragment is the one part of the loaded URL a
 * caller controls. The route is re-checked at runtime for the same reason: the
 * compile-time union binds this package's own call sites, and the renderer-side
 * detach arrives over IPC through `./auxiliary-window-ipc.ts`, where a type is a
 * claim and not a guarantee.
 */
function resolveAuxiliaryLaunch(launch: AuxiliaryWindowLaunch): ResolvedAuxiliaryLaunch {
  // Two conditions, one refusal, because from a window's point of view they are
  // the same condition — nothing to show. A route outside the closed set is not
  // a route at all; a route the closed set carries but this build does not
  // IMPLEMENT has no renderer body, so a window would open on an empty hash
  // route: a blank frame the user has to close.
  if (!isAuxiliaryRouteName(launch.route) || !IMPLEMENTED_AUXILIARY_ROUTES.includes(launch.route)) {
    throw new InvalidAuxiliaryWindowLaunchError("unknown route");
  }
  const geometry = AUXILIARY_WINDOW_GEOMETRY[launch.route];

  const { sessionId, windowId } = launch;
  const agentId = launch.route === "agent-console" ? launch.agentId : undefined;

  if (windowId !== undefined && !WindowHandleShapeSchema.safeParse(windowId).success) {
    throw new InvalidAuxiliaryWindowLaunchError("windowId is not a window handle");
  }

  if (sessionId === undefined) {
    // No context at all is the menu-bar shape. An agent id with no session to
    // read it in is not a partial descriptor, it is an incoherent one.
    if (agentId !== undefined) {
      throw new InvalidAuxiliaryWindowLaunchError("agentId supplied without sessionId");
    }
    // And a handle with no context is the same class of incoherence from the
    // other side: the shell mints one when a deck asks for a window on one of
    // its panes, so a handle arriving with nothing for the window to show names
    // a deck slot for a pane the descriptor does not identify. Refused here as
    // well as by the shared grammar, so the failure names the descriptor rather
    // than surfacing as an encoding error from a module the caller never called.
    if (windowId !== undefined) {
      throw new InvalidAuxiliaryWindowLaunchError("windowId supplied without sessionId");
    }
    // Re-selected per route rather than spread from `launch.route`:
    // `AuxiliaryRouteTarget` is a union discriminated ON the route, and a value
    // typed `{ route: "timeline" | "agent-console" }` is assignable to no single
    // member of it — TypeScript does not distribute an object type over a union
    // in its own discriminant. Widening the target type to accept it would undo
    // exactly the grammar that union encodes.
    const bareTarget: AuxiliaryRouteTarget =
      launch.route === "timeline" ? { route: "timeline" } : { route: "agent-console" };
    return { geometry, routeFragment: formatAuxiliaryFragment(bareTarget) };
  }

  if (!SessionIdSchema.safeParse(sessionId).success) {
    throw new InvalidAuxiliaryWindowLaunchError("sessionId is not a canonical UUID");
  }

  if (launch.route === "timeline") {
    const target: AuxiliaryRouteTarget =
      windowId === undefined
        ? { route: launch.route, sessionId }
        : { route: launch.route, sessionId, windowId };
    return { geometry, routeFragment: formatAuxiliaryFragment(target) };
  }

  // Context on the agent-console route is only meaningful with the agent: a
  // console window is a console FOR something.
  if (agentId === undefined) {
    throw new InvalidAuxiliaryWindowLaunchError("agent-console context requires an agentId");
  }
  if (!AgentIdShapeSchema.safeParse(agentId).success) {
    throw new InvalidAuxiliaryWindowLaunchError("agentId is not a canonical UUID");
  }
  const target: AuxiliaryRouteTarget =
    windowId === undefined
      ? { route: launch.route, sessionId, agentId }
      : { route: launch.route, sessionId, agentId, windowId };
  return { geometry, routeFragment: formatAuxiliaryFragment(target) };
}

/**
 * An auxiliary window: the same locked factory, the same bundle, at a window
 * route.
 *
 * It holds no reference to the main window and reads none of its state — it is
 * constructed, pointed at a route, and handed back. Because it mints its own
 * preload, it gets its own `contextBridge` instance and therefore its own
 * bridge; it subscribes to the daemon itself and shares no in-memory store with
 * any other window.
 *
 * Throws `InvalidAuxiliaryWindowLaunchError` on a malformed descriptor, before
 * constructing anything.
 */
export function createAuxiliaryWindow(
  launch: AuxiliaryWindowLaunch,
  options: WindowLoadOptions = {},
): BrowserWindow {
  // Deliberately first: validation must not leave a window behind.
  const { geometry, routeFragment } = resolveAuxiliaryLaunch(launch);

  const browserWindow = constructLockedWindow(geometry);

  // A crashed auxiliary window is closed and disposed rather than left as an
  // empty frame. Deliberately NOT registered on the main window: closing that
  // one on a renderer crash would fire `window-all-closed` and quit the
  // application out from under the user, and main-window crash handling belongs
  // to the crash reporter. This listener tells no deck anything — the deck's
  // pane-error slot is fed by `./auxiliary-window-ipc.ts`, which registers its
  // own listener on the same
  // event and knows which renderer asked for this window. Two listeners and not
  // one shared arm, because the two acts have different owners: disposing a dead
  // window belongs to whoever built it, and reporting the loss belongs to
  // whoever holds the deck slot it came from.
  browserWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      `[ai-sidekicks/desktop] auxiliary window renderer gone ` +
        `(route=${launch.route}, reason=${details.reason}, exitCode=${String(details.exitCode)})`,
    );
    if (!browserWindow.isDestroyed()) {
      browserWindow.destroy();
    }
  });

  prepareAndLoad(browserWindow, resolveRendererDocumentUrl(routeFragment), "auxiliary", options);

  return browserWindow;
}
