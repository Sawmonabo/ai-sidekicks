//! One conditional GET of the price list: the held copy's tag sent back as received, the answer's
//! body read up to a cap, and no redirect followed.

use std::time::Duration;

use bytes::Bytes;
use reqwest::header::{ETAG, IF_NONE_MATCH};
use reqwest::{StatusCode, Url};
use sidekicks_std::outbound_http::{CappedBodyError, KeptOutboundClient, read_capped_body};

/// How long one fetch waits, from the connection's start to the body's end.
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

/// The largest copy read, in bytes; the list is about 3.2 MB.
const COPY_SIZE_CAP: usize = 16 * 1024 * 1024;

/// The idle connections the list's client keeps to its host: the one a fetch at a time reuses.
pub(crate) const PRICE_LIST_IDLE_CONNECTIONS: usize = 1;

/// What one fetch of the list answered.
#[derive(Debug)]
pub(crate) enum FetchedPriceList {
    /// The held copy is current.
    NotModified,
    /// A new copy, with its tag exactly as the server sent it, `None` when it sent none readable.
    Copy {
        /// The copy's bytes, decompressed.
        bytes: Bytes,
        /// The answer's `ETag`.
        etag: Option<String>,
    },
}

/// Why a fetch of the list brought no answer to use; no error carries the list's address.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PriceListFetchError {
    /// The HTTP client could not be built.
    #[error("the price list's HTTP client could not be built")]
    Client(#[source] reqwest::Error),
    /// The request failed, timed out, or its body broke off.
    #[error("the price list's fetch failed")]
    Transport(#[source] reqwest::Error),
    /// The server answered something other than 200 or 304, a redirect among them.
    #[error("the price list's server answered {0}")]
    Status(StatusCode),
    /// The copy passed the size cap, so reading stopped.
    #[error("the price list's copy passed {COPY_SIZE_CAP} bytes")]
    TooLarge,
}

/// Sends one GET of `url` through `client`, which follows no redirect, conditional on `etag` when
/// there is one, within 60 s. The client's encodings are left as built, since the server answers
/// 304 to a tag only under the encoding that tag came with. Fails with `Client` when the client
/// cannot be built, `Status` for any answer but 200 or 304, `TooLarge` past 16 MiB, and
/// `Transport` for a failed, timed-out or broken exchange.
pub(crate) async fn fetch_price_list(
    client: &KeptOutboundClient,
    url: &Url,
    etag: Option<&str>,
) -> Result<FetchedPriceList, PriceListFetchError> {
    let client = client.client().map_err(PriceListFetchError::Client)?;
    let mut request = client.get(url.clone()).timeout(FETCH_TIMEOUT);
    if let Some(etag) = etag {
        request = request.header(IF_NONE_MATCH, etag);
    }
    let response = request.send().await.map_err(transport_error)?;
    match response.status() {
        StatusCode::NOT_MODIFIED => return Ok(FetchedPriceList::NotModified),
        StatusCode::OK => {}
        status => return Err(PriceListFetchError::Status(status)),
    }
    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let copy = read_capped_body(response, COPY_SIZE_CAP)
        .await
        .map_err(|error| match error {
            CappedBodyError::Read(error) => transport_error(error),
            CappedBodyError::TooLarge { .. } => PriceListFetchError::TooLarge,
        })?;
    Ok(FetchedPriceList::Copy {
        bytes: Bytes::from(copy),
        etag,
    })
}

fn transport_error(error: reqwest::Error) -> PriceListFetchError {
    PriceListFetchError::Transport(error.without_url())
}
