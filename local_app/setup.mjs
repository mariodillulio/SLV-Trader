import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const envPath = new URL('../.env', import.meta.url);

const requiredProviders = [
  {
    key: 'METALPRICE_API_KEY',
    label: 'MetalPriceAPI API key',
    description: 'Required for silver spot pricing.'
  }
];

const envText = existsSync(envPath) ? await readFile(envPath, 'utf8') : '';
const env = parseEnv(envText);
const missing = requiredProviders.filter(provider => !String(env[provider.key] || '').trim());

if (!missing.length) {
  process.exit(0);
}

console.log('Silver / SLV Play Finder first-run setup');
console.log('');
console.log('Missing required provider credentials:');
for (const provider of missing) console.log(`- ${provider.label}: ${provider.description}`);
console.log('');
console.log('Values are saved to .env only. They are not exposed in the browser or logs.');
console.log('');

const rl = readline.createInterface({ input, output });
let nextEnv = envText;
try {
  for (const provider of missing) {
    const value = (await rl.question(`${provider.label}: `)).trim();
    if (!value) {
      console.log(`${provider.key} was not provided. Setup incomplete.`);
      process.exit(1);
    }
    nextEnv = setEnvValue(nextEnv, provider.key, value);
  }
} finally {
  rl.close();
}

await writeFile(envPath, nextEnv, { mode: 0o600 });
console.log('');
console.log('Setup complete. Provider keys saved to .env.');

function parseEnv(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    values[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return values;
}

function setEnvValue(text, key, value) {
  const line = `${key}=${value}`;
  if (new RegExp(`^${escapeRegex(key)}=.*$`, 'm').test(text)) {
    return text.replace(new RegExp(`^${escapeRegex(key)}=.*$`, 'm'), line);
  }
  const prefix = text && !text.endsWith('\n') ? `${text}\n` : text;
  return `${prefix}${line}\n`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
