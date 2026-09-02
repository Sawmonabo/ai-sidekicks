// The frame's public surface — what the six 1C families import.
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

export {
  MERIDIAN_STYLE_ELEMENT_ID,
  applyConsoleScheme,
  installMeridianTokens,
} from "./token-installation.js";

// The surface seat's own vocabulary. A view family claims its slot by exporting a
// `register<Family>` function that `families.ts` calls with the registry, so the
// registry type leaves through this door rather than being deep-imported past it —
// which is the one way a family reaches the frame at all.
export type { ConsoleSurfaceRegistry } from "./surface-registry.js";
