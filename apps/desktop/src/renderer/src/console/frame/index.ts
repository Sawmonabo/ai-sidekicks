// The frame's public surface — what the renderer entry mounts a console through.
//
// A VIEW FAMILY REACHES NOTHING HERE. `ConsoleRoot` imports `console/families.ts`,
// which composes every view family in, so a family importing this door closes
// `families.ts → <family>/index.ts → frame/index.ts → ConsoleRoot.tsx →
// families.ts`, which `no-circular` fails — measured on a planted family. The
// readers are `src/renderer/src/App.tsx` and the tiers that mount a whole console.
// A family that needs a frame symbol takes the hoist instead, which is where the
// window command registry, the rail table and chords, the node's session directory,
// the absorbed Tier-1 mounts, `SurfaceAbsence` and `SurfaceErrorBoundary` went.
//
// Import order matters here in exactly one way: `frame.css` is imported by this
// barrel rather than by each component, so the sheet lands once per bundle and its
// rules cascade after the primitives' (whose barrel imports theirs first, being an
// upstream import of these components).
//
// A barrel re-exports only its own family. The route vocabulary used to be
// re-exported from here because it used to LIVE here; it now lives in
// `console/routing/`, below this family, and consumers import it from there. A
// barrel that forwarded another family's symbols would let a caller reach around
// the DAG without ever naming the family it was reaching into.

import "./frame.css";

export { ConsoleRoot } from "./ConsoleRoot.js";

// The two calls a composition root makes. The element id they install under is not
// beside them: nothing above this family names it, and the tiers that assert the
// sheet landed exactly once read it from `token-installation.ts` — the module that
// both declares it and puts it in the document.
export { applyConsoleScheme, installMeridianTokens } from "./token-installation.js";
