// Whose keystroke is it, the widget's or the console's? Two callers ask different versions:
//
//   - The keybinding table asks the narrow one, per binding: is text being typed? "Open the
//     palette" must work while composing a message and "delete the selected row" must not
//     (`isTextEntryTarget`).
//   - The pane layout asks the wide one: does the focused widget own its arrow keys? On macOS
//     Option+Arrow moves the caret by word, so a pane chord firing inside a find field would
//     rearrange the pane. Comboboxes and listboxes own their arrows too (`isEditableTarget`).
//
// The wide answer is the narrow one plus an ancestor walk, because events from a
// `role="textbox"` div, a listbox option or a combobox input fire on a descendant;
// `isContentEditable` inherits down a subtree but an ARIA role does not.

/** `<input>` types that are controls rather than text entry; a chord still reaches them. */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * The ARIA roles whose widget owns keys a console chord would otherwise take: text entry, a
 * combobox, and a listbox that navigates by arrow keys. A selector so the ancestor test is one
 * `closest` call.
 */
const EDITABLE_ROLE_SELECTOR =
  '[role="textbox"],[role="searchbox"],[role="combobox"],[role="listbox"]';

/**
 * Is this event coming out of a text field?
 *
 * `isContentEditable` covers the composer and rich editors, the tag check native fields; `type`
 * keeps a checkbox out, since no text is typed there.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tagName = target.tagName;
  if (tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  if (tagName !== "INPUT") {
    return false;
  }
  const inputType = target.getAttribute("type")?.toLowerCase() ?? "text";
  return !NON_TEXT_INPUT_TYPES.has(inputType);
}

/**
 * Does the widget this event came from own its own keys?
 *
 * True for every text-entry target and for anything inside a widget whose ARIA role takes the
 * arrow keys. A view that binds a bare modifier chord asks this before acting.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (isTextEntryTarget(target)) {
    return true;
  }
  if (target === null || !(target instanceof Element)) {
    return false;
  }
  return target.closest(EDITABLE_ROLE_SELECTOR) !== null;
}
