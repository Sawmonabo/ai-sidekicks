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

export {
  DEFAULT_ROUTE,
  RAIL_DESTINATIONS,
  formatRoute,
  isAuxiliaryRoute,
  needsContextPicker,
  parseRoute,
  railDestinationFor,
  routeSessionId,
  routesAreEqual,
  type ConsoleRoute,
  type RailDestination,
} from "./routes.js";

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
  InvalidAuxiliaryRouteTargetError,
  formatAuxiliaryFragment,
  isAuxiliaryRouteName,
  type AuxiliaryRouteName,
} from "../../../../shared/auxiliary-routes.js";
