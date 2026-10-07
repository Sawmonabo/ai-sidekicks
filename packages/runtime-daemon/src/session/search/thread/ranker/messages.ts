// The messages between the search thread and one of its rankers. Each request is answered once, in
// the order it was sent; a ranked range's arrays move across rather than being copied.

import type { RowidRange } from "../../ranking.js";
import type { CarriedError } from "../../../../worker-thread/carried-error.js";

/** What a ranker is started with. */
export interface RankerWorkerData {
  readonly databasePath: string;
}

/** What the search thread asks of a ranker. */
export type RankerRequest =
  | {
      readonly type: "rank";
      readonly matchExpression: string;
      /** Whether the range is read with each row's session and position. */
      readonly readsSessions: boolean;
      readonly range: RowidRange;
    }
  | { readonly type: "close" };

/** What a ranker answers: once when its connection is open, then once per request. */
export type RankerReply =
  | { readonly type: "opened" }
  | { readonly type: "open-failed"; readonly error: CarriedError }
  | {
      readonly type: "ranked";
      /** The index version the range was read at. */
      readonly version: number;
      readonly rowids: Float64Array<ArrayBuffer>;
      readonly ranks: Float64Array<ArrayBuffer>;
      readonly sessionRowids: Float64Array<ArrayBuffer> | undefined;
      readonly sequences: Float64Array<ArrayBuffer> | undefined;
    }
  | { readonly type: "rank-failed"; readonly error: CarriedError }
  | { readonly type: "closed" };
