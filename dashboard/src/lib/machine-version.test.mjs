import test from "node:test";
import assert from "node:assert/strict";
import { machineVersionOf } from "./machine-version.mjs";

const row = (id, version) => ({ machine_id: id, agent_version: version });

test("a hub with no versions endpoint costs the fleet a version, not the page", () => {
  // `{}` is what an older hub, or one with the endpoint disabled, answers.
  // `data?.agents.find(...)` guarded `data` and not `agents`, so this reached
  // `.find` on undefined and took the whole Overview down through MachineCard.
  for (const data of [{}, { agents: undefined }, { agents: null }, { agents: "none" },
                      { agents: 7 }, { agents: {} }, undefined, null]) {
    assert.equal(machineVersionOf(data, "m1"), undefined, JSON.stringify(data));
  }
});

test("a known machine still gets its row, and an unknown one gets nothing", () => {
  const data = { agents: [row("m1", "1.2.2"), row("m2", "1.2.3"), null, { machine_id: 7 }] };
  assert.equal(machineVersionOf(data, "m1").agent_version, "1.2.2");
  assert.equal(machineVersionOf(data, "m2").agent_version, "1.2.3");
  assert.equal(machineVersionOf(data, "m9"), undefined, "absent is not the first row");
  // A malformed entry beside good ones is skipped, not crashed on.
  assert.equal(machineVersionOf(data, ""), undefined);
  assert.equal(machineVersionOf(data, undefined), undefined);
  assert.equal(machineVersionOf({ agents: [] }, "m1"), undefined);
});
