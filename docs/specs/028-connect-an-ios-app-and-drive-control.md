# Spec-028: Connect an iOS app and drive control

| Field | Value |
| --- | --- |
| **Status** | `draft` |
| **NNN** | `028` |
| **Slug** | `connect-an-ios-app-and-drive-control` |
| **Date** | `2026-09-11` |
| **Author(s)** | `Sawmon Abo` |
| **Implementation Plan** | [Plan-025: Remote Control](../plans/025-remote-control.md) [Phase 7 — Frontend](../plans/025-remote-control.md#phase-7--frontend) |

## Goal

An iPhone app that links as a device and drives a session on any of the person's machines with full parity — the same sessions, running where they run, reached from a phone.

## Prerequisite

[Plan-025](../plans/025-remote-control.md) complete through Phase 6, and two of Phase 7's pieces before it: the web client and the one-column fold on every screen. The phone is a device like any other, so it needs the channel, the method proxy, the account's statement chain and push to already exist. Nothing in this spec re-specifies them. One thing only the outside world can supply gates part of it: the person's Apple Developer Program membership, for the signing certificate, the registered-device profile and the APNs key.

## Parity

From the phone, the user can:

- read the live transcript and session history
- send a message
- steer a run in flight
- stop a run
- answer an approval, a question or a plan, where the first answer from any device settles it and a card answered elsewhere closes with `Answered on <device>`
- configure and drive agents
- view the diff
- open and use the terminal
- reach every screen: the sessions list, Sidekicks, Skills, Workflows and Settings, its Devices page included

## Shape

The iPhone app is the console's one front end in a Capacitor shell, never a second app written in SwiftUI. A native client would be a second set of rows, a second transcript and a second vocabulary, and it would draw Preview, Review, the terminal and the Workflows canvas a second time and fall behind the desktop at each change. The shell runs the console bundle each linked machine serves to it, through the phone implementation of the front end's `PlatformBridge` ([Spec-027 §The phone and web clients](027-remote-control.md#the-phone-and-web-clients)), so the iPhone gets every screen the day that machine's service ships it.

It is native only where the phone must do something a page cannot. Each piece is a member of the phone bridge; a desktop-only member is absent.

| Piece | How |
| --- | --- |
| Device key | A small plugin of the app's own over CryptoKit's `SecureEnclave.P256.Signing`: make the key, read its public half, sign a digest. The key's handle sits in the keychain under `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. |
| Channel key | A member of the same plugin runs the channel's key exchange natively: it makes the X25519 channel key, keeps it in the keychain under `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, hands the page its public half, and for every handshake exchange on that key takes the other end's public key and returns the shared result, so the channel key never enters the page. Each handshake's ephemeral X25519 key is the page's own, made with WebCrypto as a non-extractable key, fresh for every handshake, never stored and dropped when the handshake ends, the same code the web client runs. A non-extractable key's bytes can never be read out, but script in the page can use the key while the page lives, and the shared secret `deriveBits` returns, with the Noise session keys made from it, sits in page memory, as on the web client. ([Spec-027 §The encryption envelope](027-remote-control.md#the-encryption-envelope)) |
| Push | `@capacitor/push-notifications` for the APNs token, handed to `device.pushAddressSet`, and the tap. A Notification Service Extension in Swift opens the sealed notice with CryptoKit's `HPKE` (X-Wing) and sets the title, body, thread and badge. The push key is shared with the extension through the app's keychain group under `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, and each machine's count through an App Group, so the badge is the sum. The remote-notifications background mode serves the withdrawal push. |
| Cover | `@aparajita/capacitor-biometric-auth` on each return to the foreground, with the passcode as the fallback. A plain cover view is placed before the app switcher's snapshot is taken. |
| Scan | `@capacitor-mlkit/barcode-scanning`. |
| Links | `@capacitor/app`'s URL-open event for `sidekicks://session/<id>`, and its foreground and background events, which close and reopen the channel. |
| Back | A left-edge swipe recognizer in the shell dispatches one marked dismissal; the web view's own back-and-forward gestures stay off. |
| Shared ports | A plugin that presents a full-screen page view at `http://localhost:<port>`, backed by a Network framework listener on `127.0.0.1` that runs only while the view is shown. Each accepted connection becomes one `preview.portTunnelOpen` stream, its bytes riding as attachments, and after a reconnect the stream resumes by byte offset with `preview.portTunnelResume {tunnelId, receivedOffset}`, the phone keeping its unacknowledged tail, which the 256 KB window bounds, for a grace period. |
| Saved files | `@capacitor/filesystem` 8.1.4 writes a file a page in Preview saved for the phone ([Spec-027 §What another device shows and does](027-remote-control.md#what-another-device-shows-and-does)) into a folder of its own per save in the app's cache folder, `saves/<saveId>/`, under the name the save carries cleaned as the machine cleans a staged name, as its parts arrive: the first part's base64 with `writeFile` and each later one with `appendFile`, so the phone holds one part, at most 256 KiB, in memory and two files of one name never meet. A save whose last part never came, because the channel dropped or the app left the foreground, is deleted and sent again whole when the app comes back. `@capacitor/share` 8.0.3 then hands the file's `file://` address, from `getUri`, to the system share sheet, `UIActivityViewController`, whose `Save to Files` puts it in Files, and the save's folder is deleted with `rmdir` whether `share()` resolves or rejects (`Share canceled` on a dismissed sheet). The phone shows one sheet at a time, because the plugin rejects a second share while a sheet is up (`Can't share while sharing is in progress`, [`SharePlugin.swift`](https://github.com/ionic-team/capacitor-plugins/blob/%40capacitor/share%408.0.3/share/ios/Sources/SharePlugin/SharePlugin.swift)), so the machine sends the next save once the phone acknowledges this one. Both are Capacitor's own plugins for Capacitor 8, under the MIT license, and documented for this: the share call's `files` takes `file://` addresses of the app's own files on iOS ([Capacitor: Share](https://capacitorjs.com/docs/apis/share), [Capacitor: Filesystem](https://capacitorjs.com/docs/apis/filesystem)). A picker of the app's own over `UIDocumentPickerViewController` would save to Files directly but is native code to keep, where the share sheet already offers Files and every other app that takes the file. |
| Staged bundles | Each linked machine serves its console bundle over the end-to-end channel with the list of its files and each one's SHA-256, each file's bytes riding as an attachment. The app checks the bundle file by file against that list, which catches a partial or corrupt transfer and nothing more, since the channel already proves the machine, and writes it into the app's container, one bundle per machine, switched in at the next start with `WebView.setServerBasePath` and `persistServerBasePath`, so a phone linked to two machines at different versions opens each with its own. Only the shared console assets come from a machine; the app's native code and its platform bridge ship with the app and are never downloaded from a machine. |
| Permissions text | `NSCameraUsageDescription` (the scan), `NSFaceIDUsageDescription` (the cover) and `NSMicrophoneUsageDescription` (voice). |

A label opens on touch the front end's way ([Spec-021](021-desktop-app-and-renderer.md)): the phone has no hover label of its own, so a held touch opens a control's label and a plain tap keeps the control's action, unless the trigger or a row around it raises a held-touch menu, which then rises instead and the lift runs nothing; the system's held-touch callout and text selection are off on every trigger that carries a label, so the held touch opens the label alone; and a label that explains a control which already has its own name is spoken as that control's VoiceOver hint.

It adds no background mode for keeping a connection, no background refresh, no location and no VoIP push. Its lowest iOS is 26, because the extension opens X-Wing natively and CryptoKit's X-Wing starts at iOS 26.0.

The phone keeps the enclave key's handle, the channel key, the push key and the pinned machine keys in the keychain (`ThisDeviceOnly`); the appearance record, keyboard map, notification switches and the machine in view in the app's preferences; each machine's count in the App Group; and each machine's staged bundle until that machine's next one replaces it. A handshake's ephemeral key is kept nowhere: the page drops it when the handshake ends. Nothing else from a session is written to the phone but a file a page in Preview saved for it, kept in the cache only until its share sheet closes.

Resource budget, the acceptance criteria measured on a real iPhone with the sessions list, one session streaming and Preview open: under 200 MB resident with one session and one pane open; the transcript scrolls at the display's rate; a return to the foreground shows the session within one second on a good connection, which covers one handshake and one resume; the extension opens a notice well inside Apple's time limit; and nothing runs in the background, so the app draws nothing between pushes.

## Key custody on the phone

The app's device identity key is a P-256 signing key made in the Secure Enclave. It never leaves the enclave and cannot be exported. The app keeps only the enclave's opaque handle, in the keychain under `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`: Apple's documentation says such an item "can be accessed only while the device is unlocked by the user" and that "Items with this attribute do not migrate to a new device" ([Apple](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly)). The X25519 channel key is a separate key under the same attribute, because the channel runs only while the app is in front; the bridge runs its exchanges natively, so it never reaches the page. The push key is a separate key-agreement key under `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, shared with the Notification Service Extension through the app's keychain group, because a push arrives while the phone is locked and that attribute "is recommended for items that need to be accessed by background applications" ([Apple](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly)). The key is P-256 because the Secure Enclave's key types are P-256, ML-KEM and ML-DSA and include no Ed25519 ([Apple](https://developer.apple.com/documentation/cryptokit/secureenclave)), so the public key is tagged `p256`.

Deleting and reinstalling the app, restoring a backup onto another phone, or moving to a new phone all leave the app with no key: it opens on the linking screen, and the old key is revoked from any other device. Restoring a phone's own backup onto the same phone also starts unlinked, since the keychain item is `ThisDeviceOnly`. The enclave key needs no biometric of its own: the cover already gates the app, and a biometric on every signature would prompt at every reconnect.

## In the background

When an app moves to the background, iOS gives it five seconds before it is suspended ([Apple](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time)); a background push gives it 30 seconds, and Apple asks that background pushes be sent no more than two or three times an hour ([Apple](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)). So the app keeps no connection in the background, and needs none: the session runs on the machine whatever the phone does. When the app leaves the foreground it closes its channel, which also gives back any shell lease the phone held and ends its presence. Attention reaches it by push. When it comes back it reconnects with one fresh handshake and resumes every stream from its last event, with no gap.

A session shows nothing about a phone that is asleep: a message carries no device mark, and there is no connected-devices banner. The phone's card on the Devices page reads `Last seen 12 min ago`, and a shell the phone held is free for the next device to type in. When the phone wakes, it shows the session as it now stands, with anything answered elsewhere closed by `Answered on <device>`.

## Approvals by push

An approval, a question or a plan that starts waiting while the phone has no connection raises `Waiting on you` on the phone by push. It carries the session's name and state and never what was said. The notice is sealed on the machine to the phone's push key with HPKE and X-Wing, so APNs, Apple and the relay carry bytes they cannot open. The request carries `mutable-content: 1`, so the Notification Service Extension ([Apple](https://developer.apple.com/documentation/usernotifications/unnotificationserviceextension)) opens the notice and writes the real title; if it cannot, the notification reads `A session changed. Open the app to see it.` The phone answers from the card in the composer after opening the app. There is no answer button on the notification itself, because an approval card carries the command, the edited path and the reason line, which a notification action cannot show. When the moment resolves elsewhere, the notification is replaced in place by its stable id, or withdrawn ([Spec-027 §Notifications on another device](027-remote-control.md#notifications-on-another-device)).

## Distribution and review

The app is built from the repository and signed under the person's own Apple developer account, installed on their registered iPhone, or through TestFlight, where a build can be tested for up to 90 days ([Apple](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)). Its push goes out with the person's own APNs key, which their relay holds. It is never listed on the public App Store, so no listing and no public review decides what it may do.

## Open Questions

None.

## References

- [Spec-027: Remote Control](027-remote-control.md)
- [Plan-025: Remote Control](../plans/025-remote-control.md) — Phase 7 builds the app.
- [Apple — CryptoKit `SecureEnclave`](https://developer.apple.com/documentation/cryptokit/secureenclave)
- [Apple — CryptoKit `HPKE`](https://developer.apple.com/documentation/cryptokit/hpke)
- [Apple — Distributing your app to registered devices](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices)
