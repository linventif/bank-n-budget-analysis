use axum::response::Html;

pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

const CSS: &str = r#"
:root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --card:#fff; --line:#e4e4df; --accent:#2f6f4f; --neg:#b3261e; --pos:#2f6f4f; --warn:#8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --fg:#ececea; --muted:#9a9a93; --card:#1f1f1d; --line:#33332f; --accent:#7cc39c; --neg:#f2a19b; --pos:#7cc39c; --warn:#e8b65c; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:1000px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:1.5rem; margin:0 0 16px; } h2 { font-size:1.1rem; margin:32px 0 12px; }
a { color:var(--accent); }
.muted { color:var(--muted); } .error { color:var(--neg); } .warn { color:var(--warn); }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
.accounts { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:12px; }
.balance { font-size:1.4rem; font-variant-numeric:tabular-nums; margin:4px 0; }
table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:600; color:var(--muted); font-size:.85rem; }
td.amount { text-align:right; white-space:nowrap; } .neg { color:var(--neg); } .pos { color:var(--pos); }
.scroll { overflow-x:auto; }
form.inline { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
select, button { font:inherit; padding:6px 10px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); }
button { background:var(--accent); color:var(--bg); border:none; cursor:pointer; }
.notice { padding:10px 14px; border-radius:8px; background:var(--card); border:1px solid var(--line); margin-bottom:16px; }
"#;

pub fn page(title: &str, body: &str) -> Html<String> {
    page_with_head(title, "", body)
}

pub fn page_with_head(title: &str, extra_head: &str, body: &str) -> Html<String> {
    Html(format!(
        "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <meta name=\"robots\" content=\"noindex,nofollow\">{extra_head}\
         <title>{}</title><style>{CSS}</style></head><body><main>{body}</main></body></html>",
        esc(title)
    ))
}

/// 123456 -> "1 234,56 €"
pub fn money(cents: i64, currency: &str) -> String {
    let sign = if cents < 0 { "−" } else { "" };
    let abs = cents.unsigned_abs();
    let int = (abs / 100).to_string();
    let mut grouped = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            grouped.push('\u{202f}');
        }
        grouped.push(c);
    }
    let symbol = match currency {
        "EUR" => "€",
        "USD" => "$",
        "GBP" => "£",
        other => other,
    };
    format!("{sign}{grouped},{:02}\u{a0}{}", abs % 100, esc(symbol))
}

/// "FR7630001007941234567890185" -> "FR76 … 0185"
pub fn mask_iban(iban: &str) -> String {
    let c: Vec<char> = iban.chars().filter(|c| !c.is_whitespace()).collect();
    if c.len() <= 8 {
        return esc(&c.iter().collect::<String>());
    }
    let head: String = c[..4].iter().collect();
    let tail: String = c[c.len() - 4..].iter().collect();
    esc(&format!("{head} … {tail}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(money(123456, "EUR"), "1\u{202f}234,56\u{a0}€");
        assert_eq!(money(-7, "EUR"), "−0,07\u{a0}€");
        assert_eq!(money(100000000, "EUR"), "1\u{202f}000\u{202f}000,00\u{a0}€");
        assert_eq!(mask_iban("FR76 3000 1007 9412 3456 7890 185"), "FR76 … 0185");
        assert_eq!(esc("<a href=\"x\">'&"), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
    }
}
