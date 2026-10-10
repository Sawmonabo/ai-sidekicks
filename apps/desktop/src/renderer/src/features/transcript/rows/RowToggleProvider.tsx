// The toggles a row body's controls reach. The virtualizer mounts only the visible range, so a
// call's fold, and its output opened whole, live with the feed, keyed by its row, and survive the
// row scrolling out and back;
// and every toggle keeps the pressed control where it stands, which only the feed's viewport can
// do. A context, not a row-renderer prop, so the cards a row draws need no write path of their
// own. Reads do not come through here: the feed hands the row its density.

import { createContext, type Context } from "react";

/** What a control inside a row may ask of the feed it is drawn in. */
export interface RowToggle {
  /** Fold an open call or open a folded one, keeping the pressed control where it stands. */
  readonly toggleCallFold: (rowId: string, control: HTMLElement) => void;
  /** Draw a call's output whole, keeping the pressed `Show all` where it stands. */
  readonly openOutput: (rowId: string, control: HTMLElement) => void;
  /**
   * Keep a pressed control where it stands while its own row grows or shrinks around it. Called
   * before the change the press makes.
   */
  readonly holdControlInPlace: (rowId: string, control: HTMLElement) => void;
}

/**
 * The channel, or `undefined` outside a transcript. Not a no-op default: that would swallow every
 * fold press in a tree that forgot the provider.
 */
export const RowToggleContext: Context<RowToggle | undefined> = createContext<
  RowToggle | undefined
>(undefined);

/** The toggles to publish and the row bodies they reach. */
export interface RowToggleProviderProps {
  readonly rowToggle: RowToggle;
  readonly children: React.ReactNode;
}

/** Publish one transcript's row toggles to the row bodies it mounts. */
export function RowToggleProvider(props: RowToggleProviderProps): React.JSX.Element {
  return <RowToggleContext value={props.rowToggle}>{props.children}</RowToggleContext>;
}
