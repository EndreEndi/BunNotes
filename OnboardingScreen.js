import React, { useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Image, Animated, ScrollView,
  StyleSheet, Platform, Linking,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Audio } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import WhisperManager, { MODELS, MODEL_NAMES } from './WhisperManager';

const bunnyLogo = require('./assets/icon.png');

const C = {
  bg: '#000000', surface: '#111111', border: '#232323',
  text: '#f0f0f0', bright: '#f0f0f0', white: '#f0f0f0', muted: '#999999',
  accent: '#4db8bd', accentDk: '#296266', error: '#ff3b5c',
};
const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export default function OnboardingScreen({ onComplete }) {
  const [screen, setScreen] = useState(0);
  const [micGranted, setMicGranted] = useState(false);
  const [micDenied, setMicDenied] = useState(false);
  const [selectedModel, setSelectedModel] = useState('base');
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const transition = (next) => {
    Animated.timing(fadeAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => {
      setScreen(next);
      Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    });
  };

  const skip = async () => {
    await AsyncStorage.setItem('onboarding_done', 'true');
    onComplete();
  };

  const requestMic = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (perm.granted) {
        setMicGranted(true);
        setTimeout(() => transition(2), 600);
      } else {
        setMicDenied(true);
      }
    } catch {
      setMicDenied(true);
    }
  };

  const downloadModel = async () => {
    setDownloading(true);
    setDownloadProgress(0);
    setDownloadFailed(false);
    try {
      await WhisperManager.downloadModel(
        (written, total) => { if (total > 0) setDownloadProgress(written / total); },
        selectedModel
      );
      await WhisperManager.initialize(selectedModel);
      setModelReady(true);
      setDownloading(false);
      setTimeout(() => transition(3), 600);
    } catch {
      setDownloading(false);
      setDownloadProgress(0);
      setDownloadFailed(true);
    }
  };

  const finish = async () => {
    await AsyncStorage.setItem('onboarding_done', 'true');
    onComplete();
  };

  const renderDots = () => (
    <View style={os.dots}>
      {[0, 1, 2, 3].map(i => (
        <View key={i} style={[os.dot, i === screen && os.dotActive]} />
      ))}
    </View>
  );

  return (
    <View style={os.container}>
      <StatusBar style="light" />
      <Animated.View style={[os.content, { opacity: fadeAnim }]}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 32, paddingBottom: 40 }} showsVerticalScrollIndicator={false} bounces={true}>
        {screen === 0 && (
          <View style={os.center}>
            <Image source={bunnyLogo} style={os.logo} />
            <Text style={os.title}>Welcome to BunNotes</Text>
            <Text style={os.subtitle}>Capture ideas before they vanish</Text>
            <Text style={os.desc}>
              Your voice notes stay on your device {'\u2014'} no cloud, no subscriptions.
            </Text>
            <TouchableOpacity style={os.btn} onPress={() => transition(1)}>
              <Text style={os.btnTxt}>Get Started</Text>
            </TouchableOpacity>
          </View>
        )}

        {screen === 1 && (
          <View style={os.center}>
            <Text style={{ fontSize: 64, marginBottom: 24 }}>{'\uD83C\uDF99\uFE0F'}</Text>
            <Text style={os.title}>Microphone Access</Text>
            <Text style={os.desc}>BunNotes needs your microphone to record voice notes.</Text>
            {micDenied ? (
              <>
                <Text style={[os.desc, { color: C.error, marginTop: 16 }]}>
                  Microphone access was denied. BunNotes can't record without it.
                </Text>
                <TouchableOpacity style={os.btn} onPress={() => Linking.openSettings()}>
                  <Text style={os.btnTxt}>Open Settings</Text>
                </TouchableOpacity>
              </>
            ) : micGranted ? (
              <View style={{ alignItems: 'center', marginTop: 24 }}>
                <Text style={{ fontSize: 32, color: C.accent, marginBottom: 8 }}>{'\u2713'}</Text>
                <Text style={[os.desc, { color: C.accent }]}>Microphone enabled</Text>
              </View>
            ) : (
              <TouchableOpacity style={os.btn} onPress={requestMic}>
                <Text style={os.btnTxt}>Allow</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {screen === 2 && (
          <View style={os.center}>
            <Text style={os.title}>Download Voice Model</Text>
            <Text style={os.desc}>
              BunNotes uses AI to turn your voice into text, right on your phone.
              Supports English & Romanian.
            </Text>
            {MODEL_NAMES.map(name => {
              const m = MODELS[name];
              const selected = selectedModel === name;
              const descs = {
                tiny: 'Fast and light \u2014 good for quick notes',
                base: 'Balanced speed and accuracy',
                small: 'Best quality \u2014 takes longer to process',
              };
              return (
                <TouchableOpacity key={name} disabled={downloading}
                  style={[os.modelCard, selected && os.modelSelected]}
                  onPress={() => setSelectedModel(name)}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[os.modelName, selected && { color: C.accent }]}>
                        {m.label}{name === 'base' ? ' \u00B7 Recommended' : ''}
                      </Text>
                      <Text style={os.modelDesc}>{descs[name]}</Text>
                    </View>
                    <Text style={os.modelSize}>{m.size}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
            {downloading ? (
              <View style={{ width: '100%', marginTop: 24 }}>
                <View style={os.progressBg}>
                  <View style={[os.progressFill, { width: `${Math.round(downloadProgress * 100)}%` }]} />
                </View>
                <Text style={os.progressTxt}>{Math.round(downloadProgress * 100)}%</Text>
              </View>
            ) : modelReady ? (
              <View style={{ alignItems: 'center', marginTop: 24 }}>
                <Text style={{ fontSize: 32, color: C.accent }}>{'\u2713'}</Text>
                <Text style={[os.desc, { color: C.accent }]}>Model ready</Text>
              </View>
            ) : (
              <>
                {downloadFailed && (
                  <Text style={[os.desc, { color: C.error, marginTop: 12 }]}>
                    Download failed. Check your internet connection and try again.
                  </Text>
                )}
                <TouchableOpacity style={[os.btn, { marginTop: 20 }]} onPress={downloadModel}>
                  <Text style={os.btnTxt}>Download</Text>
                </TouchableOpacity>
              </>
            )}
            <Text style={[os.desc, { fontSize: 12, marginTop: 16 }]}>
              You can change this later in Settings
            </Text>
          </View>
        )}

        {screen === 3 && (
          <View style={os.center}>
            <Image source={bunnyLogo} style={os.logo} />
            <Text style={os.title}>You're all set!</Text>
            <Text style={os.desc}>Tap the record button and start talking.</Text>
            <Text style={[os.desc, { fontSize: 13, color: C.accent, marginTop: 12 }]}>
              Pro tip: Add the BunNotes widget to your home screen for one-tap recording
            </Text>
            <TouchableOpacity style={[os.btn, { marginTop: 28 }]} onPress={finish}>
              <Text style={os.btnTxt}>Start</Text>
            </TouchableOpacity>
          </View>
        )}
        </ScrollView>
      </Animated.View>

      {renderDots()}

      <TouchableOpacity onPress={skip} style={os.skipBtn}>
        <Text style={os.skipTxt}>Skip</Text>
      </TouchableOpacity>
    </View>
  );
}

const os = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { flex: 1 },
  center: { alignItems: 'center' },
  logo: { width: 100, height: 100, borderRadius: 24, marginBottom: 24 },
  title: { fontSize: 24, fontWeight: '700', color: C.white, textAlign: 'center', marginBottom: 12 },
  subtitle: { fontFamily: MONO, fontSize: 16, color: C.accent, textAlign: 'center', marginBottom: 8 },
  desc: { fontFamily: MONO, fontSize: 14, color: C.muted, textAlign: 'center', lineHeight: 22, marginBottom: 4 },
  btn: { backgroundColor: C.accent, borderRadius: 14, paddingVertical: 16, paddingHorizontal: 48, marginTop: 32, minWidth: 200, alignItems: 'center' },
  btnTxt: { fontFamily: MONO, fontSize: 16, fontWeight: '700', color: '#000' },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingBottom: 20 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.border },
  dotActive: { backgroundColor: C.accent, width: 24 },
  skipBtn: { position: 'absolute', bottom: 44, alignSelf: 'center' },
  skipTxt: { fontFamily: MONO, fontSize: 13, color: C.muted },
  modelCard: { width: '100%', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 14, marginTop: 10 },
  modelSelected: { borderColor: C.accent, borderWidth: 2 },
  modelName: { fontFamily: MONO, fontSize: 14, fontWeight: '600', color: C.bright },
  modelSize: { fontFamily: MONO, fontSize: 12, color: C.muted },
  modelDesc: { fontFamily: MONO, fontSize: 11, color: C.muted, marginTop: 2 },
  progressBg: { height: 6, backgroundColor: C.border, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: C.accent, borderRadius: 3 },
  progressTxt: { fontFamily: MONO, fontSize: 12, color: C.muted, textAlign: 'center', marginTop: 6 },
});
