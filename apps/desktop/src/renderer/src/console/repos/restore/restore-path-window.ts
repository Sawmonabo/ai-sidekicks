// What a restore-path enumeration is handed.
//
// A MODULE OF ITS OWN because both arms take the same props — the list that draws
// every path and the windowed one past the threshold. Declared in the list they would
// close a cycle with the arm it delegates to. The window's own height cap is in
// `restore-bounds.ts` beside the two bounds it is derived from.

export interface RestorePathListProps {
  /** What the enumeration is called, for the scroll region's own name. */
  readonly label: string;
  readonly paths: readonly string[];
  /** Open one path in the diff pane. Absent where no diff exists for it. */
  readonly onOpenPath: ((path: string) => void) | undefined;
}
