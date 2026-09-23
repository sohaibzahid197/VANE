// Ask Apple whether it managed to DELIVER the test notification.
// This is the authoritative answer: it reports the HTTP status our endpoint
// returned, so a misregistered URL shows up here rather than as silence.
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
const [, , ISSUER, TOKEN] = process.argv;
const pem = readFileSync(`${process.env.HOME}/.config/vane/SubscriptionKey_Z7B89CP982.p8`, 'utf8');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const body = `${b64({ alg: 'ES256', kid: 'Z7B89CP982', typ: 'JWT' })}.${b64({
  iss: ISSUER, iat: now, exp: now + 600, aud: 'appstoreconnect-v1', bid: 'com.vane.app',
})}`;
const s = createSign('SHA256'); s.update(body);
const jwt = `${body}.${s.sign({ key: pem, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;

const res = await fetch(
  `https://api.storekit-sandbox.itunes.apple.com/inApps/v1/notifications/test/${encodeURIComponent(TOKEN)}`,
  { headers: { Authorization: `Bearer ${jwt}` } },
);
console.log('HTTP', res.status);
const j = await res.json();
console.log('\n=== DELIVERY ATTEMPTS ===');
console.log(JSON.stringify(j.sendAttempts ?? j, null, 2));

