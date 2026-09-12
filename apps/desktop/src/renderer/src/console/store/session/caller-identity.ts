// Which participant this window is — a bridge read wearing a hook.
//
// ITS OWN MODULE RATHER THAN A LINE IN `session-hooks.ts`, because it is not a
// store selector. Every other hook beside it subscribes to a store and returns
// what the store already holds. This one performs a read that can FAIL and carries
// a refusal vocabulary of its own for saying so, and a module that mixed the two
// is how a reader ends up believing a store read cannot refuse.

import { useEffect, useState } from "react";

import { isConsoleRefusal, refuse, type ConsoleRefusal } from "../../core/index.js";
import type { SessionStore } from "./session-store.js";

/**
 * The caller-identity read, as this family is allowed to take it: a function that
 * answers the participant id this window is, or the refusal that says why it could
 * not be read.
 *
 * INJECTED RATHER THAN REACHED FOR, on `open-session-entry.ts`'s precedent and for
 * its reason. The read is the growth port's `callerParticipantRead`, which lives in
 * `bridge/` — a family ABOVE this one in the console's DAG, so a hook here that
 * named the bridge would be the upward edge `structure:layering` refuses. What a
 * caller has to SAY is the same either way: perform the read, or carry the refusal
 * a live build's unregistered wire produces. The composition root, which may reach
 * the bridge, adapts the port's outcome into this shape — a served value's
 * `participantId`, or the `GrowthUnavailable` itself, which IS a `ConsoleRefusal`.
 */
export type CallerParticipantReader = () => Promise<string | ConsoleRefusal>;

/**
 * The subsystem name this family's refusals carry, spelled once.
 *
 * `core/refusal.ts` gives `origin` as the field that lets a refusal surfacing three
 * layers from where it was raised still name its author, and the `persistence/`
 * family already writes its own down this way rather than at each site.
 */
export const STORE_REFUSAL_ORIGIN = "store";

/**
 * The code a reader's REJECTION becomes.
 *
 * Not a bridge code, and the DAG is why: the codes a bridge failure carries are
 * declared in `bridge/`, a family above this one, so naming one here would be the
 * upward edge `structure:layering` refuses. It is also the honest name — the reader
 * is injected, so what this family knows is that the read did not answer, not what
 * went wrong underneath. The producer that HAS that knowledge keeps returning its
 * own `ConsoleRefusal`, which travels through the same arm untouched.
 */
export const CALLER_IDENTITY_READ_FAILED = "caller-identity-read-failed";

/**
 * The whole refusal, built once.
 *
 * A rejected reader is not a served answer and it is not "still loading" either: a
 * hook that let the rejection escape produced an unhandled rejection no React error
 * boundary can see and then sat in `not-loaded` for the life of the pane, so every
 * surface waiting on the identity stayed in its loading state with nothing on screen
 * saying why. One frozen value rather than a fresh literal per rejection, on
 * `NOT_LOADED_IDENTITY`'s reasoning: a consumer keying a `useMemo` on the result
 * should not see the answer change identity because the same failure happened twice.
 */
const CALLER_IDENTITY_READ_FAILURE: ConsoleRefusal = refuse(
  STORE_REFUSAL_ORIGIN,
  CALLER_IDENTITY_READ_FAILED,
  "Could not read which participant this window is. Reopen the pane to ask again.",
);

/**
 * Which participant this window is, or why that is not known.
 *
 * Three arms rather than a bare `string | undefined`, because a surface that
 * attributes what it renders to this window has three genuinely different situations
 * and only one of them is an identity: the read is still in flight, the read was
 * refused, or the read landed. Collapsing them attributes work to nobody in two of
 * the three and says nothing about which.
 */
export type CallerIdentityResult =
  | { readonly status: "not-loaded" }
  | { readonly status: "read"; readonly participantId: string }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * Which participant this window is: the injected read, held against its inputs.
 *
 * The answer comes from the injected read and from nowhere else — there is no "the
 * first participant" or "the one that matches the handle" fallback, because a wrong
 * answer here attributes one window's work to somebody else. The read runs once per
 * (reader, store) pair: the `not-loaded` arm is entered once for that pair and never
 * re-entered.
 *
 * A SETTLED IDENTITY BELONGS TO THE INPUTS THAT PRODUCED IT, and that is why the
 * state below carries them. A mounted pane that switches sessions or bridges hands
 * this hook a new reader and a new store, and the replacement read does not settle
 * in the same tick: for that interval a hook that simply kept its previous state
 * would report the OLD participant as this window's identity in the NEW session.
 * Comparing the stamp during render is what closes that interval rather than
 * narrowing it — the answer reverts to `not-loaded` on the pass that first sees the
 * new inputs, before the effect that will replace it runs.
 */
export function useCallerIdentity(
  readCallerParticipant: CallerParticipantReader,
  store: SessionStore,
): CallerIdentityResult {
  const [reading, setReading] = useState<CallerIdentityReading | undefined>(undefined);

  useEffect(() => {
    let abandoned = false;
    void (async () => {
      // The reader is injected, so its failure mode is whatever the composition root
      // handed us — an IPC call that never reaches the daemon rejects before it can
      // build a refusal. Caught HERE rather than with a `.catch` on the effect's
      // promise, so the abandonment check below governs the failure arm exactly as it
      // governs the settled one: a rejection that lands after unmount or after the
      // inputs changed sets nothing.
      let answer: string | ConsoleRefusal;
      try {
        answer = await readCallerParticipant();
      } catch {
        answer = CALLER_IDENTITY_READ_FAILURE;
      }
      if (abandoned) {
        return;
      }
      setReading({
        reader: readCallerParticipant,
        store,
        identity: isConsoleRefusal(answer)
          ? { status: "refused", refusal: answer }
          : { status: "read", participantId: answer },
      });
    })();
    return () => {
      // The component unmounted, or an input changed, before the read landed.
      // Settling state afterwards would either warn or, worse, publish a stale
      // window's identity into a fresh one.
      abandoned = true;
    };
  }, [readCallerParticipant, store]);

  return reading !== undefined &&
    reading.reader === readCallerParticipant &&
    reading.store === store
    ? reading.identity
    : NOT_LOADED_IDENTITY;
}

/**
 * A settled identity together with the inputs it was read against.
 *
 * Both inputs, not just the reader. The reader answers WHO this window is and the
 * store is WHICH session that answer is about, so an identity read against one store
 * is not an answer about another — and a pane can be handed a new store with the same
 * reader (a second session on the same bridge) as easily as the reverse.
 */
interface CallerIdentityReading {
  readonly reader: CallerParticipantReader;
  readonly store: SessionStore;
  readonly identity: CallerIdentityResult;
}

/**
 * One frozen initial value rather than a fresh literal per mount, so the identity
 * of the "nothing has been read yet" answer does not change under a consumer's
 * `useMemo` or effect dependency on the result — including across the passes where
 * a stamp mismatch is what produces it.
 */
const NOT_LOADED_IDENTITY: CallerIdentityResult = { status: "not-loaded" };
