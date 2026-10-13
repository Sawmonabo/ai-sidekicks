//! The hosted account's procedures on the control plane. Deleting the account removes every row the
//! control plane keeps for it and signs this machine out; a machine's own data is erased only by
//! its own erase, never by deleting the account. Exporting it returns what the control plane keeps
//! for the person, which the data export writes as `hosted-account.json`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::device::DeviceEntry;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::session::id::UserId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::text::FreeFormText;

/// `account.delete` takes nothing: the account is the caller's, and no other account is named.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AccountDeleteRequest {}

/// `account.export` takes nothing: the account is the caller's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AccountExportRequest {}

/// The account's own record, as the control plane keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AccountRecord {
    /// The person.
    pub user_id: UserId,
    /// When the account was made.
    #[garde(dive)]
    pub created_at: WireInstant,
    /// The person's display name.
    pub display_name: FreeFormText<{ usize::MAX }>,
}

/// The account record and its device list; reading them changes nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountExportResponse {
    /// The account.
    #[garde(dive)]
    pub account: AccountRecord,
    /// Its devices.
    #[garde(dive)]
    pub devices: Vec<DeviceEntry>,
}

methods! {
    /// The hosted account's procedures the control plane serves.
    pub const ACCOUNT_METHOD_DESCRIPTORS = [
        /// Deletes the caller's account.
        AccountDelete = mutation "account.delete" {
            mutating: true,
            params: AccountDeleteRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// The account record and its device list.
        AccountExport = query "account.export" {
            mutating: false,
            params: AccountExportRequest,
            result: AccountExportResponse,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the hosted account. Every method's params and result is checked, as a
/// method type is.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "account",
    doc: "The hosted account's procedures on the control plane: deleting it and exporting what \
          the control plane keeps for the person.",
    definitions: &[
        Definition::read::<AccountDeleteRequest>().checked(),
        Definition::read::<AccountExportRequest>().checked(),
        Definition::read::<AccountRecord>(),
        Definition::read::<AccountExportResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[&ACCOUNT_METHOD_DESCRIPTORS],
};
