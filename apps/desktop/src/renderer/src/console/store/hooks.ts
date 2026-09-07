// React bindings for the console's stores.
//
// Three rules from `Spec-023 §Console Design (Meridian)` shape every hook here:
//
//   • **No component subscribes to the bridge.** Components subscribe to a STORE,
//     and exactly one thing subscribes to the bridge — the apply chokepoint. That is
//     why there is no `useBridgeEvent` hook and why adding one would be caught by
//     the architecture tier.
//   • **No component constructs a store.** A store is opened by
//     `SessionStoreRegistry` and RESOLVED here. `useOpenSessionStore` is the only
//     way a component gets one, and it is a read: it never opens a session as a
//     side effect of rendering, because a render pass React discards would leave a
//     store open that nothing will ever close.
//   • **Subscriptions are partitioned per entity.** `useSessionPartition` selects
//     one kind's map, whose identity only changes when that kind changes, so a
//     `run.*` burst re-renders the runs list and nothing else. `useSessionEntity`
//     narrows further to one row, so a row re-renders when its own entity changes
//     and not when its neighbour does.
//
// zustand v5's `useStore` compares with `Object.is` and does no shallow-equality
// pass, which is exactly what these selectors want: the store merges immutably, so
// an untouched partition keeps its identity and the comparison is a pointer check.
// A selector that BUILT a value (a `.map`, a `.filter`, an object literal) would
// defeat that and re-render every frame — so selectors here return stored
// references (`selectPartition` / `selectEntity`, which the store family owns and
// these hooks are the callers of), and derivation happens in the component under
// `useMemo`.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import type { MembershipRole } from "@ai-sidekicks/contracts";

import { isConsoleRefusal, refuse, type ConsoleRefusal } from "../core/index.js";
import type { ConsoleEntity, ConsoleEntityKind, ConsoleEntityRef } from "./entities.js";
import type { FrameStore, FrameStoreState } from "./frame-store.js";
import type { SessionStoreRegistry } from "./session-store-registry.js";
import { selectEntity, selectPartition, type SessionStore } from "./session-store.js";
import type { SessionDegradedCause } from "./session-store.js";
import type { SessionStoreState } from "./session-store.js";
import type { ShellState } from "./shell-state.js";

/**
 * The store for one session, or `undefined` while that session is not open.
 *
 * Subscribed rather than read once: a session opened or closed after this
 * component mounted has to reach it, and the registry's own change emitter is the
 * event that says so — there is no poll and no interval anywhere in this path.
 * `undefined` is a real answer a caller renders as "no session", never a reason to
 * open one from inside a render.
 */
export function useOpenSessionStore(
  registry: SessionStoreRegistry,
  sessionId: string | undefined,
): SessionStore | undefined {
  const subscribe = useCallback(
    (onStoreChange: () => void) => registry.subscribe(onStoreChange),
    [registry],
  );
  const read = useCallback(
    () => (sessionId === undefined ? undefined : registry.peek(sessionId)),
    [registry, sessionId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The sessions this window has open, in open order.
 *
 * The console has no session-DIRECTORY read — no `SidekicksBridge` member lists the
 * sessions on a node, and `Plan-023 §Console growth slate` registers no row for one
 * either — so this registry is the only session set the renderer can name, and the
 * two surfaces that need one (the auxiliary window's context picker and the sessions
 * list) both read it here rather than each inventing a source.
 *
 * Subscribed through the registry's own change emitter, so it costs no timer and no
 * poll, and the read returns the registry's stable array rather than building one.
 */
export function useOpenSessionIds(registry: SessionStoreRegistry): readonly string[] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => registry.subscribe(onStoreChange),
    [registry],
  );
  const read = useCallback(() => registry.openSessionIds, [registry]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Select from the session store. The selector must return a stored reference. */
export function useSessionStore<TSelected>(
  store: SessionStore,
  selector: (state: SessionStoreState) => TSelected,
): TSelected {
  return useStore(store.readable, selector);
}

/** One entity kind's map. Identity changes only when that kind changes. */
export function useSessionPartition(
  store: SessionStore,
  kind: ConsoleEntityKind,
): Readonly<Record<string, ConsoleEntity>> {
  const select = useCallback((state: SessionStoreState) => selectPartition(state, kind), [kind]);
  return useStore(store.readable, select);
}

/**
 * One entity, or `undefined`. The narrowest subscription the console offers.
 *
 * Keyed on the ref's FIELDS rather than on the ref object, so a caller writing the
 * ordinary `useSessionEntity(store, { kind: "run", id })` — a fresh literal every
 * render — does not rebuild the selector on every pass.
 */
export function useSessionEntity(
  store: SessionStore,
  ref: ConsoleEntityRef,
): ConsoleEntity | undefined {
  const { kind, id } = ref;
  const select = useCallback(
    (state: SessionStoreState) => selectEntity(state, { kind, id }),
    [kind, id],
  );
  return useStore(store.readable, select);
}

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
 * How a roster role is read out of a participant entry, injected rather than imported.
 *
 * The role a roster carries is a REGISTERED wire value and reading it means narrowing
 * an untyped body member against the shape the corpus registers — which the console
 * only permits at or above `bridge/`, a family this one sits below. So the lookup
 * arrives the way this file's caller-identity read already arrives: as a function the
 * composition root supplies. `bridge/daemon/entity-body-reads.ts` declares the one
 * implementation; nothing here narrows anything itself.
 */
export type MembershipRoleReader = (
  participant: ConsoleEntity | undefined,
) => MembershipRole | undefined;

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
 * role-gated control stayed in its loading state with nothing on screen saying why.
 * One frozen value rather than a fresh literal per rejection, on `NOT_LOADED_IDENTITY`'s
 * reasoning: a consumer keying a `useMemo` on the result should not see the answer
 * change identity because the same failure happened twice.
 */
const CALLER_IDENTITY_READ_FAILURE: ConsoleRefusal = refuse(
  STORE_REFUSAL_ORIGIN,
  CALLER_IDENTITY_READ_FAILED,
  "Could not read which participant this window is. Reopen the pane to ask again.",
);

/**
 * What this window's own membership role is, or why it is not known.
 *
 * Three arms rather than a bare `MembershipRole | undefined`, because a surface
 * gating a control on the caller's role has three genuinely different situations
 * and only one of them is "this participant is a viewer": the read is still in
 * flight, the read was refused, or the read landed. Collapsing them would render a
 * viewer's affordances for all three, which claims a role nothing checked.
 *
 * `role` is `undefined` on the `read` arm when the roster holds no parseable role
 * for that participant — the read succeeded and the lookup found nothing, which is
 * a different fact again and is left as the honest absence rather than a default.
 */
export type CallerMembershipRoleResult =
  | { readonly status: "not-loaded" }
  | {
      readonly status: "read";
      readonly participantId: string;
      readonly role: MembershipRole | undefined;
    }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * This window's own membership role: the caller read, chained to the roster lookup.
 *
 * Two facts, and neither is guessed. Which participant this window is comes from
 * the injected read and from nowhere else — there is no "the first participant" or
 * "the one that matches the handle" fallback, because a wrong answer here silently
 * shows one person another person's controls. What that participant's role is comes
 * from the store's own roster through the injected reader, because the roster is
 * where the role lives and a second copy carried on the identity read would be a
 * second source of truth for it.
 *
 * The read runs once per (reader, store) pair — the `not-loaded` arm is entered once
 * for that pair and never re-entered — while the ROLE stays subscribed, so a role
 * change arriving on the wire re-renders without the identity being asked again.
 *
 * A SETTLED IDENTITY BELONGS TO THE INPUTS THAT PRODUCED IT, and that is why the
 * state below carries them. A mounted pane that switches sessions or bridges hands
 * this hook a new reader and a new store, and the replacement read does not settle
 * in the same tick: for that interval a hook that simply kept its previous state
 * would report the OLD participant as successfully read and look that id up in the
 * NEW store — and if the id exists there, role-gated controls render on an identity
 * this session never established. Comparing the stamp during render is what closes
 * that interval rather than narrowing it: the answer reverts to `not-loaded` on the
 * pass that first sees the new inputs, before the effect that will replace it runs.
 */
export function useCallerMembershipRole(
  readCallerParticipant: CallerParticipantReader,
  store: SessionStore,
  readMembershipRole: MembershipRoleReader,
): CallerMembershipRoleResult {
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

  const callerIdentity: CallerIdentityState =
    reading !== undefined && reading.reader === readCallerParticipant && reading.store === store
      ? reading.identity
      : NOT_LOADED_IDENTITY;

  const participantId = callerIdentity.status === "read" ? callerIdentity.participantId : undefined;
  const selectRole = useCallback(
    (state: SessionStoreState) =>
      participantId === undefined
        ? undefined
        : readMembershipRole(selectEntity(state, { kind: "participant", id: participantId })),
    [participantId, readMembershipRole],
  );
  const role = useStore(store.readable, selectRole);

  return useMemo(
    () =>
      callerIdentity.status === "read"
        ? { status: "read", participantId: callerIdentity.participantId, role }
        : callerIdentity,
    [callerIdentity, role],
  );
}

/** The identity half of the chain, before the roster lookup is folded onto it. */
type CallerIdentityState =
  | { readonly status: "not-loaded" }
  | { readonly status: "read"; readonly participantId: string }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * A settled identity together with the inputs it was read against.
 *
 * Both inputs, not just the reader. The reader answers WHO this window is and the
 * store is WHERE that participant's role is looked up, so an identity read against
 * one store is not an answer about another — and a pane can be handed a new store
 * with the same reader (a second session on the same bridge) as easily as the
 * reverse.
 */
interface CallerIdentityReading {
  readonly reader: CallerParticipantReader;
  readonly store: SessionStore;
  readonly identity: CallerIdentityState;
}

/**
 * One frozen initial value rather than a fresh literal per mount, so the identity
 * of the "nothing has been read yet" answer does not change under a consumer's
 * `useMemo` or effect dependency on the result — including across the passes where
 * a stamp mismatch is what produces it.
 */
const NOT_LOADED_IDENTITY: CallerIdentityState = { status: "not-loaded" };

/** Whether the store has been initialised, so a surface can tell "not loaded" apart. */
export function useSessionInitialised(store: SessionStore): boolean {
  return useStore(store.readable, readInitialised);
}

function readInitialised(state: SessionStoreState): boolean {
  return state.initialised;
}

/**
 * Whether this session's projection is known-incomplete — the store's own sticky
 * flag, SUBSCRIBED rather than sampled.
 *
 * Two sidebar sections read this fact beside a read of their own and each of them
 * sampled `snapshot().degradedCause` in its render body, which is a read with no
 * subscription behind it: a store entering or leaving its degraded state without
 * that section's read settling — a sequence gap in an unrelated partition, a closed
 * subscription — moved the flag and re-rendered nothing, so the warning stayed
 * absent, or stayed on screen after a re-pull had cleared it.
 *
 * A boolean rather than the cause, because these readers ask only whether one is
 * standing, and a primitive is compared by value under zustand v5's `Object.is` —
 * so a transition between two causes costs no render to a surface that renders
 * neither. A reader that renders the cause itself takes
 * {@link useSessionDegradedCause} below, which is the same subscription narrowed one
 * step less.
 */
export function useSessionDegraded(store: SessionStore): boolean {
  return useStore(store.readable, readDegraded);
}

function readDegraded(state: SessionStoreState): boolean {
  return state.degradedCause !== undefined;
}

/**
 * Why the projection is known-incomplete, or `undefined` while it is whole.
 *
 * A hook of its own rather than a `useSessionStore` call at each surface, for the
 * reason this family's header gives: the selector has to return a stored
 * reference, and one written per surface is one more chance to build a value and
 * re-render every frame. A sidebar section renders "unavailable" from this rather
 * than rendering a zero, which is the distinction `Spec-023 §Console Design
 * (Meridian)` draws between an answered empty read and a read that never landed.
 */
export function useSessionDegradedCause(store: SessionStore): SessionDegradedCause | undefined {
  return useStore(store.readable, readDegradedCause);
}

function readDegradedCause(state: SessionStoreState): SessionDegradedCause | undefined {
  return state.degradedCause;
}

/**
 * What the shell says about itself, subscribed rather than sampled.
 *
 * A hook of its own beside {@link useFrameStore} for `useSessionDegradedCause`'s
 * reason: the selector has to return a stored reference, and one written per surface
 * is one more chance to build a value in a render body and re-render every frame.
 * The store publishes a new `shellState` only when the report or the recovery fold
 * actually moved, so a subscriber here re-renders exactly when the fact does.
 */
export function useShellState(store: FrameStore): ShellState {
  return useStore(store.readable, readShellState);
}

function readShellState(state: FrameStoreState): ShellState {
  return state.shellState;
}

/**
 * How many sessions need a person, or `undefined` where nothing is reading.
 *
 * Narrowed one step further than {@link useShellState} because the rail renders this
 * and nothing else: the rail is the console's most-seen surface, and a subscriber to
 * the whole shell state would re-render it on every heartbeat.
 */
export function useRailAttentionCount(store: FrameStore): number | undefined {
  return useStore(store.readable, readRailAttentionCount);
}

function readRailAttentionCount(state: FrameStoreState): number | undefined {
  return state.railAttentionCount;
}

/** Select from the frame store. */
export function useFrameStore<TSelected>(
  store: FrameStore,
  selector: (state: FrameStoreState) => TSelected,
): TSelected {
  return useStore(store.readable, selector);
}

/**
 * The window's location hash, as a subscription rather than a poll.
 *
 * `hashchange` is a real browser event, so this needs no interval — which matters,
 * because a 100 ms route poll would be the console's only always-on timer and would
 * blow the idle-CPU budget on its own.
 */
export function useLocationHash(): string {
  return useSyncExternalStore(subscribeToHashChange, readLocationHash, readServerLocationHash);
}

function subscribeToHashChange(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  window.addEventListener("hashchange", onStoreChange);
  return () => {
    window.removeEventListener("hashchange", onStoreChange);
  };
}

function readLocationHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

function readServerLocationHash(): string {
  return "";
}
