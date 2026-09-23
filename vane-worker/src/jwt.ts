// JWT signing and JWS verification, on Web Crypto only.
//
// Two different algorithms are needed and they are easy to confuse:
//   ES256 (ECDSA P-256)  — the token we present to Apple's App Store Server API
//   RS256 (RSA PKCS#1)   — the token we present to Google for a Firestore token
//
// Workers have no `node:crypto` by default and no npm runtime, so both are
// built directly on SubtleCrypto.

const enc = new TextEncoder();

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64urlJson = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));

/** Decode a base64url segment to bytes. */
export function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Strip a PEM envelope to raw DER bytes. */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  return fromB64url(body.replace(/\+/g, '-').replace(/\//g, '_'));
}

/**
 * Sign the JWT Apple's App Store Server API expects.
 *
 * Apple rejects a token older than 60 minutes, so this is short-lived and
 * cached by the caller rather than minted per request.
 */
export async function appleJwt(opts: {
  keyId: string;
  issuerId: string;
  privateKeyPem: string;
  bundleId: string;
  ttlSeconds?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: opts.keyId, typ: 'JWT' };
  const payload = {
    iss: opts.issuerId,
    iat: now,
    exp: now + (opts.ttlSeconds ?? 1800),
    aud: 'appstoreconnect-v1',
    bid: opts.bundleId,
  };

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(opts.privateKeyPem) as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const body = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(body),
  );
  return `${body}.${b64url(sig)}`;
}

/**
 * Exchange a service account for a Google OAuth access token.
 *
 * The admin SDK is not available here, so we mint the assertion ourselves and
 * trade it at the token endpoint. Callers should cache the result: it lasts an
 * hour and this costs an extra round trip.
 */
export async function googleAccessToken(sa: {
  client_email: string;
  private_key: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key) as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const body = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(body));
  const assertion = `${body}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`google token ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** The decoded halves of a JWS, without any signature check. */
export function decodeJws<T>(jws: string): { header: any; payload: T } {
  const parts = jws.split('.');
  if (parts.length !== 3) throw new Error('malformed JWS');
  const dec = new TextDecoder();
  return {
    header: JSON.parse(dec.decode(fromB64url(parts[0]!))),
    payload: JSON.parse(dec.decode(fromB64url(parts[1]!))) as T,
  };
}

/**
 * Verify a JWS that Apple signed, using the x5c chain in its own header.
 *
 * This checks that the payload matches the signature of the leaf certificate
 * in the header. It deliberately does NOT yet chain that leaf up to Apple's
 * root CA — see verifyAppleChain in notifications.ts for why that matters and
 * what the caller must do about it.
 */
export async function verifyJwsSignature(jws: string): Promise<boolean> {
  const [h, p, s] = jws.split('.');
  if (!h || !p || !s) return false;

  const header = JSON.parse(new TextDecoder().decode(fromB64url(h))) as {
    alg?: string;
    x5c?: string[];
  };
  // Apple signs with ES256. Accepting `alg: none`, or any algorithm named by
  // the token itself, is the classic JWT forgery.
  if (header.alg !== 'ES256') return false;
  const leaf = header.x5c?.[0];
  if (!leaf) return false;

  const spki = await spkiFromCertificate(fromB64url(leaf.replace(/\+/g, '-').replace(/\//g, '_')));
  if (!spki) return false;

  const key = await crypto.subtle.importKey(
    'spki',
    spki as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    fromB64url(s) as BufferSource,
    enc.encode(`${h}.${p}`),
  );
}

/**
 * Pull the SubjectPublicKeyInfo out of a DER X.509 certificate.
 *
 * A full ASN.1 parser is overkill here: for a P-256 certificate the SPKI is
 * the 91-byte structure that begins with the fixed prime256v1 algorithm
 * identifier, so we locate that prefix rather than walking the tree.
 */
async function spkiFromCertificate(der: Uint8Array): Promise<Uint8Array | null> {
  // SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 } BIT STRING }
  const marker = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  ];
  outer: for (let i = 0; i + marker.length <= der.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (der[i + j] !== marker[j]) continue outer;
    }
    return der.slice(i, i + 0x5b);
  }
  return null;
}
