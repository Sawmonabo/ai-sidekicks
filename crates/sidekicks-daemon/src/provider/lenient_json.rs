//! Reads a provider's JSON into typed structs that name only the members a reader uses, each member
//! read leniently: a member of another JSON type reads as absent rather than failing the whole
//! value, and every member not named is skipped without being kept. A struct is made a lenient
//! member with [`lenient_object!`], which reads it only from a JSON object, since serde's derive
//! would read an array's items by position.

use std::fmt;
use std::marker::PhantomData;

use serde::Deserialize;
use serde::de::{self, Deserializer, SeqAccess, Visitor};

/// A value read leniently: the one JSON shape it takes, or `None` for any other, whose contents
/// are skipped without being kept.
pub(crate) trait Lenient: Sized {
    /// Reads the value, `None` when the JSON holds another shape.
    fn read<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Self>, D::Error>;
}

/// A member's `deserialize_with`, beside `default`: the member as `T` reads it, `None` for a value
/// of any other shape.
pub(crate) fn read_lenient<'de, D: Deserializer<'de>, T: Lenient>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::read(deserializer)
}

/// Skips any JSON value but the one shape `Wanted` reads, which each `Visitor` impl names.
pub(crate) struct LenientVisitor<Wanted>(pub(crate) PhantomData<Wanted>);

/// The `Visitor` methods that answer `None` for the JSON shapes `Wanted` does not take: scalars by
/// method and argument, `seq` and `map` skipping every element.
macro_rules! skip_other_shapes {
    ($($skipped:ident($($argument:ty)?)),* $(,)?) => {$(
        fn $skipped<E: serde::de::Error>(self $(, _value: $argument)?) -> Result<Self::Value, E> {
            Ok(None)
        }
    )*};
    (@seq) => {
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            while sequence.next_element::<serde::de::IgnoredAny>()?.is_some() {}
            Ok(None)
        }
    };
    (@map) => {
        fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            while map.next_entry::<serde::de::IgnoredAny, serde::de::IgnoredAny>()?.is_some() {}
            Ok(None)
        }
    };
}

pub(crate) use skip_other_shapes;

/// Makes each struct a [`Lenient`] value read only from a JSON object, through its derived
/// `Deserialize`.
macro_rules! lenient_object {
    ($($object:ty),* $(,)?) => {$(
        impl<'de> serde::de::Visitor<'de> for $crate::provider::lenient_json::LenientVisitor<$object> {
            type Value = Option<$object>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("any JSON value")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> Result<Self::Value, A::Error> {
                <$object as serde::Deserialize>::deserialize(
                    serde::de::value::MapAccessDeserializer::new(map),
                )
                .map(Some)
            }

            $crate::provider::lenient_json::skip_other_shapes!(
                visit_bool(bool),
                visit_str(&str),
                visit_i64(i64),
                visit_u64(u64),
                visit_f64(f64),
                visit_unit(),
            );
            $crate::provider::lenient_json::skip_other_shapes!(@seq);
        }

        impl $crate::provider::lenient_json::Lenient for $object {
            fn read<'de, D: serde::Deserializer<'de>>(
                deserializer: D,
            ) -> Result<Option<Self>, D::Error> {
                deserializer.deserialize_any($crate::provider::lenient_json::LenientVisitor::<
                    $object,
                >(std::marker::PhantomData))
            }
        }
    )*};
}

pub(crate) use lenient_object;

impl<'de> Visitor<'de> for LenientVisitor<String> {
    type Value = Option<String>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(Some(value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
        Ok(Some(value))
    }

    skip_other_shapes!(
        visit_bool(bool),
        visit_i64(i64),
        visit_u64(u64),
        visit_f64(f64),
        visit_unit()
    );
    skip_other_shapes!(@seq);
    skip_other_shapes!(@map);
}

impl<'de> Visitor<'de> for LenientVisitor<bool> {
    type Value = Option<bool>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
        Ok(Some(value))
    }

    skip_other_shapes!(
        visit_str(&str),
        visit_i64(i64),
        visit_u64(u64),
        visit_f64(f64),
        visit_unit()
    );
    skip_other_shapes!(@seq);
    skip_other_shapes!(@map);
}

impl Lenient for String {
    fn read<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Self>, D::Error> {
        deserializer.deserialize_any(LenientVisitor::<Self>(PhantomData))
    }
}

impl Lenient for bool {
    fn read<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Self>, D::Error> {
        deserializer.deserialize_any(LenientVisitor::<Self>(PhantomData))
    }
}

/// A JSON array read leniently: the elements that read as `T`, every other element skipped; any
/// value that is no array reads as absent.
pub(crate) struct LenientList<T>(pub(crate) Vec<T>);

impl<'de, T: Lenient> Visitor<'de> for LenientVisitor<LenientList<T>> {
    type Value = Option<LenientList<T>>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        let mut elements = Vec::new();
        while let Some(element) = sequence.next_element::<LenientElement<T>>()? {
            elements.extend(element.0);
        }
        Ok(Some(LenientList(elements)))
    }

    skip_other_shapes!(
        visit_bool(bool),
        visit_str(&str),
        visit_i64(i64),
        visit_u64(u64),
        visit_f64(f64),
        visit_unit()
    );

    skip_other_shapes!(@map);
}

impl<T: Lenient> Lenient for LenientList<T> {
    fn read<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Self>, D::Error> {
        deserializer.deserialize_any(LenientVisitor::<Self>(PhantomData))
    }
}

/// One element of a lenient list: `None` when it reads as another shape.
pub(crate) struct LenientElement<T>(pub(crate) Option<T>);

impl<'de, T: Lenient> Deserialize<'de> for LenientElement<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        T::read(deserializer).map(Self)
    }
}
