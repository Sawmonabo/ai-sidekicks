// The handoff's door, for the sibling directory on the other end of it.
//
// A SUB-MODULE DOOR AND NOT A FAMILY ONE. `definitions/` and `attach/` are two
// directories of one family, and this package's structure rule gives a sub-module
// directory a door exactly when a sibling takes from it — which is the case here and
// is the whole reason the handoff is a module directory rather than a file: it has
// two ends, and one of them is not in `attach/`.
//
// WHAT IS PUBLISHED IS WHAT THE TWO ENDS TAKE, and nothing for symmetry. The handoff
// class and the per-bridge resolver stay off it: a surface reaching for either would
// be holding the handoff across renders, which is exactly what the two hooks exist to
// stop it doing. `AttachHandoffOffer` stays off it too — the offering side writes an
// object literal and the type travels through the control it is a member of, so a door
// line for it would be a line no production module reads.

export {
  useAttachHandoff,
  useAttachHandoffClaim,
  type AttachHandoffControl,
} from "./attach-handoff-feed.js";
