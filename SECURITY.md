# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in BloxOS, please report
it privately. **Do not open a public GitHub issue.**

Use GitHub's [private vulnerability reporting](https://github.com/bokiko/bloxos/security/advisories/new)
on this repository, with a description of the issue, reproduction steps, and
any proof-of-concept. This is the only channel we monitor for reports; please
do not email, since GitHub's `@users.noreply.github.com` addresses cannot
receive mail.

You can expect:

- An acknowledgement within **5 business days**.
- A reply with our assessment and intended fix timeline within **15 business
  days**.
- Public disclosure (advisory + patched release) coordinated with you once a
  fix is available.

## Supported versions

Fixes land on `main` and ship in the next numbered release. Run the latest
release; older releases do not receive backported fixes.

## Scope

In scope:

- The hub HTTP/WebSocket API (`hub/`).
- The agent binary and generated install endpoints (`agent/`, hub-served
  `/install.sh`, hub-served `/install.ps1`).
- The dashboard (`dashboard/`) when served by an unmodified hub.

Out of scope:

- Misconfigurations of operator-controlled infrastructure (Caddy reverse
  proxy, systemd unit overrides, third-party API endpoints).
- Vulnerabilities requiring a pre-compromised admin account or physical
  access to the hub host.

## Hardening notes

- Agents must authenticate with durable, per-machine secrets. Install tokens
  are single-use.
- Terminal sessions require a per-session PIN gate, bcrypt-verified. The
  `terminal_sessions` table records metadata only — machine, user, source
  IP, start/end and status — never terminal input or output. A full
  product-wide audit log is planned but not shipped yet.
- Database file permissions are enforced at `0600`.
- Browser-side terminal tokens are short-lived (1-minute) and scoped to a
  single session ID.
