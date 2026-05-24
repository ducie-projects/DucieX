# DucieX

A zero-overhead compiled template engine for [HTMX](https://htmx.org), written in vanilla JavaScript. No dependencies. No virtual DOM. No runtime allocations after the warm-up phase.

```
parse once → compile to RenderFunction → render into shared Uint8Array → flush to DOM
```

---

## Table of Contents

- [Why](#why)
- [Performance Targets](#performance-targets)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Template Syntax](#template-syntax)
- [API Reference](#api-reference)
- [HTMX Integration](#htmx-integration)
- [Architecture Deep Dive](#architecture-deep-dive)
- [Files](#files)
- [Anti-Patterns Avoided](#anti-patterns-avoided)

---

## Why

Standard HTMX workflows swap server-rendered HTML fragments. When the server is fast but you need client-side templating — data arrives as JSON and the browser renders it — most template engines allocate heavily on every render call: new strings, new objects, regex-based escaping.

DucieX compiles templates once at boot, then renders them by writing bytes directly into a pre-allocated shared buffer. There is nothing to allocate at render time.

---

## Performance Targets

| Metric | Target | Notes |
|---|---|---|
| Compile time | < 2 ms per template | Measured via `performance.now()` |
| Render throughput | > 500,000 renders/sec | 10-token template, mid-range CPU |
| Heap growth | Zero after first 100 renders | Verified via `performance.memory` |
| HTMX swap latency | < 1 ms from `htmx:afterRequest` to DOM paint | RAF-batched |

Run [`benchmark.html`](benchmark.html) in your browser to verify against your own hardware.

---

## How It Works

### Compiler Phase (runs once at boot)

```
source string
    │
    ▼
  parse()         ← single-pass char scanner, no regex
    │
    ▼
   AST            ← StaticNode | ExprNode | RawNode | LoopNode | PartialNode
    │
    ▼
  codegen()       ← emits a JS function body as a string array
    │
    ▼
new Function()    ← called ONCE, produces a native RenderFunction
    │
    ▼
CompiledTemplate  ← stored in registry, never recompiled
```

### Render Phase (zero-allocation hot path)

```
RenderFunction(ctx, _sharedBuffer, 0, partials)
    │
    ├─ StaticNode  →  buf.set(preEncodedBytes, o)   // native memcpy
    ├─ ExprNode    →  escapeFn(resolve(ctx, path), buf, o)
    ├─ RawNode     →  encoder.encodeInto(val, buf)
    ├─ LoopNode    →  for (var i=0; i<len; i++) { ... }
    └─ PartialNode →  partials["name"](ctx, buf, o, partials)
    │
    ▼
byteLen (number of bytes written)
    │
    ▼
TextDecoder.decode(_sharedBuffer.subarray(0, byteLen))
```

---

## Installation

No package manager required. Drop one file into your project:

```html
<script src="template-engine.js"></script>
```

Or use CommonJS:

```js
const TemplateEngine = require('./template-engine.js');
```

HTMX event listeners are wired automatically on `DOMContentLoaded`.

---

## Quick Start

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://unpkg.com/htmx.org@1.9.12/dist/htmx.min.js"></script>
  <script src="template-engine.js"></script>
</head>
<body>

  <button
    hx-get="/api/users"
    hx-target="#list"
    hx-swap="innerHTML"
    hx-template="userList"
  >Load Users</button>

  <ul id="list"></ul>

  <script>
    TemplateEngine.registerPartial('userRow',
      '<li><strong>{{ name }}</strong> — {{ email }}</li>'
    );

    TemplateEngine.compile('userList',
      '{{#each users}}{{> userRow}}{{/each}}'
    );
  </script>

</body>
</html>
```

When the button is clicked, HTMX fires the request. DucieX intercepts `htmx:beforeSwap`, renders the JSON response through the `userList` template, and hands the resulting HTML back to HTMX to swap into `#list`.

Your server only needs to return:

```json
{ "users": [{ "name": "Alice", "email": "alice@example.com" }] }
```

---

## Template Syntax

DucieX uses a Handlebars-compatible subset.

### Interpolation (HTML-escaped)

```
{{ expression }}
{{ user.name }}
{{ product.price }}
```

Values are always HTML-escaped by default. Characters `& < > " '` become their entity equivalents. Escaping uses a 256-entry `Uint8Array` lookup table — one array read per byte, no regex.

### Raw Output (unescaped)

```
{{{ expression }}}
{{{ article.bodyHtml }}}
```

Use only with content you fully trust. This writes bytes directly into the buffer via `encodeInto()`.

### Loops

```
{{#each items}}
  <li>{{ name }} — ${{ price }}</li>
{{/each}}
```

Inside the loop body, `{{ name }}` resolves against the current item. The generated code is a tight `for` loop with a cached `.length` — no `forEach`, no closures.

### Nested Loops

```
{{#each categories}}
  <h2>{{ label }}</h2>
  {{#each products}}
    <p>{{ name }}</p>
  {{/each}}
{{/each}}
```

Each nesting level is handled by a recursive call to `parseBlock`. Each stack frame owns its own scope; depth counters are not needed.

### Dotted Property Paths

```
{{ user.address.city }}
{{ order.total.formatted }}
```

Paths are split once at compile time and cached. Resolution at render time is a sequential property chain — no `eval`, no bracket access with string keys.

### Partials

```
{{> cardPartial }}
{{#each items}}{{> rowPartial}}{{/each}}
```

Partials are pre-linked at compile time. The generated code calls the partial's `RenderFunction` directly — no registry lookup at render time.

---

## API Reference

### `TemplateEngine.compile(name, source) → CompiledTemplate`

Parse and compile a template. Registers it by name. Returns a `CompiledTemplate` object.

```js
const tpl = TemplateEngine.compile('productCard', `
  <div class="card">
    <h3>{{ name }}</h3>
    <span>${{ price }}</span>
  </div>
`);

console.log(tpl.compileMs);     // e.g. 0.12 — compile time in ms
console.log(tpl.partialNames);  // names of partials this template depends on
console.log(tpl.sizeHint);      // rough byte estimate for the output
```

Safe to call before HTMX initialises.

---

### `TemplateEngine.render(name, context) → string`

Render a compiled template with a context object. Returns an HTML string.

```js
const html = TemplateEngine.render('productCard', {
  name: 'Wireless Keyboard',
  price: '49.99',
});
```

This allocates one string (the return value). Everything else — property resolution, escaping, the output buffer — is zero-allocation.

---

### `TemplateEngine.renderToBuffer(name, context, buffer) → number`

Render directly into a caller-supplied `Uint8Array`. Returns the number of bytes written. **Fully zero-allocation.**

```js
const buf = new Uint8Array(64 * 1024); // your own buffer

const byteLen = TemplateEngine.renderToBuffer('productCard', {
  name: 'Wireless Keyboard',
  price: '49.99',
}, buf);

// Use the bytes directly — no string decode needed.
const html = new TextDecoder().decode(buf.subarray(0, byteLen));
```

Use this when you are calling the engine millions of times per second and cannot afford the one string allocation that `render()` makes.

---

### `TemplateEngine.registerPartial(name, source)`

Compile and register a template fragment for use via `{{> name}}`.

```js
TemplateEngine.registerPartial('tableRow', `
  <tr>
    <td>{{ id }}</td>
    <td>{{ label }}</td>
    <td>{{ value }}</td>
  </tr>
`);
```

Identical to `compile()` — partials and full templates live in the same registry.

---

### `TemplateEngine.preloadAll(templates)`

Compile multiple templates in one call. Keys are names, values are source strings.

```js
TemplateEngine.preloadAll({
  header:  '<header><h1>{{ title }}</h1></header>',
  footer:  '<footer>{{ year }} {{ company }}</footer>',
  layout:  '{{> header}}<main>{{{ content }}}</main>{{> footer}}',
});
```

---

### `TemplateEngine.get(name) → CompiledTemplate | undefined`

Look up a compiled template by name. Useful for inspecting compile metadata.

```js
const tpl = TemplateEngine.get('productCard');
console.log(tpl.compileMs, tpl.partialNames);
```

---

### `TemplateEngine.sharedBuffer → Uint8Array`

The 4 MB shared output buffer. Exposed for external tooling and debugging. Do not hold a reference to a slice of this buffer across render calls — the next render overwrites it.

---

## HTMX Integration

### `hx-template`

Add `hx-template="templateName"` to any HTMX element. When the XHR completes, DucieX intercepts `htmx:beforeSwap`, renders the JSON response through the named template, and injects the result as the server response before HTMX performs its swap.

```html
<button
  hx-get="/api/products"
  hx-target="#product-grid"
  hx-swap="innerHTML"
  hx-template="productGrid"
>Refresh</button>
```

Your server returns JSON:

```json
{ "items": [{ "id": 1, "name": "Keyboard", "price": "49.99" }] }
```

DucieX renders it as HTML; HTMX swaps it. No changes to HTMX configuration needed.

---

### `hx-template-batch`

Add `hx-template-batch="templateName"` to queue the DOM update through the RAF batch queue. All mutations in the same event loop tick are applied in a single `requestAnimationFrame` callback, preventing layout thrashing.

```html
<div
  hx-get="/api/feed"
  hx-trigger="every 5s"
  hx-target="#feed"
  hx-swap="innerHTML"
  hx-template-batch="feedTemplate"
></div>
```

---

### Swap target resolution

DucieX resolves `hx-target` and `hx-swap` once per element on first use and caches the result in a `WeakMap`. Entries are garbage-collected automatically when the element is removed from the DOM. `document.querySelector` is never called at render time.

---

### Supported `hx-swap` values

| Value | Behaviour |
|---|---|
| `innerHTML` | Replace element content |
| `outerHTML` | Replace element itself via a pooled `DocumentFragment` |
| `beforeend` | Append inside element |
| `afterbegin` | Prepend inside element |
| `beforebegin` | Insert before element |
| `afterend` | Insert after element |

---

## Architecture Deep Dive

### AST Node Types

All nodes are plain objects with a numeric `type` discriminant. No class hierarchy — V8 keeps hidden classes stable for same-shape literals.

| Type | Tag | Fields |
|---|---|---|
| `STATIC` (0) | _(literal text)_ | `bytes: Uint8Array` — pre-encoded UTF-8 |
| `EXPR` (1) | `{{ expr }}` | `path: string[]` — pre-split property path |
| `RAW` (2) | `{{{ expr }}}` | `path: string[]` |
| `LOOP` (3) | `{{#each arr}}` | `path: string[]`, `children: ASTNode[]` |
| `PARTIAL` (4) | `{{> name}}` | `name: string` |

### Parser

Single-pass character scanner (`indexOf` + `charCodeAt`). No regex. No substring allocations in the inner loop — text is only sliced when creating a `StaticNode`, which is then immediately encoded to bytes and discarded.

Property paths (`user.address.city`) are split once into a `string[]` and memoized in a `null`-prototype object. The same array is reused on every render.

### Code Generator

`codegen()` walks the AST and builds a JS function body as an array of strings. `new Function()` is called once to compile it into a native function.

For a template like `<li>{{ name }} — ${{ price }}</li>`, the generated body is approximately:

```js
"use strict";
var o = offset;
buf.set(statics[0], o); o += 4;          // <li>
o = escapeFn(resolveFn(ctx, ["name"]), buf, o);
buf.set(statics[1], o); o += 6;          //  — $
o = escapeFn(resolveFn(ctx, ["price"]), buf, o);
buf.set(statics[2], o); o += 5;          // </li>
return o;
```

Static segments become `buf.set()` calls — a native `memcpy`. There is no string concatenation.

### HTML Escape Table

```
ESCAPE_TABLE: Uint8Array(256)
  index = byte value of character
  value = 0xFF → pass through (write byte directly)
          0    → write '&amp;'
          1    → write '&lt;'
          2    → write '&gt;'
          3    → write '&quot;'
          4    → write '&#x27;'
```

One array read per byte. Characters outside the five special ones cost a single `buf[o++] = byte` write.

### Object Pool

`ContextPool` holds 256 pre-allocated `null`-prototype objects. `acquire()` copies the source object's keys into a wrapper in-place. `release()` clears the keys and returns the wrapper to the pool. V8's hidden class for the wrapper stays stable because the same property set is always written.

### DocumentFragment Pool

16 `DocumentFragment`s are pooled and recycled for `outerHTML` swaps. Each fragment is cleared (`removeChild` loop) before being returned to the pool.

### RAF Batch Queue

64 pre-allocated mutation slots (`{ target, html, swapType }`). `_enqueueMutation()` writes into a slot without any `new` or `push`. `_flushMutations()` applies all pending mutations in a single `requestAnimationFrame` callback — one layout pass for all of them.

---

## Files

```
duciex/
├── template-engine.js   — full engine implementation (952 lines)
├── benchmark.html       — automated perf suite (8 checks, performance.now loops)
└── demo.html            — HTMX demo: 1,000-item list rendered via hx-template
```

### `benchmark.html`

Opens in any browser. Runs eight checks sequentially and reports pass/fail/warn:

1. Compile time per template (< 2 ms)
2. Simple 10-token render throughput (> 500k/sec)
3. 50-token list template throughput (20-item loop)
4. `renderToBuffer` throughput (zero-string path)
5. HTML escape correctness (XSS probe)
6. Raw triple-stache pass-through
7. Nested loop correctness
8. Heap growth after 10,000 renders (`performance.memory`, Chrome only)

### `demo.html`

A self-contained page (no server needed). Clicking "Load 1,000 Products" generates 1,000 mock JSON items, renders them through a compiled partial, and commits the result to the DOM in one `requestAnimationFrame`. Render time and DOM commit time are displayed after each load.

---

## Anti-Patterns Avoided

| Anti-pattern | How DucieX avoids it |
|---|---|
| `innerHTML` in hot paths | DOM writes go through the RAF batch queue, once per frame |
| `JSON.parse` / `JSON.stringify` in render path | Never called inside render functions |
| `eval()` / `new Function()` at render time | `new Function()` runs once at compile time only |
| `obj[dynamicKey]` inside loops | Property paths are destructured into sequential accesses at codegen |
| `Array.push` in hot loops | Index writes to pre-sized arrays; pre-allocated slot objects for queues |
| `document.querySelector` at render time | All selectors resolved once and cached in a `WeakMap` |
| Regex-based HTML escaping | 256-entry `Uint8Array` lookup table, one read per byte |
| `Object.assign({})` per render | `ContextPool` — 256 reusable wrapper objects, reset in place |
| String concatenation for output | `Uint8Array` shared buffer; `buf.set()` for statics, `encodeInto()` for values |
| Dynamic partial lookup at render | Partials pre-linked at compile time into a frozen object |

---

## Browser Support

Requires `TextEncoder.encodeInto()` (Chrome 74+, Firefox 99+, Safari 14.1+). No polyfills. No transpilation.

Node.js is supported (DOM features are skipped automatically when `document` is `undefined`).

---

## License

MIT
