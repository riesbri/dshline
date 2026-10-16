pub fn tail(s: &[u16], n: i32) -> Text {
    if n <= 0 { return vec![]; }
    let mut remaining = display_width(s);
    if remaining <= n { return s.to_vec(); }
    let mut offset = 0;
    let mut out = Vec::new();
    for t in tokens(s) {
        offset += t.v.len();
        if remaining > n {
            remaining -= t.w;
            continue;
        }
        if t.w == 0 {
            if t.esc { append(&mut out, t.v); }
        } else {
            append(&mut out, t.v);
            append(&mut out, &s[offset..]);
            break;
        }
    }
    out
}
