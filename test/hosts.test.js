import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { parseMetrics } from '../src/exporter.js';
import { snapshot, mountKey } from '../src/snapshot.js';
import { evaluate, DEFAULT_THRESHOLDS } from '../src/alerts.js';
import { parseHosts, normalizeConfig, platformId } from '../src/config.js';
import { buildDevice, statesOf, F } from '../src/device.js';
import { hostWidget, overviewWidget, formatUptime, formatBytes } from '../src/widgets.js';

// Two scrapes of a real host (Ubuntu 26.04, Dell OptiPlex 7040), 5 s apart,
// with serial numbers and MAC addresses redacted.
const load = (n) => parseMetrics(readFileSync(new URL(`./fixtures/net05-${n}.prom`, import.meta.url), 'utf8'));
const first = snapshot(load(1), null, 0);
const s = snapshot(load(2), first.counters, 5000);

const ids = {
  device: 'ext:test:host:net05',
  feature: (k) => `ext:test:host:net05:${k}`,
};

test('parses labels, escapes and plain samples', () => {
  const m = parseMetrics('# HELP x\nup 1\nfoo{a="1",b="x\\"y"} 2.5 1700000000\n');
  assert.equal(m.get('up')[0].value, 1);
  assert.deepEqual(m.get('foo')[0], { labels: { a: '1', b: 'x"y' }, value: 2.5 });
});

test('first scrape has no rates, the second has', () => {
  assert.equal(first.cpu.percent, null);
  assert.equal(first.network[0].rxMbps, null);
  assert.ok(s.cpu.percent >= 0 && s.cpu.percent <= 100);
  assert.ok(s.network[0].txMbps >= 0);
});

test('reads the host like df, free and uptime do', () => {
  assert.equal(s.cpu.cores, 8);
  assert.equal(s.memory.percent, 6.1);
  assert.equal(s.swap.percent, 0);
  assert.equal(s.cpuTemperature, 40);
  assert.equal(s.os, 'Ubuntu 26.04.1 LTS');
  assert.equal(s.hardware, 'Dell Inc. OptiPlex 7040');
  assert.equal(s.updates, 7);
  assert.equal(s.rebootRequired, false);
  assert.equal(s.failedServices, 0);
  assert.equal(s.clockSynced, true);
  assert.equal(s.raidDegraded, null);
  assert.equal(formatUptime(s.uptimeSeconds), '5 d 3 h');
});

test('lists real disks only, with df percentages', () => {
  assert.deepEqual(
    s.filesystems.map((f) => [f.mount, f.percent]),
    [
      ['/', 2],
      ['/backup', 15.7],
      ['/boot', 5.3],
      ['/boot/efi', 0.6],
    ],
  );
  assert.equal(mountKey('/boot/efi'), 'boot-efi');
});

test('merges SMART and NVMe data per drive', () => {
  assert.deepEqual(s.drives, [
    { key: 'nvme0', model: 'Sandisk Optimus 5100 500GB', healthy: true, temperature: 46, lifeRemaining: 100, powerOnHours: 148 },
    { key: 'sda', model: 'Samsung SSD 850 EVO 500GB', healthy: true, temperature: 38, lifeRemaining: 94, powerOnHours: 73718 },
  ]);
});

test('physical NICs only', () => {
  assert.deepEqual(
    s.network.map((n) => [n.device, n.up, n.speedMbps]),
    [['enp0s31f6', true, 1000]],
  );
});

test('device features and states line up', () => {
  const device = buildDevice(ids, { name: 'net05', address: '192.0.2.5' }, s);
  const featureIds = new Set(device.features.map((f) => f.external_id));
  assert.equal(featureIds.size, device.features.length, 'feature ids are unique');
  for (const st of statesOf(ids, s)) assert.ok(featureIds.has(st.device_feature_external_id), st.device_feature_external_id);
  assert.ok(featureIds.has(ids.feature(F.CPU)));
  assert.ok(featureIds.has(ids.feature('disk-backup-usage')));
  assert.ok(featureIds.has(ids.feature('drive-sda-life')));
  const temps = device.features.filter((f) => f.unit === 'celsius').map((f) => f.category);
  assert.ok(temps.every((c) => c === 'device-temperature-sensor'), 'temperatures stay out of room averages');
});

test('alerts: baseline is silent, then one event per edge with hysteresis', () => {
  const t = DEFAULT_THRESHOLDS;
  let r = evaluate(undefined, s, t);
  assert.deepEqual(r.transitions, []);

  const full = structuredClone(s);
  full.filesystems[1].percent = 91;
  r = evaluate(r.state, full, t);
  assert.deepEqual(r.transitions.map((x) => [x.alert, x.status, x.detail]), [['disk', 'raised', '/backup 91 %']]);

  full.filesystems[1].percent = 88; // under the threshold, above the hysteresis band
  r = evaluate(r.state, full, t);
  assert.deepEqual(r.transitions, []);

  full.filesystems[1].percent = 84;
  r = evaluate(r.state, full, t);
  assert.deepEqual(r.transitions.map((x) => [x.alert, x.status]), [['disk', 'cleared']]);
});

test('alerts: unreachable needs two missed scrapes; other alerts freeze meanwhile', () => {
  let r = evaluate(undefined, s, DEFAULT_THRESHOLDS);
  r = evaluate(r.state, null, DEFAULT_THRESHOLDS);
  assert.deepEqual(r.transitions, []);
  r = evaluate(r.state, null, DEFAULT_THRESHOLDS);
  assert.deepEqual(r.transitions.map((x) => [x.alert, x.status]), [['unreachable', 'raised']]);
  r = evaluate(r.state, s, DEFAULT_THRESHOLDS);
  assert.deepEqual(r.transitions.map((x) => [x.alert, x.status]), [['unreachable', 'cleared']]);
});

test('alerts: a failing drive and failed services', () => {
  let r = evaluate(undefined, s, DEFAULT_THRESHOLDS);
  const bad = structuredClone(s);
  bad.drives[1].healthy = false;
  bad.failedServices = 2;
  r = evaluate(r.state, bad, DEFAULT_THRESHOLDS);
  assert.deepEqual(
    r.transitions.map((x) => [x.alert, x.detail]),
    [
      ['drive', 'sda (Samsung SSD 850 EVO 500GB)'],
      ['services', '2 failed'],
    ],
  );
});

test('config: hosts, ports, thresholds', () => {
  assert.deepEqual(parseHosts('net05=192.0.2.5, nas = 192.0.2.6:9101\n192.0.2.7'), [
    { name: 'net05', address: '192.0.2.5', port: 9100 },
    { name: 'nas', address: '192.0.2.6', port: 9101 },
    { name: '192.0.2.7', address: '192.0.2.7', port: 9100 },
  ]);
  const c = normalizeConfig({ hosts: 'a=192.0.2.1', poll_frequency: 3, disk_threshold: 80 });
  assert.equal(c.poll_frequency, 10);
  assert.equal(c.thresholds.disk, 80);
  assert.equal(c.thresholds.cpu, DEFAULT_THRESHOLDS.cpu);
  assert.equal(platformId({ name: 'Net 05!', address: 'x' }), 'net-05');
});

test('widgets render exactly as sent (SDK validator)', () => {
  const host = { name: 'net05', online: true, since: null, snapshot: s, alerts: [] };
  const content = hostWidget(host, DEFAULT_THRESHOLDS);
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components.filter((c) => c.type === 'gauge').length, 6);
  assert.ok(content.components.some((c) => c.type === 'status'), 'rows by default');

  const cardLayout = hostWidget(host, DEFAULT_THRESHOLDS, 'cards');
  assert.deepEqual(validateWidgetContent(cardLayout), []);
  const cards = cardLayout.components.find((c) => c.type === 'card-list');
  assert.equal(cards.display, 'grid');
  assert.deepEqual(cards.items.find((i) => i.title === 'Updates'), {
    title: 'Updates',
    subtitle: '7 pending',
    badge: { text: 'Check', color: 'warning' },
  });
  assert.equal(cards.items.find((i) => i.title === 'Uptime').badge, undefined, 'no badge when nothing needs attention');


  const down = { name: 'net01', online: false, since: '04/10/26 5:00 pm', snapshot: s, alerts: ['unreachable'] };
  assert.deepEqual(validateWidgetContent(hostWidget(down, DEFAULT_THRESHOLDS)), []);
  assert.deepEqual(validateWidgetContent(hostWidget(null, DEFAULT_THRESHOLDS)), []);

  const overview = overviewWidget([host, down, { name: 'new', online: null, snapshot: null, alerts: [] }], DEFAULT_THRESHOLDS);
  assert.deepEqual(validateWidgetContent(overview), []);
  const rows = overview.components.find((c) => c.type === 'status').items;
  assert.equal(rows[0].label, 'net01', 'problems first');
  assert.equal(formatBytes(16108920832), '15.0 GB');
});
