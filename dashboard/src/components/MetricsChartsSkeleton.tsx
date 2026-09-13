"use client";

// The history response has no points to draw. Keep each unit visible without
// a decorative plot or a promise that collection has succeeded.
import { MF_PANEL_HEAD, MF_PANEL_TITLE } from "@/lib/monoform-classes";

interface MetricsChartsSkeletonProps {
  hasGpu: boolean;
}

export function MetricsChartsSkeleton({ hasGpu }: MetricsChartsSkeletonProps) {
  const titles = hasGpu
    ? ["CPU · %", "Memory · GB", "GPU utilisation · %", "GPU temperature · °C", "VRAM · GB"]
    : ["CPU · %", "Memory · GB"];
  return (
    <div className="mf-machine-metrics-grid">
      {titles.map((title) => (
        <section key={title} className="mf-panel overflow-hidden">
          <div className={MF_PANEL_HEAD}><h3 className={MF_PANEL_TITLE}>{title}</h3></div>
          <div className="flex min-h-[180px] items-center justify-center px-6 py-5">
            <p className="mf-body text-text-secondary">No history available</p>
          </div>
        </section>
      ))}
    </div>
  );
}
