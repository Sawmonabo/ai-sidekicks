// A descriptor table refuses an entry filed under another method's name, which
// is what keeps the daemon's composed method map from pairing a name with the
// wrong shapes. Loosening `MethodDescriptorTable` so an entry's `method` no longer
// has to equal its key makes the `@ts-expect-error` below an unused directive.
import { z } from "zod";

import { defineMethodDescriptors } from "./method-descriptor.js";

const request = z.object({ sessionId: z.string() }).strict();
const response = z.object({}).strict();

defineMethodDescriptors({
  "example.read": {
    method: "example.read",
    procedureType: "query",
    mutating: false,
    requestSchema: request,
    responseSchema: response,
  },
});

defineMethodDescriptors({
  "example.read": {
    // @ts-expect-error an entry must name the method it is filed under
    method: "example.write",
    procedureType: "mutation",
    mutating: true,
    requestSchema: request,
    responseSchema: response,
  },
});
