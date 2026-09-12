/**
 * Which agent version row belongs to a machine.
 *
 * Small enough to look obviously correct, which is exactly why it was written
 * inline and got it wrong: `data?.agents.find(...)` guards `data` and not
 * `agents`, so a hub answering /api/versions with `{}` — an older build, or
 * one where the endpoint is not enabled — reached `.find` on undefined and
 * took the whole Overview down through MachineCard. A missing optional feature
 * became a blank page.
 *
 * An absent or malformed list means no version is known for this machine.
 * That is what undefined already meant here; it is not an error and it is
 * certainly not a reason to stop rendering the fleet.
 */
export function machineVersionOf(data, machineID) {
  const agents = data?.agents;
  if (!Array.isArray(agents)) return undefined;
  if (typeof machineID !== "string" || machineID === "") return undefined;
  return agents.find((agent) => agent?.machine_id === machineID);
}
