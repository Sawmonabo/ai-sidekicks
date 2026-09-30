// The device contract is the boundary between the person's devices, the control
// plane and each machine's service. These tests hold each request's refusals: the
// list and its events, linking, rename, the chain reads, the push address and the
// notification switches, and the closed list of procedures the service carries.
import { describe, expect, it } from "vitest";

import {
  ControlPlaneCallRequestSchema,
  DeviceLinkRedeemRequestSchema,
  DeviceLinkRequestSchema,
  DeviceListEventSchema,
  DeviceListSnapshotSchema,
  DeviceNotificationSettingsSetRequestSchema,
  DevicePushAddressSetRequestSchema,
  DeviceRenameRequestSchema,
  DeviceStatementApplyRequestSchema,
  DeviceStatementListRequestSchema,
  DeviceTrustedListResponseSchema,
} from "../device.js";

const bytes = (length: number): string => Buffer.alloc(length, 7).toString("base64");

const HASH = "a".repeat(64);
const ISSUED_AT = "2026-09-12T10:00:00.000Z";
const NODE_ID = "mac-mini";
const DEVICE_ID = "device-phone-1";
const ED25519_KEY = { algorithm: "ed25519", publicKey: bytes(32) } as const;
const P256_KEY = { algorithm: "p256", publicKey: bytes(65) } as const;
const CHANNEL_KEY = { algorithm: "x25519", publicKey: bytes(32) } as const;
const MACHINE_SIGNATURE = { signer: "runtimenode", nodeId: NODE_ID, signature: bytes(64) };
const DEVICE_SIGNATURE = { signer: "device", deviceId: DEVICE_ID, signature: bytes(64) };

const firstMachineAdded = {
  kind: "runtimenode.added",
  previousHash: null,
  issuedAt: ISSUED_AT,
  signatures: [MACHINE_SIGNATURE],
  nodeId: NODE_ID,
  identityKey: ED25519_KEY,
  channelKey: CHANNEL_KEY,
  name: "mac-mini",
};
const deviceLinked = {
  kind: "device.linked",
  previousHash: HASH,
  issuedAt: ISSUED_AT,
  signatures: [MACHINE_SIGNATURE, DEVICE_SIGNATURE],
  deviceId: DEVICE_ID,
  identityKey: P256_KEY,
  channelKey: CHANNEL_KEY,
  name: "iPhone",
  platform: "iPhone",
};
const deviceRenamed = {
  kind: "device.renamed",
  previousHash: HASH,
  issuedAt: ISSUED_AT,
  signatures: [DEVICE_SIGNATURE],
  deviceId: DEVICE_ID,
  name: "Work phone",
};
describe("device.list", () => {
  it("accepts the list with a machine, a revoked device and a passkey", () => {
    const snapshot = {
      machines: [
        {
          nodeId: NODE_ID,
          name: "mac-mini",
          platform: "macOS 15.6",
          serviceVersion: "0.1.0",
          reachable: false,
          lastSeenAt: ISSUED_AT,
        },
      ],
      devices: [
        {
          deviceId: DEVICE_ID,
          name: "iPhone",
          platform: "iPhone",
          appVersion: "1.4.0",
          connected: false,
          lastSeenAt: null,
          linkedAt: ISSUED_AT,
          linkedBy: { signer: "runtimenode", nodeId: NODE_ID },
          revokedAt: ISSUED_AT,
          revokePendingOnNodeIds: [NODE_ID],
          seenInTwoPlaces: false,
        },
      ],
      passkeys: [
        {
          passkeyId: "cGFzc2tleQ",
          platform: "iCloud Keychain",
          addedAt: ISSUED_AT,
          addedBy: { signer: "device", deviceId: DEVICE_ID },
        },
      ],
    };
    expect(DeviceListSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("names a statement event by its statement's kind", () => {
    expect(
      DeviceListEventSchema.safeParse({ type: "device.renamed", statement: deviceRenamed }).success,
    ).toBe(true);
    expect(
      DeviceListEventSchema.safeParse({ type: "device.revoked", statement: deviceRenamed }).success,
    ).toBe(false);
  });
});

describe("linking", () => {
  const redeem = {
    pairingId: "pairing-1",
    identityKey: P256_KEY,
    channelKey: CHANNEL_KEY,
    name: "iPhone",
    platform: "iPhone",
    appVersion: "1.4.0",
    mac: bytes(32),
  };

  it("accepts the new device's half of the link", () => {
    expect(DeviceLinkRedeemRequestSchema.safeParse(redeem).success).toBe(true);
  });

  it("refuses a linking proof that is not a SHA-256 HMAC", () => {
    expect(DeviceLinkRedeemRequestSchema.safeParse({ ...redeem, mac: bytes(16) }).success).toBe(
      false,
    );
  });

  it("links only with a device.linked statement", () => {
    expect(
      DeviceLinkRequestSchema.safeParse({ pairingId: "pairing-1", statement: deviceLinked })
        .success,
    ).toBe(true);
    expect(
      DeviceLinkRequestSchema.safeParse({ pairingId: "pairing-1", statement: deviceRenamed })
        .success,
    ).toBe(false);
  });
});

describe("rename and the chain reads", () => {
  it("refuses an empty name, since a rename left empty keeps the old one", () => {
    expect(DeviceRenameRequestSchema.safeParse({ statement: deviceRenamed }).success).toBe(true);
    expect(
      DeviceRenameRequestSchema.safeParse({ statement: { ...deviceRenamed, name: "" } }).success,
    ).toBe(false);
  });

  it("reads the chain from the start or after a statement hash", () => {
    expect(DeviceStatementListRequestSchema.safeParse({ after: null }).success).toBe(true);
    expect(DeviceStatementListRequestSchema.safeParse({ after: HASH }).success).toBe(true);
    expect(DeviceStatementListRequestSchema.safeParse({ after: "A".repeat(64) }).success).toBe(
      false,
    );
  });

  it("hands a machine a mixed run of statements", () => {
    expect(
      DeviceStatementApplyRequestSchema.safeParse({ statements: [firstMachineAdded, deviceLinked] })
        .success,
    ).toBe(true);
  });

  it("accepts a machine's verified view of its devices", () => {
    const view = {
      devices: [
        {
          deviceId: DEVICE_ID,
          name: "iPhone",
          platform: "iPhone",
          identityKey: P256_KEY,
          channelKey: CHANNEL_KEY,
          trustedBy: HASH,
          revokedAt: null,
        },
      ],
    };
    expect(DeviceTrustedListResponseSchema.safeParse(view).success).toBe(true);
  });
});

describe("push address and notification switches", () => {
  it("accepts each platform's address", () => {
    expect(
      DevicePushAddressSetRequestSchema.safeParse({ platform: "apns", address: "ab".repeat(32) })
        .success,
    ).toBe(true);
    expect(
      DevicePushAddressSetRequestSchema.safeParse({
        platform: "webPush",
        address: "https://web.push.apple.com/QGuQyavXutnMH",
      }).success,
    ).toBe(true);
  });

  it("refuses a platform outside the three", () => {
    expect(
      DevicePushAddressSetRequestSchema.safeParse({ platform: "gcm", address: "token" }).success,
    ).toBe(false);
  });

  it("refuses a Web Push endpoint that is not https", () => {
    expect(
      DevicePushAddressSetRequestSchema.safeParse({
        platform: "webPush",
        address: "http://169.254.169.254/latest",
      }).success,
    ).toBe(false);
  });

  const settings = {
    notifyOutsideTheApp: true,
    countOnAppIcon: true,
    kinds: { waitingOnYou: true, finished: true, failed: false, notifyStep: true },
    pushKey: bytes(1216),
  };

  it("accepts a phone's switches and a browser's subscription keys", () => {
    expect(DeviceNotificationSettingsSetRequestSchema.safeParse(settings).success).toBe(true);
    expect(
      DeviceNotificationSettingsSetRequestSchema.safeParse({
        ...settings,
        webPushKeys: {
          p256dh: Buffer.alloc(65, 4).toString("base64url"),
          auth: Buffer.alloc(16, 5).toString("base64url"),
        },
      }).success,
    ).toBe(true);
  });

  it("refuses a push key that is not an X-Wing public key", () => {
    expect(
      DeviceNotificationSettingsSetRequestSchema.safeParse({ ...settings, pushKey: bytes(32) })
        .success,
    ).toBe(false);
  });

  it("refuses a fifth notification kind", () => {
    expect(
      DeviceNotificationSettingsSetRequestSchema.safeParse({
        ...settings,
        kinds: { ...settings.kinds, mention: true },
      }).success,
    ).toBe(false);
  });
});

describe("controlPlane.call", () => {
  it("forwards a listed procedure", () => {
    expect(
      ControlPlaneCallRequestSchema.safeParse({
        procedure: "device.rename",
        input: { statement: deviceRenamed },
      }).success,
    ).toBe(true);
  });

  it("refuses a procedure the service does not carry", () => {
    for (const procedure of [
      "runtimenode.register",
      "runtimenode.certificateChallengeSet",
      "push.send",
    ]) {
      expect(ControlPlaneCallRequestSchema.safeParse({ procedure, input: {} }).success).toBe(false);
    }
  });
});
