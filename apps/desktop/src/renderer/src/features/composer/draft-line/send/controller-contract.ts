// The contract the send bar consumes and the object the controller is built from. Split from
// `hooks/useSendController.ts` so a component can take the controller's type without importing
// the hook.

import type { Clock } from "#renderer/lib/clock.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import type { DraftStore } from "#renderer/store/drafts.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import type { ComposerHeldDraft } from "../../held-draft/holder.js";
import type { ComposerTarget } from "../../target.js";
import type { CommandExecutor } from "../../types.js";
import type { DraftCaret } from "../caret.js";
import type { ComposerSendCalls } from "./dispatch.js";
import type { ConsoleCommandPredicate } from "./resolutions.js";

/** Whether the line is accepting text or is locked behind an in-flight dispatch. */
export type SendControllerStatus = "idle" | "sending";

/** Where the message line's caret stands, and how it is put back. */
export interface DraftLineCaret {
  /** The caret as it stands, or `undefined` while no line is drawn. */
  read(): DraftCaret | undefined;
  /** Focus the line and put the caret at `caret` once the line holds the words written back. */
  place(caret: DraftCaret): void;
}

/** Everything the controller is built from, as one object. */
export interface SendControllerDependencies {
  /** Keys the composer's held state; nothing here calls through it. */
  readonly bridge: PlatformBridge;
  readonly calls: ComposerSendCalls;
  readonly target: ComposerTarget;
  readonly draftStore: DraftStore;
  /** What rides with the words, taken at the press and put back if the send comes back. */
  readonly heldDraft: ComposerHeldDraft;
  /** The session the composer sends into, whose transcript draws each message from the press. */
  readonly sessionStore: SessionStore;
  /** The clock a message's time and a failed send's are read from. */
  readonly clock: Clock;
  /** The session's lead's provider's name, which a message refused as too long names. */
  readonly providerName: string | undefined;
  /** The line's caret, taken at the press and put back if the send comes back. */
  readonly lineCaret: DraftLineCaret;
  /** Hands a failed send's refusal to the frame, which raises a banner for one that takes one. */
  readonly raiseRefusalBanner: (refusal: Refusal) => void;
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
  /**
   * The last refusal a command or a file's copy raised, or the composer's own, until the next act
   * settles. A message that failed is no refusal here: it comes back into the line, and its line
   * stands in the transcript.
   */
  readonly refusal: Refusal | undefined;
  /**
   * Send the draft. Never rejects: a message's rejected call comes back as its line in the
   * transcript, and any other rejected call settles as the held refusal.
   */
  send(): Promise<void>;
  /** Walk one message older. `false` when the caret is not at the start edge. */
  recallOlder(caret: DraftCaret): boolean;
  /** Walk one message newer. `false` when the caret is not at the end edge. */
  recallNewer(caret: DraftCaret): boolean;
}
