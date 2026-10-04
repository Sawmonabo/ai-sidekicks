// Which rows are system messages, and what one row's system message says. The closed vocabulary
// it classifies into (kinds, wire types, labels, glyphs, the one caution) is in
// `system-message-kinds.ts`. Superseded turns are ranked separately in `superseded-turns.ts`.

import type { TimelineRow } from "@ai-sidekicks/contracts/timeline/row";

import {
  SYSTEM_MESSAGE_KINDS,
  SYSTEM_MESSAGE_BINDINGS,
  type SystemMessageKind,
} from "./system-message-kinds.js";

/** One system message: the act it names, and the row and moment it stands at. */
export interface SystemMessageReading {
  readonly kind: SystemMessageKind;
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

  /** One row's system message, or `undefined` when the row is not one. */
  public classify(row: TimelineRow): SystemMessageReading | undefined {
    const kind = row.kind === "rollback_boundary" ? "rollback" : this.#kindByWireType.get(row.type);
    if (kind === undefined) {
      return undefined;
    }
    return { kind, rowId: row.id, timestamp: row.timestamp };
  }

  /** Every system message in one loaded window, in log order. */
  public systemMessages(rows: readonly TimelineRow[]): readonly SystemMessageReading[] {
    const systemMessages: SystemMessageReading[] = [];
    for (const row of rows) {
      const systemMessage = this.classify(row);
      if (systemMessage !== undefined) {
        systemMessages.push(systemMessage);
      }
    }
    return systemMessages;
  }
}
