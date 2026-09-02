// The command zone's door.
//
// One of the composer's zones, and the one that answers the reserved slash prefix:
// what a typed `/name` runs, and what the bound provider offers for discovery beside
// it. The host mounts the popover and nothing else, so that is what leaves through
// here — the recognizer, the executor, and the catalog model are reached deeply from
// inside this zone, which is what a barrel is for.
//
// The executor and its two types DO leave, because the send controller's optional
// `commandExecutor` dependency is a seam across zones: the router zone holds the
// controller and this zone holds what plugs into it. They carry the dead-code gate's
// one exemption on the terms `apps/desktop/AGENTS.md` sets — a `@consumedBy` tag on
// the barrel specifier naming the task that imports them — because the controller
// side of the seam lands in the same family and not in this commit. The tag and the
// comment are deleted together by the change that wires them.
//
// The stylesheet is imported here so it arrives on the zone's one edge, the same rule
// every other family's door follows.

import "./provider-command-autocomplete.css";

export { ProviderCommandAutocomplete } from "./ProviderCommandAutocomplete.js";

export {
  /** @consumedBy T-023p-1C-3 */
  createClientCommandExecutor,
  /** @consumedBy T-023p-1C-3 */
  type ClientCommandExecutor,
} from "./client-command-executor.js";
export type {
  /** @consumedBy T-023p-1C-3 */
  CommandOutcome,
  /** @consumedBy T-023p-1C-3 */
  DirectiveLine,
} from "./client-command-recognizer.js";
