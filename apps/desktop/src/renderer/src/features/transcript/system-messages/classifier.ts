// Which rows are system messages, and what one row's system message says. The closed vocabulary
// it classifies into (kinds, wire types, labels, the one caution) is in `kinds.ts`. Whether a row
// is superseded is its own mark, not a classification.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { SYSTEM_MESSAGE_KINDS, SYSTEM_MESSAGE_BINDINGS, type SystemMessageKind } from "./kinds.js";

/** One system message: the act it names, its words, and the row and moment it stands at. */
export interface SystemMessageReading {
  readonly kind: SystemMessageKind;
  /** The act's name as the one-line row reads it. */
  readonly label: string;
  readonly rowId: string;
  readonly timestamp: string;
}

/**
 * The system message classifier. A class so the wire-type-to-kind table is built once per
 * transcript instead of per row, without module-level mutable state.
 */
export class SystemMessageClassifier {
  readonly #kindByWireType: ReadonlyMap<string, SystemMessageKind>;

  public constructor() {
    const kindByWireType = new Map<string, SystemMessageKind>();
    for (const kind of SYSTEM_MESSAGE_KINDS) {
      for (const wireType of SYSTEM_MESSAGE_BINDINGS[kind].wireTypes) {
        kindByWireType.set(wireType, kind);
      }
    }
    this.#kindByWireType = kindByWireType;
  }

  /**
   * One row's system message, or `undefined` when the row is not one or its payload is off
   * contract, in which case the row is drawn as any other event row.
   */
  public classify(row: TranscriptEventRow): SystemMessageReading | undefined {
    const kind = row.kind === "rollback_boundary" ? "rollback" : this.#kindByWireType.get(row.type);
    if (kind === undefined) {
      return undefined;
    }
    const label = SYSTEM_MESSAGE_BINDINGS[kind].labelOf(row);
    return label === undefined
      ? undefined
      : { kind, label, rowId: row.id, timestamp: row.timestamp };
  }
}
