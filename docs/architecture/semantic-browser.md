# One semantic browser across language personalities

## Purpose

The Object Environment should have **one browser architecture for all languages**.

A language may contribute genuinely language-specific semantic structure, source services and Commands, but it must not acquire its own browser stack. The goal is that Smalltalk, Common Lisp, JavaScript and later languages feel like different semantic personalities inhabiting the same environment rather than separate IDEs that merely share some widgets.

ADR 0016 makes this a durable architectural direction. This document expands the browser-specific consequences and the intended extraction path.

## Core invariant

```text
one semantic browser
       |
       +-- common navigation / view lifecycle
       +-- common facets
       +-- common Commands / interaction routing
       +-- common renderer-neutral realization
       |
       `-- language personality contributions
              +-- Smalltalk
              +-- Common Lisp
              +-- JavaScript
              `-- later languages
```

A language personality **extends** the browser. It does not replace it.

## What stays common

The common browser owns or composes concerns whose meaning does not depend on language syntax:

- logical browser-view lifecycle and composition;
- focus and semantic selection/navigation;
- descriptor-local action keys and activation routing;
- navigation history/breadcrumb policy when implemented;
- authorization and unavailable/unauthorized presentation;
- Presentation discovery and Command discovery through the existing registries;
- ordinary Command invocation through the existing dispatcher/router owners;
- common facets such as Documentation, History, References, Tests and Diagnostics when those exist;
- source/detail arrangement policy without owning language source semantics;
- renderer-neutral SemanticUi projection;
- DOM/GTK/native realization through the existing renderer owners;
- live refresh through ordinary authorized observation rather than polling;
- Perspective/theming/composition policy for how browser facets are arranged.

These concerns must not be reimplemented by a language package.

## What a language personality may contribute

A personality contributes semantic facts and operations that really differ by language.

Examples:

| Generic browser concern | Smalltalk contribution | Common Lisp contribution | JavaScript contribution |
| --- | --- | --- | --- |
| structural subjects | Class, Metaclass, Method | Package, Symbol, Function, Generic Function | Module, Export, Class, Function |
| hierarchy/relations | superclass, class side | package/class/generic-function relations | imports, exports, prototype/class relations |
| members/groups | protocols, selectors | exported/internal symbols, methods | exports, methods, bindings |
| primary source semantics | method source | function/form source | module/function source |
| language actions | senders, implementors, evaluate | callers, macroexpand, methods | references, evaluate, imports |
| syntax-aware behavior | Smalltalk parser/compiler services | Lisp reader/macro semantics | JavaScript parser/module semantics |

The contribution should feed existing generic owners, primarily `PresentationRegistry` and `CommandRegistry`. When repeated real pressure proves the need, `PersonalityExtensionRegistry` is the controlled contribution boundary. It is **not** a second discovery engine.

## What a language personality may not own

A personality must not introduce its own:

- Compositor;
- SelectionModel;
- renderer or SemanticUi contract;
- activation router;
- authority system;
- image/document store;
- Project model;
- history implementation;
- documentation subsystem;
- generic search infrastructure;
- command dispatcher;
- browser-window/session lifecycle.

If a language appears to need one of these, first ask whether the pressure is actually exposing a missing generic browser owner or lower Images semantic contract.

## Common browser facets

The browser should eventually treat a semantic subject as exposing a set of **facets** rather than forcing one language-specific screen shape.

Conceptually:

```text
semantic subject
    |
    +-- Structure / Relations
    +-- Members
    +-- Source / Detail
    +-- Documentation
    +-- History
    +-- References
    +-- Tests
    `-- Diagnostics
```

Not every subject exposes every facet. A facet may be generic or supplied by a personality.

Examples:

- Documentation is generic: a Smalltalk Method and JavaScript Function use the same documentation UX.
- History is generic: exact lower revision semantics may differ, but the Environment should not build per-language history stores.
- Members are personality-specific: Smalltalk selectors/protocols differ from Lisp symbols or JavaScript exports.
- Source is a common browser role with language-specific source semantics and editing/evaluation Commands beneath it.

A facet is a semantic/browser concept, not necessarily a tab. A Perspective or theme may realize facets side-by-side, stacked, tabbed, collapsed or in another composition.

## Stable conceptual layout, flexible realization

A conventional realization may look like:

```text
+----------------+----------------------+-----------------------------+
| Context        | Members / Relations  | Detail                      |
|                |                      |                             |
| project        | classes              | Source       Documentation |
| hierarchy      | methods              | --------     ------------- |
| packages       | functions            | ...          ...           |
| modules        | references           | History / Tests / etc.      |
+----------------+----------------------+-----------------------------+
```

This is not a mandatory three-column widget contract. It is a useful mental model showing which parts should remain similar across languages.

The durable/semantic layers describe subjects, facets, relations and actions. Renderer and composition policy decide concrete panes, widgets and geometry.

## Semantic roles, not language-owned pixels

Language contributions should state semantic roles and content rather than renderer styling.

For example, a personality may contribute a `members` or `source` facet. It should not specify CSS classes, GTK widgets, colors, fonts or fixed pane geometry.

Themes and host realizers decide appearance through the existing renderer-neutral mechanisms.

## Navigation stays generic

Renderer activation always returns a descriptor-local integer key through the existing EnvironmentShell activation owner.

The current E2 native-Smalltalk work is establishing the important general case: a browser action may resolve not only to an ordinary ObjectRef but to another semantic browse subject such as a native Method locator. The language/browser consumer owns target meaning; EnvironmentShell owns the single renderer-action routing interaction.

A future personality must reuse that path. It must not add `SmalltalkClickRouter`, `LispNavigator`, `JavaScriptActivationService`, or equivalent parallel owners.

References and semantic targets confer no authority. Every target is freshly authorized at the lower public semantic read/invocation boundary.

## Cuis is evidence for the one-browser rule

Cuis is deliberately **not** a separate browser personality after native import.

Once Images has native-imported a Cuis class/method:

```text
Cuis origin
    |
    v
ordinary native Smalltalk Class / Method
    |
    v
Smalltalk semantic browser contribution
```

Class hierarchy, selector/method browsing, editing, senders/implementors, evaluation and debugging should therefore use the same Smalltalk semantic facilities as natively-authored Smalltalk.

Cuis-specific information may later appear as secondary facets or Commands when there is a durable semantic basis for it, for example:

- imported-from-Cuis provenance;
- import/compatibility diagnostics;
- original imported source;
- explicit re-import/reconcile operations.

Those contributions may decorate or extend the same semantic object. They must never select a second object identity, mutation path, authority route or browser.

A strong outcome is that many Cuis workflows require **no Cuis-specific browser code at all**.

## `NativeSmalltalkBrowser` is pressure, not the final generic abstraction

`NativeSmalltalkBrowser` is the first concrete implementation pressure for language-oriented browsing. Its current existence does **not** imply the future shape is:

```text
NativeSmalltalkBrowser
CommonLispBrowser
JavaScriptBrowser
...
```

Nor should it be immediately renamed to `SemanticBrowser` merely because the direction is known.

The extraction rule is:

> Factor a generic semantic-browser owner only after E2 plus a second substantially different semantic shape prove which responsibilities are genuinely common.

Until then, duplicating a small amount of personality-local orchestration may be safer than inventing a generic framework with no second consumer. But duplicated **system owners** are never acceptable: activation, selection, rendering, authority and discovery remain generic now.

## Planned PersonalityExtensionRegistry boundary

When pressure proves it, `PersonalityExtensionRegistry` should be a narrow contribution registry, not a browser framework.

A personality may conceptually register contributions such as:

```text
personality
  presentation providers
  command providers
  structural/member facet contributors
  source/detail facet contributors
  language-specific semantic actions
```

The generic registries/browser still decide discovery/composition policy.

The registry must not become a container for arbitrary callbacks that bypass ownership boundaries. In particular it must not expose renderer handles, issue authority, persist state, dispatch Commands directly or own semantic navigation.

## Documentation is the first clearly generic code facet

ADR 0016 chooses Documentation as a common browser facet because it demonstrates the benefit of the one-browser model particularly clearly.

A Smalltalk class comment, Lisp docstring and JavaScript doc comment are language/source representations. Curated Lagrange Documentation is a separate durable semantic concept presented through the same Documentation facet for all of them.

This is the desired direction:

```text
Smalltalk Class --------+
Lisp Function ----------+--> common Documentation facet
JavaScript Function ----+
```

not:

```text
Smalltalk comment pane
Lisp docstring pane
JavaScript JSDoc pane
```

Language comment import/export remains an explicit personality-owned projection as specified by ADR 0016.

## Conformance expectations

When a generic browser extraction eventually lands, acceptance should prove behavior rather than naming:

1. two substantially different language personalities contribute semantic structure through the same browser owner;
2. both use the same EnvironmentShell activation routing, Compositor lifecycle and renderer paths;
3. common facets such as Documentation render through identical generic facet machinery;
4. a language-specific facet can be added without changing the core browser's language branches;
5. no core browser module branches on concrete language names merely to discover or route contributions;
6. authorization remains entirely in lower semantic operations;
7. DOM and GTK/native hosts realize the same SemanticUi semantics;
8. changing browser composition/theme policy does not require changes to language semantics.

A structural `grep` for language names is not sufficient proof by itself; discriminating cross-language acceptance is required.

## Future Bead epic seed — generic semantic browser extraction

This is a planning seed, not live tracker state. Do not create it solely because this document exists.

### Activation condition

Create the epic only when:

1. E2 native class/method live navigation is merged and stable; and
2. a second substantially different language shape has a real Environment consumer, or the selected real Cuis application exposes repeated browser behavior that is clearly generic beyond `NativeSmalltalkBrowser`.

### Suggested epic

**One semantic browser, pluggable language personalities**

Goal: prove two language personalities inhabit one browser architecture while sharing navigation, facets, interaction, rendering and common tools.

Suggested slices:

**B0 — characterize before extracting**
- inventory `NativeSmalltalkBrowser` responsibilities;
- classify each as generic-browser, Smalltalk personality, lower Images semantic, or existing system owner;
- identify the second concrete personality/shape that supplies abstraction pressure;
- no code extraction yet.

**B1 — smallest generic browser owner**
- extract only responsibilities demonstrably shared by the two real consumers;
- preserve PresentationRegistry/CommandRegistry as discovery owners;
- preserve EnvironmentShell as activation owner and Compositor as view owner;
- no generic language type system or renderer framework.

**B2 — minimal PersonalityExtensionRegistry**
- admit only the contribution kinds the two consumers actually require;
- prove adding the second personality requires no language branch in the generic browser;
- prove personality registration cannot bypass authority, renderer or Command ownership.

**B3 — common facets proof**
- use at least one truly generic facet (Documentation is preferred if its lower contract exists; otherwise another pressured common facet);
- same facet owner/UX for both language subjects;
- language-specific structure remains personality-contributed.

**B4 — one-browser cross-language acceptance**
- one Session/Perspective contains subjects from both personalities;
- navigate between them through the same generic semantic activation route;
- same selection/focus/history policy;
- same DOM/GTK/native realization semantics;
- no second browser stack or language-specific system owner.

### Stop conditions

Do not use this epic to pre-emptively build:

- one abstract schema that attempts to normalize all language semantics;
- a language-agnostic AST;
- a generic debugger before real language debugging pressure exists;
- a generic source editor before source semantics/editing Commands exist;
- browser-specific durable state outside Perspectives/image objects;
- personality-owned renderers, activation routers or authority mechanisms.
