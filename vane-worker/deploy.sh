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

# The key id is in the filename Apple gives you: AuthKey_<KEYID>.p8
KEY_ID="$(basename "$P8" .p8 | sed 's/^AuthKey_//')"
echo "Key ID detected from filename: $KEY_ID"
read -r -p "Issuer ID (from Users and Access > Integrations, above the Active table): " ISSUER_ID
[ -n "$ISSUER_ID" ] || { echo "issuer id is required" >&2; exit 1; }

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
