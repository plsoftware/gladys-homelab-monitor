// -----------------------------------------------------------------------------
// Snapshot -> Gladys device (features) and states.
//
// Feature conventions follow prohand/gladys-host-monitoring, so both read the
// same in Gladys: percentages are level-sensor/decimal/%, temperatures are
// device-temperature-sensor (kept out of the room averages).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';

const base = { read_only: true, has_feedback: false };

const percent = (name, external_id, keep_history = true) => ({
  ...base,
  name,
  external_id,
  category: C.LEVEL_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.PERCENT,
  min: 0,
  max: 100,
  keep_history,
});

const temperature = (name, external_id) => ({
  ...base,
  name,
  external_id,
  category: C.DEVICE_TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: 0,
  max: 120,
  keep_history: true,
});

const number = (name, external_id, max, keep_history = true) => ({
  ...base,
  name,
  external_id,
  category: C.UNKNOWN,
  type: T.UNKNOWN.UNKNOWN,
  min: 0,
  max,
  keep_history,
});

const text = (name, external_id) => ({
  ...base,
  name,
  external_id,
  category: C.TEXT,
  type: T.TEXT.TEXT,
  min: 0,
  max: 0,
  keep_history: false,
});

const rate = (name, external_id, max) => ({
  ...base,
  name,
  external_id,
  category: C.DATARATE,
  type: T.DATARATE.RATE,
  unit: U.MEGABITS_PER_SECOND,
  min: 0,
  max,
  keep_history: true,
});

/** Feature keys, shared with the widgets. */
export const F = {
  STATUS: 'status',
  CPU: 'cpu-usage',
  MEMORY: 'memory-usage',
  SWAP: 'swap-usage',
  LOAD: 'load-1',
  CPU_TEMP: 'cpu-temperature',
  UPTIME: 'uptime',
  UPDATES: 'updates-pending',
  REBOOT: 'reboot-required',
  FAILED: 'failed-services',
  OS: 'os',
  KERNEL: 'kernel',
  disk: (fs) => `disk-${fs.key}-usage`,
  driveTemp: (d) => `drive-${d.key}-temperature`,
  driveLife: (d) => `drive-${d.key}-life`,
  driveHealth: (d) => `drive-${d.key}-health`,
  netRx: (n) => `net-${n.device}-rx`,
  netTx: (n) => `net-${n.device}-tx`,
};

export const healthText = (healthy) => (healthy == null ? 'Unknown' : healthy ? 'OK' : 'FAILING');
export const yesNo = (v) => (v == null ? 'Unknown' : v ? 'Yes' : 'No');

/**
 * @param {object} ids gladys.externalIds() of the host
 * @param {object} host { name, address }
 * @param {object} s snapshot
 */
export function buildDevice(ids, host, s) {
  const f = (key) => ids.feature(key);
  const cores = s.cpu.cores ?? 1;
  const features = [
    text('Status', f(F.STATUS)),
    percent('CPU usage', f(F.CPU)),
    percent('Memory usage', f(F.MEMORY)),
  ];
  if (s.swap.totalBytes) features.push(percent('Swap usage', f(F.SWAP)));
  features.push(number('Load (1 min)', f(F.LOAD), cores * 4));
  if (s.cpuTemperature != null) features.push(temperature('CPU temperature', f(F.CPU_TEMP)));
  for (const fs of s.filesystems) features.push(percent(`Disk ${fs.mount}`, f(F.disk(fs))));
  for (const d of s.drives) {
    const label = `Drive ${d.key}`;
    features.push(text(`${label} health`, f(F.driveHealth(d))));
    if (d.temperature != null) features.push(temperature(`${label} temperature`, f(F.driveTemp(d))));
    if (d.lifeRemaining != null) {
      features.push({
        ...base,
        name: `${label} life remaining`,
        external_id: f(F.driveLife(d)),
        category: C.MAINTENANCE,
        type: T.MAINTENANCE.LIFE_REMAINING,
        unit: U.PERCENT,
        min: 0,
        max: 100,
        keep_history: true,
      });
    }
  }
  for (const n of s.network) {
    const max = n.speedMbps ?? 10000;
    features.push(rate(`Network ${n.device} in`, f(F.netRx(n)), max));
    features.push(rate(`Network ${n.device} out`, f(F.netTx(n)), max));
  }
  features.push({
    ...base,
    name: 'Uptime',
    external_id: f(F.UPTIME),
    category: C.DURATION,
    type: T.DURATION.DECIMAL,
    unit: U.DAYS,
    min: 0,
    max: 100000,
    keep_history: false,
  });
  if (s.updates != null) features.push(number('Updates pending', f(F.UPDATES), 10000));
  if (s.rebootRequired != null) features.push(text('Reboot required', f(F.REBOOT)));
  if (s.failedServices != null) features.push(number('Failed services', f(F.FAILED), 10000));
  features.push(text('Operating system', f(F.OS)), text('Kernel', f(F.KERNEL)));

  return {
    name: host.name,
    external_id: ids.device,
    params: [
      { name: 'address', value: host.address },
      { name: 'hardware', value: s.hardware ?? 'unknown' },
      { name: 'hostname', value: s.hostname ?? 'unknown' },
    ],
    features,
  };
}

/** States of an answering host. Null readings are skipped, never zeroed. */
export function statesOf(ids, s) {
  const f = (key) => ids.feature(key);
  const out = [];
  const num = (key, state) => state != null && Number.isFinite(state) && out.push({ device_feature_external_id: f(key), state });
  const txt = (key, value) => value != null && out.push({ device_feature_external_id: f(key), text: String(value) });

  txt(F.STATUS, 'Online');
  num(F.CPU, s.cpu.percent);
  num(F.MEMORY, s.memory.percent);
  if (s.swap.totalBytes) num(F.SWAP, s.swap.percent);
  num(F.LOAD, s.load[1]);
  num(F.CPU_TEMP, s.cpuTemperature);
  for (const fs of s.filesystems) num(F.disk(fs), fs.percent);
  for (const d of s.drives) {
    txt(F.driveHealth(d), healthText(d.healthy));
    num(F.driveTemp(d), d.temperature);
    num(F.driveLife(d), d.lifeRemaining);
  }
  for (const n of s.network) {
    num(F.netRx(n), n.rxMbps);
    num(F.netTx(n), n.txMbps);
  }
  num(F.UPTIME, s.uptimeSeconds == null ? null : Number((s.uptimeSeconds / 86400).toFixed(2)));
  num(F.UPDATES, s.updates);
  if (s.rebootRequired != null) txt(F.REBOOT, yesNo(s.rebootRequired));
  num(F.FAILED, s.failedServices);
  txt(F.OS, s.os);
  txt(F.KERNEL, s.kernel);
  return out;
}

/** The set of feature ids, to notice when a host grows a disk or a NIC. */
export function featureSignature(device) {
  return device.features.map((f) => f.external_id).sort().join('|');
}
