// What this playback's invite ledger holds: the rows a scenario opened with, the ones
// an act MINTED, and the state moves an act recorded on either.
//
// THE MINT AND THE READ ARE ON TWO DIFFERENT DOORS, which is the whole reason this is
// an object per bridge rather than a fold beside one of them. `invite.create` and
// `invite.revoke` are daemon calls and reach the fixture through the call door;
// `invites.list` is a growth-port operation and reaches it through the port. Without a
// holder both doors can see, the mint answered with a receipt and the ledger read a
// moment later still returned the scenario's two opening rows — so the fixture reported
// a success and then showed a ledger the invitation was not in, and the whole
// create-to-ledger transition the sent-invite surface exists for was exercised by
// nothing. Composed in `call-plane/bridge.ts` for the reason `FixtureChannelLifecycle` is:
// built inside either door, the other would be answering from a second fixture's memory
// of one session's invitations.
//
// IT RECORDS RECEIPTS RATHER THAN REQUESTS, and both halves are read for the mint.
// `InviteCreateResponse` carries `{inviteId, token, expiresAt}` and no role, while a
// ledger row's `joinMode` is REQUIRED — so the row is composed from the receipt's
// identity and expiry and the request's own join mode, which is exactly what a daemon
// would have stored. Reading the request alone would invent an id; reading the receipt
// alone would leave the ledger unable to say what the invitation grants.
//
// AND IT PARSES BOTH AGAINST THE REGISTERED SHAPES rather than reading members off
// `unknown`. A scenario scripting a mint receipt the wire could not send records
// nothing here — and it does not need a second refusal, because the call door's own
// contract assertion fails that call one layer up. The two agreeing is the point: a
// ledger that recorded loosely would hold a row from a call the caller saw reject.
//
// AGEING IS HERE AND IS THE DAEMON'S RULE, NOT ONE SCENARIO'S. `InviteState` moves
// `pending → expired` on the clock and every other state is terminal, so a row read
// past its own `expiresAt` is not pending any more whoever declared it. It lived in the
// collaboration scenario's reply while that scenario was the only one with a ledger to
// age, which made it a rule one table applied to itself: a minted row could never age,
// because the scenario cannot see the rows an act produced. Holding it here is what
// makes the rule total over the read — every row the ledger hands back, scripted or
// minted, is aged by one function at the instant the read settles.

import {
  InviteCreateResponseSchema,
  InviteCreateSchema,
  InviteRevokeResponseSchema,
} from "@ai-sidekicks/contracts";
import type { InviteState } from "@ai-sidekicks/contracts";

import { parseInstant } from "../../../core/index.js";
import type { GrowthInviteSummary } from "../../growth-values/index.js";
import type { ScenarioEngine } from "../../scenario/runtime/index.js";

/** The state the control plane gives an invitation the moment it mints one. */
const MINTED_INVITE_STATE = "pending";

/**
 * The invitations one bridge has minted and the state moves it has recorded.
 *
 * A class with private fields, on the rule every per-bridge fixture holder keeps: the
 * two tables are this playback's memory of what its own acts did, a teardown is the
 * bridge's, and a module-level holder would let two windows on two scenarios answer
 * each other's ledger reads.
 */
export class FixtureInviteLedger {
  readonly #engine: ScenarioEngine;
  /**
   * The rows this playback's mints produced, in the order they were minted.
   *
   * A LIST, because the read appends them after the scenario's own rows: a ledger is
   * what this session has sent, and an invitation minted during the window is the
   * newest thing in it. The state each one reads as is NOT here — it is the map below,
   * so one mechanism moves a minted row and a scripted one.
   */
  readonly #mintedInOrder: GrowthInviteSummary[] = [];
  /**
   * Where an act has moved a row, keyed by the invitation the act named.
   *
   * A MAP OVER EVERY ROW rather than a mutation of the minted list, because a revoke
   * addresses whichever invitation the person pressed it on — including the two the
   * scenario opened with, which this object does not hold and must not copy. Recording
   * the move rather than the row is what lets one fold answer for both.
   */
  readonly #stateByInviteId = new Map<string, InviteState>();

  public constructor(engine: ScenarioEngine) {
    this.#engine = engine;
  }

  /**
   * Record one served mint, from the request that asked for it and the receipt it got.
   *
   * Silent where either half is off-contract, which is the honest disposition rather
   * than a swallowed failure: the call door asserts the same receipt against the same
   * registry immediately after this, so such a call REJECTS and the caller is told. A
   * refusal raised here as well would be the same authoring mistake reported twice, and
   * a row recorded loosely would be a ledger entry for a call the caller saw fail.
   */
  public recordMint(request: unknown, receipt: unknown): void {
    const asked = InviteCreateSchema.safeParse(request);
    const minted = InviteCreateResponseSchema.safeParse(receipt);
    if (!asked.success || !minted.success) {
      return;
    }
    this.#mintedInOrder.push({
      inviteId: minted.data.inviteId,
      state: MINTED_INVITE_STATE,
      // The RECEIPT's expiry and not the request's. The two agree on every mint this
      // console makes, and the receipt is the one the control plane decided: a daemon
      // that clamped a caller's expiry answers with the clamped one, and a ledger built
      // from the request would go on showing the instant that was asked for.
      expiresAt: minted.data.expiresAt,
      // The REQUEST's join mode, because the receipt carries none and the row requires
      // one. This is the one fact the two halves do not overlap on.
      joinMode: asked.data.joinMode,
    });
  }

  /**
   * Record one served revoke from its receipt, whichever row it names.
   *
   * The RECEIPT's state rather than the literal `revoked`, because the receipt is what
   * the control plane decided and `InviteRevokeResponse` carries it: a revoke put on an
   * invitation that had already been accepted answers with the state it is actually in,
   * and a fixture writing `revoked` over that would move a row the daemon did not.
   */
  public recordRevoke(receipt: unknown): void {
    const revoked = InviteRevokeResponseSchema.safeParse(receipt);
    if (!revoked.success) {
      return;
    }
    this.#stateByInviteId.set(revoked.data.inviteId, revoked.data.state);
  }

  /**
   * The ledger this read answers with: the scenario's rows, then this window's mints.
   *
   * MINTED ROWS LAST, because that is when they happened — a scenario's rows are the
   * state the session opens in and a mint is an act performed on top of it. Every row
   * then passes the recorded state moves and the ageing rule in that order: a recorded
   * move is what an ACT decided and outranks the clock, and ageing a row an act has
   * already settled is the transition {@link ageInviteRow} refuses to invent.
   */
  public foldOverScripted(
    scripted: readonly GrowthInviteSummary[],
  ): readonly GrowthInviteSummary[] {
    const settledAtMilliseconds = this.#engine.clock.now();
    return [...scripted, ...this.#mintedInOrder].map((row) => {
      const moved = this.#stateByInviteId.get(row.inviteId);
      return ageInviteRow(
        moved === undefined ? row : { ...row, state: moved },
        settledAtMilliseconds,
      );
    });
  }
}

/**
 * One ledger row as it reads at a given instant on the scenario's own clock.
 *
 * ONLY A PENDING ROW AGES, because only a pending invitation has a lifetime left to
 * run: `InviteState` moves `pending → expired` and every other state is terminal, so
 * ageing an accepted or revoked row would invent a transition the daemon never makes.
 *
 * AT the declared instant rather than after it. `expiresAt` is when the invitation
 * stops being usable, so a row read at exactly its own expiry is already past the point
 * where a person could redeem it, and answering `pending` there would offer Revoke on
 * an invitation nothing could accept.
 *
 * A row whose expiry is not a readable instant is answered EXACTLY as declared, rather
 * than aged on a stamp nothing could read — an unreadable expiry is an authoring
 * mistake in whichever table declared the row, and guessing a lifecycle from it here
 * would hide that mistake behind a plausible row.
 *
 * Idempotent, which is what lets it be applied without asking whether it already has:
 * an aged row is `expired` and no longer matches the one state this moves.
 *
 * MODULE-PRIVATE, because the fold below is the only way a row reaches a reader: an
 * exported ageing function would be a second way to ask what state a row is in, and a
 * caller taking it would be re-deriving what the ledger read already answers.
 */
function ageInviteRow(
  row: GrowthInviteSummary,
  settledAtMilliseconds: number,
): GrowthInviteSummary {
  const expiry = parseInstant(row.expiresAt).epochMilliseconds;
  return row.state === "pending" && expiry !== undefined && settledAtMilliseconds >= expiry
    ? { ...row, state: "expired" }
    : row;
}
