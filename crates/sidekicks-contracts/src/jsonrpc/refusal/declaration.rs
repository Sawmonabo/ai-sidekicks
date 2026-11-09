//! The macro that declares [`RefusalCode`](super::RefusalCode) and its tables from one line per
//! code.

/// Declares [`RefusalCode`](super::RefusalCode) from one line per code: its variant, its wire text
/// and, in parentheses, its category and its HTTP status, no status for a code that rides only the
/// daemon's JSON-RPC wire, then after a `;` the JSON-RPC number of a protocol outcome, none for a
/// domain refusal.
macro_rules! refusal_codes {
    (
        $(
            $(#[doc = $doc:literal])+
            $variant:ident = $code:literal
                ($category:ident $(, $status:literal)? $(; $protocol:ident)?);
        )+
    ) => {
        $(
            const _: () = assert!(
                crate::wire::name::is_wire_name($code),
                concat!("not a wire name: ", $code),
            );
        )+

        /// A refusal's code, the `data.type` of a JSON-RPC error and the `code` of an HTTP error.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum RefusalCode {
            $(
                $(#[doc = $doc])+
                #[serde(rename = $code)]
                $variant,
            )+
        }

        impl RefusalCode {
            /// The TypeScript module the refusal union is written into.
            pub const TYPESCRIPT_MODULE_PATH: &str = "jsonrpc/refusal";

            /// Every code, in the order the TypeScript union lists them.
            pub const ALL: &[Self] = &[$(Self::$variant),+];

            /// The code's wire text.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $code,)+
                }
            }

            /// The code's category, sent as `data.category`.
            pub const fn category(self) -> RefusalCategory {
                RefusalCategory::Known(self.known_category())
            }

            /// The code's category, as this build knows every one it makes.
            pub const fn known_category(self) -> KnownRefusalCategory {
                match self {
                    $(Self::$variant => KnownRefusalCategory::$category,)+
                }
            }

            /// The JSON-RPC number the code answers with: `-31000` for a domain refusal, JSON-RPC's
            /// own number for a protocol outcome.
            pub const fn json_rpc_code(self) -> JsonRpcErrorCode {
                match self {
                    $(Self::$variant => refusal_codes!(@protocol $($protocol)?),)+
                }
            }

            /// The HTTP status a control plane route answers the code with; `None` for a code
            /// that rides only the daemon's JSON-RPC wire.
            pub const fn http_status(self) -> Option<u16> {
                match self {
                    $(Self::$variant => refusal_codes!(@status $($status)?),)+
                }
            }
        }
    };
    (@protocol) => { JsonRpcErrorCode::DomainRefusal };
    (@protocol $protocol:ident) => { JsonRpcErrorCode::$protocol };
    (@status) => { None };
    (@status $status:literal) => { Some($status) };
}

pub(super) use refusal_codes;
