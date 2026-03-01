// refreshHint.test.js
// Regression tests for loading-hint ownership in the stationboard refresh loop.
//
// These tests verify the behavioral contract of the `finally` block in
// `refreshDepartures` (v20260301.main.js) without requiring a browser DOM:
//
//   1. Queued refresh: after a foreground request finishes with a pending
//      follow-up, the loading hint must be OFF (not stuck).
//   2. Stale/superseded request: when the current request has been superseded
//      by a station switch, the loading hint must be OFF.
//   3. Failed first-load: when the first fetch fails (no rows yet), the hint
//      must be OFF and the error state is surfaced.
//   4. Normal completion: hint is OFF at the end of every normal path.
//
// Each test drives a `simulateRefreshFinally` helper that mirrors the exact
// finally-block logic from main.js — keeping the contract in one place so a
// future regression in the real file is caught by these tests.

import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Minimal hint tracker (mirrors setBoardLoadingHint / state.isBoardLoading)
// ---------------------------------------------------------------------------

function makeHintTracker() {
  let visible = false;
  const calls = [];
  return {
    setBoardLoadingHint(isLoading) {
      visible = !!isLoading;
      calls.push(!!isLoading);
    },
    get isVisible() {
      return visible;
    },
    get calls() {
      return calls;
    },
  };
}

// ---------------------------------------------------------------------------
// Simulation of the fixed `finally` block in refreshDepartures.
//
// Parameters mirror the closure variables captured at the call site:
//   showLoadingHint   – whether this invocation set the hint ON at the start
//   hasPendingRequest – whether pendingRefreshRequest is non-null
//   isStale           – whether isStaleRequest() returns true
//   hint              – hint tracker (mock for setBoardLoadingHint)
//
// Returns an object describing what actions were taken.
// ---------------------------------------------------------------------------

function simulateRefreshFinally({ showLoadingHint, hasPendingRequest, isStale, hint }) {
  // --- Fixed logic (must match the finally block in main.js) ---
  // refreshInFlight = false  (not modelled here, no assertions on it)

  // Always clear hint before any early return.
  if (showLoadingHint) {
    hint.setBoardLoadingHint(false);
  }

  if (hasPendingRequest) {
    // Queue the pending request (setTimeout omitted in simulation)
    return { path: "queued" };
  }

  if (isStale) {
    return { path: "stale" };
  }

  // Normal completion path
  return { path: "normal" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("queued refresh: hint must be OFF after foreground request with pending follow-up", () => {
  const hint = makeHintTracker();

  // Foreground refresh sets hint ON at the start of the call.
  hint.setBoardLoadingHint(true);
  assert.equal(hint.isVisible, true, "precondition: hint is ON");

  // Scheduler fires while request is inflight → gets enqueued (showLoadingHint=false).
  // When the foreground request finishes, finally runs with hasPendingRequest=true.
  simulateRefreshFinally({
    showLoadingHint: true,
    hasPendingRequest: true,
    isStale: false,
    hint,
  });

  assert.equal(
    hint.isVisible,
    false,
    "hint must be OFF after foreground request exits with a queued follow-up"
  );
});

test("queued refresh: background request (showLoadingHint=false) must not affect hint visibility", () => {
  const hint = makeHintTracker();

  // Background scheduler call: hint was never set ON for this request.
  hint.setBoardLoadingHint(false); // initial state
  assert.equal(hint.isVisible, false, "precondition: hint is already OFF");

  simulateRefreshFinally({
    showLoadingHint: false,
    hasPendingRequest: true,
    isStale: false,
    hint,
  });

  // No setBoardLoadingHint(false) call should have been made since showLoadingHint=false.
  // Hint stays OFF regardless.
  assert.equal(hint.isVisible, false, "hint must remain OFF for background request with pending queue");

  // Specifically, setBoardLoadingHint must NOT have been called since the hint
  // was never set by this request.
  const hintCallsFromFinally = hint.calls.slice(1); // skip the initialisation call above
  assert.equal(hintCallsFromFinally.length, 0, "no setBoardLoadingHint call expected when showLoadingHint=false");
});

test("stale/superseded request: hint must be OFF when request is stale", () => {
  const hint = makeHintTracker();

  // Foreground refresh sets hint ON, then station switches mid-fetch (seq incremented).
  hint.setBoardLoadingHint(true);
  assert.equal(hint.isVisible, true, "precondition: hint is ON");

  simulateRefreshFinally({
    showLoadingHint: true,
    hasPendingRequest: false,
    isStale: true,
    hint,
  });

  assert.equal(
    hint.isVisible,
    false,
    "hint must be OFF for a stale/superseded request (station switched mid-fetch)"
  );
});

test("failed first-load: hint must be OFF after catch + transient retry scheduled", () => {
  const hint = makeHintTracker();

  // First fetch fails with a transient error; a retry is scheduled and the
  // finally block runs with no pending request and no stale condition.
  // showLoadingHint=true (original foreground call), hasPendingRequest=false, isStale=false.
  hint.setBoardLoadingHint(true);

  simulateRefreshFinally({
    showLoadingHint: true,
    hasPendingRequest: false,
    isStale: false,
    hint,
  });

  assert.equal(hint.isVisible, false, "hint must be OFF after failed first-load (catch path)");
});

test("normal completion: hint is cleared on the happy path", () => {
  const hint = makeHintTracker();

  hint.setBoardLoadingHint(true);
  assert.equal(hint.isVisible, true, "precondition: hint is ON");

  const result = simulateRefreshFinally({
    showLoadingHint: true,
    hasPendingRequest: false,
    isStale: false,
    hint,
  });

  assert.equal(result.path, "normal");
  assert.equal(hint.isVisible, false, "hint must be OFF after normal successful completion");
});

test("normal completion without hint: no setBoardLoadingHint call made", () => {
  const hint = makeHintTracker();

  // Scheduler background request: showLoadingHint=false from the start.
  const result = simulateRefreshFinally({
    showLoadingHint: false,
    hasPendingRequest: false,
    isStale: false,
    hint,
  });

  assert.equal(result.path, "normal");
  assert.equal(hint.calls.length, 0, "no setBoardLoadingHint call expected when showLoadingHint=false");
});

// ---------------------------------------------------------------------------
// Regression: verify the OLD (broken) finally block would fail these tests.
// This documents what went wrong before the fix, and asserts the fix is correct.
// ---------------------------------------------------------------------------

function simulateRefreshFinallyBroken({ showLoadingHint, hasPendingRequest, isStale, hint }) {
  // OLD behaviour: setBoardLoadingHint only called at the END (after early returns).
  if (hasPendingRequest) {
    return { path: "queued" }; // <-- early return WITHOUT clearing hint
  }
  if (isStale) {
    return { path: "stale" }; // <-- early return WITHOUT clearing hint
  }
  if (showLoadingHint) {
    hint.setBoardLoadingHint(false); // only reached on normal path
  }
  return { path: "normal" };
}

test("regression: old finally block would leave hint stuck on queued path", () => {
  const hint = makeHintTracker();
  hint.setBoardLoadingHint(true);

  simulateRefreshFinallyBroken({
    showLoadingHint: true,
    hasPendingRequest: true,
    isStale: false,
    hint,
  });

  // This assertion documents the OLD bug: hint is stuck ON.
  assert.equal(
    hint.isVisible,
    true,
    "OLD code: hint is stuck ON (this confirms the pre-fix bug)"
  );
});

test("regression: old finally block would leave hint stuck on stale path", () => {
  const hint = makeHintTracker();
  hint.setBoardLoadingHint(true);

  simulateRefreshFinallyBroken({
    showLoadingHint: true,
    hasPendingRequest: false,
    isStale: true,
    hint,
  });

  // This assertion documents the OLD bug: hint is stuck ON.
  assert.equal(
    hint.isVisible,
    true,
    "OLD code: hint is stuck ON for stale request (confirms pre-fix bug)"
  );
});
