export function loadingMetricHistory(machineId, period) {
  return { machineId, period, status: 'loading', data: [] };
}

// Mask the previous key during render, before effect cleanup/setup can run.
export function metricHistoryForKey(state, machineId, period) {
  return state.machineId === machineId && state.period === period
    ? state : loadingMetricHistory(machineId, period);
}

export function createMetricHistoryRequest({ machineId, period, load, publish, timeoutMs = 15000 }) {
  let state = loadingMetricHistory(machineId, period);
  let closed = false;
  let pending;
  let controller;
  let timer;
  const emit = (next) => { state = next; if (!closed) publish(next); };
  const request = () => {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    controller = new AbortController();
    emit({ ...state, status: 'loading', error: undefined });
    // Race the deadline too: an uncooperative transport must not strand loading.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
    });
    pending = (async () => {
      try {
        const points = await Promise.race([
          (async () => {
            const response = await load({ machineId, period, signal: controller.signal });
            if (!response.ok) throw new Error('request failed');
            const json = await response.json();
            if (!Array.isArray(json?.points)) throw new Error('malformed history');
            return json.points;
          })(),
          deadline,
        ]);
        if (!closed) emit({ machineId, period, status: 'ready', data: points });
      } catch {
        if (!closed) emit({ ...state, status: 'error', error: state.data.length
          ? 'Could not refresh metric history. Showing the last loaded readings.'
          : 'Metric history could not be loaded.' });
      } finally {
        clearTimeout(timer);
        pending = undefined;
      }
    })();
    return pending;
  };
  return { machineId, period, request, dispose() { closed = true; clearTimeout(timer); controller?.abort(); } };
}
