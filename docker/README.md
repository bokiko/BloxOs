# Install BloxOS with Docker Compose

The hub side of a deployment runs as containers: Caddy for TLS, the hub API,
and the dashboard. Agents stay native services on every managed machine;
they are not containerized.

For a first installation, follow the [step-by-step walkthrough](../README.md#get-started),
including prerequisites, editing `.env`, and account setup. The commands below
assume your account can access Docker; use `sudo docker` as in that walkthrough
if it cannot. This page provides
additional configuration and troubleshooting details.

## Compose: the supported hub deployment

Use Docker Compose v2 on a Linux amd64 or arm64 host. TCP ports 80 and 443 and
UDP port 443 must be free, and browsers and agents must be able to reach the host. From a
clone of the released `v1.7.4` tag:

```bash
cd docker
cp .env.example .env
# Edit .env: set HUB_HOST to this machine's reachable hostname or IP.
# Add BLOXOS_VERSION=1.7.4 to use this release's images.
docker compose pull
docker compose up -d --no-build
```

After full CI and the Compose smoke test pass, stable release tags publish
`ghcr.io/bokiko/bloxos-hub` and `ghcr.io/bokiko/bloxos-dashboard` for
amd64 and arm64, tagged with the version (without `v`) and `latest`. Pin
`BLOXOS_VERSION` in `.env` for a predictable upgrade target. Prerelease tags
such as `1.2.1-rc.1` do not replace `latest`. A merge to `main`
does not publish images. To build your chosen source revision instead, use
`docker compose up -d --build` in place of the pull/start commands.

Then read the first-boot setup token and open the dashboard:

```bash
docker compose exec hub cat /data/.bloxos/setup-token
```

Open `https://<HUB_HOST>`, configure [browser trust](#browser-trust), enter the token, and create
the admin account. Use **Add Machine** to enroll agents; the generated
command carries the CA fingerprint, so agents verify the hub without any
manual trust step.

What the stack contains:

- `caddy` serves `https://HUB_HOST` with its internal CA and forwards API,
  WebSocket, installer, and download paths to the hub and everything else to
  the dashboard. It runs unprivileged as the hub's uid so the hub can read
  the CA it writes.
- `hub` derives `PUBLIC_URL` from `HUB_HOST` and reads Caddy's root
  certificate read-only from the `caddy-data` volume to pin it into install
  commands.
- `dashboard` is served same-origin behind Caddy.
- `caddy-init` runs once to hand the Caddy volumes to the unprivileged uid.

`HUB_HOST` is a bare hostname or IP address, no scheme, no port; the stack
publishes 80 and 443. IP addresses work because Caddy is given a default
SNI for clients that connect without one.

Client addresses: Caddy forwards the client address to the hub and the hub
accepts it from peers on the private Compose network, so per-address rate
limits and the terminal audit see clients, not Caddy. The hub's port is not
published, so only the stack's own containers can reach it. On rootless
Docker the address Caddy sees is the port forwarder's, so all external
clients share one address there; rootful Docker passes the real address.

Operations:

- Upgrade: follow [Upgrades](#upgrades) below.
- Use the [consistent backup and clean restore procedure](../docs/backup-restore.md)
  for the database, secrets, signing key and Caddy CA/configuration. Do not copy
  only the live SQLite file or delete volumes to repair a failed upgrade.
- Root certificate for browsers:
  `docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt`.
- Logs: `docker compose logs -f hub`.

## Upgrades

With the [host updater](../docs/system-updates.md) configured, use:

```sh
sudo bloxos-update update
```

The dashboard's **Settings → Updates** button starts the same worker.
It preserves the selected Compose project and volumes, stages both images,
backs up the stopped deployment and verifies the public website before
accepting the update. Any installation without the worker, including a fresh
Compose installation, needs the linked one-time setup first.
The manual instructions below are for installations **not** managed by that
worker; do not omit an updater-managed override when operating its stack.

These instructions update an existing **Compose** installation, not native
systemd services. Healthy new containers can coexist with an older native
website still serving port 443. On a mixed host, first identify the actual
upstreams; never choose Docker just because a Compose file exists. See
[upgrade verification](../docs/verified-upgrades.md).

Back up first using the [backup and restore guide](../docs/backup-restore.md),
then upgrade from your existing Compose directory with the same project name
and any existing overrides. Preserve volumes, keys, and your `.env`.

### 1. Pull and start the new images

Set `BLOXOS_VERSION` in your existing `.env` to the desired published version,
then:

```bash
docker compose pull hub dashboard
docker compose up -d --no-build hub dashboard
```

Source-build installations instead update to a chosen tested source revision
and run `docker compose up -d --build`.

For v1.2.2's stable onboarding pins, add `reuse_private_keys` inside your
existing Caddy `tls internal` block, retaining `key_type rsa2048`. Compare the
[bundled Caddyfile](Caddyfile); preserve custom routes, settings and CA data.
Pulling hub/dashboard images does not update this bind-mounted configuration.
Validate and reload the configuration after editing:

```bash
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Without that proxy change, generate a fresh command if renewal changes the key
after you copied it. Never remove pinning to work around a mismatch. See
[TLS trust for onboarding](../docs/configuration.md#tls-trust-for-onboarding).

### 2. Verify

Health through the container network (plain HTTP inside the stack, no TLS
flags):

```bash
docker compose exec caddy wget -qO- http://hub:4000/health
```

Expected: `{"status":"ok"}`. This proves internal liveness only—not the build
or that your public URL reaches this container. Check both public components
as described in [upgrade verification](../docs/verified-upgrades.md).
Then, in the dashboard, generate a **fresh** Add
Machine command: v1.2.0 mints one-line onboarding links under `/api/join/`,
which works with older proxies that already forward `/api/*` to the hub.
No Caddyfile edit is required for those new commands. (The legacy `/join/`
path remains as an alias; enrollment links expire after 15 minutes either
way.)

The hub serves agent updates too; eligible older agents can update and restart.
See the [upgrade notes](../README.md#update-an-existing-installation) for
legacy-agent and offline-signing cautions.

### Older links and custom proxies

Pulling images does not update a bind-mounted Caddyfile. If an older proxy
does not forward `/join/*`, previously copied links can still reach the
dashboard's HTML 404. **Generate a fresh command after upgrading**;
do not edit your proxy just to rescue a short-lived old link.

For custom proxies, `/api/*` must reach the hub. The optional legacy `/join/*`
alias also needs forwarding if you intend to keep using it. Compare the
[Compose Caddyfile](Caddyfile) or [native sample](../scripts/caddy/Caddyfile)
with your own configuration, preserving custom TLS settings, CA and keys.
Do not overwrite a customized configuration with a release sample.

## Browser trust

Caddy creates a private certificate authority for this installation. A browser
that does not trust it will show a certificate warning. Obtain its root
certificate directly from your Docker host over a trusted administrative
connection:

```sh
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./bloxos-root.crt
```

Import this public root certificate into the trusted certificate store used by
your browser/operating system, then reopen `https://<HUB_HOST>`. Only trust a
root obtained from your own verified host; do not download an unverified
certificate from a warning page. Never copy or distribute Caddy's private keys.

Trusting a root CA grants it the ability to authenticate sites for that client.
On managed devices, follow your administrator's certificate policy. A properly
configured publicly trusted certificate is an alternative for custom deployments.

### Import the certificate on your browsing computer

Use the `bloxos-root.crt` you copied from your server. Choose the instructions
for the computer/browser where you will open the dashboard:

**Windows — Edge or Chrome**

1. Press **Win+R**, type `certmgr.msc`, and press Enter. This opens your user
   certificate manager.
2. Expand **Trusted Root Certification Authorities**, then select **Certificates**.
3. Right-click **Certificates** → **All Tasks** → **Import**.
4. Select your `bloxos-root.crt` file. Keep **Trusted Root Certification Authorities**
   as the destination, finish the wizard, and confirm the trust prompt for your
   own server's certificate.
5. Close and reopen the browser, then visit your BloxOS HTTPS address.

[Microsoft's certificate-store reference](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/certificate-stores)
explains the difference between user and machine stores.

**macOS — Safari or Chrome**

1. Open **Keychain Access** using Spotlight. Select the **login** keychain.
2. Choose **File → Import Items**, select `bloxos-root.crt`, and import it.
3. Open the imported certificate, expand **Trust**, and set **Secure Sockets
   Layer (SSL)** to **Always Trust**.
4. Close that window and authenticate if prompted to save the change. Reopen
   the browser and visit your BloxOS HTTPS address.

[Apple's certificate trust instructions](https://support.apple.com/guide/keychain-access/change-the-trust-settings-of-a-certificate-kyca11871/mac)
describe these controls.

**Firefox — including on Linux**

1. Open **Settings** and search for **certificates**. Open **View Certificates**.
2. Select **Authorities** → **Import**, then choose `bloxos-root.crt`.
3. Enable **Trust this CA to identify websites**, confirm, and reopen your
   BloxOS HTTPS address.

Import into **Authorities**, not **Your Certificates**. See
[Mozilla's root-certificate import instructions](https://wiki.mozilla.org/CA/Changing_Trust_Settings).

The generated agent commands handle their own CA and key verification; browser
trust and agent enrollment are separate. Keep the Caddy data volume across
upgrades so this identity does not change.

## Troubleshooting the first start

- **Page will not open:** check `docker compose ps`, that ports 80/443 are free,
  and that `HUB_HOST` resolves to a reachable address. `localhost` on an agent
  means that agent, not the hub.
- **Certificate warning:** follow [Browser trust](#browser-trust); do not remove
  certificate verification from enrollment commands.
- **Setup token not ready:** wait for the hub to be healthy, then retry the token
  command. Check `docker compose logs --tail=100 hub caddy` locally if needed.
  Logs may contain setup information—redact secrets before posting them.
- **Expired enrollment command:** generate a fresh command in Add Machine. Linux
  join links expire after 15 minutes. Never paste a real join link into an issue.

For persistent failures, use the [bug report template](https://github.com/bokiko/bloxos/issues/new/choose)
with your version, platform and sanitized error output.

## Smoke test

`scripts/smoke/compose-enroll.sh` is the end-to-end gate for this stack. On
a disposable Linux host with Docker, systemd, and passwordless sudo it
brings the stack up, completes setup through the API, mints an install
token, runs the generated Linux command on that same host so it enrolls as
an agent, asserts the machine is online with the CA pinned, then removes
the agent and the stack. It also backs up and restores the initialized hub
with its original state/identity into a temporary network-isolated project.
CI runs it on source/container changes, and tags must pass both smoke and the
full CI suite on their exact commit before publishing images. Locally:

```bash
SMOKE_CONFIRM_DISPOSABLE=1 HUB_HOST=127.0.0.1 scripts/smoke/compose-enroll.sh
```

## Images

| Image | Dockerfile | Contents | Port |
|---|---|---|---|
| hub | `Dockerfile.hub` | hub binary plus the agent binaries the hub serves | 4000 |
| dashboard | `Dockerfile.dashboard` | Next.js standalone server | 3000 |

Both build from the repository root (the hub and agent modules share
`proto/` through a local replace directive) and run as unprivileged users.
The sections below run them individually, without Caddy; published images
are not part of this step.

### Build

```bash
docker build -f Dockerfile.hub -t bloxos-hub .
docker build -f Dockerfile.dashboard -t bloxos-dashboard .
```

The hub image builds the hub and all three agent payloads from the same source
with `CGO_ENABLED=0`, `-trimpath`, no VCS stamping, and stripped binaries.
Reproducibility also depends on the toolchain and dependencies. Before
promotion, the release gate checks the actual payload hashes from both hub
image architectures against published agent identities. Changed agent bytes
require a new agent release number; unchanged bytes do not trigger a rollout.

### Architecture

Every hub image, whatever architecture it runs on, carries Linux agents for
both amd64 and arm64 (cross-compiled in the build stage, no emulation) and the
Windows amd64 agent, so one hub serves a mixed fleet. The hub picks the Linux
build from the `arch` the installer and the agent's self-updater request
(`/download/agent?os=linux&arch=amd64|arm64`), answers 404 with a message
naming the architecture when it has no binary for it, and the installer
refuses to install an ELF whose `e_machine` does not match the host CPU. An
agent reports its architecture on connect, and the hub announces only that
architecture's SHA to it. A request without `arch`, or an agent that reports
none, gets the amd64 build, as before.

### Run the hub alone

The hub refuses to start without an origin policy, so `PUBLIC_URL` (or
`ALLOWED_ORIGINS`) is required. All state lives in one volume mounted at
`/data`: `bloxos.db`, and `.bloxos/` holding the setup token, JWT secret and
update-signing key.

```bash
docker run -d --name bloxos-hub -p 127.0.0.1:4000:4000 \
  -e PUBLIC_URL=http://127.0.0.1:4000 \
  -v bloxos-data:/data \
  bloxos-hub
docker exec bloxos-hub cat /data/.bloxos/setup-token
```

This standalone example is local-only. Use the Caddy+HTTPS Compose stack for
LAN access. Inside the image the hub listens on `0.0.0.0:4000` and runs as uid 65532.
The managed agent bundle is root-owned and read-only in
`/usr/local/bin/agents/`, beside the hub executable. Legacy paths under
`/usr/local/lib/bloxos/` are hard links to the same payloads; no
`BLOXOS_AGENT_BINARY*` setting is needed for the default installation. See
[agent delivery precedence](../docs/native-agent-upgrades.md) before adding an override. Compose sets
`BLOXOS_PIN_DIAL_ADDR=caddy:443` so pin verification reaches Caddy directly.
This also handles a loopback `PUBLIC_URL`, which otherwise points back into
the hub container itself. SNI and certificate verification still use the
configured public identity. For a private
CA, mount the CA certificate and point `BLOXOS_CA_CERT` at it. Back up the
`/data` volume; losing the update-signing key strands agent self-update.

### Run the dashboard alone

```bash
docker run -d --name bloxos-dashboard -p 127.0.0.1:3000:3000 bloxos-dashboard
```

The dashboard is built with an empty `NEXT_PUBLIC_HUB_URL`, so it expects
to be served from the same origin as the hub API, which a reverse proxy in
front of both provides. It runs as the `node` user.

Both images carry a healthcheck against `/health` (hub) and `/login`
(dashboard).
