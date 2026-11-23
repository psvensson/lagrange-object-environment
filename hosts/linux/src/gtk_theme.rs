//! GTK-specific, transient realization of ThemeResolver's already-authorized
//! fifteen semantic tokens (ADR 0015 T4). No Images services, catalog refs,
//! default palette, ACL or durable CSS state exists at this renderer boundary.
//! This is a host-side appearance adapter, NOT a seventh RendererAdapter op.

use gtk4::prelude::*;
use serde_json::Value;
use std::collections::BTreeMap;

const TYPES: [(&str, &str); 15] = [
    ("accent", "color"), ("focus", "color"), ("radius.normal", "dimension"),
    ("selection.background", "color"), ("selection.text", "color"),
    ("spacing.compact", "dimension"), ("spacing.normal", "dimension"),
    ("surface.base", "color"), ("surface.raised", "color"),
    ("text.muted", "color"), ("text.primary", "color"),
    ("typography.code.family", "fontFamily"), ("typography.code.size", "fontSize"),
    ("typography.ui.family", "fontFamily"), ("typography.ui.size", "fontSize"),
];

// The input is the *tokens array* from ThemeResolver.resolve or
// resolveCatalogDefault, not an ObjectRef, Theme record or transient authority.
// Validate the complete closed surface grammar before constructing GTK CSS,
// because these exact values will become native style declaration text.
pub fn css_for_resolved_tokens(tokens: &Value) -> Result<String, String> {
    let list = tokens.as_array().ok_or("GTK Theme requires a resolved token array")?;
    if list.len() != TYPES.len() {
        return Err("GTK Theme requires the complete 15-token resolved set".into());
    }
    let mut values = BTreeMap::new();
    for token in list {
        let object = token.as_object().ok_or("GTK Theme token must be an object")?;
        if object.len() != 3 || !object.contains_key("path")
            || !object.contains_key("type") || !object.contains_key("value") {
            return Err("GTK Theme token has unexpected fields".into());
        }
        let path = object["path"].as_str().ok_or("GTK Theme path must be text")?;
        let kind = object["type"].as_str().ok_or("GTK Theme type must be text")?;
        let expected = TYPES.iter().find(|(p, _)| *p == path)
            .ok_or("GTK Theme unknown token path")?;
        if expected.1 != kind || values.contains_key(path) {
            return Err("GTK Theme duplicate or incompatible token".into());
        }
        let value = &object["value"];
        let css_value = match kind {
            "color" => {
                let color = value.as_str().ok_or("GTK Theme color must be text")?;
                if color.len() != 7 || !color.starts_with('#')
                    || !color.as_bytes()[1..].iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)) {
                    return Err("GTK Theme color must be opaque lowercase #rrggbb".into());
                }
                color.to_string()
            }
            "fontFamily" => {
                let family = value.as_str().ok_or("GTK Theme font family must be text")?;
                if family != "sans-serif" && family != "monospace" {
                    return Err("GTK Theme font family is unsupported".into());
                }
                family.to_string()
            }
            "dimension" | "fontSize" => {
                // Mirror JS Number.isSafeInteger, not serde_json::as_u64:
                // 13, 13.0, 1.3e1 and -0 are the SAME valid dimension,
                // including when a JSON parser stores an integral float.
                let number = value.as_f64().ok_or("GTK Theme dimension must be a JSON number")?;
                if !number.is_finite() || number.fract() != 0.0 || number < 0.0
                    || number > 9_007_199_254_740_991.0
                    || (kind == "fontSize" && number == 0.0) {
                    return Err("GTK Theme dimension/font size is out of range".into());
                }
                format!("{}px", number as u64)
            }
            _ => return Err("GTK Theme unsupported token type".into()),
        };
        values.insert(path.to_string(), css_value);
    }
    let at = |path: &str| values.get(path).map(String::as_str).unwrap();
    // Each path is consumed intentionally. Only GTK property names and
    // selector syntax live here; inherited value selection belongs to Images
    // and ThemeResolver. The style is scoped per widget via apply_native_tool_css.
    Ok(format!(r#"
#lagrange-tool {{
  background-color: {base};
  color: {primary};
  font-family: {ui_family};
  font-size: {ui_size};
  padding: {spacing};
  border-radius: {radius};
}}
#lagrange-tool-heading {{ color: {accent}; }}
#lagrange-tool-reason {{ color: {muted}; }}
button {{
  background-image: none;
  background-color: {raised};
  color: {accent};
  padding: {compact};
  border-radius: {radius};
}}
entry, textview, textview text {{
  background-color: {raised};
  color: {primary};
  padding: {compact};
  border-radius: {radius};
}}
#lagrange-tool-source {{
  font-family: {code_family};
  font-size: {code_size};
}}
button:focus, entry:focus-within, textview:focus-within {{ outline: 2px solid {focus}; }}
selection {{ background-color: {selection_bg}; color: {selection_text}; }}
"#,
        base=at("surface.base"), primary=at("text.primary"),
        ui_family=at("typography.ui.family"), ui_size=at("typography.ui.size"),
        spacing=at("spacing.normal"), radius=at("radius.normal"),
        accent=at("accent"), muted=at("text.muted"), raised=at("surface.raised"),
        compact=at("spacing.compact"), code_family=at("typography.code.family"),
        code_size=at("typography.code.size"), focus=at("focus"),
        selection_bg=at("selection.background"), selection_text=at("selection.text"),
    ))
}

// GTK CSS providers are applied to the actual widget contexts in ONE pane,
// never installed on the display/process. Two sessions with different Themes
// can coexist, and dropping a pane retires its widget-owned providers.
pub fn apply_native_tool_css(root: &gtk4::Widget, css: &str) {
    let provider = gtk4::CssProvider::new();
    provider.load_from_data(css);
    fn attach(widget: &gtk4::Widget, provider: &gtk4::CssProvider) {
        widget.style_context().add_provider(provider, gtk4::STYLE_PROVIDER_PRIORITY_APPLICATION);
        let mut child = widget.first_child();
        while let Some(current) = child {
            child = current.next_sibling();
            attach(&current, provider);
        }
    }
    attach(root, &provider);
}
