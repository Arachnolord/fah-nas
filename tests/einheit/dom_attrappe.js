// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Gemeinsame DOM-Attrappe für Oberflächen-Tests in Node (kein jsdom, keine npm-Pakete). Bildet nur ab, was die
// Oberfläche wirklich benutzt: Knoten-Baum, Attribute, Klassen, dataset, CSSOM-Stil, Ereignisse mit Aufsteigen,
// Formularwerte, <dialog> (showModal/close/open), einfache Selektoren (Tag, .klasse, #id, [attr], [attr="w"],
// Nachfahren-Kombinator, Komma-Listen) und eine Serialisierung `alsText()` für Assertions.

class AttrappeEvent {
  constructor(type, init = {}) {
    this.type = type; this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable;
    this.defaultPrevented = false; this.target = null; this.currentTarget = null; this._gestoppt = false;
    Object.assign(this, Object.fromEntries(Object.entries(init).filter(([k]) => !['bubbles', 'cancelable'].includes(k))));
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._gestoppt = true; }
  stopImmediatePropagation() { this._gestoppt = true; }
}
class AttrappeKeyboardEvent extends AttrappeEvent {}
class AttrappeInputEvent extends AttrappeEvent {}

class Hoerer {
  constructor() { this.hoerer = new Map(); }
  addEventListener(art, fn) { if (!fn) return; if (!this.hoerer.has(art)) this.hoerer.set(art, []); this.hoerer.get(art).push(fn); }
  removeEventListener(art, fn) { const l = this.hoerer.get(art); if (l) this.hoerer.set(art, l.filter((x) => x !== fn)); }
  _ausloesen(ev) {
    for (const fn of [...(this.hoerer.get(ev.type) || [])]) {
      ev.currentTarget = this;
      if (typeof fn === 'function') fn.call(this, ev); else if (fn && typeof fn.handleEvent === 'function') fn.handleEvent(ev);
      if (ev._gestoppt) break;
    }
  }
}

export class AttrappeNode extends Hoerer {
  constructor() { super(); this.parentNode = null; this.childNodes = []; }
  get isConnected() { let k = this; while (k.parentNode) k = k.parentNode; return k === globalThis.document?.documentElement; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] || null; }
  get previousSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) - 1] || null; }
  _einhaengen(k, index) {
    if (k.nodeType === 11) { const kinder = [...k.childNodes]; k.childNodes = []; kinder.forEach((x, i) => { x.parentNode = null; this._einhaengen(x, index === undefined ? undefined : index + i); }); return k; }
    if (k.parentNode) k.parentNode.removeChild(k);
    k.parentNode = this;
    if (index === undefined || index < 0 || index >= this.childNodes.length) this.childNodes.push(k); else this.childNodes.splice(index, 0, k);
    return k;
  }
  appendChild(k) { return this._einhaengen(k); }
  append(...kinder) { for (const k of kinder) this._einhaengen(typeof k === 'string' ? new AttrappeText(k) : k); }
  prepend(...kinder) { kinder.reverse().forEach((k) => this._einhaengen(typeof k === 'string' ? new AttrappeText(k) : k, 0)); }
  insertBefore(k, ref) { return ref ? this._einhaengen(k, this.childNodes.indexOf(ref)) : this._einhaengen(k); }
  removeChild(k) { this.childNodes = this.childNodes.filter((x) => x !== k); k.parentNode = null; return k; }
  replaceChild(neu, alt) { const i = this.childNodes.indexOf(alt); this.removeChild(alt); return this._einhaengen(neu, i); }
  replaceChildren(...kinder) { for (const k of [...this.childNodes]) this.removeChild(k); this.append(...kinder); }
  replaceWith(...kinder) { const p = this.parentNode; if (!p) return; const i = p.childNodes.indexOf(this); p.removeChild(this); kinder.forEach((k, n) => p._einhaengen(typeof k === 'string' ? new AttrappeText(k) : k, i + n)); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(k) { for (let x = k; x; x = x.parentNode) if (x === this) return true; return false; }
  cloneNode(tief = false) {
    let k;
    if (this.nodeType === 3) return new AttrappeText(this.data);
    if (this.nodeType === 11) k = new AttrappeFragment();
    else {
      k = new AttrappeElement(this.localName, this.namespaceURI);
      for (const [n, v] of this.attribute) k.setAttribute(n, v);
      Object.assign(k.dataset, this.dataset);
      for (const [n, v] of Object.entries(this.style)) if (typeof v === 'string') k.style[n] = v;
    }
    if (tief) for (const c of this.childNodes) k.appendChild(c.cloneNode(true));
    return k;
  }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    const pfad = []; for (let x = this; x; x = x.parentNode) pfad.push(x);
    for (const x of ev.bubbles ? pfad : [this]) { x._ausloesen(ev); if (ev._gestoppt) break; }
    if (ev.bubbles && !ev._gestoppt && globalThis.document && pfad[pfad.length - 1] === globalThis.document.documentElement) globalThis.document._ausloesen(ev);
    return !ev.defaultPrevented;
  }
}

export class AttrappeText extends AttrappeNode {
  constructor(text) { super(); this.nodeType = 3; this.data = String(text); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  get nodeValue() { return this.data; }
  set nodeValue(v) { this.data = String(v); }
}

export class AttrappeFragment extends AttrappeNode {
  constructor() { super(); this.nodeType = 11; }
  get textContent() { return this.childNodes.map((k) => k.textContent).join(''); }
  get children() { return this.childNodes.filter((k) => k.nodeType === 1); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { return suchen(this, s); }
}

const LEER_ELEMENTE = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'source', 'col', 'wbr']);
const BOOL_EIGENSCHAFTEN = ['checked', 'disabled', 'hidden', 'readOnly', 'multiple', 'selected', 'required', 'open'];

export class AttrappeElement extends AttrappeNode {
  constructor(tag, ns) {
    super();
    this.nodeType = 1; this.localName = String(tag).toLowerCase(); this.tagName = this.localName.toUpperCase(); this.namespaceURI = ns || null;
    this.attribute = new Map(); this.dataset = {}; this._wert = ''; this.fokussiert = false;
    const stil = { eigenschaften: {}, setProperty(k, v) { stil.eigenschaften[k] = String(v); }, getPropertyValue(k) { return stil.eigenschaften[k] || ''; }, removeProperty(k) { delete stil.eigenschaften[k]; } };
    this.style = stil;
    this.classList = {
      add: (...k) => this.setAttribute('class', [...new Set([...this.klassen(), ...k])].join(' ')),
      remove: (...k) => this.setAttribute('class', this.klassen().filter((x) => !k.includes(x)).join(' ')),
      toggle: (k, an) => { const hat = this.klassen().includes(k); const soll = an === undefined ? !hat : !!an; if (soll && !hat) this.classList.add(k); if (!soll && hat) this.classList.remove(k); return soll; },
      contains: (k) => this.klassen().includes(k),
    };
  }
  klassen() { return (this.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get children() { return this.childNodes.filter((k) => k.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get textContent() { return this.childNodes.map((k) => k.textContent).join(''); }
  set textContent(v) { for (const k of [...this.childNodes]) this.removeChild(k); if (v !== '' && v !== null && v !== undefined) this._einhaengen(new AttrappeText(v)); }
  get innerText() { return this.textContent; }
  get value() { return this._wert; }
  set value(v) { this._wert = String(v ?? ''); }
  get type() { return this.getAttribute('type') || (this.localName === 'input' ? 'text' : ''); }
  set type(v) { this.setAttribute('type', v); }
  get href() { return this.getAttribute('href') || ''; }
  set href(v) { this.setAttribute('href', v); }
  setAttribute(k, v) { this.attribute.set(k, String(v)); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_m, b) => b.toUpperCase())] = String(v); }
  getAttribute(k) { return this.attribute.has(k) ? this.attribute.get(k) : null; }
  removeAttribute(k) { this.attribute.delete(k); }
  hasAttribute(k) { return this.attribute.has(k); }
  toggleAttribute(k, an) { const soll = an === undefined ? !this.hasAttribute(k) : !!an; if (soll) this.setAttribute(k, ''); else this.removeAttribute(k); return soll; }
  focus() { this.fokussiert = true; if (globalThis.document) globalThis.document.activeElement = this; }
  blur() { this.fokussiert = false; if (globalThis.document && globalThis.document.activeElement === this) globalThis.document.activeElement = null; }
  click() { this.dispatchEvent(new AttrappeEvent('click', { bubbles: true, cancelable: true })); }
  select() {}
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  scrollIntoView() {}
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  matches(s) { return String(s).split(',').some((t) => passt(this, t.trim())); }
  closest(s) { for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (x.matches(s)) return x; return null; }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { return suchen(this, s); }
  // <dialog>
  showModal() { this.setAttribute('open', ''); }
  show() { this.setAttribute('open', ''); }
  close(wert) { if (!this.hasAttribute('open')) return; this.removeAttribute('open'); if (wert !== undefined) this.returnValue = wert; this.dispatchEvent(new AttrappeEvent('close')); }
}
for (const e of BOOL_EIGENSCHAFTEN) {
  const attr = e === 'readOnly' ? 'readonly' : e;
  Object.defineProperty(AttrappeElement.prototype, e, {
    get() { return this.hasAttribute(attr); },
    set(v) { if (v) this.setAttribute(attr, ''); else this.removeAttribute(attr); },
  });
}

/** Ein zusammengesetzter Selektor ohne Kombinator: tag, .k, #id, [a], [a="w"] in beliebiger Folge. */
function passtEinfach(el, sel) {
  if (!el || el.nodeType !== 1) return false;
  const re = /([a-zA-Z][a-zA-Z0-9-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]|(\*)/g;
  let m; let gelesen = 0;
  while ((m = re.exec(sel))) {
    if (m.index !== gelesen) return false;
    gelesen = re.lastIndex;
    if (m[1] && el.localName !== m[1].toLowerCase()) return false;
    if (m[2] && !el.klassen().includes(m[2])) return false;
    if (m[3] && el.getAttribute('id') !== m[3]) return false;
    if (m[4] && (!el.hasAttribute(m[4]) || (m[5] !== undefined && el.getAttribute(m[4]) !== m[5]))) return false;
  }
  return gelesen === sel.length && sel.length > 0;
}

/** Selektor mit Nachfahren-Kombinator (Leerzeichen) und Kind-Kombinator (>). */
function passt(el, sel) {
  const teile = sel.replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
  const pruefe = (knoten, i) => {
    if (!passtEinfach(knoten, teile[i])) return false;
    if (i === 0) return true;
    if (teile[i - 1] === '>') return pruefe(knoten.parentNode, i - 2);
    for (let x = knoten.parentNode; x && x.nodeType === 1; x = x.parentNode) if (pruefe(x, i - 1)) return true;
    return false;
  };
  return pruefe(el, teile.length - 1);
}

function suchen(wurzel, sel) {
  const aus = [];
  const gehe = (k) => { for (const c of k.childNodes) { if (c.nodeType === 1) { if (c.matches(sel)) aus.push(c); gehe(c); } } };
  gehe(wurzel);
  return aus;
}

function escape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/** Serialisiert einen Knoten (oder ein Fragment) wie HTML – nur für Assertions. Attribute in Einfügereihenfolge. */
export function alsText(k) {
  if (!k) return '';
  if (k.nodeType === 3) return escape(k.data);
  if (k.nodeType === 11) return k.childNodes.map(alsText).join('');
  const attr = [...k.attribute.entries()].map(([n, v]) => (v === '' ? ` ${n}` : ` ${n}="${escape(v)}"`)).join('');
  if (LEER_ELEMENTE.has(k.localName)) return `<${k.localName}${attr}>`;
  return `<${k.localName}${attr}>${k.childNodes.map(alsText).join('')}</${k.localName}>`;
}

/**
 * Setzt globalThis.document/window/… auf eine frische Attrappe. Gibt {document, window, aufraeumen()} zurück;
 * aufraeumen() stellt die vorherigen globalen Werte wieder her.
 */
export function domAttrappe() {
  const vorher = {};
  const NAMEN = ['document', 'window', 'location', 'localStorage', 'sessionStorage', 'matchMedia', 'Node', 'Event', 'KeyboardEvent', 'InputEvent', 'HTMLElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'];
  for (const n of NAMEN) vorher[n] = Object.getOwnPropertyDescriptor(globalThis, n);
  const documentElement = new AttrappeElement('html');
  const head = new AttrappeElement('head');
  const body = new AttrappeElement('body');
  documentElement.appendChild(head); documentElement.appendChild(body);
  const dokument = new Hoerer();
  Object.assign(dokument, {
    nodeType: 9, documentElement, head, body, title: '', cookie: 'fahnas_csrf=abc123', activeElement: null, visibilityState: 'visible', hidden: false,
    createElement: (tag) => new AttrappeElement(tag),
    createElementNS: (ns, tag) => new AttrappeElement(tag, ns),
    createTextNode: (text) => new AttrappeText(text),
    createDocumentFragment: () => new AttrappeFragment(),
    getElementById: (id) => suchen(documentElement, `#${id}`)[0] || null,
    querySelector: (s) => suchen(documentElement, s)[0] || null,
    querySelectorAll: (s) => suchen(documentElement, s),
    dispatchEvent(ev) { ev.target = ev.target || dokument; dokument._ausloesen(ev); return !ev.defaultPrevented; },
  });
  const fenster = new Hoerer();
  fenster.dispatchEvent = (ev) => { ev.target = ev.target || fenster; fenster._ausloesen(ev); return !ev.defaultPrevented; };
  const speicher = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; })();
  const setze = (n, wert) => Object.defineProperty(globalThis, n, { value: wert, configurable: true, writable: true });
  setze('document', dokument);
  setze('window', globalThis);
  setze('location', { hash: '', href: 'https://nas.local/', origin: 'https://nas.local', host: 'nas.local', pathname: '/', replace() {}, reload() {} });
  setze('localStorage', speicher);
  setze('sessionStorage', speicher);
  setze('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  setze('Node', AttrappeNode);
  setze('Event', AttrappeEvent);
  setze('KeyboardEvent', AttrappeKeyboardEvent);
  setze('InputEvent', AttrappeInputEvent);
  setze('HTMLElement', AttrappeElement);
  setze('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  setze('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 0));
  setze('cancelAnimationFrame', (id) => clearTimeout(id));
  // window-Ereignisse (beforeunload, keydown …) über globalThis
  vorher.addEventListener = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
  vorher.removeEventListener = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');
  vorher.dispatchEvent = Object.getOwnPropertyDescriptor(globalThis, 'dispatchEvent');
  setze('addEventListener', fenster.addEventListener.bind(fenster));
  setze('removeEventListener', fenster.removeEventListener.bind(fenster));
  setze('dispatchEvent', fenster.dispatchEvent);
  return {
    document: dokument, window: globalThis, fenster,
    aufraeumen() {
      for (const [n, d] of Object.entries(vorher)) { if (d) Object.defineProperty(globalThis, n, d); else delete globalThis[n]; }
    },
  };
}
