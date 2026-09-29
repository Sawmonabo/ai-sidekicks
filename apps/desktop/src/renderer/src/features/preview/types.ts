// What the pane KNOWS about the page, as opposed to what it draws.
//
// The chrome never derives navigability: the pane's content takes the reading as a prop
// and holds no second copy of its shape. The address field's filesystem guard lives here
// too: it is a decision about a destination, not about a layout, and a test can drive it
// without mounting a pane.

import type { PreviewPage } from "@ai-sidekicks/contracts";

import type { ReadingState } from "@renderer/console/primitives/index.js";

/**
 * What the pane knows about the page right now.
 *
 * `ended` is a fact and not the absence of one: a subscription that finished cleanly
 * is neither a reading nor a refusal, and a pane holding the last state it was sent
 * would present an address, a title and two history depths as current while nothing reports
 * them. It carries no last state for that reason.
 */
export type NavigationReading =
  /** No answer has come back yet, which is not the same as "no page". */
  | Extract<ReadingState, { readonly kind: "reading" }>
  | (Extract<ReadingState, { readonly kind: "served" }> & {
      readonly state: PreviewPage;
    })
  /** The producer finished. The pane was being told, and is not being told now. */
  | { readonly kind: "ended" };

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
export function isFilesystemDestination(destination: string): boolean {
  const trimmed = destination.trim();
  return (
    /^file:/iu.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("\\") ||
    /^[a-z]:/iu.test(trimmed)
  );
}
