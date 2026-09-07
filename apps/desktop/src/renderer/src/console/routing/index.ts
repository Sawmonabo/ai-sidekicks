// The routing family's door.
//
// Routing sits BELOW both `store/` and `frame/` in the console's family DAG, and
// that placement is the point rather than an arrangement. It used to live in
// `frame/`, which meant `store/frame-store.ts` imported `frame/routes.js` while
// three `frame/` modules imported `FrameStore` back — a family-level cycle that
// happened to work because bundlers tolerate it, and that any later family could
// have closed into a real one.
//
// Nothing here holds state, reads the DOM, or knows a store exists. A route is a
// value parsed from a string and rendered back to one.
//
// TWO MODULES BEHIND ONE DOOR. `routes.ts` is the grammar — the union, the parser, and
// the formatter that inverts it — and `route-readers.ts` is what a caller asks of a
// route it already has. The door re-exports from whichever module DECLARES a symbol,
// so a reader following a name lands on the reasoning that owns it.

export { DEFAULT_ROUTE, formatRoute, parseRoute, type ConsoleRoute } from "./routes.js";
export {
  RAIL_DESTINATIONS,
  isAuxiliaryRoute,
  needsContextPicker,
  railDestinationFor,
  routeAuxiliaryWindowId,
  routeSessionId,
  routesAreEqual,
  settingsRoute,
  settingsSelection,
  type RailDestination,
} from "./route-readers.js";

// The auxiliary-route grammar, declared in `src/shared/auxiliary-routes.ts` because
// the main process's Window menu reads the same table.
//
// It leaves through THIS door rather than through `core/` because this is the family
// that owns route grammar — `routes.ts` beside this line already reads that leaf to
// parse an auxiliary address — and because a view family may not read the
// cross-process leaf itself: it sits under no rung of the DAG, so nothing orders that
// edge and a second reading of the route vocabulary could land above the family that
// owns the first.
export {
  AUXILIARY_ROUTE_LABELS,
  IMPLEMENTED_AUXILIARY_ROUTES,
  isAuxiliaryRouteName,
  type AuxiliaryRouteName,
} from "../../../../shared/auxiliary-routes.js";
// The grammar's own half, from the leaf that holds both sides of it. Two lines
// rather than one because the cross-process leaf is two modules — what routes
// exist, and how one becomes an address — and forwarding the second through the
// first would put a re-export chain across the process boundary.
export {
  InvalidAuxiliaryRouteTargetError,
  formatAuxiliaryFragment,
} from "../../../../shared/auxiliary-route-fragment.js";
