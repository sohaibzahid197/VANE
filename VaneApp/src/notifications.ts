// Local notifications via Notifee.
//
// WHY NOT expo-notifications: it was attempted and does not build on this
// project. React Native 0.87.1 falls in a gap between Expo SDKs — SDK 57
// targets RN ~0.86, SDK 58 targets RN ~0.88 (still an RC). Installing SDK 57
// against 0.87.1 gets as far as compiling, then fails in Expo's own source:
//   ExpoReactNativeFactory.swift: type 'any RCTReactNativeFactoryDelegate'
//   has no member 'extraModulesForBridge' / 'extraLazyModuleClasses'
// React Native changed that delegate protocol between 0.86 and 0.87, so no
// build setting bridges it. Revisit when Expo SDK 58 and RN 0.88 are stable.
//
// Scope: the 08:00 daily digest is scheduled LOCALLY, which gets every
// timezone right at zero server cost. The other four alerts are
// server-driven, so this module also registers the device's FCM token and
// renders incoming pushes through Notifee (FCM's own display on iOS is
// limited, and routing both paths through one renderer keeps them
// consistent).

import notifee, {
  AndroidImportance,
  AuthorizationStatus,
  RepeatFrequency,
  TriggerType,
  type TimestampTrigger,
} from '@notifee/react-native';
import {
  getMessaging,
  getToken,
  onMessage,
  onTokenRefresh,
  requestPermission as fcmRequestPermission,
} from '@react-native-firebase/messaging';
import { Platform } from 'react-native';
import { saveFcmToken } from './firebase.ts';

const CHANNEL_ID = 'vane-signals';
const DIGEST_ID = 'daily-digest';

/** Android needs a channel before anything can be posted to it. */
export async function ensureChannel() {
  if (Platform.OS !== 'android') return;
  await notifee.createChannel({
    id: CHANNEL_ID,
    name: 'Signal alerts',
    description: 'Daily digests and signal changes',
    importance: AndroidImportance.DEFAULT,
  });
}

/**
 * Ask for permission. Call AFTER onboarding with context, never on first
 * launch — a cold prompt gets declined by most users and iOS only lets you
 * ask once.
 */
export async function requestPermission(): Promise<boolean> {
  const settings = await notifee.requestPermission();
  return (
    settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
    settings.authorizationStatus === AuthorizationStatus.PROVISIONAL
  );
}

export async function hasPermission(): Promise<boolean> {
  const settings = await notifee.getNotificationSettings();
  // PROVISIONAL counts: requestPermission() accepts it, so excluding it here
  // left provisionally-authorised users permanently told "notifications are
  // off" with the digest never scheduled.
  return (
    settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
    settings.authorizationStatus === AuthorizationStatus.PROVISIONAL
  );
}

/** True when the OS will not show a prompt again — the user must go to
 *  Settings. Used to offer a route out instead of a dead button. */
export async function permissionIsBlocked(): Promise<boolean> {
  const settings = await notifee.getNotificationSettings();
  return settings.authorizationStatus === AuthorizationStatus.DENIED;
}

/** Next occurrence of `hour:00` in the device's own timezone. */
function nextAt(hour: number): number {
  const when = new Date();
  when.setHours(hour, 0, 0, 0);
  if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
  return when.getTime();
}

/**
 * The 08:00 local daily digest. Scheduled on-device rather than pushed, which
 * handles every timezone correctly and costs nothing on the server.
 */
export async function scheduleDailyDigest(hour = 8) {
  await ensureChannel();
  await cancelDailyDigest();

  const trigger: TimestampTrigger = {
    type: TriggerType.TIMESTAMP,
    timestamp: nextAt(hour),
    repeatFrequency: RepeatFrequency.DAILY,
  };

  await notifee.createTriggerNotification(
    {
      id: DIGEST_ID,
      title: 'Today’s signals are in',
      body: 'See what the model expects across your watchlist.',
      android: { channelId: CHANNEL_ID, pressAction: { id: 'default' } },
      ios: { sound: 'default' },
    },
    trigger,
  );
}

export async function cancelDailyDigest() {
  await notifee.cancelTriggerNotification(DIGEST_ID);
}

/** Which trigger notifications are currently scheduled. */
export async function scheduledIds(): Promise<string[]> {
  return notifee.getTriggerNotificationIds();
}

/**
 * Reconcile the scheduled digest against the user's toggle state.
 * Index 3 of the alerts array is the daily digest, scheduled on-device. The
 * other four are delivered by the server to this device's FCM token.
 */
export async function syncAlerts(alerts: boolean[]) {
  if (alerts[3]) await scheduleDailyDigest();
  else await cancelDailyDigest();
}

/**
 * Register for server-driven alerts.
 *
 * Stores the token at `users/{uid}.fcmToken`, which the rules permit the
 * client to write and the sender reads. Re-registers on refresh, because a
 * stale token silently stops delivery with no error anywhere.
 *
 * Returns an unsubscribe for the foreground listener.
 */
export async function registerForPush(): Promise<() => void> {
  try {
    const m = getMessaging();
    await fcmRequestPermission(m);

    const token = await getToken(m);
    if (token) await saveFcmToken(token);

    const offRefresh = onTokenRefresh(m, (t: string) => {
      saveFcmToken(t).catch(() => {});
    });

    // A push arriving while the app is open is not displayed by the OS, so
    // render it through Notifee for parity with background delivery.
    const offMessage = onMessage(m, async (msg: any) => {
      const n = msg?.notification;
      // A data-only push carries its copy in `data`. Returning early on a
      // missing `notification` block meant those were silently dropped, so
      // the app could only ever display pushes the OS would have drawn
      // anyway — which is the opposite of why this handler exists.
      const title = n?.title ?? msg?.data?.title;
      const body = n?.body ?? msg?.data?.body;
      if (!title && !body) return;
      await ensureChannel();
      await notifee.displayNotification({
        title: title ?? 'VANE',
        body: body ?? '',
        android: { channelId: CHANNEL_ID, pressAction: { id: 'default' } },
        ios: { sound: 'default' },
      });
    });

    return () => {
      offRefresh();
      offMessage();
    };
  } catch {
    // No Firebase, no permission, or a simulator without APNs: local
    // notifications still work, the user simply gets no server pushes.
    return () => {};
  }
}

