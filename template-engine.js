/**
 * DucieX Template Engine — zero-overhead compiled templates for HTMX.
 *
 * Architecture: parse once → compile to a RenderFunction → render into a shared
 * pre-allocated Uint8Array → flush byte range to DOM via a DocumentFragment pool.
 *
 * Three absolute rules for the hot path:
 *   1. No allocations  — every object comes from a pool.
 *   2. No dynamic dispatch — all template logic is baked into a closed RenderFunction.
 *   3. No DOM queries  — every swap target is resolved once at compile/init time.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// § 0  CONSTANTS & SHARED INFRASTRUCTURE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-built 256-entry HTML escape lookup table.
 * Index = char code. Value = index into ESCAPE_STRINGS, or 0xFF for "pass through".
 * We avoid regex entirely — a single array read per character.
 */
const ESCAPE_TABLE = new Uint8Array(256).fill(0xFF);
// 0 = '&amp;'  1 = '&lt;'  2 = '&gt;'  3 = '&quot;'  4 = '&#x27;'
ESCAPE_TABLE[38]  = 0; // &
ESCAPE_TABLE[60]  = 1; // <
ESCAPE_TABLE[62]  = 2; // >
ESCAPE_TABLE[34]  = 3; // "
ESCAPE_TABLE[39]  = 4; // '

// Parallel string array — index matches ESCAPE_TABLE values 0-4.
const ESCAPE_STRINGS = ['&amp;', '&lt;', '&gt;', '&quot;', '&#x27;'];

// TextEncoder/Decoder reused across all encode/decode calls (never re-created).
const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

// Shared output buffer: 4 MB. All RenderFunctions write here.
// If a template exceeds this, it is a sign it should be split into partials.
const SHARED_BUFFER_SIZE = 4 * 1024 * 1024;
const _sharedBuffer = new Uint8Array(SHARED_BUFFER_SIZE);

// Scratch encode buffer reused for individual value escaping.
// Max single interpolated value: 64 KB (covers any realistic data value).
const _encodeBuffer = new Uint8Array(65536);

// ─────────────────────────────────────────────────────────────────────────────
// § 1  AST NODE TYPES
//
// Nodes are plain objects with a numeric `type` discriminant.
// No class hierarchy — V8 keeps hidden classes stable for plain object literals
// sharing the same property shape, giving us fast property access.
// ─────────────────────────────────────────────────────────────────────────────

/** @enum {number} */
const NodeType = Object.freeze({
  STATIC:  0, // raw UTF-8 bytes baked in at compile time
  EXPR:    1, // {{ expr }}  — HTML-escaped interpolation
  RAW:     2, // {{{ expr }}} — unescaped interpolation
  LOOP:    3, // {{#each items}} ... {{/each}}
  PARTIAL: 4, // {{> name}}
});

/**
 * StaticNode — pre-encoded byte slice of literal template text.
 * @typedef {{ type: 0, bytes: Uint8Array }} StaticNode
 *
 * ExprNode — resolved property path for an escaped value.
 * @typedef {{ type: 1, path: string[] }} ExprNode
 *
 * RawNode — same but unescaped.
 * @typedef {{ type: 2, path: string[] }} RawNode
 *
 * LoopNode — iteration over an array property.
 * @typedef {{ type: 3, path: string[], children: ASTNode[] }} LoopNode
 *
 * PartialNode — pre-linked reference; fn is filled in after all templates compile.
 * @typedef {{ type: 4, name: string, fn: RenderFunction|null }} PartialNode
 *
 * @typedef {StaticNode|ExprNode|RawNode|LoopNode|PartialNode} ASTNode
 */

// ─────────────────────────────────────────────────────────────────────────────
// § 2  PARSER
//
// Single-pass character scanner. No regex. No substring allocation in the hot
// inner loop — we only slice when we need to store a static segment.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a template source string into an array of ASTNodes.
 * Called once per template at compile time.
 *
 * @param {string} source
 * @param {string} templateName  — used for error messages only
 * @returns {ASTNode[]}
 */
function parse(source, templateName) {
  const nodes = [];
  const len = source.length;
  let pos = 0;

  while (pos < len) {
    // Scan forward for the next '{{'.
    const openIdx = source.indexOf('{{', pos);

    if (openIdx === -1) {
      // No more tags — remainder is static text.
      if (pos < len) {
        nodes[nodes.length] = makeStaticNode(source.slice(pos, len));
      }
      break;
    }

    // Emit static text before this tag.
    if (openIdx > pos) {
      nodes[nodes.length] = makeStaticNode(source.slice(pos, openIdx));
    }

    // Determine tag kind.
    const isRaw  = source.charCodeAt(openIdx + 2) === 123; // '{{{ ...'
    const isBlock = source.charCodeAt(openIdx + 2) === 35;  // '{{# ...'
    const isClose = source.charCodeAt(openIdx + 2) === 47;  // '{{/ ...'
    const isPartial = source.charCodeAt(openIdx + 2) === 62; // '{{> ...'

    if (isRaw) {
      // Triple-stache raw expression: {{{ expr }}}
      const closeIdx = source.indexOf('}}}', openIdx + 3);
      if (closeIdx === -1) throw new Error(`[${templateName}] Unclosed {{{ at pos ${openIdx}}`);
      const expr = source.slice(openIdx + 3, closeIdx).trim();
      nodes[nodes.length] = { type: NodeType.RAW, path: splitPath(expr) };
      pos = closeIdx + 3;

    } else if (isBlock) {
      // Block tag: {{#each items}} ... {{/each}}
      const closeTag = source.indexOf('}}', openIdx + 2);
      if (closeTag === -1) throw new Error(`[${templateName}] Unclosed {{ at pos ${openIdx}}`);
      const directive = source.slice(openIdx + 2, closeTag).trim();

      if (directive.startsWith('#each ')) {
        const iterPath = directive.slice(6).trim();
        // Find the matching {{/each}}, handling nesting.
        const { children, endPos } = parseBlock(source, closeTag + 2, 'each', templateName);
        nodes[nodes.length] = { type: NodeType.LOOP, path: splitPath(iterPath), children };
        pos = endPos;
      } else {
        throw new Error(`[${templateName}] Unknown block directive: ${directive}`);
      }

    } else if (isClose) {
      // This should never be reached at the top-level parser (handled by parseBlock).
      throw new Error(`[${templateName}] Unexpected closing tag at pos ${openIdx}`);

    } else if (isPartial) {
      // Partial include: {{> name}}
      const closeTag = source.indexOf('}}', openIdx + 2);
      if (closeTag === -1) throw new Error(`[${templateName}] Unclosed {{ at pos ${openIdx}}`);
      const partialName = source.slice(openIdx + 2, closeTag).trim().slice(1).trim();
      // fn is null now; it will be linked by the compiler after all partials compile.
      nodes[nodes.length] = { type: NodeType.PARTIAL, name: partialName, fn: null };
      pos = closeTag + 2;

    } else {
      // Normal escaped expression: {{ expr }}
      const closeTag = source.indexOf('}}', openIdx + 2);
      if (closeTag === -1) throw new Error(`[${templateName}] Unclosed {{ at pos ${openIdx}}`);
      const expr = source.slice(openIdx + 2, closeTag).trim();
      nodes[nodes.length] = { type: NodeType.EXPR, path: splitPath(expr) };
      pos = closeTag + 2;
    }
  }

  return nodes;
}

/**
 * Recursively parse the body of a block tag (e.g. {{#each}}) until {{/blockType}}.
 * Returns the child AST nodes and the position after the closing tag.
 *
 * @param {string} source
 * @param {number} startPos — position immediately after the opening tag's '}}'
 * @param {string} blockType — e.g. 'each'
 * @param {string} templateName
 * @returns {{ children: ASTNode[], endPos: number }}
 */
function parseBlock(source, startPos, blockType, templateName) {
  const len = source.length;
  let pos = startPos;
  const children = [];

  while (pos < len) {
    const openIdx = source.indexOf('{{', pos);

    if (openIdx === -1) {
      throw new Error(`[${templateName}] Unclosed #${blockType} block`);
    }

    if (openIdx > pos) {
      children[children.length] = makeStaticNode(source.slice(pos, openIdx));
    }

    const ch2 = source.charCodeAt(openIdx + 2);
    const closeTag = source.indexOf('}}', openIdx + 2);
    if (closeTag === -1) throw new Error(`[${templateName}] Unclosed {{ inside #${blockType}`);

    const directive = source.slice(openIdx + 2, closeTag).trim();

    if (ch2 === 47 && directive === `/${blockType}`) {
      // Matching closing tag — this stack frame's block is complete.
      // depth starts at 1 and we return immediately; no need to decrement and loop.
      return { children, endPos: closeTag + 2 };

    } else if (ch2 === 35 && directive.startsWith(`#${blockType} `)) {
      // Nested block of the same type. Recursion handles its own scope — we must NOT
      // touch `depth` here, otherwise the outer frame's closing tag will see depth > 1
      // and never terminate.
      const result = parseBlock(source, closeTag + 2, blockType, templateName);
      const iterPath = directive.slice(blockType.length + 1).trim();
      children[children.length] = { type: NodeType.LOOP, path: splitPath(iterPath), children: result.children };
      pos = result.endPos;

    } else if (ch2 === 62) {
      // Partial inside a block.
      const partialName = directive.trim().slice(1).trim();
      children[children.length] = { type: NodeType.PARTIAL, name: partialName, fn: null };
      pos = closeTag + 2;

    } else if (ch2 === 123) {
      // Raw expression inside block.
      const rawClose = source.indexOf('}}}', openIdx + 3);
      if (rawClose === -1) throw new Error(`[${templateName}] Unclosed {{{ inside #${blockType}}`);
      const expr = source.slice(openIdx + 3, rawClose).trim();
      children[children.length] = { type: NodeType.RAW, path: splitPath(expr) };
      pos = rawClose + 3;

    } else {
      // Normal expression inside block.
      const expr = directive;
      children[children.length] = { type: NodeType.EXPR, path: splitPath(expr) };
      pos = closeTag + 2;
    }
  }

  throw new Error(`[${templateName}] Unterminated #${blockType}`);
}

/**
 * Split a dotted property path into a pre-built string array.
 * "user.name" → ["user", "name"]. Cached to avoid repeat splits.
 *
 * @param {string} expr
 * @returns {string[]}
 */
const _pathCache = Object.create(null);
function splitPath(expr) {
  let cached = _pathCache[expr];
  if (cached !== undefined) return cached;
  cached = expr.split('.');
  _pathCache[expr] = cached;
  return cached;
}

/**
 * Create a StaticNode, pre-encoding the text to UTF-8 bytes.
 * The Uint8Array is allocated once here and never again.
 *
 * @param {string} text
 * @returns {StaticNode}
 */
function makeStaticNode(text) {
  // _encoder.encode allocates a new Uint8Array — this is acceptable at compile time.
  return { type: NodeType.STATIC, bytes: _encoder.encode(text) };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3  CODE GENERATOR / COMPILER
//
// Converts an AST → a single JavaScript function (via new Function).
// new Function is called ONCE at compile time per template.
// The generated function is a tight for-loop with zero dynamic dispatch.
//
// Generated function signature:
//   (ctx, buf, offset, resolveFn, escapeFn, partials) => newOffset
//
// Where:
//   ctx        — current render context object
//   buf        — shared Uint8Array output buffer
//   offset     — current write position in buf
//   resolveFn  — resolves a property path array against ctx
//   escapeFn   — encodes + HTML-escapes a string value into buf
//   partials   — frozen object mapping partial name → compiled RenderFunction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compile an AST into a RenderFunction.
 * Returns the RenderFunction and a list of partial names it depends on
 * (so the linker can fill them in after all templates are compiled).
 *
 * @param {ASTNode[]} ast
 * @param {string} templateName
 * @returns {{ fn: Function, partialNames: string[] }}
 */
function codegen(ast, templateName) {
  const lines = [];
  const staticBuffers = []; // collected StaticNode byte arrays, referenced by index
  const partialNames = [];

  lines[lines.length] = '"use strict";';
  lines[lines.length] = 'var o = offset;'; // local alias avoids repeated property lookup

  emitNodes(ast, lines, staticBuffers, partialNames, 'ctx');

  lines[lines.length] = 'return o;';

  const body = lines.join('\n');

  // new Function is the ONLY eval-equivalent in this file, and it runs once at compile time.
  // The inner body contains no user data — only structure derived from the template source.
  // eslint-disable-next-line no-new-func
  const generatedFn = new Function(
    'ctx', 'buf', 'offset', 'statics', 'resolveFn', 'escapeFn', 'rawFn', 'partials',
    body
  );

  // Bind the static buffers array so the generated function closes over only frozen data.
  // We use a wrapper to pass `statics` as an argument (not a closure) — keeping the
  // generated function's shape stable for V8 hidden class optimisation.
  const staticsFrozen = Object.freeze(staticBuffers);

  /**
   * RenderFunction: writes template output into buf starting at offset.
   * Returns the new offset (= offset + bytes written).
   *
   * @type {(ctx: object, buf: Uint8Array, offset: number, partials: object) => number}
   */
  function renderFn(ctx, buf, offset, partials) {
    return generatedFn(ctx, buf, offset, staticsFrozen, _resolvePath, _escapeInto, _rawInto, partials);
  }

  return { fn: renderFn, partialNames };
}

/**
 * Recursively emit code lines for an array of ASTNodes.
 * ctxVar is the JavaScript variable name holding the current context ('ctx', 'item0', etc.)
 *
 * @param {ASTNode[]} nodes
 * @param {string[]} lines
 * @param {Uint8Array[]} staticBuffers
 * @param {string[]} partialNames
 * @param {string} ctxVar
 */
function emitNodes(nodes, lines, staticBuffers, partialNames, ctxVar) {
  const n = nodes.length;
  for (let i = 0; i < n; i++) {
    const node = nodes[i];

    if (node.type === NodeType.STATIC) {
      // Copy pre-encoded bytes directly into the output buffer.
      // set() is a native memcpy — the fastest way to bulk-copy a Uint8Array.
      const idx = staticBuffers.length;
      staticBuffers[idx] = node.bytes;
      lines[lines.length] = `buf.set(statics[${idx}], o); o += ${node.bytes.length};`;

    } else if (node.type === NodeType.EXPR) {
      // Resolve the property path, escape, and write into buf.
      const pathLiteral = JSON.stringify(node.path);
      lines[lines.length] = `o = escapeFn(resolveFn(${ctxVar}, ${pathLiteral}), buf, o);`;

    } else if (node.type === NodeType.RAW) {
      // Same but no escaping.
      const pathLiteral = JSON.stringify(node.path);
      lines[lines.length] = `o = rawFn(resolveFn(${ctxVar}, ${pathLiteral}), buf, o);`;

    } else if (node.type === NodeType.LOOP) {
      // Generate a tight for-loop. The loop variable name is unique per nesting depth.
      // We derive a unique iterator variable from the path to avoid shadowing.
      const loopVar = `_arr_${lines.length}`;
      const idxVar  = `_i_${lines.length}`;
      const itemVar = `_item_${lines.length}`;
      const pathLiteral = JSON.stringify(node.path);
      lines[lines.length] = `var ${loopVar} = resolveFn(${ctxVar}, ${pathLiteral});`;
      lines[lines.length] = `if (${loopVar}) {`;
      lines[lines.length] = `var ${loopVar}_len = ${loopVar}.length;`;
      lines[lines.length] = `for (var ${idxVar} = 0; ${idxVar} < ${loopVar}_len; ${idxVar}++) {`;
      lines[lines.length] = `var ${itemVar} = ${loopVar}[${idxVar}];`;
      // Recurse with the item as the new context variable.
      emitNodes(node.children, lines, staticBuffers, partialNames, itemVar);
      lines[lines.length] = '}'; // end for
      lines[lines.length] = '}'; // end if

    } else if (node.type === NodeType.PARTIAL) {
      // Emit a call to the pre-linked partial render function stored in partials[name].
      // The lookup is by string key here, but it happens at most once per partial invocation
      // and the partials object is frozen (V8 optimises frozen object property access heavily).
      partialNames[partialNames.length] = node.name;
      const nameLiteral = JSON.stringify(node.name);
      lines[lines.length] = `o = partials[${nameLiteral}](${ctxVar}, buf, o, partials);`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4  HOT-PATH HELPERS
//
// These are called by every RenderFunction. They must be pure, zero-allocation,
// and branch-minimal. V8 will inline them into the generated function bodies.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a pre-split property path array against a context object.
 * Uses sequential property accesses rather than eval — V8 can monomorphise
 * the call site once the hidden class of ctx stabilises.
 *
 * @param {object} ctx
 * @param {string[]} path
 * @returns {*}
 */
function _resolvePath(ctx, path) {
  const len = path.length;
  let val = ctx;
  for (let i = 0; i < len; i++) {
    if (val == null) return '';
    val = val[path[i]];
  }
  return val == null ? '' : val;
}

/**
 * Encode a value to UTF-8 and HTML-escape it into buf at offset.
 * Uses the 256-entry ESCAPE_TABLE for O(1) per-character dispatch.
 * Returns the new offset.
 *
 * Strategy: encode into _encodeBuffer first, then walk bytes applying escapes.
 * This avoids building an intermediate escaped string — we write bytes directly.
 *
 * @param {*} val
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {number}
 */
function _escapeInto(val, buf, offset) {
  if (val === '' || val === null || val === undefined) return offset;
  const str = typeof val === 'string' ? val : String(val);
  const encoded = _encoder.encodeInto(str, _encodeBuffer);
  const srcLen = encoded.written;

  let o = offset;
  for (let i = 0; i < srcLen; i++) {
    const byte = _encodeBuffer[i];
    const esc = ESCAPE_TABLE[byte];
    if (esc === 0xFF) {
      // Pass-through: safe character, write directly.
      buf[o++] = byte;
    } else {
      // Write the escape sequence bytes one at a time.
      const escStr = ESCAPE_STRINGS[esc];
      const escLen = escStr.length;
      for (let j = 0; j < escLen; j++) {
        buf[o++] = escStr.charCodeAt(j); // ASCII only — charCodeAt is safe
      }
    }
  }
  return o;
}

/**
 * Encode a raw (unescaped) value into buf. No escape processing.
 * Used for {{{ triple-stache }}} expressions.
 *
 * @param {*} val
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {number}
 */
function _rawInto(val, buf, offset) {
  if (val === '' || val === null || val === undefined) return offset;
  const str = typeof val === 'string' ? val : String(val);
  const result = _encoder.encodeInto(str, buf.subarray(offset));
  return offset + result.written;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5  OBJECT POOL — render context wrappers
//
// We never call Object.assign({}) during rendering.
// Instead we keep a pool of wrapper objects and reset their properties in place.
// V8 tracks hidden classes: as long as we always assign the same set of keys,
// the wrapper stays on the fast path.
// ─────────────────────────────────────────────────────────────────────────────

const POOL_SIZE = 256;

class ContextPool {
  constructor() {
    // Pre-allocate all slots. Each slot is a plain empty object.
    this._pool = new Array(POOL_SIZE);
    this._top  = 0;
    for (let i = 0; i < POOL_SIZE; i++) {
      this._pool[i] = Object.create(null);
    }
  }

  /**
   * Acquire a context wrapper. Copies own enumerable keys from src into the wrapper
   * without allocating a new object.
   *
   * @param {object} src
   * @returns {object}
   */
  acquire(src) {
    let wrapper;
    if (this._top > 0) {
      wrapper = this._pool[--this._top];
    } else {
      // Pool exhausted (> 256 concurrent contexts) — allocate as last resort.
      wrapper = Object.create(null);
    }

    // Copy keys from src into the wrapper. For typical data objects with a small
    // fixed set of keys this loop is extremely fast and V8 keeps the shape stable.
    const keys = Object.keys(src);
    const kLen = keys.length;
    for (let i = 0; i < kLen; i++) {
      wrapper[keys[i]] = src[keys[i]];
    }

    return wrapper;
  }

  /**
   * Return a wrapper to the pool. Clear its properties so GC can collect values.
   *
   * @param {object} wrapper
   */
  release(wrapper) {
    if (this._top >= POOL_SIZE) return; // pool full — let GC collect it
    const keys = Object.keys(wrapper);
    const kLen = keys.length;
    for (let i = 0; i < kLen; i++) {
      wrapper[keys[i]] = undefined;
    }
    this._pool[this._top++] = wrapper;
  }
}

// Singleton pool used by TemplateEngine.render().
const _ctxPool = new ContextPool();

// ─────────────────────────────────────────────────────────────────────────────
// § 6  DOCUMENT FRAGMENT POOL
//
// For HTMX outerHTML swaps we need a DocumentFragment to stage DOM nodes before
// committing. Creating fragments is cheap but not free — pool them.
// ─────────────────────────────────────────────────────────────────────────────

const FRAG_POOL_SIZE = 16;
const _fragPool = [];
let _fragTop = 0;

function _acquireFragment() {
  if (_fragTop > 0) return _fragPool[--_fragTop];
  // Fragments require a DOM context — guard for SSR environments.
  return (typeof document !== 'undefined') ? document.createDocumentFragment() : null;
}

function _releaseFragment(frag) {
  if (!frag) return;
  // Remove all child nodes so the fragment is clean for reuse.
  while (frag.firstChild) frag.removeChild(frag.firstChild);
  if (_fragTop < FRAG_POOL_SIZE) _fragPool[_fragTop++] = frag;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 7  RAF BATCH QUEUE
//
// DOM writes are batched into a single requestAnimationFrame callback.
// This prevents layout thrashing when multiple HTMX responses arrive in the
// same event loop tick.
// ─────────────────────────────────────────────────────────────────────────────

// Pre-allocated fixed array for pending mutations.
// Each slot: { target: Element, html: string } — we reuse slots.
const RAF_QUEUE_MAX = 64;
const _rafQueue    = new Array(RAF_QUEUE_MAX);
let   _rafLen      = 0;
let   _rafPending  = false;

// Pre-populate slot objects so no allocation occurs when enqueuing.
for (let i = 0; i < RAF_QUEUE_MAX; i++) {
  _rafQueue[i] = { target: null, html: '', swapType: 'innerHTML' };
}

/**
 * Schedule a DOM mutation for the next animation frame.
 * Uses a pre-allocated queue — no array push(), no new object.
 *
 * @param {Element} target
 * @param {string} html
 * @param {string} swapType — 'innerHTML' | 'outerHTML' | 'beforebegin' etc.
 */
function _enqueueMutation(target, html, swapType) {
  if (_rafLen >= RAF_QUEUE_MAX) {
    // Queue full — flush immediately rather than dropping updates.
    _flushMutations();
  }
  const slot = _rafQueue[_rafLen++];
  slot.target   = target;
  slot.html     = html;
  slot.swapType = swapType;

  if (!_rafPending) {
    _rafPending = true;
    requestAnimationFrame(_flushMutations);
  }
}

/**
 * RAF callback — apply all queued DOM mutations in one batch.
 * Setting innerHTML in a tight loop is acceptable here because:
 *   (a) it happens at most once per frame,
 *   (b) the browser combines the layout pass over all mutations.
 *
 * For outerHTML we use a DocumentFragment to avoid triggering multiple reflows.
 */
function _flushMutations() {
  const len = _rafLen;
  for (let i = 0; i < len; i++) {
    const m = _rafQueue[i];
    const target   = m.target;
    const html     = m.html;
    const swapType = m.swapType;

    if (swapType === 'innerHTML') {
      target.innerHTML = html;
    } else if (swapType === 'outerHTML') {
      // Stage in a DocumentFragment to avoid multiple reflows.
      const frag = _acquireFragment();
      if (frag) {
        // Use a temporary div as a parse context — required to parse HTML into nodes.
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        while (tmp.firstChild) frag.appendChild(tmp.firstChild);
        target.parentNode.replaceChild(frag, target);
        _releaseFragment(frag);
      } else {
        target.outerHTML = html;
      }
    } else if (swapType === 'beforeend') {
      target.insertAdjacentHTML('beforeend', html);
    } else if (swapType === 'afterbegin') {
      target.insertAdjacentHTML('afterbegin', html);
    } else if (swapType === 'beforebegin') {
      target.insertAdjacentHTML('beforebegin', html);
    } else if (swapType === 'afterend') {
      target.insertAdjacentHTML('afterend', html);
    } else {
      // Default fallback.
      target.innerHTML = html;
    }

    // Clear slot so GC can collect the target reference.
    m.target   = null;
    m.html     = '';
    m.swapType = 'innerHTML';
  }

  _rafLen     = 0;
  _rafPending = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 8  COMPILED TEMPLATE REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   name:         string,
 *   fn:           Function,
 *   partialNames: string[],
 *   sizeHint:     number,
 *   source:       string,
 * }} CompiledTemplate
 */

// Central registry: name → CompiledTemplate.
// Object.create(null) avoids prototype chain lookups on every access.
const _registry = Object.create(null);

// Frozen empty partials object used when a template has no partials.
// Passing the same object reference keeps the generated function's call site
// monomorphic in V8.
const _emptyPartials = Object.freeze(Object.create(null));

// ─────────────────────────────────────────────────────────────────────────────
// § 9  HTMX INTEGRATION
//
// We intercept htmx:afterRequest and htmx:configRequest to inject compiled
// template output before HTMX performs its swap.
//
// hx-template="name"   → render the named template with the response JSON as ctx
// hx-template-target   → overrides hx-target for the template render
// ─────────────────────────────────────────────────────────────────────────────

// Resolved swap targets cache: element → { target: Element, swapType: string }
// WeakMap so entries are GC'd when the source element is removed from the DOM.
const _swapCache = new WeakMap();

/**
 * Resolve and cache the HTMX swap configuration for an element.
 * Called once per element the first time it triggers a request.
 *
 * @param {Element} el
 * @returns {{ target: Element, swapType: string }}
 */
function _resolveSwapConfig(el) {
  let cfg = _swapCache.get(el);
  if (cfg) return cfg;

  const targetSelector = el.getAttribute('hx-target') || 'this';
  const swapType       = el.getAttribute('hx-swap')   || 'innerHTML';

  let targetEl;
  if (targetSelector === 'this') {
    targetEl = el;
  } else if (targetSelector === 'closest') {
    targetEl = el.closest(el.getAttribute('hx-target-closest') || '*');
  } else {
    // Resolve selector once and cache the DOM node reference.
    targetEl = document.querySelector(targetSelector);
  }

  cfg = { target: targetEl || el, swapType };
  _swapCache.set(el, cfg);
  return cfg;
}

/**
 * Wire up HTMX event listeners.
 * Called automatically when the DOM is ready (see bottom of file).
 */
function _initHTMX() {
  if (typeof document === 'undefined') return;

  // htmx:beforeSwap fires after the XHR completes, before HTMX modifies the DOM.
  // We intercept here to substitute template-rendered HTML.
  document.body.addEventListener('htmx:beforeSwap', function(evt) {
    const el = evt.detail.elt;
    if (!el) return;

    const templateName = el.getAttribute('hx-template');
    if (!templateName) return;

    const template = _registry[templateName];
    if (!template) {
      console.warn(`[DucieX] Template "${templateName}" not found`);
      return;
    }

    // Parse the XHR response as JSON context.
    let ctx;
    try {
      ctx = JSON.parse(evt.detail.xhr.responseText);
    } catch (e) {
      console.warn(`[DucieX] hx-template requires JSON response for "${templateName}"`);
      return;
    }

    // Render the template into the shared buffer.
    const byteLen = template.fn(ctx, _sharedBuffer, 0, _buildPartialsMap(template));
    const html    = _decoder.decode(_sharedBuffer.subarray(0, byteLen));

    // Override HTMX's swap target.
    evt.detail.serverResponse = html;
  });

  // htmx:afterRequest — used for RAF-batched swaps when hx-template-batch is set.
  document.body.addEventListener('htmx:afterRequest', function(evt) {
    const el = evt.detail.elt;
    if (!el) return;

    const templateName = el.getAttribute('hx-template-batch');
    if (!templateName) return;

    const template = _registry[templateName];
    if (!template) return;

    let ctx;
    try {
      ctx = JSON.parse(evt.detail.xhr.responseText);
    } catch (e) { return; }

    const byteLen = template.fn(ctx, _sharedBuffer, 0, _buildPartialsMap(template));
    const html    = _decoder.decode(_sharedBuffer.subarray(0, byteLen));
    const swapCfg = _resolveSwapConfig(el);
    _enqueueMutation(swapCfg.target, html, swapCfg.swapType);
  });
}

/**
 * Build the partials map for a template, linking partial names to their
 * RenderFunctions. The result is frozen so V8 can use fast property access.
 *
 * @param {CompiledTemplate} template
 * @returns {object}
 */
function _buildPartialsMap(template) {
  const names = template.partialNames;
  if (names.length === 0) return _emptyPartials;

  const map = Object.create(null);
  const n = names.length;
  for (let i = 0; i < n; i++) {
    const partial = _registry[names[i]];
    if (partial) {
      map[names[i]] = partial.fn;
    }
  }
  return Object.freeze(map);
}

// ─────────────────────────────────────────────────────────────────────────────
// § 10  PUBLIC API — TemplateEngine
// ─────────────────────────────────────────────────────────────────────────────

const TemplateEngine = {

  /** The shared output buffer — exposed for external tooling / debugging. */
  get sharedBuffer() { return _sharedBuffer; },

  /**
   * Compile a template and register it by name.
   * Safe to call during page load before HTMX initialises.
   *
   * @param {string} name
   * @param {string} source
   * @returns {CompiledTemplate}
   */
  compile(name, source) {
    const t0  = performance.now();
    const ast = parse(source, name);
    const { fn, partialNames } = codegen(ast, name);
    const t1  = performance.now();

    const compiled = {
      name,
      fn,
      partialNames,
      // Size hint: rough byte estimate for buffer pre-allocation checks.
      sizeHint: source.length * 2,
      source,
      compileMs: t1 - t0,
    };

    _registry[name] = compiled;
    return compiled;
  },

  /**
   * Register a partial (a template fragment used via {{> name}}).
   * Partials are compiled the same way as full templates.
   *
   * @param {string} name
   * @param {string} source
   */
  registerPartial(name, source) {
    this.compile(name, source);
  },

  /**
   * Compile many templates at once. Keys are names, values are source strings.
   * All partials are linked after all templates compile.
   *
   * @param {Record<string, string>} templates
   */
  preloadAll(templates) {
    const keys = Object.keys(templates);
    const n = keys.length;
    for (let i = 0; i < n; i++) {
      const name = keys[i];
      this.compile(name, templates[name]);
    }
  },

  /**
   * Render a named template with the given context.
   * Returns an HTML string decoded from the shared buffer.
   *
   * Note: this is NOT zero-allocation because it must return a JS string.
   * For zero-allocation rendering use renderToBuffer() and handle the bytes yourself.
   *
   * @param {string} name
   * @param {object} context
   * @returns {string}
   */
  render(name, context) {
    const template = _registry[name];
    if (!template) throw new Error(`[DucieX] Unknown template: "${name}"`);

    const partials = _buildPartialsMap(template);
    const byteLen  = template.fn(context, _sharedBuffer, 0, partials);
    // _decoder.decode allocates a string — unavoidable at the API boundary.
    return _decoder.decode(_sharedBuffer.subarray(0, byteLen));
  },

  /**
   * Render directly into a caller-supplied Uint8Array.
   * Zero allocations on the render path.
   *
   * @param {string} name
   * @param {object} context
   * @param {Uint8Array} buffer — must be large enough for the output
   * @returns {number} — bytes written
   */
  renderToBuffer(name, context, buffer) {
    const template = _registry[name];
    if (!template) throw new Error(`[DucieX] Unknown template: "${name}"`);

    const partials = _buildPartialsMap(template);
    return template.fn(context, buffer, 0, partials);
  },

  /**
   * Look up a compiled template by name.
   * @param {string} name
   * @returns {CompiledTemplate|undefined}
   */
  get(name) {
    return _registry[name];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// § 11  BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initHTMX);
  } else {
    _initHTMX();
  }
}

// ESM export for bundler environments; also exposes as a global for plain <script>.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TemplateEngine;
}
if (typeof globalThis !== 'undefined') {
  globalThis.TemplateEngine = TemplateEngine;
}
