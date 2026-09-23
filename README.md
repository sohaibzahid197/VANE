# VANE — AI crypto prediction app

Two independent pieces, both free to run:

```
vane-pipeline/   Node + TypeScript. Fetches prices, scores signals, publishes
                 one Firestore document. Runs on GitHub Actions cron ($0).
VaneApp/         React Native app for iOS and Android.
Vane Prediction App.dc.html   The original design canvas (needs an HTTP server).
```

## Status

| Area | State |
|---|---|
| Design (7 screens) | ✅ complete, in the canvas |
| Pipeline: fetch, indicators, signal, backtest | ✅ built and run |
| Pipeline: Firestore publish | ⚠️ blocked — Firestore database not yet created |
| **Model validation** | ❌ **fails the gate — see below** |
| App: all 7 screens + navigation | ✅ built |
| App: responsive scaling | ✅ iOS + Android, phone + tablet |
| App: Firebase integration | ⬜ not started |
| App: in-app purchases | ⬜ deliberately last |
| App: push notifications | ⬜ not started |

## The model does not work yet

`npm run backtest` in `vane-pipeline/` scores the signal against the naive
baseline "the last 24 hours keep going." Latest run, ~40,000 hourly candles
across five coins:

```
  horizon      n     model    naive     edge   verdict
  24H      6050    46.3%    47.4%  -1.1pp   fail
  7D       5930    48.2%    47.6%  +0.7pp   fail
  30D      5470    48.6%    48.5%  +0.1pp   fail
```

Worse, confidence is inverted — the highest-scoring bucket is the least
accurate (43.7%). So `publish.ts` ships `conf: null` and the app must not
render a confidence percentage until a horizon clears the gate.

Do not "fix" this by flipping the signal. A 43.7% bucket inverts to 56.3%,
which looks like an edge but is curve-fitting to one market regime.

Crowd sentiment and the personal track record need no model at all, and are
the two features to lead with meanwhile.

## Running it

**Pipeline** — no credentials needed for either of these:

```bash
cd vane-pipeline
npm run backtest              # walk-forward accuracy + calibration
DRY_RUN=1 npm run refresh     # print the Firestore document
```

To actually publish, create the Firestore database first, then:

```bash
export FIREBASE_SERVICE_ACCOUNT="$(cat ~/.config/vane/service-account.json)"
npm run refresh
```

**App** — Metro must run in its own terminal, or you get a red
`No script URL provided` screen even though the build succeeded:

```bash
cd VaneApp
npx react-native start                  # leave this running
npx react-native run-ios --no-packager
npx react-native run-android --no-packager
```

## Free-tier budget

Everything here is free without a credit card. The two limits that shape the
design:

- **Firestore: 50,000 reads/day.** Every coin for every timeframe lives in
  ONE document (`public/signals_latest`), so an app open costs 1 read instead
  of 5. That is the difference between ~10,000 and ~50,000 daily opens.
- **GitHub Actions: 2,000 min/month on a private repo.** A 15-minute cron
  needs 2,880 runs and does not fit, so the workflow is `*/30`. Make the repo
  public for unlimited minutes and drop it back to `*/15`.

Firebase Cloud Functions are **not** used — they require the Blaze plan and a
payment method. GitHub Actions replaces them for all scheduled work.

The only unavoidable cost is the Apple Developer Program, $99/year.

## Secrets

The service-account JSON is a root credential for the whole Firebase project.
It lives at `~/.config/vane/service-account.json` (mode 600), never in the
repo, and reaches CI as the GitHub secret `FIREBASE_SERVICE_ACCOUNT`.

`firestore.rules` is the entire authorization layer, since there is no server.
Three invariants matter most: `public/**` is read-only to clients,
`users/{uid}/entitlement` is never client-writable, and predictions are
append-only so a user cannot manufacture a perfect track record.
