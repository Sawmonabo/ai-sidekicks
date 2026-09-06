// The seam between a command that reads its line and the executor that runs it.
//
// ITS OWN MODULE BECAUSE BOTH SIDES NEED IT, AND EACH IMPORTS THE OTHER. The executor
// reaches the accelerator to build the handler map for one composer, and the
// accelerator reaches this contract to declare what it returns. Declaring the
// contract in the executor closed that loop — a cycle `structure:layering` fails —
// and the remedy the repo's own rule names for two sides of one seam is the shared
// module rather than a duplicated type: one map shape, read the same way by the
// producer and the consumer, so neither can drift into a shape the other refuses.

import type { CommandOutcome, DirectiveLine } from "../router/command-executor.js";

/**
 * A command that reads arguments off the line it was typed on.
 *
 * The registry's `run()` takes nothing, because the registry is keyed for a PALETTE,
 * where there is no line — so a command whose act depends on what follows its name
 * cannot be performed through `invoke` at all. This map is where such a command is
 * reached instead, keyed by the same id the registry holds it under, so recognition,
 * the palette entry, and the keyboard page all keep naming one command.
 *
 * IT DOES NOT WIDEN RECOGNITION. A handler for an id the registry does not hold is
 * unreachable: the recogniser answers first and refuses the name. That ordering is
 * deliberate — a second registry that could claim a name the console has never heard
 * of is the thing `client-command-recognizer.ts` exists to prevent.
 */
export type DirectiveLineHandlers = ReadonlyMap<
  string,
  (line: DirectiveLine) => Promise<CommandOutcome>
>;

/**
 * No argument-reading command, for an executor built where a LINE never exists.
 *
 * The discovery popover runs a command a person PICKED out of a list, and a picked
 * entry carries no typed argument — so an argument-reading command reached from there
 * takes its palette act, which is the same act the palette entry itself performs.
 * Declared once rather than composed at each such site, so no caller mints a second
 * empty map and none of them can accidentally mint a non-empty one.
 */
export const NO_DIRECTIVE_LINE_HANDLERS: DirectiveLineHandlers = new Map();
