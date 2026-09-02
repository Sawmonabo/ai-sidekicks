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
