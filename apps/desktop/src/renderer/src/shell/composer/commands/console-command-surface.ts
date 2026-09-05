// The composer's view of the console's command registry: what it may offer, and
// what it may run.
//
// WHY THE COMPOSER NEEDS ONE AT ALL. `send-router.ts` takes a
// `ClientCommandPredicate` whose default answers `false` for every name, so a
// composer with no surface behind it refuses every `/name` a person types. That is
// the fail-loud default and it is correct as a default — but shipped alone it makes
// the reserved `/` prefix a prefix that reserves nothing, which is the state this
// module ends.
//
// WHY THE REGISTRY IS DEEP-IMPORTED. `consoleCommands` is the frame family's
// window-scoped registry and the frame's barrel publishes only `ConsoleRoot` and the
// token installation. The precedent is in-tree and reasoned the same way:
// `test/console/surfaces/composer.tsx` deep-imports `frame/run-lifecycle-projector.js`
// "rather than taken off the frame barrel, which does not publish it", because a
// consumer that built its own would be a second answer to a question one module
// already owns. Building a second registry here would be exactly that: a person's
// `/frame.goToSettings` would reach a list the palette has never heard of.
//
// WHY THE `when` CONTEXT IS TYPED RATHER THAN SPELLED. Eligibility in the palette is
// a `when` clause over `FRAME_WHEN_CLAUSE_KEYS`, and a clause naming a key the
// context does not carry evaluates FALSE. So a composer that hand-wrote five of six
// keys would silently hide whichever command used the sixth. The context below is
// typed as `FrameWhenClauseContext`, which is derived from that tuple — a key added
// to the frame's vocabulary is a compile error here rather than a command that
// quietly stops being offered.

import type { CommandRegistry, ConsoleCommand } from "../../../console/palette/index.js";
import { isAuxiliaryRoute, type ConsoleRoute } from "../../../console/routing/index.js";
import {
  consoleCommands,
  type FrameWhenClauseContext,
} from "../../../console/frame/command-surface.js";

/**
 * What the registry answers when a caller asks it to run something.
 *
 * Derived from the registry's own method rather than restated: the three arms are
 * the registry's closed vocabulary, and a fourth added there would reach every
 * consumer of this type as a compile error instead of an unhandled arm.
 */
export type ConsoleCommandInvocationOutcome = ReturnType<CommandRegistry["invoke"]>;

/**
 * The narrow face of the console's command list the composer reads and acts through.
 *
 * TWO READINGS, AND THEY ANSWER TWO QUESTIONS. `offeredCommands` is what applies
 * where this composer is, which is what the discovery popover may LIST — offering a
 * command that does not apply here would be an invitation to a refusal.
 * `registeredCommandIds` is every id this window holds, visible or not, and it is
 * what a typed name is RECOGNISED against: a person who types the exact id of a
 * command that exists but does not apply here has not typed an unknown name, and
 * telling them so would send them looking for a spelling mistake they did not make.
 * Visibility still decides whether it RUNS — `invoke` is fail-closed on it — so the
 * wider recognition set costs no eligibility and buys the honest sentence.
 */
export interface ComposerCommandSurface {
  /** Every command offered where this composer is, ordered by group then title. */
  readonly offeredCommands: readonly ConsoleCommand[];
  /** Every command this window has registered, in registration order, visible or not. */
  readonly registeredCommandIds: readonly string[];
  /** Run one by id, fail-closed on visibility. Never awaits the command itself. */
  invoke(commandId: string): ConsoleCommandInvocationOutcome;
}

/**
 * Read the console's commands as this composer's route sees them.
 *
 * Built per call rather than memoised at module scope: the registry is mutated by
 * the frame's own registration effect, which runs AFTER a child mounts, so a list
 * captured once at mount would be the empty registry forever. Every caller reads it
 * at the moment a person asks — which is when the answer has to be current anyway.
 */
export function composerCommandSurface(route: ConsoleRoute): ComposerCommandSurface {
  const whenContext = composerWhenContext(route);
  return {
    offeredCommands: consoleCommands.commandsFor(whenContext),
    registeredCommandIds: consoleCommands.all().map((command) => command.id),
    invoke: (commandId: string) => consoleCommands.invoke(commandId, whenContext),
  };
}

/**
 * Where a command run from the composer would be running.
 *
 * `sessionActive` is `true` unconditionally and that is a statement rather than a
 * shortcut: the composer is a seat addressed WITHIN one session, so a composer that
 * is rendering at all is a window that has a session in hand. The frame derives the
 * same fact from its retained session id; both readings answer the same question and
 * neither can be true where the other is false.
 *
 * The three rail destinations are `false` for the same structural reason — the
 * composer is mounted under the workspace deck and does not render on the sessions
 * list, the workflows builder, or the settings pages.
 */
function composerWhenContext(route: ConsoleRoute): FrameWhenClauseContext {
  return {
    sessionActive: true,
    onSessions: false,
    onWorkspace: route.kind === "workspace",
    onWorkflows: false,
    onSettings: false,
    inAuxiliaryWindow: isAuxiliaryRoute(route),
  };
}
