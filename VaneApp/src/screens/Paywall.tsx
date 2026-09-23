// Screen 1b — the paywall.
//
// Every price on this screen comes from StoreKit. None of it is hardcoded,
// and that is not a style preference: this screen previously advertised
// "$49.99 / year" in the plan card and "$79.99 per year" in the fine print
// directly beneath it, while App Store Connect held a third number. Reading
// the price from the product is the only way those can never disagree.
//
// It also fixes the internationalisation problem. StoreKit returns the price
// already formatted for the user's storefront, so a buyer in Pakistan sees
// rupees rather than a dollar figure they will not be charged. Misstating the
// price is an App Store guideline 3.1.2 rejection, not a cosmetic bug.
//
// The disclosure layout follows 3.1.2: title, length of subscription, price
// per period, and the Terms/Privacy links adjacent to the purchase button
// rather than buried in Settings.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, tint } from '../theme.ts';
import { useScale } from '../responsive.ts';
import { Button, ErrorState, Loading, MIN_TAP, Text, tapSlop } from '../ui.tsx';
import { useStore } from '../store.tsx';
import { IconClose, IconTick } from '../icons.tsx';
import { PLAN_LABEL, PLAN_ORDER, type PlanId } from '../products.ts';
import { buy, complete, loadOffers, restore, type PlanOffer } from '../purchases.ts';

/** Opening a URL can reject (no handler, malformed link). Unhandled, that is
 *  a silent no-op for the user and a LogBox warning for us. */
function openExternal(url: string) {
  Linking.openURL(url).catch(() => {
    Alert.alert("Couldn't open link", url);
  });
}

const TERMS = 'https://sohaibzahid197.github.io/VANE-legal/terms-and-conditions.html';
const PRIVACY = 'https://sohaibzahid197.github.io/VANE-legal/privacy-policy.html';

const PERKS = [
  'Every signal across all 30 coins',
  'Model reasoning for every call',
  '24h, 7d and 30d price targets',
  'Push alerts when a signal flips',
  'Full history and accuracy stats',
];

/** Billing periods per year, for the per-month comparison line. */
const PER_YEAR: Record<PlanId, number> = { weekly: 52, monthly: 12, yearly: 1 };

/** What one month of a plan costs, so plans of different periods compare. */
const monthlyRate = (o: PlanOffer) => (o.amount * PER_YEAR[o.plan]) / 12;

/** True when StoreKit gave us a usable number to do arithmetic on. */
const hasAmount = (o: PlanOffer) => Number.isFinite(o.amount) && o.amount > 0;

/**
 * Format a derived amount the way the storefront would.
 *
 * `toFixed(2)` prefixed with the ISO code produced "USD 6.67" next to
 * StoreKit's own "$79.99" — two money formats on one line — and "6,67 €"
 * storefronts got a dot decimal. Intl handles both; if the currency code is
 * missing or invalid it throws, and no derived figure is better than a wrong
 * one sitting beside a real price.
 */
function money(amount: number, currency: string): string | null {
  if (!currency || !Number.isFinite(amount)) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return null;
  }
}

/**
 * Saving against the most expensive plan per month, rounded down.
 *
 * Computed from the real prices rather than asserted. The old screen claimed a
 * flat "SAVE 86%" next to prices that did not produce 86%, which is precisely
 * the sort of unverifiable claim 3.1.2 exists to stop.
 */
function savingPercent(offer: PlanOffer, all: PlanOffer[]): number | null {
  const usable = all.filter(hasAmount);
  if (!hasAmount(offer) || usable.length < 2) return null;
  const rates = usable.map(monthlyRate);
  const dearest = Math.max(...rates);
  const cheapest = Math.min(...rates);
  const mine = monthlyRate(offer);
  // One badge, on the best-value plan only. Rendering a tag on two of three
  // cards reads as decoration rather than a recommendation.
  if (mine > cheapest || !Number.isFinite(dearest) || dearest <= 0) return null;
  const pct = Math.floor(((dearest - mine) / dearest) * 100);
  return pct >= 5 ? pct : null;
}

/** The plan the saving is measured against, so the claim can be stated. */
function baselinePlan(all: PlanOffer[]): PlanId | null {
  const usable = all.filter(hasAmount);
  if (usable.length < 2) return null;
  return usable.reduce((a, b) => (monthlyRate(a) >= monthlyRate(b) ? a : b)).plan;
}

type Status = 'loading' | 'ready' | 'unavailable';

export default function Paywall({ onClose }: { onClose: () => void }) {
  const { plan, setPlan, setPro } = useStore();
  const s = useScale();
  const st = useStyles();

  const [offers, setOffers] = useState<PlanOffer[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [busy, setBusy] = useState(false);

  // `busy` as state has a one-frame hole: two taps dispatched in the same
  // batch both read the pre-render value and both start work. The ref closes
  // it, and also lets Subscribe and Restore lock each other out.
  const working = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const fetchOffers = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    setStatus('loading');
    // Clearing first stops a stale offer staying selected and purchasable
    // behind the spinner while a retry is in flight.
    setOffers([]);
    try {
      const found = await loadOffers();
      if (!mounted.current) return;
      setOffers(found);
      setStatus(found.length > 0 ? 'ready' : 'unavailable');
    } catch {
      // loadOffers swallows most errors, but connect() can still reject.
      // Without this the screen sits on the spinner forever, and the only
      // retry control lives in the state the user can no longer reach.
      if (mounted.current) setStatus('unavailable');
    } finally {
      working.current = false;
    }
  }, []);

  useEffect(() => {
    void fetchOffers();
  }, [fetchOffers]);

  // Show plans in a stable order regardless of what order the store returns.
  const sorted = useMemo(
    () =>
      [...offers].sort(
        (a, b) => PLAN_ORDER.indexOf(a.plan) - PLAN_ORDER.indexOf(b.plan),
      ),
    [offers],
  );

  // The selected plan must be one the store actually offered. A stale
  // selection restored from disk could otherwise point at a product that is
  // no longer for sale, and the purchase would fail with nothing on screen to
  // explain why.
  const selected = useMemo(
    () => sorted.find((o) => o.plan === plan) ?? sorted[0],
    [sorted, plan],
  );

  // Write the fallback back to the store. Silently charging `sorted[0]` while
  // the store still held an unavailable plan made Settings report a different
  // subscription from the one the user actually bought.
  useEffect(() => {
    if (selected && selected.plan !== plan) setPlan(selected.plan);
  }, [selected, plan, setPlan]);

  const onSubscribe = useCallback(async () => {
    if (!selected || working.current) return;
    working.current = true;
    setBusy(true);
    // Captured now: the plan must not change under an in-flight purchase.
    const buying = selected.plan;
    try {
      const result = await buy(buying);
      if (result.status === 'cancelled') return;
      if (result.status === 'failed') {
        Alert.alert('Purchase failed', result.reason);
        return;
      }

      // TODO(entitlement): the transaction should go to the receipt validator,
      // which writes users/{uid}/entitlement, and this screen should read that
      // back. Until that exists, entitlement is a local flag — good enough to
      // exercise the flow, NOT good enough to ship as the only gate.
      //
      // Entitlement is granted BEFORE the transaction is finished. Finishing
      // drops it from the StoreKit queue, so doing that first means a crash in
      // between leaves the user charged with no entitlement and no replay.
      setPro(true);
      await complete(result.transaction);
      if (mounted.current) onClose();
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [selected, setPro, onClose]);

  const onRestore = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      const found = await restore();
      if (found.length === 0) {
        Alert.alert('Nothing to restore', 'No previous purchase was found for this Apple Account.');
        return;
      }
      setPro(true);
      Alert.alert('Restored', 'Your subscription is active again.');
      if (mounted.current) onClose();
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [setPro, onClose]);

  return (
    <SafeAreaView style={st.root}>
      <View style={st.head}>
        <Text style={st.brand}>VANE PRO</Text>
        <Pressable
          onPress={onClose}
          hitSlop={14}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={st.close}>
          <IconClose size={s.w(15)} color={C.dim} />
        </Pressable>
      </View>

      <ScrollView
        style={st.body}
        contentContainerStyle={st.bodyContent}
        showsVerticalScrollIndicator={false}>
        <Text style={st.title} accessibilityRole="header">Every signal, unlocked.</Text>

        <View style={st.perks}>
          {PERKS.map((p) => (
            <View key={p} style={st.perkRow}>
              <IconTick size={s.w(16)} color={C.accent} />
              <Text style={st.perkText}>{p}</Text>
            </View>
          ))}
        </View>

        {/* Loading and ErrorState carry the progressbar role and the polite
            live region. Hand-rolling them here lost both: an
            accessibilityLabel on a non-`accessible` View is ignored on iOS,
            so neither the spinner nor the failure was ever announced. */}
        {status === 'loading' && <Loading label="Loading plans" />}

        {/* An empty product list is the single most confusing IAP failure:
            it means the products are not purchasable (agreement unsigned,
            not yet "Ready to Submit", wrong storefront), not that the user
            did something wrong. Saying so beats rendering a blank screen. */}
        {status === 'unavailable' && (
          <ErrorState
            message={
              "Plans aren't available right now. This is usually a temporary " +
              'store problem — please try again in a moment.'
            }
            onRetry={fetchOffers}
          />
        )}

        {status === 'ready' && (
          <View accessibilityRole="radiogroup" accessibilityLabel="Subscription plans">
            {sorted.map((o) => {
              const on = selected?.plan === o.plan;
              const save = savingPercent(o, sorted);
              const perMonth =
                o.plan === 'monthly' || !hasAmount(o)
                  ? null
                  : money(monthlyRate(o), o.currency);
              const against = save !== null ? baselinePlan(sorted) : null;
              return (
                <Pressable
                  key={o.productId}
                  onPress={() => setPlan(o.plan)}
                  // A plan tapped mid-purchase changed the highlight and the
                  // quoted price while StoreKit charged the captured plan.
                  disabled={busy}
                  accessibilityRole="radio"
                  accessibilityLabel={[
                    PLAN_LABEL[o.plan],
                    o.price,
                    perMonth ? `${perMonth} per month` : null,
                    save !== null && against
                      ? `saves ${save} percent against the ${PLAN_LABEL[against].toLowerCase()} plan`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                  accessibilityState={{ selected: on, disabled: busy }}
                  style={[st.plan, on ? st.planOn : st.planOff]}>
                  <View style={st.planLeft}>
                    <Text style={st.planName}>{PLAN_LABEL[o.plan]}</Text>
                    <Text style={st.planSub}>
                      {o.price}
                      {perMonth ? ` · ${perMonth} per month` : ''}
                    </Text>
                  </View>
                  {save !== null && (
                    <View style={st.saveTag}>
                      <Text style={st.saveText}>SAVE {save}%</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}

      </ScrollView>

      <View style={st.foot}>
        <Button
          title={
            busy
              ? 'Please wait…'
              : selected
                ? `Subscribe ${PLAN_LABEL[selected.plan].toLowerCase()}`
                : 'Subscribe'
          }
          disabled={!selected || busy}
          onPress={onSubscribe}
        />

        {/* The renewal disclosure quotes the same price object the button
            charges, so the two cannot drift apart. */}
        <Text style={st.fine}>
          {selected ? `${selected.price} per ${periodWord(selected.plan)}. ` : ''}
          Your subscription renews automatically unless cancelled at least 24
          hours before the period ends. Manage or cancel in your device's
          subscription settings.
        </Text>

        <View style={st.links}>
          <Pressable
            onPress={() => openExternal(TERMS)}
            hitSlop={tapSlop(80, 14)}
            accessibilityRole="link"
            accessibilityLabel="Terms of Use">
            <Text style={st.link}>Terms of Use</Text>
          </Pressable>
          <Text style={st.linkDot}>·</Text>
          <Pressable
            onPress={() => openExternal(PRIVACY)}
            hitSlop={tapSlop(80, 14)}
            accessibilityRole="link"
            accessibilityLabel="Privacy Policy">
            <Text style={st.link}>Privacy Policy</Text>
          </Pressable>
          <Text style={st.linkDot}>·</Text>
          {/* Guideline 3.1.1 requires a working restore in any app selling a
              subscription. This was a stub alert, which is a rejection. */}
          <Pressable
            onPress={onRestore}
            disabled={busy}
            hitSlop={tapSlop(80, 14)}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            accessibilityLabel="Restore purchases">
            <Text style={st.link}>Restore</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const periodWord = (p: PlanId) =>
  p === 'weekly' ? 'week' : p === 'monthly' ? 'month' : 'year';

function useStyles() {
  const { w, h, f, width } = useScale();
  return useMemo(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingHorizontal: w(18) },
  head: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingTop: h(6),
  },
  brand: { color: C.accent, fontSize: f(13), fontWeight: '700', letterSpacing: 3 },
  close: {
    width: w(30), height: w(30), borderRadius: w(15),
    backgroundColor: 'rgba(255,255,255,.08)',
    alignItems: 'center', justifyContent: 'center',
  },

  body: { flex: 1 },
  bodyContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: h(10) },
  title: {
    color: C.text, fontSize: f(29), fontWeight: '700',
    lineHeight: f(35), marginBottom: h(20),
  },
  perks: { gap: h(10), marginBottom: h(24) },
  perkRow: { flexDirection: 'row', alignItems: 'center', gap: w(10) },
  perkText: { color: C.dim, fontSize: f(14), flex: 1 },

  plan: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderRadius: w(16), padding: w(15), marginBottom: h(10), minHeight: MIN_TAP,
  },
  planOn: {
    borderWidth: 1.5, borderColor: C.accent,
    backgroundColor: tint(C.accent, 0.08),
  },
  planOff: {
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,.09)',
    backgroundColor: 'rgba(255,255,255,.03)',
  },
  planLeft: { flex: 1 },
  planName: { color: C.text, fontSize: f(16), fontWeight: '700' },
  planSub: { color: C.dim, fontSize: f(12), marginTop: h(3) },
  saveTag: {
    backgroundColor: C.accent, borderRadius: w(7),
    paddingHorizontal: w(8), paddingVertical: h(4),
  },
  saveText: { color: C.bg, fontSize: f(9), fontWeight: '700', letterSpacing: 0.5 },

  foot: { paddingBottom: h(8) },
  fine: {
    color: C.faint, fontSize: f(11), lineHeight: f(16),
    textAlign: 'center', marginTop: h(12),
  },
  links: {
    flexDirection: 'row', justifyContent: 'center',
    alignItems: 'center', gap: w(8), marginTop: h(10),
  },
  link: { color: C.dim, fontSize: f(11), textDecorationLine: 'underline' },
  linkDot: { color: C.faint, fontSize: f(11) },
}), [width, w, h, f]);
}
