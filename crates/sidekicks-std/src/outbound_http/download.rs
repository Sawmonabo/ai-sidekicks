//! A download written to a file while it is hashed, then checked against the digest it was pinned
//! to. The file is written whole before anything opens it, so nothing reads an archive that has
//! not passed its check; a download that fails or does not match leaves no file behind.

use std::io;
use std::path::Path;

use reqwest::{Client, Response, StatusCode};
use sha2::{Digest as _, Sha256, Sha512};
use tokio::io::AsyncWriteExt as _;

use crate::cleanup_failures::CleanupFailures;
use crate::file::removal_after_failure::remove_file_after_failure;

// What a failure says it was doing, as its cleanup's log line names it.
const DOWNLOADING: &str = "the checked download";

/// The digest a download must have, as its publisher lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExpectedDigest {
    /// A SHA-256 digest.
    Sha256([u8; 32]),
    /// A SHA-512 digest.
    Sha512([u8; 64]),
}

impl ExpectedDigest {
    // The digest's bytes.
    fn as_bytes(&self) -> &[u8] {
        match self {
            Self::Sha256(digest) => digest,
            Self::Sha512(digest) => digest,
        }
    }
}

/// Why a checked download failed, told apart by whether trying again can mend it.
#[derive(Debug, thiserror::Error)]
pub enum CheckedDownloadError {
    /// The request could not be sent or was refused before an answer, a redirect past the
    /// client's policy among the reasons.
    #[error("the download's request failed")]
    Request(#[source] reqwest::Error),
    /// The server answered something other than success.
    #[error("the download's server answered {0}")]
    Status(StatusCode),
    /// The body broke off while it was read.
    #[error("the download's body broke off")]
    Body(#[source] reqwest::Error),
    /// The file could not be made or written.
    #[error("the download could not be written")]
    Write(#[source] io::Error),
    /// The body declared or passed its size cap, so reading stopped.
    #[error("the download passed its cap of {0} bytes")]
    TooLarge(u64),
    /// The bytes' digest is not the one pinned; `received` is it in lowercase hexadecimal.
    #[error("the download's digest {received} differs from its pin")]
    DigestMismatch {
        /// The digest of the bytes received.
        received: String,
    },
}

impl CheckedDownloadError {
    /// Whether a later try can end differently: a network, server or disk failure can, while a
    /// refused request, a client error, a body past its cap or a wrong digest would only fetch
    /// the same bytes for the same refusal.
    pub fn is_passing(&self) -> bool {
        match self {
            Self::Request(error) => !(error.is_builder() || error.is_redirect()),
            Self::Status(status) => {
                status.is_server_error() || *status == StatusCode::TOO_MANY_REQUESTS
            }
            Self::Body(_) | Self::Write(_) => true,
            Self::TooLarge(_) | Self::DigestMismatch { .. } => false,
        }
    }
}

/// Downloads `url` through `client` into a new file at `temporary_path`, made readable by its
/// owner alone, hashing each chunk as it is written, and answers once the whole file matches
/// `expected`. A body that declares or passes `size_cap` bytes is refused. On any failure the file
/// is removed and the failure answered with the removal's own failure beside it; a file already at
/// `temporary_path` is left as it was and refused.
pub async fn download_checked(
    client: &Client,
    url: &str,
    expected: &ExpectedDigest,
    size_cap: u64,
    temporary_path: &Path,
) -> Result<(), CleanupFailures<CheckedDownloadError, io::Error>> {
    let unmade = |failure| CleanupFailures::new(failure, Vec::new(), DOWNLOADING);
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| unmade(CheckedDownloadError::Request(error.without_url())))?;
    let status = response.status();
    if !status.is_success() {
        return Err(unmade(CheckedDownloadError::Status(status)));
    }
    // The declared length is only a hint, so the cap is held on the bytes read too.
    if response
        .content_length()
        .is_some_and(|declared| declared > size_cap)
    {
        return Err(unmade(CheckedDownloadError::TooLarge(size_cap)));
    }
    let file = sidekicks_platforms::create_new_file(temporary_path, 0o600)
        .map_err(|error| unmade(CheckedDownloadError::Write(error)))?;
    let mut file = tokio::fs::File::from_std(file);
    let written = write_checked(&mut response, &mut file, expected, size_cap).await;
    drop(file);
    written.map_err(|failure| remove_file_after_failure(failure, temporary_path, DOWNLOADING))
}

// Writes `response`'s body to `file` while hashing it, held to `size_cap` bytes, flushes it, and
// compares the whole digest with `expected`.
async fn write_checked(
    response: &mut Response,
    file: &mut tokio::fs::File,
    expected: &ExpectedDigest,
    size_cap: u64,
) -> Result<(), CheckedDownloadError> {
    let mut digest = RunningDigest::for_expected(expected);
    let mut written: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| CheckedDownloadError::Body(error.without_url()))?
    {
        written = written.saturating_add(chunk.len() as u64);
        if written > size_cap {
            return Err(CheckedDownloadError::TooLarge(size_cap));
        }
        digest.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(CheckedDownloadError::Write)?;
    }
    file.flush().await.map_err(CheckedDownloadError::Write)?;
    let received = digest.finalize();
    if received != expected.as_bytes() {
        return Err(CheckedDownloadError::DigestMismatch {
            received: base16ct::lower::encode_string(&received),
        });
    }
    Ok(())
}

// The hash of the bytes read so far, of the algorithm the expected digest names.
enum RunningDigest {
    Sha256(Sha256),
    Sha512(Sha512),
}

impl RunningDigest {
    fn for_expected(expected: &ExpectedDigest) -> Self {
        match expected {
            ExpectedDigest::Sha256(_) => Self::Sha256(Sha256::new()),
            ExpectedDigest::Sha512(_) => Self::Sha512(Sha512::new()),
        }
    }

    fn update(&mut self, bytes: &[u8]) {
        match self {
            Self::Sha256(hasher) => hasher.update(bytes),
            Self::Sha512(hasher) => hasher.update(bytes),
        }
    }

    fn finalize(self) -> Vec<u8> {
        match self {
            Self::Sha256(hasher) => hasher.finalize().to_vec(),
            Self::Sha512(hasher) => hasher.finalize().to_vec(),
        }
    }
}
