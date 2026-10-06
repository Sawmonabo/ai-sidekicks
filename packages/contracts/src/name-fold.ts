// The one way names are compared wherever a name must be held once: a workflow in the library, a
// pasted-token account under its provider.
import { caseFold } from "unicode-case-folding";

/**
 * A name folded the one way names are compared: Unicode's full case folding, the same on every
 * machine whatever its language, so `Straße`, `STRASSE` and `STRAẞE` are one name and the Turkish
 * dotless `ı` stays apart from `i`. A store writes this fold beside the name it keeps once.
 */
export function foldName(name: string): string {
  return caseFold(name);
}
