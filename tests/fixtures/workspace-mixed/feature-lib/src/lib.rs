#[cfg(feature = "foo")]
pub fn which() -> &'static str {
    "foo"
}

#[cfg(all(feature = "bar", not(feature = "foo")))]
pub fn which() -> &'static str {
    "bar"
}

#[cfg(not(any(feature = "foo", feature = "bar")))]
pub fn which() -> &'static str {
    "none"
}
