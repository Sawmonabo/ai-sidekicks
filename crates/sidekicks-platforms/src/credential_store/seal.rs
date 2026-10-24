//! systemd's credential service as the daemon's secrets use it: one varlink call per connection to
//! its socket, `Encrypt` to seal a value under a name for this user and `Decrypt` to open it, each
//! message one JSON object ended by one NUL byte; and the key a sealed blob was sealed with, read
//! from the blob's header without a call.
//!
//! A call sends only `name`, the value or blob, and `scope: "user"`: the service then seals with
//! the calling user's key and never asks polkit, and systemd 256, the first release to serve the
//! socket, refuses a field it does not know. Nothing stays open between calls, and at most four
//! calls run at once, under the sixteen connections the socket lets one user hold. The value
//! travels as base64 in buffers that wipe themselves, and a reply is read in place, never copied
//! into an owned string. The client sets no time limit: every caller wraps its call in its own, and
//! a call dropped by its caller closes its connection.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use secrecy::zeroize::Zeroizing;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::Semaphore;

use crate::{connect_unix_domain_socket, found_no_listener};

// The calls one client runs at once; the socket lets one user hold sixteen connections, which this
// user's other programs share.
const CONCURRENT_CALLS: usize = 4;

// The longest reply read: a credential of systemd's 1 MiB limit with its 128 KiB of header, in
// base64, fits with room to spare.
const REPLY_LIMIT: usize = 2 * 1024 * 1024;

// The bytes read from the socket at a time.
const READ_CHUNK: usize = 8 * 1024;

// The reply buffer's first size; it grows by doubling.
const FIRST_REPLY_CAPACITY: usize = 4 * 1024;

const ENCRYPT_METHOD: &str = "io.systemd.Credentials.Encrypt";
const DECRYPT_METHOD: &str = "io.systemd.Credentials.Decrypt";

// The scope that seals with the calling user's key and asks polkit for nothing.
const USER_SCOPE: &str = "user";

// The bytes of a credential's fixed header before its initialization vector: the key id, then the
// key, block, vector and tag sizes, each four bytes.
const FIXED_HEADER_BYTES: usize = 32;
const KEY_ID_BYTES: usize = 16;
const VECTOR_SIZE_OFFSET: usize = 24;
const PCR_MASK_BYTES: usize = 8;

/// systemd's credential service at its socket; see the module doc. Clones share the limit on calls
/// at once.
#[derive(Clone, Debug)]
pub struct CredentialSeal {
    socket_path: PathBuf,
    calls: Arc<Semaphore>,
}

impl CredentialSeal {
    /// The credential service listening at `socket_path`: systemd's own socket on Linux, a test's
    /// listener otherwise.
    pub fn at(socket_path: impl Into<PathBuf>) -> Self {
        Self {
            socket_path: socket_path.into(),
            calls: Arc::new(Semaphore::new(CONCURRENT_CALLS)),
        }
    }

    /// The socket the calls go to, for the service log.
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// Seals `value` under `name` with this user's key and returns the sealed blob in base64, which
    /// only [`Self::unseal`] under the same name opens. Fails with [`SealFailure`].
    pub async fn seal(&self, name: &str, value: &SecretString) -> Result<String, SealFailure> {
        let value = value.expose_secret().as_bytes();
        let encoded_length = base64::encoded_len(value.len(), true)
            .ok_or(SealFailure::Broken("the value is too long to seal"))?;
        let mut data = Zeroizing::new(vec![0_u8; encoded_length]);
        let written = STANDARD
            .encode_slice(value, &mut data[..])
            .map_err(|_too_short| SealFailure::Broken("the value's base64 did not fit"))?;
        let data = std::str::from_utf8(&data[..written])
            .map_err(|_not_text| SealFailure::Broken("the value's base64 is not text"))?;
        let message = call_message(&Call {
            method: ENCRYPT_METHOD,
            parameters: EncryptParameters {
                name,
                data,
                scope: USER_SCOPE,
            },
        })?;
        let reply = self.call(&message).await?;
        Ok(reply_parameters(&reply)?
            .blob
            .ok_or(SealFailure::Broken("the reply carries no blob"))?
            .to_owned())
    }

    /// Opens `blob`, sealed under `name` with this user's key. Fails with [`SealFailure`]: the
    /// service refuses a blob sealed under another name, with another key, or damaged.
    pub async fn unseal(&self, name: &str, blob: &str) -> Result<SecretString, SealFailure> {
        let message = call_message(&Call {
            method: DECRYPT_METHOD,
            parameters: DecryptParameters {
                name,
                blob,
                scope: USER_SCOPE,
            },
        })?;
        let reply = self.call(&message).await?;
        let data = reply_parameters(&reply)?
            .data
            .ok_or(SealFailure::Broken("the reply carries no value"))?;
        let mut value = Zeroizing::new(vec![0_u8; base64::decoded_len_estimate(data.len())]);
        let length = STANDARD
            .decode_slice(data, &mut value[..])
            .map_err(|_not_base64| SealFailure::Broken("the reply's value is not base64"))?;
        let value = std::str::from_utf8(&value[..length])
            .map_err(|_not_text| SealFailure::Broken("the opened value is not text"))?;
        Ok(SecretString::from(value))
    }

    // Sends `message` on a connection of its own and reads the reply up to its NUL. The connection
    // closes when the call ends or its caller drops it.
    async fn call(&self, message: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealFailure> {
        let _call = self
            .calls
            .acquire()
            .await
            .expect("the client never closes its own limit on calls");
        let mut connection = connect_unix_domain_socket(&self.socket_path)
            .await
            .map_err(|failure| {
                if found_no_listener(&failure) {
                    SealFailure::NoService(failure)
                } else {
                    SealFailure::Failed(failure)
                }
            })?;
        connection
            .write_all(message)
            .await
            .map_err(SealFailure::Failed)?;
        let mut reply = Zeroizing::new(Vec::with_capacity(FIRST_REPLY_CAPACITY));
        let mut chunk = Zeroizing::new([0_u8; READ_CHUNK]);
        loop {
            let read = connection
                .read(&mut chunk[..])
                .await
                .map_err(SealFailure::Failed)?;
            if read == 0 {
                return Err(SealFailure::Failed(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "the service closed the connection before its reply ended",
                )));
            }
            let (received, is_whole) = match chunk[..read].iter().position(|&byte| byte == 0) {
                Some(end) => (&chunk[..end], true),
                None => (&chunk[..read], false),
            };
            if reply.len() + received.len() > REPLY_LIMIT {
                return Err(SealFailure::Broken(
                    "the reply is longer than any credential",
                ));
            }
            append_wiping(&mut reply, received);
            if is_whole {
                return Ok(reply);
            }
        }
    }
}

/// Why a call to the credential service failed. It never carries the value or the reply's text.
#[derive(Debug, thiserror::Error)]
pub enum SealFailure {
    /// Nothing listens at the socket: no systemd, or one older than 256, which does not serve it.
    #[error("systemd's credential service is not running on this computer")]
    NoService(#[source] io::Error),
    /// The service answered with a varlink error: `error` is its name, and `errno` the system
    /// error a `io.systemd.System` error carries.
    #[error("systemd's credential service refused the call with {error}")]
    Refused {
        /// The error's name, such as `io.systemd.Credentials.BadFormat`.
        error: String,
        /// The system error number a `io.systemd.System` error carries.
        errno: Option<i64>,
    },
    /// The connection failed: it could not be opened, or closed before the reply ended.
    #[error("the connection to systemd's credential service failed")]
    Failed(#[source] io::Error),
    /// The request could not be built or the reply could not be read.
    #[error("systemd's credential service could not be used: {0}")]
    Broken(&'static str),
}

/// The key a blob was sealed with, by the key id at the start of its header. The declared order is
/// the strength, weakest first, as systemd's automatic choice ranks them: the system key alone, the
/// chip, the chip with a signed PCR policy, then each chip form pinned to the chip's storage key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SealKey {
    /// This computer's system key alone, scoped to the user (`HOST_SCOPED`).
    SystemKey,
    /// The security chip with the system key, scoped to the user
    /// (`HOST_AND_TPM2_HMAC_SCOPED`).
    Chip,
    /// The chip with the system key and a signed PCR policy, scoped to the user
    /// (`HOST_AND_TPM2_HMAC_WITH_PK_SCOPED`).
    ChipWithPublicKey,
    /// The chip with the system key, pinned to the chip's storage key, scoped to the user
    /// (`HOST_AND_TPM2_HMAC_SCOPED_PINNED_SRK`, systemd 262 and later).
    ChipPinned,
    /// The chip with the system key and a signed PCR policy, pinned to the chip's storage key,
    /// scoped to the user (`HOST_AND_TPM2_HMAC_WITH_PK_SCOPED_PINNED_SRK`, systemd 262 and later).
    ChipWithPublicKeyPinned,
}

impl SealKey {
    // Each key id systemd writes for a user-scoped credential, as `creds-util.h` defines it.
    const IDS: [([u8; KEY_ID_BYTES], Self); 5] = [
        (
            [
                0x55, 0xb9, 0xed, 0x1d, 0x38, 0x59, 0x4d, 0x43, 0xa8, 0x31, 0x9d, 0x2e, 0xbb, 0x33,
                0x2a, 0xc6,
            ],
            Self::SystemKey,
        ),
        (
            [
                0xef, 0x4a, 0xc1, 0x36, 0x79, 0xa9, 0x48, 0x0e, 0xa7, 0xdb, 0x68, 0x89, 0x7f, 0x9f,
                0x16, 0x5d,
            ],
            Self::Chip,
        ),
        (
            [
                0xad, 0xbc, 0x4c, 0xa3, 0xef, 0xb6, 0x42, 0x01, 0xba, 0x88, 0x1b, 0x6f, 0x2e, 0x40,
                0x95, 0xea,
            ],
            Self::ChipWithPublicKey,
        ),
        (
            [
                0x2a, 0x1f, 0x87, 0x7a, 0x42, 0x75, 0x43, 0x1a, 0xb3, 0xf9, 0xed, 0x1f, 0x5d, 0x8f,
                0x66, 0x01,
            ],
            Self::ChipPinned,
        ),
        (
            [
                0x16, 0xe4, 0x92, 0x94, 0x9f, 0x94, 0x40, 0x02, 0x86, 0x75, 0x8f, 0x94, 0xb7, 0xc5,
                0x2b, 0xc7,
            ],
            Self::ChipWithPublicKeyPinned,
        ),
    ];

    /// Whether the key holds the security chip beside the system key.
    pub fn uses_chip(self) -> bool {
        !matches!(self, Self::SystemKey)
    }
}

/// What a sealed blob's header says, read without a call: the key it was sealed with and, for a
/// chip key, the boot measurements (PCRs) it is bound to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SealHeader {
    key: SealKey,
    pcr_mask: u64,
}

impl SealHeader {
    /// The header of `blob`, a sealed blob in base64, or `None` when it is not one of the key ids
    /// [`SealKey`] names or is cut short.
    pub fn read(blob: &str) -> Option<Self> {
        let fixed = decode_prefix(blob, FIXED_HEADER_BYTES)?;
        let id: [u8; KEY_ID_BYTES] = fixed[..KEY_ID_BYTES].try_into().ok()?;
        let key = SealKey::IDS
            .iter()
            .find_map(|(known, key)| (*known == id).then_some(*key))?;
        if !key.uses_chip() {
            return Some(Self { key, pcr_mask: 0 });
        }
        // The chip's header follows the vector, at the next eight-byte boundary, and starts with
        // the mask of the PCRs the chip's key is bound to.
        let vector_size: [u8; 4] = fixed[VECTOR_SIZE_OFFSET..VECTOR_SIZE_OFFSET + 4]
            .try_into()
            .ok()?;
        let chip_header = usize::try_from(u32::from_le_bytes(vector_size))
            .ok()?
            .checked_add(FIXED_HEADER_BYTES)?
            .checked_next_multiple_of(8)?;
        let header = decode_prefix(blob, chip_header.checked_add(PCR_MASK_BYTES)?)?;
        let pcr_mask: [u8; PCR_MASK_BYTES] = header[chip_header..chip_header + PCR_MASK_BYTES]
            .try_into()
            .ok()?;
        Some(Self {
            key,
            pcr_mask: u64::from_le_bytes(pcr_mask),
        })
    }

    /// The key the blob was sealed with.
    pub fn key(self) -> SealKey {
        self.key
    }

    /// The mask of the PCRs the chip's key is bound to, bit `n` for PCR `n`; `0` for a blob sealed
    /// with no chip or bound to no PCR.
    pub fn pcr_mask(self) -> u64 {
        self.pcr_mask
    }

    /// Whether the blob opens only in the boot state it was sealed in, as one bound to PCR 7 stops
    /// opening once the Secure Boot settings change.
    pub fn is_boot_bound(self) -> bool {
        self.pcr_mask != 0
    }

    /// A blob in base64 whose header [`Self::read`] reads as `key` bound to `pcr_mask`, followed by
    /// `payload`, for a test's seal.
    #[cfg(any(test, feature = "test-support"))]
    pub fn test_blob(key: SealKey, pcr_mask: u64, payload: &[u8]) -> String {
        let id = SealKey::IDS
            .iter()
            .find_map(|(id, known)| (*known == key).then_some(*id))
            .expect("every key has an id");
        let mut bytes = test_header(id, pcr_mask);
        bytes.extend_from_slice(payload);
        STANDARD.encode(bytes)
    }

    /// The payload of a blob [`Self::test_blob`] made, or `None` when `blob` is not one.
    #[cfg(any(test, feature = "test-support"))]
    pub fn test_blob_payload(blob: &str) -> Option<Vec<u8>> {
        let bytes = STANDARD.decode(blob).ok()?;
        bytes.get(TEST_HEADER_BYTES..).map(<[u8]>::to_vec)
    }
}

// The bytes of a test blob's header: the fixed header, a 12-byte vector, the padding to the chip's
// header, its PCR mask and the rest of it.
#[cfg(any(test, feature = "test-support"))]
const TEST_HEADER_BYTES: usize = 96;

// A test blob's header with `id` as its key id and `pcr_mask` where a chip's header starts.
#[cfg(any(test, feature = "test-support"))]
fn test_header(id: [u8; KEY_ID_BYTES], pcr_mask: u64) -> Vec<u8> {
    let mut bytes = id.to_vec();
    for size in [32_u32, 16, 12, 16] {
        bytes.extend_from_slice(&size.to_le_bytes());
    }
    bytes.extend_from_slice(&[0; 12]);
    bytes.extend_from_slice(&[0; 4]);
    bytes.extend_from_slice(&pcr_mask.to_le_bytes());
    bytes.extend_from_slice(&[0; 40]);
    bytes
}

// One varlink call: the method and its parameters.
#[derive(Serialize)]
struct Call<'call, Parameters> {
    method: &'call str,
    parameters: Parameters,
}

// What `Encrypt` is sent.
#[derive(Serialize)]
struct EncryptParameters<'call> {
    name: &'call str,
    data: &'call str,
    scope: &'static str,
}

// What `Decrypt` is sent.
#[derive(Serialize)]
struct DecryptParameters<'call> {
    name: &'call str,
    blob: &'call str,
    scope: &'static str,
}

// A reply, its strings borrowed from the reply's buffer.
#[derive(Deserialize)]
struct Reply<'reply> {
    #[serde(borrow, default)]
    error: Option<&'reply str>,
    #[serde(borrow, default)]
    parameters: Option<ReplyParameters<'reply>>,
}

// The parameters of a reply: the blob `Encrypt` answers, the value `Decrypt` answers, or the
// system error an `io.systemd.System` error carries.
#[derive(Deserialize)]
struct ReplyParameters<'reply> {
    #[serde(borrow, default)]
    blob: Option<&'reply str>,
    #[serde(borrow, default)]
    data: Option<&'reply str>,
    #[serde(default)]
    errno: Option<i64>,
}

// `call` as JSON with the NUL that ends it, in a buffer sized before it is filled, so its growth
// leaves no partial copy of a value behind.
fn call_message<Parameters: Serialize>(
    call: &Call<'_, Parameters>,
) -> Result<Zeroizing<Vec<u8>>, SealFailure> {
    let length = json_utf8_byte_length(call)
        .map_err(|_unwritable| SealFailure::Broken("the call cannot be written as JSON"))?;
    let mut message = Zeroizing::new(Vec::with_capacity(length + 1));
    serde_json::to_writer(&mut *message, call)
        .map_err(|_unwritable| SealFailure::Broken("the call cannot be written as JSON"))?;
    message.push(0);
    Ok(message)
}

// The parameters of a reply that succeeded. Fails with the service's error, or when the reply is
// not a varlink reply; the parser's message, which can quote the reply, is never kept.
fn reply_parameters(reply: &[u8]) -> Result<ReplyParameters<'_>, SealFailure> {
    let reply: Reply<'_> = serde_json::from_slice(reply)
        .map_err(|_quotes_the_reply| SealFailure::Broken("the reply is not a varlink reply"))?;
    match (reply.error, reply.parameters) {
        (Some(error), parameters) => Err(SealFailure::Refused {
            error: error.to_owned(),
            errno: parameters.and_then(|parameters| parameters.errno),
        }),
        (None, Some(parameters)) => Ok(parameters),
        (None, None) => Err(SealFailure::Broken("the reply carries no parameters")),
    }
}

// Appends `bytes` to `buffer`, moving it to a buffer twice its size when it is full, so the old
// buffer is wiped as it drops rather than freed with its bytes in it.
fn append_wiping(buffer: &mut Zeroizing<Vec<u8>>, bytes: &[u8]) {
    let needed = buffer.len() + bytes.len();
    if needed > buffer.capacity() {
        let mut larger = Zeroizing::new(Vec::with_capacity(needed.max(buffer.capacity() * 2)));
        larger.extend_from_slice(buffer);
        *buffer = larger;
    }
    buffer.extend_from_slice(bytes);
}

// The first `byte_count` bytes `blob` encodes, or `None` when it encodes fewer or is not base64.
fn decode_prefix(blob: &str, byte_count: usize) -> Option<Vec<u8>> {
    let characters = byte_count.div_ceil(3).checked_mul(4)?;
    let prefix = blob.get(..characters)?;
    let decoded = STANDARD.decode(prefix).ok()?;
    (decoded.len() >= byte_count).then_some(decoded)
}

#[cfg(all(test, unix))]
mod tests {
    use std::path::Path;
    use std::time::Duration;

    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use rstest::rstest;
    use secrecy::{ExposeSecret, SecretString};
    use serde_json::{Value, json};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::{UnixListener, UnixStream};

    use super::{CredentialSeal, REPLY_LIMIT, SealFailure, SealHeader, SealKey, test_header};

    const NAME: &str = "ai-sidekicks-workflow-secrets.0a1b";

    // What a test's call answers, written for the assertion.
    #[derive(Debug, PartialEq)]
    enum Answer {
        Blob(String),
        Value(String),
        Refused(String, Option<i64>),
        Broken,
        Failed(String),
    }

    // Which call a case makes.
    #[derive(Clone, Copy)]
    enum Method {
        Seal,
        Unseal,
    }

    // Reads one message from `connection` up to its NUL, or `None` when it closes first.
    async fn read_message(connection: &mut UnixStream) -> Option<Vec<u8>> {
        let mut message = Vec::new();
        let mut byte = [0_u8; 1];
        loop {
            if connection.read(&mut byte).await.ok()? == 0 {
                return None;
            }
            if byte[0] == 0 {
                return Some(message);
            }
            message.push(byte[0]);
        }
    }

    // A listener in `folder` that answers its first connection's message with `reply` and hands
    // back the message it read.
    fn answer_once(folder: &Path, reply: Vec<u8>) -> tokio::task::JoinHandle<Value> {
        let listener = UnixListener::bind(folder.join("credentials")).expect("the test binds");
        tokio::spawn(async move {
            let (mut connection, _) = listener.accept().await.expect("the client connects");
            let message = read_message(&mut connection)
                .await
                .expect("the client sends a message ended by a NUL");
            // A client that stops reading at its limit closes the connection under this write.
            let _written = connection.write_all(&reply).await;
            serde_json::from_slice(&message).expect("the message is JSON")
        })
    }

    async fn make_call(seal: &CredentialSeal, method: Method) -> Answer {
        let answer = match method {
            Method::Seal => seal
                .seal(NAME, &SecretString::from("hunter2"))
                .await
                .map(Answer::Blob),
            Method::Unseal => seal
                .unseal(NAME, "QkxPQg==")
                .await
                .map(|value| Answer::Value(value.expose_secret().to_owned())),
        };
        answer.unwrap_or_else(|failure| match failure {
            SealFailure::Refused { error, errno } => Answer::Refused(error, errno),
            SealFailure::Broken(_) => Answer::Broken,
            unexpected @ (SealFailure::NoService(_) | SealFailure::Failed(_)) => {
                Answer::Failed(format!("{unexpected:?}"))
            }
        })
    }

    /// Each call sends exactly its method, the name, the value or blob, and the user scope, ended
    /// by a NUL, and reads its reply to the NUL alone. Mutations: drop `scope`; add `timestamp` or
    /// `uid`; end the message with a newline (the listener never reads a whole message); read past
    /// the NUL (the trailing message breaks the reply); read a reply past the limit.
    #[rstest]
    #[case::seal(
        Method::Seal,
        b"{\"parameters\":{\"blob\":\"QkxPQg==\"}}\0{\"error\":\"later\"}\0".to_vec(),
        json!({
            "method": "io.systemd.Credentials.Encrypt",
            "parameters": {"name": NAME, "data": STANDARD.encode("hunter2"), "scope": "user"},
        }),
        Answer::Blob("QkxPQg==".to_owned())
    )]
    #[case::unseal(
        Method::Unseal,
        format!(
            "{{\"parameters\":{{\"data\":\"{}\"}}}}\0",
            STANDARD.encode("hunter2")
        )
        .into_bytes(),
        json!({
            "method": "io.systemd.Credentials.Decrypt",
            "parameters": {"name": NAME, "blob": "QkxPQg==", "scope": "user"},
        }),
        Answer::Value("hunter2".to_owned())
    )]
    #[case::refused(
        Method::Unseal,
        b"{\"error\":\"io.systemd.System\",\"parameters\":{\"errno\":131}}\0".to_vec(),
        json!({
            "method": "io.systemd.Credentials.Decrypt",
            "parameters": {"name": NAME, "blob": "QkxPQg==", "scope": "user"},
        }),
        Answer::Refused("io.systemd.System".to_owned(), Some(131))
    )]
    #[case::past_the_limit(
        Method::Seal,
        vec![b'a'; REPLY_LIMIT + 1],
        json!({
            "method": "io.systemd.Credentials.Encrypt",
            "parameters": {"name": NAME, "data": STANDARD.encode("hunter2"), "scope": "user"},
        }),
        Answer::Broken
    )]
    #[tokio::test]
    async fn a_call_sends_its_message_and_reads_its_reply(
        #[case] method: Method,
        #[case] reply: Vec<u8>,
        #[case] expected_message: Value,
        #[case] expected_answer: Answer,
    ) {
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let listener = answer_once(folder.path(), reply);
        let seal = CredentialSeal::at(folder.path().join("credentials"));

        let answer = tokio::time::timeout(Duration::from_secs(5), make_call(&seal, method))
            .await
            .expect("the call answers");
        let message = listener.await.expect("the listener reads the message");

        assert_eq!(message, expected_message);
        assert_eq!(answer, expected_answer);
    }

    /// A socket path with nothing listening is no service, never a refusal. Mutation: read every
    /// connect failure as `Failed`.
    #[tokio::test]
    async fn a_socket_with_no_listener_is_no_service() {
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let seal = CredentialSeal::at(folder.path().join("credentials"));

        let failure = seal
            .seal(NAME, &SecretString::from("hunter2"))
            .await
            .expect_err("nothing listens");

        assert!(matches!(failure, SealFailure::NoService(_)), "{failure:?}");
    }

    /// A call whose service never answers ends when its caller stops waiting, its connection
    /// closed, and the next call gets its own reply on a connection of its own. Mutations: keep
    /// the connection open past the call (the listener never sees it close); wait with no bound.
    #[tokio::test]
    async fn a_call_given_up_closes_its_connection_and_the_next_reads_its_own_reply() {
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let listener =
            UnixListener::bind(folder.path().join("credentials")).expect("the test binds");
        let seal = CredentialSeal::at(folder.path().join("credentials"));
        let service = tokio::spawn(async move {
            let (mut silent, _) = listener.accept().await.expect("the first call connects");
            read_message(&mut silent)
                .await
                .expect("the first call sends");
            // The first connection closes once its caller stops waiting.
            let closed = read_message(&mut silent).await.is_none();
            let (mut answered, _) = listener.accept().await.expect("the second call connects");
            read_message(&mut answered)
                .await
                .expect("the second call sends");
            answered
                .write_all(b"{\"parameters\":{\"blob\":\"U0VDT05E\"}}\0")
                .await
                .expect("the reply is written");
            closed
        });

        let first = tokio::time::timeout(
            Duration::from_millis(200),
            seal.seal(NAME, &SecretString::from("first")),
        )
        .await;
        let second = tokio::time::timeout(
            Duration::from_secs(5),
            seal.seal(NAME, &SecretString::from("second")),
        )
        .await
        .expect("the second call answers");
        let closed = tokio::time::timeout(Duration::from_secs(5), service)
            .await
            .expect("the listener ends")
            .expect("the listener's task ends");

        assert!(first.is_err(), "the first call is given up");
        assert!(closed, "the given-up call's connection closes");
        assert_eq!(second.expect("the second call is sealed"), "U0VDT05E");
    }

    fn blob(id: [u8; 16], pcr_mask: u64) -> String {
        STANDARD.encode(test_header(id, pcr_mask))
    }

    fn id(key: SealKey) -> [u8; 16] {
        SealKey::IDS
            .iter()
            .find_map(|(id, known)| (*known == key).then_some(*id))
            .expect("every key has an id")
    }

    /// Each of the five key ids reads its key, a chip key reads its PCR mask, and an unknown id
    /// reads nothing. Mutations: read the system key as a chip key; accept an unknown id; read the
    /// mask before the eight-byte boundary.
    #[rstest]
    #[case::system_key(id(SealKey::SystemKey), 0x80, Some((SealKey::SystemKey, 0)))]
    #[case::chip_bound_to_pcr_7(id(SealKey::Chip), 0x80, Some((SealKey::Chip, 0x80)))]
    #[case::chip_bound_to_nothing(id(SealKey::Chip), 0, Some((SealKey::Chip, 0)))]
    #[case::chip_with_public_key(
        id(SealKey::ChipWithPublicKey),
        0x80,
        Some((SealKey::ChipWithPublicKey, 0x80))
    )]
    #[case::chip_pinned(id(SealKey::ChipPinned), 0, Some((SealKey::ChipPinned, 0)))]
    #[case::chip_with_public_key_pinned(
        id(SealKey::ChipWithPublicKeyPinned),
        0x80,
        Some((SealKey::ChipWithPublicKeyPinned, 0x80))
    )]
    #[case::unknown_id([0x5a; 16], 0, None)]
    fn a_blobs_header_reads_its_key_and_pcr_mask(
        #[case] id: [u8; 16],
        #[case] pcr_mask: u64,
        #[case] expected: Option<(SealKey, u64)>,
    ) {
        let header = SealHeader::read(&blob(id, pcr_mask));

        assert_eq!(
            header.map(|header| (header.key(), header.pcr_mask())),
            expected
        );
        assert_eq!(
            header.map(SealHeader::is_boot_bound),
            expected.map(|(_, mask)| mask != 0)
        );
    }
}
