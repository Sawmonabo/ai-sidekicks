// A document read for its font set, which every window's document has and the unit tier's DOM
// shim does not.

/** A document whose `fonts` may be absent, as it is under the unit tier's DOM shim. */
export interface FontLoadingDocument {
  readonly fonts?: FontFaceSet;
}
