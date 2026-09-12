import test from "node:test";
import assert from "node:assert/strict";
import { virtualizationDisplay } from "./virtualization.mjs";

test("a host is not described the same way as the guest it runs", () => {
  const host = virtualizationDisplay("kvm", "host");
  assert.equal(host.text, "kvm · host");
  assert.equal(host.title, "The agent reports this machine as a kvm host.");

  const guest = virtualizationDisplay("kvm", "guest");
  assert.equal(guest.text, "kvm · guest");
  assert.equal(guest.title, "The agent reports this machine as a kvm guest.");

  // Case and padding come from an external tool, not from us.
  for (const raw of ["HOST", " Host ", "hOsT"]) {
    assert.equal(virtualizationDisplay("kvm", raw).text, "kvm · host", raw);
  }
});

test("a missing role is unknown, never guessed in either direction", () => {
  // An agent predating the field, or a platform where the role is not
  // detected. "kvm" alone reads as "this is a VM", which for a host is the
  // opposite of the truth — so it must not silently become either answer.
  for (const missing of [undefined, null, "", "   ", 7, {}, "supervisor"]) {
    const shown = virtualizationDisplay("kvm", missing);
    assert.equal(shown.text, "kvm · role unknown", JSON.stringify(missing));
    assert.equal(shown.role, "", "neither host nor guest");
    assert.match(shown.title, /does not say which/);
  }
});

test("no virtualization system means nothing to qualify", () => {
  // A role with no system is not evidence of anything, including when the
  // role itself looks confident.
  for (const [system, role] of [["", "host"], ["   ", "guest"], [undefined, "host"],
                                [null, "guest"], [7, "host"], [{}, "guest"]]) {
    const shown = virtualizationDisplay(system, role);
    assert.equal(shown.text, "—", JSON.stringify([system, role]));
    assert.equal(shown.role, "");
  }
});

test("an unfamiliar hypervisor is reported, not rejected", () => {
  assert.equal(virtualizationDisplay("xen", "guest").text, "xen · guest");
  assert.equal(virtualizationDisplay("wsl", "host").text, "wsl · host");
  assert.equal(virtualizationDisplay("docker", "").text, "docker · role unknown");
});

test("the report is stated and nothing beyond it is claimed", () => {
  // A detected host role does NOT prove the machine is bare metal — nested
  // virtualization exists — and does not prove anything is running on it.
  const host = virtualizationDisplay("kvm", "host");
  for (const overclaim of [/bare metal/i, /not itself/i, /physical/i, /runs/i, /running/i]) {
    assert.doesNotMatch(host.title, overclaim, String(overclaim));
  }

  // And "guest" is not a synonym for "virtual machine": gopsutil reports
  // containers through the same field.
  for (const system of ["docker", "lxc", "podman"]) {
    const guest = virtualizationDisplay(system, "guest");
    assert.equal(guest.text, `${system} · guest`);
    assert.doesNotMatch(guest.title, /virtual machine|\bVM\b/i, system);
    assert.match(guest.title, new RegExp(`reports this machine as a ${system} guest`));
  }

  // Absence is absence. It is not evidence of bare metal either.
  const none = virtualizationDisplay("", "");
  assert.doesNotMatch(none.title, /bare metal|physical|not virtual/i);
  assert.match(none.title, /reports no virtualization system/);
});
