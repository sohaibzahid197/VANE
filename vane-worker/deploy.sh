#!/usr/bin/env bash
# One-shot deploy for the VANE entitlement Worker.
#
# Run it from vane-worker/ AFTER `npx wrangler login`. It sets the four
# secrets, deploys, reads back the real URL and writes that URL into the app,
# so the placeholder in entitlement.ts cannot be forgotten — which would mean
# every purchase is charged and never entitled.
set -euo pipefail

P8="${1:-}"
if [ -z "$P8" ] || [ ! -f "$P8" ]; then
  echo "usage: ./deploy.sh /path/to/AuthKey_XXXXXXXXXX.p8" >&2
  exit 1
fi

SA="$HOME/.config/vane/service-account.json"
[ -f "$SA" ] || { echo "missing $SA" >&2; exit 1; }

# The key id is in the filename Apple gives you. The prefix differs by key
# type — an In-App Purchase key downloads as SubscriptionKey_<KEYID>.p8, an
# App Store Connect API key as AuthKey_<KEYID>.p8 — so strip whichever is
# there rather than assuming. A key id carrying the prefix is not rejected
# locally: Apple simply refuses every JWT, and every purchase fails to
# validate with no clue as to why.
KEY_ID="$(basename "$P8" .p8 | sed -E 's/^(SubscriptionKey|AuthKey|InAppPurchaseKey)_//')"

# Apple's key ids are 10 characters of uppercase letters and digits. Anything
# else means the filename was renamed and the id must be typed by hand.
if ! printf '%s' "$KEY_ID" | grep -qE '^[A-Z0-9]{10}$'; then
  echo "Could not read a key id from the filename (got: '$KEY_ID')." >&2
  read -r -p "Key ID (10 characters, shown next to the key in App Store Connect): " KEY_ID
  printf '%s' "$KEY_ID" | grep -qE '^[A-Z0-9]{10}$' || { echo "That is not a valid key id." >&2; exit 1; }
fi
echo "Key ID: $KEY_ID"

read -r -p "Issuer ID (from Users and Access > Integrations, above the Active table): " ISSUER_ID
# The issuer id is a UUID. Pasting the key id here by mistake is easy and the
# only symptom would be Apple rejecting every request.
if ! printf '%s' "$ISSUER_ID" | grep -qiE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  echo "That does not look like an Issuer ID — it should be a UUID like" >&2
  echo "57246542-96fe-1a63-e053-0824d011072a, shown ABOVE the Active table." >&2
  exit 1
fi

echo
echo "Setting secrets..."
# Piped, never pasted: the .p8 is a PEM and its newlines are load-bearing.
printf '%s' "$KEY_ID"    | npx wrangler secret put APPLE_KEY_ID
printf '%s' "$ISSUER_ID" | npx wrangler secret put APPLE_ISSUER_ID
npx wrangler secret put APPLE_PRIVATE_KEY < "$P8"
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT < "$SA"

echo
echo "Deploying..."
OUT="$(npx wrangler deploy 2>&1)"
echo "$OUT"

URL="$(printf '%s' "$OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)"
if [ -z "$URL" ]; then
  echo
  echo "Could not read the deployed URL from wrangler's output." >&2
  echo "Find it in the Cloudflare dashboard and edit VALIDATE_URL by hand." >&2
  exit 1
fi

APP_FILE="../VaneApp/src/entitlement.ts"
python3 - "$URL" "$APP_FILE" <<'PY'
import re, sys
url, path = sys.argv[1], sys.argv[2]
s = open(path).read()
s = re.sub(r"export const VALIDATE_URL = '[^']*';",
           f"export const VALIDATE_URL = '{url}/validate';", s)
open(path, 'w').write(s)
print(f"\nVALIDATE_URL set to {url}/validate")
PY

echo
echo "Smoke test (expect 401 'missing token' — that means it is alive):"
curl -s -X POST "$URL/validate" -w '\nHTTP %{http_code}\n'

echo
echo "Next: register this URL with Apple, BOTH boxes, Version 2:"
echo "  $URL/apple-notifications"
echo "App Store Connect > your app > App Information > App Store Server Notifications"
