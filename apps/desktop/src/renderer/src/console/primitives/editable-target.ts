// Whose keystroke is it — the widget's, or the console's?
//
// Two surfaces ask that question and they ask two different versions of it, so both
// live here rather than one being reimplemented beside the other:
//
//   • The keybinding table asks the NARROW one, per binding: is text being typed?
//     "Open the palette" must work while a person is composing a message, and
//     "delete the selected row" must not. That is `isTextEntryTarget`.
//   • The deck asks the WIDE one: does the focused widget own its arrow keys? On
//     macOS Option+Arrow is word-wise caret movement and Option+Backspace deletes a
//     word, so a deck chord that fired from inside a find field would rearrange or
//     close the pane a person was typing in. A combobox and a listbox own their
//     arrows too, and neither is a text field. That is `isEditableTarget`.
//
// The wide answer is the narrow one plus an ANCESTOR walk, because the element the
// event fires on is not always the widget: a `role="textbox"` composed from a
// contentEditable div, an option inside a listbox, and the input inside a combobox
// all deliver their events from a descendant. `isContentEditable` already inherits
// down a contentEditable subtree; an ARIA role does not, so the role arm walks.
//
// It lives in `primitives/` rather than in either caller because both callers are
// above it in the console's family DAG, and a helper hoisted to the lower of two
// consumers is the rule this tree runs on. It renders nothing and imports nothing.

/**
 * `<input>` types that are controls rather than text entry. A checkbox or a
 * radio should still receive a chord; a search field should not.
 */
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
 * The ARIA roles whose widget owns the keys a console chord would otherwise take.
 *
 * `textbox` and `searchbox` are text entry by declaration; `combobox` is a text
 * field with a popup; `listbox` navigates its own options with the arrow keys. Held
 * as a selector string rather than as a list walked by hand so the ancestor test is
 * one `closest` call — the browser's own matcher, and no second traversal.
 */
const EDITABLE_ROLE_SELECTOR =
  '[role="textbox"],[role="searchbox"],[role="combobox"],[role="listbox"]';

/**
 * Is this event coming out of a text field?
 *
 * `isContentEditable` covers the composer and any rich editor; the tag check
 * covers native fields. `type` is consulted so a chord still reaches a checkbox,
 * which is a control rather than a place text is being typed.
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
 * True for every text-entry target, and additionally for anything inside a widget
 * whose ARIA role declares it takes the arrow keys. A surface that binds a bare
 * modifier chord asks this before acting, so a person typing never has the view
 * rearranged underneath them.
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
