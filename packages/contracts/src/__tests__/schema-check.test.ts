// The runtime pieces every generated check calls: the byte measure of a capped value and the
// format rules, run against the Rust checks' web-address case table, parsed strictly with zod.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "./case-table.test-support.js";
import { validateHostingAddress } from "../generated/git/shared.js";
import { validatePreviewPortTicketIssueResponse } from "../generated/preview/port.js";
import {
  PROVIDER_SIGN_IN_VERIFICATION_URI_MAX_LEN,
  validateProviderAccountSignInResponse,
} from "../generated/provider/account/sign-in.js";
import { jsonUtf8ByteLength } from "../jsonrpc/byte-length.js";
import { SCHEMA_FORMATS, wireByteLength } from "../schema-check.js";
import { WEB_ADDRESS_FAULTS } from "../generated/web-address.js";
import { webAddressFault } from "../web-address/rule.js";

describe("wireByteLength", () => {
  it("counts every attachment a nested placeholder names beside the JSON", () => {
    const value = { entries: [{ audio: { $bytes: 0 } }, { image: { $bytes: 1 } }] };
    expect(wireByteLength(value, [new Uint8Array(10), new Uint8Array(7)])).toBe(
      jsonUtf8ByteLength(value) + 17,
    );
  });

  it("measures infinite where a placeholder names no attachment", () => {
    expect(wireByteLength({ audio: { $bytes: 1 } }, [new Uint8Array(10)])).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(wireByteLength({ audio: { $bytes: 0 } }, undefined)).toBe(Number.POSITIVE_INFINITY);
  });
});

// The web-address case table the Rust checks read too, so the two sides cannot drift. Parsed, not
// cast, so a fault outside the closed set fails here as it fails the Rust suite.
const webAddressText = z
  .object({
    name: z.string(),
    text: z.string(),
    web: z.string().nullable(),
    https: z.string().nullable(),
  })
  .strict();

const webAddressCases = readCaseTable(
  z
    .object({
      faults: z.array(
        z.object({ address: z.string(), fault: z.enum(WEB_ADDRESS_FAULTS).nullable() }).strict(),
      ),
      texts: z.array(webAddressText),
      httpsCap: z.int().positive(),
      capped: z.array(webAddressText.omit({ web: true })),
    })
    .strict(),
  "web-address.json",
);

describe("SCHEMA_FORMATS", () => {
  it.each(webAddressCases.faults)(
    "judges $address as a web address exactly when it draws no fault",
    ({ address, fault }) => {
      expect(webAddressFault(new URL(address))).toBe(fault);
      expect(SCHEMA_FORMATS["web-url"](address)).toBe(fault === null);
    },
  );

  it("holds a number to its Rust integer type's range", () => {
    expect(SCHEMA_FORMATS.uint32.validate(0xffff_ffff)).toBe(true);
    expect(SCHEMA_FORMATS.uint32.validate(0x1_0000_0000)).toBe(false);
    expect(SCHEMA_FORMATS.uint32.validate(-1)).toBe(false);
    expect(SCHEMA_FORMATS.uint32.validate(1.5)).toBe(false);
    expect(SCHEMA_FORMATS.int64.validate(-(2 ** 63))).toBe(true);
    expect(SCHEMA_FORMATS.int64.validate(2 ** 64)).toBe(false);
    expect(SCHEMA_FORMATS.int64.validate(-(2 ** 64))).toBe(false);
  });
});

// Each generated check runs its address type's whole schema: the format, the patterns beside it
// (the `http` start of a web address, the NUL an https: address may not carry) and the cap.
describe("the generated web address checks", () => {
  it.each(webAddressCases.texts)(
    "take $name exactly where the Rust address types keep it",
    ({ text, web, https }) => {
      expect(validateHostingAddress(text)).toBe(web !== null);
      expect(validatePreviewPortTicketIssueResponse({ address: text })).toBe(https !== null);
    },
  );

  // The product's capped address takes 2048 code points, not the table's cap: leading spaces,
  // which both sides trim, fill the difference, so each row is measured as sent at the table's cap.
  it.each(webAddressCases.capped)(
    "caps $name as sent, exactly where the Rust address type does",
    ({ text, https }) => {
      const padding = " ".repeat(
        PROVIDER_SIGN_IN_VERIFICATION_URI_MAX_LEN - webAddressCases.httpsCap,
      );
      const response = {
        attemptId: "attempt",
        verificationUri: `${padding}${text}`,
        isBrowserOpenedByProvider: false,
      };
      expect(validateProviderAccountSignInResponse(response)).toBe(https !== null);
    },
  );
});
