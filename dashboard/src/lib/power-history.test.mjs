import test from "node:test";
import assert from "node:assert/strict";
import { mergePowerHistory, powerChartPoints, powerReading, powerProblemLabel, powerRailStats, powerSensorIDs, sampleAgeLabel, validPowerStats } from "./power-history.mjs";

const stats = (mean = 100, peak = 200, samples = 30) => ({ mean_watts: mean, peak_watts: peak, samples });

test("rejected telemetry has a useful bounded diagnostic, not raw server errors", () => {
  assert.match(powerProblemLabel("clock_skew"), /Correct its clock/);
  assert.match(powerProblemLabel("storage_error"), /will retry/);
  assert.equal(powerProblemLabel("raw sensitive error"), null);
  assert.equal(powerProblemLabel("__proto__"), null);
});
const bucket = (seq, extra = {}) => ({ stream_id: "a", seq, start_unix_ms: seq * 30000,
  end_unix_ms: (seq + 1) * 30000, expected_samples: 30,
  gpus: [{ id: "GPU-a", ...stats() }, { id: "GPU-b", ...stats() }], ...extra });

test("never fabricate GPU totals by summing independent peaks", () => {
  assert.equal(powerChartPoints([bucket(1)], "gpu_total")[0].peak, null);
  assert.equal(powerChartPoints([bucket(1, { gpu_total: stats(180, 250) })], "gpu_total")[0].peak, 250);
});
test("unknown is not zero, and a real zero remains visible", () => {
  // A GPU parked at 0 W is a measurement and must be drawn.
  const points = [
    bucket(1, { gpu_total: stats(null, null, 0) }),
    bucket(2, { gpu_total: stats(0, 0) }),
  ];
  assert.deepEqual(powerChartPoints(points, "gpu_total").map((p) => p.mean), [null, 0]);
});

// An all-zero RAPL window cannot show that the counters progressed, so it is
// not drawn as a measurement of zero. The hub excludes it from totals; this is
// the same policy on the machine's own chart, which previously read
// `point.cpu` straight out of the payload and never looked at `sources`.
test("an all-zero RAPL window is not drawn as zero watts", () => {
  const labelled = (source) => [{ domain: "cpu", source }];
  const legacy = bucket(1, { cpu: stats(0, 0) });                       // unlabelled = legacy RAPL
  const rapl = bucket(2, { cpu: stats(0, 0), sources: labelled("rapl-package") });
  for (const point of [legacy, rapl]) {
    assert.equal(powerChartPoints([point], "cpu")[0].mean, null, JSON.stringify(point.sources));
  }
  // CONTROL: the counter moved, so however small the mean, it is a reading.
  const moved = bucket(3, { cpu: stats(0, 0.4), sources: labelled("rapl-package") });
  assert.equal(powerChartPoints([moved], "cpu")[0].mean, 0);
});

// The gate the tab was missing entirely.
test("a mislabelled or unlabelled scalar domain is not drawn", () => {
  const cases = [
    // A package sum wearing a whole-machine label.
    { sensor: "system", point: bucket(1, { system: stats(100, 120), sources: [{ domain: "system", source: "rapl-package" }] }) },
    // System and DRAM never shipped unlabelled.
    { sensor: "system", point: bucket(1, { system: stats(100, 120) }) },
    { sensor: "dram", point: bucket(1, { dram: stats(12, 14) }) },
    // A shunt names its chip, never its rail.
    { sensor: "system", point: bucket(1, { system: stats(31, 34), sources: [{ domain: "system", source: "hwmon:ina226" }] }) },
  ];
  for (const { sensor, point } of cases) {
    assert.equal(powerChartPoints([point], sensor)[0].mean, null, sensor);
  }
  // CONTROL: correctly labelled, the same readings draw.
  const ok = bucket(1, { system: stats(100, 120), sources: [{ domain: "system", source: "ipmi-dcmi" }] });
  assert.equal(powerChartPoints([ok], "system")[0].mean, 100);
});

// A change of backend is a change of measurement method. A line drawn across
// one implies a continuity that does not exist.
test("the line breaks where the measurement method changes", () => {
  const psys = bucket(1, { system: stats(100, 120), sources: [{ domain: "system", source: "rapl-psys" }] });
  const dcmi = bucket(2, { system: stats(105, 125), sources: [{ domain: "system", source: "ipmi-dcmi" }] });
  const chart = powerChartPoints([psys, dcmi], "system");
  assert.equal(chart.length, 3, "a break is inserted between the two methods");
  assert.equal(chart[1].mean, null);
  assert.equal(chart[0].source, "rapl-psys");
  assert.equal(chart[2].source, "ipmi-dcmi");

  // CONTROL: the same backend throughout draws one continuous line.
  const same = powerChartPoints([psys, bucket(2, { system: stats(105, 125), sources: [{ domain: "system", source: "rapl-psys" }] })], "system");
  assert.equal(same.length, 2);
});
// Absence and invalidity are different answers, and the adapter must not
// collapse them: an ABSENT label is the legacy-CPU exemption, so coercing a
// malformed one to "" hands it that exemption and draws it as a measurement.
// Tested THROUGH powerReading and its consumers, because that coercion sat in
// the adapter and powerClassify alone would have looked correct.
test("a malformed provenance label never inherits the legacy exemption", () => {
  const cpu = { mean_watts: 42, peak_watts: 43, samples: 30 };
  const malformed = [
    { domain: "cpu", source: {} },
    { domain: "cpu", source: 7 },
    { domain: "cpu", source: [] },
    { domain: "cpu", source: true },
  ];
  for (const entry of malformed) {
    const point = bucket(1, { cpu, sources: [entry] });
    assert.equal(powerReading(point, "cpu").kind, "unknown", JSON.stringify(entry));
    assert.equal(powerChartPoints([point], "cpu")[0].mean, null, "and it is not drawn");
    assert.equal(powerRailStats([point], "cpu").windows, 0, "nor summarised");
    assert.equal(powerRailStats([point], "cpu").excluded, 1, "and the omission is counted");
  }

  // A malformed CONTAINER is malformed provenance too, and must not crash.
  for (const sources of ["nope", 7, {}, true]) {
    const point = bucket(1, { cpu, sources });
    assert.equal(powerReading(point, "cpu").kind, "unknown", JSON.stringify(sources));
    assert.equal(powerChartPoints([point], "cpu")[0].mean, null);
  }

  // CONTROL: a genuinely ABSENT label is the pre-labelling agent, and still
  // draws. This is the case the coercion was mistaking everything for.
  for (const point of [bucket(1, { cpu }), bucket(1, { cpu, sources: [] }),
                       bucket(1, { cpu, sources: [{ domain: "system", source: "rapl-psys" }] })]) {
    assert.equal(powerReading(point, "cpu").kind, "measured");
    assert.equal(powerChartPoints([point], "cpu")[0].mean, 42);
  }

  // And an absent label on a domain that never shipped unlabelled stays out.
  assert.equal(powerReading(bucket(1, { system: cpu }), "system").kind, "unknown");
});

test("gaps break lines for missing sequences, restarts and declared loss", () => {
  for (const next of [bucket(3), bucket(2, { stream_id: "b" }), bucket(2, { gap_before: true })]) {
    const chart = powerChartPoints([next, bucket(1)], "GPU-a");
    assert.equal(chart.length, 3);
    assert.equal(chart[1].mean, null);
  }
});
test("partial sampling reports coverage, not invented full-window data", () => {
  assert.equal(powerChartPoints([bucket(1, { cpu: stats(100, 150, 15) })], "cpu")[0].coverage, 50);
});
test("invalid values are unavailable; sensor IDs are stable and unique", () => {
  assert.equal(powerChartPoints([bucket(1, { cpu: stats(Infinity, 2) })], "cpu")[0].mean, null);
  assert.deepEqual(powerSensorIDs([bucket(1), bucket(2)]), ["GPU-a", "GPU-b"]);
});
test("sample age exposes stale and clock-skewed data", () => {
  assert.equal(sampleAgeLabel(10000, 45000), "35s ago");
  assert.equal(sampleAgeLabel(10000, 135000), "2m ago");
  assert.equal(sampleAgeLabel(50000, 10000), "Machine clock ahead");
  assert.equal(sampleAgeLabel(undefined, 10000), "No samples");
});

test("delta history merges late backfill, deduplicates and refreshes gap metadata", () => {
  const initial = { points: [bucket(5)], gaps: [], degraded: true, cursor: 1 };
  const delta = { points: [bucket(2), bucket(5)], gaps: [{ stream_id: "a", from: 3, through: 4 }], degraded: false, cursor: 3 };
  const result = mergePowerHistory(initial, delta, 200000);
  assert.deepEqual(result.points.map((point) => point.seq).sort(), [2, 5]);
  assert.deepEqual(result.gaps, delta.gaps);
  assert.equal(result.degraded, false);
  assert.equal(result.cursor, 3);
});

test("empty deltas still expire local history; cursor reset requires full reload", () => {
  const initial = { points: [bucket(1)], gaps: [], degraded: false, cursor: 3 };
  const delta = { points: [], gaps: [], degraded: false, cursor: 3 };
  assert.equal(mergePowerHistory(initial, delta, 86400000 + 60001).points.length, 0);
  assert.throws(() => mergePowerHistory(initial, { ...delta, cursor: 1 }, 0), RangeError);
  assert.throws(() => mergePowerHistory(undefined, { ...delta, cursor: NaN }, 0));
});

/* --- the numbers beside the chart ---------------------------------------- */

test("the rail average weights each window by the samples behind it", () => {
  // 30 samples at 100 W and 10 at 200 W is 125 W of measured draw, not 150:
  // the half-empty window did not happen for as long as the full one.
  const points = [
    bucket(1, { cpu: stats(100, 150, 30) }),
    bucket(2, { cpu: stats(200, 260, 10) }),
  ];
  const rail = powerRailStats(points, "cpu");
  assert.equal(rail.average, 125);
  assert.equal(rail.windows, 2);
  assert.equal(rail.samples, 40);
});

test("the rail peak is the highest sample seen, never a sum across sensors", () => {
  const points = [bucket(1), bucket(2)]; // two GPUs, 200 W peak each
  assert.equal(powerRailStats(points, "GPU-a").peak, 200);
  // gpu_total is only what the hub reported for the combined sensor; absent
  // means absent, not 400.
  assert.equal(powerRailStats(points, "gpu_total").peak, null);
  assert.equal(powerRailStats(points, "gpu_total").average, null);
});

test("an unreadable window is skipped rather than counted as zero", () => {
  const points = [
    bucket(1, { cpu: stats(100, 150, 30) }),
    bucket(2, { cpu: stats(100, 150, 0) }),      // no samples
    bucket(3, { cpu: stats(100, 50, 30) }),      // peak below mean: corrupt
    bucket(4, { cpu: stats(Infinity, 200, 30) }),
  ];
  const rail = powerRailStats(points, "cpu");
  assert.equal(rail.windows, 1, "only the readable window counts");
  assert.equal(rail.average, 100);
  assert.equal(rail.peak, 150);
});

test("no readings at all is unavailable, not zero watts", () => {
  for (const points of [[], [bucket(1)]]) {
    const rail = powerRailStats(points, "cpu");
    assert.equal(rail.average, null);
    assert.equal(rail.peak, null);
    assert.equal(rail.windows, 0);
    assert.equal(rail.modelled.average, null);
  }
});

test("a real zero reading is still a reading", () => {
  const rail = powerRailStats([bucket(1, { gpu_total: stats(0, 0, 30) })], "gpu_total");
  assert.equal(rail.average, 0);
  assert.equal(rail.peak, 0);
  assert.equal(rail.windows, 1);
});

// Averaging a counter reading together with a model produces a figure neither
// of them made.
test("measured and modelled are summarised separately, never blended", () => {
  const measured = bucket(1, { system: stats(100, 100, 30), sources: [{ domain: "system", source: "ipmi-dcmi" }] });
  const modelled = bucket(2, { system: stats(20, 20, 30), sources: [{ domain: "system", source: "estimate-util" }] });
  const rail = powerRailStats([measured, modelled], "system");

  assert.equal(rail.measured.average, 100, "the measured average is only measurements");
  assert.equal(rail.measured.windows, 1);
  assert.equal(rail.modelled.average, 20, "and the model keeps its own");
  assert.equal(rail.modelled.windows, 1);
  assert.deepEqual(rail.measured.sources, ["ipmi-dcmi"]);
  assert.deepEqual(rail.modelled.sources, ["estimate-util"]);
  // The top-level figures stay a measurement, not a blend of 100 and 20.
  assert.equal(rail.average, 100);
});

test("windows the policy declined are counted, not silently dropped", () => {
  const excluded = bucket(1, { system: stats(23, 26, 30), sources: [{ domain: "system", source: "battery" }] });
  const rail = powerRailStats([excluded], "system");
  assert.equal(rail.windows, 0);
  assert.equal(rail.excluded, 1, "the omission is visible");
});

test("the chart and the rail agree on what a readable window is", () => {
  for (const s of [stats(100, 150, 30), stats(0, 0, 1)]) assert.equal(validPowerStats(s), true);
  for (const s of [undefined, null, stats(100, 50, 30), stats(100, 150, 0),
    stats(Infinity, 200, 30), stats(-1, 200, 30), { ...stats(), samples: 1.5 }]) {
    assert.equal(validPowerStats(s), false);
  }
});
