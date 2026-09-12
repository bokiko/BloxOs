import {
  KIND_MEASURED, KIND_ESTIMATED, KIND_UNKNOWN,
  DOMAIN_SYSTEM, DOMAIN_CPU, DOMAIN_DRAM, DOMAIN_GPU,
  powerKindFor,
} from "./power-cell.mjs";
import { POWER_FUTURE_SKEW_TOLERANCE_MS } from "./power-freshness.mjs";

/**
 * Which domain a sensor selection belongs to.
 *
 * Everything that is not one of the named scalars is a GPU device id, which
 * lives in the GPU domain and carries no scalar source label by construction.
 */
export function powerSensorDomain(sensor) {
  switch (sensor) {
    case "gpu_total": return DOMAIN_GPU;
    case "cpu": return DOMAIN_CPU;
    case "system": return DOMAIN_SYSTEM;
    case "dram": return DOMAIN_DRAM;
    default: return DOMAIN_GPU;
  }
}

/**
 * The backend label this point recorded for a domain, exactly as it arrived.
 *
 * The RAW value, deliberately. Coercing a malformed label to "" would hand it
 * to the classifier as an ABSENT one, and absent is the legacy-CPU exemption —
 * so `{"source": {}}` on a cpu domain would have been read as a pre-labelling
 * agent and drawn as a measurement. Absence and invalidity are different
 * answers and only the classifier gets to tell them apart.
 *
 * `undefined` means the point carries no entry for this domain at all.
 */
export function powerSourceOf(point, domain) {
  const sources = point?.sources;
  if (!Array.isArray(sources)) return undefined;
  const entry = sources.find((s) => s && typeof s === "object" && s.domain === domain);
  return entry === undefined ? undefined : entry.source;
}

/** The same label, safe to put on screen. Never used for classification. */
export function powerSourceLabel(source) {
  return typeof source === "string" ? source : "";
}

// Keep unavailable readings null. Never reinterpret legacy instantaneous watts
// as a 30-second mean, or sum independent GPU peaks into a machine peak.
export function powerStats(point, sensor) {
  if (sensor === "gpu_total") return point.gpu_total;
  if (sensor === "cpu") return point.cpu;
  if (sensor === "system") return point.system;
  if (sensor === "dram") return point.dram;
  return point.gpus?.find((gpu) => gpu.id === sensor);
}

/**
 * One point's reading for a sensor, with its provenance decided.
 *
 * This is the gate the machine Power tab was missing. It read `point.cpu`
 * straight out of the payload and never looked at `sources`, so an unlabelled
 * System reading, a package sum labelled as whole-machine power, or a RAPL
 * window whose counters never progressed all drew exactly like a measurement.
 * The hub's exclusions protect the fleet endpoints; they did not reach here.
 *
 * The raw API rows are untouched — this selects what may be DRAWN, it does not
 * filter the payload.
 */
export function powerReading(point, sensor) {
  const stats = powerStats(point, sensor);
  if (!validPowerStats(stats)) return { stats: null, source: "", kind: KIND_UNKNOWN };
  const domain = powerSensorDomain(sensor);
  // A `sources` container that is PRESENT but not an array is malformed
  // provenance. An agent that never sent one omits the field entirely, and
  // only that is absence — the difference decides whether the legacy CPU
  // exemption applies.
  const sources = point?.sources;
  if (sources !== undefined && sources !== null && !Array.isArray(sources)) {
    return { stats, source: "", kind: KIND_UNKNOWN };
  }
  // Classification sees the RAW label; only the display string is coerced.
  const raw = powerSourceOf(point, domain);
  return { stats, source: powerSourceLabel(raw), kind: powerKindFor(domain, raw, stats) };
}

// A window is readable only when the agent actually sampled it and the numbers
// are self-consistent. A peak below its own mean is a corrupt record, not a low
// reading, so it is dropped rather than drawn or averaged.
export function validPowerStats(stats) {
  return Boolean(stats) && Number.isInteger(stats.samples) && stats.samples > 0 &&
    Number.isFinite(stats.mean_watts) && stats.mean_watts >= 0 &&
    Number.isFinite(stats.peak_watts) && stats.peak_watts >= stats.mean_watts;
}

/**
 * The four series a power chart draws.
 *
 * Measured and modelled get their OWN fields. A single `mean` key that both
 * kinds write into is exactly how a modelled window came to be drawn under the
 * measured line's label and style: `powerReading` decided the kind correctly
 * and the renderer then had no field in which to keep the answer. The split is
 * in the data, so a consumer cannot blend them back together by accident.
 */
export const POWER_SERIES = [
  { key: "measuredMean", kind: KIND_MEASURED, stat: "mean", name: "Average (W)" },
  { key: "measuredPeak", kind: KIND_MEASURED, stat: "peak", name: "Sampled peak (W)" },
  { key: "modelledMean", kind: KIND_ESTIMATED, stat: "mean", name: "Modelled average (W)" },
  { key: "modelledPeak", kind: KIND_ESTIMATED, stat: "peak", name: "Modelled peak (W)" },
];

const SERIES_BY_KEY = new Map(POWER_SERIES.map((series) => [series.key, series]));

/** Whether a chart field carries modelled values. Drives the "~" and the words. */
export function powerSeriesModelled(key) {
  return SERIES_BY_KEY.get(key)?.kind === KIND_ESTIMATED;
}

const blankSeries = () => ({ measuredMean: null, measuredPeak: null, modelledMean: null, modelledPeak: null });

export function powerChartPoints(points, sensor) {
  const ordered = points.filter((point) =>
    Number.isFinite(point.start_unix_ms) && Number.isFinite(point.end_unix_ms) &&
    point.end_unix_ms > point.start_unix_ms
  ).sort((a, b) => a.start_unix_ms - b.start_unix_ms || a.seq - b.seq);
  const result = [];
  let previous;
  let previousMethod = null;
  for (const point of ordered) {
    const { stats, source, kind } = powerReading(point, sensor);
    const drawable = kind === KIND_MEASURED || kind === KIND_ESTIMATED;
    // What produced this value. A change of BACKEND or of kind is a change of
    // measurement method, and a line drawn across one implies a continuity
    // that does not exist.
    const method = drawable ? `${kind}\u0000${source}` : null;

    const discontinuity = previous && (
      point.gap_before || point.stream_id !== previous.stream_id ||
      point.seq !== previous.seq + 1 || point.start_unix_ms - previous.end_unix_ms > 1500 ||
      (method !== null && previousMethod !== null && method !== previousMethod)
    );
    if (discontinuity) {
      result.push({ timestamp: point.start_unix_ms, ...blankSeries(), coverage: null, kind: null, source: "" });
    }
    const row = {
      timestamp: point.end_unix_ms,
      ...blankSeries(),
      coverage: drawable && point.expected_samples > 0
        ? Math.min(100, 100 * stats.samples / point.expected_samples) : null,
      kind: drawable ? kind : null,
      source: drawable ? source : "",
    };
    if (drawable) {
      const prefix = kind === KIND_MEASURED ? "measured" : "modelled";
      row[`${prefix}Mean`] = stats.mean_watts;
      row[`${prefix}Peak`] = stats.peak_watts;
    }
    result.push(row);
    previous = point;
    if (method !== null) previousMethod = method;
  }
  return result;
}

/**
 * Indices where a series holds a single point with no neighbour to join.
 *
 * A polyline through one point draws nothing at all, so `dot={false}` would
 * erase exactly the window a kind or method split exists to point at — one
 * modelled window between measured ones, or one reading after a backend
 * change. Those get a mark instead of disappearing.
 */
export function powerIsolatedIndexes(rows, key) {
  const solo = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.[key] == null) continue;
    if (rows[index - 1]?.[key] == null && rows[index + 1]?.[key] == null) solo.add(index);
  }
  return solo;
}

/** Watts, or an em dash. A missing reading is never printed as zero, and a
 *  modelled figure is never printed as a bare measurement. */
export function formatPowerWatts(value, modelled = false) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${modelled ? "~ " : ""}${Math.round(value)} W`;
}

/** The series name a tooltip shows, with the backend that produced the point. */
export function powerTooltipName(name, source) {
  return `${name} · ${typeof source === "string" && source !== "" ? source : "source unlabelled"}`;
}

/**
 * The lead readout above the chart.
 *
 * It reads the LATEST row's own kind. Formatting `latest.mean` regardless put
 * a modelled number in the largest type on the page with no mark and no word
 * saying so, while the separate modelled rail row said nothing about it — the
 * headline is not qualified by a figure further down.
 */
export function powerLatestReadout(chart) {
  const row = Array.isArray(chart) && chart.length > 0 ? chart[chart.length - 1] : undefined;
  const modelled = row?.kind === KIND_ESTIMATED;
  const watts = modelled ? row.modelledMean : row?.kind === KIND_MEASURED ? row.measuredMean : null;
  const source = typeof row?.source === "string" ? row.source : "";
  // A blank source is NOT evidence of an old agent: GPU readings carry no
  // scalar backend label by contract, so every current GPU window has one.
  // Say what is true — there is no label — and infer nothing from it.
  const backend = source ? ` Backend: ${source}.` : " No backend label is recorded for this reading.";
  return {
    label: modelled ? "Latest 30 s average · modelled" : "Latest 30 s average",
    value: formatPowerWatts(watts, modelled),
    modelled,
    source,
    // Only the LATEST window was examined here. Older windows in the loaded
    // history may well be readable, and the rail below says how many are.
    title: watts === null
      ? "The latest window has no reading eligible for this sensor."
      : modelled
        ? `Modelled by an older agent from CPU utilisation, not measured.${backend}`
        : `Measured.${backend}`,
  };
}

export function powerSensorIDs(points) {
  return [...new Set(points.flatMap((point) => (point.gpus ?? []).map((gpu) => gpu.id)))].sort();
}

export function powerProblemLabel(problem) {
  const labels = {
    clock_skew: "The machine clock is more than 15 minutes ahead of the hub. Correct its clock to resume power history.",
    storage_error: "The hub could not save power history. The agent will retry; live metrics are unaffected.",
    conflicting_replay: "A saved power-history record conflicts with the hub's copy. Existing readings are preserved; agent diagnostics need review.",
    rejected_data: "The hub rejected a power-history record. Live metrics are unaffected; agent diagnostics need review.",
  };
  return Object.hasOwn(labels, problem) ? labels[problem] : null;
}

// Ingestion cursors (not measurement timestamps) preserve offline backfill.
// The server returns current gap/degraded metadata even on an empty delta.
export function mergePowerHistory(previous, incoming, now) {
  if (!Number.isSafeInteger(incoming.cursor) || incoming.cursor < 0 ||
    !Array.isArray(incoming.points) || !Array.isArray(incoming.gaps)) {
    throw new Error("Invalid power history response.");
  }
  if (previous && incoming.cursor < previous.cursor) {
    throw new RangeError("Power history changed on the hub; reloading.");
  }
  const cutoff = now - 24 * 60 * 60 * 1000;
  const points = new Map();
  for (const point of [...(previous?.points ?? []), ...incoming.points]) {
    if (point.end_unix_ms >= cutoff) points.set(JSON.stringify([point.stream_id, point.seq]), point);
  }
  return { ...incoming, points: [...points.values()] };
}

// The numbers beside the chart, for one sensor, over the points already loaded
// (at most 24 h — see mergePowerHistory's cutoff).
//
// `average` is sample-weighted: a window the agent only half-sampled carries
// half the weight of a full one, so the figure is the mean of every sample
// taken rather than the mean of the window means. `peak` is the highest single
// sampled peak of any window — never a sum, because independent sensors peak at
// different instants and adding them would invent a machine peak that never
// happened. `windows`/`samples` are what the average is made of, so the label
// beside it can say so instead of implying a full day.
export function powerRailStats(points, sensor) {
  const blank = () => ({ windows: 0, samples: 0, weighted: 0, peak: null });
  const acc = { [KIND_MEASURED]: blank(), [KIND_ESTIMATED]: blank() };
  const sources = { [KIND_MEASURED]: new Set(), [KIND_ESTIMATED]: new Set() };
  let excluded = 0;

  for (const point of points) {
    const { stats, source, kind } = powerReading(point, sensor);
    if (kind !== KIND_MEASURED && kind !== KIND_ESTIMATED) {
      if (stats) excluded += 1; // a real window we declined to count
      continue;
    }
    const a = acc[kind];
    a.windows += 1;
    a.samples += stats.samples;
    a.weighted += stats.mean_watts * stats.samples;
    a.peak = a.peak === null ? stats.peak_watts : Math.max(a.peak, stats.peak_watts);
    if (source) sources[kind].add(source);
  }

  const summarise = (kind) => ({
    windows: acc[kind].windows,
    samples: acc[kind].samples,
    average: acc[kind].samples > 0 ? acc[kind].weighted / acc[kind].samples : null,
    peak: acc[kind].peak,
    sources: [...sources[kind]].sort(),
  });

  const measured = summarise(KIND_MEASURED);
  return {
    // Measured and modelled are summarised SEPARATELY. Averaging a counter
    // reading together with a model produces a figure neither of them made.
    measured,
    modelled: summarise(KIND_ESTIMATED),
    excluded,
    // The measured summary stays at the top level so existing callers keep
    // reading a measurement rather than a blend.
    windows: measured.windows,
    samples: measured.samples,
    average: measured.average,
    peak: measured.peak,
  };
}

export function sampleAgeLabel(endUnixMS, now) {
  if (!Number.isFinite(endUnixMS)) return "No samples";
  // The shared skew tolerance, not a second one. A 5s allowance here against
  // 2s everywhere else meant the same window could be "clock ahead" on one
  // screen and current on another.
  if (endUnixMS > now + POWER_FUTURE_SKEW_TOLERANCE_MS) return "Machine clock ahead";
  const seconds = Math.max(0, Math.floor((now - endUnixMS) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}
