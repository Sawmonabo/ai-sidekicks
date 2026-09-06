// What the address field SHOWS, and who last decided it.
//
// `Spec-023 §Console Design (Meridian)` 12.2 puts the same rule on this field as on
// the history controls — the chrome derives nothing, it renders the view's REPORTED
// state. A field whose value is only ever what somebody typed breaks that rule in
// the direction that is hardest to see: it keeps showing the destination that was
// submitted, so a redirect, a link, or a page that navigates itself leaves the
// chrome asserting a location the page left, submitting it again goes back there,
// and the location the page is actually on can be neither selected nor copied.
//
// The field therefore has two states rather than one string, and which one it is in
// is the whole model:
//
//   • FOLLOWING — the field shows the reported URL and moves with it. This is the
//     resting state, and it is what makes the current location selectable.
//   • EDITING — the field shows the person's draft and nothing moves it. A reported
//     navigation arriving mid-edit changes the page, not the caret.
//
// TWO TRANSITIONS, AND THE ONES DELIBERATELY ABSENT. A keystroke enters editing; a
// submit or an Escape returns to following. FOCUS is not a transition: entering
// editing on focus would freeze the field for anyone who merely clicked into it to
// copy the URL, and would need a blur rule to get back out — a rule with a stuck
// state at the end of it. Selecting text needs no mode.
//
// AND WHAT A SUBMIT DOES NOT DO: it does not hold the submitted string on screen
// until the navigation reports. Returning to following means a refused navigation —
// which is every navigation until the browser namespace is registered — snaps the
// field back to the location the page is still on, rather than leaving the chrome
// showing a destination nothing went to. The refusal says what happened; the field
// says where the page is.

/** The field's state. The mode is the discriminant, and there are only two. */
export type AddressFieldState =
  | { readonly mode: "following" }
  | { readonly mode: "editing"; readonly draft: string };

/** Where the field starts, and where a submit or an Escape returns it. */
export const FOLLOWING_ADDRESS_FIELD: AddressFieldState = { mode: "following" };

/** Where a keystroke puts it, carrying the draft that keystroke produced. */
export function editingAddressField(draft: string): AddressFieldState {
  return { mode: "editing", draft };
}

/**
 * What the input renders.
 *
 * The empty string when following with nothing reported yet — which is an absent
 * reading rather than an empty location, and the field says so with its placeholder
 * rather than by showing a fabricated URL.
 */
export function addressFieldValue(
  state: AddressFieldState,
  reportedUrl: string | undefined,
): string {
  return state.mode === "editing" ? state.draft : (reportedUrl ?? "");
}

/**
 * What a submit sends: whatever the field shows, trimmed.
 *
 * Named rather than left as a `.trim()` at the call site because two things read it
 * — the filesystem guard and the navigation — and a guard that ran on one spelling
 * while the navigation dispatched another is the shape that lets a refused
 * destination through.
 */
export function addressFieldSubmission(
  state: AddressFieldState,
  reportedUrl: string | undefined,
): string {
  return addressFieldValue(state, reportedUrl).trim();
}
