/**
 * How a machine's virtualization is described.
 *
 * A KVM host and a KVM guest both report a virtualization system of "kvm", so
 * the system alone does not say which a machine is — and "kvm" on its own
 * reads as "this is a VM", which for a host is the opposite of the truth.
 *
 * Everything here states the REPORTED FACT and stops there. A detected host
 * role does not prove the machine is bare metal (nested virtualization
 * exists), does not prove anything is running on it, and "guest" does not mean
 * "virtual machine" — gopsutil reports docker and lxc through the same field.
 * Availability is not certification, the same boundary the power work holds.
 */
export const VIRT_HOST = "host";
export const VIRT_GUEST = "guest";

export function virtualizationDisplay(system, role) {
  const s = typeof system === "string" ? system.trim() : "";
  if (s === "") {
    return {
      text: "—",
      role: "",
      title: "This machine reports no virtualization system.",
    };
  }
  const r = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (r === VIRT_HOST) {
    return {
      text: `${s} · host`,
      role: VIRT_HOST,
      title: `The agent reports this machine as a ${s} host.`,
    };
  }
  if (r === VIRT_GUEST) {
    return {
      text: `${s} · guest`,
      role: VIRT_GUEST,
      title: `The agent reports this machine as a ${s} guest.`,
    };
  }
  return {
    text: `${s} · role unknown`,
    role: "",
    title: `The agent reported ${s} but not whether this machine is the host or the guest. Both report ${s}, so this does not say which.`,
  };
}
