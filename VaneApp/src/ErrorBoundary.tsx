// Last line of defence. Without this, any render-time throw shows the user a
// blank white screen with no explanation and no way back.

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { C } from './theme.ts';

type Props = { children: React.ReactNode };
type State = { error: Error | null; attempts: number };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, attempts: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Kept to console rather than a crash reporter: shipping analytics is a
    // privacy decision, not a default.
    console.error('[VANE] unhandled render error', error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // Deliberately does NOT cap font scaling: someone who needs large text
    // needs it most when something has gone wrong. That makes the content
    // scrollable a requirement, or the button drifts off-screen.
    return (
      <View style={st.root}>
        <ScrollView contentContainerStyle={st.content}>
          <Text style={st.title} accessibilityRole="header">Something broke</Text>
          <Text style={st.body}>
            VANE hit an unexpected error and stopped. Reopening the app usually
            clears it.
          </Text>
          {__DEV__ && <Text style={st.detail}>{error.message}</Text>}
          {this.state.attempts >= 2 && (
            <Text style={st.detail}>
              This keeps happening. Fully closing and reopening the app is more
              likely to help than retrying again.
            </Text>
          )}
          <Pressable
            onPress={() =>
              this.setState((prev) => ({ error: null, attempts: prev.attempts + 1 }))
            }
            accessibilityRole="button"
            accessibilityLabel="Try again"
            style={st.retry}>
            <Text style={st.retryText}>Try again</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: {
    flexGrow: 1, alignItems: 'center', justifyContent: 'center',
    padding: 28, gap: 10,
  },
  title: { color: C.text, fontSize: 20, fontWeight: '700' },
  body: { color: C.dim, fontSize: 14, textAlign: 'center', lineHeight: 21 },
  detail: { color: C.faint, fontSize: 11, textAlign: 'center', marginTop: 8 },
  retry: {
    marginTop: 14, paddingVertical: 15, paddingHorizontal: 28,
    minHeight: 48, minWidth: 160,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 14, borderWidth: 1, borderColor: C.cardBorder,
  },
  retryText: { color: C.accent, fontSize: 15, fontWeight: '700' },
});
