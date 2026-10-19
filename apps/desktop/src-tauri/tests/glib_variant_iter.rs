#![cfg(target_os = "linux")]

use glib::variant::ToVariant;

#[test]
fn 문자열_반복자는_빈_문자열과_유니코드를_모든_접근_방식으로_반환한다() {
    let strings = ["", "한글", "🙂", "last"];
    let variant = strings.to_variant();

    assert_eq!(
        variant.array_iter_str().unwrap().collect::<Vec<_>>(),
        strings
    );
    assert_eq!(
        variant.array_iter_str().unwrap().rev().collect::<Vec<_>>(),
        ["last", "🙂", "한글", ""]
    );
    assert_eq!(variant.array_iter_str().unwrap().last(), Some("last"));

    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.next(), Some(""));
    assert_eq!(iter.nth(1), Some("🙂"));
    assert_eq!(iter.next(), None);

    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.nth_back(1), Some("🙂"));
    assert_eq!(iter.next_back(), Some("한글"));
    assert_eq!(iter.next(), Some(""));
    assert_eq!(iter.next_back(), None);
}

#[test]
fn 빈_배열의_문자열_반복자는_모든_접근에서_요소를_반환하지_않는다() {
    let variant = Vec::<String>::new().to_variant();
    let mut iter = variant.array_iter_str().unwrap();

    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
    assert_eq!(iter.nth(usize::MAX), None);
    assert_eq!(iter.nth_back(usize::MAX), None);
    assert_eq!(iter.last(), None);
}
