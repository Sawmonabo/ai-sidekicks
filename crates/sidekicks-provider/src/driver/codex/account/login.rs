//! The params of Codex's `account/login/start`, written by hand so a credential it carries stays a
//! secret until the request is encoded.

use secrecy::SecretString;
use serde::Serialize;

use crate::driver::codex::account::auth_file::serialize_secret;

/// One `account/login/start` request, its arm named by `type`.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum CodexLoginAccountParams {
    /// A `ChatGPT` sign-in in a browser on this machine, which returns to Codex's own callback.
    Chatgpt {},
    /// A `ChatGPT` sign-in by a device code, finished from a browser on any device.
    ChatgptDeviceCode {},
    /// A `ChatGPT` sign-in's tokens the daemon read from an account's home and hands a service that
    /// keeps no sign-in of its own; Codex holds them in its memory alone.
    #[serde(rename_all = "camelCase")]
    ChatgptAuthTokens {
        /// The sign-in's access token.
        #[serde(serialize_with = "serialize_secret")]
        access_token: SecretString,
        /// The `ChatGPT` workspace the token signs in to.
        chatgpt_account_id: String,
        /// The plan the sign-in's identity token names; `None` lets Codex read it from the access
        /// token's claims.
        chatgpt_plan_type: Option<String>,
    },
}
