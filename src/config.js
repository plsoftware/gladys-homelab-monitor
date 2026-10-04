// -----------------------------------------------------------------------------
// Configuration screen values -> normalized config (pure).
// -----------------------------------------------------------------------------

import { DEFAULT_THRESHOLDS } from './alerts.js';

export const DEFAULT_PORT = 9100;

/**
 * "net05=192.168.1.5, nas=192.168.1.6:9101, 192.168.1.7" -> [{ name, address, port }]
 * A bare address is also the host's name.
 */
export function parseHosts(raw) {
  return String(raw ?? '')
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      const name = eq === -1 ? null : entry.slice(0, eq).trim();
      const target = eq === -1 ? entry : entry.slice(eq + 1).trim();
      const [address, port] = target.split(':');
      return { name: name || address, address, port: Number(port) || DEFAULT_PORT };
    })
    .filter((h) => h.address);
}

export function normalizeConfig(raw = {}) {
  const threshold = (key) => {
    const v = Number(raw[`${key}_threshold`]);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_THRESHOLDS[key];
  };
  return {
    hosts: parseHosts(raw.hosts),
    poll_frequency: Math.max(10, Number(raw.poll_frequency ?? 30) || 30),
    thresholds: {
      cpu: threshold('cpu'),
      memory: threshold('memory'),
      disk: threshold('disk'),
      temperature: threshold('temperature'),
    },
  };
}

/** Stable device id: the host's name, slugged ("Net 05" -> "net-05"). */
export function platformId(host) {
  return host.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || host.address;
}
