// What the address field shows and who last decided it. Following shows the reported URL and
// moves with it; editing shows the draft. A keystroke enters editing; submit or Escape returns
// to following. Focus is not a transition (it would freeze the field for anyone who only clicked
// in to copy), and a submit does not pin the submitted string, so a refused navigation snaps back.

/** The field's state: following the reported URL, or editing a draft. */
export type AddressFieldState =
  | { readonly mode: "following" }
  | { readonly mode: "editing"; readonly draft: string };

/** Where the field starts, and where a submit or an Escape returns it. */
export const FOLLOWING_ADDRESS_FIELD: AddressFieldState = { mode: "following" };

/** Where a keystroke puts it, carrying the draft that keystroke produced. */
export function editingAddressField(draft: string): AddressFieldState {
  return { mode: "editing", draft };
}

/** What the input renders: the draft while editing, else the reported URL, or "" if none yet. */
export function addressFieldValue(
  state: AddressFieldState,
  reportedUrl: string | undefined,
): string {
  return state.mode === "editing" ? state.draft : (reportedUrl ?? "");
}

/** What a submit sends: the field's value, trimmed; the guard and the navigation read this one. */
export function addressFieldSubmission(
  state: AddressFieldState,
  reportedUrl: string | undefined,
): string {
  return addressFieldValue(state, reportedUrl).trim();
}

/**
 * Whether a destination names a place on this machine's disk; the address field never accepts
 * one. Deliberately broad, because a miss silently navigates to a local file. Matches `file:`,
 * a leading `/` (POSIX and `//server/share`), a leading backslash (root-relative, UNC, `\\?\`
 * and `\\.\` forms), `~`, and a drive letter with a colon, including drive-relative `C:secret.txt`
 * and bare `C:`. That last arm also refuses a hypothetical one-letter URI scheme, the cheap side.
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
