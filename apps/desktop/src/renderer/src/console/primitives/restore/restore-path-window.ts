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
  /**
   * What the mounting surface does with one enumerated path, or `undefined` where
   * it offers nothing and the path renders as text.
   *
   * DELIBERATELY NOT "open in the diff pane". Both enumerations name paths git
   * does not track — an overwritten IGNORED path and a divergent gitlink — so
   * there is no diff to open for either, and a prop that named one surface's
   * affordance would have made every other mount read as a degraded version of a
   * thing that never existed. The surface decides; this list draws the control.
   */
  readonly onOpenPath: ((path: string) => void) | undefined;
  /**
   * The verb in the control's accessible name, so activation is legible.
   *
   * Without it the button's whole accessible name is the path, and a reader who
   * cannot see the surrounding copy is told WHAT the control is about and never
   * what pressing it does. Optional with a default, because the name is a property
   * of the affordance the mount supplies rather than of the enumeration.
   */
  readonly pathActionLabel?: string | undefined;
}
