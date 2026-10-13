//! What each contract module hands the TypeScript generator: the module's path in
//! `packages/contracts`, its definitions, the constants a client reads as values and its method
//! tables. The crate root collects every module's description.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator};

use crate::method::MethodTable;

/// One contract module's TypeScript face, written to `<path>.ts` under the generated folder.
#[derive(Clone, Copy, Debug)]
pub struct TypeScriptModule {
    /// The module's path under `packages/contracts/src`, kebab-case folders, without `.ts`.
    pub path: &'static str,
    /// The generated file's head comment.
    pub doc: &'static str,
    /// The types this module owns; each becomes one `$defs` entry and one exported type.
    pub definitions: &'static [Definition],
    /// The constants written as `export const NAME = … as const`.
    pub constants: &'static [TsConstant],
    /// The method tables written under their `*_METHOD_DESCRIPTORS` names.
    pub method_tables: &'static [&'static MethodTable],
}

/// Which side of the wire a definition's schema describes: what a reader accepts, or what the
/// writer sends, which differ where a member has a serde default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchemaContract {
    /// What deserializing accepts.
    Read,
    /// What serializing writes.
    Sent,
}

/// One type a module owns: its name, its schema and whether TypeScript gets a check for it beyond
/// the checks every method type gets.
#[derive(Clone, Copy, Debug)]
pub struct Definition {
    /// The type's schema name, which is its TypeScript name.
    pub name: fn() -> Cow<'static, str>,
    /// The type's schema, built in the generator of its contract.
    pub schema: fn(&mut SchemaGenerator) -> Schema,
    /// Which side the schema describes.
    pub contract: SchemaContract,
    /// Whether the generated file exports `validate<Name>` for it.
    pub is_checked: bool,
}

impl Definition {
    /// `T` as a reader accepts it.
    pub const fn read<T: JsonSchema>() -> Self {
        Self {
            name: T::schema_name,
            schema: T::json_schema,
            contract: SchemaContract::Read,
            is_checked: false,
        }
    }

    /// `T` as the daemon sends it, so a member it always fills is required in TypeScript.
    pub const fn sent<T: JsonSchema>() -> Self {
        Self {
            contract: SchemaContract::Sent,
            ..Self::read::<T>()
        }
    }

    /// The same definition, with an exported check.
    pub const fn checked(self) -> Self {
        Self {
            is_checked: true,
            ..self
        }
    }
}

/// A type named from a method table: its schema name, which resolves to the module that owns it.
#[derive(Clone, Copy, Debug)]
pub struct TypeName(pub fn() -> Cow<'static, str>);

impl TypeName {
    /// `T`'s name.
    pub const fn of<T: JsonSchema>() -> Self {
        Self(T::schema_name)
    }
}

/// A constant a TypeScript client reads as a value.
#[derive(Clone, Copy, Debug)]
pub struct TsConstant {
    /// The exported name, today's TypeScript name.
    pub name: &'static str,
    /// The constant's doc comment.
    pub doc: &'static str,
    /// The value as JSON; fails only where the value's own `Serialize` fails.
    pub value: fn() -> serde_json::Result<serde_json::Value>,
}

/// Declares a module's constants and its `TS_CONSTANTS` table in one place, so each constant's
/// doc is written once. `pub const NAME: T = value;` declares a Rust constant and lists it;
/// `NAME = expression;` lists a value TypeScript reads that Rust holds in another form, such as an
/// enum's variants. Every entry carries a `///` doc.
macro_rules! ts_constants {
    (@table [$(($name:ident, $doc:expr, $value:expr))*]) => {
        /// The constants this module's generated TypeScript exports, in order.
        pub(crate) const TS_CONSTANTS: &[$crate::typescript::TsConstant] = &[$(
            $crate::typescript::TsConstant { name: stringify!($name), doc: $doc, value: $value },
        )*];
    };
    (
        @table [$($table:tt)*]
        $(#[doc = $doc:literal])+
        pub const $name:ident: $type:ty = $value:expr;
        $($rest:tt)*
    ) => {
        $(#[doc = $doc])+
        pub const $name: $type = $value;
        $crate::typescript::ts_constants!(
            @table [$($table)* ($name, concat!($($doc, "\n"),+), || serde_json::to_value($name))]
            $($rest)*
        );
    };
    (
        @table [$($table:tt)*]
        $(#[doc = $doc:literal])+
        $name:ident = $value:expr;
        $($rest:tt)*
    ) => {
        $crate::typescript::ts_constants!(
            @table [$($table)* ($name, concat!($($doc, "\n"),+), || serde_json::to_value($value))]
            $($rest)*
        );
    };
    ($($entries:tt)*) => {
        $crate::typescript::ts_constants!(@table [] $($entries)*);
    };
}

pub(crate) use ts_constants;
