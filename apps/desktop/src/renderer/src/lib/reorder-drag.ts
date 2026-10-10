// Reordering a row or a stack of items by dragging one with the pointer.
//
// Every window a person sees is drawn from the hidden console document through a portal, and
// that document never paints: its `requestAnimationFrame` never fires and listeners on its
// `document` hear nothing from another window. So every listener here is bound to the pressed
// item's own document, every animation runs on the item itself, and the reduced-motion setting is
// read from the item's own window. The item's `transform` is written in the `pointermove`
// handler, so it is drawn in the frame the pointer moved in; the one frame loop is the edge
// scroll's, on frames from the item's own window, and it runs only while the pointer holds near
// an end of a list that scrolls.
//
// A press becomes a drag once the pointer travels past a small distance, and only then is pointer
// capture taken, so a click on a control inside the grip still reaches that control. The lifted
// item follows the pointer by `transform`; its neighbors glide aside, each from where it is drawn
// to where it makes room. The order commits once, on release, and the drawn positions are held
// until the caller hands back the new order; then every item glides from where it is drawn to its
// new place (FLIP). Escape, a canceled pointer and lost capture glide everything back. Every
// move it draws is announced as scripted motion, since an inline `transform` and
// `element.animate()` fire no event that says something moved.

import { type Clock, type ScheduledHandle } from "./clock.js";
import { prefersReducedMotion } from "./reduced-motion.js";
import { announceScriptedMotion } from "./scripted-motion.js";
import { scrollForReorderDrag } from "./scroll/chokepoint.js";

/** Which way the items run: a row (`horizontal`) or a stack (`vertical`). */
export type ReorderAxis = "horizontal" | "vertical";

/** How a `ReorderDrag` moves its items and where it commits a new order. */
export interface ReorderDragOptions<Key extends string> {
  readonly axis: ReorderAxis;
  /** How long a glide runs, in milliseconds; a window asking for reduced motion gets none. */
  readonly glideMs: number;
  /** The glide's easing, as a Web Animations `easing` string. */
  readonly glideEasing: string;
  /** Where the edge scroll's frames come from; paced by the pressed item's own window. */
  readonly clock: Clock;
  /**
   * Commits a move: the item under `key` goes to `toIndex` in the order with it taken out. Called
   * once per drag, on release, and only when the index changed.
   */
  readonly onReorder: (key: Key, toIndex: number) => void;
  /** Called on a release that leaves the order as it was, for an owner that says so. */
  readonly onDropInPlace?: (key: Key) => void;
  /** True where an item with no registered handle cannot be dragged at all. */
  readonly isHandleRequired?: boolean;
  /** A place outside the list a drag can be let go on, as a pane is dragged past a column. */
  readonly beyond?: ReorderDropBeyond<Key>;
}

/**
 * A place outside the list's own room an item can be dropped on. While the pointer is over it the
 * neighbors close back up; a release there hands the item to `onDrop` instead of reordering, and
 * the owner calls `settle` once it has laid the list out again.
 */
export interface ReorderDropBeyond<Key extends string> {
  /** Whether the pointer, in the item's window's viewport pixels, is over that place. */
  readonly contains: (pointerX: number, pointerY: number) => boolean;
  /** The pointer went over that place or left it, for a mark to show where the drop lands. */
  readonly onHover: (isOver: boolean) => void;
  readonly onDrop: (key: Key) => void;
}

/**
 * One list's pointer reorder. Items register through `itemRef`; an item whose drag starts only
 * from part of it (a pane's header) registers that part through `handleRef`. The caller hands the
 * order it draws to `setOrder` after every render. While lifted, an item carries
 * `data-reorder-lifted` and a `z-index`, so it must be a flex or grid item or positioned. Held
 * near an end of the nearest ancestor that scrolls along the axis, the drag scrolls it.
 */
export class ReorderDrag<Key extends string> {
  readonly #options: ReorderDragOptions<Key>;
  readonly #items = new Map<Key, RegisteredItem>();
  readonly #handles = new Map<Key, HTMLElement>();
  readonly #itemRefs = new Map<Key, (element: HTMLElement | null) => void>();
  readonly #handleRefs = new Map<Key, (element: HTMLElement | null) => void>();
  /** The glides this controller started, so it never cancels an animation it does not own. */
  readonly #glides = new Map<Key, Animation>();
  #order: readonly Key[] = [];
  #gesture: Gesture<Key> | undefined;
  /** The committed drag's order and where each item rested in it, until the new order arrives. */
  #awaitedCommit: AwaitedCommit<Key> | undefined;

  readonly #onPointerMove = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (gesture?.pointerId !== event.pointerId) {
      return;
    }
    if (gesture.phase === "pressed") {
      if ((event.buttons & PRIMARY_BUTTON) === 0) {
        // Released outside the window before the drag began, so no `pointerup` reached us.
        this.#endGesture(gesture);
        return;
      }
      const travel = Math.hypot(event.clientX - gesture.pressX, event.clientY - gesture.pressY);
      if (travel >= DRAG_START_DISTANCE_PX) {
        this.#follow(this.#lift(gesture), event.clientX, event.clientY);
      }
      return;
    }
    this.#follow(gesture, event.clientX, event.clientY);
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (gesture?.pointerId !== event.pointerId) {
      return;
    }
    // Listeners go first, so the capture loss that follows a release is not read as a cancel.
    this.#endGesture(gesture);
    if (gesture.phase === "pressed") {
      return;
    }
    const beyond = this.#options.beyond;
    if (gesture.isBeyond && beyond !== undefined) {
      beyond.onHover(false);
      // The item stays where the hand left it until the owner lays the list out and settles.
      this.#awaitedCommit = {
        keys: gesture.slots.map((slot) => slot.key),
        slots: gesture.slots,
        scroller: gesture.scroller,
      };
      beyond.onDrop(gesture.key);
      return;
    }
    if (gesture.to === gesture.from) {
      this.#settle(undefined);
      this.#options.onDropInPlace?.(gesture.key);
      return;
    }
    const home = slotAt(gesture.slots, gesture.from);
    const target = slotAt(gesture.slots, gesture.to);
    // Where the item's start lands once it takes the target's place in the order.
    const landing =
      gesture.to > gesture.from ? target.start + target.size - home.size : target.start;
    this.#glide(home, this.#drawnOffset(gesture, home), landing - home.start, gesture.glideMs);
    this.#awaitedCommit = {
      keys: gesture.slots.map((slot) => slot.key),
      slots: gesture.slots,
      scroller: gesture.scroller,
    };
    this.#options.onReorder(home.key, gesture.to);
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.#gesture?.phase !== "lifted") {
      return;
    }
    // The Escape belongs to the drag; nothing behind it closes as well.
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  };

  readonly #onLost = (event: PointerEvent): void => {
    if (event.pointerId === this.#gesture?.pointerId) {
      this.cancel();
    }
  };

  public constructor(options: ReorderDragOptions<Key>) {
    this.#options = options;
  }

  /**
   * A ref callback registering the element that moves for `key`, the same function for as long
   * as `key` stays in the order, so a render never re-binds the element.
   */
  public itemRef(key: Key): (element: HTMLElement | null) => void {
    let ref = this.#itemRefs.get(key);
    if (ref === undefined) {
      ref = (element) => {
        this.#registerItem(key, element);
      };
      this.#itemRefs.set(key, ref);
    }
    return ref;
  }

  /**
   * A ref callback narrowing where `key`'s drag may start to `element`, stable on the same terms
   * as `itemRef`.
   */
  public handleRef(key: Key): (element: HTMLElement | null) => void {
    let ref = this.#handleRefs.get(key);
    if (ref === undefined) {
      ref = (element) => {
        if (element === null) {
          this.#handles.delete(key);
        } else {
          this.#handles.set(key, element);
        }
      };
      this.#handleRefs.set(key, ref);
    }
    return ref;
  }

  /**
   * Takes the order the caller draws. A change while an item is lifted cancels the drag, as does
   * a press whose item left the order; the first change after a commit glides every item into
   * its new place.
   */
  public setOrder(keys: readonly Key[]): void {
    if (sameOrder(keys, this.#order)) {
      return;
    }
    this.#order = [...keys];
    for (const refs of [this.#itemRefs, this.#handleRefs]) {
      for (const key of refs.keys()) {
        if (!keys.includes(key)) {
          refs.delete(key);
        }
      }
    }
    const gesture = this.#gesture;
    if (gesture?.phase === "lifted" || (gesture !== undefined && !keys.includes(gesture.key))) {
      this.cancel();
      return;
    }
    const awaited = this.#awaitedCommit;
    if (awaited !== undefined && !sameOrder(keys, awaited.keys)) {
      this.#awaitedCommit = undefined;
      this.#settle(awaited);
    }
  }

  /**
   * Glides every item from where it is drawn to where its layout puts it now. A caller whose
   * commit was refused calls this, since no new order will arrive to settle the drawn positions,
   * and so does an owner that laid the list out again after a drop beyond it. Nothing happens
   * once a new order has settled them.
   */
  public settle(): void {
    const awaited = this.#awaitedCommit;
    if (awaited === undefined) {
      return;
    }
    this.#awaitedCommit = undefined;
    this.#settle(awaited);
  }

  /** Ends a press or a drag without committing, gliding a lifted item back. */
  public cancel(): void {
    const gesture = this.#gesture;
    if (gesture === undefined) {
      return;
    }
    this.#endGesture(gesture);
    if (gesture.phase === "lifted") {
      if (gesture.isBeyond) {
        this.#options.beyond?.onHover(false);
      }
      this.#settle(undefined);
    }
  }

  #registerItem(key: Key, element: HTMLElement | null): void {
    const registered = this.#items.get(key);
    if (registered?.element === element) {
      return;
    }
    if (this.#gesture?.key === key) {
      // The pressed element went away or was replaced, so the gesture has nothing to move.
      this.cancel();
    }
    if (registered !== undefined) {
      registered.element.removeEventListener("pointerdown", registered.onPointerDown);
      this.#items.delete(key);
    }
    if (element === null) {
      this.#glides.get(key)?.cancel();
      this.#glides.delete(key);
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      this.#press(key, element, event);
    };
    element.addEventListener("pointerdown", onPointerDown);
    this.#items.set(key, { element, onPointerDown });
  }

  #press(key: Key, element: HTMLElement, event: PointerEvent): void {
    if (event.button !== 0 || this.#gesture !== undefined || !this.#order.includes(key)) {
      return;
    }
    const handle = this.#handles.get(key);
    if (
      handle === undefined
        ? this.#options.isHandleRequired === true
        : !event.composedPath().includes(handle)
    ) {
      return;
    }
    const ownerDocument = element.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow === null) {
      return;
    }
    if (this.#awaitedCommit !== undefined) {
      // A commit that never came back: the order drawn is still the old one, so put it back.
      this.settle();
    }
    const listeners = new ownerWindow.AbortController();
    this.#gesture = {
      phase: "pressed",
      key,
      element,
      ownerWindow,
      pointerId: event.pointerId,
      pressX: event.clientX,
      pressY: event.clientY,
      listeners,
    };
    const options = { signal: listeners.signal };
    const preventDefault = (blocked: Event): void => {
      blocked.preventDefault();
    };
    ownerDocument.addEventListener("pointermove", this.#onPointerMove, options);
    ownerDocument.addEventListener("pointerup", this.#onPointerUp, options);
    ownerDocument.addEventListener("pointercancel", this.#onLost, options);
    ownerDocument.addEventListener("keydown", this.#onKeyDown, { ...options, capture: true });
    // An image or a link inside the grip would start the browser's own drag, which ends ours,
    // and a press that moves would otherwise select the grip's text.
    ownerDocument.addEventListener("dragstart", preventDefault, options);
    ownerDocument.addEventListener("selectstart", preventDefault, options);
    element.addEventListener("lostpointercapture", this.#onLost, options);
  }

  #lift(gesture: PressedGesture<Key>): LiftedGesture<Key> {
    for (const glide of this.#glides.values()) {
      glide.cancel();
    }
    this.#glides.clear();
    const slots = this.#order.flatMap((key): Slot<Key>[] => {
      const item = this.#items.get(key);
      return item === undefined ? [] : [this.#slotOf(key, item.element)];
    });
    // The press is ended whenever its item leaves the order or its element changes, so it is here.
    const from = slots.findIndex((slot) => slot.key === gesture.key);
    const home = slotAt(slots, from);
    gesture.element.setPointerCapture(gesture.pointerId);
    gesture.element.setAttribute(LIFTED_ATTRIBUTE, "");
    gesture.element.style.zIndex = "1";
    const step = home.size + gapBeside(slots, from);
    const lifted: LiftedGesture<Key> = {
      ...gesture,
      phase: "lifted",
      slots,
      from,
      to: from,
      step,
      shifts: new Map(),
      glideMs: prefersReducedMotion(gesture.ownerWindow) ? 0 : this.#options.glideMs,
      scroller: this.#scrollerOf(gesture.element),
      frameClock: this.#options.clock.withFrames(gesture.ownerWindow),
      pointerX: gesture.pressX,
      pointerY: gesture.pressY,
      edgeScroll: undefined,
      isBeyond: false,
    };
    this.#gesture = lifted;
    announceScriptedMotion(gesture.element);
    return lifted;
  }

  #follow(gesture: LiftedGesture<Key>, pointerX: number, pointerY: number): void {
    gesture.pointerX = pointerX;
    gesture.pointerY = pointerY;
    const travel =
      this.#options.axis === "horizontal" ? pointerX - gesture.pressX : pointerY - gesture.pressY;
    // The layout moves back by what the list scrolled, so the item adds it to stay on the pointer.
    const offset = travel + this.#scrolledBy(gesture.scroller);
    gesture.element.style.transform = this.#translate(offset);
    announceScriptedMotion(gesture.element);
    const isBeyond = this.#options.beyond?.contains(pointerX, pointerY) ?? false;
    if (isBeyond !== gesture.isBeyond) {
      gesture.isBeyond = isBeyond;
      this.#options.beyond?.onHover(isBeyond);
    }
    const home = slotAt(gesture.slots, gesture.from);
    // Over the place beyond the list, the neighbors close back up behind the item.
    const to = isBeyond
      ? gesture.from
      : nearestSlot(gesture.slots, home.start + home.size / 2 + offset);
    if (to !== gesture.to) {
      gesture.to = to;
      this.#makeRoom(gesture);
    }
    this.#armEdgeScroll(gesture);
  }

  /** Arms one edge-scroll frame while the pointer holds inside an end of the scrolling list. */
  #armEdgeScroll(gesture: LiftedGesture<Key>): void {
    if (gesture.edgeScroll !== undefined || this.#edgeSpeed(gesture) === 0) {
      return;
    }
    gesture.edgeScroll = {
      armedAt: gesture.frameClock.now(),
      frame: gesture.frameClock.scheduleFrame(() => {
        this.#scrollAtEdge(gesture);
      }),
    };
  }

  #scrollAtEdge(gesture: LiftedGesture<Key>): void {
    const armed = gesture.edgeScroll;
    gesture.edgeScroll = undefined;
    const scroller = gesture.scroller;
    if (this.#gesture !== gesture || armed === undefined || scroller === undefined) {
      return;
    }
    const elapsedMs = gesture.frameClock.now() - armed.armedAt;
    const current = this.#scrollOffsetOf(scroller.element);
    const target = Math.min(
      Math.max(0, current + this.#edgeSpeed(gesture) * elapsedMs),
      scroller.maximumOffset,
    );
    scrollForReorderDrag(scroller.element, this.#options.axis, target);
    // Re-places the item over the scrolled list and arms the next frame while still at the edge.
    this.#follow(gesture, gesture.pointerX, gesture.pointerY);
  }

  /**
   * How fast the list scrolls, in CSS pixels per millisecond, signed along the axis: zero away
   * from its ends, rising to `EDGE_SCROLL_STEPS_PER_SECOND` steps a second at the very edge, and
   * zero once the list can scroll no further that way.
   */
  #edgeSpeed(gesture: LiftedGesture<Key>): number {
    const scroller = gesture.scroller;
    if (scroller === undefined) {
      return 0;
    }
    const rect = scroller.element.getBoundingClientRect();
    const horizontal = this.#options.axis === "horizontal";
    const [low, high] = horizontal ? [rect.left, rect.right] : [rect.top, rect.bottom];
    const pointer = horizontal ? gesture.pointerX : gesture.pointerY;
    // The edge band is half the lifted item, and never more than a quarter of the visible list.
    const band = Math.min(gesture.step / 2, (high - low) / 4);
    if (band <= 0) {
      return 0;
    }
    const current = this.#scrollOffsetOf(scroller.element);
    const fullSpeed = (gesture.step * EDGE_SCROLL_STEPS_PER_SECOND) / MILLISECONDS_PER_SECOND;
    if (pointer < low + band && current > 0) {
      return -fullSpeed * Math.min(1, (low + band - pointer) / band);
    }
    if (pointer > high - band && current < scroller.maximumOffset) {
      return fullSpeed * Math.min(1, (pointer - (high - band)) / band);
    }
    return 0;
  }

  /** The nearest ancestor that scrolls along the axis and has somewhere to scroll. */
  #scrollerOf(element: HTMLElement): Scroller | undefined {
    const ownerWindow = element.ownerDocument.defaultView;
    if (ownerWindow === null) {
      return undefined;
    }
    const horizontal = this.#options.axis === "horizontal";
    for (
      let ancestor = element.parentElement;
      ancestor !== null;
      ancestor = ancestor.parentElement
    ) {
      const style = ownerWindow.getComputedStyle(ancestor);
      const overflow = horizontal ? style.overflowX : style.overflowY;
      if (overflow !== "auto" && overflow !== "scroll") {
        continue;
      }
      // The extent at lift: a lifted item carried past the end must not grow what can scroll.
      const maximumOffset = horizontal
        ? ancestor.scrollWidth - ancestor.clientWidth
        : ancestor.scrollHeight - ancestor.clientHeight;
      if (maximumOffset > 0) {
        return {
          element: ancestor,
          startOffset: this.#scrollOffsetOf(ancestor),
          maximumOffset,
        };
      }
    }
    return undefined;
  }

  /** How far `scroller` has scrolled along the axis since the drag lifted. */
  #scrolledBy(scroller: Scroller | undefined): number {
    return scroller === undefined
      ? 0
      : this.#scrollOffsetOf(scroller.element) - scroller.startOffset;
  }

  #scrollOffsetOf(element: Element): number {
    return this.#options.axis === "horizontal" ? element.scrollLeft : element.scrollTop;
  }

  /** Glides each neighbor between the lifted item's home and its target aside by one step. */
  #makeRoom(gesture: LiftedGesture<Key>): void {
    gesture.slots.forEach((slot, index) => {
      if (index === gesture.from) {
        return;
      }
      let shift = 0;
      if (gesture.from < index && index <= gesture.to) {
        shift = -gesture.step;
      } else if (gesture.to <= index && index < gesture.from) {
        shift = gesture.step;
      }
      if (shift === (gesture.shifts.get(slot.key) ?? 0)) {
        return;
      }
      gesture.shifts.set(slot.key, shift);
      this.#glide(slot, this.#drawnOffset(gesture, slot), shift, gesture.glideMs);
    });
  }

  /**
   * Clears every transform this controller set and glides each item from where it is drawn to its
   * layout. `resting` is where the items sat before a committed reorder moved their elements, and
   * the list that scrolled under them; from it the drawn position is recovered once the new order
   * is laid out.
   */
  #settle(resting: AwaitedCommit<Key> | undefined): void {
    const items = [...this.#items];
    const drawnStarts = items.map(([, item]) => this.#startOf(item.element));
    for (const [key, item] of items) {
      this.#glides.get(key)?.cancel();
      item.element.style.transform = "";
      item.element.style.zIndex = "";
      item.element.removeAttribute(LIFTED_ATTRIBUTE);
    }
    this.#glides.clear();
    const layoutStarts = items.map(([, item]) => this.#startOf(item.element));
    const scrolled = this.#scrolledBy(resting?.scroller);
    items.forEach(([key, item], index) => {
      announceScriptedMotion(item.element);
      const ownerWindow = item.element.ownerDocument.defaultView;
      if (ownerWindow === null || prefersReducedMotion(ownerWindow)) {
        return;
      }
      const drawn = drawnStarts[index] ?? 0;
      const layout = layoutStarts[index] ?? 0;
      const restingSlot = resting?.slots.find((slot) => slot.key === key);
      // After a reorder the element sits in its new place still wearing its old offset, so the
      // spot it is drawn at is its old resting start, moved by what the list scrolled since, plus
      // that offset.
      const from =
        restingSlot === undefined
          ? drawn - layout
          : restingSlot.start - scrolled + drawn - 2 * layout;
      if (Math.abs(from) >= SETTLED_PX) {
        this.#glide({ key, element: item.element }, from, 0, this.#options.glideMs, false);
      }
    });
  }

  /** Animates `target`'s offset along the axis; a held glide keeps its end until settled. */
  #glide(
    target: Pick<Slot<Key>, "key" | "element">,
    from: number,
    to: number,
    durationMs: number,
    holds = true,
  ): void {
    this.#glides.get(target.key)?.cancel();
    const glide = target.element.animate(
      [{ transform: this.#translate(from) }, { transform: this.#translate(to) }],
      {
        duration: durationMs,
        easing: this.#options.glideEasing,
        fill: holds ? "forwards" : "none",
      },
    );
    this.#glides.set(target.key, glide);
    announceScriptedMotion(target.element);
  }

  #endGesture(gesture: Gesture<Key>): void {
    gesture.listeners.abort();
    if (gesture.phase === "lifted" && gesture.edgeScroll !== undefined) {
      gesture.frameClock.cancel(gesture.edgeScroll.frame);
      gesture.edgeScroll = undefined;
    }
    if (gesture.element.hasPointerCapture(gesture.pointerId)) {
      gesture.element.releasePointerCapture(gesture.pointerId);
    }
    this.#gesture = undefined;
  }

  /** How far `slot`'s element is drawn from where it sat when the drag began, scroll aside. */
  #drawnOffset(gesture: LiftedGesture<Key>, slot: Slot<Key>): number {
    return this.#startOf(slot.element) + this.#scrolledBy(gesture.scroller) - slot.start;
  }

  #startOf(element: HTMLElement): number {
    const rect = element.getBoundingClientRect();
    return this.#options.axis === "horizontal" ? rect.left : rect.top;
  }

  #slotOf(key: Key, element: HTMLElement): Slot<Key> {
    const rect = element.getBoundingClientRect();
    return this.#options.axis === "horizontal"
      ? { key, element, start: rect.left, size: rect.width }
      : { key, element, start: rect.top, size: rect.height };
  }

  #translate(offset: number): string {
    return this.#options.axis === "horizontal"
      ? `translateX(${String(offset)}px)`
      : `translateY(${String(offset)}px)`;
  }
}

/** The attribute a lifted item carries, for a stylesheet to raise it or hide what stays put. */
const LIFTED_ATTRIBUTE = "data-reorder-lifted";

/**
 * How far, in CSS pixels, a press travels before it becomes a drag: the platform's own drag
 * threshold (Windows' `SM_CXDRAG` is 4 by default), so a click that wobbles stays a click.
 */
const DRAG_START_DISTANCE_PX = 4;

/** An offset under half a pixel lands on the same device pixel at 2x: nothing to glide. */
const SETTLED_PX = 0.5;

/** The primary button's bit in `PointerEvent.buttons`. */
const PRIMARY_BUTTON = 1;

/**
 * How many item steps a second the list scrolls with the pointer at its very edge: a tab strip
 * of 150-pixel tabs moves 600 pixels a second, a gentle scroll that still crosses a long list.
 */
const EDGE_SCROLL_STEPS_PER_SECOND = 4;

const MILLISECONDS_PER_SECOND = 1000;

/** The list a drag scrolls, and where it stood when the drag lifted. */
interface Scroller {
  readonly element: Element;
  readonly startOffset: number;
  /** How far it could scroll at lift, in CSS pixels. */
  readonly maximumOffset: number;
}

/** A committed drag's order, where each item rested in it, and the list that scrolled under it. */
interface AwaitedCommit<Key extends string> {
  readonly keys: readonly Key[];
  readonly slots: readonly Slot<Key>[];
  readonly scroller: Scroller | undefined;
}

/** An item's element and the press listener bound to it. */
interface RegisteredItem {
  readonly element: HTMLElement;
  readonly onPointerDown: (event: PointerEvent) => void;
}

/** One item's span along the axis, in viewport pixels, measured when the drag began. */
interface Slot<Key extends string> {
  readonly key: Key;
  readonly element: HTMLElement;
  readonly start: number;
  readonly size: number;
}

/** A press that has not yet traveled far enough to be a drag. */
interface PressedGesture<Key extends string> {
  readonly phase: "pressed";
  readonly key: Key;
  readonly element: HTMLElement;
  readonly ownerWindow: Window;
  readonly pointerId: number;
  readonly pressX: number;
  readonly pressY: number;
  readonly listeners: AbortController;
}

/** A lifted item following the pointer. */
interface LiftedGesture<Key extends string> extends Omit<PressedGesture<Key>, "phase"> {
  readonly phase: "lifted";
  /** Every item in order, where it sat when the drag began. */
  readonly slots: readonly Slot<Key>[];
  readonly from: number;
  /** The index the item takes if released now. */
  to: number;
  /** How far a neighbor moves aside: the lifted item's size and the gap beside it. */
  readonly step: number;
  /** Each neighbor's current offset, so a glide starts only on a change. */
  readonly shifts: Map<Key, number>;
  readonly glideMs: number;
  readonly scroller: Scroller | undefined;
  /** The item's own window's frames, for the edge scroll. */
  readonly frameClock: Clock;
  /** Where the pointer last was, so an edge-scroll frame can re-place the item under it. */
  pointerX: number;
  pointerY: number;
  /** The armed edge-scroll frame and when it was armed, or `undefined` while none is. */
  edgeScroll: { readonly armedAt: number; readonly frame: ScheduledHandle } | undefined;
  /** Whether the pointer is over the place beyond the list. */
  isBeyond: boolean;
}

type Gesture<Key extends string> = PressedGesture<Key> | LiftedGesture<Key>;

function sameOrder<Key extends string>(left: readonly Key[], right: readonly Key[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function slotAt<Key extends string>(slots: readonly Slot<Key>[], index: number): Slot<Key> {
  const slot = slots[index];
  if (slot === undefined) {
    throw new Error(`No item sits at index ${String(index)} of a list of ${String(slots.length)}.`);
  }
  return slot;
}

/** The gap between the item at `index` and the one after it, or before it for the last. */
function gapBeside<Key extends string>(slots: readonly Slot<Key>[], index: number): number {
  const slot = slotAt(slots, index);
  const next = slots[index + 1];
  if (next !== undefined) {
    return next.start - (slot.start + slot.size);
  }
  const previous = slots[index - 1];
  return previous === undefined ? 0 : slot.start - (previous.start + previous.size);
}

/** The index of the slot whose center is nearest `center`. */
function nearestSlot<Key extends string>(slots: readonly Slot<Key>[], center: number): number {
  let nearest = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  slots.forEach((slot, index) => {
    const distance = Math.abs(slot.start + slot.size / 2 - center);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  });
  return nearest;
}
