#!/usr/bin/env node
// Creates .env from .env.example with freshly generated secrets.
//
//   npm run setup              create .env (keeps existing values)
//   npm run setup -- --rotate  generate a new password + session secret
//                              (signs out every device)
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');
const rotate = process.argv.includes('--rotate');

// Unambiguous lowercase alphabet (no 0/o, 1/l/i) so it is easy to type on a phone.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function generatePassword() {
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 5; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-'); // 20 random chars ≈ 99 bits
}

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
let newPassword = null;

if (rotate || getVar(text, 'APP_PASSWORD').length < 12) {
  newPassword = generatePassword();
  text = setVar(text, 'APP_PASSWORD', newPassword);
}
if (rotate || getVar(text, 'SESSION_SECRET').length < 32) {
  text = setVar(text, 'SESSION_SECRET', randomBytes(32).toString('base64url'));
}

writeFileSync(envPath, text, { encoding: 'utf8' });

console.log(created ? `Created ${envPath}` : `Updated ${envPath}`);
if (newPassword) {
  console.log('');
  console.log('  Your X-Plane Remote password (type this on your phone):');
  console.log('');
  console.log(`      ${newPassword}`);
  console.log('');
  console.log('  It is stored in .env (git-ignored). Change APP_PASSWORD there if you prefer your own (min 12 chars).');
  if (rotate) console.log('  All previously signed-in devices are now signed out.');
} else {
  console.log('Existing APP_PASSWORD and SESSION_SECRET kept. Use `npm run setup -- --rotate` to replace them.');
}
