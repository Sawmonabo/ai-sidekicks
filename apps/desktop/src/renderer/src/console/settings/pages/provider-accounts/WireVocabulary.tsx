import type { ReactNode } from "react";
import { WireFigure } from "../../../primitives/index.js";
import { DefinitionGrid } from "../../shared/DefinitionGrid.js";

/**
 * One vocabulary block: the closed set the wire declares, and what each member means.
 *
 * The terms render through `WireFigure` because each one is a value the daemon
 * sends: verbatim, in mono, never re-cased. The meanings are the console's own
 * words, and they are TOTAL over the union by their record type — a member added
 * upstream is a compile error here rather than a term that stops being explained.
 */
export function WireVocabulary<TTerm extends string>(props: {
  readonly label: string;
  readonly terms: readonly TTerm[];
  readonly meanings: Readonly<Record<TTerm, string>>;
  /** One clause about the set as a whole, where the members do not carry it. */
  readonly note?: string;
}): ReactNode {
  return (
    <section className="meridian-settings-page__block" aria-label={props.label}>
      <h3 className="meridian-settings-page__block-title">{props.label}</h3>
      {props.note === undefined ? null : (
        <p className="meridian-settings-page__aside">{props.note}</p>
      )}
      <DefinitionGrid
        entries={props.terms.map((term) => ({
          key: term,
          term: <WireFigure value={term} />,
          definition: props.meanings[term],
        }))}
      />
    </section>
  );
}
