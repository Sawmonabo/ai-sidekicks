// The WebAuthn ceremony seam's sub-module door.
//
// ONE SYMBOL, and it is the WRITER. A door exists here because a sibling inside this
// family reads from it: `fixture/` encodes a scripted ceremony resolution, and it is
// the only module in the console that ever writes one. Everything the sign-in family
// takes — the reader and the vocabularies — reaches it through `bridge/index.ts`,
// which re-exports from the module that DECLARES each symbol rather than through this
// inner barrel, so a line here for any of them would be a specifier no module
// resolves and the barrel census reports rather than tolerates.

export { encodeCeremonyResolution } from "./ceremony-resolution.js";
