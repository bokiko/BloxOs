"use client";

import { MF_BUTTON, MF_PANEL_HEAD, MF_PANEL_TITLE } from "@/lib/monoform-classes";

function MetricHistoryPlaceholders({ hasGpu, loading }: { hasGpu: boolean; loading: boolean }) {
  const titles = hasGpu
    ? ["CPU · %", "Memory · GB", "GPU utilisation · %", "GPU temperature · °C", "VRAM · GB"]
    : ["CPU · %", "Memory · GB"];
  return (
    <div className="mf-machine-metrics-grid" aria-busy={loading}>
      {titles.map((title) => (
        <section key={title} className="mf-panel overflow-hidden">
          <div className={MF_PANEL_HEAD}><h3 className={MF_PANEL_TITLE}>{title}</h3></div>
          <div className="flex min-h-[180px] items-center justify-center px-6 py-5">
            <p className="mf-body text-text-secondary">
              {loading ? "Loading metric history…" : "No metric history available for this period."}
            </p>
          </div>
        </section>
      ))}
    </div>
  );
}

export function MetricsChartsLoading({ hasGpu }: { hasGpu: boolean }) {
  return <MetricHistoryPlaceholders hasGpu={hasGpu} loading />;
}

export function MetricsChartsEmpty({ hasGpu }: { hasGpu: boolean }) {
  return <MetricHistoryPlaceholders hasGpu={hasGpu} loading={false} />;
}

export function MetricsChartsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="mf-panel flex flex-wrap items-center justify-between gap-4 p-6" role="alert">
      <p className="mf-body text-text-secondary">{message}</p>
      <button type="button" className={MF_BUTTON} onClick={onRetry}>Retry</button>
    </section>
  );
}

export function MetricsRefreshWarning(props: { message: string; onRetry: () => void }) {
  return <MetricsChartsError {...props} />;
}
