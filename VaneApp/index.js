/**
 * @format
 */

import { AppRegistry } from 'react-native';
import notifee, { EventType } from '@notifee/react-native';
import { getMessaging, setBackgroundMessageHandler } from '@react-native-firebase/messaging';
import App from './App';
import { name as appName } from './app.json';

// Background/quit-state handlers MUST be registered at module scope, outside
// the component tree — React has not mounted when the OS delivers these.
// Without them, data-only pushes are dropped while backgrounded and tapping a
// notification from a killed state does nothing.
try {
  setBackgroundMessageHandler(getMessaging(), async () => {
    // Notification-payload pushes are drawn by the OS. Nothing more is needed
    // here yet; the handler must exist so FCM does not warn and drop.
  });
} catch {
  // Firebase unavailable (e.g. config missing) — local notifications still work.
}

notifee.onBackgroundEvent(async ({ type, detail }) => {
  if (type === EventType.PRESS && detail.notification?.id) {
    // Deep-linking into the tapped coin belongs here once routes are named.
  }
});

AppRegistry.registerComponent(appName, () => App);
