#![no_main]
use dshline_renderer::*;
use libfuzzer_sys::fuzz_target;
fuzz_target!(|bytes: &[u8]| {
    if bytes.len() > 4096 {
        return;
    }
    let s: Text = bytes
        .chunks(2)
        .map(|b| u16::from_le_bytes([b[0], *b.get(1).unwrap_or(&0)]))
        .collect();
    let budget = bytes.first().copied().unwrap_or(0) as i32 - 16;
    let _ = display_width(&s);
    let _ = strip_ansi(&s);
    let _ = truncate(&s, budget);
    let _ = tail(&s, budget);
    let _ = wrap(&s, budget);
    let _ = chunk(&s, budget);
    assert_eq!(split_columns(&s, 1, 7).concat(), s);
    let _ = escape(&s);
    let _ = sanitize(&s);
    let p = Palette::default();
    let _ = inline(&s, &p);
    let _ = markdown(&s, &p);
    let _ = markdown_transition(&s, &MarkdownState::default(), &p, true, false);
});
