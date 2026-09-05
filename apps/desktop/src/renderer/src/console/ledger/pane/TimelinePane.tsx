// The timeline pane: its chrome, and the hole where another plan's rows go.
//
// `Spec-023 §The surface set` fixes the chrome — panes are "each headed by an entity
// breadcrumb and a kind glyph, with the actor's hue as the focus ring" — and
// `workspace/deck/PaneHeader.tsx` states the rest of the strip as its own rule: close,
// open-in-window where the kind permits, and the kind's own actions. Everything below is
// that header and nothing beyond it.
//
// THE ROWS ARE NOT THIS FAMILY'S. The row vocabulary of `Spec-013 §Timeline Entry
// Types` is authored in `renderer/src/timeline/`, which the console imports through
// no path — it reaches this pane by CALLING `registerTimelineRowRenderer`. So the
// body here is a slot that reads the seat, and a row body written under `console/`
// for one of those entry types would be this family authoring somebody else's work.
//
// WHY THE TWO CONTROLS ARE HOST-SUPPLIED AND ABSENT WITHOUT A HOST. Closing a pane
// and tearing one off into a window are both the DECK's acts — it owns which panes
// exist and in what window. The honest rendering of a control whose act nobody can
// perform is to leave it out, not to draw it disabled: that is the same
// absent-not-disabled rule `src/shared/auxiliary-routes.ts` applies to the Window
// menu, and it is why neither handler is defaulted to a no-op. Inside the deck the
// acts arrive through `workspace/deck/pane-controls.ts`; outside it — the auxiliary
// timeline window, the full-width surface — no host is mounted and no control
// renders. Explicit props still win, for a host that owns this pane's lifetime and
// is not a deck.
//
// THE HEADER ITSELF IS ANOTHER FAMILY'S, AND IT ARRIVES AS A COMPOSITION ARGUMENT.
// Eleven pane kinds across six view families want the same strip, and written per
// family it is six breadcrumbs and six sets of accessible names that agree until one
// of them ships. So there is one header, and it is `workspace/`'s — a SIBLING view
// family, which this one may not import: view families are siblings rather than a
// ladder, and `structure:layering`'s `console-view-family-isolation` rule reports the
// edge. The component is passed in instead, by the pane board that composes both, on
// the same terms as the session workspace's own body one directory up. What this pane
// supplies is what genuinely differs: its kind, its name, the address its breadcrumb
// reads, and the heading id its own `<section>` points at.

import { useId, type ComponentType } from "react";

import { routeSessionId } from "../../routing/index.js";
import { useFrameStore, type ConsoleEntityRef } from "../../store/index.js";
import { tokenReference } from "../../tokens/index.js";
import {
  timelineRowRenderer,
  type ConsolePaneContext,
  type OwnerSlotContract,
  type PaneKind,
} from "../../seats/index.js";
import { TimelineRowHost } from "./TimelineRowHost.js";

/**
 * Who owns the rows, what this pane owes them, and where the shell dies.
 *
 * DEVELOPER-FACING AND NEVER RENDERED — every member names work in flight, and the
 * empty state below names the FEATURE that has not been built while this names the
 * people building it.
 *
 * AND THE GOVERNANCE IDS LIVE IN THIS COMMENT RATHER THAN IN THE VALUES. The owner
 * is Plan-013 Phase 4, authoring the `Spec-013 §Timeline Entry Types` vocabulary in
 * `renderer/src/timeline/`, and that is what every member below is about — but the
 * repository's standing rule keeps those ids out of runtime strings, because a
 * string is one bad render away from a participant's screen and a comment is not.
 * The suite beside this file asserts the absence rather than trusting it.
 */
export const TIMELINE_ROW_SLOT: OwnerSlotContract = {
  owningTask: "the timeline row vocabulary, authored in renderer/src/timeline/",
  mountObligation:
    "the projected row wire-verbatim, the author's hue assignment, whether a later rollback boundary supersedes it, and the list's collapse state for it",
  deleteShellIn:
    "the PR that registers the real row renderer — the seat is owner-scoped, so a shell left registered beside it refuses the real one by name",
};

/** Carries the pane's focus ring colour into the chrome's boundary rules. */
interface PaneFocusStyle extends React.CSSProperties {
  readonly "--meridian-pane-hue": string;
}

/**
 * The pane context, narrowed to the arm this body can serve.
 *
 * `ConsolePaneAddress` is a discriminated union over the pane kind, so narrowing on
 * `kind` narrows the entity with it: this pane's entity is a channel reference or
 * nothing, and an artifact or a run reference is not representable here. The narrowing
 * is the type's whole purpose — a body handed an address it cannot serve would query a
 * partition that has never held the row and render as permanently missing.
 *
 * AND THE ENTITY IS THE PANE'S SCOPE, NOT DECORATION. A channel address used to
 * reach the header's breadcrumb and stop there, while the body below it was handed
 * the whole session store — so a pane headed by one channel rendered every
 * channel's rows, and the header was the only thing on screen saying otherwise.
 */
export type TimelinePaneContext = Extract<ConsolePaneContext, { readonly kind: "timeline" }>;

/**
 * What this pane hands the header it is composed with.
 *
 * DECLARED HERE RATHER THAN IMPORTED, because the component itself is another view
 * family's and a type-only import is still an edge the layering cruise reads —
 * `tsPreCompilationDeps` puts type positions in the graph on purpose, so a family
 * could not otherwise be told from the shape of its neighbour. This is the same act
 * `ledger/index.ts` performs for the workspace body it is handed: the CONSUMER states
 * what it supplies, and the composition site is where a component that satisfies it is
 * named. Structural typing does the rest — a header taking more optional props than
 * these is assignable, and one demanding a prop this pane never supplies is not.
 */
export interface LedgerPaneHeaderProps {
  readonly kind: PaneKind;
  /** The pane's name, sentence case. Also the noun the open-in-window label uses. */
  readonly title: string;
  /** The id the pane's own `aria-labelledby` points at. */
  readonly headingId: string;
  readonly sessionId: string | undefined;
  readonly entity: ConsoleEntityRef | undefined;
  /** Overrides the host's close, where the caller owns this pane's lifetime. */
  readonly onClose?: () => void;
  /** Overrides the host's detach, on the same terms. */
  readonly onOpenInWindow?: () => void;
}

export interface TimelinePaneProps {
  readonly context: TimelinePaneContext;
  /** The shared pane chrome, named by whichever composition mounts this body. */
  readonly paneHeader: ComponentType<LedgerPaneHeaderProps>;
  /** Supplied by whatever owns this pane's lifetime. Absent, no close is offered. */
  readonly onClose?: () => void;
  /** Supplied where a host can open the pane in a window of its own
   * (`Spec-023 §The surface set`, auxiliary windows). */
  readonly onOpenInWindow?: () => void;
}

export function TimelinePane(props: TimelinePaneProps): React.JSX.Element {
  const headingId = useId();
  const { context, paneHeader: PaneHeader } = props;

  // Read through the store's own selector rather than off a snapshot: the pane has
  // to follow a navigation that changes which session it is a log of, and a
  // render-time snapshot read would leave it showing the session before last.
  const route = useFrameStore(context.frameStore, (state) => state.route);

  const focusStyle: PaneFocusStyle = {
    "--meridian-pane-hue": context.focusHue ?? tokenReference("edge-strong"),
  };

  return (
    <section
      className="meridian-pane meridian-pane--timeline"
      style={focusStyle}
      aria-labelledby={headingId}
    >
      <PaneHeader
        kind="timeline"
        title="Timeline"
        headingId={headingId}
        sessionId={routeSessionId(route)}
        entity={context.entity}
        {...(props.onClose === undefined ? {} : { onClose: props.onClose })}
        {...(props.onOpenInWindow === undefined ? {} : { onOpenInWindow: props.onOpenInWindow })}
      />
      <TimelineRowHost
        contract={TIMELINE_ROW_SLOT}
        body={timelineRowRenderer()}
        sessionStore={context.sessionStore}
        {...(context.entity === undefined ? {} : { channelId: context.entity.id })}
      />
    </section>
  );
}
