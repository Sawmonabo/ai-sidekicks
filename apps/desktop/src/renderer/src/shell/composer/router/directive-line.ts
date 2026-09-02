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

import { COMPOSER_HISTORY_RECALL_CAP } from "../composer-bounds.js";
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
 */
export function composeDirectivePlaceholder(target: ComposerTarget): string {
  if (target.path === "provider-bound") {
    return `Steer ${target.agentName ?? "the agent"}'s running turn`;
  }
  const channel = target.channelLabel;
  return channel === undefined ? "Message this session" : `Message ${channel}`;
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
   */
  public recordSent(text: string): void {
    const body = text.trim();
    if (body.length === 0) {
      return;
    }
    this.#sentNewestFirst.unshift(body);
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
