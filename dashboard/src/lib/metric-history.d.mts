export type Period = '30m' | '1h' | '6h' | '24h' | '7d';
export interface MetricPoint {
  timestamp: string;
  cpu_percent: number;
  ram_used: number;
  ram_total: number;
  gpu_temp: number;
  gpu_util: number;
  gpu_vram_used: number;
  gpu_vram_total: number;
}
export interface MetricHistoryState {
  machineId: string;
  period: Period;
  status: 'loading' | 'ready' | 'error';
  data: MetricPoint[];
  error?: string;
}
export function loadingMetricHistory(machineId: string, period: Period): MetricHistoryState;
export function metricHistoryForKey(state: MetricHistoryState, machineId: string, period: Period): MetricHistoryState;
export function createMetricHistoryRequest(options: {
  machineId: string;
  period: Period;
  load: (key: { machineId: string; period: Period; signal: AbortSignal }) => Promise<Response>;
  publish: (state: MetricHistoryState) => void;
  timeoutMs?: number;
}): { machineId: string; period: Period; request: () => Promise<void>; dispose: () => void };
