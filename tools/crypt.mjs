// Encrypt / decrypt the calculator inside index.html.
//   node tools/crypt.mjs decrypt index.html <password> out/app.html
//   node tools/crypt.mjs encrypt out/app.html <password> index.html user1@x.com,user2@x.com
// Everyone shares one password (it derives the AES key); each listed email is
// allowed through the gate. Keep the decrypted app.html out of the repo.
import fs from 'fs'; import zlib from 'zlib'; import crypto from 'crypto';
const [,, mode, inFile, pw, outFile, emails] = process.argv;
const sub = crypto.webcrypto.subtle;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
async function key(salt, iter, usage) {
  const km = await sub.importKey('raw', Buffer.from(pw), 'PBKDF2', false, ['deriveKey']);
  return sub.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, km, { name: 'AES-GCM', length: 256 }, true, [usage]);
}
if (mode === 'decrypt') {
  const html = fs.readFileSync(inFile, 'utf8');
  const GATE = JSON.parse(html.match(/var GATE = (\{.*?\});\n/s)[1]);
  const k = await key(Buffer.from(GATE.salt, 'base64'), GATE.iter, 'decrypt');
  const pt = await sub.decrypt({ name: 'AES-GCM', iv: Buffer.from(GATE.iv, 'base64') }, k, Buffer.from(GATE.ct, 'base64'));
  fs.writeFileSync(outFile, zlib.gunzipSync(Buffer.from(pt)));
  console.log('decrypted to', outFile, 'users:', (GATE.users || [GATE.emailHash]).length);
} else if (mode === 'encrypt') {
  const page = fs.readFileSync(outFile, 'utf8');
  const old = JSON.parse(page.match(/var GATE = (\{.*?\});\n/s)[1]);
  const salt = Buffer.from(old.salt, 'base64'), iter = old.iter, iv = crypto.randomBytes(12);
  const k = await key(salt, iter, 'encrypt');
  const gz = zlib.gzipSync(fs.readFileSync(inFile), { level: 9 });
  const ct = Buffer.from(await sub.encrypt({ name: 'AES-GCM', iv }, k, gz));
  const users = emails.split(',').map(e => e.trim().toLowerCase()).filter(Boolean).map(sha);
  const GATE = { v: 2, iter, salt: old.salt, iv: iv.toString('base64'), ct: ct.toString('base64'), users };
  fs.writeFileSync(outFile, page.replace(/var GATE = \{.*?\};\n/s, () => 'var GATE = ' + JSON.stringify(GATE) + ';\n'));
  console.log('encrypted', inFile, '->', outFile, 'users:', users.length, 'ct bytes:', ct.length);
} else { console.error('mode must be decrypt or encrypt'); process.exit(1); }
