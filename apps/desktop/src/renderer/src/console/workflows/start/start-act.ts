// Starting one run from the picker, and what the picker knows about that act afterwards.
//
// THE REACT HALF ONLY. What a start IS — the single-flight guard, the act it publishes,
// the refusal reading, and how long any of it lives — is `start-flight.ts`, which has no
// renderer in it at all. This file decides when React is told: it subscribes the mount
// to the flight its session already has, and hands a row the one thing it can ask for.
//
// THE STATE IS NOT HELD HERE, AND THAT IS THE WHOLE OF THE SPLIT. The composer's `+`
// menu renders the picker only while its disclosure is open, so this hook is unmounted
// and re-created every time somebody closes and reopens the menu. State held by the
// mount — a latch from `useGenerationLatch`, a value from `useSubjectScopedState` —
// starts idle on every open, which is how a second press dispatched a second
// non-idempotent start while the first was still running. So the mount subscribes and
// owns nothing: the flight belongs to the `(port, session)` pair, and a picker reopened
// mid-flight reads `starting` from the same object the first press published into.
//
// THE PIN IS THE ENTRY'S OWN. A start is against a version, and the enumeration is what
// says which version a definition's name is at; composing one here would be this surface
// choosing a version nobody pinned.
//
// THE CHANNEL TRAVELS AS PROVENANCE AND IS NEVER TYPED BY ANYBODY. A composer addressed
// within a channel is a chat-borne start and says so; a composer addressed at a running
// turn carries none rather than a guessed one. Whether the starter is a member of that
// channel is the daemon's to validate, and this surface neither pre-empts nor re-derives
// it. It is read at the PRESS rather than held by the flight, because the flight outlives
// the mount and the address does not: the provenance a start carries is the one the
// composer was showing when the row was pressed.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { GrowthPort } from "../../bridge/index.js";
import type { WorkflowDefinitionRow } from "../definitions/definition-rows.js";
import {
  heldWorkflowStartAct,
  startWorkflowRun,
  watchWorkflowStartFlight,
  type WorkflowStartAct,
} from "./start-flight.js";

/** The act, and the one thing a row can ask for. */
export interface WorkflowStartDispatch {
  readonly act: WorkflowStartAct;
  readonly start: (definition: WorkflowDefinitionRow) => void;
}

/** What a start is addressed by, all of it the composer's own. */
export interface WorkflowStartAddress {
  readonly growth: GrowthPort;
  /** The session the run starts in, or nothing where this composer has none. */
  readonly sessionId: string | undefined;
  /** The originating channel of a chat-borne start. Absent everywhere else. */
  readonly channelId: string | undefined;
}

/**
 * Read the picker's one start act, and hand back the press.
 *
 * Addressed by the port AND the session, which is the pair every read and act on this
 * seam is held against: the fixture's scenario switch replaces the bridge and keeps the
 * session id, so a session-only address would carry the previous scenario's receipt into
 * the next one.
 *
 * BOTH CALLBACKS GO THROUGH THE REGISTER rather than closing over the flight this render
 * resolved. A flight captured at render can be retired before React runs the
 * subscription's setup — the close and reopen this hook exists for — and watching that
 * object there would revive it outside the register, which is the second flight the
 * whole arrangement is meant to prevent.
 */
export function useWorkflowStartAct(address: WorkflowStartAddress): WorkflowStartDispatch {
  const { growth, sessionId, channelId } = address;
  const subscribe = useCallback(
    (onActChanged: () => void) => watchWorkflowStartFlight(growth, sessionId, onActChanged),
    [growth, sessionId],
  );
  // A READ AND NEVER A MINT. The register answers with the idle value where no flight is
  // held, so a render pass React discards leaves no entry behind for nobody to unwatch.
  const readAct = useCallback(() => heldWorkflowStartAct(growth, sessionId), [growth, sessionId]);
  const act = useSyncExternalStore(subscribe, readAct, readAct);

  const start = useCallback(
    (definition: WorkflowDefinitionRow) => {
      startWorkflowRun(growth, sessionId, definition, channelId);
    },
    [growth, sessionId, channelId],
  );

  return useMemo(() => ({ act, start }), [act, start]);
}
