//! The provider name of a new passkey: the community AAGUID list, fetched at registration verify,
//! maps the authenticator's AAGUID to the name a person knows it by. A list that cannot be fetched
//! or read gives no name and is logged; the passkey registers either way.

use std::collections::HashMap;
use std::future::Future;

use serde::Deserialize;
use sidekicks_contracts::trust_statement::PlatformDescription;
use sidekicks_contracts::webauthn::ceremony::Aaguid;
use sidekicks_contracts::wire::text::TextError;

/// The AAGUID an authenticator that names none sends.
const NAMELESS_AAGUID: &str = "00000000-0000-0000-0000-000000000000";

/// Fetches the AAGUID list's JSON text.
pub trait AuthenticatorList: Clone + Send + Sync + 'static {
    /// The list as fetched; fails when it could not be fetched in time.
    fn fetch_list(&self) -> impl Future<Output = Result<String, AuthenticatorListError>> + Send;
}

/// Why the list could not be fetched.
#[derive(Debug, thiserror::Error)]
pub enum AuthenticatorListError {
    /// The fetch failed or answered a failure status; its own words are kept.
    #[error("the authenticator list could not be fetched: {0}")]
    Fetch(String),
    /// The fetch did not finish within its wait.
    #[error("the authenticator list was not fetched in time")]
    TimedOut,
}

/// Why the fetched list gave no name: it did not read, it is retired, or the name it holds is one
/// the wire refuses.
#[derive(Debug, thiserror::Error)]
enum AuthenticatorListUnread {
    /// The text is not the list's JSON.
    #[error("the authenticator list did not read")]
    Malformed(#[from] serde_json::Error),
    /// The list is the empty object, the form it takes once it is retired.
    #[error("the authenticator list is retired: it holds no authenticator")]
    Retired,
    /// The list's name for the AAGUID is one a provider name on the wire cannot carry.
    #[error("the authenticator list's name for the AAGUID is refused")]
    NameRefused(#[from] TextError),
}

#[derive(Deserialize)]
struct AuthenticatorEntry {
    name: String,
}

/// The provider name the list gives `aaguid`, or `None` for the all-zero AAGUID, one the list
/// does not hold, or a list that could not be fetched or read or whose name the wire refuses,
/// which is logged with `request_id`.
pub(crate) async fn read_provider_name<L: AuthenticatorList>(
    list: &L,
    aaguid: &Aaguid,
    request_id: Option<&str>,
) -> Option<PlatformDescription> {
    if aaguid.as_str() == NAMELESS_AAGUID {
        return None;
    }
    let text = match list.fetch_list().await {
        Ok(text) => text,
        Err(error) => {
            crate::server::log_internal_failure(request_id, &error);
            return None;
        }
    };
    match find_name(&text, aaguid) {
        Ok(name) => name,
        Err(error) => {
            crate::server::log_internal_failure(request_id, &error);
            None
        }
    }
}

fn find_name(
    text: &str,
    aaguid: &Aaguid,
) -> Result<Option<PlatformDescription>, AuthenticatorListUnread> {
    let mut entries: HashMap<String, AuthenticatorEntry> = serde_json::from_str(text)?;
    if entries.is_empty() {
        return Err(AuthenticatorListUnread::Retired);
    }
    match entries.remove(aaguid.as_str()) {
        Some(entry) => Ok(Some(PlatformDescription::new(entry.name)?)),
        None => Ok(None),
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) use worker_list::WorkerAuthenticatorList;

#[cfg(target_arch = "wasm32")]
mod worker_list {
    //! The Worker's fetch of the list, cached at the edge.

    use std::future::Future;
    use std::pin::pin;
    use std::time::Duration;

    use futures_util::future::{Either, select};
    use worker::send::SendFuture;
    use worker::{CfProperties, Delay, Fetch, Method, Request, RequestInit};

    use super::{AuthenticatorList, AuthenticatorListError};

    /// The community list of authenticator AAGUIDs and their names.
    const LIST_URL: &str = "https://raw.githubusercontent.com/passkeydeveloper/\
                            passkey-authenticator-aaguids/main/aaguid.json";

    /// How long the edge keeps a fetched copy, in seconds.
    const LIST_CACHE_SECONDS: i32 = 86_400;

    /// How long a registration waits for the list.
    const LIST_WAIT: Duration = Duration::from_secs(3);

    /// The Worker's fetch of the AAGUID list.
    #[derive(Clone, Copy, Debug)]
    pub(crate) struct WorkerAuthenticatorList;

    impl AuthenticatorList for WorkerAuthenticatorList {
        fn fetch_list(
            &self,
        ) -> impl Future<Output = Result<String, AuthenticatorListError>> + Send {
            SendFuture::new(async {
                let fetched = pin!(async {
                    let mut init = RequestInit::new();
                    // Every `cf` field is sent once one is set; the others keep their defaults.
                    init.with_method(Method::Get)
                        .with_cf_properties(CfProperties {
                            cache_ttl: Some(LIST_CACHE_SECONDS),
                            ..CfProperties::default()
                        });
                    let request = Request::new_with_init(LIST_URL, &init)?;
                    let mut response = Fetch::Request(request).send().await?;
                    if response.status_code() != 200 {
                        return Err(worker::Error::RustError(format!(
                            "status {}",
                            response.status_code()
                        )));
                    }
                    response.text().await
                });
                let wait = pin!(Delay::from(LIST_WAIT));
                match select(fetched, wait).await {
                    Either::Left((fetched, _)) => {
                        fetched.map_err(|error| AuthenticatorListError::Fetch(error.to_string()))
                    }
                    Either::Right(((), _)) => Err(AuthenticatorListError::TimedOut),
                }
            })
        }
    }
}
