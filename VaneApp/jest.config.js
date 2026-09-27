// The React Native preset does not transform node_modules by default, but
// several of this app's dependencies ship untranspiled ESM — AsyncStorage,
// Notifee, the Firebase modules, react-navigation and react-native-iap all
// publish `import` statements. Without them in transformIgnorePatterns the
// whole suite dies at the first import with "Cannot use import statement
// outside a module", which is why it was failing on a clean tree before any of
// the markets work landed.
module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: [
    'node_modules/(?!(?:' +
      [
        '@react-native',
        'react-native',
        '@react-native-async-storage',
        '@react-native-firebase',
        '@react-navigation',
        '@notifee',
        'react-native-iap',
        'react-native-nitro-modules',
        'react-native-svg',
        'react-native-screens',
        'react-native-safe-area-context',
      ].join('|') +
      ')/)',
  ],
};
