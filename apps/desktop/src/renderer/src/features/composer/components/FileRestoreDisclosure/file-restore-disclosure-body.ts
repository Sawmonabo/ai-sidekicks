// The file-restore disclosure's chunk root: the one module a lazy `import()` names.
//
// Nothing on a first paint is a restore, so the disclosure loads behind a dynamic import
// and its stylesheet enters here with it rather than through the primitives door.
//
// Named `Body` because `seats/lazy-body/lazy-body.ts` fixes the export name a loader resolves.

import "./FileRestoreDisclosure.css";

/** The disclosure under the name a lazy body loader resolves. */
export { FileRestoreDisclosure as Body } from "./FileRestoreDisclosure.js";
