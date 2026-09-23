// Ask Apple to send a test notification to the registered webhook.
//
// App Store Connect has no button for this; the App Store Server API endpoint
// POST /inApps/v1/notifications/test is the supported way. Apple then posts a
// TEST notification to whichever URL is registered for that environment,
// which is the only way to prove the webhook is wired before a real purchase.
//
// Usage: node test-notification.mjs <ISSUER_ID> [Sandbox|Production]
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const [, , ISSUER_ID, ENV = 'Production'] = process.argv;
if (!ISSUER_ID) {
  console.error('usage: node test-notification.mjs <ISSUER_ID> [Sandbox|Production]');
  process.exit(1);
}

const KEY_PATH = `${process.env.HOME}/.config/vane/SubscriptionKey_Z7B89CP982.p8`;
const KEY_ID = 'Z7B89CP982';
const BUNDLE_ID = 'com.vane.app';

const HOST = ENV === 'Sandbox'
  ? 'https://api.storekit-sandbox.itunes.apple.com'
  : 'https://api.storekit.itunes.apple.com';

const b64 = (o) =>
  Buffer.from(JSON.stringify(o)).toString('base64url');

const now = Math.floor(Date.now() / 1000);
const header = { alg: 'ES256', kid: KEY_ID, typ: 'JWT' };
const payload = {
  iss: ISSUER_ID,
  iat: now,
  exp: now + 600,
  aud: 'appstoreconnect-v1',
  bid: BUNDLE_ID,
};

const body = `${b64(header)}.${b64(payload)}`;
const signer = createSign('SHA256');
signer.update(body);
// Apple expects the JOSE raw r||s encoding, not DER.
const sig = signer.sign(
  { key: readFileSync(KEY_PATH, 'utf8'), dsaEncoding: 'ieee-p1363' },
).toString('base64url');
const jwt = `${body}.${sig}`;

const res = await fetch(`${HOST}/inApps/v1/notifications/test`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${jwt}` },
});
const text = await res.text();
console.log(`${ENV}: HTTP ${res.status}`);
console.log(text || '(empty body)');

if (res.status === 401) {
  console.log('\n401 means Apple rejected the JWT — check the Issuer ID, or');
  console.log('that the key is an In-App Purchase key rather than a Team key.');
}
