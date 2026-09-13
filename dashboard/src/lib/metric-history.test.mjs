import test from 'node:test';
import assert from 'node:assert/strict';
import { loadingMetricHistory, metricHistoryForKey, createMetricHistoryRequest } from './metric-history.mjs';
const point = { timestamp: '2026-09-13T00:00:00Z', cpu_percent: 0 };
const ok = points => ({ ok: true, json: async () => ({ points }) });
function fixture(load, extra = {}) {
  const states = [];
  const request = createMetricHistoryRequest({ machineId: 'a', period: '1h', load, publish: s => states.push(s), ...extra });
  return { request, states, latest: () => states.at(-1) };
}
test('initial loading makes no empty-history claim', () => {
  assert.deepEqual(loadingMetricHistory('a', '1h'), { machineId: 'a', period: '1h', status: 'loading', data: [] });
});
for (const points of [[], [point]]) test(`successful ${points.length}-point response is ready`, async () => {
  const f = fixture(async () => ok(points));
  const work = f.request.request();
  assert.equal(f.latest().status, 'loading');
  await work;
  assert.equal(f.latest().status, 'ready');
  assert.deepEqual(f.latest().data, points);
});
for (const [name, load] of [
  ['HTTP failure', async () => ({ ok: false })],
  ['network failure', async () => { throw new Error('offline'); }],
  ['malformed points', async () => ok({})],
  ['missing points', async () => ({ ok: true, json: async () => ({}) })],
  ['malformed JSON', async () => ({ ok: true, json: async () => { throw new Error('JSON'); } })],
  ['non-cleanup abort', async () => { throw new DOMException('aborted', 'AbortError'); }],
]) test(`${name} yields initial error, never confirmed empty`, async () => {
  const f = fixture(load); await f.request.request();
  assert.equal(f.latest().status, 'error');
  assert.equal(f.latest().error, 'Metric history could not be loaded.');
  assert.deepEqual(f.latest().data, []);
});
test('refresh failure retains same-key readings; retry requests the selected period', async () => {
  const calls = [];
  const f = fixture(async key => { calls.push(key); if (calls.length === 2) throw new Error('offline'); return ok([point]); }, { period: '7d' });
  await f.request.request(); await f.request.request();
  assert.equal(f.latest().status, 'error'); assert.deepEqual(f.latest().data, [point]);
  assert.equal(f.latest().error, 'Could not refresh metric history. Showing the last loaded readings.');
  await f.request.request(); assert.equal(f.latest().status, 'ready');
  assert.deepEqual(calls.map(({ machineId, period }) => [machineId, period]), [['a', '7d'], ['a', '7d'], ['a', '7d']]);
});
test('machine and period changes immediately mask previous readings', () => {
  const state = { machineId: 'a', period: '1h', status: 'ready', data: [point] };
  assert.deepEqual(metricHistoryForKey(state, 'b', '1h'), loadingMetricHistory('b', '1h'));
  assert.deepEqual(metricHistoryForKey(state, 'a', '7d'), loadingMetricHistory('a', '7d'));
  assert.equal(metricHistoryForKey(state, 'a', '1h'), state);
});
test('cleanup suppresses a late response from the old key', async () => {
  let resolve; const f = fixture(() => new Promise(r => { resolve = r; }));
  const pending = f.request.request(); f.request.dispose(); resolve(ok([point])); await pending;
  assert.equal(f.states.length, 1); assert.equal(f.latest().status, 'loading');
});
test('overlapping retry and poll cannot create competing responses', async () => {
  let resolve, calls = 0;
  const f = fixture(() => { calls++; return new Promise(r => { resolve = r; }); });
  const first = f.request.request(); const second = f.request.request();
  assert.equal(first, second); assert.equal(calls, 1);
  resolve(ok([point])); await first; assert.equal(f.latest().status, 'ready');
});
test('timeout becomes error even if transport ignores abort', async () => {
  const f = fixture(() => new Promise(() => {}), { timeoutMs: 5 });
  await f.request.request(); assert.equal(f.latest().status, 'error');
});
