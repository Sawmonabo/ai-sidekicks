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
//
// A `direct` CHANNEL CARRIES NO POLICY, AND THE REQUEST IS WHERE THAT IS ENFORCED.
// The wire's own validation couples the kind to the pair — a direct channel requires
// exactly two distinct humans and refuses every agent-turn member, a general one
// refuses the pair — so the direct arm composes a request with no `config` member at
// all rather than one carrying an audience the daemon would have to reject. The form
// above draws no such field either; this is the second half of the same rule, stated
// where a request is built.
//
// AND THE PAIR IS CANONICALIZED BEFORE IT IS SENT. The two ids are sorted, so the
// pair a form composes does not depend on who was picked first: order carries no
// meaning on this wire, and two orderings of one pair would read as two channels.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";

import type {
  GrowthChannelAudience,
  GrowthChannelConfig,
  GrowthChannelKind,
  GrowthChannelTurnPolicy,
} from "../../bridge/index.js";
import { Emitter, type Unsubscribe } from "../../core/index.js";
import type { ChannelCreateRequest } from "./channel-writes.js";

/**
 * The moderation members a person can touch, declared once.
 *
 * The tuple is what the form iterates and the union is what the draft keys its
 * touched set on, so a third moderation member arrives in both places or in neither.
 */
export const CHANNEL_MODERATION_FIELDS = ["preTurnGate", "postTurnReview"] as const;

/** One moderation member. Derived from the tuple, never restated. */
export type ChannelModerationField = (typeof CHANNEL_MODERATION_FIELDS)[number];

/**
 * Whether the form composes a request, or what it is still missing.
 *
 * `nameRefusal` is its own member rather than another entry in `missing`, because it
 * is a refusal AGAINST A FIELD — it marks the name box and names the reserved word —
 * while `missing` is a list of things nobody has said yet. Collapsing them would put
 * "you may not call it that" in the same sentence as "you have not chosen anybody".
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
  #kind: GrowthChannelKind = "general";
  // The one policy member the form opens with a value in: the empty state is
  // `general` with audience `participants`, so the draft holds that rather than
  // leaving the reader to infer it from an unset select.
  #audience: GrowthChannelAudience | undefined = "participants";
  #turnPolicy: GrowthChannelTurnPolicy | undefined;
  #roundRobinOrder = "";
  #turnsPerAgent = "";
  #moderation = new Map<ChannelModerationField, boolean>();
  #otherParticipantId: string | undefined;

  /** Subscribe to edits. Returns an idempotent unsubscribe. */
  public onChange(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Put every field back where it started. What Cancel does, and nothing more.
   *
   * Renderer-local by definition: nothing was sent, so there is nothing to withdraw,
   * and a Cancel that reached the wire would be inventing an act the plane does not
   * have. The audience returns to `participants` because that is the form's empty
   * state rather than an absence.
   */
  public reset(): void {
    this.#name = "";
    this.#kind = "general";
    this.#audience = "participants";
    this.#turnPolicy = undefined;
    this.#roundRobinOrder = "";
    this.#turnsPerAgent = "";
    this.#moderation = new Map();
    this.#otherParticipantId = undefined;
    this.#changes.emit();
  }

  public get name(): string {
    return this.#name;
  }

  public setName(value: string): void {
    this.#name = value;
    this.#changes.emit();
  }

  public get kind(): GrowthChannelKind {
    return this.#kind;
  }

  /**
   * Choose the kind.
   *
   * The policy entries are LEFT STANDING when the kind moves to `direct` rather than
   * dropped: they are not sent on that arm, so nothing composed from them can reach
   * the daemon, and a person who tries `direct` and comes back should not find the
   * turn policy they chose two minutes ago quietly gone.
   */
  public setKind(value: GrowthChannelKind): void {
    this.#kind = value;
    this.#changes.emit();
  }

  public get audience(): GrowthChannelAudience | undefined {
    return this.#audience;
  }

  public setAudience(value: GrowthChannelAudience | undefined): void {
    this.#audience = value;
    this.#changes.emit();
  }

  public get turnPolicy(): GrowthChannelTurnPolicy | undefined {
    return this.#turnPolicy;
  }

  public setTurnPolicy(value: GrowthChannelTurnPolicy | undefined): void {
    this.#turnPolicy = value;
    this.#changes.emit();
  }

  /** The round-robin order as typed: identifiers separated by commas. */
  public get roundRobinOrder(): string {
    return this.#roundRobinOrder;
  }

  public setRoundRobinOrder(value: string): void {
    this.#roundRobinOrder = value;
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

  /** The other human in a `direct` pair, as picked. */
  public get otherParticipantId(): string | undefined {
    return this.#otherParticipantId;
  }

  public setOtherParticipantId(value: string | undefined): void {
    this.#otherParticipantId = value;
    this.#changes.emit();
  }

  /**
   * The request this draft composes, or what it is still missing.
   *
   * The session and the viewer are ARGUMENTS and never fields, for the reason the
   * attach form gives about its own catalog: both are reads their owner already
   * holds, and a copy inside the draft would be a second answer to a question already
   * asked. An unread viewer is passed as the `undefined` it is and the direct arm
   * fails closed — a pair composed from a caller identity nobody established would
   * put two people in a room neither of them chose.
   */
  public readiness(
    sessionId: string | undefined,
    viewerParticipantId: string | undefined,
  ): CreateChannelReadiness {
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
    const turnsPerAgent = readTurnCap(this.#turnsPerAgent);
    if (this.#kind === "general" && turnsPerAgent === "unreadable") {
      missing.push("a whole number of turns per agent, or none at all");
    }
    if (this.#kind === "direct") {
      if (this.#otherParticipantId === undefined) {
        missing.push("the other person in the pair");
      }
      if (viewerParticipantId === undefined) {
        missing.push("which participant this window is");
      }
    }
    if (missing.length > 0 || nameRefusal !== undefined || sessionId === undefined) {
      return { status: "incomplete", missing, nameRefusal };
    }
    return { status: "ready", request: this.#request(sessionId, viewerParticipantId, name) };
  }

  #request(
    sessionId: string,
    viewerParticipantId: string | undefined,
    name: string,
  ): ChannelCreateRequest {
    if (this.#kind === "direct") {
      return {
        sessionId,
        name,
        kind: "direct",
        // Both members are present by the readiness check above; the pair is built
        // from them in canonical order and carries no policy at all.
        memberPair: canonicalMemberPair(this.#otherParticipantId ?? "", viewerParticipantId ?? ""),
      };
    }
    const config = this.#config();
    return config === undefined
      ? { sessionId, name, kind: "general" }
      : { sessionId, name, kind: "general", config };
  }

  /** What the form actually collected, or `undefined` where it collected nothing. */
  #config(): GrowthChannelConfig | undefined {
    const roundRobinOrder = readIdentifierList(this.#roundRobinOrder);
    const turnsPerAgent = readTurnCap(this.#turnsPerAgent);
    const moderation = this.#moderationConfig();
    const config: GrowthChannelConfig = {
      ...(this.#turnPolicy === undefined ? {} : { turnPolicy: this.#turnPolicy }),
      ...(roundRobinOrder === undefined ? {} : { roundRobinOrder }),
      ...(moderation === undefined ? {} : { moderation }),
      ...(this.#audience === undefined ? {} : { audience: this.#audience }),
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

/**
 * The two ids in canonical order.
 *
 * Sorted rather than kept as picked, because the pair is a membership and not a
 * sequence: nothing on this wire reads position, so two orderings of one pair are one
 * channel described twice.
 */
export function canonicalMemberPair(
  firstParticipantId: string,
  secondParticipantId: string,
): readonly [string, string] {
  return firstParticipantId <= secondParticipantId
    ? [firstParticipantId, secondParticipantId]
    : [secondParticipantId, firstParticipantId];
}

/** The typed list, or `undefined` where nothing was typed. Blank entries are dropped. */
function readIdentifierList(typed: string): readonly string[] | undefined {
  const entries = typed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.length === 0 ? undefined : entries;
}

/**
 * The typed cap: a positive whole number, nothing at all, or a value that is neither.
 *
 * The third arm is why this answers a union rather than `number | undefined`. A field
 * holding `two` is not the same fact as an empty one — the first is something a
 * person meant and the console could not read, and sending the session's default for
 * it would silently discard what they asked for.
 */
function readTurnCap(typed: string): number | undefined | "unreadable" {
  const trimmed = typed.trim();
  if (trimmed === "") {
    return undefined;
  }
  return /^[1-9][0-9]*$/.test(trimmed) ? Number(trimmed) : "unreadable";
}
