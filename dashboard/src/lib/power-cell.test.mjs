import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  KIND_ESTIMATED, KIND_MEASURED, KIND_UNKNOWN, POWER_DOMAIN_LINES, REASONS, hubNowFrom, powerAgeLabel, powerCellState, powerClassify, powerDomainLines, powerKindFor, powerLineDisplay,
} from "./power-cell.mjs";
// The freshness policy is owned by ONE module. These tests import it from
// there, so a second declaration in power-cell.mjs would not go unnoticed.
import { POWER_FRESH_MS, POWER_FUTURE_SKEW_TOLERANCE_MS } from "./power-freshness.mjs";

const CURRENT_LOOKBACK_MS = POWER_FRESH_MS;
const FUTURE_SKEW_TOLERANCE_MS = POWER_FUTURE_SKEW_TOLERANCE_MS;

// The SAME corpus hub/fleet_power_corpus_test.go reads.
//
// The hub decides what may be totalled and this decides what may be drawn.
// Two matrices in two languages do not detect a divergence between those
// policies; they just both exist. One file does.
const CORPUS = JSON.parse(readFileSync(
  new URL("../../../proto/powerhistory/testdata/classification.json", import.meta.url), "utf8"));

test("the corpus actually loads", () => {
  // Without this, every case below would pass by iterating nothing.
  assert.ok(Array.isArray(CORPUS.cases) && CORPUS.cases.length >= 20,
    `the shared corpus has ${CORPUS.cases?.length} cases; it is not being read`);
  const kinds = new Set(CORPUS.cases.map((c) => c.kind));
  for (const kind of [KIND_MEASURED, KIND_ESTIMATED, KIND_UNKNOWN]) {
    assert.ok(kinds.has(kind), `the corpus contains no ${kind} case`);
  }
});

test("the dashboard classifies exactly as the hub does", () => {
  for (const c of CORPUS.cases) {
    const stats = { mean_watts: c.mean, peak_watts: c.peak, samples: c.samples };
    const got = powerKindFor(c.domain, c.source, stats);
    assert.equal(got, c.kind,
      `${c.name}: ${c.domain}/${c.source || "(unlabelled)"} classified as ${got}, ` +
      `corpus says ${c.kind}${c.why ? ` — ${c.why}` : ""}`);
  }
});

// --- cell state ------------------------------------------------------------

const NOW = 1_700_000_000_000;
const fresh = (over = {}) => ({
  watts: 118, kind: KIND_MEASURED, source: "ipmi-dcmi",
  window_end_unix_ms: NOW - 10_000, ...over,
});

test("a measured value renders as itself", () => {
  const cell = powerCellState(fresh(), NOW);
  assert.equal(cell.state, "value");
  assert.equal(cell.watts, 118);
  assert.equal(cell.prefix, "");
  assert.equal(cell.note, "");
});

test("a true measured zero is a value, not a dash", () => {
  const cell = powerCellState(fresh({ watts: 0 }), NOW);
  assert.equal(cell.state, "value");
  assert.equal(cell.watts, 0);
});

test("a modelled value is marked twice, and keeps the wire spelling", () => {
  const cell = powerCellState(fresh({ kind: KIND_ESTIMATED, source: "estimate-util" }), NOW);
  assert.equal(cell.state, "value");
  assert.equal(cell.prefix, "~");
  assert.equal(cell.note, "Modelled");
  // `estimated` is what the endpoint says; "Modelled" is rendering only.
  assert.equal(cell.kind, KIND_ESTIMATED);
});

test("a reason from the hub becomes a dash that explains itself", () => {
  for (const reason of ["absent", "clock_skew", "unreadable",
                        "source_unverified", "scope_unverified", "counter_idle_unverified"]) {
    const cell = powerCellState({ reason, source: "battery" }, NOW);
    assert.equal(cell.state, "unavailable", reason);
    assert.equal(cell.reason, reason);
    assert.ok(cell.detail && cell.detail.length > 0, `${reason} must carry a detail`);
  }
});

// The hub withholding a stale reading is the COMMON case. Dropping its
// timestamp along with its value would leave an operator looking at a dash
// with no idea how long it had been one.
test("a server-withheld stale reading keeps its age", () => {
  const cell = powerCellState(
    { reason: "stale", source: "rapl-psys", window_end_unix_ms: NOW - 10 * 60_000 }, NOW);
  assert.equal(cell.state, "stale");
  assert.equal(cell.reason, "stale");
  assert.equal(cell.ageMs, 10 * 60_000, "the age comes from the window the server did report");
  assert.equal(cell.watts, undefined, "and the value stays withheld");
});

// The same fail-open shape as the old "estimated if labelled, else measured"
// rule, which presented every unrecognised backend as a counter reading.
test("a number with no recognised kind is unavailable, never measured", () => {
  for (const kind of [undefined, null, "", "unknown", "modelled", "MEASURED", 1, {}]) {
    const cell = powerCellState(
      { watts: 118, kind, source: "rapl-psys", window_end_unix_ms: NOW }, NOW);
    assert.equal(cell.state, "unavailable", `kind=${JSON.stringify(kind)}`);
    assert.equal(cell.reason, "source_unverified");
    assert.equal(cell.watts, undefined);
  }
  // CONTROL: the two kinds the endpoint actually sends do render.
  for (const kind of [KIND_MEASURED, KIND_ESTIMATED]) {
    assert.equal(
      powerCellState({ watts: 118, kind, source: "rapl-psys", window_end_unix_ms: NOW }, NOW).state,
      "value", kind);
  }
  // And a real zero is still a value, so this is not a truthiness filter.
  assert.equal(
    powerCellState({ watts: 0, kind: KIND_MEASURED, source: "ipmi-dcmi", window_end_unix_ms: NOW }, NOW).watts,
    0);
});

test("a negative or non-finite wattage is not a reading", () => {
  for (const watts of [-1, -0.5, NaN, Infinity, "118", null, undefined]) {
    const cell = powerCellState(
      { watts, kind: KIND_MEASURED, source: "rapl-psys", window_end_unix_ms: NOW }, NOW);
    assert.equal(cell.state, "unavailable", `watts=${String(watts)}`);
  }
});

test("a malformed source is unknown, not a crash", () => {
  for (const source of [1, {}, [], true, Symbol("s")]) {
    assert.equal(powerClassify("system", source), KIND_UNKNOWN, String(source));
    assert.equal(powerClassify("cpu", source), KIND_UNKNOWN, String(source));
  }
  // A legitimately ABSENT label still takes the legacy CPU path.
  for (const source of [undefined, null, ""]) {
    assert.equal(powerClassify("cpu", source), KIND_MEASURED);
    assert.equal(powerClassify("system", source), KIND_UNKNOWN);
  }
});

// Freshness is re-evaluated on every render against a clock that ticks
// independently of the fetch. A value that was fresh when it arrived must not
// stay fresh forever in a tab that stopped polling.
test("a value goes stale as time passes, without the snapshot changing", () => {
  const snapshot = fresh({ window_end_unix_ms: NOW });
  assert.equal(powerCellState(snapshot, NOW).state, "value");
  assert.equal(powerCellState(snapshot, NOW + CURRENT_LOOKBACK_MS).state, "value",
    "exactly at the boundary is still current");

  const stale = powerCellState(snapshot, NOW + CURRENT_LOOKBACK_MS + 1);
  assert.equal(stale.state, "stale", "the same snapshot, later, is not current");
  assert.ok(stale.ageMs > CURRENT_LOOKBACK_MS);

  const later = powerCellState(snapshot, NOW + 10 * CURRENT_LOOKBACK_MS);
  assert.equal(later.state, "stale");
  assert.ok(later.ageMs > stale.ageMs, "the age keeps growing");
});

test("a window stamped ahead of us is skew, not a fresh reading", () => {
  const snapshot = fresh({ window_end_unix_ms: NOW + FUTURE_SKEW_TOLERANCE_MS + 1 });
  assert.equal(powerCellState(snapshot, NOW).reason, "clock_skew");
  // Within tolerance it is accepted: clocks are not perfectly aligned.
  assert.equal(powerCellState(fresh({ window_end_unix_ms: NOW + FUTURE_SKEW_TOLERANCE_MS }), NOW).state,
    "value");
});

test("nothing at all is unavailable, never zero", () => {
  for (const entry of [null, undefined, {}, { watts: null }, { watts: "118" }]) {
    const cell = powerCellState(entry, NOW);
    assert.equal(cell.state, "unavailable");
    assert.equal(cell.watts, undefined, "an unavailable cell carries no number");
  }
});

// --- the four lines --------------------------------------------------------

test("a machine shows four labelled domains, in a fixed order, never summed", () => {
  const machine = {
    machine_id: "m1",
    window_end_unix_ms: NOW - 5_000,
    domains: {
      system: { watts: 118, kind: KIND_MEASURED, source: "ipmi-dcmi" },
      cpu: { watts: 65, kind: KIND_MEASURED, source: "rapl-package" },
      gpu: { watts: 0, kind: KIND_MEASURED, source: "" },
      dram: { reason: "absent" },
    },
  };
  const lines = powerDomainLines(machine, NOW);
  assert.deepEqual(lines.map((l) => l.label), ["System", "CPU package", "GPU total", "DRAM"]);
  assert.deepEqual(lines.map((l) => l.state), ["value", "value", "value", "unavailable"]);
  // The GPU sits at a real zero and stays a value.
  assert.equal(lines[2].watts, 0);
  // No total is derived anywhere.
  assert.ok(!lines.some((l) => l.label.toLowerCase().includes("total ")), "no summed line");
});

test("the lines inherit the machine's window when a domain omits one", () => {
  const machine = {
    window_end_unix_ms: NOW - 10 * CURRENT_LOOKBACK_MS,
    domains: { system: { watts: 118, kind: KIND_MEASURED, source: "rapl-psys" } },
  };
  const [system] = powerDomainLines(machine, NOW);
  assert.equal(system.state, "stale", "an old window makes its domains stale too");
});

test("a domain the hub did not report is absent, not another domain's number", () => {
  const machine = {
    window_end_unix_ms: NOW,
    domains: { cpu: { watts: 65, kind: KIND_MEASURED, source: "rapl-package" } },
  };
  const lines = powerDomainLines(machine, NOW);
  const byDomain = Object.fromEntries(lines.map((l) => [l.domain, l]));
  assert.equal(byDomain.cpu.state, "value");
  for (const domain of ["system", "gpu", "dram"]) {
    assert.equal(byDomain[domain].state, "unavailable", domain);
    assert.equal(byDomain[domain].watts, undefined);
  }
});

test("a missing machine yields four dashes rather than nothing to render", () => {
  const lines = powerDomainLines(undefined, NOW);
  assert.equal(lines.length, POWER_DOMAIN_LINES.length);
  assert.ok(lines.every((l) => l.state === "unavailable"));
});

// --- the policy itself, beyond the corpus ----------------------------------

test("classification ignores the samples; powerKindFor is where they matter", () => {
  assert.equal(powerClassify("cpu", "rapl-package"), KIND_MEASURED);
  assert.equal(powerKindFor("cpu", "rapl-package",
    { mean_watts: 0, peak_watts: 0, samples: 30 }), KIND_UNKNOWN);
  // A window with no samples is not the frozen case; it has nothing to say.
  assert.equal(powerKindFor("cpu", "rapl-package",
    { mean_watts: 0, peak_watts: 0, samples: 0 }), KIND_MEASURED);
});

// --- whose clock ------------------------------------------------------------
//
// Freshness compares against the HUB's reference, never the browser's. A
// browser clock hours off would otherwise relabel hub-validated readings as
// agent clock skew, and a backward wall-clock adjustment would keep cached
// data looking current. Neither is a fact about the fleet.

test("the hub clock advances by monotonic elapsed time, not by the wall clock", () => {
  const baseline = { generatedUnixMs: NOW, requestStartedMonotonicMs: 5_000 };
  assert.equal(hubNowFrom(baseline, 5_000), NOW, "at receipt it is the hub's own stamp");
  assert.equal(hubNowFrom(baseline, 65_000), NOW + 60_000, "a minute later, a minute on");
});

test("a browser clock hours off does not turn hub-validated readings into skew", () => {
  // The browser believes it is three hours ahead. The hub said the snapshot
  // was generated at NOW, and the window ended ten seconds before that.
  const baseline = { generatedUnixMs: NOW, requestStartedMonotonicMs: 1_000 };
  const entry = fresh({ window_end_unix_ms: NOW - 10_000 });

  const wrongWallClock = NOW + 3 * 60 * 60 * 1000;
  assert.equal(powerCellState(entry, wrongWallClock).reason, "stale",
    "control: judged against the browser clock this reading looks ancient");

  assert.equal(powerCellState(entry, hubNowFrom(baseline, 1_000)).state, "value",
    "judged against the hub's reference it is exactly what it is");

  // And a browser three hours BEHIND must not make the window look future-dated.
  assert.equal(powerCellState(entry, NOW - 3 * 60 * 60 * 1000).reason, "clock_skew",
    "control: the backward case mislabels it as agent skew");
  assert.equal(powerCellState(entry, hubNowFrom(baseline, 1_000)).state, "value");
});

// The hub stamps generated_unix_ms early in its handler, so the clock is
// already running while the response is in flight. Anchoring at RECEIPT would
// discard that time and make a slow response look younger than it is.
test("a slow response does not buy extra freshness", () => {
  const requestStart = 1_000;
  const transitMs = 40_000;
  const baseline = { generatedUnixMs: NOW, requestStartedMonotonicMs: requestStart };
  const entry = fresh({ window_end_unix_ms: NOW });

  // Right after a 40s round trip, the hub's clock has already moved on 40s.
  assert.equal(hubNowFrom(baseline, requestStart + transitMs), NOW + transitMs);

  // CONTROL: anchoring at receipt instead would report the hub's clock as
  // unmoved, and the reading would stay "current" 40s longer than it is.
  const atReceipt = { generatedUnixMs: NOW, requestStartedMonotonicMs: requestStart + transitMs };
  assert.equal(hubNowFrom(atReceipt, requestStart + transitMs), NOW);

  // So the window goes stale 40s sooner under the correct anchor.
  const t = requestStart + transitMs + CURRENT_LOOKBACK_MS - transitMs + 1;
  assert.equal(powerCellState(entry, hubNowFrom(baseline, t)).state, "stale");
  assert.equal(powerCellState(entry, hubNowFrom(atReceipt, t)).state, "value",
    "control: the receipt anchor would still call it current");
});

test("a monotonic source that moved backwards yields no reference at all", () => {
  const baseline = { generatedUnixMs: NOW, requestStartedMonotonicMs: 10_000 };
  assert.equal(hubNowFrom(baseline, 9_999), null);
  assert.equal(powerCellState(fresh(), null).reason, "no_reference");
});

test("a response with no usable hub reference is unavailable, not assumed fresh", () => {
  for (const baseline of [null, {}, { generatedUnixMs: NOW }, { requestStartedMonotonicMs: 1 },
                          { generatedUnixMs: "now", requestStartedMonotonicMs: 1 }]) {
    assert.equal(hubNowFrom(baseline, 1_000), null, JSON.stringify(baseline));
  }
  // An old or malformed response therefore renders as unavailable per domain.
  const lines = powerDomainLines({
    window_end_unix_ms: NOW,
    domains: { system: { watts: 118, kind: KIND_MEASURED, source: "rapl-psys" } },
  }, hubNowFrom(null, 1_000));
  assert.ok(lines.every((l) => l.state === "unavailable"));
  assert.equal(lines[0].reason, "no_reference");
});

test("elapsed time ages a snapshot even though the fetch never repeats", () => {
  const baseline = { generatedUnixMs: NOW, requestStartedMonotonicMs: 0 };
  const entry = fresh({ window_end_unix_ms: NOW });
  assert.equal(powerCellState(entry, hubNowFrom(baseline, 0)).state, "value");
  assert.equal(powerCellState(entry, hubNowFrom(baseline, CURRENT_LOOKBACK_MS)).state, "value");
  const later = powerCellState(entry, hubNowFrom(baseline, CURRENT_LOOKBACK_MS + 1));
  assert.equal(later.state, "stale");
  assert.ok(later.ageMs > CURRENT_LOOKBACK_MS);
});

/* --- one line of a Power cell, ready to print ----------------------------- */

test("a cell line prints a number only when it has one, and says what it is", () => {
  const measured = powerLineDisplay({ state: "value", watts: 118.4, kind: "measured", source: "rapl-psys" });
  assert.equal(measured.value, "118 W");
  assert.equal(measured.note, "", "a measurement needs no qualifier");
  assert.match(measured.title, /Measured\. Backend: rapl-psys\./);

  // A model is marked in WORDS, not by a tilde alone and not by grey text.
  const modelled = powerLineDisplay({ state: "value", watts: 12, kind: "estimated", source: "estimate-util" });
  assert.equal(modelled.value, "~ 12 W");
  assert.equal(modelled.note, "Modelled");
  assert.match(modelled.title, /not measured/);

  // A real zero is a reading. Never a dash, never "no data".
  assert.equal(powerLineDisplay({ state: "value", watts: 0, kind: "measured", source: "ipmi-dcmi" }).value, "0 W");
});

test("a withheld reading keeps its age; every dash keeps its reason", () => {
  const stale = powerLineDisplay({ state: "stale", ageMs: 195000, reason: "stale", detail: "older than the freshness window" });
  assert.equal(stale.value, "—", "stale is not a number");
  assert.equal(stale.note, "3m old", "but it still says how long");
  assert.match(stale.title, /freshness window/);

  for (const [ms, expected] of [[0, "0s"], [59_000, "59s"], [60_000, "1m"], [3_600_000, "1h"],
                                [86_400_000, "1d"], [-1, ""], [NaN, ""]]) {
    assert.equal(powerAgeLabel(ms), expected, String(ms));
  }

  const unknown = powerLineDisplay({ state: "unavailable", reason: "scope_unverified",
    detail: REASONS.scope_unverified });
  assert.equal(unknown.value, "—");
  assert.equal(unknown.note, "", "an absence has no age to report");
  assert.equal(unknown.title, REASONS.scope_unverified);

  // Nothing at all is still a dash with an explanation, never a blank or a 0.
  for (const nothing of [undefined, null, 7, "value"]) {
    const line = powerLineDisplay(nothing);
    assert.equal(line.value, "—", JSON.stringify(nothing));
    assert.match(line.title, /\S/);
  }
});
