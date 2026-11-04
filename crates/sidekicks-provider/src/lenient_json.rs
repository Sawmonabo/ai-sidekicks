//! Reads a provider's JSON into typed structs that name only the members a reader uses, each member
//! read leniently: a member of another JSON type reads as absent rather than failing the whole
//! value, and every member not named is skipped without being kept. The `f64` reader alone reads
//! its value whole and drops one of another shape, since `serde_json`'s arbitrary precision, which
//! a dependency turns on, hands a fraction to a map visitor. A struct is made a lenient member with
//! [`lenient_object!`], which reads it only from a JSON object, since serde's derive would read an
//! array's items by position and that map form of a number as an object.

use std::fmt;
use std::marker::PhantomData;

use serde::Deserialize;
use serde::de::value::{MapAccessDeserializer, MapDeserializer};
use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, IntoDeserializer, MapAccess};
use serde::de::{SeqAccess, Visitor};

/// A value read leniently: the one JSON shape it takes, or `None` for any other, whose contents
/// are skipped without being kept, except by the `f64` reader, which reads the value whole first.
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

/// A member's `deserialize_with`, beside `default`: whether the member is a non-empty string, its
/// text dropped as it is read, so a person's data such as an email is never kept.
pub(crate) fn read_is_non_empty_text<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<bool, D::Error> {
    Ok(String::read(deserializer)?.is_some_and(|text| !text.is_empty()))
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
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Self::Value, A::Error> {
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
        impl<'de> serde::de::Visitor<'de> for $crate::lenient_json::LenientVisitor<$object> {
            type Value = Option<$object>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("any JSON value")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> Result<Self::Value, A::Error> {
                $crate::lenient_json::read_object(map)
            }

            $crate::lenient_json::skip_other_shapes!(
                visit_bool(bool),
                visit_str(&str),
                visit_i64(i64),
                visit_u64(u64),
                visit_f64(f64),
                visit_unit(),
            );
            $crate::lenient_json::skip_other_shapes!(@seq);
        }

        impl $crate::lenient_json::Lenient for $object {
            fn read<'de, D: serde::Deserializer<'de>>(
                deserializer: D,
            ) -> Result<Option<Self>, D::Error> {
                deserializer.deserialize_any($crate::lenient_json::LenientVisitor::<
                    $object,
                >(std::marker::PhantomData))
            }
        }
    )*};
}

pub(crate) use lenient_object;

/// The members of a JSON object read into `T` through its derived `Deserialize`, for
/// [`lenient_object!`]; `None` where `map` is `serde_json`'s map form of a number.
pub(crate) fn read_object<'de, T: Deserialize<'de>, A: MapAccess<'de>>(
    mut map: A,
) -> Result<Option<T>, A::Error> {
    let first_key = map.next_key::<String>()?;
    if first_key.as_deref().is_some_and(is_number_key) {
        map.next_value::<IgnoredAny>()?;
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        return Ok(None);
    }
    T::deserialize(MapAccessDeserializer::new(KeyReplayingMap {
        first_key,
        rest: map,
    }))
    .map(Some)
}

// Whether `key` is the one key of serde_json's map form of a number, asked of serde_json's own
// number reader so its private spelling is never copied; never so without arbitrary precision.
fn is_number_key(key: &str) -> bool {
    let number_form = MapDeserializer::<_, de::value::Error>::new(std::iter::once((key, "0")));
    serde_json::Number::deserialize(number_form).is_ok()
}

// A map whose first key was already read: that key, then the rest of the map.
struct KeyReplayingMap<A> {
    first_key: Option<String>,
    rest: A,
}

impl<'de, A: MapAccess<'de>> MapAccess<'de> for KeyReplayingMap<A> {
    type Error = A::Error;

    fn next_key_seed<K: DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, A::Error> {
        match self.first_key.take() {
            Some(key) => seed.deserialize(key.into_deserializer()).map(Some),
            None => self.rest.next_key_seed(seed),
        }
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, A::Error> {
        self.rest.next_value_seed(seed)
    }
}

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

impl<'de> Visitor<'de> for LenientVisitor<u64> {
    type Value = Option<u64>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
        Ok(Some(value))
    }

    skip_other_shapes!(
        visit_bool(bool),
        visit_str(&str),
        visit_i64(i64),
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

impl Lenient for u64 {
    fn read<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Self>, D::Error> {
        deserializer.deserialize_any(LenientVisitor::<Self>(PhantomData))
    }
}

impl Lenient for f64 {
    fn read<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Self>, D::Error> {
        // serde_json's arbitrary precision, which a dependency turns on, hands a fraction to a
        // visitor in a private form only `Value` reads, so the value is read whole and dropped.
        Ok(serde_json::Value::deserialize(deserializer)?.as_f64())
    }
}

/// A JSON array read leniently: the elements that read as `T`, every other element skipped; any
/// value that is no array reads as absent.
#[derive(Debug)]
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
