// What the address field SHOWS, and who last decided it.
//
// This field is under the same rule as the history controls — the chrome derives
// nothing, it renders the view's REPORTED
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

/**
 * Whether a destination names a place on this machine's disk.
 *
 * The address field never accepts a filesystem path. The predicate is deliberately
 * broad, because every spelling it misses is a page navigating to a local file, and
 * that failure is silent: a navigation to `C:secret.txt` looks like a successful one.
 *
 * Breadth is spelled as the ROOTS a local path can start from rather than as a list of
 * examples, because Windows has more of them than the ones with separators in the
 * obvious places:
 *
 *   • `file:` — the scheme, whatever follows it.
 *   • A leading `/` — POSIX root, and with it the forward-slash UNC form
 *     `//server/share`: Win32 takes either separator, so both spellings land here.
 *   • A leading backslash — every backslash-rooted Windows form at once. Root-relative
 *     `\Windows\System32` resolves against the current drive; UNC `\\server\share`,
 *     the extended-length `\\?\C:\...` prefix, and the device namespace `\\.\pipe\...`
 *     differ from it only in what follows the first separator.
 *   • `~` — the home shorthand.
 *   • A drive letter and a colon — `C:\Windows` and `C:/Windows`, but ALSO the
 *     drive-relative `C:secret.txt` and the bare `C:`, which resolve against that
 *     drive's current directory and carry no separator at all. The arm is therefore
 *     the letter and the colon, with nothing required after them.
 *
 * The last arm refuses a hypothetical one-letter URI scheme with it. No such scheme is
 * registered, and refusing a destination that cannot be reached is the cheap direction;
 * admitting one that reads a file is not.
 */
export function isFileAddress(destination: string): boolean {
  const trimmed = destination.trim();
  return (
    /^file:/iu.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("\\") ||
    /^[a-z]:/iu.test(trimmed)
  );
}
