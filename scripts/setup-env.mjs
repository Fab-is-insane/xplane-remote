#!/usr/bin/env node
// Creates .env from .env.example and generates the session secret.
//
//   npm run setup              create .env (keeps existing values)
//   npm run setup -- --rotate  generate a new session secret
//                              (signs out every device)
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');
const rotate = process.argv.includes('--rotate');
const DEFAULT_PIN = '5463';

function setVar(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
}

function getVar(text, key) {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(examplePath, 'utf8');
const created = !existsSync(envPath);

if (getVar(text, 'APP_PASSWORD').length < 4) text = setVar(text, 'APP_PASSWORD', DEFAULT_PIN);
if (rotate || getVar(text, 'SESSION_SECRET').length < 32) {
  text = setVar(text, 'SESSION_SECRET', randomBytes(32).toString('base64url'));
}

writeFileSync(envPath, text, { encoding: 'utf8' });

console.log(created ? `Created ${envPath}` : `Updated ${envPath}`);
console.log(`Sign-in PIN: ${getVar(text, 'APP_PASSWORD')}  (change APP_PASSWORD in .env if you like)`);
if (rotate) console.log('New session secret generated: all previously signed-in devices are now signed out.');
