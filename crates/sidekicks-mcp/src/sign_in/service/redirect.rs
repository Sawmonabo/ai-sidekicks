//! Where a sign-in's browser comes back: the callback form chosen for the server and the receiver
//! bound at it. A provider's own callback is sent whole, in the form its rule gives for whether
//! the server returns `iss`; the daemon's own loopback address takes the server's id unless it
//! does.

use reqwest::Url;

use crate::oauth::redirect_receiver::{CallbackPath, RedirectListener, RedirectReceiverError};
use crate::sign_in::address_digest::ServerAddressDigest;
use crate::sign_in::service::OwnerIssuedClient;

/// The redirect a sign-in to one server binds: an owner's or a provider's callback, else the
/// daemon's own loopback address at the path the server's `iss` support picks.
#[derive(Clone, Copy)]
pub(super) struct SignInRedirect<'a> {
    owner_callback: Option<&'a Url>,
    callback_path: CallbackPath<'a>,
}

impl<'a> SignInRedirect<'a> {
    /// The redirect for a server whose owner's client is `owner`, `is_issuer_in_response` where
    /// its metadata says it returns `iss`, and whose keyed digest is `digest`.
    pub(super) fn choose(
        owner: Option<&'a OwnerIssuedClient>,
        is_issuer_in_response: bool,
        digest: &'a ServerAddressDigest,
    ) -> Self {
        let owner_callback = owner
            .and_then(|owner| owner.callback.as_ref())
            .map(|callback| {
                if is_issuer_in_response {
                    &callback.with_issuer
                } else {
                    &callback.without_issuer
                }
            });
        let callback_path = if owner_callback.is_some() || is_issuer_in_response {
            CallbackPath::Shared
        } else {
            CallbackPath::PerServer(digest.as_str())
        };
        Self {
            owner_callback,
            callback_path,
        }
    }

    /// Binds the receiver at this redirect and answers it with the redirect address the client is
    /// chosen with; an owner's callback the receiver never binds answers no receiver and that
    /// callback, so the client's order sends it to a provider's flow. Fails as the system refuses
    /// the listener.
    pub(super) async fn bind(
        self,
    ) -> Result<(Option<RedirectListener>, Url), RedirectReceiverError> {
        match RedirectListener::bind(self.owner_callback, self.callback_path).await {
            Ok(listener) => {
                let redirect_address = listener.redirect_url().clone();
                Ok((Some(listener), redirect_address))
            }
            Err(error @ RedirectReceiverError::Bind(_)) => Err(error),
            Err(
                RedirectReceiverError::NotHttp { .. }
                | RedirectReceiverError::NotLoopback { .. }
                | RedirectReceiverError::UnusablePath { .. },
            ) => Ok((
                None,
                self.owner_callback
                    .expect("the receiver refuses only an owner-issued callback")
                    .clone(),
            )),
        }
    }
}
