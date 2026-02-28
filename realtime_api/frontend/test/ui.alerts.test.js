import test from "node:test";
import assert from "node:assert/strict";

import {
  hasPositiveDelayForAlertColumn,
  journeyModalStateReducer,
  normalizeDepartureAlerts,
  openDepartureAlertsPopover,
  resolveRenderableInlineAlertsForLineAlertButton,
  resolveDepartureAlertsForLineBadge,
  shouldShowBusLineAlertColumn,
  shouldIgnoreJourneyError,
} from "../v20260228.ui.js";

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

test("resolveRenderableInlineAlertsForLineAlertButton keeps renderable text (including banner-duplicate fallback)", () => {
  const dep = {
    alerts: [
      {
        id: "c-1",
        severity: "warning",
        header: "Line 7 deviation",
        description: "Stop moved",
      },
      {
        id: "c-2",
        severity: "warning",
        header: "  ",
        description: "",
      },
    ],
  };
  const banners = [
    {
      severity: "warning",
      header: "Line 7 deviation",
      description: "Stop moved",
    },
  ];

  const inlineAlerts = resolveRenderableInlineAlertsForLineAlertButton(dep, banners);
  assert.equal(Array.isArray(inlineAlerts), true);
  assert.equal(inlineAlerts.length, 1);
  assert.equal(inlineAlerts[0].id, "c-1");
});

test("hasPositiveDelayForAlertColumn accepts status/delay/displayedDelay signals", () => {
  assert.equal(
    hasPositiveDelayForAlertColumn({ mode: "bus", status: "delay", displayedDelayMin: 0, delayMin: 0 }),
    true
  );
  assert.equal(
    hasPositiveDelayForAlertColumn({ mode: "bus", status: null, displayedDelayMin: 2, delayMin: 0 }),
    true
  );
  assert.equal(
    hasPositiveDelayForAlertColumn({ mode: "bus", status: null, displayedDelayMin: 0, delayMin: 3 }),
    true
  );
  assert.equal(
    hasPositiveDelayForAlertColumn({ mode: "bus", status: null, displayedDelayMin: 0, delayMin: 0 }),
    false
  );
});

test("shouldShowBusLineAlertColumn requires delayed bus + renderable inline alert button", () => {
  const delayedBusNoAlerts = [{ mode: "bus", status: "delay", delayMin: 2, displayedDelayMin: 2, alerts: [] }];
  const alertBusNoDelay = [
    {
      mode: "bus",
      status: null,
      delayMin: 0,
      displayedDelayMin: 0,
      alerts: [{ id: "a-1", header: "Line 1 diversion", description: "Stop moved" }],
    },
  ];
  const mixedRows = [
    {
      mode: "bus",
      status: null,
      delayMin: 3,
      displayedDelayMin: 3,
      alerts: [],
    },
    {
      mode: "bus",
      status: null,
      delayMin: 0,
      displayedDelayMin: 0,
      alerts: [{ id: "a-2", header: "Line 2 disruption", description: "Stop skipped" }],
    },
  ];

  assert.equal(shouldShowBusLineAlertColumn(delayedBusNoAlerts, []), false);
  assert.equal(shouldShowBusLineAlertColumn(alertBusNoDelay, []), false);
  assert.equal(shouldShowBusLineAlertColumn(mixedRows, []), true);
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

test("shouldIgnoreJourneyError ignores superseded/user abort but not timeout abort", () => {
  const timeoutAbort = new DOMException("Timeout", "AbortError");
  const userAbort = new DOMException("Aborted", "AbortError");

  assert.equal(
    shouldIgnoreJourneyError(timeoutAbort, { requestId: 3, activeRequestId: 3 }),
    false
  );
  assert.equal(
    shouldIgnoreJourneyError(userAbort, { requestId: 3, activeRequestId: 3 }),
    true
  );
  assert.equal(
    shouldIgnoreJourneyError(new Error("whatever"), { requestId: 2, activeRequestId: 3 }),
    true
  );
});

test("journeyModalStateReducer clears loading on success and failure", () => {
  const started = journeyModalStateReducer(null, { type: "request_started" });
  assert.equal(started.loading, true);
  assert.equal(started.error, null);

  const failed = journeyModalStateReducer(started, {
    type: "request_failed",
    message: "boom",
  });
  assert.equal(failed.loading, false);
  assert.equal(failed.error, "boom");

  const restarted = journeyModalStateReducer(failed, { type: "request_started" });
  const succeeded = journeyModalStateReducer(restarted, { type: "request_succeeded" });
  assert.equal(succeeded.loading, false);
  assert.equal(succeeded.error, null);
});
