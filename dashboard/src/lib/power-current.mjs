/* ============================================================================
 * The fleet's current power snapshot, as one page-level fact.
 *
 * Every surface that shows a live watt figure — the fleet power pane, the
 * fleet table's Power column, a machine's Overview — reads THIS. One request
 * per page, not one per row: a fleet table fetching per-machine history would
 * issue a request per row and still answer a different question, because a
 * history bucket is not a current reading.
 *
 * Two rules this module exists to hold, both of them crossed-outcome rules
 * that a nested fetch got wrong:
 *
 *   - A failure somewhere else must not suppress a snapshot that arrived.
 *     The pane used to fetch current INSIDE the history handler and share its
 *     abort signal, so a history 500 or timeout meant the current request was
 *     never made at all, and the honest live figure vanished with it.
 *   - A failure HERE must not leave the last good snapshot on screen. A
 *     watt figure with no way to tell how old it is is worse than a dash;
 *     a cached headline is exactly the "probably still fine" this refuses.
 *
 * The clock is the hub's, carried by hubNowFrom, and it ticks independently of
 * the fetch so a tab that stops polling watches its own cells go stale.
 * ========================================================================== */

import { REASONS, POWER_DOMAIN_LINES, hubNowFrom, powerDomainLines } from "./power-cell.mjs";

/** Nothing fetched yet. Not an error, and not a reading either. */
export const POWER_CURRENT_LOADING = Object.freeze({
  status: "loading", snapshot: null, baseline: null, error: "", session: null,
});

/** No session entitled to ask. Nothing was requested, so nothing is claimed. */
export const POWER_CURRENT_IDLE = Object.freeze({
  status: "idle", snapshot: null, baseline: null, error: "", session: null,
});

/**
 * The hub-clock reference a snapshot carries, or null if it carries none.
 *
 * `requestStartedMonotonicMs` is taken BEFORE the request goes out. Anchoring
 * at receipt would discard transit time and extend apparent freshness by
 * exactly that delay.
 */
export function powerCurrentBaseline(generatedUnixMS, requestStartedMonotonicMs) {
  if (!Number.isFinite(generatedUnixMS) || generatedUnixMS <= 0) return null;
  if (!Number.isFinite(requestStartedMonotonicMs)) return null;
  return { generatedUnixMs: generatedUnixMS, requestStartedMonotonicMs };
}

/**
 * The provider's whole state machine, so its rules can be tested without a
 * browser, a fetch or a React tree.
 */
export function powerCurrentReduce(state, event) {
  const previous = state ?? POWER_CURRENT_LOADING;
  const session = event?.session ?? null;
  switch (event?.type) {
    case "loaded":
      // A snapshot with no usable hub reference is not a reading: its age
      // cannot be judged, and an unjudgeable age is unavailable.
      return event.baseline
        ? { status: "ready", snapshot: event.snapshot, baseline: event.baseline, error: "", session }
        : { status: "error", snapshot: null, baseline: null, session,
            error: "The hub's snapshot carried no usable clock reference." };
    case "failed":
      // The snapshot goes with it. Keeping it would put a number on screen
      // that nothing can date.
      return { status: "error", snapshot: null, baseline: null, session,
        error: typeof event.error === "string" && event.error !== ""
          ? event.error : "Could not refresh fleet power." };
    case "reset":
      return POWER_CURRENT_LOADING;
    case "idle":
      return POWER_CURRENT_IDLE;
    default:
      return previous;
  }
}

/**
 * The state as the CURRENT session may read it.
 *
 * A provider mounted for the life of the page outlives the session inside it.
 * Binding the fetch effect to the token cancels the next poll, but a response
 * already in flight for the previous account can still land, and even a
 * correct cleanup leaves a render or two in which the old snapshot is still in
 * state — long enough to show one account's fleet to the next. So the session
 * that fetched a snapshot is stored WITH it, and a mismatch reads as nothing
 * fetched yet rather than as data.
 *
 * The session key is an opaque identity, compared and never rendered.
 */
export function powerCurrentForSession(state, session) {
  if (!state || typeof state !== "object") return POWER_CURRENT_LOADING;
  if (state.status === "idle") return state;
  return state.session === session && session != null ? state : POWER_CURRENT_LOADING;
}

/** The raw row for one machine, or undefined when this snapshot has none. */
export function powerCurrentMachine(state, machineId) {
  if (!state || state.status !== "ready" || !state.snapshot) return undefined;
  const rows = state.snapshot.machines;
  if (!(rows instanceof Map) || typeof machineId !== "string" || machineId === "") return undefined;
  return rows.get(machineId);
}

/** Every domain answered with the same reason, so a cell is never half-drawn. */
function allUnavailable(reason) {
  const detail = REASONS[reason] ?? REASONS.unavailable;
  return POWER_DOMAIN_LINES.map(({ domain, label }) => ({
    domain, label, state: "unavailable", reason, detail,
  }));
}

/**
 * The labelled lines for one machine's Power cell.
 *
 * Always in the same order, each independently in its own state.
 * A machine the snapshot does not mention says so; it never inherits the row
 * above it, and a route change never shows the previous machine's watts.
 */
export function powerCurrentLines(state, machineId, monotonicNowMs) {
  if (!state || state.status === "loading") return allUnavailable("loading_snapshot");
  if (state.status === "idle") return allUnavailable("no_session");
  if (state.status !== "ready" || !state.snapshot) return allUnavailable("unavailable");
  const now = hubNowFrom(state.baseline, monotonicNowMs);
  if (now === null) return allUnavailable("no_reference");
  const machine = powerCurrentMachine(state, machineId);
  if (machine === undefined) return allUnavailable("not_in_snapshot");
  return powerDomainLines(machine, now);
}

/** Whether any of a cell's lines carries a number worth showing. */
export function powerCellHasReading(lines) {
  return Array.isArray(lines) && lines.some((line) => line?.state === "value" || line?.state === "stale");
}
