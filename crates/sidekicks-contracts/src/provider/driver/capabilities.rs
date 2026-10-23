//! What a driver offers a client: its models and modes, and the execution posture a run starts
//! under. The `provider.model.list` and `provider.mode.list` replies that carry them are in the
//! driver's methods.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::provider::driver::methods::{PROVIDER_WIRE_HANDLE_MAX_LEN, PROVIDER_WIRE_TOKEN_MAX_LEN};
use crate::session::controls::methods::PermissionLevel;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::text::FreeFormText;

/// One selectable model of one provider, normalized at the driver's boundary. A model's default
/// row and its larger-window row share the model's id, so a row is found by its id and its
/// `largerWindow` together.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderModel {
    /// The model's id.
    pub id: FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>,
    /// The model's name.
    pub name: FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>,
    /// What the model can do, in the provider's words.
    pub capabilities: Vec<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>>,
    /// The model's reasoning-effort levels, as the installed build offers them; absent means the
    /// model has no effort axis, which an empty list would deny.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>>")]
    pub effort_levels: Option<Vec<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>>>,
    /// The model's output-speed levels where its provider publishes them per model; absent means
    /// the model exposes no speed selection.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>>")]
    pub output_speed_levels: Option<Vec<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>>>,
    /// Whether the model has a fast output mode, as its provider reports it.
    pub fast: bool,
    /// Whether this row is the model's larger window, offered beside its default row.
    pub larger_window: bool,
    /// The window in tokens as the provider reports it; absent until a reading arrives.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<1>")]
    pub context_window: Option<SafeInt<1>>,
}

/// The catalog row a choice names, found by the model's id and whether it is the larger window;
/// `None` when the catalog holds no such row.
pub fn find_provider_model_row<'rows>(
    rows: &'rows [ProviderModel],
    model_id: &str,
    larger_window: bool,
) -> Option<&'rows ProviderModel> {
    rows.iter()
        .find(|row| row.id.as_str() == model_id && row.larger_window == larger_window)
}

/// One selectable mode of one provider, normalized at the driver's boundary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderMode {
    /// The mode's id.
    pub id: FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>,
    /// The mode's name.
    pub name: FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>,
}

/// The name of the credential deny list handed to the provider, a reference so the list itself is
/// never embedded.
pub type CredentialPolicyRef = FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>;

/// Declares the execution posture: each permission level's arm repeats the credential policy, then
/// adds its writable roots.
macro_rules! execution_posture {
    (
        $(#[doc = $doc:literal])+
        pub enum $name:ident {
            $($(#[doc = $arm_doc:literal])+ $arm:ident { $($extra:tt)* },)+
        }
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(
            tag = "mode",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        pub enum $name {$(
            $(#[doc = $arm_doc])+
            $arm {
                /// The credential deny list handed to the provider on every level.
                credential_policy_ref: CredentialPolicyRef,
                $($extra)*
            },
        )+}
    };
}

execution_posture! {
    /// How a run may touch the machine, tagged on `mode`, the permission level: `readonly` and
    /// `yolo` carry no writable roots, so only `ask`, `reviewed` and `sandboxed` name the folders a
    /// run may write.
    pub enum ExecutionPosture {
        /// Reads only.
        Readonly {
            /// Always empty.
            writable_roots: BoundedVec<FilesystemPath, 0, 0>,
        },
        /// Asks before every change.
        Ask {
            /// The folders a run may write.
            writable_roots: Vec<FilesystemPath>,
        },
        /// Asks before a reviewed change.
        Reviewed {
            /// The folders a run may write.
            writable_roots: Vec<FilesystemPath>,
        },
        /// Runs inside the sandbox without asking.
        Sandboxed {
            /// The folders a run may write.
            writable_roots: Vec<FilesystemPath>,
        },
        /// Runs without asking.
        Yolo {
            /// Always empty.
            writable_roots: BoundedVec<FilesystemPath, 0, 0>,
        },
    }
}

impl ExecutionPosture {
    /// The credential deny list handed to the provider, the same member on every level.
    pub fn credential_policy_ref(&self) -> &CredentialPolicyRef {
        match self {
            Self::Readonly {
                credential_policy_ref,
                ..
            }
            | Self::Ask {
                credential_policy_ref,
                ..
            }
            | Self::Reviewed {
                credential_policy_ref,
                ..
            }
            | Self::Sandboxed {
                credential_policy_ref,
                ..
            }
            | Self::Yolo {
                credential_policy_ref,
                ..
            } => credential_policy_ref,
        }
    }

    /// The permission level the posture runs at, its `mode`.
    pub fn permission_level(&self) -> PermissionLevel {
        match self {
            Self::Readonly { .. } => PermissionLevel::Readonly,
            Self::Ask { .. } => PermissionLevel::Ask,
            Self::Reviewed { .. } => PermissionLevel::Reviewed,
            Self::Sandboxed { .. } => PermissionLevel::Sandboxed,
            Self::Yolo { .. } => PermissionLevel::Yolo,
        }
    }

    /// The folders a run may write: empty on `readonly` and `yolo`.
    pub fn writable_roots(&self) -> &[FilesystemPath] {
        match self {
            Self::Readonly { writable_roots, .. } | Self::Yolo { writable_roots, .. } => {
                writable_roots.as_slice()
            }
            Self::Ask { writable_roots, .. }
            | Self::Reviewed { writable_roots, .. }
            | Self::Sandboxed { writable_roots, .. } => writable_roots,
        }
    }
}

/// The TypeScript module of what a driver offers.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/capabilities",
    doc: "What a driver offers a client: its models and modes, and the execution posture a run \
          starts under.",
    definitions: &[
        Definition::read::<ProviderModel>(),
        Definition::read::<ProviderMode>(),
        Definition::read::<ExecutionPosture>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::{ProviderModel, find_provider_model_row};

    /// The case table: one catalog and the choices made against it.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct CaseTable {
        rows: Vec<ProviderModel>,
        cases: Vec<Case>,
    }

    /// One choice and the row it must find, by index, or none.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Case {
        name: String,
        model_id: String,
        larger_window: bool,
        expected_index: Option<usize>,
    }

    #[test]
    fn finds_the_row_by_model_id_and_window() {
        let table: CaseTable = serde_json::from_str(include_str!(
            "../../../tests/fixtures/provider-model-row.json"
        ))
        .expect("the case table parses");
        for case in &table.cases {
            let found = find_provider_model_row(&table.rows, &case.model_id, case.larger_window)
                .map(|row| {
                    table
                        .rows
                        .iter()
                        .position(|candidate| std::ptr::eq(candidate, row))
                        .expect("the found row is one of the rows")
                });
            assert_eq!(found, case.expected_index, "{}", case.name);
        }
    }
}
