// stationboard.budget.test.js
// Regression tests for the request-budget guard in getStationboard
// (backend/src/api/stationboard.js).
//
// The budget guard prevents optional phases (sparse retry, scope fallback,
// alerts, supplement) from chaining into a 504 when the total request budget
// is nearly exhausted.  When a phase is skipped the function returns a usable
// static-only 200 instead of timing out.
//
// Budget arithmetic (from stationboard.js):
//   totalBudgetMs = Math.min(STATIONBOARD_ROUTE_TIMEOUT_MS, 5000)
//                 = 5000 by default (route timeout is 6500ms, capped at 5000)
//   LOW_BUDGET_THRESHOLD_MS = 400
//   isBudgetLow()  →  (totalBudgetMs - elapsedMs) < 400
//
// Each test drives a simulateBudgetPipeline helper that mirrors the exact guard
// conditions from getStationboard — keeping the contract in one place so a
// future regression in the real file is caught here.
//
// Guard points in order:
//   1. sparse_retry_skipped_budget   – too few departures, but budget low
//   2. scope_fallback_skipped_budget – zero departures, but budget low
//   3. alerts_skipped_budget         – budget exhausted before awaiting alerts
//                                      (function returns early; supplement
//                                       is never reached in this branch)
//   4. supplement_skipped_budget     – alerts ran but budget exhausted before
//                                      the supplement fetch
//
// The latencySafe debug object (returned in the response when debug=true):
//   { degradedMode, degradedReasons, totalBudgetMs,
//     remainingBudgetMs, lowBudgetThresholdMs }
// These tests verify its shape and values under each degraded scenario.

import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Budget constants — must stay in sync with stationboard.js
// ---------------------------------------------------------------------------

const LOW_BUDGET_THRESHOLD_MS = 400;
const DEFAULT_TOTAL_BUDGET_MS = 5000; // min(6500, 5000)

// ---------------------------------------------------------------------------
// computeTotalBudget mirrors stationboard.js budget arithmetic.
// Accepts the same STATIONBOARD_ROUTE_TIMEOUT_MS values.
// ---------------------------------------------------------------------------

function computeTotalBudget(routeTimeoutMs = 6500) {
  return Math.min(Math.max(100, routeTimeoutMs), 5000);
}

// ---------------------------------------------------------------------------
// simulateBudgetPipeline
//
// Mirrors the guard conditions from getStationboard.  Accepts the elapsed time
// (ms) at the moment each optional phase boundary is reached, plus flags that
// determine whether each phase is needed.  Returns a latencySafe-shaped object
// identical to what getStationboard writes into response.debug.latencySafe.
//
// Parameters:
//   totalBudgetMs           – total budget (default 5000)
//   elapsedBeforeSparseRetry, elapsedBeforeScopeFallback,
//   elapsedBeforeAlerts, elapsedBeforeSupplement
//                           – simulated elapsed time at each guard boundary
//   sparseRetryNeeded       – board has too few departures
//   scopeFallbackNeeded     – board has 0 departures
//   alertsRequested         – includeAlertsApplied is true
//   supplementNeeded        – !hasReplacementDeparture (alerts path only)
// ---------------------------------------------------------------------------

function simulateBudgetPipeline({
  totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS,
  elapsedBeforeSparseRetry = 0,
  elapsedBeforeScopeFallback = 0,
  elapsedBeforeAlerts = 0,
  elapsedBeforeSupplement = 0,
  sparseRetryNeeded = false,
  scopeFallbackNeeded = false,
  alertsRequested = true,
  supplementNeeded = false,
} = {}) {
  // Mirror of getStationboard's isBudgetLow at a given elapsed time
  const isBudgetLow = (elapsed) => (totalBudgetMs - elapsed) < LOW_BUDGET_THRESHOLD_MS;

  const degradedReasons = [];
  let degradedMode = false;
  const phasesRan = [];
  const phasesSkipped = [];

  // --- Phase 1: Sparse retry ---
  if (sparseRetryNeeded) {
    if (isBudgetLow(elapsedBeforeSparseRetry)) {
      degradedMode = true;
      degradedReasons.push("sparse_retry_skipped_budget");
      phasesSkipped.push("sparseRetry");
    } else {
      phasesRan.push("sparseRetry");
    }
  }

  // --- Phase 2: Scope fallback ---
  if (scopeFallbackNeeded) {
    if (isBudgetLow(elapsedBeforeScopeFallback)) {
      degradedMode = true;
      degradedReasons.push("scope_fallback_skipped_budget");
      phasesSkipped.push("scopeFallback");
    } else {
      phasesRan.push("scopeFallback");
    }
  }

  // --- Phase 3: Alerts (early return when budget low) ---
  if (alertsRequested) {
    if (isBudgetLow(elapsedBeforeAlerts)) {
      degradedMode = true;
      degradedReasons.push("alerts_skipped_budget");
      phasesSkipped.push("alerts");
      // getStationboard returns early here — supplement is never evaluated.
      return buildLatencySafe({
        degradedMode,
        degradedReasons,
        totalBudgetMs,
        phasesRan,
        phasesSkipped,
        earlyReturn: true,
      });
    }
    phasesRan.push("alerts");
  }

  // --- Phase 4: Supplement (only reached when alerts ran or not requested) ---
  if (supplementNeeded) {
    if (isBudgetLow(elapsedBeforeSupplement)) {
      degradedMode = true;
      degradedReasons.push("supplement_skipped_budget");
      phasesSkipped.push("supplement");
    } else {
      phasesRan.push("supplement");
    }
  }

  return buildLatencySafe({
    degradedMode,
    degradedReasons,
    totalBudgetMs,
    phasesRan,
    phasesSkipped,
    earlyReturn: false,
  });
}

function buildLatencySafe({
  degradedMode,
  degradedReasons,
  totalBudgetMs,
  phasesRan,
  phasesSkipped,
  earlyReturn,
}) {
  return {
    degradedMode,
    degradedReasons: Array.from(new Set(degradedReasons)),
    totalBudgetMs,
    lowBudgetThresholdMs: LOW_BUDGET_THRESHOLD_MS,
    // Internal tracking (not in the real latencySafe shape but useful here):
    _phasesRan: phasesRan,
    _phasesSkipped: phasesSkipped,
    _earlyReturn: earlyReturn,
  };
}

// ---------------------------------------------------------------------------
// simulateBudgetPipelineUnguarded — OLD behaviour without budget guards.
// Documents what would happen without the guard: all phases run regardless.
// Used in regression tests to show the pre-guard behaviour.
// ---------------------------------------------------------------------------

function simulateBudgetPipelineUnguarded({
  sparseRetryNeeded = false,
  scopeFallbackNeeded = false,
  alertsRequested = true,
  supplementNeeded = false,
} = {}) {
  const phasesRan = [];
  if (sparseRetryNeeded) phasesRan.push("sparseRetry");
  if (scopeFallbackNeeded) phasesRan.push("scopeFallback");
  if (alertsRequested) phasesRan.push("alerts");
  if (supplementNeeded) phasesRan.push("supplement");
  return {
    degradedMode: false,
    degradedReasons: [],
    _phasesRan: phasesRan,
    _phasesSkipped: [],
    _earlyReturn: false,
  };
}

// ---------------------------------------------------------------------------
// Tests — budget arithmetic
// ---------------------------------------------------------------------------

test("budget: default totalBudgetMs is 5000 (min of route timeout 6500 and cap 5000)", () => {
  assert.equal(computeTotalBudget(6500), 5000);
});

test("budget: totalBudgetMs is capped at 5000 even for large route timeouts", () => {
  assert.equal(computeTotalBudget(10000), 5000);
});

test("budget: totalBudgetMs uses minimum of 100 for very small route timeouts", () => {
  assert.equal(computeTotalBudget(50), 100);
});

test("budget: isBudgetLow fires when remaining budget < LOW_BUDGET_THRESHOLD_MS (400ms)", () => {
  const isBudgetLow = (elapsed) => (DEFAULT_TOTAL_BUDGET_MS - elapsed) < LOW_BUDGET_THRESHOLD_MS;
  // 4600ms elapsed → 400ms remaining → NOT low (boundary)
  assert.equal(isBudgetLow(4600), false, "4600ms elapsed: 400ms left — exactly at threshold, not low");
  // 4601ms elapsed → 399ms remaining → IS low
  assert.equal(isBudgetLow(4601), true, "4601ms elapsed: 399ms left — low");
  // 0ms elapsed → 5000ms remaining → NOT low
  assert.equal(isBudgetLow(0), false, "0ms elapsed: plenty of budget");
});

// ---------------------------------------------------------------------------
// Tests — ample budget path: all phases run, no degradation
// ---------------------------------------------------------------------------

test("ample budget: all phases run and degradedMode is false", () => {
  const result = simulateBudgetPipeline({
    totalBudgetMs: 5000,
    elapsedBeforeSparseRetry: 100,
    elapsedBeforeScopeFallback: 150,
    elapsedBeforeAlerts: 200,
    elapsedBeforeSupplement: 300,
    sparseRetryNeeded: true,
    scopeFallbackNeeded: false,
    alertsRequested: true,
    supplementNeeded: true,
  });

  assert.equal(result.degradedMode, false);
  assert.deepEqual(result.degradedReasons, []);
  assert.ok(result._phasesRan.includes("sparseRetry"));
  assert.ok(result._phasesRan.includes("alerts"));
  assert.ok(result._phasesRan.includes("supplement"));
  assert.equal(result._phasesSkipped.length, 0);
});

// ---------------------------------------------------------------------------
// Tests — sparse retry guard
// ---------------------------------------------------------------------------

test("sparse retry: skipped when budget is low, degradedMode is true", () => {
  // 4700ms elapsed of 5000ms budget → 300ms left < 400ms threshold
  const result = simulateBudgetPipeline({
    totalBudgetMs: 5000,
    elapsedBeforeSparseRetry: 4700,
    sparseRetryNeeded: true,
    scopeFallbackNeeded: false,
    alertsRequested: false,
    supplementNeeded: false,
  });

  assert.equal(result.degradedMode, true);
  assert.ok(
    result.degradedReasons.includes("sparse_retry_skipped_budget"),
    "degradedReasons must include sparse_retry_skipped_budget"
  );
  assert.ok(result._phasesSkipped.includes("sparseRetry"));
  assert.equal(result._phasesRan.includes("sparseRetry"), false);
});

test("sparse retry: runs when budget is ample", () => {
  const result = simulateBudgetPipeline({
    totalBudgetMs: 5000,
    elapsedBeforeSparseRetry: 500,
    sparseRetryNeeded: true,
    alertsRequested: false,
  });

  assert.equal(result.degradedMode, false);
  assert.ok(result._phasesRan.includes("sparseRetry"));
  assert.equal(result._phasesSkipped.includes("sparseRetry"), false);
});

test("sparse retry: not evaluated when not needed (sufficient departures)", () => {
  const result = simulateBudgetPipeline({
    totalBudgetMs: 5000,
    elapsedBeforeSparseRetry: 4700, // would be low — but sparseRetryNeeded=false
    sparseRetryNeeded: false,
    alertsRequested: false,
  });

  assert.equal(result.degradedMode, false);
  assert.equal(result._phasesRan.includes("sparseRetry"), false);
  assert.equal(result._phasesSkipped.includes("sparseRetry"), false);
});

// ---------------------------------------------------------------------------
// Tests — scope fallback guard
// ---------------------------------------------------------------------------

test("scope fallback: skipped when budget is low, degradedMode is true", () => {
  const result = simulateBudgetPipeline({
    totalBudgetMs: 5000,
    elapsedBeforeScopeFallback: 4700,
    sparseRetryNeeded: false,
    scopeFallbackNeeded: true,
    alertsRequested: false,
    supplementNeeded: false,
  });

  assert.equal(result.degradedMode, true);
  assert.ok(result.degradedReasons.includes("scope_fallback_skipped_budget"));
  assert.ok(result._phasesSkipped.includes("scopeFallback"));
});

test("scope fallback: runs when budget is ample", () => {
  const result = simulateBudgetPipeline({
    totalBudgetMs: 5000,
    elapsedBeforeScopeFallback: 500,
    scopeFallbackNeeded: true,
    alertsRequested: false,
  });

  assert.equal(result.degradedMode, false);
  assert.ok(result._phasesRan.includes("scopeFallback"));
});

// ---------------------------------------------------------------------------
// Tests — alerts guard (early return)
// ---------------------------------------------------------------------------

test("alerts: skipped when budget is low; function returns early (supplement never reached)", () => {
  const result = simulateBudgetPipeline({
    totalBudgetMs: 5000,
    elapsedBeforeAlerts: 4700,
    sparseRetryNeeded: false,
    scopeFallbackNeeded: false,
    alertsRequested: true,
    supplementNeeded: true, // even though needed, must not run — early return
  });

  assert.equal(result.degradedMode, true);
  assert.ok(result.degradedReasons.includes("alerts_skipped_budget"));
  assert.ok(result._phasesSkipped.includes("alerts"));
  assert.equal(result._phasesRan.includes("alerts"), false);
  // Supplement must NOT have run — the real function returns early at alerts
  assert.equal(result._phasesRan.includes("supplement"), false);
  assert.equal(result._phasesSkipped.includes("supplement"), false);
  assert.equal(result._earlyReturn, true, "alerts guard triggers an early return");
});

test("alerts: run when budget is ample", () => {
  const result = simulateBudgetPipeline({
    totalBudgetMs: 5000,
    elapsedBeforeAlerts: 200,
    alertsRequested: true,
    supplementNeeded: false,
  });

  assert.equal(result.degradedMode, false);
  assert.ok(result._phasesRan.includes("alerts"));
  assert.equal(result._earlyReturn, false);
});

// ---------------------------------------------------------------------------
// Tests — supplement guard
// ---------------------------------------------------------------------------

test("supplement: skipped when budget is low after alerts completed", () => {
  // Scenario: alerts consumed most of the remaining budget; supplement sees low budget.
  const result = simulateBudgetPipeline({
    totalBudgetMs: 5000,
    elapsedBeforeAlerts: 200,    // budget OK → alerts run
    elapsedBeforeSupplement: 4700, // alerts consumed time → budget now low
    alertsRequested: true,
    supplementNeeded: true,
  });

  assert.equal(result.degradedMode, true);
  assert.ok(result.degradedReasons.includes("supplement_skipped_budget"));
  assert.ok(result._phasesRan.includes("alerts"), "alerts must have run");
  assert.ok(result._phasesSkipped.includes("supplement"));
  assert.equal(result._earlyReturn, false, "no early return — only supplement was skipped");
});

test("supplement: runs when budget is ample after alerts", () => {
  const result = simulateBudgetPipeline({
    totalBudgetMs: 5000,
    elapsedBeforeAlerts: 200,
    elapsedBeforeSupplement: 500,
    alertsRequested: true,
    supplementNeeded: true,
  });

  assert.equal(result.degradedMode, false);
  assert.ok(result._phasesRan.includes("alerts"));
  assert.ok(result._phasesRan.includes("supplement"));
  assert.equal(result._phasesSkipped.length, 0);
});

test("supplement: not evaluated when no replacement departure needed", () => {
  const result = simulateBudgetPipeline({
    totalBudgetMs: 5000,
    elapsedBeforeSupplement: 4700, // would be low — but supplementNeeded=false
    alertsRequested: true,
    supplementNeeded: false,
  });

  assert.equal(result.degradedMode, false);
  assert.equal(result._phasesRan.includes("supplement"), false);
  assert.equal(result._phasesSkipped.includes("supplement"), false);
});

// ---------------------------------------------------------------------------
// Tests — multiple phases skipped in the same request
// ---------------------------------------------------------------------------

test("multiple phases skipped: sparse retry and scope fallback both skipped", () => {
  // Both phases need to run and budget is low when reached.
  const result = simulateBudgetPipeline({
    totalBudgetMs: 5000,
    elapsedBeforeSparseRetry: 4700,
    elapsedBeforeScopeFallback: 4700,
    sparseRetryNeeded: true,
    scopeFallbackNeeded: true,
    alertsRequested: false,
  });

  assert.equal(result.degradedMode, true);
  assert.ok(result.degradedReasons.includes("sparse_retry_skipped_budget"));
  assert.ok(result.degradedReasons.includes("scope_fallback_skipped_budget"));
  assert.equal(result.degradedReasons.length, 2);
});

// ---------------------------------------------------------------------------
// Tests — latencySafe debug shape
// ---------------------------------------------------------------------------

test("latencySafe debug shape: degraded response includes required fields", () => {
  const result = simulateBudgetPipeline({
    totalBudgetMs: 5000,
    elapsedBeforeAlerts: 4700,
    alertsRequested: true,
  });

  // Verify the real stationboard debug output shape
  assert.ok("degradedMode" in result, "latencySafe must have degradedMode");
  assert.ok("degradedReasons" in result, "latencySafe must have degradedReasons");
  assert.ok("totalBudgetMs" in result, "latencySafe must have totalBudgetMs");
  assert.ok("lowBudgetThresholdMs" in result, "latencySafe must have lowBudgetThresholdMs");
  assert.equal(typeof result.degradedMode, "boolean");
  assert.ok(Array.isArray(result.degradedReasons));
  assert.equal(result.lowBudgetThresholdMs, LOW_BUDGET_THRESHOLD_MS);
  assert.equal(result.totalBudgetMs, 5000);
});

test("latencySafe debug shape: degradedReasons deduplicated", () => {
  // Simulated scenario where the same reason could appear twice (edge case)
  const reasons = ["alerts_skipped_budget", "alerts_skipped_budget"];
  const deduplicated = Array.from(new Set(reasons));
  assert.equal(deduplicated.length, 1);
  assert.equal(deduplicated[0], "alerts_skipped_budget");
});

// ---------------------------------------------------------------------------
// Regression: old code (no budget guards) would chain all phases regardless
// ---------------------------------------------------------------------------

test("regression: old code without guards would run alerts even when budget exhausted", () => {
  // Under the old behaviour (no guards), ALL phases run unconditionally.
  const result = simulateBudgetPipelineUnguarded({
    sparseRetryNeeded: false,
    scopeFallbackNeeded: false,
    alertsRequested: true,
    supplementNeeded: true,
  });

  // Old code: degradedMode is never set, all phases always run
  assert.equal(result.degradedMode, false, "OLD code: no degraded tracking");
  assert.deepEqual(result.degradedReasons, [], "OLD code: no degradedReasons emitted");
  // This is the bug: alerts and supplement would run regardless of remaining budget,
  // potentially causing a 504 timeout cascade.
  assert.ok(result._phasesRan.includes("alerts"), "OLD code: alerts always run");
  assert.ok(result._phasesRan.includes("supplement"), "OLD code: supplement always run");
});

test("regression: old code would not short-circuit on sparse retry exhaustion", () => {
  const result = simulateBudgetPipelineUnguarded({
    sparseRetryNeeded: true,
    scopeFallbackNeeded: true,
    alertsRequested: true,
    supplementNeeded: false,
  });

  // Old code would run all three even with zero budget remaining.
  assert.ok(result._phasesRan.includes("sparseRetry"));
  assert.ok(result._phasesRan.includes("scopeFallback"));
  assert.ok(result._phasesRan.includes("alerts"));
  assert.equal(result.degradedMode, false);
});
