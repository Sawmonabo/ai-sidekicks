// The messages between the search thread and one of its rankers. Each request is answered once, in
// the order it was sent; a ranked range's arrays move across rather than being copied. A ranker
// opens a read, then ranks within it or ends it; a ranking ends the read it ran in.

import type { RowidRange } from "../../ranking.js";
import type { CarriedError } from "../../../../worker-thread/carried-error.js";

/** What a ranker is started with. */
export interface RankerWorkerData {
  readonly databasePath: string;
}

/** What the search thread asks of a ranker. */
export type RankerRequest =
  | { readonly type: "open-read" }
  | {
      readonly type: "rank";
      readonly matchExpression: string;
      /** Whether the range is read with each row's session and position. */
      readonly readsSessions: boolean;
      readonly range: RowidRange;
    }
  | { readonly type: "end-read" }
  | { readonly type: "close" };

/** What a ranker answers: once when its connection is open, then once per request. */
export type RankerReply =
  | { readonly type: "opened" }
  | { readonly type: "open-failed"; readonly error: CarriedError }
  | {
      readonly type: "read-opened";
      /** The index version the read sees. */
      readonly version: number;
    }
  | {
      readonly type: "ranked";
      readonly rowids: Float64Array<ArrayBuffer>;
      readonly ranks: Float64Array<ArrayBuffer>;
      readonly sessionRowids: Float64Array<ArrayBuffer> | undefined;
      readonly sequences: Float64Array<ArrayBuffer> | undefined;
    }
  | { readonly type: "rank-failed"; readonly error: CarriedError }
  | { readonly type: "read-ended" }
  | { readonly type: "closed" };
