// The contract the send bar consumes, and the object the controller is built from.
//
// Split from `send-controller.ts` because it is a different job: that module holds
// the hook that FULFILS this, and this holds what the surface may ask of it. The
// split is what keeps either file readable, and it is what lets a component take the
// controller's type without importing the hook — a seat that renders a controller
// somebody else built has no reason to pull in a `useState` chain to do it.
//
// EVERY DEPENDENCY IS ONE OBJECT, so a new one is one edit rather than one at each
// call site, and the three optional members travel together for a reason each states.

import type { ConsoleBridge } from "../../../console/bridge/index.js";
import type { ConsoleRefusal } from "../../../console/core/index.js";
import type { DraftStore } from "../../../console/persistence/index.js";
import type { ComposerTarget } from "../chips/chip-models.js";
import type { CommandExecutor } from "./command-executor.js";
import type { DirectiveCaret, DirectivePathLabel } from "./directive-line.js";
import type { ClientCommandPredicate, ProviderCommandPredicate } from "./send-resolutions.js";

/** Whether the line is accepting text or is locked behind an in-flight dispatch. */
export type SendControllerStatus = "idle" | "sending";

/** What the composer is built from. One object, so a new dependency is one edit. */
export interface SendControllerDependencies {
  readonly bridge: ConsoleBridge;
  readonly target: ComposerTarget;
  /** The window-lifetime draft store the composer seat is handed. */
  readonly draftStore: DraftStore;
  /**
   * Whether a name is a registered client command.
   *
   * Travels with the executor because the two are one decision split in half: the
   * router will not intercept a name nothing claims, so a recogniser without an
   * executor intercepts into a refusal and an executor without a recogniser is
   * never called. The composer's command zone supplies both or neither.
   */
  readonly recognizeClientCommand?: ClientCommandPredicate | undefined;
  /**
   * Whether a name is one the bound provider published, for discovery only.
   *
   * Supplied by the same zone and read off the same holder the discovery popover
   * renders from, so a name the list showed and a name the send path recognises are
   * one reading. Absent, a typed provider command refuses exactly as it did before
   * the two zones shared one.
   */
  readonly recognizeProviderCommand?: ProviderCommandPredicate | undefined;
  /**
   * Runs a recognised client command, when this composer has one to run with.
   *
   * Optional because the command family is a separate zone that mounts its own
   * recogniser and executor together. Absent, an intercepted line REFUSES: the
   * router only intercepts a name a recogniser claimed, so reaching this arm with
   * no executor means the two halves were wired apart, and clearing the line would
   * report success for an act nothing performed.
   */
  readonly commandExecutor?: CommandExecutor | undefined;
}

/** Everything the send bar renders and every act it offers. */
export interface SendController {
  readonly text: string;
  readonly placeholder: string;
  /** "new turn" or "steer", or `undefined` when this text resolves to no send. */
  readonly pathLabel: DirectivePathLabel | undefined;
  readonly status: SendControllerStatus;
  /**
   * Whether an interrupt is in flight, so the surface can mark Stop busy.
   *
   * Its own reading rather than a second value of {@link status}: a stop and a send
   * can be in flight at once, and one status could not say so.
   */
  readonly isStopping: boolean;
  /** The last refusal, composer-side or daemon-side, until the person types again. */
  readonly refusal: ConsoleRefusal | undefined;
  /**
   * The most recent message sent to THIS address, so a tripped run can be resent
   * without retyping. `undefined` once the composer is re-addressed, because a body
   * written for one target is not an offer to send it to another.
   */
  readonly resendableText: string | undefined;
  /**
   * The store's restart disclosure, while it is armed and there is text to lose.
   *
   * The sentence is the store's own — fixed text carrying no participant content —
   * so the composer renders what the store says rather than a second wording of it.
   */
  readonly restartNotice: string | undefined;
  changeText(next: string): void;
  send(): Promise<void>;
  /** Send one exact body again. The tripwire card's offer; never a silent retry. */
  resend(body: string): Promise<void>;
  stop(): Promise<void>;
  /** Walk one message older. `false` when the caret is not at the start edge. */
  recallOlder(caret: DirectiveCaret): boolean;
  /** Walk one message newer. `false` when the caret is not at the end edge. */
  recallNewer(caret: DirectiveCaret): boolean;
  /** Called when the line takes focus, which is what arms the disclosure. */
  acknowledgeRestartNotice(): void;
}
