// A runtime binding store over a scratch database, for a driver test that reads what a fork or a
// rewind wrote to its session's binding and to the conversations the session left.

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { RuntimeBindingStore } from "../runtime-binding-store.js";

/** Runs `test` over a binding store on a fresh scratch database, closing the database after. */
export async function withScratchBindingStore(
  test: (bindings: RuntimeBindingStore, database: ScratchDatabase) => Promise<void>,
): Promise<void> {
  const database = await openScratchDatabase();
  try {
    await test(new RuntimeBindingStore(database), database);
  } finally {
    await database.close();
  }
}
