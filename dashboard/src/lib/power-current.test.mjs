import test from "node:test";
import assert from "node:assert/strict";
import {
  POWER_CURRENT_LOADING, powerCellHasReading, powerCurrentBaseline, powerCurrentForSession,
  powerCurrentLines,
  powerCurrentMachine, powerCurrentReduce,
} from "./power-current.mjs";
import { normalizeFleetPowerCurrent } from "./fleet-power.mjs";
import { POWER_FRESH_MS } from "./power-freshness.mjs";

const GENERATED = 1_757_700_000_000;
const REQUEST_STARTED = 5_000; // a monotonic reading, not a wall clock

// The hub's own JSON, not a hand-made object: the row shape is a wire
// contract, and a fixture that renames a field tests a shape nothing sends.
const payload = (machines) => ({
  generated_unix_ms: GENERATED, lookback_ms: 150000, domains: [],
  machines_total: machines.length, machines_reporting: machines.length,
  machines,
});
const row = (id, domains, end = GENERATED - 10_000) => ({
  machine_id: id, window_end_unix_ms: end, domains,
});
const measured = { watts: 118, kind: "measured", source: "rapl-psys" };
const modelled = { watts: 12, kind: "estimated", source: "estimate-util" };

const loadedWith = (machines, generated) => powerCurrentReduce(POWER_CURRENT_LOADING, {
  type: "loaded",
  snapshot: normalizeFleetPowerCurrent({ ...payload(machines), generated_unix_ms: generated }),
  baseline: powerCurrentBaseline(generated, REQUEST_STARTED),
});
const ready = (machines) => loadedWith(machines, GENERATED);
const lineOf = (lines, domain) => lines.find((line) => line.domain === domain);

// NOT the crossed-outcome proof. This is the reducer's success path and
// nothing else fails in it, so it cannot show that a history failure leaves a
// current snapshot standing. That claim needs both requests and lives in the
// page fixture; naming it otherwise here would be a test passing on its title.
test("a loaded snapshot answers each domain from that machine's own row", () => {
  const state = ready([row("m1", { system: measured })]);
  assert.equal(state.status, "ready");
  const lines = powerCurrentLines(state, "m1", REQUEST_STARTED);
  assert.equal(lineOf(lines, "system").state, "value");
  assert.equal(lineOf(lines, "system").watts, 118);
  assert.equal(powerCellHasReading(lines), true);
});

test("a failure here clears the snapshot; a cached headline is worse than a dash", () => {
  const good = ready([row("m1", { system: measured })]);
  for (const event of [{ type: "failed", error: "Could not refresh fleet power." },
                       { type: "failed" }]) {
    const failed = powerCurrentReduce(good, event);
    assert.equal(failed.status, "error");
    assert.equal(failed.snapshot, null, "the last good snapshot does not survive");
    assert.equal(failed.baseline, null);
    assert.match(failed.error, /\S/, "and the failure says something");
    const lines = powerCurrentLines(failed, "m1", REQUEST_STARTED);
    assert.equal(lines.length, 5, "every domain still answers");
    for (const line of lines) assert.equal(line.state, "unavailable");
    assert.equal(powerCellHasReading(lines), false, "no number survives the error");
  }
});

test("a machine the snapshot does not mention never inherits another's watts", () => {
  const state = ready([row("m1", { system: measured }), row("m2", { cpu: modelled })]);
  assert.equal(powerCurrentMachine(state, "m1").machine_id, "m1");
  // The route changed to a machine this snapshot has no row for.
  assert.equal(powerCurrentMachine(state, "m9"), undefined);
  const lines = powerCurrentLines(state, "m9", REQUEST_STARTED);
  for (const line of lines) {
    assert.equal(line.state, "unavailable");
    assert.equal(line.reason, "not_in_snapshot");
  }
  // And m2's modelled CPU is m2's alone.
  assert.equal(lineOf(powerCurrentLines(state, "m2", REQUEST_STARTED), "cpu").watts, 12);
  assert.equal(lineOf(powerCurrentLines(state, "m1", REQUEST_STARTED), "cpu").state, "unavailable");
  for (const bad of ["", undefined, null, 7, {}]) {
    assert.equal(powerCurrentMachine(state, bad), undefined, JSON.stringify(bad));
  }
});

test("an unusable hub reference is an error, never a baseline", () => {
  // 0, negative and non-numeric all mean the same thing: there is no hub
  // clock here. Treating 0 as a timestamp dates every reading to 1970 and
  // paints the whole fleet stale, which reads as a fault rather than as the
  // missing reference it is.
  for (const generated of [0, -1, -1000, NaN, Infinity, null, undefined, "1757700000000"]) {
    assert.equal(powerCurrentBaseline(generated, REQUEST_STARTED), null, String(generated));
    const state = loadedWith([row("m1", { system: measured })], generated);
    assert.equal(state.status, "error", String(generated));
    assert.equal(state.snapshot, null);
    for (const line of powerCurrentLines(state, "m1", REQUEST_STARTED)) {
      assert.equal(line.state, "unavailable");
    }
  }
  // A monotonic reading that is not a number is no anchor either.
  for (const started of [NaN, Infinity, undefined, "5000"]) {
    assert.equal(powerCurrentBaseline(GENERATED, started), null, String(started));
  }
  // CONTROL: a real pair is a baseline, and 0 is a legitimate monotonic start.
  assert.deepEqual(powerCurrentBaseline(GENERATED, 0),
    { generatedUnixMs: GENERATED, requestStartedMonotonicMs: 0 });
});

test("cells age on the clock, not on the next fetch", () => {
  const state = ready([row("m1", { system: measured })]);
  const fresh = lineOf(powerCurrentLines(state, "m1", REQUEST_STARTED), "system");
  assert.equal(fresh.state, "value");

  // The same snapshot, later. Nothing was refetched; the reading is stale
  // because time passed, which is the point of ticking the clock separately.
  const later = lineOf(powerCurrentLines(state, "m1", REQUEST_STARTED + POWER_FRESH_MS + 1000), "system");
  assert.equal(later.state, "stale");
  assert.ok(later.ageMs > POWER_FRESH_MS, "and it says how old");

  // A monotonic source that went backwards judges nothing.
  for (const line of powerCurrentLines(state, "m1", REQUEST_STARTED - 1)) {
    assert.equal(line.reason, "no_reference");
  }
});

test("before anything arrives, a cell is loading — not zero and not an error", () => {
  const lines = powerCurrentLines(POWER_CURRENT_LOADING, "m1", REQUEST_STARTED);
  assert.equal(lines.length, 5);
  for (const line of lines) {
    assert.equal(line.state, "unavailable");
    assert.equal(line.reason, "loading_snapshot");
    assert.match(line.detail, /\S/);
  }
  assert.deepEqual(lines.map((line) => line.domain), ["system", "cpu", "gpu", "dram", "cpu_gpu"]);
  // Unknown events leave the state exactly as it was.
  const state = ready([row("m1", { system: measured })]);
  assert.equal(powerCurrentReduce(state, { type: "nonsense" }), state);
  assert.equal(powerCurrentReduce(state, undefined), state);
  assert.equal(powerCurrentReduce(state, { type: "reset" }).status, "loading");
});

test("a registered but silent machine still answers for every domain", () => {
  // Every registered machine gets a row, and every row answers for every
  // domain. A silent machine is a row full of reasons, not a missing row.
  const silent = row("m3", {
    system: { reason: "absent" }, cpu: { reason: "source_unverified", source: "hwmon:ina226" },
    gpu: { reason: "counter_idle_unverified" }, dram: { reason: "scope_unverified" },
  });
  const lines = powerCurrentLines(ready([silent]), "m3", REQUEST_STARTED);
  assert.deepEqual(lines.map((line) => line.state), ["unavailable", "unavailable", "unavailable", "unavailable", "unavailable"]);
  assert.deepEqual(lines.map((line) => line.reason),
    ["absent", "source_unverified", "counter_idle_unverified", "scope_unverified", "absent"]);
  for (const line of lines) assert.match(line.detail, /\S/, "each dash is explained");
});

test("a row the hub could not key is dropped, not stored under a guessed id", () => {
  const raw = normalizeFleetPowerCurrent(payload([
    row("m1", { system: measured }), { window_end_unix_ms: GENERATED, domains: {} },
    { machine_id: "", domains: {} }, { machine_id: 7, domains: {} }, null, "nope",
  ]));
  assert.deepEqual([...raw.machines.keys()], ["m1"]);
  // An old hub that sends no machines array at all is empty, not a crash.
  assert.equal(normalizeFleetPowerCurrent({ generated_unix_ms: GENERATED, domains: [] }).machines.size, 0);
});

/* --- one session's fleet is never shown to the next ----------------------- */

test("a response for the previous account cannot repopulate the new one", () => {
  const A = "token-account-a";
  const B = "token-account-b";
  const forA = powerCurrentReduce(POWER_CURRENT_LOADING, {
    type: "loaded", session: A,
    snapshot: normalizeFleetPowerCurrent(payload([row("a-only", { system: measured })])),
    baseline: powerCurrentBaseline(GENERATED, REQUEST_STARTED),
  });
  assert.equal(forA.status, "ready");
  assert.equal(lineOf(powerCurrentLines(forA, "a-only", REQUEST_STARTED), "system").watts, 118);

  // The account switched. A request already in flight for A lands and writes
  // state; the effect's cleanup has not run yet. Read under B, that state is
  // nothing fetched yet — not A's machines under B's name.
  const underB = powerCurrentForSession(forA, B);
  assert.equal(underB.status, "loading");
  assert.equal(underB.snapshot, null);
  assert.equal(powerCurrentMachine(underB, "a-only"), undefined);
  for (const line of powerCurrentLines(underB, "a-only", REQUEST_STARTED)) {
    assert.equal(line.state, "unavailable");
    assert.equal(line.reason, "loading_snapshot");
  }

  // Signing out entirely is the same answer.
  assert.equal(powerCurrentForSession(forA, null).status, "loading");
  assert.equal(powerCurrentForSession(forA, undefined).status, "loading");
  assert.equal(powerCurrentForSession(forA, "").status, "loading");

  // CONTROL: A's own session still reads A's snapshot.
  assert.equal(powerCurrentForSession(forA, A), forA);
  assert.equal(lineOf(powerCurrentLines(powerCurrentForSession(forA, A), "a-only", REQUEST_STARTED), "system").watts, 118);

  // A failure recorded for A is not shown to B either.
  const failedA = powerCurrentReduce(forA, { type: "failed", session: A, error: "hub down" });
  assert.equal(powerCurrentForSession(failedA, B).status, "loading");
  assert.equal(powerCurrentForSession(failedA, A).error, "hub down");
});

test("no session entitled to ask means nothing was asked, and nothing is claimed", () => {
  // The login and setup screens, a logged-out tab, and a role without
  // fleet.read all land here. It is not an error and not a pending fetch.
  const idle = powerCurrentReduce(POWER_CURRENT_LOADING, { type: "idle" });
  assert.equal(idle.status, "idle");
  assert.equal(idle.snapshot, null);
  const lines = powerCurrentLines(idle, "m1", REQUEST_STARTED);
  assert.equal(lines.length, 5);
  for (const line of lines) {
    assert.equal(line.state, "unavailable");
    assert.equal(line.reason, "no_session");
    assert.match(line.detail, /fleet read access/);
  }
  // Idle is session-independent: there is no session to mismatch.
  assert.equal(powerCurrentForSession(idle, "any-token").status, "idle");
});
