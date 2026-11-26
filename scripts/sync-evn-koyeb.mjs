import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchEvnUsage } from '../src/evn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', 'data', 'evn-sync.local.json');

async function main() {
  const raw = await fs.readFile(configPath, 'utf8');
  const cfg = JSON.parse(raw);
  const report = await fetchEvnUsage({
    username: cfg.username,
    password: cfg.password,
    customerId: cfg.customerId,
    billingStartDay: cfg.billingStartDay || 1,
    now: new Date(),
  });
  const sendFlag = process.argv.includes('--send') ? '&send=1' : '';
  const url = `${cfg.koyebUrl.replace(/\/$/, '')}/healthz?evn=1${sendFlag}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ report }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  console.log(new Date().toISOString(), 'Synced EVN report to Koyeb:', {
    latestReadingDate: report.latestReadingDate,
    dailyLatestKwh: report.dailyLatestKwh,
    monthlyKwh: report.monthlyKwh,
    koyebOk: json?.ok,
  });
}

main().catch((err) => {
  console.error(new Date().toISOString(), 'EVN sync error:', err?.message || err);
  process.exitCode = 1;
});
