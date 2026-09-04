// The chip rail's door.
//
// One of the composer's three zones, each behind its own barrel so the lanes that
// fill them edit disjoint directories rather than one file three ways.
//
// The two chips and the addressing vocabulary behind them are NOT forwarded. The
// chips are the rail's own bodies and have exactly one mount; the vocabulary is read
// deeply by the send router and the address hook, which are this family's own.

export { ComposerChipRail } from "./ComposerChipRail.js";
