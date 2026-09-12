// What a person has typed into the create form, and the one request it composes.
//
// A CLASS WITH PRIVATE FIELDS AND AN EMITTER, not a hook body: it holds edited state,
// and `apps/desktop/AGENTS.md` puts stateful logic here rather than in a render, where
// a pass React discarded would take every edit with it.
//
// EVERY MEMBER OF THE POLICY IS FIXED AT CREATION, which is what makes this form the
// only moment. V1 registers no channel-configuration mutation at all — there is no
// `channel.configUpdate` and no field on a channel is mutable once it exists — so a
// channel whose rhythm turns out wrong is replaced rather than reconfigured, and the
// form says so before a person commits rather than after.
//
// AN UNSET MEMBER IS THE SESSION'S DEFAULT AND NEVER A VALUE THE CONSOLE FILLED IN.
// `GrowthChannelConfig` is optional throughout and its absences MEAN that, so this
// draft tracks whether a member was touched rather than comparing it to a default it
// would have had to invent. Two moderation boxes left alone send no `moderation` at
// all; one of them touched sends what the form holds, because a person who unchecked
// a box has said something and a form that could not send `false` would silently keep
// the session's own gate on.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";

import type { GrowthChannelConfig } from "../bridge/index.js";
import { Emitter, type Unsubscribe } from "../core/index.js";
import type { ChannelCreateRequest } from "./channel-writes.js";
import {
  CHANNEL_MODERATION_FIELDS,
  draftSnapshotsMatch,
  readTurnCap,
  type ChannelModerationField,
  type CreateChannelDraftSnapshot,
} from "./create-channel-fields.js";

/**
 * Whether the form composes a request, or what it is still missing.
 *
 * `nameRefusal` is its own member rather than another entry in `missing`, because it
 * is a refusal AGAINST A FIELD — it marks the name box and names the reserved word —
 * while `missing` is a list of things nobody has said yet. Collapsing them would put
 * "you may not call it that" in the same sentence as "you have not chosen a name".
 */
export type CreateChannelReadiness =
  | { readonly status: "ready"; readonly request: ChannelCreateRequest }
  | {
      readonly status: "incomplete";
      readonly missing: readonly string[];
      readonly nameRefusal: string | undefined;
    };

export class CreateChannelDraft {
  readonly #changes = new Emitter<void>("create channel draft");
  #name = "";
  #turnsPerAgent = "";
  #moderation = new Map<ChannelModerationField, boolean>();

  /** Subscribe to edits. Returns an idempotent unsubscribe. */
  public onChange(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /** Everything typed right now, as the one value two moments compare by. */
  public snapshot(): CreateChannelDraftSnapshot {
    return {
      name: this.#name,
      turnsPerAgent: this.#turnsPerAgent,
      moderation: CHANNEL_MODERATION_FIELDS.map((field) => this.#moderation.get(field)),
    };
  }

  /**
   * Put the fields back, but only where nothing has been typed since `submitted`.
   *
   * WHAT A RESET AFTER A WIRE ACT IS FOR, and what it is not. Emptying the form once a
   * create settles is what makes the next one start clean, and that is only true of the
   * draft the create CONSUMED. A wire call is a round trip whose length this console does
   * not decide and the fields stay live for it — a text box that went dead mid-trip would
   * drop keystrokes a person had already committed — so a draft that has moved on since
   * the press is their next channel, and clearing it would be this surface taking work
   * away as a reward for the work it just finished.
   *
   * THE SAME RULE THE ROW OVERLAY BESIDE IT KEEPS. `channel-model.ts` applies a lifecycle
   * receipt only while the read is still the exact reading it was answered against; this
   * applies a reset only while the draft is still the exact draft that was sent.
   *
   * Answers whether it reset, so a caller can tell the two settlements apart.
   */
  public resetIfUnchangedSince(submitted: CreateChannelDraftSnapshot): boolean {
    if (!draftSnapshotsMatch(this.snapshot(), submitted)) {
      return false;
    }
    this.reset();
    return true;
  }

  /**
   * Put every field back where it started. What Cancel does, and nothing more.
   *
   * Renderer-local by definition: nothing was sent, so there is nothing to withdraw,
   * and a Cancel that reached the wire would be inventing an act the plane does not
   * have.
   */
  public reset(): void {
    this.#name = "";
    this.#turnsPerAgent = "";
    this.#moderation = new Map();
    this.#changes.emit();
  }

  public get name(): string {
    return this.#name;
  }

  public setName(value: string): void {
    this.#name = value;
    this.#changes.emit();
  }

  /** The per-agent turn cap as typed. Kept as text so a half-typed number is legible. */
  public get turnsPerAgent(): string {
    return this.#turnsPerAgent;
  }

  public setTurnsPerAgent(value: string): void {
    this.#turnsPerAgent = value;
    this.#changes.emit();
  }

  /** One moderation member, or `undefined` where nobody has touched it. */
  public moderationValue(field: ChannelModerationField): boolean | undefined {
    return this.#moderation.get(field);
  }

  public setModeration(field: ChannelModerationField, value: boolean): void {
    this.#moderation.set(field, value);
    this.#changes.emit();
  }

  /**
   * The request this draft composes, or what it is still missing.
   *
   * The session is an ARGUMENT and never a field, for the reason the attach form gives
   * about its own catalog: it is a read its owner already holds, and a copy inside the
   * draft would be a second answer to a question already asked.
   */
  public readiness(sessionId: string | undefined): CreateChannelReadiness {
    const name = this.#name.trim();
    const missing: string[] = [];
    if (sessionId === undefined) {
      missing.push("a session to create it in");
    }
    if (name === "") {
      missing.push("a name");
    }
    const nameRefusal =
      name === MAIN_CHANNEL_NAME
        ? `\`${MAIN_CHANNEL_NAME}\` is the session's own channel, and no new channel may take that name.`
        : undefined;
    if (readTurnCap(this.#turnsPerAgent) === "unreadable") {
      missing.push("a whole number of turns per agent, or none at all");
    }
    if (missing.length > 0 || nameRefusal !== undefined || sessionId === undefined) {
      return { status: "incomplete", missing, nameRefusal };
    }
    const config = this.#config();
    return {
      status: "ready",
      request: config === undefined ? { sessionId, name } : { sessionId, name, config },
    };
  }

  /**
   * What the form actually collected, or `undefined` where it collected nothing.
   *
   * `turnsPerAgent` leaves only where it reads as a number: the unreadable arm is
   * refused at readiness above, so there is no arm on which this sends a cap the person
   * did not type.
   */
  #config(): GrowthChannelConfig | undefined {
    const turnsPerAgent = readTurnCap(this.#turnsPerAgent);
    const moderation = this.#moderationConfig();
    const config: GrowthChannelConfig = {
      ...(moderation === undefined ? {} : { moderation }),
      ...(typeof turnsPerAgent === "number" ? { turnsPerAgent } : {}),
    };
    return Object.keys(config).length === 0 ? undefined : config;
  }

  #moderationConfig(): GrowthChannelConfig["moderation"] {
    if (this.#moderation.size === 0) {
      return undefined;
    }
    const preTurnGate = this.#moderation.get("preTurnGate");
    const postTurnReview = this.#moderation.get("postTurnReview");
    return {
      ...(preTurnGate === undefined ? {} : { preTurnGate }),
      ...(postTurnReview === undefined ? {} : { postTurnReview }),
    };
  }
}
