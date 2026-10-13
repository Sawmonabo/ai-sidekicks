//! The method table: every daemon method is declared once, with [`methods!`], in the contract
//! module that owns it. A declaration gives a marker type the daemon registers a handler for and a
//! table entry the TypeScript method map is generated from.

use std::sync::Arc;

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::refusal::RefusalCode;
use crate::schema::ReceivedCheckError;
use crate::typescript::TypeName;

/// How a method answers: a `query` reads and a `mutation` changes state, each with one result; a
/// `subscription` answers with an acknowledgement and then streams emissions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcedureType {
    /// Reads, with one result.
    Query,
    /// Changes state, with one result.
    Mutation,
    /// Acknowledges, then streams emissions.
    Subscription,
}

/// One method's contract as the table lists it.
#[derive(Clone, Copy, Debug)]
pub struct MethodDescriptor {
    /// The method's wire name (`browser.siteDataList`).
    pub method: &'static str,
    /// How the method answers.
    pub procedure_type: ProcedureType,
    /// Whether the method changes state; the version gate refuses a mutating call while the
    /// client's protocol version is incompatible.
    pub is_mutating: bool,
    /// The request's type.
    pub params: TypeName,
    /// The result's type: a subscription's acknowledgement.
    pub result: TypeName,
    /// A subscription's emission type; `None` exactly for a query or a mutation.
    pub emission: Option<TypeName>,
    /// The refusal codes the method answers with.
    pub refusals: &'static [RefusalCode],
    /// The check the request's params pass before they are read, built on first use; fails where
    /// the params' schema does not build a check.
    pub params_check: fn() -> Result<Arc<jsonschema::Validator>, ReceivedCheckError>,
}

/// One module's methods, written to TypeScript under `name`.
#[derive(Clone, Copy, Debug)]
pub struct MethodTable {
    /// The table's `*_METHOD_DESCRIPTORS` name.
    pub name: &'static str,
    /// The table type's TypeScript name where it is not the one derived from `name`.
    pub type_name: Option<&'static str>,
    /// The table's doc comment.
    pub doc: &'static str,
    /// The table's methods, in declaration order.
    pub methods: &'static [MethodDescriptor],
}

/// A method the daemon answers; its marker type is what a handler registers against.
pub trait Method {
    /// The request.
    type Params: Serialize + DeserializeOwned + JsonSchema + garde::Validate<Context = ()>;
    /// The result, or a subscription's acknowledgement.
    type Result: Serialize + DeserializeOwned + JsonSchema;
    /// The method's table entry.
    const DESCRIPTOR: MethodDescriptor;
}

/// A subscription method, whose stream carries `Emission` values after the acknowledgement.
pub trait SubscriptionMethod: Method {
    /// One value the stream carries.
    type Emission: Serialize + DeserializeOwned + JsonSchema;
}

/// Declares a module's method table and a marker type per method:
///
/// ```ignore
/// methods! {
///     /// The `browser.*` methods the daemon answers.
///     pub const BROWSER_METHOD_DESCRIPTORS = [
///         /// Lists the sites holding data in the shared browser profile.
///         BrowserSiteDataList = query "browser.siteDataList" {
///             mutating: false,
///             params: EmptyPayload,
///             result: BrowserSiteDataListResponse,
///             refusals: [],
///         },
///     ];
/// }
/// ```
///
/// A subscription adds `emission: Type,` after its result; a table whose TypeScript type name is
/// not derived from its own name writes it after the name (`pub const NAME: "TypeName" = [`).
macro_rules! methods {
    (@procedure query) => { $crate::method::ProcedureType::Query };
    (@procedure mutation) => { $crate::method::ProcedureType::Mutation };
    (@procedure subscription) => { $crate::method::ProcedureType::Subscription };
    (@emission query) => { None };
    (@emission mutation) => { None };
    (@emission subscription $emission:ty) => {
        Some($crate::typescript::TypeName::of::<$emission>())
    };
    (@subscription query $marker:ident) => {};
    (@subscription mutation $marker:ident) => {};
    (@subscription subscription $marker:ident $emission:ty) => {
        impl $crate::method::SubscriptionMethod for $marker {
            type Emission = $emission;
        }
    };
    (@type_name) => { None };
    (@type_name $type_name:literal) => { Some($type_name) };
    (
        $(#[doc = $table_doc:literal])+
        pub const $table:ident $(: $type_name:literal)? = [
            $(
                $(#[$meta:meta])*
                $marker:ident = $kind:ident $method:literal {
                    mutating: $mutating:literal,
                    params: $params:ty,
                    result: $result:ty,
                    $(emission: $emission:ty,)?
                    refusals: [$($refusal:ident),* $(,)?] $(,)?
                }
            ),* $(,)?
        ];
    ) => {
        $(
            $(#[$meta])*
            #[derive(Clone, Copy, Debug)]
            pub struct $marker;

            impl $crate::method::Method for $marker {
                type Params = $params;
                type Result = $result;
                const DESCRIPTOR: $crate::method::MethodDescriptor =
                    $crate::method::MethodDescriptor {
                        method: $method,
                        procedure_type: $crate::method::methods!(@procedure $kind),
                        is_mutating: $mutating,
                        params: $crate::typescript::TypeName::of::<$params>(),
                        result: $crate::typescript::TypeName::of::<$result>(),
                        emission: $crate::method::methods!(@emission $kind $($emission)?),
                        refusals: &[$($crate::jsonrpc::refusal::RefusalCode::$refusal),*],
                        params_check: $crate::schema::received_check::<$params>,
                    };
            }

            $crate::method::methods!(@subscription $kind $marker $($emission)?);
        )*

        $(#[doc = $table_doc])+
        pub const $table: $crate::method::MethodTable = $crate::method::MethodTable {
            name: stringify!($table),
            type_name: $crate::method::methods!(@type_name $($type_name)?),
            doc: concat!($($table_doc, "\n"),+),
            methods: &[$(<$marker as $crate::method::Method>::DESCRIPTOR),*],
        };
    };
}

pub(crate) use methods;

#[cfg(test)]
mod tests {
    #[test]
    fn every_method_builds_its_params_check() {
        let failures: Vec<String> = crate::typescript_modules()
            .flat_map(|module| module.method_tables)
            .flat_map(|table| table.methods)
            .filter_map(|method| {
                (method.params_check)()
                    .err()
                    .map(|error| format!("{}: {error:?}", method.method))
            })
            .collect();
        assert!(failures.is_empty(), "{failures:#?}");
    }
}
