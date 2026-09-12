/**
 * What a power reading may be shown as, and what a cell says when it may not.
 *
 * The hub decides what may be TOTALLED (hub/fleet_power.go). This decides what
 * may be DRAWN and what a cell reads. The two policies have to agree, so both
 * are checked against one shared corpus —
 * proto/powerhistory/testdata/classification.json — rather than two matrices
 * maintained in parallel.
 *
 * Nothing here adds domains, picks a "best" number, or turns an instantaneous
 * watt reading into a window mean.
 */

import {
  POWER_FRESH_MS, POWER_FUTURE_SKEW_TOLERANCE_MS,
  freshnessOf, FRESH, STALE, SKEWED,
} from "./power-freshness.mjs";

export const KIND_MEASURED = "measured";
export const KIND_ESTIMATED = "estimated";
export const KIND_UNKNOWN = "unknown";

export const DOMAIN_SYSTEM = "system";
export const DOMAIN_CPU = "cpu";
export const DOMAIN_DRAM = "dram";
export const DOMAIN_GPU = "gpu";

const SOURCE_ESTIMATE = "estimate-util";
const SOURCE_BATTERY = "battery";
const HWMON_PREFIX = "hwmon:";
const RAPL_SOURCES = new Set(["rapl-psys", "rapl-package", "rapl-dram"]);

// Freshness policy is NOT redeclared here. power-freshness.mjs already owns
// the pair and the comparison; a second "one pair" declaration is how the
// three-way disagreement it was written to end gets rebuilt.
export { POWER_FRESH_MS, POWER_FUTURE_SKEW_TOLERANCE_MS };

/** Whether a recognised source measures THIS domain. */
function measuresDomain(domain, source) {
  switch (source) {
    case "rapl-psys":
    case "ipmi-dcmi":
      return domain === DOMAIN_SYSTEM;
    case "rapl-package":
      return domain === DOMAIN_CPU;
    case "rapl-dram":
      return domain === DOMAIN_DRAM;
    default:
      return false;
  }
}

/**
 * A SYSTEM reading that measures something real but not demonstrably this
 * machine: a pack that may be carrying part of the load, a shunt named only by
 * its chip. Outside the system domain these keep their classification — the
 * exclusion is about a whole-machine claim, not about the backend.
 */
function systemScopeUnverified(source) {
  return source === SOURCE_BATTERY || source.startsWith(HWMON_PREFIX);
}

/**
 * The label alone. `system`, `dram` and `sources` were introduced together, so
 * only an unlabelled CPU reading corresponds to an agent that ever shipped.
 */
export function powerClassify(domain, source) {
  if (domain === DOMAIN_GPU) return KIND_MEASURED;
  // Explicit normalisation, not truthiness. A legitimately ABSENT label is
  // undefined, null or "": that is the legacy CPU case. Anything else that is
  // not a string is a malformed payload, and a malformed payload is unknown —
  // never a crash in startsWith, and never quietly treated as absent.
  if (source === undefined || source === null || source === "") {
    return domain === DOMAIN_CPU ? KIND_MEASURED : KIND_UNKNOWN;
  }
  if (typeof source !== "string") return KIND_UNKNOWN;
  if (source === SOURCE_ESTIMATE) return KIND_ESTIMATED;
  if (domain === DOMAIN_SYSTEM && systemScopeUnverified(source)) return KIND_UNKNOWN;
  if (measuresDomain(domain, source)) return KIND_MEASURED;
  if (source.startsWith(HWMON_PREFIX)) return KIND_MEASURED;
  return KIND_UNKNOWN;
}

/** Whether an all-zero window here could be a counter that never advanced. */
function frozenCounterDomain(domain, source) {
  if (RAPL_SOURCES.has(source)) return true;
  if (!source) return domain === DOMAIN_CPU;
  return false;
}

/**
 * The label plus what the samples say.
 *
 * An all-zero RAPL window is withheld. Not because the row is wrong — samples
 * cannot separate a frozen counter from genuinely zero energy — but because
 * that ambiguity is not something to draw as a value. Deliberately not a
 * "> 0" filter: a GPU at 0 W, an active BMC zero, and a window whose peak
 * moved are all real.
 */
export function powerKindFor(domain, source, stats) {
  const kind = powerClassify(domain, source);
  if (kind !== KIND_MEASURED) return kind;
  if (!stats || !Number.isFinite(stats.samples) || stats.samples <= 0) return kind;
  if (stats.mean_watts !== 0 || stats.peak_watts !== 0) return kind;
  return frozenCounterDomain(domain, typeof source === "string" ? source : "") ? KIND_UNKNOWN : kind;
}

/**
 * The hub's clock, carried forward by elapsed time since the snapshot arrived.
 *
 * Freshness is a comparison against the HUB's reference, not the browser's. A
 * browser clock hours off would otherwise relabel hub-validated readings as
 * agent clock skew, and a backward wall-clock adjustment would keep cached
 * data looking current — neither of which is a fact about the fleet.
 *
 * So the baseline is generated_unix_ms advanced by a MONOTONIC elapsed
 * measurement. No network time sync, and no assumption that the two wall
 * clocks agree.
 *
 * Elapsed is measured from when the REQUEST STARTED, not from when the
 * response arrived. The hub stamps generated_unix_ms early in its handler, so
 * anchoring at receipt would throw away the transit and processing time and
 * extend apparent freshness by exactly that delay — a slow response would look
 * younger than it is. Anchoring at request start is a conservative upper bound
 * on the hub's clock: it may withhold slightly early, and it can never
 * prolong freshness.
 *
 * Null means the age cannot be judged: a response with no usable reference, or
 * a monotonic source that went backwards. Callers treat that as unavailable
 * rather than guessing.
 */
export function hubNowFrom(baseline, monotonicNowMs) {
  if (!baseline || typeof baseline !== "object") return null;
  const { generatedUnixMs, requestStartedMonotonicMs } = baseline;
  if (!Number.isFinite(generatedUnixMs) || !Number.isFinite(requestStartedMonotonicMs)) return null;
  if (!Number.isFinite(monotonicNowMs)) return null;
  const elapsed = monotonicNowMs - requestStartedMonotonicMs;
  if (elapsed < 0) return null; // a monotonic clock that moved backwards is not one
  return generatedUnixMs + elapsed;
}

/**
 * Reasons a cell has no number. Each names what happened, so the dash can be
 * explained rather than merely rendered.
 */
export const REASONS = {
  absent: "This machine's latest window carries no reading for this domain.",
  stale: "The latest reading is older than the freshness window.",
  clock_skew: "The machine stamped this window ahead of the hub clock, so its age is unknown.",
  unreadable: "The latest stored window could not be read.",
  source_unverified: "The hub cannot attribute this reading to a backend it recognises for this domain.",
  scope_unverified: "This sensor measures something real, but not demonstrably this whole machine.",
  counter_idle_unverified: "An all-zero window cannot verify that the counters progressed, so it is not read as a measurement of zero.",
  unavailable: "The hub could not be reached.",
  no_reference: "The response carried no hub clock reference, so this reading's age cannot be judged.",
};

/**
 * One cell.
 *
 * `now` is the HUB's clock (see hubNowFrom), passed in and never read here. A
 * value that was fresh when it was fetched does not stay fresh in a tab that
 * stopped polling, so freshness is re-evaluated on every render against a
 * clock that ticks independently of the fetch. Tests advance it without
 * replacing the snapshot.
 *
 * Without a usable reference the age is unknown, and unknown age is
 * unavailable — not "probably still fine".
 */
export function powerCellState(entry, now) {
  if (!entry || typeof entry !== "object") {
    return { state: "unavailable", reason: "absent", detail: REASONS.absent };
  }

  // An age is worth reporting even when the value is not. The hub withholding
  // a stale reading is the COMMON case, and dropping its timestamp with it
  // would leave an operator with a dash and no idea how long it had been one.
  const freshness = freshnessOf(entry.window_end_unix_ms, now);

  if (entry.reason) {
    const reason = entry.reason in REASONS ? entry.reason : "source_unverified";
    const cell = { state: "unavailable", reason, detail: REASONS[reason],
      source: typeof entry.source === "string" ? entry.source : "" };
    if (reason === "stale") {
      return { ...cell, state: "stale", ageMs: freshness.ageMS };
    }
    return cell;
  }

  // Provenance FAILS CLOSED. A missing or unrecognised kind alongside a number
  // must not become "measured" — that is the same fail-open shape as the old
  // "estimated if labelled, else measured" rule, which presented every
  // unrecognised backend as a counter reading.
  if (entry.kind !== KIND_MEASURED && entry.kind !== KIND_ESTIMATED) {
    return { state: "unavailable", reason: "source_unverified",
      detail: REASONS.source_unverified,
      source: typeof entry.source === "string" ? entry.source : "" };
  }
  if (!Number.isFinite(entry.watts) || entry.watts < 0) {
    return { state: "unavailable", reason: "absent", detail: REASONS.absent };
  }

  if (freshness.state === SKEWED) {
    return { state: "unavailable", reason: "clock_skew", detail: REASONS.clock_skew };
  }
  if (freshness.state === STALE) {
    return { state: "stale", ageMs: freshness.ageMS, reason: "stale", detail: REASONS.stale };
  }
  if (freshness.state !== FRESH) {
    // No usable reference on either side: unknown age is unavailable, not
    // "probably still fine".
    return { state: "unavailable", reason: "no_reference", detail: REASONS.no_reference };
  }

  const modelled = entry.kind === KIND_ESTIMATED;
  return {
    state: "value",
    watts: entry.watts,
    kind: entry.kind,
    source: typeof entry.source === "string" ? entry.source : "",
    // Rendering only. The wire spelling stays `estimated`.
    prefix: modelled ? "~" : "",
    note: modelled ? "Modelled" : "",
  };
}

/**
 * The four lines a Power cell shows, in a fixed order, each independently in
 * its own state. Never summed, never reduced to one number, and a domain that
 * is absent says so rather than quietly becoming a different domain.
 */
export const POWER_DOMAIN_LINES = [
  { domain: DOMAIN_SYSTEM, label: "System" },
  { domain: DOMAIN_CPU, label: "CPU package" },
  { domain: DOMAIN_GPU, label: "GPU total" },
  { domain: DOMAIN_DRAM, label: "DRAM" },
];

export function powerDomainLines(machine, now) {
  const domains = machine && typeof machine === "object" ? machine.domains : null;
  return POWER_DOMAIN_LINES.map(({ domain, label }) => {
    const entry = domains && typeof domains === "object" ? domains[domain] : null;
    const withWindow = entry && typeof entry === "object" && !("window_end_unix_ms" in entry)
      ? { ...entry, window_end_unix_ms: machine?.window_end_unix_ms }
      : entry;
    return { domain, label, ...powerCellState(withWindow, now) };
  });
}
