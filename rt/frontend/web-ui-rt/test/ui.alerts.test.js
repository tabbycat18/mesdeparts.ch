import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeDepartureAlerts,
  openDepartureAlertsPopover,
  resolveDepartureAlertsForLineBadge,
} from "../ui.v2026-02-21-2.js";

class FakeClassList {
  constructor() {
    this._set = new Set();
  }

  add(...names) {
    for (const name of names) {
      const value = String(name || "").trim();
      if (value) this._set.add(value);
    }
  }

  remove(...names) {
    for (const name of names) this._set.delete(String(name || "").trim());
  }

  contains(name) {
    return this._set.has(String(name || "").trim());
  }

  toggle(name, force) {
    const key = String(name || "").trim();
    if (!key) return false;
    if (force === true) {
      this._set.add(key);
      return true;
    }
    if (force === false) {
      this._set.delete(key);
      return false;
    }
    if (this._set.has(key)) {
      this._set.delete(key);
      return false;
    }
    this._set.add(key);
    return true;
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || "").toUpperCase();
    this.ownerDocument = ownerDocument || null;
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.style = {
      removeProperty: () => {},
    };
    this.attributes = Object.create(null);
    this.textContent = "";
    this._id = "";
    this.rect = { left: 12, top: 12, right: 72, bottom: 32, width: 60, height: 20 };
  }

  set id(value) {
    this._id = String(value || "");
    if (this.ownerDocument && this._id) {
      this.ownerDocument._register(this._id, this);
    }
  }

  get id() {
    return this._id;
  }

  set className(value) {
    this.classList = new FakeClassList();
    const parts = String(value || "").split(/\s+/).filter(Boolean);
    this.classList.add(...parts);
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

  setAttribute(name, value) {
    this.attributes[String(name)] = String(value);
  }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    if (node.id && this.ownerDocument) {
      this.ownerDocument._register(node.id, node);
    }
    return node;
  }

  addEventListener() {}

  focus() {}

  getBoundingClientRect() {
    return this.rect;
  }
}

class FakeDocument {
  constructor() {
    this._byId = new Map();
    this.body = new FakeElement("body", this);
    this.documentElement = { clientWidth: 390, clientHeight: 844 };
  }

  _register(id, node) {
    this._byId.set(String(id), node);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createTextNode(text) {
    const node = new FakeElement("#text", this);
    node.textContent = String(text || "");
    return node;
  }

  addEventListener() {}

  getElementById(id) {
    return this._byId.get(String(id || "")) || null;
  }
}

test("normalizeDepartureAlerts dedupes and suppresses banner-duplicate alerts", () => {
  const dep = {
    alerts: [
      {
        id: "a-1",
        severity: "warning",
        header: "Limited train service between A and B",
        description: "Construction work",
      },
      {
        id: "a-1",
        severity: "warning",
        header: "Limited train service between A and B",
        description: "Construction work",
      },
      {
        id: "a-2",
        severity: "warning",
        header: "Station closed",
        description: "Weather disruption",
      },
      {
        id: "empty",
        severity: "info",
        header: "",
        description: "",
      },
    ],
  };
  const banners = [
    {
      severity: "warning",
      header: "Station closed",
      description: "Weather disruption",
    },
  ];

  const detailAlerts = normalizeDepartureAlerts(dep, banners, {
    suppressBannerDuplicates: false,
  });
  const inlineAlerts = normalizeDepartureAlerts(dep, banners, {
    suppressBannerDuplicates: true,
  });

  assert.equal(detailAlerts.length, 2);
  assert.equal(inlineAlerts.length, 1);
  assert.equal(inlineAlerts[0].id, "a-1");
});

test("resolveDepartureAlertsForLineBadge falls back when all alerts duplicate banners", () => {
  const dep = {
    alerts: [
      {
        id: "b-1",
        severity: "warning",
        header: "Line 1 disruption",
        description: "Stop moved",
      },
    ],
  };
  const banners = [
    {
      severity: "warning",
      header: "Line 1 disruption",
      description: "Stop moved",
    },
  ];

  const alerts = resolveDepartureAlertsForLineBadge(dep, banners);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, "b-1");
});

test("openDepartureAlertsPopover creates a visible panel with alert content", () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;

  const doc = new FakeDocument();
  globalThis.document = doc;
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 900,
    addEventListener: () => {},
  };

  try {
    const dep = {
      line: "M10",
      alerts: [
        {
          id: "a-1",
          severity: "warning",
          header: "Service restreint",
          description: "Travaux en cours",
        },
      ],
    };
    const anchor = doc.createElement("button");
    anchor.rect = { left: 100, top: 200, right: 160, bottom: 226, width: 60, height: 26 };

    openDepartureAlertsPopover(dep, anchor);

    const layer = doc.getElementById("departure-alerts-layer");
    assert.ok(layer);
    assert.equal(layer.classList.contains("is-visible"), true);
    const panel = layer.children[0];
    assert.ok(panel);
    const list = panel.children[1];
    assert.ok(list);
    assert.equal(list.childElementCount, 1);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
