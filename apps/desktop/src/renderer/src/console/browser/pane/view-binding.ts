// The native view this pane holds: attached when the pane mounts, torn down when it goes.
//
// `Spec-023 §Console Design (Meridian)` 12.1 gives the pane host two operations and
// says they are one pair — a view is created or adopted for a pane, and it is torn
// down again, idempotently, because window teardown fires the same call. Neither had a
// production caller. A pane opened through the deck's registry started five
// subscriptions and every one of its acts against a `paneId` no view had ever been
// created for, and closing that pane disposed the renderer's subscriptions and its
// geometry publisher while the main-process view went on painting over a rectangle
// nobody was reporting any more.
//
// SO THE PAIR HAS ONE OWNER, AND IT IS THIS MODULE. Attach and detach are not two
// lifecycles that happen to be adjacent: the detach is admissible exactly when the
// attach was SERVED, and a second owner for either half would have to re-derive that
// fact from something. The binding below holds it as the one thing it knows about
// itself.
//
// ATTACH IS THE FIRST THING THE PANE DOES, AND THAT IS STRUCTURAL RATHER THAN A
// CONVENTION. The console's subject-scoped resource holder opens a resource DURING the
// render that first sees a new subject, so a binding minted through it dispatches
// before the first commit — and therefore before any child's subscription effect,
// which React runs child-first and would otherwise put ahead of anything this
// component's own effects could do.
//
// AND THE SUBSCRIPTIONS WAIT FOR ITS ANSWER, which is the pane's composition rather
// than this module's: `BrowserPane.tsx` renders the steering body only once this
// reading says there is a view to steer, or that no view was ever asked for. A read
// opened against a pane with no view is a question about nothing.
//
// THE TWO ABSENCES ARE TWO ARMS AND NOT ONE. `unasked` is the build whose browser
// namespace is not registered anywhere in the corpus — nobody asked, the pane draws
// its chrome, and every surface inside it renders its own not-checked absence, which
// is what that build is designed to show. `refused` is a wire that ANSWERED and said
// no: there is no view, and the pane says so instead of offering controls over one.
// `bridge/growth-port/growth-outcome.ts` owns that reading and this module calls it
// rather than re-deriving it from a code comparison.
//
// A BINDING OUTLIVES ITS SUBJECT, so every rule here is about the pass where the state
// still holds the previous `(bridge, paneId)`. The holder addresses the resource by its
// subject, so a reply for a retired subject reaches a binding nothing renders — and
// that binding's own disposal has already sent its detach.

import { useCallback, useSyncExternalStore } from "react";

import { isUnbuiltWireRefusal, type ConsoleBridge } from "../../bridge/index.js";
import {
  Emitter,
  normalizeWireRejection,
  reportTripwire,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../../core/index.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "../../store/index.js";
import type { PaneSubject } from "./geometry-binding.js";
import type { BrowserPaneRejectionFallback } from "./pane-refusals.js";

/** The subsystem name every refusal this module raises itself carries. */
const VIEW_BINDING_REFUSAL_ORIGIN = "browser-view-binding";

/**
 * The site a refused teardown is reported from, spelled as this module's own path.
 *
 * Exported on `INGEST_ABORT_SITE`'s precedent: the case that drives the teardown reads
 * the record back, and a literal restated there would pass over a report filed from
 * anywhere else in the tree.
 */
export const VIEW_BINDING_SITE = "console/browser/pane/view-binding.ts";

/**
 * What an attach that never answered says, where the rejection carries no code.
 *
 * Distinct from the composer entry's `pane-attach-failed`, and the difference is what a
 * person can do about it: that one is a menu row that did not attach a page to a
 * conversation, and this one is a pane that has no view at all. A pane rendering the
 * entry's sentence would name a conversation nobody was writing in.
 */
const ATTACH_CALL_FALLBACK: BrowserPaneRejectionFallback = {
  code: "view-attach-failed",
  detail:
    "This pane has no page view, because the call that would have created one never answered. Closing the pane and opening it again asks for a view once more.",
};

/**
 * What a teardown that never answered is RECORDED as. It renders nowhere.
 *
 * By the time this is composed the surface that would have shown it is gone, which is
 * the whole reason the refused arm reaches the diagnostic band instead. It is still one
 * of this pane's own codes rather than a free string, because the pane is what authored
 * the sentence.
 */
const DETACH_CALL_FALLBACK: BrowserPaneRejectionFallback = {
  code: "view-detach-failed",
  detail: "The call that would have torn this pane's page view down never answered.",
};

/** The attach operation's own outcome type, and the page shape read out of it. */
type AttachOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserPaneAttach"]>>;
type AttachedPage = Extract<AttachOutcome, { readonly status: "served" }>["value"]["page"];

/**
 * Whether this pane has a view, and if not, which kind of not.
 *
 * Four arms, on `NavigationReading`'s own reasoning one module over: each is a
 * different fact about the same pane and each has a different next move. Collapsing the
 * two absences would tell a person the console had been told no when in truth it had
 * never asked, which is exactly the collapse rule 8 forbids.
 */
export type PaneViewAttachment =
  /** The call is out and nothing has answered. Not "no view" — no answer yet. */
  | { readonly kind: "attaching" }
  | { readonly kind: "attached"; readonly page: AttachedPage }
  /** No wire for this operation is registered in this build. Nobody asked. */
  | { readonly kind: "unasked"; readonly refusal: ConsoleRefusal }
  /** The call was put and answered no, or it rejected. There is no view. */
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** The reading before anything has answered, held once so its identity is stable. */
const ATTACHING_VIEW: PaneViewAttachment = { kind: "attaching" };

/**
 * One pane's view, from the call that creates it to the call that tears it down.
 *
 * A class with private fields rather than a pair of hooks, because the invariant that
 * makes the pair correct — a detach is sent if and only if an attach was served — is
 * state, and a hook holding it in a ref would put the decision at whichever call site
 * read the ref.
 */
class BrowserPaneViewBinding {
  readonly #bridge: ConsoleBridge;
  readonly #paneId: string;
  readonly #changes = new Emitter<void>("browser pane view attachment");

  #attachment: PaneViewAttachment = ATTACHING_VIEW;
  #isAttached = false;
  #isDisposed = false;

  /**
   * Minting one ASKS FOR THE VIEW. There is no second `start()` a caller could forget:
   * the holder opens this during the render that first addresses the subject, so
   * construction is the earliest moment a view can be asked for and any later one would
   * be behind a subscription effect.
   */
  public constructor(subject: PaneSubject) {
    this.#bridge = subject.bridge;
    this.#paneId = subject.paneId;
    void this.#attach();
  }

  /** Stable between publishes, which is what `useSyncExternalStore` requires of it. */
  public get attachment(): PaneViewAttachment {
    return this.#attachment;
  }

  /** Whether this binding's own teardown has already run. Read by the holder. */
  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  public subscribe(onChange: () => void): Unsubscribe {
    return this.#changes.subscribe(onChange);
  }

  /**
   * End this binding, and give the view back where there is one to give.
   *
   * TERMINAL, AND IDEMPOTENT. The holder disposes a value that no commit ever saw as
   * well as one a mount is giving up, and React's double mount runs the committed
   * cleanup and then re-commits the same instance — so this may be reached twice for
   * one binding, and the second reach must not send a second teardown.
   *
   * BEST-EFFORT, NEVER A BLOCKED UNMOUNT. Nothing waits on the answer: the pane is
   * already gone by the time one arrives, so a refusal reaches the diagnostic band and
   * an unmount is never held up by a call that may not answer at all.
   */
  public dispose(): void {
    if (this.#isDisposed) {
      return;
    }
    this.#isDisposed = true;
    if (!this.#isAttached) {
      // Either nothing was ever created — so there is nothing to tear down and a
      // teardown sent anyway would be a call about a pane the host never heard of — or
      // the attach is still in flight, and the continuation below owns it from here.
      return;
    }
    void this.#detach();
  }

  /**
   * Ask for the view, and settle this binding on whatever came back.
   *
   * WHOEVER FINISHES LAST OWNS THE VIEW. A pane opened and closed inside one round trip
   * disposes while this call is still out, and the view the reply carries would then be
   * resident for the life of the window with no renderer left that knows it exists. So
   * a reply that lands after disposal tears itself down here or never.
   */
  async #attach(): Promise<void> {
    const settled = await this.#requestAttach();
    if (settled.kind === "attached") {
      this.#isAttached = true;
      if (this.#isDisposed) {
        void this.#detach();
        return;
      }
    }
    this.#publish(settled);
  }

  /** The call, with its two failure shapes read into this module's own reading. */
  async #requestAttach(): Promise<PaneViewAttachment> {
    try {
      const outcome = await this.#bridge.growth.browserPaneAttach({ paneId: this.#paneId });
      if (outcome.status === "served") {
        return { kind: "attached", page: outcome.value.page };
      }
      return isUnbuiltWireRefusal(outcome)
        ? { kind: "unasked", refusal: outcome }
        : { kind: "refused", refusal: outcome };
    } catch (failure) {
      // A rejection is the transport going away rather than the host saying no, and it
      // travels through the console's one rejection reader so a code the other side
      // sent survives instead of being re-coded under this module's name.
      return {
        kind: "refused",
        refusal: normalizeWireRejection(VIEW_BINDING_REFUSAL_ORIGIN, failure, ATTACH_CALL_FALLBACK),
      };
    }
  }

  /**
   * Give the view back, and record a host that answered and did not.
   *
   * THE `unasked` ARM IS NOT A REFUSED TEARDOWN. That code means this console's own
   * port declined before any request left the process, so nothing was asked and nothing
   * refused — the same distinction the attach path draws, applied to a call whose answer
   * no surface renders. Recording it would put a firing on the diagnostic band for a
   * build that is designed to serve none of these operations.
   *
   * EVERY OTHER CODE IS A HOST THAT ANSWERED AND KEPT THE VIEW. The view goes on
   * holding its partition and painting over a rectangle nobody publishes any more, and
   * the pane that would have said so has unmounted — so this record is the only place an
   * operator can see it.
   */
  async #detach(): Promise<void> {
    const refusal = await this.#requestDetach();
    if (refusal === undefined || isUnbuiltWireRefusal(refusal)) {
      return;
    }
    reportTripwire(
      "cleanup-refused",
      VIEW_BINDING_SITE,
      `the host answered the teardown of the page view for pane ${this.#paneId} with \`${refusal.code}\` and did not release it; that view holds its partition and paints over a rectangle nothing publishes any more`,
    );
  }

  /** The teardown call, answering with the refusal to record or nothing at all. */
  async #requestDetach(): Promise<ConsoleRefusal | undefined> {
    try {
      const outcome = await this.#bridge.growth.browserPaneDetach({ paneId: this.#paneId });
      return outcome.status === "served" ? undefined : outcome;
    } catch (failure) {
      return normalizeWireRejection(VIEW_BINDING_REFUSAL_ORIGIN, failure, DETACH_CALL_FALLBACK);
    }
  }

  /** Record a reading and wake the surface, unless this binding is already over. */
  #publish(attachment: PaneViewAttachment): void {
    if (this.#isDisposed) {
      return;
    }
    this.#attachment = attachment;
    this.#changes.emit();
  }
}

/** Ends a binding. Terminal: the teardown call is one-way. */
function closeViewBinding(bound: BrowserPaneViewBinding): void {
  bound.dispose();
}

/** Whether a binding's own disposal has already run, however it was reached. */
function isViewBindingClosed(bound: BrowserPaneViewBinding): boolean {
  return bound.isDisposed;
}

/**
 * How the holder ends a binding, and how it reads one that already ended.
 *
 * A terminal disposal rather than a release, on `geometry-binding.ts`'s own reasoning
 * beside it: a disposed binding has given its view back and can never ask for another,
 * so React's double mount has to be handed a fresh one rather than the corpse the first
 * mount's cleanup left. Declared at module level so both members keep one identity
 * across every render.
 */
const BROWSER_PANE_VIEW_DISPOSAL: SubjectScopedDisposal<BrowserPaneViewBinding> = {
  dispose: closeViewBinding,
  isClosed: isViewBindingClosed,
};

/**
 * Hold this pane's view for the life of the mount, and render what the host said.
 *
 * Subscribed rather than copied, for `useGeometryPublisher`'s reason: the attach
 * settles asynchronously, so a value read straight after the mint is the pending arm by
 * construction, and an outcome recorded between this component's render and an effect's
 * subscription is missed by the effect shape — which for a refusal is silent.
 */
export function useBrowserPaneView(bridge: ConsoleBridge, paneId: string): PaneViewAttachment {
  const openBinding = useCallback(
    () => new BrowserPaneViewBinding({ bridge, paneId }),
    [bridge, paneId],
  );
  const { value: binding } = useSubjectScopedResource(
    bridge,
    paneId,
    openBinding,
    BROWSER_PANE_VIEW_DISPOSAL,
  );
  const subscribe = useCallback((onChange: () => void) => binding.subscribe(onChange), [binding]);
  const readAttachment = useCallback(() => binding.attachment, [binding]);
  return useSyncExternalStore(subscribe, readAttachment, readAttachment);
}
