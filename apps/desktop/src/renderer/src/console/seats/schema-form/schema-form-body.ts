// The schema form kit's chunk root: the one module an `import()` names, and everything
// the kit publishes to the console reached through it.
//
// WHY IT EXISTS. Nothing on the flagship first paint draws a schema. The three surfaces
// that do — the run pane's waiting-phase form, the builder's phase preview, and the
// input-ask card's structured arm behind them — all arrive as loader-backed bodies of
// their own, so every module in this directory is reached from a lazy chunk and from
// nowhere else. It rode the initial graph anyway, because the seats door re-exported the
// two composed surfaces statically and `apps/desktop/AGENTS.md` §Module shape states
// exactly what that costs: a symbol reachable both statically and dynamically is
// assigned to the STATIC chunk, so a door line for a body only a lazy chunk reads
// defeats the boundary while looking tidy. Measured, it put thirty-one modules of this
// directory and the JSON-Schema validator behind them on the document every session
// downloads, whether or not a form was ever drawn.
//
// So the seats door publishes `schema-form-mounts.ts` instead, and that module reaches
// this one through `import()` and through nothing else. This module is therefore the
// bundler's split point: everything only it reaches is emitted as its own chunk and
// fetched the first time a form mounts.
//
// AND THE STYLESHEET ENTERS HERE. `apps/desktop/AGENTS.md` admits a sheet through the
// barrel of the directory that OWNS it, and a directory carrying a lazily-loaded chunk
// has an owner of its own — so `schema-form.css` left the seats door with the code it
// styles and enters at this root, which is the module the chunk is rooted at. It loads
// with the first schema form and never before.
//
// WHAT IT PUBLISHES IS WHAT THE DOOR PUBLISHED, unchanged: the two composed surfaces and
// the attachment carrier's reading. `useSchemaForm`, `planSchemaForm` and
// `compileSchemaValidator` stay inside for the reason `seats/index.ts` gives — a caller
// assembling those itself would be a second answer to what a schema draws.

import "./schema-form.css";

export { SchemaFormAnswer } from "./SchemaFormAnswer.js";
export { SchemaFormPreview } from "./SchemaFormPreview.js";
export { attachmentArtifactIdsIn } from "./schema-artifact-members.js";
