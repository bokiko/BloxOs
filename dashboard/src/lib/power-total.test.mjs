import test from "node:test";
import assert from "node:assert/strict";
import { powerOverlapWarning, powerDomainLines, powerLineDisplay } from "./power-cell.mjs";
import { combinedSeries, domainLabel, normalizeFleetPowerCurrent, currentReading } from "./fleet-power.mjs";

test("integrated hardware gets a visible caveat, including mixed integrated/discrete inventory", () => {
  for (const [cpu, vendor, model] of [
    ["AMD Ryzen AI 9 HX 370", "AMD", "Radeon 890M"],
    ["AMD Ryzen AI MAX+ 395", "Advanced Micro Devices", "Radeon 8060S Graphics"],
    ["AMD Ryzen 7", "AMD", "Radeon Graphics"],
    ["Intel Core i7", "Intel", "UHD Graphics 770"],
    ["Intel Core Ultra", "Intel", "Arc Graphics"],
  ]) {
    assert.match(powerOverlapWarning({cpu_model:cpu, gpu_devices:[
      {vendor:"NVIDIA",model:"RTX 4090"}, {vendor,model},
    ]}), /Integrated graphics detected/, model);
  }
});

test("unverified inventory never silently promises no overlap", () => {
  for (const hw of [undefined, {}, {gpu_models:["RTX 4090"]}, {gpu_devices:[]},
    {gpu_devices:[{vendor:"AMD",model:"Unknown"}]}, {gpu_devices:[null]},
    {gpu_devices:[{vendor:"NVIDIA",model:"GB10"}]}, {gpu_devices:[{vendor:"NVIDIA",model:"Future SoC"}]}]) {
    assert.match(powerOverlapWarning(hw), /unverified.*may double-count/);
  }
  assert.equal(powerOverlapWarning({gpu_devices:[{vendor:"NVIDIA",model:"RTX 4090"}]}), "");
  assert.equal(powerOverlapWarning({gpu_devices:[{vendor:"AMD",model:"Radeon RX 7900 XTX"}]}), "");
});

test("total comes from the server, carries its warning and ages with its window", () => {
  const now=1_000_000;
  const machine={window_end_unix_ms:now, power_hardware:{cpu_model:"AMD Ryzen AI",gpu_devices:[{vendor:"AMD",model:"Radeon 890M"}]},
    domains:{cpu:{watts:48,kind:"measured"},gpu:{watts:299,kind:"measured"},cpu_gpu:{watts:347,kind:"measured",source:"cpu+gpu:rapl-package"}}};
  const total=powerDomainLines(machine,now).find(l=>l.domain==="cpu_gpu");
  assert.equal(total.watts,347);
  assert.match(total.warning,/Integrated/);
  assert.match(powerLineDisplay(total).title,/30-second mean/);
  assert.equal(powerDomainLines(machine,now+200_000).find(l=>l.domain==="cpu_gpu").state,"stale");
  delete machine.domains.cpu_gpu;
  assert.equal(powerDomainLines(machine,now).find(l=>l.domain==="cpu_gpu").state,"unavailable");
});

test("total chart uses the concise TOTAL label", () => {
  assert.equal(domainLabel("cpu_gpu"),"TOTAL");
  const snapshot=normalizeFleetPowerCurrent({generated_unix_ms:1000,domains:[{domain:"cpu_gpu",measured:{watts:347,machines:1,oldest_contributor_end_unix_ms:1000,newest_contributor_end_unix_ms:1000}}]});
  assert.equal(currentReading(snapshot,"cpu_gpu","measured",1000).watts,347);
  assert.equal(combinedSeries(null,snapshot,"cpu_gpu")[0].label,"TOTAL");
});
