import test from "node:test";
import assert from "node:assert/strict";

import { renderServiceBanners } from "../ui.v2026-02-21-1.js";

class FakeClassList {
  constructor() {
    this._set = new Set();
  }

  add(...names) {
    for (const name of names) {
      const n = String(name || "").trim();
      if (n) this._set.add(n);
    }
  }

  remove(...names) {
    for (const name of names) {
      this._set.delete(String(name || "").trim());
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
  constructor(tagName) {
    this.tagName = String(tagName || "").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.style = {};
    this.attributes = Object.create(null);
    this.textContent = "";
    this._id = "";
    this.src = "";
    this.alt = "";
  }

  set id(value) {
    this._id = String(value || "");
  }

  get id() {
    return this._id;
  }

  set className(value) {
    this.classList = new FakeClassList();
    const parts = String(value || "").split(/\s+/).filter(Boolean);
    this.classList.add(...parts);
  }

  get className() {
    return "";
  }

  setAttribute(name, value) {
    this.attributes[String(name)] = String(value);
  }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  set innerHTML(value) {
    if (String(value || "") === "") {
      this.children = [];
      this.textContent = "";
    }
  }

  get childElementCount() {
    return this.children.length;
  }
}

class FakeDocument {
  constructor() {
    this._byId = new Map();
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  getElementById(id) {
    return this._byId.get(String(id || "")) || null;
  }

  querySelector() {
    return null;
  }

  registerById(id, element) {
    if (!element) return;
    element.id = id;
    this._byId.set(String(id), element);
  }
}

test("renderServiceBanners renders visible banner rows when payload includes banners", () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;

  const doc = new FakeDocument();
  const host = doc.createElement("section");
  host.className = "service-banners";
  doc.registerById("service-banners", host);

  globalThis.window = { innerWidth: 1280 };
  globalThis.document = doc;

  try {
    renderServiceBanners([
      {
        severity: "warning",
        header: "Limited train service between A and B",
        description: "Construction work, replacement transport.",
      },
    ]);

    assert.equal(host.classList.contains("is-visible"), true);
    assert.equal(host.childElementCount, 1);

    const banner = host.children[0];
    assert.equal(banner.classList.contains("service-banner"), true);

    const body = banner.children.find((child) => child.classList.contains("service-banner__body"));
    assert.ok(body);

    const title = body.children.find((child) => child.classList.contains("service-banner__title"));
    const text = body.children.find((child) => child.classList.contains("service-banner__text"));
    assert.ok(title);
    assert.ok(text);
    assert.equal(title.textContent, "Limited train service between A and B");
    assert.equal(text.textContent, "Construction work, replacement transport.");
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
