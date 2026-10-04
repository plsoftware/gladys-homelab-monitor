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
      return { name: name || address, address, port: Number(port) || DEFAULT_PORT, entry };
    })
    .filter((h) => h.address);
}

// An IPv4 address or a host name: "192.168.20/100" or "net 01" is a typo, not a host.
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function isValidAddress(address) {
  if (/^\d+(\.\d+)*$/.test(address)) return IPV4.test(address);
  return HOSTNAME.test(address);
}

export function normalizeConfig(raw = {}) {
  const threshold = (key) => {
    const v = Number(raw[`${key}_threshold`]);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_THRESHOLDS[key];
  };
  const parsed = parseHosts(raw.hosts);
  const valid = (h) => isValidAddress(h.address) && h.port > 0 && h.port < 65536;
  return {
    hosts: parsed.filter(valid).map(({ entry, ...h }) => h),
    invalid: parsed.filter((h) => !valid(h)).map((h) => h.entry),
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
