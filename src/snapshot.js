// -----------------------------------------------------------------------------
// node_exporter metrics -> one readable snapshot of a host.
//
// Pure functions of a parsed scrape (plus the previous counters, for the rates),
// so they are testable without a host or Gladys. Every reading is null when the
// host does not report it: an exporter without the -collectors package has no
// updates count, a Raspberry Pi has no DMI, a VM has no temperature.
// -----------------------------------------------------------------------------

// Filesystems that are not disks: memory, containers, snaps, kernel views.
const VIRTUAL_FS = new Set([
  'tmpfs', 'ramfs', 'devtmpfs', 'overlay', 'squashfs', 'nsfs', 'autofs', 'efivarfs', 'proc', 'sysfs',
  'cgroup', 'cgroup2', 'tracefs', 'debugfs', 'securityfs', 'pstore', 'bpf', 'configfs', 'fusectl',
  'mqueue', 'hugetlbfs', 'binfmt_misc', 'rpc_pipefs', 'devpts', 'fuse.lxcfs', 'fuse.snapfuse',
]);
// Network filesystems belong to the machine serving them, not to this host.
const NETWORK_FS = /^(nfs4?|cifs|smb3?|sshfs|fuse\.sshfs|9p|ceph|glusterfs|fuse\.glusterfs)$/;
const HIDDEN_MOUNTS = /^\/(run|snap|proc|sys|dev|var\/lib\/docker|var\/snap|var\/lib\/kubelet|var\/lib\/containers)(\/|$)/;
// Physical NICs; bridges, veths and docker interfaces only repeat their traffic.
const PHYSICAL_NIC = /^(en|eth|wl|ww|bond)/;

const all = (m, name) => m.get(name) ?? [];
const first = (m, name, match = () => true) => all(m, name).find((s) => match(s.labels))?.value ?? null;
const sum = (m, name, match = () => true) => {
  const samples = all(m, name).filter((s) => match(s.labels));
  return samples.length ? samples.reduce((t, s) => t + s.value, 0) : null;
};
const round = (v, digits = 1) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(digits)));

/** "/" -> "root", "/boot/efi" -> "boot-efi": a stable key for feature ids. */
export function mountKey(mount) {
  return mount === '/' ? 'root' : mount.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
}

function cpuCounters(m) {
  let total = 0;
  let idle = 0;
  const cores = new Set();
  for (const { labels, value } of all(m, 'node_cpu_seconds_total')) {
    cores.add(labels.cpu);
    total += value;
    if (labels.mode === 'idle' || labels.mode === 'iowait') idle += value;
  }
  return { total, idle, cores: cores.size };
}

function cpuTemperature(m) {
  // Intel package, then Intel coretemp package sensor, AMD Tctl/Tdie,
  // Raspberry Pi and other ARM boards.
  const zone = (type) => first(m, 'node_thermal_zone_temp', (l) => l.type === type);
  const chips = new Map(all(m, 'node_hwmon_chip_names').map((s) => [s.labels.chip, s.labels.chip_name]));
  const hwmon = (chipName, sensor) =>
    first(m, 'node_hwmon_temp_celsius', (l) => chips.get(l.chip) === chipName && (!sensor || l.sensor === sensor));
  return (
    zone('x86_pkg_temp') ??
    hwmon('coretemp', 'temp1') ??
    hwmon('k10temp', 'temp1') ??
    hwmon('zenpower') ??
    zone('cpu-thermal') ??
    zone('cpu_thermal') ??
    hwmon('cpu_thermal') ??
    null
  );
}

function filesystems(m) {
  const seen = new Set();
  const out = [];
  for (const { labels, value: size } of all(m, 'node_filesystem_size_bytes')) {
    const { mountpoint: mount, fstype, device } = labels;
    if (VIRTUAL_FS.has(fstype) || NETWORK_FS.test(fstype) || HIDDEN_MOUNTS.test(mount)) continue;
    if (labels.device_error || size <= 0) continue;
    // A bind mount repeats its device: keep the first (shortest) mount point.
    if (seen.has(device)) continue;
    seen.add(device);
    const match = (l) => l.mountpoint === mount && l.device === device;
    const free = first(m, 'node_filesystem_free_bytes', match);
    const avail = first(m, 'node_filesystem_avail_bytes', match);
    if (free == null || avail == null) continue;
    // df's figure: reserved blocks count neither as used nor as available.
    const used = size - free;
    out.push({
      mount,
      key: mountKey(mount),
      fstype,
      sizeBytes: size,
      usedBytes: used,
      availBytes: avail,
      percent: used + avail > 0 ? round((100 * used) / (used + avail)) : null,
      readOnly: first(m, 'node_filesystem_readonly', match) === 1,
    });
  }
  return out.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
}

/** smartmon "/dev/sda" and "/dev/nvme0", nvme "nvme0n1", hwmon "nvme_nvme0" -> "sda" / "nvme0". */
function driveKey(name) {
  return String(name).replace(/^\/dev\//, '').replace(/^nvme_/, '').replace(/^(nvme\d+)n\d+$/, '$1');
}

function drives(m) {
  const map = new Map();
  const drive = (key) => {
    if (!map.has(key)) {
      map.set(key, { key, model: null, healthy: null, temperature: null, lifeRemaining: null, powerOnHours: null });
    }
    return map.get(key);
  };

  for (const { labels } of all(m, 'smartmon_device_info')) {
    const d = drive(driveKey(labels.disk));
    d.model = labels.device_model || labels.product || labels.model_family || d.model;
  }
  for (const { labels } of all(m, 'nvme_device_info')) {
    const d = drive(driveKey(labels.device));
    d.model = labels.model || d.model;
  }
  for (const { labels, value } of all(m, 'smartmon_device_smart_healthy')) drive(driveKey(labels.disk)).healthy = value === 1;
  for (const { labels, value } of all(m, 'nvme_critical_warning_total')) {
    const d = drive(driveKey(labels.device));
    if (value > 0) d.healthy = false;
    else if (d.healthy == null) d.healthy = true;
  }

  const smartValue = (disk, ...names) => {
    for (const name of names) {
      const v = first(m, name, (l) => driveKey(l.disk) === disk);
      if (v != null) return v;
    }
    return null;
  };
  for (const d of map.values()) {
    d.temperature =
      first(m, 'nvme_temperature_celsius', (l) => driveKey(l.device) === d.key) ??
      smartValue(d.key, 'smartmon_temperature_celsius_raw_value', 'smartmon_airflow_temperature_cel_raw_value');
    const used = first(m, 'nvme_percentage_used_ratio', (l) => driveKey(l.device) === d.key);
    d.lifeRemaining =
      used != null
        ? Math.max(0, round(100 - used * 100, 0))
        : // Normalized SMART values of the vendors' "life left" attributes.
          smartValue(
            d.key,
            'smartmon_wear_leveling_count_value',
            'smartmon_media_wearout_indicator_value',
            'smartmon_percent_lifetime_remain_value',
            'smartmon_ssd_life_left_value',
          );
    d.powerOnHours =
      smartValue(d.key, 'smartmon_power_on_hours_raw_value') ??
      first(m, 'nvme_power_on_hours_total', (l) => driveKey(l.device) === d.key);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function networkCounters(m) {
  const nics = {};
  for (const { labels, value } of all(m, 'node_network_receive_bytes_total')) {
    if (!PHYSICAL_NIC.test(labels.device)) continue;
    nics[labels.device] = {
      rx: value,
      tx: first(m, 'node_network_transmit_bytes_total', (l) => l.device === labels.device) ?? 0,
      up: first(m, 'node_network_up', (l) => l.device === labels.device) === 1,
      speedMbps: (() => {
        const bytes = first(m, 'node_network_speed_bytes', (l) => l.device === labels.device);
        return bytes != null && bytes > 0 ? (bytes * 8) / 1e6 : null;
      })(),
    };
  }
  return nics;
}

/**
 * One snapshot of a host.
 * @param {Map} m parsed scrape
 * @param {object|null} previous the `counters` of the previous snapshot, for rates
 * @param {number} now ms timestamp of this scrape
 */
export function snapshot(m, previous = null, now = Date.now()) {
  const cpu = cpuCounters(m);
  const nics = networkCounters(m);
  const elapsed = previous ? (now - previous.at) / 1000 : 0;

  const cpuPercent =
    previous && cpu.total > previous.cpu.total
      ? round(100 * (1 - (cpu.idle - previous.cpu.idle) / (cpu.total - previous.cpu.total)))
      : null;

  const network = Object.entries(nics).map(([device, nic]) => {
    const before = previous?.nics?.[device];
    const rate = (current, past) =>
      before && elapsed > 0 && current >= past ? round(((current - past) * 8) / elapsed / 1e6, 2) : null;
    return {
      device,
      up: nic.up,
      speedMbps: nic.speedMbps,
      rxMbps: rate(nic.rx, before?.rx),
      txMbps: rate(nic.tx, before?.tx),
    };
  });

  const memTotal = first(m, 'node_memory_MemTotal_bytes');
  const memAvail = first(m, 'node_memory_MemAvailable_bytes');
  const swapTotal = first(m, 'node_memory_SwapTotal_bytes');
  const swapFree = first(m, 'node_memory_SwapFree_bytes');
  const os = all(m, 'node_os_info')[0]?.labels;
  const uname = all(m, 'node_uname_info')[0]?.labels;
  const dmi = all(m, 'node_dmi_info')[0]?.labels;
  const boot = first(m, 'node_boot_time_seconds');
  const time = first(m, 'node_time_seconds');
  const mdFailed = sum(m, 'node_md_disks', (l) => l.state === 'failed');
  const mdDegraded = sum(m, 'node_md_degraded');

  return {
    cpu: { percent: cpuPercent, cores: cpu.cores || null },
    memory: {
      totalBytes: memTotal,
      usedBytes: memTotal != null && memAvail != null ? memTotal - memAvail : null,
      percent: memTotal ? round((100 * (memTotal - memAvail)) / memTotal) : null,
    },
    swap: {
      totalBytes: swapTotal,
      usedBytes: swapTotal != null && swapFree != null ? swapTotal - swapFree : null,
      percent: swapTotal ? round((100 * (swapTotal - swapFree)) / swapTotal) : null,
    },
    load: {
      1: round(first(m, 'node_load1'), 2),
      5: round(first(m, 'node_load5'), 2),
      15: round(first(m, 'node_load15'), 2),
    },
    cpuTemperature: round(cpuTemperature(m)),
    filesystems: filesystems(m),
    drives: drives(m),
    network,
    uptimeSeconds: boot != null && time != null ? Math.max(0, Math.round(time - boot)) : null,
    os: os?.pretty_name || (os?.name && os?.version ? `${os.name} ${os.version}` : null),
    kernel: uname?.release ?? null,
    hostname: uname?.nodename ?? null,
    hardware: dmi
      ? [dmi.system_vendor, dmi.product_name].filter((s) => s && !/to be filled|default string/i.test(s)).join(' ') ||
        null
      : null,
    updates: sum(m, 'apt_upgrades_pending'),
    rebootRequired: (() => {
      const v = first(m, 'node_reboot_required');
      return v == null ? null : v === 1;
    })(),
    failedServices: first(m, 'node_systemd_units', (l) => l.state === 'failed'),
    clockSynced: (() => {
      const v = first(m, 'node_timex_sync_status');
      return v == null ? null : v === 1;
    })(),
    raidDegraded: mdFailed == null && mdDegraded == null ? null : (mdFailed ?? 0) + (mdDegraded ?? 0) > 0,
    counters: { at: now, cpu: { total: cpu.total, idle: cpu.idle }, nics },
  };
}
