import test from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(String(key), String(value));
  }
}

class FakeClassList {
  constructor() {
    this._set = new Set();
  }

  add(...names) {
    for (const raw of names) {
      const name = String(raw || "").trim();
      if (name) this._set.add(name);
    }
  }

  remove(...names) {
    for (const raw of names) {
      const name = String(raw || "").trim();
      if (name) this._set.delete(name);
    }
  }

  contains(name) {
    return this._set.has(String(name || "").trim());
  }

  toggle(name, force) {
    const n = String(name || "").trim();
    if (!n) return false;
    if (force === true) {
      this._set.add(n);
      return true;
    }
    if (force === false) {
      this._set.delete(n);
      return false;
    }
    if (this._set.has(n)) {
      this._set.delete(n);
      return false;
    }
    this._set.add(n);
    return true;
  }
}

class FakeElement {
  constructor(tagName, doc) {
    this.tagName = String(tagName || "").toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.attributes = Object.create(null);
    this.dataset = Object.create(null);
    this.style = {};
    this.listeners = new Map();
    this.textContent = "";
    this.disabled = false;
    this.tabIndex = 0;
    this.scrollTop = 0;
    this.type = "";
    this._id = "";
  }

  set id(value) {
    const id = String(value || "");
    if (this._id) this.ownerDocument._unregisterId(this._id, this);
    this._id = id;
    if (id) this.ownerDocument._registerId(id, this);
  }

  get id() {
    return this._id;
  }

  set className(value) {
    this.classList = new FakeClassList();
    const parts = String(value || "")
      .split(/\s+/)
      .filter(Boolean);
    this.classList.add(...parts);
  }

  get className() {
    return Array.from(this.classList._set).join(" ");
  }

  set hidden(value) {
    if (value) this.attributes.hidden = "";
    else delete this.attributes.hidden;
  }

  get hidden() {
    return Object.prototype.hasOwnProperty.call(this.attributes, "hidden");
  }

  get offsetParent() {
    return this.hidden ? null : this.parentNode ? {} : null;
  }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  removeChild(node) {
    const idx = this.children.indexOf(node);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      node.parentNode = null;
    }
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
    if (this.id) this.ownerDocument._unregisterId(this.id, this);
  }

  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    for (const child of this.children) {
      if (child.contains(node)) return true;
    }
    return false;
  }

  setAttribute(name, value) {
    const key = String(name || "");
    const val = String(value ?? "");
    if (key === "id") {
      this.id = val;
      return;
    }
    if (key === "class") {
      this.className = val;
      return;
    }
    if (key === "hidden") {
      this.hidden = true;
      return;
    }
    this.attributes[key] = val;
    if (key.startsWith("data-")) {
      const dataKey = key
        .slice(5)
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[dataKey] = val;
    }
  }

  getAttribute(name) {
    const key = String(name || "");
    if (key === "id") return this.id || null;
    if (key === "class") return this.className || null;
    if (key === "hidden") return this.hidden ? "" : null;
    return Object.prototype.hasOwnProperty.call(this.attributes, key)
      ? this.attributes[key]
      : null;
  }

  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }

  toggleAttribute(name, force) {
    const key = String(name || "");
    const has = this.hasAttribute(key);
    const shouldAdd = force === undefined ? !has : !!force;
    if (shouldAdd) this.setAttribute(key, "");
    else this.removeAttribute(key);
    return shouldAdd;
  }

  removeAttribute(name) {
    const key = String(name || "");
    if (key === "id") {
      this.id = "";
      return;
    }
    if (key === "hidden") {
      this.hidden = false;
      return;
    }
    delete this.attributes[key];
  }

  addEventListener(type, handler) {
    const key = String(type || "");
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(handler);
  }

  dispatchEvent(evt) {
    const event = evt || {};
    if (!event.type) throw new Error("Event type is required");
    if (!event.preventDefault) {
      event.preventDefault = () => {
        event.defaultPrevented = true;
      };
    }
    if (!Object.prototype.hasOwnProperty.call(event, "target")) {
      event.target = this;
    }
    event.currentTarget = this;

    const handlers = this.listeners.get(event.type) || [];
    for (const handler of handlers) handler(event);
    return !event.defaultPrevented;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  querySelectorAll(selector) {
    return querySelectorAllFrom(this, selector);
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length ? all[0] : null;
  }
}

class FakeDocument {
  constructor() {
    this._byId = new Map();
    this.documentElement = { clientWidth: 1000, lang: "fr" };
    this.body = new FakeElement("body", this);
    this.activeElement = this.body;
  }

  _registerId(id, el) {
    this._byId.set(String(id), el);
  }

  _unregisterId(id, el) {
    const key = String(id);
    if (this._byId.get(key) === el) this._byId.delete(key);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this._byId.get(String(id || "")) || null;
  }
}

function walkDescendants(root, cb) {
  for (const child of root.children) {
    cb(child);
    walkDescendants(child, cb);
  }
}

function matchesSelector(el, selector) {
  const sel = String(selector || "").trim();
  if (!sel) return false;

  if (sel.startsWith("#")) return el.id === sel.slice(1);
  if (sel.startsWith(".")) {
    const classes = sel
      .slice(1)
      .split(".")
      .filter(Boolean);
    return classes.every((cls) => el.classList.contains(cls));
  }
  if (sel === "button") return el.tagName === "BUTTON";
  if (sel === "input") return el.tagName === "INPUT";
  if (sel === "select") return el.tagName === "SELECT";
  if (sel === "textarea") return el.tagName === "TEXTAREA";
  if (sel === "[href]") return el.hasAttribute("href");
  if (sel.startsWith("[tabindex]")) return String(el.tabIndex) !== "-1";
  return el.tagName.toLowerCase() === sel.toLowerCase();
}

function querySelectorAllFrom(root, selector) {
  const selectors = String(selector || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  const seen = new Set();
  walkDescendants(root, (el) => {
    if (selectors.some((sel) => matchesSelector(el, sel)) && !seen.has(el)) {
      seen.add(el);
      out.push(el);
    }
  });
  return out;
}

function event(type, extra = {}) {
  return {
    type,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...extra,
  };
}

function findByClass(root, className) {
  let found = null;
  walkDescendants(root, (el) => {
    if (!found && el.classList.contains(className)) found = el;
  });
  return found;
}

test("info modal keeps dialog semantics, tab behavior, focus return, and background lock", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousLocalStorage = globalThis.localStorage;
  const previousRAF = globalThis.requestAnimationFrame;
  const previousHTMLElement = globalThis.HTMLElement;

  const doc = new FakeDocument();
  const storage = new MemoryStorage();
  const badge = doc.createElement("button");
  badge.id = "info-badge";
  doc.body.appendChild(badge);

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      innerWidth: 1020,
      location: { search: "" },
      matchMedia: () => ({ matches: false }),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: doc,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      languages: ["fr-FR"],
      language: "fr-FR",
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (cb) => cb(),
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    writable: true,
    value: FakeElement,
  });

  try {
    const { setupInfoButton } = await import(`../v20260223-1.infoBTN.js?test=${Date.now()}`);
    setupInfoButton();

    badge.focus();
    badge.dispatchEvent(event("click"));

    const overlay = doc.getElementById("info-overlay");
    assert.ok(overlay);
    assert.equal(overlay.classList.contains("is-visible"), true);
    assert.equal(doc.body.classList.contains("info-modal-open"), true);
    assert.equal(doc.body.style.paddingRight, "20px");

    const panel = findByClass(overlay, "info-panel");
    assert.ok(panel);
    assert.equal(panel.getAttribute("role"), "dialog");
    assert.equal(panel.getAttribute("aria-modal"), "true");
    assert.equal(panel.getAttribute("aria-labelledby"), "info-panel-title");
    assert.equal(panel.getAttribute("aria-describedby"), "info-panel-desc");

    const title = doc.getElementById("info-panel-title");
    const desc = doc.getElementById("info-panel-desc");
    assert.ok(title);
    assert.ok(desc);
    assert.equal(title.tagName, "H2");

    const tabHelp = doc.getElementById("info-tab-help");
    const tabRealtime = doc.getElementById("info-tab-realtime");
    const tabCredits = doc.getElementById("info-tab-credits");
    assert.ok(tabHelp);
    assert.ok(tabRealtime);
    assert.ok(tabCredits);

    const panelHelp = doc.getElementById("info-panel-help");
    const panelRealtime = doc.getElementById("info-panel-realtime");
    const panelCredits = doc.getElementById("info-panel-credits");
    assert.ok(panelHelp);
    assert.ok(panelRealtime);
    assert.ok(panelCredits);
    assert.equal(tabHelp.getAttribute("aria-selected"), "true");
    assert.equal(tabRealtime.getAttribute("aria-selected"), "false");

    const body = findByClass(overlay, "info-panel-body");
    assert.ok(body);
    body.scrollTop = 85;
    tabRealtime.dispatchEvent(event("click"));
    assert.equal(body.scrollTop, 0);
    assert.equal(tabRealtime.getAttribute("aria-selected"), "true");
    assert.equal(panelRealtime.classList.contains("is-active"), true);
    assert.equal(panelRealtime.hasAttribute("hidden"), false);
    assert.equal(panelHelp.hasAttribute("hidden"), true);

    overlay.dispatchEvent(event("keydown", { key: "Escape" }));
    assert.equal(overlay.classList.contains("is-visible"), false);
    assert.equal(doc.body.classList.contains("info-modal-open"), false);
    assert.equal(doc.body.style.paddingRight, "");
    assert.equal(doc.activeElement, badge);

    badge.dispatchEvent(event("click"));
    assert.equal(overlay.classList.contains("is-visible"), true);
    overlay.dispatchEvent(event("click", { target: overlay }));
    assert.equal(overlay.classList.contains("is-visible"), false);
    assert.equal(doc.body.classList.contains("info-modal-open"), false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: previousWindow });
    if (previousDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: previousDocument });
    if (previousNavigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: previousNavigator });
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: previousLocalStorage });
    if (previousRAF === undefined) delete globalThis.requestAnimationFrame;
    else Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: previousRAF });
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: previousHTMLElement });
  }
});
