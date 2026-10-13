//! Handle ids: a fixed prefix and a canonical index (`inputs/main/0`), parsed into the index and
//! printed back as the same text. The schema carries the index's bound as a decimal-range pattern.

/// A pattern matching exactly the canonical decimal integers `0..=max`: no sign, no leading zero.
pub fn decimal_at_most(max: u64) -> String {
    let digits: Vec<u8> = max.to_string().bytes().map(|digit| digit - b'0').collect();
    let length = digits.len();
    let mut arms = vec!["0".to_owned()];
    if length > 1 {
        // Every number with fewer digits than `max`.
        arms.push(format!("[1-9][0-9]{{0,{}}}", length - 2));
    }
    for (position, &digit) in digits.iter().enumerate() {
        // `max`'s digits up to `position`, then a smaller digit, then any digits.
        let lowest = u8::from(position == 0);
        if digit > lowest {
            let prefix: String = digits[..position].iter().map(u8::to_string).collect();
            arms.push(format!(
                "{prefix}[{lowest}-{}][0-9]{{{}}}",
                digit - 1,
                length - position - 1
            ));
        }
    }
    arms.push(max.to_string());
    format!("(?:{})", arms.join("|"))
}

/// Declares a handle id type: `handle_id!(/// doc \n InputMainHandleId, "inputs/main/");` gives a
/// newtype over the index, at most [`MAX_SAFE_INTEGER`](crate::wire::integer::MAX_SAFE_INTEGER).
macro_rules! handle_id {
    ($(#[$meta:meta])* $name:ident, $prefix:literal) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub struct $name {
            index: u64,
        }

        impl $name {
            /// The handle at `index`, or `None` past the largest exact JavaScript integer.
            pub const fn new(index: u64) -> Option<Self> {
                if index <= $crate::wire::integer::MAX_SAFE_INTEGER {
                    Some(Self { index })
                } else {
                    None
                }
            }

            /// The handle's index.
            pub const fn index(self) -> u64 {
                self.index
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.collect_str(&format_args!(concat!($prefix, "{}"), self.index))
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = <String as serde::Deserialize>::deserialize(deserializer)?;
                let index = text
                    .strip_prefix($prefix)
                    .filter(|digits| {
                        *digits == "0"
                            || (digits.starts_with(|first: char| ('1'..='9').contains(&first))
                                && digits.bytes().all(|digit| digit.is_ascii_digit()))
                    })
                    .and_then(|digits| digits.parse::<u64>().ok())
                    .and_then(Self::new);
                index.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom(concat!(
                        "a handle id is ",
                        $prefix,
                        " and a whole number from 0 with no leading zero"
                    ))
                })
            }
        }

        impl schemars::JsonSchema for $name {
            fn inline_schema() -> bool {
                true
            }

            fn schema_name() -> std::borrow::Cow<'static, str> {
                stringify!($name).into()
            }

            fn json_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                schemars::json_schema!({
                    "type": "string",
                    "pattern": format!(
                        "^{}{}$",
                        $prefix,
                        $crate::wire::handle_id::decimal_at_most(
                            $crate::wire::integer::MAX_SAFE_INTEGER
                        )
                    ),
                })
            }
        }
    };
}

pub(crate) use handle_id;
