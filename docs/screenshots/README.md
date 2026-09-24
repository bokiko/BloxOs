# Dashboard gallery

BloxOS uses **Monoform with the Lumen visual finish**, in **Dark** and
**Bright** appearances. These captures show the current interface with a
synthetic fleet. They are product screenshots rather than design concepts, and
they contain no private fleet data.

## Fleet overview

The Overview keeps fleet power and availability at the top, followed by the
machine list used for everyday work. Missing readings remain unavailable rather
than being displayed as zero.

![BloxOS v1.7.6 Overview in Dark appearance with fleet power, availability, and four synthetic machines](https://cdn.jsdelivr.net/gh/bokiko/bloxos@f97a1cbb895f4452bba178cde8b025a0da6b5a88/docs/screenshots/overview-v1.7.6-dark.png)

## Machine detail

Open a machine to inspect live readings, power, services, containers, metrics,
AI sessions, notes, and—on Linux—a re-authenticated terminal. This fixture also
shows how BloxOS qualifies a Total reading when integrated graphics may overlap
with CPU package power.

![BloxOS v1.7.6 Machine Detail in Dark appearance with live readings and component power](https://cdn.jsdelivr.net/gh/bokiko/bloxos@f97a1cbb895f4452bba178cde8b025a0da6b5a88/docs/screenshots/machine-v1.7.6-dark.png)

## Hardware inventory

Inventory collects the hardware reported by every agent into searchable,
sortable, groupable, and exportable tables.

![BloxOS Inventory showing fleet totals and a searchable machine hardware table](https://cdn.jsdelivr.net/gh/bokiko/bloxos@f97a1cbb895f4452bba178cde8b025a0da6b5a88/docs/screenshots/inventory-v1.7.6-dark.png)

## AI Sessions

AI Sessions shows metadata for supported Claude Code, Codex, and Kimi
processes. It never collects prompts, responses, transcripts, terminal output,
or full project paths.

![BloxOS AI Sessions showing one synthetic Claude Code session](https://cdn.jsdelivr.net/gh/bokiko/bloxos@f97a1cbb895f4452bba178cde8b025a0da6b5a88/docs/screenshots/ai-sessions-v1.7.6-dark.png)

## Agent versions and rollout

Versions exposes the state that matters during an agent rollout: signing,
delivery, platform progress, blockers, served binaries, and the build reported
by each connected machine.

[How agent rollout status works →](../versions.md)

## Bright appearance

Bright changes contrast without changing information architecture or behavior.

![BloxOS v1.7.6 Overview in Bright appearance](https://cdn.jsdelivr.net/gh/bokiko/bloxos@f97a1cbb895f4452bba178cde8b025a0da6b5a88/docs/screenshots/overview-v1.7.6-bright.png)

![BloxOS v1.7.6 Machine Detail in Bright appearance](https://cdn.jsdelivr.net/gh/bokiko/bloxos@f97a1cbb895f4452bba178cde8b025a0da6b5a88/docs/screenshots/machine-v1.7.6-bright.png)

## Metric history states

Loading, request failure, confirmed empty history, refresh failure with retained
readings, and a single-point response have distinct presentations. The
[state captures](../reviews/lumen-visual-finish/pre-merge/README.md) document
those cases and their verification limits.

## Capture notes

- Overview and Machine Detail were captured from the v1.7.6 synthetic staging
  fixture. Inventory and AI Sessions use the Lumen visual-validation fixture;
  those surfaces remain representative of v1.7.6.
- Fixture names, local addresses, readings, alerts, and connection timing are
  illustrative. They are not hardware benchmarks or production data.
- The images are unmodified browser captures. Embedded URLs use a commit-pinned
  jsDelivr copy of the files stored beside this README.
- Unavailable sensors are left unavailable. The fixture does not invent data to
  make a screenshot look more complete.
- The app's canonical [logo SVGs](../../dashboard/public/brand/) are reused by
  the root README; no separate lookalike logo is maintained here.

[Design guide](../themes/README.md) · [Back to BloxOS](../../README.md)
