// How the two surfaces reach the handoff: one offers, one claims.
//
// SPLIT OFF THE HANDOFF ITSELF for the cut `bridge/quotas/` already makes twice.
// `attach-handoff.ts` owns what an offer IS and how long one lives; this module owns
// how React sees it — which is a different job, testable without a tree on one side of
// the line and only with one on the other.
//
// THE CLAIM IS AN EFFECT AND NEVER A RENDER-TIME READ. Claiming mutates the handoff,
// and a render body that mutated it would spend the offer on a pass React is free to
// discard — the offer would be gone and the form would never have opened.
//
// AND IT WAITS FOR THE READ IT RESOLVES AGAINST. The offer carries an id; the form
// needs the record. The definition list is what turns one into the other, so the claim
// stands by until that read has SERVED — a claim taken against a read still in flight
// would resolve nothing and spend the offer doing it.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../../../bridge/index.js";
import type { PushDrivenReadState } from "../../../seats/index.js";
import type { SidekickDefinitionListReading } from "../../agent-wire.js";
import type { AttachSidekickForm } from "../attach-model.js";
import { attachHandoffFor, type AttachHandoffOffer } from "./attach-handoff.js";

/** What an offering surface holds: the standing offer, and the two acts on it. */
export interface AttachHandoffControl {
  /** The offer standing in this window, or `undefined` where none is. */
  readonly standingOffer: AttachHandoffOffer | undefined;
  readonly offer: (offer: AttachHandoffOffer) => void;
  readonly withdraw: () => void;
}

/**
 * This window's handoff, as a surface that OFFERS reads and writes it.
 *
 * Subscribed rather than read once, because the offer is what the offering surface
 * renders back: a row that showed a press it had made and then never showed the
 * withdrawal would be reporting a promise the console had already dropped.
 */
export function useAttachHandoff(bridge: ConsoleBridge): AttachHandoffControl {
  // Resolved inside each callback rather than over a handoff this render captured,
  // for the reason `provider-quota-feed.ts` states about its own reading: the value
  // this render happened to hold is not necessarily the one the registry answers with
  // at the moment somebody presses.
  const subscribe = useCallback(
    (onOfferChanged: () => void) => attachHandoffFor(bridge).watch(onOfferChanged),
    [bridge],
  );
  const readStandingOffer = useCallback(() => attachHandoffFor(bridge).standingOffer, [bridge]);
  const standingOffer = useSyncExternalStore(subscribe, readStandingOffer, readStandingOffer);
  return useMemo<AttachHandoffControl>(
    () => ({
      standingOffer,
      offer: (next: AttachHandoffOffer): void => {
        attachHandoffFor(bridge).offer(next);
      },
      withdraw: (): void => {
        attachHandoffFor(bridge).withdraw();
      },
    }),
    [bridge, standingOffer],
  );
}

/**
 * Honour a standing offer for this session, once.
 *
 * THE OFFER IS SPENT EITHER WAY once the read has served, and that is deliberate. A
 * definition deleted between the press and the claim cannot be attached from, and an
 * offer that survived the record it names would open a form on nothing every time the
 * list refreshed. What is NOT spent is an offer whose read has not served or has
 * refused: nothing there says the definition is gone, and dropping it would turn one
 * failed read into a lost act.
 *
 * The parameter is written inline rather than as an exported interface: nothing but
 * this signature names the shape, and an export no module imports is dead by the
 * package's own gate.
 *
 * @param claim.bridge `undefined` where the mount resolved no bridge, which claims
 *   nothing at all.
 * @param claim.sessionId The session this form attaches into. An offer made for
 *   another session is not honoured and is not spent.
 * @param claim.definitions The read that turns the offer's id into the record.
 * @param claim.onOpen Opens the form. Called only where a record was selected.
 */
export function useAttachHandoffClaim(claim: {
  readonly bridge: ConsoleBridge | undefined;
  readonly sessionId: string | undefined;
  readonly definitions: PushDrivenReadState<SidekickDefinitionListReading>;
  readonly form: AttachSidekickForm;
  readonly onOpen: () => void;
}): void {
  const { bridge, sessionId, definitions, form, onOpen } = claim;
  useEffect(() => {
    if (bridge === undefined || sessionId === undefined || definitions.kind !== "loaded") {
      return;
    }
    const handoff = attachHandoffFor(bridge);
    const standing = handoff.standingOffer;
    if (standing === undefined || standing.sessionId !== sessionId) {
      return;
    }
    const record = definitions.value.definitions.find(
      (definition) => definition.definitionId === standing.definitionId,
    );
    handoff.claim(sessionId);
    if (record === undefined) {
      return;
    }
    // The form's own selection, which is what moves it onto the definition arm and
    // drops every override — the same act the picker performs, so a handed-off
    // definition and a picked one leave the form in one state rather than two.
    form.selectDefinition(record);
    onOpen();
  }, [bridge, sessionId, definitions, form, onOpen]);
}
