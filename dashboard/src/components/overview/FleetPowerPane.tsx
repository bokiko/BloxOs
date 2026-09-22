"use client";

// Current readouts remain separate from chart history. Coverage stays beside
// each figure; machine details own the breakdown and hardware caveats.
// Modelled readings stay separate and labelled. Curves preserve gaps.

import { useEffect, useId, useMemo, useRef, useState, type Key } from "react";
import { usePowerCurrent } from "@/contexts/PowerCurrentContext";
import { powerIsolatedIndexes } from "@/lib/power-history.mjs";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltip } from "@/components/charts/ChartTooltip";
import { Zap } from "lucide-react";

import { DEMO_MODE, HUB_URL, getStoredToken } from "@/lib/session";
import { freshnessNote } from "@/lib/power-freshness.mjs";
import {
  PERIOD_LABELS,
  POWER_PERIODS,
  coverageSentence,
  domainLabel,
  fleetPowerChartRows,
  fleetPowerWarnings,
  formatWatts,
  currentReading,
  currentDomainOf,
  currentDomainExcludes,
  currentOfferedDomains,
  domainOf,
  combinedSeries,
  resolveDomainChoice,
  availableDomains,
  POWER_DOMAINS,
  normalizeFleetPower,
  shortfallSentence,
} from "@/lib/fleet-power.mjs";
import { MF_PANEL_HEAD, MF_PANEL_TITLE } from "@/lib/monoform-classes";
import type { PowerPeriod, PowerRate } from "./useWorkspacePrefs";

export type { PowerPeriod, PowerRate };

/* Power keeps the Lumen teal role; solid/dashed strokes and explicit labels
   distinguish measured and modelled readings without using status colours. */
const STROKE: Record<string, string> = Object.fromEntries(
  POWER_DOMAINS.flatMap((domain) => [
    [`${domain}:measured`, "var(--data-power)"],
    [`${domain}:estimated`, "var(--data-power)"],
  ]),
);

const axisTick = {
  fontSize: 10,
  fill: "var(--text-tertiary)",
  fontFamily: "var(--font-mono)",
} as const;

interface Series {
  key: string;
  domain: string;
  kind: "measured" | "estimated";
  label: string;
}

/** Which kind a chart field carries, for the surfaces recharts hands a key. */
function kindOfKey(series: Series[], key: string): Series["kind"] | undefined {
  return series.find((s) => s.key === key)?.kind;
}

/**
 * A mark for a bucket with no neighbour to draw a line to.
 *
 * A polyline through one point renders nothing, so without this a fleet
 * reporting a single bucket shows an empty chart. The mark carries no
 * freshness claim: a bucket's end time is when the window closed, not when
 * anything was observed.
 */
function soloMark(rows: unknown, key: string, stroke: string) {
  const solo = powerIsolatedIndexes(rows, key) as Set<number>;
  const Solo = (props: { cx?: number; cy?: number; index?: number; key?: Key | null }) =>
    solo.has(props.index ?? -1) && Number.isFinite(props.cx) && Number.isFinite(props.cy)
      ? <circle key={props.key} cx={props.cx} cy={props.cy} r={2.75} fill={stroke} stroke="none" />
      : <g key={props.key} />;
  return Solo;
}

/**
 * The current snapshot, from GET /api/fleet/power/current. Kept distinct from
 * the history type so nothing can pass one where the other belongs — that
 * substitution is what let a charted bucket be presented as a current reading.
 */
interface FleetPowerCurrent {
  generatedUnixMS: number | null;
  machinesTotal: number;
  machinesReporting: number;
  domains: Map<string, unknown>;
}

interface FleetPowerHistory {
  period: PowerPeriod;
  coverage: {
    machinesTotal: number;
    machinesReporting: number;
    machinesAPIPolled: number;
    degradedMachines: number;
    gapsDeclared: number;
    gapBuckets: number;
    truncated: boolean;
  };
}

export interface FleetPowerPaneProps {
  period: PowerPeriod;
  onPeriodChange: (period: PowerPeriod) => void;
  /** Read-only here. The control that sets it lives in Settings → Preferences
   * (components/settings/PowerRateSettings.tsx); a tariff is typed once and
   * read on every visit, so it does not belong on the pane. */
  /**
   * Retained so the Overview's props do not churn while energy accounting is
   * withheld. The pane prices nothing today.
   */
  rate?: PowerRate;
}

/**
 * The reader's chosen domain, per browser.
 *
 * Deliberately localStorage rather than an account preference: this is a view
 * choice, and adding an account field would mean a schema change this work does
 * not otherwise need. Every access is guarded — a cookie-blocked browser throws
 * on access, and a throw during render would take the page down.
 */
const DOMAIN_STORAGE_KEY = "bloxos.fleetPower.domain";

function readStoredDomain(): string | null {
  try {
    const raw = window.localStorage.getItem(DOMAIN_STORAGE_KEY);
    return raw && raw !== "dram" && (POWER_DOMAINS as string[]).includes(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeStoredDomain(domain: string): void {
  try {
    window.localStorage.setItem(DOMAIN_STORAGE_KEY, domain);
  } catch {
    // A reader who cannot persist the choice still gets it for this session.
  }
}

export function FleetPowerPane({ period, onPeriodChange }: FleetPowerPaneProps) {
  const fillId = useId();
  const [state, setState] = useState<{
    period: string;
    data?: FleetPowerHistory;
    error?: string;
  }>({
    period,
  });

  // The CURRENT reading is a separate request, from a page-level provider.
  //
  // It used to be fetched HERE, inside this handler and on this handler's
  // abort signal, which made it a dependent of the history request: a history
  // 500 or a history timeout meant the current request was never issued, and a
  // live figure the hub would have served fine vanished with it. Two questions
  // that fail independently must be asked independently.
  //
  // The old rule still holds: if this is unavailable, the readouts say so.
  // They never fall back to the history aggregate wearing a "current" label.
  const power = usePowerCurrent();
  const current = power.snapshot as FleetPowerCurrent | null;
  // The HUB's clock, ticking on its own. The readouts beside the table cells
  // must age the same snapshot by the same reference, or the two disagree.
  const hubNow = power.hubNow;

  useEffect(() => {
    // Demo mode has no hub. Fabricating a power series to fill the pane would
    // be exactly the invention the rest of this file exists to avoid, so the
    // pane says what it is instead.
    if (DEMO_MODE) return;
    let stopped = false;
    let active: AbortController | undefined;

    const load = async () => {
      if (active) return;
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const token = getStoredToken();
        const res = await fetch(
          `${HUB_URL}/api/fleet/power/history?period=${encodeURIComponent(period)}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal },
        );
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? "Fleet power history is not available on this hub yet."
              : "Could not refresh power history.",
          );
        }
        const data = normalizeFleetPower(await res.json()) as FleetPowerHistory;
        if (!stopped) setState({ period, data });
      } catch (error) {
        if (!stopped) {
          setState((previous) => ({
            period,
            // Keep the last good window for THIS period on the screen and mark
            // it stale, rather than blanking a real reading over one bad poll.
            data: previous.period === period ? previous.data : undefined,
            error: error instanceof Error ? error.message : "Could not refresh power history.",
          }));
        }
      } finally {
        clearTimeout(timeout);
        active = undefined;
      }
    };

    void load();
    // One 30-second bucket is the finest the agents produce, so polling
    // faster than that only re-renders the same numbers.
    const refresh = setInterval(() => void load(), 30000);
    return () => {
      stopped = true;
      active?.abort();
      clearInterval(refresh);
    };
  }, [period]);

  const data = state.period === period ? state.data : undefined;
  const error = state.period === period ? state.error : undefined;

  // DOMAIN CHOICE IS EXPLICIT AND LATCHED.
  //
  // It used to be automatic: any machine reporting system power took the whole
  // chart, hiding every other domain. That was survivable while only measured
  // counters existed and became actively harmful once a MODELLED system reading
  // could appear — one estimating board joining the fleet would evict the
  // measured CPU and GPU history of every other machine.
  //
  // So the reader chooses, the choice persists, and the initial default is
  // computed ONCE. Recomputing it per poll would let an arriving domain move
  // the view out from under someone mid-read.
  // SSR-SAFE: storage is read AFTER mount, never in the initialiser.
  //
  // Reading localStorage while computing initial state produces different
  // markup on the server (no window, so null) and in the browser (a stored
  // "dram", say), and React then reports a hydration mismatch and discards the
  // server render. So the first render is always the neutral default, and the
  // stored choice is applied in an effect on the client.
  const [domain, setDomain] = useState<string | null>(null);
  const latched = useRef(false);

  useEffect(() => {
    if (latched.current) return;
    const stored = readStoredDomain();
    if (stored) {
      latched.current = true;
      setDomain(stored);
      return;
    }
    // No stored choice: latch the computed default ONCE, so a domain arriving
    // on a later poll cannot move the view out from under the reader.
    if (!data) return;
    latched.current = true;
    setDomain(resolveDomainChoice(data, null) as string);
  }, [data]);

  const selected = domain ?? (resolveDomainChoice(data, null) as string);
  const chooseDomain = (next: string) => {
    latched.current = true;
    setDomain(next);
    writeStoredDomain(next);
  };

  // Series come from BOTH sources: a capped or empty history must not hide a
  // domain that is reporting right now.
  const series = useMemo(
    () => (combinedSeries(data, current, selected) as Series[]) ?? [],
    [data, current, selected],
  );
  const rows = useMemo(() => fleetPowerChartRows(data, series), [data, series]);
  const warnings = useMemo(() => (fleetPowerWarnings(data) as string[]) ?? [], [data]);
  const coverage = data?.coverage;

  // Readouts come from the CURRENT snapshot, never from the charted history.
  // Each carries its own freshness, judged from its oldest contributor, so a
  // mostly-dark fleet cannot be made to read as current by one live machine.
  const readouts = series.map((s) => ({
    ...s,
    latest: currentReading(current, s.domain, s.kind, hubNow) as
      | {
          watts: number;
          machines: number;
          sources: string[];
          freshness: { state: string; ageMS: number | null };
        }
      | null,
  }));


  // The selector only offers domains that have data, but the SELECTED domain is
  // always offered even when it goes quiet — a reader watching DRAM must not
  // have the control vanish underneath them the moment it stops reporting.
  // Offered domains come from BOTH sources. Deriving them from history alone
  // would let a truncated or empty history response hide a domain that is
  // reporting right now — the record cap drops the oldest rows, and a fleet
  // that only just started reporting has little history to show.
  // A domain is offered when the snapshot has anything to SAY about it, not
  // only when it has a number: a domain whose contributors were all excluded
  // must stay reachable, or the reason the hub recorded cannot be read.
  // Offering it invents nothing — it charts empty and shows the exclusions.
  const currentDomains = currentOfferedDomains(current) as string[];
  const offered = Array.from(
    new Set([...(availableDomains(data) as string[]), ...currentDomains, selected]),
  ).filter((d) => (POWER_DOMAINS as string[]).includes(d));

  // The selected domain has an exclusion to explain. The empty state must not
  // pre-empt it: with no history and every contributor excluded, "no machine
  // reports power" would replace the screen that says why.
  const currentExclusions = currentDomainExcludes(current, selected) as boolean;

  const domainSwitch = (
    <div className="mf-segment" role="group" aria-label="Power domain">
      {(POWER_DOMAINS as string[])
        .filter((d) => d !== "dram" && offered.includes(d))
        .map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={d === selected}
            onClick={() => chooseDomain(d)}
            title={`Chart ${domainLabel(d)} power`}
          >
            {domainLabel(d)}
          </button>
        ))}
    </div>
  );

  const periodSwitch = (
    <div className="mf-segment" role="group" aria-label="Power window">
      {(POWER_PERIODS as PowerPeriod[]).map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={key === period}
          onClick={() => onPeriodChange(key)}
          title={`Chart the ${PERIOD_LABELS[key]}`}
        >
          {key}
        </button>
      ))}
    </div>
  );

  return (
    <section className="mf-panel mf-power-anchor min-w-0 overflow-hidden" aria-label="Fleet power">
      <div className={MF_PANEL_HEAD}>
        <h2 className={MF_PANEL_TITLE}>Fleet power</h2>
        {/* One control group. It wraps rather than scrolling sideways: an
            option scrolled out of view with no visible cue is worse than an
            extra header row. */}
        <div className="mf-power-controls">
          {domainSwitch}
          {periodSwitch}
        </div>
      </div>
      <div className="mf-power-anchor-body">
        {DEMO_MODE ? (
          <EmptyState
            title="Not in the demo data."
            tip="Power comes from real counters on real machines — RAPL, an active BMC reading, GPU counters — so there is nothing here to simulate. Connect a hub to see it."
          />
        ) : series.length === 0 && !data && !currentExclusions ? (
          <EmptyState
            // The error IS the title. It used to be the body under a
            // "Fleet power unavailable." heading, which said the same thing
            // twice and made a two-line box out of one fact.
            title={
              error && !data
                ? error
                : !data
                  ? "Loading…"
                  : coverage && coverage.machinesTotal === 0
                    ? "No machines in this fleet."
                    : "No machine reports power."
            }
            hint={coverage && coverage.machinesTotal > 0 ? coverageShort(coverage) : undefined}
            tip={
              coverage && coverage.machinesTotal > 0
                ? "The agent reports power only from counters it can attribute: RAPL, a BMC reading the firmware says it is actually taking, and GPU counters. A machine without one reports nothing rather than a guess."
                : undefined
            }
          />
        ) : (
          <>

            {/* WHAT IS MISSING FROM THIS DOMAIN, and why. A shrinking
                contributor count with no explanation reads as a bug; these
                counts say which machines were excluded and on what grounds.
                Unknown provenance is shown because it is deliberately excluded
                from both series — silence there would hide the exclusion. */}
            {(() => {
              const diag = current ? currentDomainOf(current, selected) : null;
              if (!diag) return null;
              const notes = [
                diag.staleMachines > 0 ? `${diag.staleMachines} stale` : null,
                diag.skewedMachines > 0 ? `${diag.skewedMachines} clock-skewed` : null,
                diag.unknownMachines > 0 ? `${diag.unknownMachines} source or scope unverified` : null,
                diag.unreadableMachines > 0 ? `${diag.unreadableMachines} unreadable` : null,
              ].filter(Boolean);
              if (notes.length === 0) return null;
              return (
                <p
                  className="mf-table-meta mt-1"
                  title="These machines reported this domain but were excluded from the current figure. Their last values are not carried forward."
                >
                  Excluded: {notes.join(" · ")}
                </p>
              );
            })()}

            {/* THE READOUTS, which are also the chart's legend: each number
                carries the swatch of the line it came from, that line's name,
                and that line's own machine count. They sit side by side and
                are never totalled — "142 W measured" beside "≈18 W estimated"
                is two facts, and 160 W is not a third. */}
            <div
              className="mt-3 flex flex-wrap items-start gap-x-7 gap-y-3"
              title={coverage ? coverageDetail(coverage) : undefined}
            >
              {readouts.map((r) => (
                <div key={r.key} className="min-w-0">
                  <p className="mf-metric text-[36px] leading-none text-text-primary">
                    {r.kind === "estimated" && r.latest ? "~ " : ""}
                    {formatWatts(r.latest?.watts ?? null)}
                  </p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12px] leading-[1.4] text-text-tertiary">
                    <SeriesMark seriesKey={r.key} estimated={r.kind === "estimated"} />
                    {/* The label wears a text token; the swatch beside it is
                        the only thing carrying the series colour. */}
                    <span className="text-text-secondary">{r.label}</span>
                    {r.kind === "estimated" ? <span>— modelled, not measured</span> : null}
                    <span>
                      ·{" "}
                      {/* The denominator is the CURRENT fleet size, not the
                          history window's. Mixing them would compare live
                          contributors against a count drawn from a different
                          span. */}
                      {r.latest
                        ? `${r.latest.machines} / ${current?.machinesTotal ?? coverage?.machinesTotal ?? 0} reporting`
                        : "no reading"}
                    </span>
                    {/* A value that is not current NEVER appears as a bare
                        number. The note carries the age of the OLDEST
                        contributor, because the sum is only as current as
                        that — one live machine does not refresh the rest. */}
                    {r.latest && freshnessNote(r.latest.freshness) ? (
                      <span className="text-status-warning">
                        · {freshnessNote(r.latest.freshness)}
                      </span>
                    ) : null}
                  </p>
                </div>
              ))}
            </div>

            {/* COVERAGE, where no readout is carrying it. Every series being
                silent in this window would otherwise leave a chart of older
                buckets with nothing saying how much of the fleet is behind it. */}
            {coverage && !readouts.some((r) => r.latest) && (
              <p className="mt-2 text-[12px] text-text-secondary" title={coverageDetail(coverage)}>
                {/* Named as HISTORY coverage. This row appears exactly when no
                    current readout is carrying a number — including when the
                    current request just failed — and an unqualified "3 / 4
                    reporting" under a blank headline reads as a live count
                    that survived the failure. It is the charted window's. */}
                History · {coverageShort(coverage)}
              </p>
            )}

            {/* A failed current request and a successful snapshot with no
                eligible sensors both leave the readouts blank, and they are
                different situations for an operator: one is worth retrying,
                the other is what this fleet's hardware reports. Separate from
                the history error above, and it does not touch the chart. */}
            {power.status === "error" && power.error && (
              <p role="status" className="mt-2 flex items-start gap-2 text-[12px] text-status-warning">
                <span className="mf-status-dot mf-status-warning mt-1.5" aria-hidden="true" />
                <span>Current power unavailable. {power.error}</span>
              </p>
            )}

            {/* Excluded contributors in the HISTORY, surfaced even when the
                current snapshot is unavailable. Without this, a domain whose
                only contributors were excluded would look simply empty, and
                the reason — that the hub declined to total those readings
                rather than losing them — would be invisible. */}
            {(() => {
              const hist = domainOf(data, selected) as { unknown?: { machines: number } };
              const unknownMachines = hist?.unknown?.machines ?? 0;
              if (unknownMachines === 0) return null;
              return (
                <p
                  className="mf-table-meta mt-1"
                  title="Either the hub does not recognise the backend, or it recognises it and cannot vouch for what the sensor is wired across — a battery pack that may be supplying only part of the load, or a shunt whose rail its chip name does not identify. Excluded from both the measured and the modelled series rather than guessed into one. The stored readings are unchanged."
                >
                  {unknownMachines} machine{unknownMachines === 1 ? "" : "s"} whose power source or
                  scope is unverified — excluded from both series
                </p>
              );
            })()}

            {error && (
              <p role="status" className="mt-2 flex items-start gap-2 text-[12px] text-status-warning">
                <span className="mf-status-dot mf-status-warning mt-1.5" aria-hidden="true" />
                {/* This is the HISTORY poll, and only the history poll. The
                    current snapshot is a separate request from a separate
                    provider and may well have succeeded — it is what the
                    readouts above are showing. Saying "readings may be stale"
                    over a live figure tells an operator to distrust a number
                    that is fine. */}
                <span>{error} The chart may be out of date.</span>
              </p>
            )}
            {warnings.map((warning) => (
              <p
                key={warning}
                role="status"
                className="mt-2 flex items-start gap-2 text-[12px] text-status-warning"
              >
                <span className="mf-status-dot mf-status-warning mt-1.5" aria-hidden="true" />
                <span>{warning}</span>
              </p>
            ))}

            {/* The chart's accessible name is where the long form still
                lives: a screen reader gets the whole coverage sentence and
                the shortfall, which sighted readers get from the swatch row's
                tooltip rather than from a paragraph. */}
            <div
              className="mf-power-chart mt-3.5"
              role="img"
              aria-label={`${domainLabel(selected)} power in watts across the fleet, ${PERIOD_LABELS[period]}. ${
                coverage ? coverageDetail(coverage) : ""
              } Unreported buckets are left blank — missing data is not zero power.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--data-power)" stopOpacity={0.3} />
                      <stop offset="60%" stopColor="var(--data-power)" stopOpacity={0.12} />
                      <stop offset="100%" stopColor="var(--data-power)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="2 5" vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={formatTime}
                    tick={axisTick}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={32}
                  />
                  <YAxis unit=" W" tick={axisTick} axisLine={false} tickLine={false} width={56} />
                  <Tooltip
                    cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
                    content={
                      <ChartTooltip
                        labelFormatter={(label) => formatTime(Number(label))}
                        // A modelled figure is marked wherever it appears,
                        // including here.
                        formatter={(value, name, entry) => [
                          `${kindOfKey(series, String(entry?.dataKey ?? "")) === "estimated" ? "~ " : ""}${
                            formatWatts(typeof value === "number" ? value : null)}`,
                          String(name ?? ""),
                        ]}
                      />
                    }
                  />
                  {series.map((s) => (
                    <Area
                      key={s.key}
                      dataKey={s.key}
                      name={s.label}
                      stroke={STROKE[s.key] ?? "var(--data-power)"}
                      // Monotone curves round joins without adding local extrema.
                      type="monotoneX"
                      strokeWidth={3.5}
                      fill={s.kind === "measured" ? `url(#${fillId})` : "none"}
                      fillOpacity={1}
                      baseValue={0}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeDasharray={s.kind === "estimated" ? "5 4" : undefined}
                      // A bucket with no neighbour draws no line, so the mark
                      // is the only way it appears. Neutral by design: a
                      // bucket's end time is not an observation time, so no
                      // mark here may imply freshness.
                      dot={soloMark(rows, s.key, STROKE[s.key] ?? "var(--data-power)")}
                      activeDot={{ r: 4.5, strokeWidth: 0 }}
                      // A bucket nobody observed is a break in the line, not a
                      // straight segment drawn across time nobody measured.
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>

          </>
        )}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * The series swatch — the chart's legend, carried beside each readout.
 *
 * A 14px rule in the line's own stroke, dashed exactly as the line is dashed.
 * It is the ONLY thing in the readout wearing the series colour; every word
 * beside it wears a text token, and "modelled, not measured" is written out,
 * so solid versus dashed and the written labels carry the distinction.
 * ------------------------------------------------------------------------- */

function SeriesMark({ seriesKey, estimated }: { seriesKey: string; estimated: boolean }) {
  return (
    <svg width="14" height="8" viewBox="0 0 14 8" aria-hidden="true" className="shrink-0">
      <line
        x1="0"
        y1="4"
        x2="14"
        y2="4"
        stroke={STROKE[seriesKey] ?? "var(--data-power)"}
        strokeWidth="2"
        strokeDasharray={estimated ? "4 3" : undefined}
      />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Coverage, at two lengths.
 *
 * `coverageShort` is what goes on the screen; `coverageDetail` is the full
 * sentence plus the shortfall, for the tooltip and for the chart's accessible
 * name. Both are derived from the same numbers, so they cannot disagree.
 * ------------------------------------------------------------------------- */

interface Coverage {
  machinesTotal: number;
  machinesReporting: number;
  machinesAPIPolled: number;
}

/** "4 / 6 reporting". */
function coverageShort(coverage: Coverage): string {
  return `${coverage.machinesReporting} / ${coverage.machinesTotal} reporting`;
}

function coverageDetail(coverage: Coverage): string {
  const shortfall = shortfallSentence(coverage) as string | null;
  return shortfall
    ? `${coverageSentence(coverage)} ${shortfall}.`
    : (coverageSentence(coverage) as string);
}

/* ---------------------------------------------------------------------------
 * Empty state
 *
 * One short line, and a second one only where there is a number to give. It is
 * sized to its content and CENTRED in whatever height the paired-panel row
 * gives the pane: a dashed frame stretched to an arbitrary height reads as a
 * chart that failed to load, which is a different and wrong claim.
 *
 * The paragraph that used to explain WHERE power readings come from is on the
 * frame's tooltip. It answers a question an operator asks once.
 * ------------------------------------------------------------------------- */

function EmptyState({ title, hint, tip }: { title: string; hint?: string; tip?: string }) {
  return (
    <div className="flex h-full flex-col justify-center">
      <div
        className="mt-4 flex items-center gap-3 rounded-[10px] border border-dashed border-border-subtle px-4 py-4"
        title={tip}
      >
        <Zap className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[13px] text-text-primary">{title}</p>
          {hint && <p className="mt-0.5 text-[12px] text-text-tertiary">{hint}</p>}
        </div>
      </div>
    </div>
  );
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
