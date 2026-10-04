# Linux hosts (node_exporter) for Gladys

Shows the Linux machines on your network in Gladys — CPU, memory, disks,
temperatures, drive health, updates and failed services — with dashboard gauges
and scene alerts.

## Before you start

On each machine (Debian, Ubuntu, Raspberry Pi OS, Proxmox VE):

```
sudo apt install prometheus-node-exporter prometheus-node-exporter-collectors
```

Check it answers: `http://<machine>:9100/metrics` in a browser.

Disks mounted under `/mnt` or `/media` are hidden by the Debian/Ubuntu package. To show them:

```
echo 'ARGS="--collector.filesystem.mount-points-exclude=^/(dev|proc|run|sys|var/lib/docker/.+|var/lib/containers/storage/.+)($|/)"' | sudo tee /etc/default/prometheus-node-exporter
sudo systemctl restart prometheus-node-exporter
```

## Configuration

1. **Hosts**: `name=address`, separated by commas, e.g. `server1=192.168.1.10, nas=192.168.1.11`.
2. Adjust the alert thresholds if needed (CPU 95 %, memory 90 %, disk 90 %, CPU 85 °C).
3. Open the Discovery tab and create the devices.
4. Add the **Linux host** widget (one per machine) or the **Linux hosts** overview to a dashboard.

## Alerts

Add a scene with the trigger **Linux host alert**, optionally filtered by machine,
alert type and raised/cleared, and use `{{triggerEvent.data.host_name}}`,
`{{triggerEvent.data.alert_label}}` and `{{triggerEvent.data.detail}}` in the message.

## Troubleshooting

- *No host answered* — check the address and that port 9100 is reachable from the Gladys host.
- Missing updates/reboot/drive readings — install `prometheus-node-exporter-collectors`; its timers run every 15 minutes.
- Logs: `docker logs` on the integration container.
