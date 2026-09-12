"use client";

import { useEffect, useState, type Key } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltip } from "@/components/charts/ChartTooltip";
import { HUB_URL, getStoredToken } from "@/lib/session";
import {
  POWER_SERIES, formatPowerWatts, mergePowerHistory, powerChartPoints, powerIsolatedIndexes,
  powerLatestReadout, powerProblemLabel, powerRailStats, powerSensorIDs, powerSeriesModelled,
  powerTooltipName, sampleAgeLabel,
} from "@/lib/power-history.mjs";
import { freshnessOf, STALE, SKEWED } from "@/lib/power-freshness.mjs";
import { MF_INPUT, MF_PANEL_HEAD, MF_PANEL_TITLE } from "@/lib/monoform-classes";

// Monoform: average and peak are two views of the same measurement, not two
// health states, so they are told apart by stroke style — solid measured-power
// teal for the average, dashed violet for the sampled peak — and never by the
// green/amber pair this product reserves for real nominal/warning data.
const MEAN_STROKE = "var(--data-power, var(--mf-blue))";
const PEAK_STROKE = "var(--mf-violet)";
// A model is not a quieter measurement, so it does not get the measurement's
// colour at lower weight. It gets its own quiet stroke and its own dash, and
// the words "Modelled" and "~" everywhere it appears — a style difference
// alone is not a label, and amber/green stay reserved for real status.
const MODELLED_STROKE = "var(--mf-quiet)";

const SERIES_STROKE: Record<string, { stroke: string; dash?: string }> = {
  measuredMean: { stroke: MEAN_STROKE },
  measuredPeak: { stroke: PEAK_STROKE, dash: "4 3" },
  modelledMean: { stroke: MODELLED_STROKE, dash: "2 3" },
  modelledPeak: { stroke: MODELLED_STROKE, dash: "1 4" },
};

interface PowerSeries { key: string; name: string }
const axisTick = { fontSize: 10, fill: "var(--text-tertiary)", fontFamily: "var(--font-mono)" } as const;

interface Stats { mean_watts: number | null; peak_watts: number | null; samples: number }
interface Point {
  stream_id: string; seq: number; start_unix_ms: number; end_unix_ms: number;
  expected_samples: number; gap_before?: boolean;
  gpus: (Stats & { id: string })[]; gpu_total?: Stats; cpu?: Stats;
  // Whole-platform and memory-controller power, beside the others and never
  // folded into them. Older hubs omit both, so both are optional.
  system?: Stats; dram?: Stats;
  // The backend behind each scalar domain. Absent on agents predating source
  // labelling; what may be drawn is decided from it in power-history.mjs.
  sources?: { domain: string; source: string }[];
}
interface History { points: Point[]; gaps: { stream_id: string; from: number; through: number }[]; degraded: boolean; cursor: number; problem?: string }
/** One plotted row. Each kind owns its own fields; `kind`/`source` say which
 *  instrument produced the point so a tooltip can name it. */
interface ChartRow {
  timestamp: number;
  measuredMean: number | null; measuredPeak: number | null;
  modelledMean: number | null; modelledPeak: number | null;
  coverage: number | null; kind: string | null; source: string;
}

/**
 * A mark for a point with no neighbour to draw a line to.
 *
 * Splitting by kind and by method isolates single windows on purpose — one
 * modelled window between measured ones, the first reading after a backend
 * change. A polyline through one point renders nothing, so `dot={false}` would
 * hide exactly the window the split exists to show. Isolated points only: a
 * dot on every sample would be noise across 24 hours.
 */
function soloDot(rows: ChartRow[], key: string, stroke: string) {
  const solo = powerIsolatedIndexes(rows, key) as Set<number>;
  const Solo = (props: { cx?: number; cy?: number; index?: number; key?: Key | null }) =>
    solo.has(props.index ?? -1) && Number.isFinite(props.cx) && Number.isFinite(props.cy)
      ? <circle key={props.key} cx={props.cx} cy={props.cy} r={2.5} fill={stroke} stroke="none" />
      : <g key={props.key} />;
  return Solo;
}

export function PowerHistory({ machineId }: { machineId: string }) {
  const [sensor, setSensor] = useState("gpu_total");
  const [state, setState] = useState<{ machineId: string; data?: History; error?: string }>({ machineId });
  const [now, setNow] = useState(0);
  useEffect(() => {
    let stopped = false;
    let active: AbortController | undefined;
    let cached: History | undefined;
    const load = async () => {
      if (active) return;
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const token = getStoredToken();
        const after = cached ? `?after=${cached.cursor}` : "";
        const res = await fetch(`${HUB_URL}/api/machines/${encodeURIComponent(machineId)}/power/history${after}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal,
        });
        if (cached && (res.status === 400 || res.status === 409)) {
          throw new RangeError("Power history changed on the hub; reloading.");
        }
        if (!res.ok) throw new Error(res.status === 404
          ? "Power history is not available on this hub yet." : "Could not refresh power history.");
        const data = await res.json() as History;
        cached = mergePowerHistory(cached, data, Date.now()) as History;
        if (!stopped) setState({ machineId, data: cached });
      } catch (error) {
        if (error instanceof RangeError) cached = undefined;
        if (!stopped) setState((previous) => ({ machineId,
          data: previous.machineId === machineId ? previous.data : undefined,
          error: error instanceof Error ? error.message : "Could not refresh power history." }));
      } finally { clearTimeout(timeout); active = undefined; }
    };
    void load();
    const refresh = setInterval(() => void load(), 30000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { stopped = true; active?.abort(); clearInterval(refresh); clearInterval(clock); };
  }, [machineId]);
  const data = state.machineId === machineId ? state.data : undefined;
  const points = data?.points ?? [];
  const sensors = powerSensorIDs(points) as string[];
  const chart = powerChartPoints(points, sensor) as ChartRow[];
  const latest = chart.at(-1);
  // The lead number reads the latest row's OWN kind. Formatting a `mean` that
  // both kinds wrote into printed a modelled figure in the largest type on the
  // page, unmarked, with only a separate rail row further down to contradict it.
  const readout = powerLatestReadout(chart) as {
    label: string; value: string; modelled: boolean; source: string; title: string;
  };
  const error = state.machineId === machineId ? state.error : undefined;
  const problem = powerProblemLabel(data?.problem);
  const hasCPU = points.some((point) => point.cpu && point.cpu.samples > 0);
  const hasSystem = points.some((point) => point.system && point.system.samples > 0);
  const hasDRAM = points.some((point) => point.dram && point.dram.samples > 0);
  // The SHARED freshness policy. A local 90s rule here against 150s elsewhere
  // meant the same window could read as current on one screen and stale on
  // another, which is the disagreement power-freshness.mjs exists to end.
  const freshness = freshnessOf(latest?.timestamp, now > 0 ? now : NaN);
  const stale = freshness.state === STALE || freshness.state === SKEWED;
  type RailSummary = {
    windows: number;
    samples: number;
    average: number | null;
    peak: number | null;
    sources: string[];
  };
  const rail = powerRailStats(points, sensor) as RailSummary & {
    measured: RailSummary;
    modelled: RailSummary;
    excluded: number;
  };
  const formatTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <section className="mf-panel mf-machine-power overflow-hidden" aria-label="Component power history">
      <div className={MF_PANEL_HEAD}>
        <div>
          <h2 className={MF_PANEL_TITLE}>Power history · last 24 hours</h2>
          <p className="mt-1 text-xs text-text-tertiary">
            30-second averages and sampled peaks. Component power, not wall power.
          </p>
        </div>
        <select
          aria-label="Power sensor"
          value={sensor}
          onChange={(event) => setSensor(event.target.value)}
          className={`${MF_INPUT} max-w-full border px-2.5`}
        >
          <option value="gpu_total">All GPUs together</option>
          {sensors.map((id) => <option key={id} value={id}>{id}</option>)}
          <option value="cpu">CPU packages{hasCPU ? "" : " (unavailable)"}</option>
          {/* Whole-platform and memory-controller power, beside the others and
              never folded into them. A domain the machine does not report says
              so rather than disappearing from the list — an absent option
              looks like a feature that does not exist. */}
          <option value="system">Whole system{hasSystem ? "" : " (unavailable)"}</option>
          <option value="dram">DRAM{hasDRAM ? "" : " (unavailable)"}</option>
        </select>
      </div>
      <div className="space-y-3.5 px-6 py-5">
      {error && (
        <p role="status" className="text-xs text-status-warning">
          {error} Existing readings may be stale.
        </p>
      )}
      {problem && <p role="status" className="text-xs text-status-warning">{problem}</p>}
      {(data?.degraded || (data?.gaps.length ?? 0) > 0 || points.some((point) => point.gap_before)) && (
        <p role="status" className="text-xs text-status-warning">
          History has gaps or reduced recording coverage. Missing data is not zero power.
        </p>
      )}
      {points.length === 0 ? (
        <p className="py-6 text-[13px] text-text-tertiary">{problem ? "Power history is paused." : data
          ? "No power history yet. A supported agent normally sends its first completed window within about a minute."
          : error ? "Power history unavailable." : "Loading power history…"}</p>
      ) : (
        <div className="mf-machine-power-layout">
          {/* The numbers this chart is made of. None of them is a new
              measurement: the average is the sample-weighted mean of the
              windows actually loaded (so a half-sampled window counts for
              half), the peak is the highest single sampled peak of any window
              and never a sum across sensors, and coverage is the LATEST
              window's — a 24-hour ratio would read as a fault on a machine
              enrolled an hour ago. A null reading prints an em dash, never 0. */}
          <dl className="mf-power-rail">
            <RailRow label={readout.label} value={readout.value} title={readout.title} lead />
            <RailRow
              label={`Measured average · ${rail.windows} window${rail.windows === 1 ? "" : "s"}`}
              value={formatWatts(rail.average)}
              title={`Sample-weighted mean of the ${rail.samples} samples in the ${rail.windows} measured windows loaded`}
            />
            <RailRow label="Highest measured sample" value={formatWatts(rail.peak)} />
            {/* A model is never averaged together with a counter reading: that
                produces a figure neither of them made. It gets its own row,
                marked, or no row at all. */}
            {rail.modelled.windows > 0 && (
              <RailRow
                label={`Modelled · ${rail.modelled.windows} window${rail.modelled.windows === 1 ? "" : "s"}`}
                value={formatWatts(rail.modelled.average, true)}
                title={`Modelled from CPU utilisation, not measured. Highest modelled sample ${formatWatts(rail.modelled.peak, true)}. Kept separate from the measured average above, because averaging a model together with a counter reading produces a figure neither of them made.`}
              />
            )}
            {rail.excluded > 0 && (
              <RailRow
                label="Not counted"
                value={`${rail.excluded} window${rail.excluded === 1 ? "" : "s"}`}
                title="Windows whose backend this build cannot attribute to this domain, whose scope it cannot vouch for, or whose counters an all-zero window cannot show progressed. The readings are stored unchanged; they are not summarised here."
              />
            )}
            <RailRow
              label="Last window"
              value={`${now ? sampleAgeLabel(latest?.timestamp, now) : "—"}${stale ? " · stale" : ""}`}
              tone={stale ? "warning" : undefined}
            />
            <RailRow
              label="Coverage"
              value={latest?.coverage != null ? `${Math.round(latest.coverage)}% sample coverage` : "sensor unavailable"}
            />
          </dl>
          <div>
          <div
            className="h-52"
            role="img"
            aria-label="Measured and modelled average and peak power in watts over the last 24 hours, drawn as separate lines"
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
                <XAxis
                  dataKey="timestamp" type="number" domain={["dataMin", "dataMax"]}
                  tickFormatter={formatTime} tick={axisTick} axisLine={false} tickLine={false} minTickGap={28}
                />
                <YAxis unit=" W" tick={axisTick} axisLine={false} tickLine={false} width={64} />
                <Tooltip
                  cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
                  content={
                    <ChartTooltip
                      labelFormatter={(label) => formatTime(Number(label))}
                      // Every row names the backend that produced it, so a
                      // method change reads as a change of instrument rather
                      // than as an unexplained break in the line.
                      formatter={(value, name, entry) => [
                        value == null
                          ? "—"
                          : formatWatts(Number(value), powerSeriesModelled(String(entry?.dataKey ?? "")) as boolean),
                        powerTooltipName(String(name ?? ""), (entry?.payload as { source?: unknown } | undefined)?.source) as string,
                      ]}
                    />
                  }
                />
                {/* Four lines, one per kind and statistic. A measured window
                    and a modelled one write into different fields, so neither
                    can inherit the other's label, colour or dash — the split
                    the classifier makes survives all the way to the pixels. */}
                {(POWER_SERIES as PowerSeries[]).map((series) => (
                  <Line
                    key={series.key}
                    dataKey={series.key}
                    name={series.name}
                    stroke={SERIES_STROKE[series.key].stroke}
                    strokeWidth={1.5}
                    strokeDasharray={SERIES_STROKE[series.key].dash}
                    dot={soloDot(chart, series.key, SERIES_STROKE[series.key].stroke)}
                    activeDot={{ r: 3 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-xs text-text-tertiary">
            Solid line: measured average · dashed violet: highest observed sample · grey dashes
            marked ~: modelled by the agent, not measured. A line stops where the measurement
            method changes; a single window with no neighbour is drawn as a dot. Gaps and
            unavailable sensors are left blank.
          </p>
          </div>
        </div>
      )}
      </div>
    </section>
  );
}

/** One number on the rail. `lead` is the one the eye lands on first. */
function RailRow({
  label,
  value,
  lead,
  tone,
  title,
}: {
  label: string;
  value: string;
  lead?: boolean;
  tone?: "warning";
  title?: string;
}) {
  return (
    <div>
      <dt className="mf-kicker">{label}</dt>
      <dd
        className={`mf-metric ${lead ? "mf-power-rail-value" : "mt-1 text-[13px]"} ${
          tone === "warning" ? "text-status-warning" : lead ? "" : "text-text-primary"
        }`}
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}

/** Watts, or an em dash — the one formatter, so a modelled figure cannot be
 *  printed bare on one surface and marked on another. */
function formatWatts(value: number | null | undefined, modelled = false): string {
  return formatPowerWatts(value, modelled) as string;
}
