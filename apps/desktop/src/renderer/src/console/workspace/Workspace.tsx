// The session workspace: the cast bar, the deck, and the composer's seat.
//
// This is what a person is looking at when they are looking at a session. It
// composes three things it does not own — `CastBar` (this family's), the deck's
// panes (six families', through one mount door), and the composer (the composer
// family's, through its seat) — and owns exactly one thing itself: the arrangement.
//
// FOUR DECISIONS:
//
//   • **The layout is restored once, at mount, and saved through the persistence
//     chokepoint.** `Spec-023 §Console Design (Meridian)` §4.2: "pane ids, sizes,
//     order, and scroll positions persist; projections are re-derived on
//     reconnect". Nothing about a session's own state is written — the snapshot
//     holds pane ids, kinds, entity refs, and widths, which is the `layout` value
//     class and nothing beyond it.
//   • **Saves are coalesced by the write itself.** Dragging a separator produces a
//     transition per frame, and one durable write per frame would spend the store's
//     whole budget on a gesture. `deck/layout-persistence.ts` holds one write in
//     flight and one pending snapshot, so a drag costs what the database can absorb
//     and every record it writes is the newest arrangement rather than a stale one.
//   • **An empty deck opens the ledger.** §4.2's empty state is "the workspace
//     shows the ledger alone, full width", which is a `timeline` pane at full width
//     rather than a special case in the renderer.
//   • **Refusals are rendered where they happened.** What a restore dropped belongs
//     to the deck and renders inside it; what a detach or a save refused changes
//     what the whole surface can do and takes the workspace banner — §4.1's
//     placement for a refusal of that reach.
//   • **A detached pane keeps its slot.** §4.5's main window "never keeps a duplicate
//     projection alive while the aux window shows it" suppresses the BODY, not the
//     pane: closing the pane would delete its width and its position, and the window
//     closing or crashing would then have nowhere to put it back. So the hand-off's
//     detached set is subscribed to here and passed down, and the slot draws a
//     placeholder with a focus control and a way back.

import { useCallback, useEffect, useMemo, useState } from "react";

import { DECK_RESTORED_PANE_CAP, refuse, type ConsoleRefusal } from "../core/index.js";
import { type ConsoleBridge } from "../bridge/index.js";
import { RefusalBanner, useAnnounce } from "../primitives/index.js";
import { routeSessionId, type ConsoleRoute } from "../routing/index.js";
import { type FrameStore, type SessionStore } from "../store/index.js";
import { type DraftStore, type UiStateStore } from "../persistence/index.js";
import { CastBar } from "./CastBar.js";
import { AuxiliaryHandoff } from "./aux-handoff.js";
import { Deck } from "./deck/Deck.js";
import { useDeckLayout, useDeckLayoutState, type DeckLayout } from "./deck/deck-layout.js";
import type { DeckPane } from "./deck/deck-model.js";
import { DeckLayoutWriter } from "./deck/layout-persistence.js";
import {
  actorFollowHandler,
  composerSeatRenderer,
  consolePaneRegistry,
  type ConsolePaneAddress,
  type ConsolePaneContext,
  type ConsolePaneRegistry,
} from "./seats/index.js";
import { ACTOR_FOLLOW_ANNOUNCEMENTS, resolveActorFollow } from "./actor-follow.js";

/** The durable record the deck's arrangement is saved under, per session. */
const DECK_LAYOUT_RECORD_KEY = "deck-layout";

/** Why the workspace itself refused. Closed, so a second cause is a decision. */
export const WORKSPACE_REFUSAL_CODES = ["layout-save-failed"] as const;

/** One workspace refusal code. Derived, so the vocabulary is declared once. */
export type WorkspaceRefusalCode = (typeof WORKSPACE_REFUSAL_CODES)[number];

/** The subsystem name every refusal this surface raises carries. */
export const WORKSPACE_REFUSAL_ORIGIN = "workspace";

/** A typed workspace refusal — `core`'s one refusal shape, narrowed on `code`. */
interface WorkspaceRefusal extends ConsoleRefusal {
  readonly code: WorkspaceRefusalCode;
}

/**
 * Raise one, from the closed vocabulary above.
 *
 * `refuse` takes its code as a `string`, so a call site that spelled one wrong
 * would compile and render a code no reader could look up. Everything this surface
 * refuses goes through here instead, where the union is what binds.
 */
function refuseWorkspace(code: WorkspaceRefusalCode, detail: string): WorkspaceRefusal {
  return { ...refuse(WORKSPACE_REFUSAL_ORIGIN, code, detail), code };
}

export interface WorkspaceProps {
  readonly bridge: ConsoleBridge;
  readonly frameStore: FrameStore;
  /** `undefined` on a route that names no session, or before its store opens. */
  readonly sessionStore: SessionStore | undefined;
  readonly uiStateStore: UiStateStore;
  readonly draftStore: DraftStore;
  readonly route: ConsoleRoute;
  /** Where pane bodies come from. Defaults to the process-wide registry. */
  readonly registry?: ConsolePaneRegistry;
}

export function Workspace(props: WorkspaceProps): React.JSX.Element {
  const sessionId = routeSessionId(props.route);
  const registry = props.registry ?? consolePaneRegistry;
  const layout = useDeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
  const deckState = useDeckLayoutState(layout);
  const [handoff] = useState(() => new AuxiliaryHandoff({ growth: props.bridge.growth }));
  // Read HERE and not inside the follow callback: a hook may not be called from one,
  // and a workspace mounted outside `LiveAnnouncerProvider` should fail on this line
  // rather than the first time somebody presses a chip.
  const announce = useAnnounce();
  const sessionStore = props.sessionStore;
  const [banners, setBanners] = useState<readonly ConsoleRefusal[]>([]);

  const raise = useCallback((refusal: ConsoleRefusal) => {
    setBanners((current) => [...current, refusal]);
  }, []);

  const restoreRefusals = useDeckPersistence({
    layout,
    uiStateStore: props.uiStateStore,
    sessionId,
    onSaveRefused: raise,
  });

  const paneContextFor = useCallback(
    (pane: DeckPane): ConsolePaneContext => ({
      kind: pane.kind,
      entity: pane.entity,
      paneId: pane.paneId,
      bridge: props.bridge,
      frameStore: props.frameStore,
      sessionStore: props.sessionStore,
      uiStateStore: props.uiStateStore,
      draftStore: props.draftStore,
      // Fail-closed, per the seat's own rule: the ring takes an actor's hue only
      // where the pane's entity is a run or an agent, and an unattributed pane takes
      // the neutral boundary rather than somebody else's colour. Resolving that hue
      // belongs to the lane that renders run and agent panes; nothing here guesses.
      focusHue: undefined,
    }),
    [props.bridge, props.frameStore, props.sessionStore, props.uiStateStore, props.draftStore],
  );

  const detached = useDetachedPanes(handoff);

  const onOpenInWindow = useCallback(
    (pane: DeckPane) => {
      void (async () => {
        const outcome = await handoff.detach({
          paneId: pane.paneId,
          kind: pane.kind,
          sessionId,
          ...(pane.entity?.kind === "agent" ? { agentId: pane.entity.id } : {}),
        });
        if (outcome.outcome === "refused") {
          raise(outcome.refusal);
        }
        // The pane STAYS, with its body suppressed. §4.5 forbids a duplicate
        // projection, not the slot: a closed pane loses its width and its position,
        // and the window closing would then have nowhere to put the pane back.
      })();
    },
    [handoff, raise, sessionId],
  );

  const onFocusDetachedWindow = useCallback(
    (paneId: string) => {
      void (async () => {
        const refusal = await handoff.focus(paneId);
        if (refusal !== undefined) {
          raise(refusal);
        }
      })();
    },
    [handoff, raise],
  );

  const onReturnToDeck = useCallback(
    (paneId: string) => {
      void (async () => {
        const refusal = await handoff.returnToDeck(paneId);
        if (refusal !== undefined) {
          raise(refusal);
        }
      })();
    },
    [handoff, raise],
  );

  const onFollow = useCallback(
    (participantId: string) => {
      // §4.1's follow has two halves, and both of them happen. The first is the
      // deck's: the actor's own pane takes focus where one is open, and the session's
      // ledger otherwise. In a deck holding one timeline that half is a no-op, which
      // is why the second half is not optional.
      const panes = layout.snapshot().panes;
      const target =
        panes.find((pane) => pane.entity?.id === participantId) ??
        panes.find((pane) => pane.kind === "timeline");
      if (target !== undefined) {
        layout.focus(target.paneId);
      }

      // The second half — the ledger scrolling to that actor's newest row — rides the
      // ledger's own scroll chokepoint through the follow seat, never a
      // `scrollIntoView` call here. Each way it can fail says so: a participant with
      // no row, a row outside the window the ledger holds, and a window with no ledger
      // mounted are three different facts, and a press that quietly did nothing
      // reported none of them.
      const resolution = resolveActorFollow(sessionStore?.snapshot().timeline ?? [], participantId);
      if (resolution.outcome === "no-activity") {
        announce(ACTOR_FOLLOW_ANNOUNCEMENTS["no-activity"]);
        return;
      }
      const follow = actorFollowHandler();
      if (follow === undefined) {
        announce(ACTOR_FOLLOW_ANNOUNCEMENTS["no-ledger"]);
        return;
      }
      if (follow({ participantId, newestSequence: resolution.newestSequence }) !== "revealed") {
        announce(ACTOR_FOLLOW_ANNOUNCEMENTS["row-not-in-view"]);
      }
    },
    [announce, layout, sessionStore],
  );

  const composer = composerSeatRenderer();
  const focusedPane = useFocusedPaneAddress(deckState.panes, deckState.focusedPaneId);

  return (
    <div className="meridian-workspace">
      {banners.map((refusal, position) => (
        <RefusalBanner
          key={`${refusal.code}-${String(position)}`}
          code={refusal.code}
          detail={refusal.detail}
          onDismiss={() => {
            setBanners((current) => current.filter((candidate) => candidate !== refusal));
          }}
        />
      ))}
      <CastBar sessionId={sessionId} sessionStore={props.sessionStore} onFollow={onFollow} />
      <Deck
        layout={layout}
        registry={registry}
        paneContextFor={paneContextFor}
        onOpenInWindow={onOpenInWindow}
        restoreRefusals={restoreRefusals}
        detachedPaneIds={detached.paneIds}
        onFocusDetachedWindow={onFocusDetachedWindow}
        onReturnToDeck={onReturnToDeck}
        {...(detached.signalRefusal === undefined
          ? {}
          : { detachedSignalRefusal: detached.signalRefusal })}
      />
      {composer === undefined || props.sessionStore === undefined ? null : (
        <div className="meridian-workspace__composer">
          {composer({
            sessionStore: props.sessionStore,
            bridge: props.bridge,
            draftStore: props.draftStore,
            route: props.route,
            focusedPane,
          })}
        </div>
      )}
    </div>
  );
}

/** Which panes are showing in windows of their own, and what the signal refused. */
interface DetachedPaneProjection {
  readonly paneIds: readonly string[];
  readonly signalRefusal: ConsoleRefusal | undefined;
}

/**
 * Follow the hand-off's detached set, and watch the crashed-window signal while it
 * is non-empty.
 *
 * The signal is opened on the first detach and closed when the last pane comes back,
 * rather than held for the surface's lifetime: a subscription over an empty set can
 * report nothing, and its refusal would sit on screen as a permanent notice about a
 * hazard this window does not currently have.
 */
function useDetachedPanes(handoff: AuxiliaryHandoff): DetachedPaneProjection {
  const [projection, setProjection] = useState<DetachedPaneProjection>({
    paneIds: [],
    signalRefusal: undefined,
  });

  useEffect(() => {
    const read = (): void => {
      setProjection({
        paneIds: handoff.detached().map((pane) => pane.paneId),
        signalRefusal: handoff.paneErrorRefusal,
      });
    };
    const unsubscribe = handoff.subscribe(read);
    read();
    return () => {
      unsubscribe();
      handoff.stopWatchingPaneErrors();
    };
  }, [handoff]);

  const hasDetachedPane = projection.paneIds.length > 0;
  useEffect(() => {
    if (!hasDetachedPane) {
      handoff.stopWatchingPaneErrors();
      return;
    }
    void handoff.watchPaneErrors();
  }, [handoff, hasDetachedPane]);

  return projection;
}

/** The focused pane's address, for the composer's send router. */
function useFocusedPaneAddress(
  panes: readonly DeckPane[],
  focusedPaneId: string | undefined,
): ConsolePaneAddress | undefined {
  return useMemo(() => {
    const pane = panes.find((candidate) => candidate.paneId === focusedPaneId);
    return pane === undefined ? undefined : { kind: pane.kind, entity: pane.entity };
  }, [panes, focusedPaneId]);
}

interface DeckPersistenceOptions {
  readonly layout: DeckLayout;
  readonly uiStateStore: UiStateStore;
  readonly sessionId: string | undefined;
  readonly onSaveRefused: (refusal: ConsoleRefusal) => void;
}

/**
 * Restore the deck once, then keep it saved. Returns what the restore refused.
 *
 * A hook rather than two effects in the component body, because the two halves are
 * one story: the restore has to complete before the first save, or an empty deck
 * would overwrite the record it was about to read.
 */
function useDeckPersistence(options: DeckPersistenceOptions): readonly ConsoleRefusal[] {
  const { layout, uiStateStore, sessionId, onSaveRefused } = options;
  const [restoreRefusals, setRestoreRefusals] = useState<readonly ConsoleRefusal[]>([]);

  // The partition rides the REQUEST rather than being read here. A writer coalesces,
  // so a queued arrangement settles after the act that queued it — and this component
  // survives a navigation between two already-open sessions, because the shell opens
  // session stores and never closes them. Reading a mutable current-session holder at
  // write time filed the older session's arrangement under the newer one's partition
  // and overwrote a deck the person had not touched.
  const [writer] = useState(
    () =>
      new DeckLayoutWriter({
        write: async (partition, snapshot) => {
          const result = await uiStateStore.write(
            partition,
            DECK_LAYOUT_RECORD_KEY,
            "layout",
            snapshot,
          );
          if (result.outcome === "refused") {
            onSaveRefused(result.refusal);
          }
        },
        // A write that rejects is surfaced, not thrown: an unhandled rejection out
        // of a save would take the window down over a layout the person can redraw.
        onFailed: () => {
          onSaveRefused(
            refuseWorkspace(
              "layout-save-failed",
              "This window's pane arrangement could not be saved. It is still on screen, and it will be saved again on the next change.",
            ),
          );
        },
      }),
  );

  useEffect(() => {
    if (sessionId === undefined) {
      return;
    }
    let superseded = false;
    void (async () => {
      const record = await uiStateStore.read(sessionId, DECK_LAYOUT_RECORD_KEY);
      if (superseded) {
        return;
      }
      const report = record === undefined ? undefined : layout.restore(record.value);
      if (report !== undefined && report.refusals.length > 0) {
        setRestoreRefusals(report.refusals);
      }
      if (report === undefined || report.restoredPaneCount === 0) {
        // §4.2's empty state: the workspace shows the ledger alone, full width.
        layout.open({ kind: "timeline", entity: undefined });
      }
    })();
    return () => {
      superseded = true;
    };
  }, [layout, sessionId, uiStateStore]);

  useEffect(() => {
    if (sessionId === undefined) {
      return;
    }
    return layout.subscribe(() => {
      writer.request(sessionId, layout.toSnapshot());
    });
  }, [layout, writer, sessionId]);

  return restoreRefusals;
}
