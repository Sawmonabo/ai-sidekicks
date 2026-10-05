// Reordering a row or a stack of items by dragging one with the pointer.
//
// Every window a person sees is drawn from the hidden console document through a portal, and
// that document never paints: its `requestAnimationFrame` never fires and listeners on its
// `document` hear nothing from another window. So every listener here is bound to the pressed
// item's own document, every animation runs on the item itself, and the reduced-motion setting is
// read from the item's own window. No frame loop is used: the item's `transform` is written in the
// `pointermove` handler, so it is drawn in the frame the pointer moved in.
//
// A press becomes a drag once the pointer travels past a small distance, and only then is pointer
// capture taken, so a click on a control inside the grip still reaches that control. The lifted
// item follows the pointer by `transform`; its neighbors glide aside, each from where it is drawn
// to where it makes room. The order commits once, on release, and the drawn positions are held
// until the caller hands back the new order; then every item glides from where it is drawn to its
// new place (FLIP). Escape, a cancelled pointer and lost capture glide everything back.

import { prefersReducedMotion } from "./reduced-motion.js";

/** Which way the items run: a row (`horizontal`) or a stack (`vertical`). */
export type ReorderAxis = "horizontal" | "vertical";

/** How a `ReorderDrag` moves its items and where it commits a new order. */
export interface ReorderDragOptions<Key extends string> {
  readonly axis: ReorderAxis;
  /** How long a glide runs, in milliseconds; a window asking for reduced motion gets none. */
  readonly glideMs: number;
  /** The glide's easing, as a Web Animations `easing` string. */
  readonly glideEasing: string;
  /**
   * Commits a move: the item under `key` goes to `toIndex` in the order with it taken out. Called
   * once per drag, on release, and only when the index changed.
   */
  readonly onReorder: (key: Key, toIndex: number) => void;
}

/**
 * One list's pointer reorder. Items register through `itemRef`; an item whose drag starts only
 * from part of it (a pane's header) registers that part through `handleRef`. The caller hands the
 * order it draws to `setOrder` after every render. While lifted, an item carries
 * `data-reorder-lifted` and a `z-index`, so it must be a flex or grid item or positioned.
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
  #awaitedCommit:
    | { readonly keys: readonly Key[]; readonly slots: readonly Slot<Key>[] }
    | undefined;

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
        this.#follow(this.#lift(gesture), event);
      }
      return;
    }
    this.#follow(gesture, event);
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
    if (gesture.to === gesture.from) {
      this.#settle(undefined);
      return;
    }
    const home = slotAt(gesture.slots, gesture.from);
    const target = slotAt(gesture.slots, gesture.to);
    // Where the item's start lands once it takes the target's place in the order.
    const landing =
      gesture.to > gesture.from ? target.start + target.size - home.size : target.start;
    this.#glide(home, this.#drawnOffset(home), landing - home.start, gesture.glideMs);
    this.#awaitedCommit = { keys: gesture.slots.map((slot) => slot.key), slots: gesture.slots };
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

  /** A stable ref callback registering the element that moves for `key`. */
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

  /** A stable ref callback narrowing where `key`'s drag may start to `element`. */
  public handleRef(key: Key): (element: HTMLElement | null) => void {
    let ref = this.#handleRefs.get(key);
    if (ref === undefined) {
      ref = (element) => {
        if (element === null) {
          this.#handles.delete(key);
          this.#handleRefs.delete(key);
        } else {
          this.#handles.set(key, element);
        }
      };
      this.#handleRefs.set(key, ref);
    }
    return ref;
  }

  /**
   * Takes the order the caller draws. A change while an item is lifted cancels the drag; the
   * first change after a commit glides every item into its new place.
   */
  public setOrder(keys: readonly Key[]): void {
    if (sameOrder(keys, this.#order)) {
      return;
    }
    this.#order = [...keys];
    if (this.#gesture?.phase === "lifted") {
      this.cancel();
      return;
    }
    const awaited = this.#awaitedCommit;
    if (awaited !== undefined && !sameOrder(keys, awaited.keys)) {
      this.#awaitedCommit = undefined;
      this.#settle(awaited.slots);
    }
  }

  /**
   * Glides every item from where it is drawn to where its layout puts it now. A caller whose
   * commit was refused calls this, since no new order will arrive to settle the drawn positions.
   */
  public settle(): void {
    this.#awaitedCommit = undefined;
    this.#settle(undefined);
  }

  /** Ends a press or a drag without committing, gliding a lifted item back. */
  public cancel(): void {
    const gesture = this.#gesture;
    if (gesture === undefined) {
      return;
    }
    this.#endGesture(gesture);
    if (gesture.phase === "lifted") {
      this.#settle(undefined);
    }
  }

  #registerItem(key: Key, element: HTMLElement | null): void {
    const registered = this.#items.get(key);
    if (registered !== undefined) {
      registered.element.removeEventListener("pointerdown", registered.onPointerDown);
      this.#items.delete(key);
    }
    if (element === null) {
      this.#itemRefs.delete(key);
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
    if (handle !== undefined && !event.composedPath().includes(handle)) {
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
    const from = slots.findIndex((slot) => slot.key === gesture.key);
    const home = slotAt(slots, from);
    gesture.element.setPointerCapture(gesture.pointerId);
    gesture.element.setAttribute(LIFTED_ATTRIBUTE, "");
    gesture.element.style.zIndex = "1";
    const lifted: LiftedGesture<Key> = {
      ...gesture,
      phase: "lifted",
      slots,
      from,
      to: from,
      step: home.size + gapBeside(slots, from),
      shifts: new Map(),
      glideMs: prefersReducedMotion(gesture.ownerWindow) ? 0 : this.#options.glideMs,
    };
    this.#gesture = lifted;
    return lifted;
  }

  #follow(gesture: LiftedGesture<Key>, event: PointerEvent): void {
    const offset =
      this.#options.axis === "horizontal"
        ? event.clientX - gesture.pressX
        : event.clientY - gesture.pressY;
    gesture.element.style.transform = this.#translate(offset);
    const home = slotAt(gesture.slots, gesture.from);
    const to = nearestSlot(gesture.slots, home.start + home.size / 2 + offset);
    if (to !== gesture.to) {
      gesture.to = to;
      this.#makeRoom(gesture);
    }
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
      this.#glide(slot, this.#drawnOffset(slot), shift, gesture.glideMs);
    });
  }

  /**
   * Clears every transform this controller set and glides each item from where it is drawn to its
   * layout. `restingSlots` are where the items sat before a committed reorder moved their elements;
   * from them the drawn position is recovered once the new order is laid out.
   */
  #settle(restingSlots: readonly Slot<Key>[] | undefined): void {
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
    items.forEach(([key, item], index) => {
      const ownerWindow = item.element.ownerDocument.defaultView;
      if (ownerWindow === null || prefersReducedMotion(ownerWindow)) {
        return;
      }
      const drawn = drawnStarts[index] ?? 0;
      const layout = layoutStarts[index] ?? 0;
      const resting = restingSlots?.find((slot) => slot.key === key);
      // After a reorder the element sits in its new place still wearing its old offset, so the
      // spot it is drawn at is its old resting start plus that offset.
      const from = resting === undefined ? drawn - layout : resting.start + drawn - 2 * layout;
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
  }

  #endGesture(gesture: Gesture<Key>): void {
    gesture.listeners.abort();
    if (gesture.element.hasPointerCapture(gesture.pointerId)) {
      gesture.element.releasePointerCapture(gesture.pointerId);
    }
    this.#gesture = undefined;
  }

  /** How far `slot`'s element is drawn from where it sat when the drag began. */
  #drawnOffset(slot: Slot<Key>): number {
    return this.#startOf(slot.element) - slot.start;
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

/** A press that has not yet travelled far enough to be a drag. */
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
