# gladys-homelab-monitor

The Linux machines on your network in [Gladys Assistant](https://gladysassistant.com),
Webmin-style: CPU, memory, disks, temperatures, drive health, updates and failed
services, as gauges on the dashboard and as alerts in scenes.

Each machine runs Prometheus **node_exporter**, a small read-only agent packaged by
every major distribution. The integration reads it directly over the LAN — **no
Prometheus server, no SSH keys, no admin passwords** in Gladys.

Complements [gladys-host-monitoring](https://github.com/prohand/gladys-host-monitoring),
which watches the machine Gladys itself runs on: this one watches the others.

## On each machine

```bash
sudo apt install prometheus-node-exporter prometheus-node-exporter-collectors
```

Debian, Ubuntu, Raspberry Pi OS and Proxmox VE all ship it. It starts at once and
serves `http://<machine>:9100/metrics`. The `-collectors` package adds the pending
updates, reboot-required, SMART and NVMe readings; without it those features are
simply absent. Port 9100 should be reachable from the Gladys host only — restrict it
with your firewall if the LAN is not trusted.

## Features (per machine)

| Feature | Type |
|---|---|
| Status | text — Online / Unreachable |
| CPU usage, Memory usage, Swap usage | % |
| Load (1 min) | number |
| CPU temperature | °C (device temperature, kept out of room averages) |
| Disk `<mount>` | % per real filesystem, like `df` (no tmpfs, snaps, Docker layers or network mounts) |
| Drive `<name>` health / temperature / life remaining | SMART and NVMe |
| Network `<nic>` in / out | Mbit/s, physical NICs only |
| Uptime | days |
| Updates pending, Reboot required, Failed services | apt / systemd |
| Operating system, Kernel | text |

Readings a machine does not report (no temperature in a VM, no DMI on a Pi) are
left out rather than shown as zero.

## Dashboard widgets

- **Linux host** — one machine: CPU, memory, disk, CPU temperature, swap and load
  gauges coloured against the alert thresholds, plus uptime, memory, network,
  updates, reboot, services and every drive. *Details layout*: **Rows** (default —
  best in a narrow dashboard column, where label and value sit close) or **Cards**
  (a compact grid; Gladys sizes its cells for posters, so text is cut short in a
  wide widget).
- **Linux hosts** — every machine on one line, the ones needing attention first.

## Scenes

- **Trigger: Linux host alert** — raised / cleared, filter by host and alert:
  unreachable (two missed reads), CPU (two reads over), memory, disk, CPU temperature,
  failing drive, failed services, reboot required, RAID degraded. Thresholds are in the
  configuration; an alert clears 5 points below its threshold. Variables:
  `host_name`, `alert_label`, `status`, `value`, `detail`.
- **Action: Get Linux host status** — CPU, memory, fullest disk, temperature, uptime,
  updates and current alerts, for a message.

## Configuration

`Hosts`: `name=address[:port]`, comma separated, e.g.
`server1=192.168.1.10, nas=192.168.1.11:9100`. The name becomes the device name
and its identity — renaming a host creates a new device.

## Test

```bash
npm test                            # parsing, readings, alerts, widgets (SDK validator)
node scripts/read.js <address>      # read-only check of a live machine
node scripts/read.js <address> --widget
```

## Release

Actions → **Release** → Run workflow → pick patch / minor / major. It bumps
`package.json` and the manifest, tags `vX.Y.Z`, and builds
`ghcr.io/plsoftware/gladys-homelab-monitor:X.Y.Z` (+ `:latest`) for amd64 and arm64.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
