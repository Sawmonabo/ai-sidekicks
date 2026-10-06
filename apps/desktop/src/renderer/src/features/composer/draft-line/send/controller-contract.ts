// The contract the send bar consumes and the object the controller is built from. Split from
// `hooks/useSendController.ts` so a component can take the controller's type without importing
// the hook.

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import type { DraftStore } from "#renderer/store/drafts.js";
import type { ComposerTarget } from "../../target.js";
import type { CommandExecutor } from "../../types.js";
import type { DraftCaret } from "../caret.js";
import type { ComposerSendCalls } from "./dispatch.js";
import type { ConsoleCommandPredicate } from "./resolutions.js";

/** Whether the line is accepting text or is locked behind an in-flight dispatch. */
export type SendControllerStatus = "idle" | "sending";

/** Everything the controller is built from, as one object. */
export interface SendControllerDependencies {
  /** Keys the composer's held state; nothing here calls through it. */
  readonly bridge: PlatformBridge;
  readonly calls: ComposerSendCalls;
  readonly target: ComposerTarget;
  readonly draftStore: DraftStore;
  /**
   * Whether a name is a registered console command. Supplied with `commandExecutor` by the
   * command zone: a recognizer without an executor intercepts into a refusal.
   */
  readonly recognizeConsoleCommand?: ConsoleCommandPredicate | undefined;
  /**
   * Runs a recognized console command. Absent, an intercepted line refuses, since clearing the
   * line would report success for an act nothing performed.
   */
  readonly commandExecutor?: CommandExecutor | undefined;
}

/** Everything the send bar renders and every act it offers. */
export interface SendController {
  readonly status: SendControllerStatus;
  /** The last refusal, composer-side or daemon-side, until the next act settles. */
  readonly refusal: Refusal | undefined;
  /** Send the draft. Never rejects: a rejected call settles as the held refusal. */
  send(): Promise<void>;
  /** Walk one message older. `false` when the caret is not at the start edge. */
  recallOlder(caret: DraftCaret): boolean;
  /** Walk one message newer. `false` when the caret is not at the end edge. */
  recallNewer(caret: DraftCaret): boolean;
}
