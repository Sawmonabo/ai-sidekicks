// The directive line: what the input SAYS, and what walking its history does.
//
// `Spec-023 §Console Design (Meridian)` gives the line two jobs beyond holding text.
// It is ADDRESSED — the placeholder names the target, so a person reading nothing
// else still knows where their sentence is going — and it is WALKABLE: ArrowUp and
// ArrowDown at the edge offsets recall this participant's sent messages, guarded so
// that a walk never destroys an unsent draft.
//
// The recall is stateful, so it is a class with private fields. The two derivations
// are pure, so they are functions: the placeholder is a projection of the target and
// the path label is a projection of the router's own resolution, which is what keeps
// the label from being a second guess beside the decision it describes.
//
// EDGE OFFSETS, NOT BARE ARROW KEYS. A person editing the middle of a long message
// presses ArrowUp to move up a line, and a composer that hijacked it would eat their
// caret movement. So recall is offered only when the caret is at the very start
// (older) or the very end (newer) of the text, which is the one position where the
// arrow has nothing else to do.

import { COMPOSER_HISTORY_RECALL_CAP, COMPOSER_RETAINED_ADDRESS_CAP } from "../composer-bounds.js";
import type { ComposerTarget } from "../chips/chip-models.js";
import type { ComposerSendResolution } from "./send-resolutions.js";

/** The two path labels the line renders under itself. Closed; derived union. */
export const DIRECTIVE_PATH_LABELS = ["new turn", "steer"] as const;

/** One path label. Derived from the enumeration, never restated. */
export type DirectivePathLabel = (typeof DIRECTIVE_PATH_LABELS)[number];

/**
 * The placeholder, addressed to the target.
 *
 * Every name in it is wire-verbatim or absent. An agent whose name has not been read
 * is "the agent" rather than its opaque id: an id in a placeholder is an internal
 * handle in operator-facing copy, and a person cannot act on one.
 *
 * THE CHANNEL ARM BRANCHES ON THE ID BEFORE THE LABEL. Falling through an unread
 * label to "Message this session" wrote the UNADDRESSED sentence over an addressed
 * send: the message goes to the channel the pane names, and the line said it was
 * going to the session's own default. Two destinations, one sentence, and the one it
 * stated was the one not happening.
 */
export function composeDirectivePlaceholder(target: ComposerTarget): string {
  if (target.path === "provider-bound") {
    return `Steer ${target.agentName ?? "the agent"}'s running turn`;
  }
  if (target.channelLabel !== undefined) {
    return `Message ${target.channelLabel}`;
  }
  return target.channelId === undefined
    ? "Message this session"
    : "Message this channel, name not read";
}

/**
 * The path label, or `undefined` when this text resolves to no send at all.
 *
 * Derived from the RESOLUTION rather than from the target, because the two can
 * disagree: text addressed to a running turn that carries no read comparand
 * resolves to a refusal, and labelling it "steer" would promise a send the router
 * has already declined to make.
 */
export function directivePathLabel(
  resolution: ComposerSendResolution,
): DirectivePathLabel | undefined {
  switch (resolution.outcome) {
    case "new-turn":
      return "new turn";
    case "steer":
      return "steer";
    case "client-command":
    case "refused":
      return undefined;
  }
}

/** Where the caret sits, which is what decides whether an arrow recalls. */
export interface DirectiveCaret {
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly textLength: number;
}

/** True when the caret is collapsed at the very start of the text. */
export function caretAtStart(caret: DirectiveCaret): boolean {
  return caret.selectionStart === 0 && caret.selectionEnd === 0;
}

/** True when the caret is collapsed at the very end of the text. */
export function caretAtEnd(caret: DirectiveCaret): boolean {
  return caret.selectionStart === caret.textLength && caret.selectionEnd === caret.textLength;
}

/**
 * This participant's sent messages, walkable, draft-guarded.
 *
 * The guard is the whole design: the text a person had typed before they started
 * walking is STASHED on the first recall and restored when they walk back past the
 * newest entry. Without it, one ArrowUp on a half-written message destroys it and
 * there is nowhere to get it back from — the ledger holds what was sent, and this
 * was not sent.
 *
 * The list is bounded at `COMPOSER_HISTORY_RECALL_CAP` and holds only what this
 * window has seen this session. It is renderer-local and never persisted:
 * `console/persistence/draft-store.ts` states why participant-authored text does not
 * reach durable storage, and a recall list is the same class of content.
 */
export class DirectiveHistory {
  /** Newest first, so index 0 is the message most recently sent. */
  readonly #sentNewestFirst: string[] = [];
  /** `-1` while not walking; otherwise the index into the list above. */
  #recallIndex = -1;
  #stashedDraft = "";

  /** True while a walk is in progress, so the surface can mark the line as recalled. */
  public get isRecalling(): boolean {
    return this.#recallIndex >= 0;
  }

  /** How many messages are walkable. Bounded by the cap; read by tests and the surface. */
  public get recallableCount(): number {
    return this.#sentNewestFirst.length;
  }

  /**
   * Record one sent message and end any walk in progress.
   *
   * Recording ends the walk because the walk's anchor — the stashed draft — has just
   * been sent. Keeping the index would leave a later ArrowDown restoring text that is
   * now in the ledger, which reads as the composer duplicating a message.
   *
   * What is recorded is the message VERBATIM. Trimming here would be a transform in
   * the one place it looks harmless: a recalled message is text a person sends
   * again, so a list that stored a trimmed copy would quietly reintroduce, one
   * ArrowUp later, exactly the loss of indentation the router refuses to perform.
   */
  public recordSent(text: string): void {
    if (text.trim().length === 0) {
      return;
    }
    this.#sentNewestFirst.unshift(text);
    if (this.#sentNewestFirst.length > COMPOSER_HISTORY_RECALL_CAP) {
      this.#sentNewestFirst.length = COMPOSER_HISTORY_RECALL_CAP;
    }
    this.reset();
  }

  /**
   * Walk one message older, or `undefined` when there is nothing older to reach.
   *
   * `currentText` is stashed on the FIRST step only, so walking three messages back
   * and forward again returns the person's own unsent text rather than the message
   * they passed through on the way.
   */
  public recallOlder(currentText: string): string | undefined {
    if (this.#recallIndex + 1 >= this.#sentNewestFirst.length) {
      return undefined;
    }
    if (this.#recallIndex === -1) {
      this.#stashedDraft = currentText;
    }
    this.#recallIndex += 1;
    return this.#sentNewestFirst[this.#recallIndex];
  }

  /**
   * Walk one message newer, or back to the stashed draft.
   *
   * `undefined` means the walk was not in progress, so the arrow belongs to the
   * caret and not to this class.
   */
  public recallNewer(): string | undefined {
    if (this.#recallIndex < 0) {
      return undefined;
    }
    this.#recallIndex -= 1;
    if (this.#recallIndex < 0) {
      const stashed = this.#stashedDraft;
      this.#stashedDraft = "";
      return stashed;
    }
    return this.#sentNewestFirst[this.#recallIndex];
  }

  /** End the walk without changing what is in the line. */
  public reset(): void {
    this.#recallIndex = -1;
    this.#stashedDraft = "";
  }
}

/**
 * One recall history per composer address, so a walk never crosses a rebinding.
 *
 * The composer is rebound rather than remounted when a person moves between agents
 * and channels, and a single history for the life of the mounted bar carried the
 * whole of one address's sent messages — and any walk in progress — into the next.
 * ArrowUp under the new target copied participant-authored text written for the old
 * one into the line, and ArrowDown restored a draft stashed before the switch.
 *
 * A MAP RATHER THAN A RESET. Coming back to an address and finding its own history
 * intact is what a person expects; a reset on every rebinding would have destroyed
 * it to fix a leak between addresses. What a map costs is growth, so the retained
 * addresses are bounded and the least recently addressed is evicted — the histories
 * are per window and never persisted, and unbounded growth is a budget failure.
 *
 * THE CURSOR IS AT REST FOR AN ADDRESS THAT HAS JUST BECOME CURRENT. Walking is a
 * gesture within one line; a switch away and back cannot land mid-walk, so becoming
 * current resets the walk without touching what the address has sent.
 */
export class AddressedDirectiveHistories {
  /** Insertion order is the recency order the eviction reads. */
  readonly #byAddress = new Map<string, DirectiveHistory>();
  #currentAddress: string | undefined = undefined;

  /** How many addresses are retained. Bounded by the cap; read by tests. */
  public get retainedAddressCount(): number {
    return this.#byAddress.size;
  }

  /**
   * The history for this address, made current.
   *
   * Idempotent for an address that is already current, so a caller free to ask on
   * every render neither re-orders the map nor disturbs a walk in progress.
   */
  public forAddress(address: string): DirectiveHistory {
    const existing = this.#byAddress.get(address);
    const history = existing ?? new DirectiveHistory();
    if (existing !== undefined) {
      // Re-inserted so the map's own iteration order stays the recency order the
      // eviction below reads, rather than a separate list that could disagree.
      this.#byAddress.delete(address);
    }
    this.#byAddress.set(address, history);
    if (this.#currentAddress !== address) {
      this.#currentAddress = address;
      history.reset();
    }
    this.#evictBeyondCap();
    return history;
  }

  /** Drop the least recently addressed histories past the retained-address cap. */
  #evictBeyondCap(): void {
    while (this.#byAddress.size > COMPOSER_RETAINED_ADDRESS_CAP) {
      const leastRecent = this.#byAddress.keys().next();
      if (leastRecent.done === true) {
        return;
      }
      this.#byAddress.delete(leastRecent.value);
    }
  }
}
