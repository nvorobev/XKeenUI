//! Xray JSONC normalization shared by config consumers.

fn strip_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escape = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                chars.next();
                for nc in chars.by_ref() {
                    if nc == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                for nc in chars.by_ref() {
                    if prev == '*' && nc == '/' {
                        break;
                    }
                    prev = nc;
                }
            }
            _ => out.push(c),
        }
    }
    out
}

fn strip_trailing_commas(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_string = false;
    let mut escape = false;
    let mut trailing_comma_at: Option<usize> = None;
    for c in input.chars() {
        if in_string {
            out.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                trailing_comma_at = None;
                out.push(c);
            }
            ',' => {
                trailing_comma_at = Some(out.len());
                out.push(c);
            }
            c if c.is_whitespace() => out.push(c),
            '}' | ']' => {
                if let Some(pos) = trailing_comma_at.take() {
                    out.truncate(pos);
                }
                out.push(c);
            }
            _ => {
                trailing_comma_at = None;
                out.push(c);
            }
        }
    }
    out
}

pub(crate) fn strip_jsonc(input: &str) -> String {
    strip_trailing_commas(&strip_comments(input))
}
