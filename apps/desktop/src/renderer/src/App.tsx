// The renderer's root component.
//
// Plan-023 Phase 1C mounts the console here, replacing the Phase-1 substrate probe
// (`SessionBootstrap`) that this component rendered while there was nothing else to
// render. That component is not deleted — it is Plan-002's, it keeps its own unit
// tests, and Plan-002's surfaces mount it through the console's surface registry
// when they land. What changes is only what the ROOT renders.
//
// Everything the console needs it builds for itself: `ConsoleRoot` installs the
// token sheet before first paint, resolves the bridge (live or `define`-gated
// fixture), creates the per-window stores, and mounts whatever the route names.

import { ConsoleRoot } from "./console/frame/index.js";

export function App(): React.JSX.Element {
  return <ConsoleRoot />;
}
