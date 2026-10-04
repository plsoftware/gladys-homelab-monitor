// -----------------------------------------------------------------------------
// Dashboard widgets, built from the in-memory host table (pure).
//
//   host      one host, Webmin-style: 6 gauges + a status list
//   overview  every host on one line each, problems first
//
// Gauges carry their value (not a device_feature binding) so they can be
// coloured against the alert thresholds; the integration nudges the widgets
// after every poll, so they stay as fresh as the states.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS as COLOR } from '@gladysassistant/integration-sdk';
import { ALERT_LABELS, HYSTERESIS } from './alerts.js';
import { healthText } from './device.js';

const fmt = (v, digits = 0) => (v == null ? '–' : Number(v).toFixed(digits));

export function formatUptime(seconds) {
  if (seconds == null) return '–';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function formatBytes(bytes) {
  if (bytes == null) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Green below threshold - HYSTERESIS, amber up to the threshold, red beyond. */
function level(value, threshold) {
  if (value == null || threshold == null) return COLOR.NEUTRAL;
  if (value >= threshold) return COLOR.DANGER;
  if (value >= threshold - HYSTERESIS) return COLOR.WARNING;
  return COLOR.SUCCESS;
}

const gauge = (label, value, unit, max, color) => ({
  type: 'gauge',
  label,
  value: value ?? 0,
  min: 0,
  max,
  ...(unit ? { unit } : {}),
  color: value == null ? COLOR.NEUTRAL : color,
});

const clip = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * @param {object} host { name, online, since, snapshot, alerts: string[] }
 * @param {object} thresholds
 * @param {'cards'|'rows'} layout how the details under the gauges are shown
 */
export function hostWidget(host, thresholds, layout = 'cards') {
  const s = host?.snapshot;
  if (!host) {
    return { ttl_seconds: 60, components: [{ type: 'text', variant: 'body', text: 'Choose a host in the widget settings.' }] };
  }
  if (!s) {
    return {
      ttl_seconds: 30,
      components: [
        { type: 'text', variant: 'caption', text: host.name },
        { type: 'status', items: [{ label: 'Status', value: 'Not read yet', color: COLOR.NEUTRAL, icon: 'clock' }] },
      ],
    };
  }

  const root = s.filesystems.find((f) => f.mount === '/') ?? s.filesystems[0];
  const otherDisk = s.filesystems.find((f) => f !== root);
  const cores = s.cpu.cores ?? 1;

  const gauges = [
    gauge('CPU', s.cpu.percent, '%', 100, level(s.cpu.percent, thresholds.cpu)),
    gauge('Memory', s.memory.percent, '%', 100, level(s.memory.percent, thresholds.memory)),
    gauge(`Disk ${clip(root?.mount ?? '/', 14)}`, root?.percent, '%', 100, level(root?.percent, thresholds.disk)),
  ];
  if (s.cpuTemperature != null) {
    gauges.push(gauge('CPU temp', s.cpuTemperature, '°C', 110, level(s.cpuTemperature, thresholds.temperature)));
  }
  if (s.swap.totalBytes) gauges.push(gauge('Swap', s.swap.percent, '%', 100, level(s.swap.percent, 80)));
  else if (otherDisk) {
    gauges.push(gauge(`Disk ${clip(otherDisk.mount, 14)}`, otherDisk.percent, '%', 100, level(otherDisk.percent, thresholds.disk)));
  }
  // Load reads against the core count: 1.0 per core is fully busy.
  gauges.push(gauge('Load', s.load[1], '', cores, level((100 * (s.load[1] ?? 0)) / cores, 100)));

  const items = [];
  if (!host.online) {
    items.push({ label: 'Status', value: `Unreachable since ${host.since ?? '?'}`, color: COLOR.DANGER, icon: 'wifi-off' });
  }
  if (host.alerts.length) {
    items.push({
      label: 'Alerts',
      value: clip(host.alerts.map((a) => ALERT_LABELS[a]).join(', ')),
      color: COLOR.DANGER,
      icon: 'alert-triangle',
    });
  }
  items.push({ label: 'Uptime', value: formatUptime(s.uptimeSeconds), icon: 'clock' });
  items.push({
    label: 'Memory',
    value: `${formatBytes(s.memory.usedBytes)} of ${formatBytes(s.memory.totalBytes)}`,
    icon: 'cpu',
  });
  for (const n of s.network.slice(0, 1)) {
    items.push({
      label: `Network ${n.device}`,
      value: n.up ? `↓ ${fmt(n.rxMbps, 2)} ↑ ${fmt(n.txMbps, 2)} Mbit/s` : 'link down',
      color: n.up ? COLOR.NEUTRAL : COLOR.DANGER,
      icon: 'activity',
    });
  }
  if (s.updates != null) {
    items.push({
      label: 'Updates',
      value: s.updates ? `${s.updates} pending` : 'Up to date',
      color: s.updates ? COLOR.WARNING : COLOR.SUCCESS,
      icon: 'download',
    });
  }
  if (s.rebootRequired != null) {
    items.push({
      label: 'Reboot required',
      value: s.rebootRequired ? 'Yes' : 'No',
      color: s.rebootRequired ? COLOR.WARNING : COLOR.SUCCESS,
      icon: 'refresh-cw',
    });
  }
  if (s.failedServices != null) {
    items.push({
      label: 'Services',
      value: s.failedServices ? `${s.failedServices} failed` : 'All running',
      color: s.failedServices ? COLOR.DANGER : COLOR.SUCCESS,
      icon: 'settings',
    });
  }
  for (const d of s.drives) {
    const parts = [healthText(d.healthy)];
    if (d.lifeRemaining != null) parts.push(`${fmt(d.lifeRemaining)} % life`);
    if (d.temperature != null) parts.push(`${fmt(d.temperature)} °C`);
    items.push({
      label: clip(`${d.key}${d.model ? ` ${d.model}` : ''}`),
      value: parts.join(' · '),
      color: d.healthy === false ? COLOR.DANGER : d.lifeRemaining != null && d.lifeRemaining < 10 ? COLOR.WARNING : COLOR.SUCCESS,
      icon: 'hard-drive',
    });
  }
  if (s.raidDegraded != null) {
    items.push({ label: 'RAID', value: s.raidDegraded ? 'Degraded' : 'OK', color: s.raidDegraded ? COLOR.DANGER : COLOR.SUCCESS, icon: 'layers' });
  }
  if (s.clockSynced === false) items.push({ label: 'Clock', value: 'Not synchronised', color: COLOR.WARNING, icon: 'watch' });

  const caption = [s.os, s.kernel].filter(Boolean).join(' · ');
  return {
    ttl_seconds: 30,
    components: [
      ...(caption ? [{ type: 'text', variant: 'caption', text: clip(caption, 80) }] : []),
      ...gauges.slice(0, 6),
      layout === 'rows' ? { type: 'status', items: items.slice(0, 10) } : detailCards(items),
    ],
  };
}

const BADGE = { [COLOR.DANGER]: 'Alert', [COLOR.WARNING]: 'Check' };

/**
 * The details as a grid of small cards (label as the title, value under it)
 * instead of full-width rows: label and value stay together however wide the
 * widget is. Colour survives as a badge on the cards that need attention.
 */
function detailCards(items) {
  return {
    type: 'card-list',
    display: 'grid',
    items: items.slice(0, 12).map((i) => ({
      title: clip(i.label, 60),
      subtitle: String(i.value),
      ...(BADGE[i.color] ? { badge: { text: BADGE[i.color], color: i.color } } : {}),
    })),
  };
}

/** One line per host, problems first. */
export function overviewWidget(hosts, thresholds) {
  if (hosts.length === 0) {
    return { ttl_seconds: 60, components: [{ type: 'text', variant: 'body', text: 'No host configured yet.' }] };
  }
  const rows = hosts.map((h) => {
    const s = h.snapshot;
    if (!h.online || !s) {
      if (!s) return { rank: 3, item: { label: h.name, value: 'Not read yet', color: COLOR.NEUTRAL, icon: 'server' } };
      return { rank: 0, item: { label: h.name, value: 'Unreachable', color: COLOR.DANGER, icon: 'server' } };
    }
    const disk = Math.max(...s.filesystems.map((f) => f.percent ?? 0), 0);
    const parts = [`CPU ${fmt(s.cpu.percent)}%`, `RAM ${fmt(s.memory.percent)}%`, `Disk ${fmt(disk)}%`];
    if (s.cpuTemperature != null) parts.push(`${fmt(s.cpuTemperature)}°C`);
    const warn =
      [level(s.cpu.percent, thresholds.cpu), level(s.memory.percent, thresholds.memory), level(disk, thresholds.disk)].includes(
        COLOR.WARNING,
      ) || s.rebootRequired;
    const color = h.alerts.length ? COLOR.DANGER : warn ? COLOR.WARNING : COLOR.SUCCESS;
    return {
      rank: color === COLOR.DANGER ? 1 : color === COLOR.WARNING ? 2 : 3,
      item: { label: h.name, value: clip(parts.join(' · ')), color, icon: 'server' },
    };
  });
  rows.sort((a, b) => a.rank - b.rank || a.item.label.localeCompare(b.item.label));
  const problems = rows.filter((r) => r.rank < 3).length;
  return {
    ttl_seconds: 30,
    components: [
      {
        type: 'text',
        variant: 'caption',
        text: `${hosts.length} host${hosts.length === 1 ? '' : 's'} · ${problems ? `${problems} need${problems === 1 ? 's' : ''} attention` : 'all OK'}`,
      },
      { type: 'status', items: rows.slice(0, 10).map((r) => r.item) },
    ],
  };
}
