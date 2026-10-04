// Read-only check of a live host, without Gladys: two scrapes 5 s apart (for
// the rates), then the snapshot and the "host" widget content the integration
// would publish. Usage: node scripts/read.js <address>[:port] [--widget]
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { scrape } from '../src/exporter.js';
import { snapshot } from '../src/snapshot.js';
import { DEFAULT_THRESHOLDS } from '../src/alerts.js';
import { hostWidget } from '../src/widgets.js';

const [target, flag] = process.argv.slice(2);
if (!target) {
  console.error('Usage: node scripts/read.js <address>[:port] [--widget]');
  process.exit(1);
}
const [address, port = '9100'] = target.split(':');

const a = snapshot(await scrape(address, port));
await new Promise((r) => setTimeout(r, 5000));
const s = snapshot(await scrape(address, port), a.counters);
delete s.counters;

if (flag === '--widget') {
  const content = hostWidget({ name: address, online: true, snapshot: s, alerts: [] }, DEFAULT_THRESHOLDS);
  console.log(JSON.stringify(content, null, 1));
  console.log('validator:', validateWidgetContent(content));
} else {
  console.log(JSON.stringify(s, null, 1));
}
