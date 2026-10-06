// A window's copy of the console document's stylesheets. Every window renders from the console
// document's tree, but a stylesheet styles only the document it sits in, so each window carries a
// copy of every `<style>` and `<link rel="stylesheet">` in the console document's head, kept in
// order, and kept current while the console document's change: a lazily loaded chunk adds its
// sheet, and the development server rewrites a sheet's text in place on every edit.

/** The attributes of a stylesheet link a change to which is copied across. */
const LINK_ATTRIBUTES = ["href", "media", "disabled"] as const;

/**
 * Copies `source`'s head stylesheets into `target`'s head and keeps them current until
 * `disconnect`. An element whose id `target` already holds is left to `target`'s own copy.
 * `source` is this realm's document, the one whose script runs this.
 */
export class StylesheetMirror {
  readonly #source: Document;
  readonly #target: Document;
  readonly #copies = new Map<Element, Element>();
  readonly #observer: MutationObserver;

  public constructor(source: Document, target: Document) {
    this.#source = source;
    this.#target = target;
    for (const element of source.head.children) {
      this.#copy(element);
    }
    this.#observer = new MutationObserver((records) => {
      for (const record of records) {
        this.#apply(record);
      }
    });
    this.#observer.observe(source.head, {
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: [...LINK_ATTRIBUTES],
    });
  }

  /** Stop following the source; the copies stay in the target. */
  public disconnect(): void {
    this.#observer.disconnect();
  }

  #apply(record: MutationRecord): void {
    if (record.target === this.#source.head) {
      for (const removed of record.removedNodes) {
        if (removed instanceof Element) {
          this.#copies.get(removed)?.remove();
          this.#copies.delete(removed);
        }
      }
      for (const added of record.addedNodes) {
        if (added instanceof Element && added.parentNode === this.#source.head) {
          this.#copy(added);
        }
      }
      return;
    }
    // A change inside or on one head element: a sheet's text rewritten, or a link re-pointed.
    const element = this.#headChildHolding(record.target);
    if (element !== undefined) {
      this.#refresh(element);
    }
  }

  /** Copy one head element of the source, when it is a stylesheet the target lacks. */
  #copy(element: Element): void {
    if (!isStylesheet(element) || this.#copies.has(element)) {
      return;
    }
    if (element.id !== "" && this.#target.getElementById(element.id) !== null) {
      return;
    }
    const copy = this.#target.importNode(element, true);
    if (element instanceof HTMLLinkElement) {
      // Resolved against the source: the target is a blank document with a base of its own.
      copy.setAttribute("href", element.href);
    }
    this.#copies.set(element, copy);
    this.#place(element, copy);
  }

  /** Put `copy` where `element` sits among the copied elements, so the cascade order holds. */
  #place(element: Element, copy: Element): void {
    for (let next = element.nextElementSibling; next !== null; next = next.nextElementSibling) {
      const nextCopy = this.#copies.get(next);
      if (nextCopy !== undefined) {
        this.#target.head.insertBefore(copy, nextCopy);
        return;
      }
    }
    this.#target.head.append(copy);
  }

  /** Bring one copy in line with its source after the source changed. */
  #refresh(element: Element): void {
    const copy = this.#copies.get(element);
    if (copy === undefined) {
      return;
    }
    if (!(element instanceof HTMLLinkElement)) {
      copy.textContent = element.textContent;
      return;
    }
    for (const name of LINK_ATTRIBUTES) {
      const value = name === "href" ? element.href : element.getAttribute(name);
      if (value === null) {
        copy.removeAttribute(name);
      } else {
        copy.setAttribute(name, value);
      }
    }
  }

  /** The source head element `node` is, or sits inside; `undefined` for anything else. */
  #headChildHolding(node: Node): Element | undefined {
    for (let current: Node | null = node; current !== null; current = current.parentNode) {
      if (current.parentNode === this.#source.head) {
        return current instanceof Element ? current : undefined;
      }
    }
    return undefined;
  }
}

function isStylesheet(element: Element): boolean {
  return (
    element instanceof HTMLStyleElement ||
    (element instanceof HTMLLinkElement && element.rel === "stylesheet")
  );
}
