// The command zone's door.
//
// One of the composer's zones, and the one that answers the reserved slash prefix:
// what a typed `/name` runs, and what the bound provider offers for discovery beside
// it. One thing leaves through here — the popover the host mounts — because the
// host is the only consumer outside this zone that mounts anything.
//
// The send bar reaches `useComposerCommandZone` DEEP rather than through this door,
// the same way this zone reaches the router's executor seam deep: an intra-family
// import is a sibling reading a sibling, and routing it through a barrel would make
// this module look like the owner of a hook the send bar is the only caller of.
//
// The seam's own shapes do not leave through here either. `DirectiveLine`,
// `CommandOutcome`, and `CommandExecutor` are the router zone's declarations,
// imported by this zone rather than restated in it, and a barrel that re-exported
// another zone's types would advertise this one as their owner.
//
// The stylesheet is imported here so it arrives on the zone's one edge, the same rule
// every other family's door follows.

import "./provider-command-autocomplete.css";

export { ProviderCommandAutocomplete } from "./ProviderCommandAutocomplete.js";
