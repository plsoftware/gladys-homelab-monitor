// -----------------------------------------------------------------------------
// Linux hosts (node_exporter) -> Gladys external integration.
//
// One Gladys device per Linux machine running Prometheus node_exporter, read
// directly over the LAN (no Prometheus server needed):
//   - CPU, memory, swap and per-disk usage, load, CPU temperature
//   - per-drive SMART health, temperature and life remaining
//   - network throughput, uptime, pending updates, reboot required, failed
//     services, OS and kernel
// plus a "host alert" scene trigger (raised / cleared), a "get host status"
// scene action, and two dashboard widgets (one host with gauges, all hosts).
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { scrape } from './src/exporter.js';
import { snapshot } from './src/snapshot.js';
import { buildDevice, statesOf, featureSignature, F } from './src/device.js';
import { evaluate, raisedAlerts, ALERT_LABELS, DEFAULT_THRESHOLDS } from './src/alerts.js';
import { normalizeConfig, platformId } from './src/config.js';
import { hostWidget, overviewWidget, formatUptime } from './src/widgets.js';

const gladys = new GladysIntegration();

let config = { hosts: [], poll_frequency: 30, thresholds: DEFAULT_THRESHOLDS };
let pollTimer = null;
let polling = false;
// device external_id -> { name, address, port, ids, snapshot, online, since, alertState, signature }
const hosts = new Map();

// --- Polling -----------------------------------------------------------------------

async function publishDevices() {
  const devices = [...hosts.values()]
    .filter((h) => h.snapshot)
    .map((h) => buildDevice(h.ids, h, h.snapshot));
  if (devices.length) await gladys.publishDiscoveredDevices(devices);
}

async function fireAlerts(host, transitions) {
  for (const t of transitions) {
    const data = {
      host: host.ids.device,
      host_name: host.name,
      alert: t.alert,
      alert_label: ALERT_LABELS[t.alert],
      status: t.status,
      value: t.value ?? null,
      detail: t.detail ?? '',
    };
    logger.info(`alert ${t.status}: ${host.name} ${t.alert} ${t.detail ?? ''}`);
    try {
      await gladys.publishSceneEvent('host_alert', data);
    } catch (err) {
      // A refused event (older core, rate limit) must not break the poll.
      logger.error(`Cannot fire host_alert for ${host.name}`, err);
    }
  }
}

async function pollHost(host) {
  let s = null;
  try {
    s = snapshot(await scrape(host.address, host.port), host.snapshot?.counters ?? null);
  } catch (err) {
    if (host.online !== false) logger.warn(`${host.name} (${host.address}:${host.port}) unreachable: ${err.message}`);
  }

  const { state, transitions } = evaluate(host.alertState, s, config.thresholds);
  host.alertState = state;

  if (s) {
    host.online = true;
    host.since = null;
    host.snapshot = s;
  } else if (host.online !== false) {
    host.online = false;
    host.since = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' });
  }
  await fireAlerts(host, transitions);
  return s !== null;
}

async function pollAll() {
  if (polling) return; // a slow host must not stack polls
  polling = true;
  try {
    const results = await Promise.all([...hosts.values()].map(pollHost));

    // New disk, drive or NIC (or the very first read): (re)publish the devices.
    let changed = false;
    for (const host of hosts.values()) {
      if (!host.snapshot) continue;
      const signature = featureSignature(buildDevice(host.ids, host, host.snapshot));
      if (signature !== host.signature) {
        host.signature = signature;
        changed = true;
      }
    }
    if (changed) await publishDevices();

    const states = [...hosts.values()].flatMap((h) =>
      h.online
        ? statesOf(h.ids, h.snapshot)
        : h.snapshot
          ? [{ device_feature_external_id: h.ids.feature(F.STATUS), text: 'Unreachable' }]
          : [],
    );
    if (states.length) {
      try {
        await gladys.publishStates(states);
      } catch (err) {
        // Expected until the user has created the devices from the Discovery tab.
        logger.debug(`publishStates skipped: ${err.message}`);
      }
    }

    const up = results.filter(Boolean).length;
    if (up === 0 && hosts.size > 0) {
      await gladys.setConnectionStatus(false, { en: 'No host answered: is node_exporter running and reachable?' });
    } else {
      await gladys.setConnectionStatus(true);
    }
    gladys.requestWidgetRefresh('host');
    gladys.requestWidgetRefresh('overview');
  } finally {
    polling = false;
  }
}

// --- Lifecycle ---------------------------------------------------------------------

async function start() {
  stop();
  const previous = new Map(hosts);
  hosts.clear();
  for (const h of config.hosts) {
    const ids = gladys.externalIds('host', platformId(h));
    // Keep what a host already knew across a config change (rates, alert baseline).
    const before = previous.get(ids.device);
    hosts.set(ids.device, {
      ...h,
      ids,
      snapshot: before?.address === h.address ? before.snapshot : null,
      online: before?.online ?? null,
      since: before?.since ?? null,
      alertState: before?.alertState,
      signature: null,
    });
  }

  if (hosts.size === 0) {
    await gladys.setConnectionStatus(false, {
      en: 'Add your hosts in the Configuration tab, e.g. server1=192.168.1.10',
      fr: 'Ajoutez vos machines dans l’onglet Configuration, ex. serveur1=192.168.1.10',
    });
    return;
  }

  await pollAll();
  logger.info(`Watching ${hosts.size} host(s) every ${config.poll_frequency}s`);
  pollTimer = setInterval(() => pollAll().catch((err) => logger.warn(`Poll failed: ${err.message}`)), config.poll_frequency * 1000);
}

function stop() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// --- Gladys handlers ------------------------------------------------------------------

gladys.onScanRequest(async () => {
  for (const host of hosts.values()) host.signature = null;
  await pollAll();
  await publishDevices();
});

gladys.onPoll(async () => {
  await pollAll();
});

gladys.onDeviceCreated(async () => {
  await pollAll();
});

gladys.onSetValue(async (device) => {
  throw new Error(`${device.name}: host features are read-only`);
});

const hostView = (h) => ({ ...h, alerts: raisedAlerts(h.alertState) });

gladys.onWidgetGet('host', async ({ settings }) => {
  const host = hosts.get(settings?.host);
  return hostWidget(host ? hostView(host) : null, config.thresholds, settings?.layout === 'rows' ? 'rows' : 'cards');
});

gladys.onWidgetGet('overview', async () => overviewWidget([...hosts.values()].map(hostView), config.thresholds));

gladys.onSceneAction('get_host_status', async (fields) => {
  const host = hosts.get(fields.host) ?? (hosts.size === 1 ? [...hosts.values()][0] : null);
  if (!host) throw new Error(hosts.size ? 'Choose a host' : 'No host configured');
  const s = host.snapshot;
  const disk = s ? Math.max(...s.filesystems.map((f) => f.percent ?? 0), 0) : null;
  return {
    host_name: host.name,
    status: host.online ? 'Online' : 'Unreachable',
    cpu: s?.cpu.percent ?? null,
    memory: s?.memory.percent ?? null,
    disk,
    temperature: s?.cpuTemperature ?? null,
    uptime: formatUptime(s?.uptimeSeconds ?? null),
    updates: s?.updates ?? null,
    alerts: raisedAlerts(host.alertState).map((a) => ALERT_LABELS[a]).join(', ') || 'none',
  };
});

gladys.onConfigUpdated(async (newConfig) => {
  config = normalizeConfig(newConfig);
  await start();
});

gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    await start();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
  }
});

gladys.handleShutdown(() => stop());

logger.info('Starting the Linux hosts (node_exporter) integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
