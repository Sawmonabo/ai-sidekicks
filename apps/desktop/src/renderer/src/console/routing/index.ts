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
  routeSessionId,
  routeWorkflowPhase,
  routesAreEqual,
  settingsRoute,
  settingsSelection,
  type RailDestination,
  type WorkflowPhaseFocus,
} from "./route-readers.js";
