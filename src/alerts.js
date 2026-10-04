// -----------------------------------------------------------------------------
// Host alerts: raised / cleared transitions, one scene event per edge.
//
// Pure: evaluate() takes the previous alert state of a host and its new
// snapshot (null = the host did not answer) and returns the new state plus the
// transitions to fire. The first evaluation of a host only records a baseline,
// so restarting the integration never fires anything by itself.
// -----------------------------------------------------------------------------

/** Points below the threshold an alert must fall to clear: no flapping at 89.9/90.1 %. */
export const HYSTERESIS = 5;
/** Consecutive readings needed to raise: a single CPU spike or missed scrape is not an alert. */
const CONFIRM = { cpu: 2, unreachable: 2 };

export const ALERT_LABELS = {
  unreachable: 'Host unreachable',
  cpu: 'CPU usage',
  memory: 'Memory usage',
  disk: 'Disk usage',
  temperature: 'CPU temperature',
  drive: 'Drive health',
  services: 'Failed services',
  reboot: 'Reboot required',
  raid: 'RAID degraded',
};

export const DEFAULT_THRESHOLDS = { cpu: 95, memory: 90, disk: 90, temperature: 85 };

/** Each alert's current reading: { over: bool|null, value, detail }. */
function readings(s, thresholds, active) {
  if (s === null) return { unreachable: { over: true, value: null, detail: 'no answer from node_exporter' } };

  const numeric = (key, value, detail) => {
    if (value == null) return { over: null, value: null, detail };
    const limit = thresholds[key];
    // Raised at the threshold, cleared only HYSTERESIS points below it.
    const over = active[key]?.raised ? value >= limit - HYSTERESIS : value >= limit;
    return { over, value, detail };
  };

  const worstDisk = [...s.filesystems].sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0];
  const badDrives = s.drives.filter((d) => d.healthy === false);

  return {
    unreachable: { over: false, value: null, detail: '' },
    cpu: numeric('cpu', s.cpu.percent, `${s.cpu.percent} %`),
    memory: numeric('memory', s.memory.percent, `${s.memory.percent} %`),
    disk: numeric('disk', worstDisk?.percent ?? null, worstDisk ? `${worstDisk.mount} ${worstDisk.percent} %` : ''),
    temperature: numeric('temperature', s.cpuTemperature, `${s.cpuTemperature} °C`),
    drive: {
      over: s.drives.length ? badDrives.length > 0 : null,
      value: badDrives.length,
      detail: badDrives.map((d) => `${d.key}${d.model ? ` (${d.model})` : ''}`).join(', '),
    },
    services: {
      over: s.failedServices == null ? null : s.failedServices > 0,
      value: s.failedServices,
      detail: s.failedServices ? `${s.failedServices} failed` : '',
    },
    reboot: { over: s.rebootRequired, value: null, detail: '' },
    raid: { over: s.raidDegraded, value: null, detail: '' },
  };
}

/**
 * @param {object|undefined} state previous state of this host ({ alertKey: { raised, streak } }), undefined the first time
 * @param {object|null} s the new snapshot, or null when the host did not answer
 * @param {object} thresholds { cpu, memory, disk, temperature }
 * @returns {{ state: object, transitions: {alert, status, value, detail}[] }}
 */
export function evaluate(state, s, thresholds) {
  const baseline = state === undefined;
  const next = structuredClone(state ?? {});
  const transitions = [];

  for (const [alert, r] of Object.entries(readings(s, thresholds, next))) {
    if (r.over == null) continue; // not reported by this host
    const cur = (next[alert] ??= { raised: false, streak: 0 });
    if (baseline) {
      cur.raised = r.over;
      cur.streak = r.over ? CONFIRM[alert] ?? 1 : 0;
      continue;
    }
    if (r.over) {
      cur.streak += 1;
      if (!cur.raised && cur.streak >= (CONFIRM[alert] ?? 1)) {
        cur.raised = true;
        transitions.push({ alert, status: 'raised', value: r.value, detail: r.detail });
      }
    } else {
      cur.streak = 0;
      if (cur.raised) {
        cur.raised = false;
        transitions.push({ alert, status: 'cleared', value: r.value, detail: r.detail });
      }
    }
  }
  return { state: next, transitions };
}

/** Alerts currently raised, for the widgets. */
export function raisedAlerts(state = {}) {
  return Object.entries(state)
    .filter(([, v]) => v.raised)
    .map(([k]) => k);
}
