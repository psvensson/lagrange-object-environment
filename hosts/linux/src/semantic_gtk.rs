//! The GTK realization of SemanticUi/v1 (ADR 0013's native tool-UI route).
//!
//! Builds REAL GTK4 controls from a validated SemanticUi document — the SAME
//! document the browser DOM realizer consumes (one description, two hosts).
//! A `group` -> a boxed section with a title label; `text` -> a label; `field`
//! -> a label:value row; `collection` -> a list of buttons; `action(key)` -> a
//! real `gtk4::Button` whose activation emits the DESCRIPTOR-LOCAL intent
//! `{kind:'activate-item', key}` — never a ref/subject (the PR #33 security
//! property, identical to the browser).
//!
//! GTK APIs stop at this realization boundary: nothing above it (Presentation,
//! EnvironmentShell, the Compositor) learns what a `gtk4::Widget` is. The
//! emitted intent is plain data, identical in shape to the browser's.
//!
//! Headless-friendly: `gtk4::init()` works under Xvfb (GDK X11 backend); the
//! controls are built and a button is programmatically activated
//! (`emit_clicked`) with no on-screen window realization required.

use gtk4::prelude::*;
use std::cell::RefCell;
use std::rc::Rc;

use crate::semantic_ui::{Node, SemanticUi};

/// A plain-data intent emitted by a control — identical shape to the browser's
/// `{kind:'activate-item', key}` or `{kind:'edit-field', key, text}`. Serialized
/// to the EXACT same JSON the DOM emits (text omitted when absent), so a test
/// can assert cross-host intent BYTES, not just parallel per-host literals.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Intent {
    pub kind: String,
    pub key: i64,
    /// The RAW-STRING payload of an edit-field intent (None for activate-item).
    /// Never a parsed value: text is the only editable scalar in this slice, and
    /// raw text has one host-neutral interpretation (the canonical text value).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl Intent {
    pub fn activate_item(key: i64) -> Self {
        Self {
            kind: "activate-item".to_string(),
            key,
            text: None,
        }
    }

    pub fn edit_field(key: i64, text: String) -> Self {
        Self {
            kind: "edit-field".to_string(),
            key,
            text: Some(text),
        }
    }
}

/// A realized tool pane: the root GTK widget plus the recorded intents, the
/// action buttons, and the editable-field entries (so a test can drive them).
pub struct GtkRealization {
    pub root: gtk4::Box,
    /// Intents emitted by action activations + edit commits, in order.
    pub intents: Rc<RefCell<Vec<Intent>>>,
    /// One button per `action(key)` node, in document order.
    buttons: Rc<RefCell<Vec<(i64, gtk4::Button)>>>,
    /// One entry per editable `field(key)` node, in document order.
    entries: Rc<RefCell<Vec<(i64, gtk4::Entry)>>>,
}

impl GtkRealization {
    /// Programmatically activate the action with the given descriptor-local
    /// key (the native analogue of a DOM button `.click()`). Returns the
    /// intent it emitted, or None if no such action exists.
    pub fn activate(&self, key: i64) -> Option<Intent> {
        let buttons = self.buttons.borrow();
        let (_, button) = buttons.iter().find(|(k, _)| *k == key)?;
        button.emit_clicked();
        self.intents.borrow().last().cloned()
    }

    /// The labels of all action buttons, in document order.
    pub fn action_labels(&self) -> Vec<String> {
        self.buttons
            .borrow()
            .iter()
            .map(|(_, b)| b.label().map(|l| l.to_string()).unwrap_or_default())
            .collect()
    }

    /// All text the pane shows (labels + button labels), for structural
    /// assertions.
    pub fn visible_text(&self) -> Vec<String> {
        let mut out = Vec::new();
        collect_text(self.root.upcast_ref::<gtk4::Widget>(), &mut out);
        out
    }

    /// Set the text of the editable field with the given descriptor-local key
    /// and commit it (the native analogue of typing into a DOM <input> and
    /// pressing Enter). Returns the intent it emitted, or None if no such
    /// editable field exists. Commit is Enter/activate ONLY (no focus-leave in
    /// this slice) — identical to the DOM.
    pub fn edit_field(&self, key: i64, text: &str) -> Option<Intent> {
        let entries = self.entries.borrow();
        let (_, entry) = entries.iter().find(|(k, _)| *k == key)?;
        entry.set_text(text);
        entry.emit_activate();
        self.intents.borrow().last().cloned()
    }

    /// The current text of each editable field, in document order (for tests).
    pub fn editable_texts(&self) -> Vec<String> {
        self.entries
            .borrow()
            .iter()
            .map(|(_, e)| e.text().to_string())
            .collect()
    }
}

fn collect_text(widget: &gtk4::Widget, out: &mut Vec<String>) {
    if let Ok(label) = widget.clone().downcast::<gtk4::Label>() {
        out.push(label.text().to_string());
    }
    if let Ok(button) = widget.clone().downcast::<gtk4::Button>() {
        if let Some(l) = button.label() {
            out.push(l.to_string());
        }
    }
    let mut child = widget.first_child();
    while let Some(c) = child {
        collect_text(&c, out);
        child = c.next_sibling();
    }
}

/// Realize a validated SemanticUi document as GTK4 controls. `gtk4::init()`
/// must have been called (once per process).
pub fn realize(doc: &SemanticUi) -> GtkRealization {
    let intents = Rc::new(RefCell::new(Vec::new()));
    let buttons = Rc::new(RefCell::new(Vec::new()));
    let entries = Rc::new(RefCell::new(Vec::new()));
    let root = gtk4::Box::new(gtk4::Orientation::Vertical, 4);
    root.set_widget_name("lagrange-tool");
    if let Some(title) = group_title(&doc.root) {
        root.set_tooltip_text(Some(&title));
    }
    render_children(&doc.root, &root, &intents, &buttons, &entries);
    GtkRealization {
        root,
        intents,
        buttons,
        entries,
    }
}

fn group_title(node: &Node) -> Option<String> {
    match node {
        Node::Group { title, .. } => title.clone(),
        _ => None,
    }
}

fn render_children(
    node: &Node,
    container: &gtk4::Box,
    intents: &Rc<RefCell<Vec<Intent>>>,
    buttons: &Rc<RefCell<Vec<(i64, gtk4::Button)>>>,
    entries: &Rc<RefCell<Vec<(i64, gtk4::Entry)>>>,
) {
    if let Node::Group { children, .. } = node {
        for child in children {
            render_node(child, container, intents, buttons, entries);
        }
    }
}

fn render_node(
    node: &Node,
    container: &gtk4::Box,
    intents: &Rc<RefCell<Vec<Intent>>>,
    buttons: &Rc<RefCell<Vec<(i64, gtk4::Button)>>>,
    entries: &Rc<RefCell<Vec<(i64, gtk4::Entry)>>>,
) {
    match node {
        Node::Text { role, text } => {
            let label = gtk4::Label::new(Some(text));
            label.set_halign(gtk4::Align::Start);
            match role.as_deref() {
                Some("heading") => label.set_widget_name("lagrange-tool-heading"),
                Some("reason") => label.set_widget_name("lagrange-tool-reason"),
                _ => {}
            }
            container.append(&label);
        }
        Node::Field { label, text, key, editable } => {
            let row = gtk4::Box::new(gtk4::Orientation::Horizontal, 6);
            row.set_widget_name("lagrange-tool-field");
            let key_label = gtk4::Label::new(Some(label));
            key_label.set_halign(gtk4::Align::Start);
            row.append(&key_label);
            if editable.as_deref() == Some("text") {
                // Editable: a real GtkEntry committing on Enter/activate ONLY
                // (no focus-leave in this slice), emitting a RAW-STRING intent
                // with the descriptor-local field key — identical to the DOM.
                let field_key = key.expect("an editable field always carries its key");
                let entry = gtk4::Entry::new();
                entry.set_text(text);
                entry.set_widget_name("lagrange-tool-field-input");
                let intents = Rc::clone(intents);
                entry.connect_activate(move |e| {
                    intents
                        .borrow_mut()
                        .push(Intent::edit_field(field_key, e.text().to_string()));
                });
                entries.borrow_mut().push((field_key, entry.clone()));
                row.append(&entry);
            } else {
                let value = gtk4::Label::new(Some(text));
                value.set_halign(gtk4::Align::Start);
                row.append(&value);
            }
            container.append(&row);
        }
        Node::Collection { items, .. } => {
            let list = gtk4::Box::new(gtk4::Orientation::Vertical, 2);
            list.set_widget_name("lagrange-tool-references");
            for item in items {
                if let Node::Action { key, label } = item {
                    let button = gtk4::Button::with_label(label);
                    let intents = Rc::clone(intents);
                    let key = *key;
                    button.connect_clicked(move |_| {
                        intents.borrow_mut().push(Intent::activate_item(key));
                    });
                    buttons.borrow_mut().push((key, button.clone()));
                    list.append(&button);
                }
            }
            container.append(&list);
        }
        Node::Group { children, .. } => {
            let nested = gtk4::Box::new(gtk4::Orientation::Vertical, 4);
            for child in children {
                render_node(child, &nested, intents, buttons, entries);
            }
            container.append(&nested);
        }
        Node::Action { .. } => {
            // Actions only appear inside a collection; a bare action is a
            // contract-level concern (validation tolerates it), render nothing.
        }
    }
}
