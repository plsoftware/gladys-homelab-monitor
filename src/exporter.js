// -----------------------------------------------------------------------------
// Prometheus node_exporter client: one GET of /metrics, parsed from the text
// exposition format into { name -> [{ labels, value }] }.
// -----------------------------------------------------------------------------

import http from 'node:http';

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 16 * 1024 * 1024;

/** GET a URL as text with node:http (no extra dependency). */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BYTES) req.destroy(new Error('answer too large'));
      });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
  });
}

/** `a="1",b="x\"y"` -> { a: '1', b: 'x"y' } */
function parseLabels(text) {
  const labels = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    labels[m[1]] = m[2].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));
  }
  return labels;
}

/**
 * Parse the Prometheus text format.
 * @param {string} text
 * @returns {Map<string, {labels: object, value: number}[]>}
 */
export function parseMetrics(text) {
  const metrics = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const brace = line.indexOf('{');
    const space = line.indexOf(' ');
    let name;
    let labels = {};
    let rest;
    if (brace !== -1 && (space === -1 || brace < space)) {
      const close = line.lastIndexOf('}');
      name = line.slice(0, brace);
      labels = parseLabels(line.slice(brace + 1, close));
      rest = line.slice(close + 1).trim();
    } else {
      name = line.slice(0, space);
      rest = line.slice(space + 1).trim();
    }
    const value = Number(rest.split(/\s+/)[0]);
    if (!metrics.has(name)) metrics.set(name, []);
    metrics.get(name).push({ labels, value });
  }
  return metrics;
}

/** Read and parse http://host:port/metrics. */
export async function scrape(host, port) {
  return parseMetrics(await httpGet(`http://${host}:${port}/metrics`));
}
