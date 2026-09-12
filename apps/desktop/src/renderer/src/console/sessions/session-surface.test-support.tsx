// The harness this destination's test files drive it through: the mount, the settle,
// and the queries over what it drew.
//
// Hoisted on second use, per `apps/desktop/AGENTS.md`. The files ask different
// questions — one about the LIST and the act of starting a session, another about the
// two session-scoped reads in the aside, and the binding's own about how long the
// rail's count lives — but they mount the same destination against the same faked
// context, and a second copy of `settle` in particular would let them disagree about
// how many passes the read chain needs without any one of them failing.
//
// THE FAKED CONTEXT IS THE SIBLING MODULE, `session-surface.context.test-support.ts`.
// The two are one seam apart — a case composes a context there and hands it to the
// mount here — and neither imports the other, which is what let them split when the
// pair outgrew one file.

import { act, render } from "@testing-library/react";

import { ManualClock } from "../core/index.js";
import {
  PAST_REFRESH_DEBOUNCE_MS,
  settle as settleReactWork,
} from "../core/settle.test-support.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "../primitives/index.js";
import { politeText } from "../primitives/announce/live-region.test-support.js";
import { SidekicksBridgeProvider } from "../bridge/index.js";
import { SessionAttentionBinding } from "./SessionAttentionBinding.js";
import { SessionsSurface } from "./SessionsSurface.js";
import type { ConsoleSurfaceContext, NewSessionControlComponent } from "../seats/index.js";

/**
 * Let the destination's asynchronous arrivals land.
 *
 * Two reads settle behind this destination — the attention projection and the node's
 * session directory — and each settles an effect that can schedule the next, so the
 * count is the depth of that chain rather than a number picked to make a test pass.
 * Both are performed by the binding ABOVE the surface now rather than by the surface,
 * which changes where they are mounted and not how long the chain is.
 *
 * The attention read is the one that also costs TIME. It goes through the console's
 * one refresh scheduler, so its first read lands a debounce interval after the
 * subscribe rather than on the next microtask — and the bridge this file builds
 * carries no scenario engine, so that interval is measured on the wall clock. A
 * surface driven against the real fixture advances the frozen clock instead.
 */
export async function settle(): Promise<void> {
  await settleReactWork();
  await act(async () => {
    await new Promise((resolveAfterDebounce) => {
      setTimeout(resolveAfterDebounce, PAST_REFRESH_DEBOUNCE_MS);
    });
  });
}

/**
 * The absence the LIST is rendering, as its kind classes.
 *
 * Scoped to the list region deliberately. The aside beside it holds the attention
 * panel, which renders its own honest absence, so an unscoped query would answer with
 * whichever of the two came first in the document and would pass or fail for reasons
 * that have nothing to do with the directory.
 */
export function listAbsenceKinds(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-sessions__list .meridian-nothing")].flatMap(
    (element) => [...element.classList].filter((name) => name.startsWith("meridian-nothing--")),
  );
}

/**
 * Mount the destination the way the frame does: under the bridge provider and the
 * console's one announcer.
 *
 * THE CONTEXT rather than an element, because the mount now has two things to do with
 * it — hand it to the surface and supply it to the provider — and a helper that took
 * the composed element could reach neither. The provider is part of the shape under
 * test: its own error says every console surface renders inside one.
 *
 * THE SURFACE'S OWN ELEMENT IS RETURNED, not the render container — the
 * `settings/pages/application/updates/UpdatesBlock.reading.test.tsx` shape, and here it is
 * load-bearing rather
 * than tidy. The provider's two live regions are siblings ABOVE this surface, and
 * they carry the settlement sentence, so a case asserting the panel does not say
 * "Nothing needs you." would otherwise be reading the announcement of exactly that
 * and failing for a reason that has nothing to do with what is on screen.
 *
 * The announcer runs on a `ManualClock` so its hold window is frozen: whether a
 * sentence is still standing is otherwise a question about how fast the runner was.
 *
 * The composed-session control is a STAND-IN, and it has to be one: the real control
 * is the workspace family's, this module is a sibling view family's, and a
 * `.test-support` module is a subject of `console-view-family-isolation` like any
 * other — only `*.test.*` is excluded from that cruise. It is also the right shape
 * for what this file drives: the surface hands the control a bridge and a settlement
 * and places what it renders, so every case here is about the destination's own
 * chrome, and the control's behaviour is asserted where the control lives.
 *
 * A CASE ABOUT THE SETTLEMENT SUPPLIES ITS OWN. What this destination owes a composed
 * create is the four things `acts/session-start.ts` does, and the only way to drive
 * them from here is a control that calls the callback it was handed — so the stand-in
 * is replaceable and the default one calls nothing, which is what keeps every other
 * suite's tree the shape it was.
 */
export function renderSurface(
  context: ConsoleSurfaceContext,
  options: { readonly newSessionControl?: NewSessionControlComponent } = {},
): {
  readonly container: HTMLElement;
  readonly politeText: () => string;
} {
  const announcer = new LiveAnnouncer({ clock: new ManualClock() });
  const mounted = render(
    <SidekicksBridgeProvider bridge={context.bridge}>
      <LiveAnnouncerProvider announcer={announcer}>
        {/*
          The window's attention binding, mounted the way the frame mounts it. It is
          part of the shape under test rather than scaffolding: the destination reads
          the projection and the node's directory THROUGH it now, so a harness that
          omitted it would be driving a surface no composition produces — and the one
          it would produce is the one this seat exists to retire.
        */}
        <SessionAttentionBinding
          context={{
            bridge: context.bridge,
            frameStore: context.frameStore,
            sessionStoreRegistry: context.sessionStoreRegistry,
          }}
        >
          <SessionsSurface
            context={context}
            newSessionControl={options.newSessionControl ?? InertNewSessionControl}
          />
        </SessionAttentionBinding>
      </LiveAnnouncerProvider>
    </SidekicksBridgeProvider>,
  ).container;
  const surfaceRoot = mounted.querySelector<HTMLElement>("section.meridian-sessions");
  if (surfaceRoot === null) {
    throw new Error("the sessions destination did not render");
  }
  return {
    container: surfaceRoot,
    politeText: () => politeText(mounted),
  };
}

/**
 * The composed-draft control every case that is not about it gets.
 *
 * Renders the marker and calls nothing: a stand-in that settled a start would put a
 * navigation and a store open into suites whose subject is the list's chrome, and one
 * that rendered a control a person could press would change what every
 * `getByRole("button")` in those suites resolves.
 */
function InertNewSessionControl(): React.JSX.Element {
  return <span data-new-session-control>the composed-session control</span>;
}
