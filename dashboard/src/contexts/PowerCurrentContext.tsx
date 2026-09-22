"use client";

/* ============================================================================
 * One current power snapshot for the whole page.
 *
 * The fleet power pane, the fleet table's Power column and a machine's
 * Overview all read this. One request per page, not one per row: a table
 * fetching per-machine history would issue a request per machine and still
 * answer the wrong question, because a charted bucket is not a current
 * reading.
 *
 * It is deliberately a SEPARATE request from anything else. The pane used to
 * fetch current inside its history handler and share that handler's abort
 * signal, so a history 500 or timeout meant the current request was never
 * issued at all and a perfectly good live figure disappeared with it. Nothing
 * here knows what else the page is fetching.
 *
 * The policy lives in power-current.mjs, which is where it is tested. This
 * file is the fetch, the clock and the plumbing.
 * ========================================================================== */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from "react";
import { DEMO_MODE, HUB_URL } from "@/lib/session";
import { useAuth } from "./AuthContext";
import { normalizeFleetPowerCurrent } from "@/lib/fleet-power.mjs";
import {
  POWER_CURRENT_IDLE, POWER_CURRENT_LOADING, powerCurrentBaseline, powerCurrentForSession,
  powerCurrentLines, powerCurrentMachine, powerCurrentReduce,
} from "@/lib/power-current.mjs";
import { hubNowFrom } from "@/lib/power-cell.mjs";

const REFRESH_MS = 30000;

/** Demo mode has no hub. Fabricating a watt figure to fill the column would be
 *  exactly the invention this feature exists to avoid. */
const DEMO_STATE = {
  status: "error", snapshot: null, baseline: null, session: null,
  error: "Demo mode has no hub, so there is no current power reading.",
} as const;

export interface PowerDomainLine {
  domain: string;
  label: string;
  state: "value" | "stale" | "unavailable";
  reason?: string;
  detail?: string;
  watts?: number;
  kind?: string;
  source?: string;
  prefix?: string;
  note?: string;
  ageMs?: number;
  warning?: string;
}

interface PowerCurrentState {
  status: "idle" | "loading" | "ready" | "error";
  snapshot: { machines: Map<string, unknown> } | null;
  baseline: { generatedUnixMs: number; requestStartedMonotonicMs: number } | null;
  error: string;
  /** Which session fetched this. Compared, never rendered. */
  session: string | null;
}

interface PowerCurrentValue {
  status: PowerCurrentState["status"];
  error: string;
  /** The whole normalized snapshot, for the fleet aggregate readouts. Null
   *  whenever it is not usable — including after a failure, so no surface can
   *  keep a headline the page can no longer date. */
  snapshot: unknown;
  /** The HUB's clock, advancing on its own. Every surface that judges the age
   *  of this snapshot must use THIS — a browser clock beside it would make the
   *  aggregate and the cells disagree about the same reading. Null when the
   *  age cannot be judged, which is unavailable and never "probably fine". */
  hubNow: number | null;
  /** The labelled lines for one machine, aged against the hub's clock. */
  linesFor: (machineId: string) => PowerDomainLine[];
  /** Whether this snapshot carries a row for a machine at all. */
  hasMachine: (machineId: string) => boolean;
  refresh: () => void;
}

const PowerCurrentContext = createContext<PowerCurrentValue | null>(null);

/** A monotonic reading, or 0 before one is available. Never a wall clock:
 *  substituting Date.now() would reintroduce the browser-clock dependence the
 *  hub-clock baseline exists to remove. */
function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now() : 0;
}

export function PowerCurrentProvider({ children }: { children: ReactNode }) {
  // This provider is mounted for the life of the page, so it outlives the
  // session inside it. The token is both the trigger and the identity: the
  // effect restarts when it changes, and every snapshot records which session
  // fetched it so a response still in flight for the previous account cannot
  // be read as the new one's fleet.
  const { token, isAuthenticated, hasScope } = useAuth();
  const session = isAuthenticated && token && hasScope("fleet.read") ? token : null;
  const [state, setState] = useState<PowerCurrentState>(POWER_CURRENT_LOADING as PowerCurrentState);
  // Ticks on its own so a cell ages without a refetch. A tab that stopped
  // polling watches its own readings go stale instead of showing a number
  // that was current when the request happened to land.
  const [tick, setTick] = useState(0);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    // Nothing is asked for without a session entitled to ask. That covers the
    // login and setup screens, a logged-out tab, and a role without
    // fleet.read — none of which should be issuing fleet-wide power polls.
    // Demo mode has no hub at all. Both are DERIVED below rather than written
    // into state here: they are facts about the page, not fetch results.
    if (!session || DEMO_MODE) return;
    let stopped = false;
    let active: AbortController | undefined;

    const load = async () => {
      if (active) return;
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), 10000);
      // BEFORE the request goes out. Anchoring at receipt would throw away
      // transit time and extend apparent freshness by exactly that delay.
      const requestStarted = monotonicNow();
      try {
        const res = await fetch(`${HUB_URL}/api/fleet/power/current`, {
          headers: { Authorization: `Bearer ${session}` }, signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(res.status === 404
            ? "Current fleet power is not available on this hub yet."
            : "Could not refresh current power.");
        }
        const snapshot = normalizeFleetPowerCurrent(await res.json());
        if (stopped) return;
        // The clock is advanced WITH the snapshot, in the same batch. The
        // interval only ticks once a second, so a response that arrives
        // between ticks would land with `tick` still older than its own
        // request start — elapsed negative, no usable reference, and a dash
        // flashing over a reading that had just arrived. The baseline stays
        // anchored at request start; only the reading of "now" moves.
        setTick(monotonicNow());
        setState(powerCurrentReduce(undefined, {
          type: "loaded", snapshot, session,
          baseline: powerCurrentBaseline(snapshot.generatedUnixMS, requestStarted),
        }) as PowerCurrentState);
      } catch (error) {
        if (stopped) return;
        // The previous snapshot goes with it. A watt figure nothing can date
        // is worse than a dash.
        setState(powerCurrentReduce(undefined, {
          type: "failed", session,
          error: error instanceof Error ? error.message : "Could not refresh current power.",
        }) as PowerCurrentState);
      } finally {
        clearTimeout(timeout);
        active = undefined;
      }
    };

    void load();
    const refresh = setInterval(() => void load(), REFRESH_MS);
    const clock = setInterval(() => setTick(monotonicNow()), 1000);
    return () => { stopped = true; active?.abort(); clearInterval(refresh); clearInterval(clock); };
  }, [session, reloads]);

  // Masked at RENDER, not only in the effect's cleanup. Cleanup runs a beat
  // after the token changes, and state written by the old session is still
  // there until it does — a beat is enough to paint one account's machines
  // under another account's name.
  // Derived, not stored. Masking at RENDER is the point: the effect's cleanup
  // runs a beat after the token changes, and state written by the old session
  // is still there until it does — a beat is enough to paint one account's
  // machines under another account's name.
  const visible = (DEMO_MODE ? DEMO_STATE
    : !session ? (POWER_CURRENT_IDLE as PowerCurrentState)
    : powerCurrentForSession(state, session)) as PowerCurrentState;
  const hubNow = hubNowFrom(visible.baseline, tick) as number | null;

  const linesFor = useCallback(
    (machineId: string) => powerCurrentLines(visible, machineId, tick) as PowerDomainLine[],
    [visible, tick],
  );
  const hasMachine = useCallback(
    (machineId: string) => powerCurrentMachine(visible, machineId) !== undefined,
    [visible],
  );
  const refresh = useCallback(() => setReloads((n) => n + 1), []);
  const value = useMemo<PowerCurrentValue>(
    () => ({ status: visible.status, error: visible.error, snapshot: visible.snapshot,
      hubNow, linesFor, hasMachine, refresh }),
    [visible.status, visible.error, visible.snapshot, hubNow, linesFor, hasMachine, refresh],
  );

  return <PowerCurrentContext.Provider value={value}>{children}</PowerCurrentContext.Provider>;
}

/**
 * Power lines for one machine.
 *
 * Outside a provider this returns the unavailable state rather than throwing:
 * a fleet table that renders in a context without power must show dashes, not
 * take the page down.
 */
export function usePowerCurrent(): PowerCurrentValue {
  const ctx = useContext(PowerCurrentContext);
  return ctx ?? FALLBACK;
}

const FALLBACK: PowerCurrentValue = {
  status: "loading",
  error: "",
  snapshot: null,
  hubNow: null,
  linesFor: (machineId: string) =>
    powerCurrentLines(POWER_CURRENT_LOADING, machineId, 0) as PowerDomainLine[],
  hasMachine: () => false,
  refresh: () => {},
};
