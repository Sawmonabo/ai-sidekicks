// The phase graph's door, and the module the loader's `import()` names.
//
// THIS FILE IS THE LAZY CHUNK'S ENTRY. `phase-graph-loader.ts` reaches this module
// and nothing else in this directory, so everything under it — the graph library, its
// `@xyflow/system` runtime sibling, the library's own `base.css` and this directory's
// sheet — is emitted as one chunk and fetched the first time a run's phases are
// drawn. A static import of any of it from a pane the console can open at boot would
// put every one of those bytes into the document the operator waits for.
//
// WHY THE STYLESHEETS ENTER HERE. `apps/desktop/AGENTS.md` admits a stylesheet
// through the barrel of the family or of the lazily-loaded chunk that owns it, and
// through no component. This directory is the second case, and the door is what makes
// it one: imported from `PhaseGraphCanvas.tsx` the sheets would be a component's own
// edge, and pulled up into `workflows.css` with the family's other per-surface sheets
// they would land on the initial path this whole arrangement exists to keep them off.
//
// THE ORDER OF THE TWO IMPORTS IS LOAD-BEARING, and it is stated here in source order
// rather than left to be derived from the module graph. `base.css` defines the
// library's own fallback palette on `.react-flow`; `phase-graph.css` redefines every
// one of those properties from Meridian tokens at equal specificity, so it has to come
// second or the library's fallback paints.
//
// ONE EXPORT. The canvas is the whole of the chunk's public surface — the layout, the
// topology, the element builders and the node body are reached from inside it — and a
// second export would be a second way into a chunk whose single fetch the loader's
// memo serialises.

import "@xyflow/react/dist/base.css";
import "./phase-graph.css";

export { PhaseGraphCanvas } from "./PhaseGraphCanvas.js";
