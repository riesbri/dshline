pub fn wrap(s: &[u16], n: i32) -> Vec<Text> {
    // General source spans can develop holes when skipped spaces follow zero-width
    // tokens. Keep the original kernel for all non-printable-ASCII paragraphs.
    if s.iter().any(|&unit| unit != 10 && !(32..127).contains(&unit)) {
        return wrap_reference(s, n);
    }
    let budget = n.max(1);
    let mut out = vec![];
    for p in s.split(|c| *c == 10) {
        if p.is_empty() { out.push(vec![]); continue; }
        let mut start = 0;
        let mut end = 0;
        let mut at = 0;
        let mut used = 0;
        let mut open: Text = vec![];
        let mut prefix: Text = vec![];
        let mut last: Option<usize> = None;
        let mut last_open = vec![];
        let mut broken = false;
        for t in tokens(p) {
            let token_start = at;
            at += t.v.len();
            if t.w == 0 {
                if t.esc {
                    if closes(t.v) { open.clear(); } else { append(&mut open, t.v); }
                }
                end = at;
                continue;
            }
            if used == 0 && t.w > budget {
                let mut line = cat(&[&prefix, &p[start..at]]);
                if !open.is_empty() { append(&mut line, &reset()); }
                out.push(line);
                prefix = open.clone();
                start = at;
                end = at;
                last = None;
                used = 0;
                broken = true;
                continue;
            }
            while used > 0 && used + t.w > budget {
                let split = last.unwrap_or(end);
                let break_open = if last.is_some() { last_open.clone() } else { open.clone() };
                let mut line = cat(&[&prefix, &p[start..split]]);
                if !break_open.is_empty() { append(&mut line, &reset()); }
                out.push(line);
                prefix = break_open;
                start = if split < end && p[split] == 32 { split + 1 } else { split };
                used = display_width(&p[start..end]);
                last = None;
                last_open.clear();
                broken = true;
            }
            if t.v == [32] && used == 0 && broken {
                // A skipped space is outside the retained contiguous source span.
                start = at;
                end = at;
                continue;
            }
            if t.v == [32] { last = Some(token_start); last_open = open.clone(); }
            used += t.w;
            end = at;
        }
        if used > 0 || out.is_empty() {
            let mut line = cat(&[&prefix, &p[start..end]]);
            if !open.is_empty() { append(&mut line, &reset()); }
            out.push(line);
        }
    }
    if out.is_empty() { out.push(vec![]); }
    out
}
