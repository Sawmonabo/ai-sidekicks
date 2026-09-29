// The file-restore disclosure's chunk root: the one module a lazy `import()` names.
//
// Nothing on a first paint is a restore, so the disclosure loads behind a dynamic import.
// Named `Body` because `components/LazyBody/lazy-body.ts` fixes the export name a loader resolves.

/**
 * The disclosure under the name a lazy body loader resolves.
 *
 * @consumedBy the composer's undo readout
 */
export { FileRestoreDisclosure as Body } from "./FileRestoreDisclosure.js";
