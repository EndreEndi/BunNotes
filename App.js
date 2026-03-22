import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, TextInput, StyleSheet,
  Keyboard, Platform, AppState, ActivityIndicator, Linking,
  Image, Modal, FlatList, RefreshControl, PermissionsAndroid, BackHandler,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { StorageAccessFramework } from 'expo-file-system';
import WhisperManager, { MODELS, MODEL_NAMES } from './WhisperManager';
import SyncManager from './SyncManager';
import OnboardingScreen from './OnboardingScreen';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SOUNDS_DIR = FileSystem.documentDirectory + 'sounds/';
const AUDIO_DIR = FileSystem.documentDirectory + 'audio/';
const WIDGET_DIR = FileSystem.documentDirectory + 'widget_recordings/';
const HISTORY_KEY = 'transcription_history';
const DELETED_KEY = 'deleted_notes';
const PENDING_DELETES_KEY = 'pending_deletes';

const bunnyLogo = require('./assets/icon.png');
const defaultStartSound = require('./assets/sounds/record_start.mp3');
const defaultStopSound = require('./assets/sounds/record_stop.mp3');

const C = {
  bg: '#000000', surface: '#111111', border: '#232323',
  text: '#f0f0f0', bright: '#f0f0f0', white: '#f0f0f0', muted: '#999999',
  accent: '#4db8bd', accentDk: '#296266', error: '#ff3b5c',
};
const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const [serverUrl, setServerUrl] = useState('');
  const [serverOnline, setServerOnline] = useState(false);
  const [offlineMode, setOfflineMode] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadingModel, setDownloadingModel] = useState(null);
  const [downloadedModels, setDownloadedModels] = useState({});
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [syncStatus, setSyncStatus] = useState({ pending: 0 });
  const [toast, setToast] = useState(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [startSoundPath, setStartSoundPath] = useState(null);
  const [stopSoundPath, setStopSoundPath] = useState(null);
  const [startSoundName, setStartSoundName] = useState(null);
  const [stopSoundName, setStopSoundName] = useState(null);
  const [saveFolderUri, setSaveFolderUri] = useState(null);
  const [saveFolderName, setSaveFolderName] = useState(null);
  const [autoSave, setAutoSave] = useState(false);
  const [notes, setNotes] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [playingId, setPlayingId] = useState(null);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioStorageSize, setAudioStorageSize] = useState(0);
  const [onboardingDone, setOnboardingDone] = useState(null);
  const [showCelebration, setShowCelebration] = useState(false);
  const [serverExpanded, setServerExpanded] = useState(false);
  const [transLanguage, setTransLanguage] = useState('en');

  const playbackRef = useRef(null);
  const pendingAutoRecord = useRef(false);
  const recordingRef = useRef(null);
  const timerRef = useRef(null);
  const serverInputRef = useRef('');

  // -------------------------------------------------------------------------
  // Deep link (widget opens app with whispernotes://record)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const handle = (event) => {
      const url = typeof event === 'string' ? event : event?.url;
      if (url && url.includes('record')) {
        if (modelReady) startRecording();
        else pendingAutoRecord.current = true;
      }
    };
    Linking.getInitialURL().then((url) => { if (url) handle(url); });
    const sub = Linking.addEventListener('url', handle);
    return () => sub.remove();
  }, [modelReady]);

  useEffect(() => {
    if (modelReady && pendingAutoRecord.current) {
      pendingAutoRecord.current = false;
      setTimeout(() => startRecording(), 500);
    }
  }, [modelReady]);

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------
  useEffect(() => {
    (async () => {
      // Check onboarding
      const obDone = await AsyncStorage.getItem('onboarding_done');
      setOnboardingDone(obDone === 'true');

      // Load history
      try { const h = await AsyncStorage.getItem(HISTORY_KEY); if (h) setNotes(JSON.parse(h)); } catch {}

      // Notification permission (Android 13+)
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        try { await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS'); } catch {}
      }

      // Load preferences
      try {
        const [sf, sfn, as2, ss, se, ssn, sen, om] = await Promise.all([
          AsyncStorage.getItem('save_folder_uri'), AsyncStorage.getItem('save_folder_name'),
          AsyncStorage.getItem('auto_save'),
          AsyncStorage.getItem('sound_record_start'), AsyncStorage.getItem('sound_record_stop'),
          AsyncStorage.getItem('sound_record_start_name'), AsyncStorage.getItem('sound_record_stop_name'),
          AsyncStorage.getItem('offline_mode'),
        ]);
        if (sf) { setSaveFolderUri(sf); setSaveFolderName(sfn); }
        if (as2 === 'true') setAutoSave(true);
        if (ss) { setStartSoundPath(ss); setStartSoundName(ssn); }
        if (se) { setStopSoundPath(se); setStopSoundName(sen); }
        if (om === 'true') setOfflineMode(true);
        const lang = await AsyncStorage.getItem('transcription_language');
        if (lang) setTransLanguage(lang);
      } catch {}

      // Server
      const isOffline = (await AsyncStorage.getItem('offline_mode')) === 'true';
      const saved = await AsyncStorage.getItem('server_url');
      if (saved) {
        setServerUrl(saved); serverInputRef.current = saved;
        if (!isOffline) SyncManager.setServerUrl(saved);
      }

      // Background server sync
      if (saved && !isOffline) { syncNotesFromServer(saved); }

      // Check downloaded models and load active one
      const dlModels = await WhisperManager.getDownloadedModels();
      setDownloadedModels(dlModels);
      // Find a model to initialize (active or any downloaded)
      const active = await WhisperManager.getActiveModel();
      const modelToLoad = (active && dlModels[active]) ? active : MODEL_NAMES.find(n => dlModels[n]);
      if (modelToLoad) {
        try {
          await WhisperManager.initialize(modelToLoad);
          setModelReady(true);
          processWidgetRecordings();
        } catch {
          // Model file may be corrupted — don't scare the user
          showToast('Tap Settings to re-download your voice model');
        }
      }
      // No model downloaded — fresh install, onboarding will handle it
    })();
  }, []);

  // -------------------------------------------------------------------------
  // Onboarding
  // -------------------------------------------------------------------------
  const handleOnboardingComplete = async () => {
    setOnboardingDone(true);
    const dlModels = await WhisperManager.getDownloadedModels();
    setDownloadedModels(dlModels);
    if (WhisperManager.modelReady) {
      setModelReady(true);
    }
  };

  // -------------------------------------------------------------------------
  // Server connectivity
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!serverUrl || offlineMode) { if (offlineMode) setServerOnline(false); return; }
    const check = async () => {
      SyncManager.setServerUrl(serverUrl);
      const online = await SyncManager.checkConnection();
      setServerOnline(online);
      if (online) { SyncManager.processQueue(); try { setSyncStatus(await SyncManager.getStatus()); } catch {} }
    };
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, [serverUrl, offlineMode]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        if (serverUrl && !offlineMode) SyncManager.processQueue();
        if (modelReady) processWidgetRecordings();
      }
    });
    return () => sub.remove();
  }, [serverUrl, offlineMode, modelReady]);

  // -------------------------------------------------------------------------
  // Back handler for settings overlay
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!settingsVisible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setSettingsVisible(false);
      return true;
    });
    return () => sub.remove();
  }, [settingsVisible]);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  const showToast = useCallback((msg, isError = false) => {
    setToast({ msg, isError }); setTimeout(() => setToast(null), 3000);
  }, []);

  const fmtTimer = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const genTitle = (text) => {
    const words = text.trim().split(/\s+/).slice(0, 5).join(' ');
    return words.length > 40 ? words.slice(0, 40) + '...' : words;
  };

  const fmtDate = (iso) => {
    const d = new Date(iso); const diff = Date.now() - d;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const fmtDuration = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  const playSound = async (source) => {
    if (!source) return;
    try {
      const asset = typeof source === 'number' ? source : { uri: source };
      if (typeof source === 'string') {
        const info = await FileSystem.getInfoAsync(source);
        if (!info.exists) return;
      }
      const { sound } = await Audio.Sound.createAsync(asset);
      await sound.playAsync();
      sound.setOnPlaybackStatusUpdate((st) => { if (st.didJustFinish) sound.unloadAsync(); });
    } catch {}
  };

  // -------------------------------------------------------------------------
  // Notes persistence
  // -------------------------------------------------------------------------
  const persistNotes = async (items) => {
    setNotes(items);
    try { await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(items)); } catch {}
  };

  const addNote = async (text, audioSrcPath) => {
    const id = Date.now().toString();
    let savedAudioPath = null;
    if (audioSrcPath) {
      try {
        await FileSystem.makeDirectoryAsync(AUDIO_DIR, { intermediates: true });
        savedAudioPath = AUDIO_DIR + `note-${id}.wav`;
        const srcUri = audioSrcPath.startsWith('file://') ? audioSrcPath : 'file://' + audioSrcPath;
        await FileSystem.copyAsync({ from: srcUri, to: savedAudioPath });
      } catch { savedAudioPath = null; }
    }
    const item = { id, text, title: genTitle(text), createdAt: new Date().toISOString(), synced: !!serverUrl, audioPath: savedAudioPath, language: transLanguage };
    const updated = [item, ...notes].slice(0, 200);
    await persistNotes(updated);
    return item;
  };

  // -------------------------------------------------------------------------
  // Server sync
  // -------------------------------------------------------------------------
  const syncNotesFromServer = async (url) => {
    try {
      // Retry pending deletes
      try {
        const raw = await AsyncStorage.getItem(PENDING_DELETES_KEY);
        const pending = raw ? JSON.parse(raw) : [];
        const remaining = [];
        for (const fn of pending) {
          try {
            const r = await fetch(url + '/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: fn }) });
            if (!r.ok && r.status !== 404) remaining.push(fn);
          } catch { remaining.push(fn); }
        }
        await AsyncStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(remaining));
      } catch {}

      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(url + '/api/notes', { signal: controller.signal });
      clearTimeout(tid);
      if (!resp.ok) return;
      const { notes: serverNotes } = await resp.json();
      if (!serverNotes?.length) return;

      let deletedSet = new Set();
      try { const raw = await AsyncStorage.getItem(DELETED_KEY); if (raw) deletedSet = new Set(JSON.parse(raw)); } catch {}

      const localH = await AsyncStorage.getItem(HISTORY_KEY);
      const local = localH ? JSON.parse(localH) : [];
      const localDates = new Set(local.map(n => n.createdAt?.slice(0, 16)));
      const localTexts = new Set(local.map(n => n.text?.slice(0, 50)));
      const toAdd = [];
      for (const sn of serverNotes) {
        if (sn.filename && deletedSet.has(sn.filename)) continue;
        const dk = sn.date?.slice(0, 16); const tk = sn.preview?.slice(0, 50);
        if ((dk && localDates.has(dk)) || (tk && localTexts.has(tk))) continue;
        toAdd.push({
          id: sn.filename || Date.now().toString() + Math.random().toString(36).slice(2),
          text: sn.preview || '', title: sn.title || 'Synced Note',
          createdAt: sn.date ? new Date(sn.date).toISOString() : new Date().toISOString(),
          synced: true, serverFilename: sn.filename,
        });
      }
      if (toAdd.length) {
        const merged = [...local, ...toAdd].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 200);
        setNotes(merged);
        await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(merged));
        showToast(`Synced ${toAdd.length} note${toAdd.length > 1 ? 's' : ''}`);
      }
    } catch {}
  };

  const syncFromServer = async () => { if (serverUrl && !offlineMode) await syncNotesFromServer(serverUrl); };

  // -------------------------------------------------------------------------
  // Widget recordings
  // -------------------------------------------------------------------------
  const processWidgetRecordings = async () => {
    try {
      const dirInfo = await FileSystem.getInfoAsync(WIDGET_DIR);
      if (!dirInfo.exists || !dirInfo.isDirectory) return;
      const files = await FileSystem.readDirectoryAsync(WIDGET_DIR);
      const wavFiles = files.filter(f => f.endsWith('.wav'));
      if (wavFiles.length === 0) return;
      showToast(`Transcribing ${wavFiles.length} widget recording${wavFiles.length > 1 ? 's' : ''}...`);
      for (const wavFile of wavFiles) {
        const wavPath = WIDGET_DIR + wavFile;
        try {
          const rawPath = wavPath.replace('file://', '');
          const result = await WhisperManager.transcribe(rawPath);
          if (result.text) { await addNote(result.text, wavPath); showToast('Widget note added'); }
        } catch {}
        try { await FileSystem.deleteAsync(wavPath, { idempotent: true }); } catch {}
      }
    } catch {}
  };

  // -------------------------------------------------------------------------
  // Sound effects
  // -------------------------------------------------------------------------
  const pickSound = async (which) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['audio/*'], copyToCacheDirectory: true });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      await FileSystem.makeDirectoryAsync(SOUNDS_DIR, { intermediates: true });
      const destPath = SOUNDS_DIR + `${which}_${asset.name}`;
      await FileSystem.copyAsync({ from: asset.uri, to: destPath });
      if (which === 'start') { setStartSoundPath(destPath); setStartSoundName(asset.name); await AsyncStorage.setItem('sound_record_start', destPath); await AsyncStorage.setItem('sound_record_start_name', asset.name); }
      else { setStopSoundPath(destPath); setStopSoundName(asset.name); await AsyncStorage.setItem('sound_record_stop', destPath); await AsyncStorage.setItem('sound_record_stop_name', asset.name); }
      showToast(`Sound set: ${asset.name}`);
    } catch { showToast('Failed to pick sound', true); }
  };

  const clearSound = async (which) => {
    if (which === 'start') {
      if (startSoundPath) try { await FileSystem.deleteAsync(startSoundPath, { idempotent: true }); } catch {}
      setStartSoundPath(null); setStartSoundName(null);
      await AsyncStorage.removeItem('sound_record_start'); await AsyncStorage.removeItem('sound_record_start_name');
    } else {
      if (stopSoundPath) try { await FileSystem.deleteAsync(stopSoundPath, { idempotent: true }); } catch {}
      setStopSoundPath(null); setStopSoundName(null);
      await AsyncStorage.removeItem('sound_record_stop'); await AsyncStorage.removeItem('sound_record_stop_name');
    }
    showToast('Sound removed');
  };

  // -------------------------------------------------------------------------
  // Save to folder (SAF)
  // -------------------------------------------------------------------------
  const pickSaveFolder = async () => {
    try {
      const perms = await StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!perms.granted) return;
      const name = decodeURIComponent(perms.directoryUri.split('%3A').pop() || 'folder');
      setSaveFolderUri(perms.directoryUri); setSaveFolderName(name);
      await AsyncStorage.setItem('save_folder_uri', perms.directoryUri);
      await AsyncStorage.setItem('save_folder_name', name);
      showToast(`Folder set: ${name}`);
      if (!autoSave) { setAutoSave(true); await AsyncStorage.setItem('auto_save', 'true'); }
    } catch { showToast('Failed to pick folder', true); }
  };

  const clearSaveFolder = async () => {
    setSaveFolderUri(null); setSaveFolderName(null); setAutoSave(false);
    await AsyncStorage.removeItem('save_folder_uri'); await AsyncStorage.removeItem('save_folder_name');
    await AsyncStorage.setItem('auto_save', 'false');
  };

  const toggleAutoSave = async () => {
    const next = !autoSave; setAutoSave(next);
    await AsyncStorage.setItem('auto_save', next ? 'true' : 'false');
    if (next && !saveFolderUri) pickSaveFolder();
  };

  const saveNoteToFolder = async (item) => {
    if (!saveFolderUri) { pickSaveFolder(); return; }
    try {
      const dt = new Date(item.createdAt);
      const filename = `voice-note-${dt.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`;
      const content = `---\ndate: ${dt.toISOString().slice(0, 16).replace('T', ' ')}\ntype: voice-note\ntags:\n  - voice-note\n  - whisper\n---\n\n${item.text}\n`;
      const fileUri = await StorageAccessFramework.createFileAsync(saveFolderUri, filename, 'text/markdown');
      await FileSystem.writeAsStringAsync(fileUri, content);
      showToast(`Saved to ${saveFolderName || 'folder'}`);
    } catch { showToast('Save failed', true); }
  };

  // -------------------------------------------------------------------------
  // Audio playback
  // -------------------------------------------------------------------------
  const stopPlayback = async () => {
    if (playbackRef.current) { try { await playbackRef.current.stopAsync(); await playbackRef.current.unloadAsync(); } catch {} playbackRef.current = null; }
    setPlayingId(null); setPlaybackProgress(0); setAudioDuration(0);
  };

  const togglePlayback = async (noteId, audioPath) => {
    if (playingId === noteId) {
      if (playbackRef.current) {
        const st = await playbackRef.current.getStatusAsync();
        if (st.isPlaying) await playbackRef.current.pauseAsync(); else await playbackRef.current.playAsync();
      }
      return;
    }
    await stopPlayback();
    if (!audioPath) return;
    try {
      const info = await FileSystem.getInfoAsync(audioPath);
      if (!info.exists) { showToast('Audio file missing', true); return; }
      const { sound } = await Audio.Sound.createAsync({ uri: audioPath });
      playbackRef.current = sound; setPlayingId(noteId);
      sound.setOnPlaybackStatusUpdate((st) => {
        if (st.isLoaded) {
          setPlaybackProgress(st.positionMillis / (st.durationMillis || 1));
          setAudioDuration(Math.round((st.durationMillis || 0) / 1000));
          if (st.didJustFinish) stopPlayback();
        }
      });
      await sound.playAsync();
    } catch { showToast('Playback failed', true); }
  };

  const calcAudioStorage = async () => {
    try {
      const dir = await FileSystem.getInfoAsync(AUDIO_DIR);
      if (!dir.exists) { setAudioStorageSize(0); return; }
      const files = await FileSystem.readDirectoryAsync(AUDIO_DIR);
      let total = 0;
      for (const f of files) { const fi = await FileSystem.getInfoAsync(AUDIO_DIR + f); if (fi.exists && fi.size) total += fi.size; }
      setAudioStorageSize(total);
    } catch { setAudioStorageSize(0); }
  };

  const clearAllAudio = async () => {
    await stopPlayback();
    try { await FileSystem.deleteAsync(AUDIO_DIR, { idempotent: true }); } catch {}
    const updated = notes.map(n => ({ ...n, audioPath: null }));
    await persistNotes(updated); setAudioStorageSize(0); showToast('All audio cleared');
  };

  // -------------------------------------------------------------------------
  // Delete note
  // -------------------------------------------------------------------------
  const deleteNote = async (id) => {
    const item = notes.find(n => n.id === id);
    if (playingId === id) await stopPlayback();
    await persistNotes(notes.filter(n => n.id !== id));
    if (expandedId === id) setExpandedId(null);
    if (item?.audioPath) { try { await FileSystem.deleteAsync(item.audioPath, { idempotent: true }); } catch {} }
    try {
      const raw = await AsyncStorage.getItem(DELETED_KEY);
      const deleted = raw ? JSON.parse(raw) : [];
      deleted.push(id); if (item?.serverFilename) deleted.push(item.serverFilename);
      await AsyncStorage.setItem(DELETED_KEY, JSON.stringify(deleted.slice(-500)));
    } catch {}
    if (serverUrl && !offlineMode && item) {
      const filename = item.serverFilename || `voice-note-${item.id}.md`;
      try {
        const resp = await fetch(serverUrl + '/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename }) });
        if (!resp.ok) throw new Error();
      } catch {
        try { const raw = await AsyncStorage.getItem(PENDING_DELETES_KEY); const p = raw ? JSON.parse(raw) : []; p.push(filename); await AsyncStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(p)); } catch {}
      }
    }
    showToast('Deleted');
  };

  // -------------------------------------------------------------------------
  // Model download
  // -------------------------------------------------------------------------
  const downloadAndActivateModel = async (name) => {
    const info = MODELS[name];
    if (!info) return;
    const alreadyDownloaded = downloadedModels[name];
    if (alreadyDownloaded) {
      // Just switch to it
      try {
        await WhisperManager.initialize(name);
        setModelReady(true);
        showToast(`Switched to ${info.label}`);
      } catch { showToast('Failed to load model', true); }
      return;
    }
    // Download then activate
    setDownloadingModel(name); setDownloadProgress(0);
    try {
      await WhisperManager.downloadModel((w, t) => { if (t > 0) setDownloadProgress(w / t); }, name);
      await WhisperManager.initialize(name);
      setModelReady(true);
      setDownloadedModels(prev => ({ ...prev, [name]: true }));
      showToast(`${info.label} ready`);
    } catch { showToast('Download failed. Check your internet and try again', true); }
    setDownloadingModel(null); setDownloadProgress(0);
  };

  const deleteModel = async (name) => {
    if (WhisperManager.getCurrentModel() === name) {
      showToast('Cannot delete active model', true);
      return;
    }
    await WhisperManager.deleteModel(name);
    setDownloadedModels(prev => ({ ...prev, [name]: false }));
    showToast(`${MODELS[name].label} deleted`);
  };

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------
  const startRecording = async () => {
    if (!modelReady) { showToast('Model loading...', true); return; }
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) { showToast('BunNotes needs microphone access to record', true); return; }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const audioDir = FileSystem.documentDirectory + 'recordings/';
      await FileSystem.makeDirectoryAsync(audioDir, { intermediates: true });
      const audioPath = audioDir.replace('file://', '') + `voice-note-${timestamp}.wav`;
      await WhisperManager.startRealtimeTranscribe(audioPath, transLanguage);
      recordingRef.current = true; setRecording(true); setSeconds(0);
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      playSound(startSoundPath || defaultStartSound);
    } catch { showToast('Something went wrong. Please try again', true); }
  };

  const stopRecording = async () => {
    if (!recordingRef.current) return;
    setRecording(false); recordingRef.current = null;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playSound(stopSoundPath || defaultStopSound);
    setTranscribing(true);
    try {
      const result = await WhisperManager.stopRealtimeTranscribe();
      if (result.text) {
        const isFirstNote = notes.length === 0;
        const detectedLang = transLanguage;
        const note = await addNote(result.text, result.audioPath);
        if (note) note.language = detectedLang;
        if (autoSave && saveFolderUri && note) { try { await saveNoteToFolder(note); } catch {} }
        if (isFirstNote) { setShowCelebration(true); setTimeout(() => setShowCelebration(false), 2500); }
        showToast('Note saved');
        const syncLang = detectedLang || 'en';
        if (serverUrl && result.audioPath && !offlineMode) {
          try { SyncManager.setServerUrl(serverUrl); await SyncManager.queueForSync('file://' + result.audioPath, result.text, syncLang); setSyncStatus(await SyncManager.getStatus()); } catch {}
        }
      } else { showToast('No speech detected'); }
    } catch { showToast("Couldn't understand the audio. Try speaking more clearly", true); }
    setTranscribing(false);
  };

  const cancelRecording = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (recordingRef.current) {
      setRecording(false); recordingRef.current = null;
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      if (WhisperManager._realtimeStop) { try { await WhisperManager._realtimeStop(); } catch {} WhisperManager._realtimeStop = null; }
      WhisperManager._realtimePromise = null;
      if (WhisperManager._realtimeAudioPath) { try { await FileSystem.deleteAsync('file://' + WhisperManager._realtimeAudioPath, { idempotent: true }); } catch {} }
    }
    setTranscribing(false); showToast('Cancelled');
  };

  // -------------------------------------------------------------------------
  // Server connect/disconnect
  // -------------------------------------------------------------------------
  const connectServer = async () => {
    const url = serverInputRef.current.trim();
    if (!url) { showToast('Enter a server URL', true); return; }
    setServerUrl(url); await AsyncStorage.setItem('server_url', url); Keyboard.dismiss();
    setOfflineMode(false); await AsyncStorage.setItem('offline_mode', 'false');
    SyncManager.setServerUrl(url);
    const online = await SyncManager.checkConnection(); setServerOnline(online);
    if (online) { SyncManager.processQueue(); try { setSyncStatus(await SyncManager.getStatus()); } catch {} syncFromServer(); showToast('Connected'); }
    else { showToast('Server unreachable', true); }
  };

  const disconnectServer = async () => {
    setOfflineMode(true); await AsyncStorage.setItem('offline_mode', 'true');
    setServerOnline(false); showToast('Disconnected');
  };

  // -------------------------------------------------------------------------
  // Save to Obsidian
  // -------------------------------------------------------------------------
  const saveToObsidian = async () => {
    // Not used directly in new UI but kept for server sync
  };

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  const renderSettings = () => {
    if (!settingsVisible) return null;
    const currentModel = WhisperManager.getCurrentModel();
    return (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.bg, zIndex: 999 }}>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 24, paddingTop: Platform.OS === 'android' ? 40 : 24, paddingBottom: 60 }}
            showsVerticalScrollIndicator={true}
            bounces={true}
            removeClippedSubviews={true}
          >
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>Settings</Text>
              <TouchableOpacity onPress={() => setSettingsVisible(false)} style={s.doneBtn}><Text style={s.doneBtnTxt}>Done</Text></TouchableOpacity>
            </View>

            <Text style={s.sLabel}>Voice Model</Text>
            <Text style={s.sDesc}>Choose which AI model converts your speech to text. Larger models are more accurate but use more storage.</Text>
            {MODEL_NAMES.map(name => {
              const m = MODELS[name];
              const isActive = currentModel === name;
              const isDownloaded = downloadedModels[name];
              const isDownloading = downloadingModel === name;
              return (
                <View key={name} style={{ backgroundColor: C.surface, borderWidth: isActive ? 2 : 1, borderColor: isActive ? C.accent : C.border, borderRadius: 12, padding: 12, marginBottom: 8 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View>
                      <Text style={{ fontFamily: MONO, fontSize: 15, fontWeight: '600', color: isActive ? C.accent : C.bright }}>{m.label}</Text>
                      <Text style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>{m.size} &middot; {m.quality}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                      {isActive && <Text style={{ fontFamily: MONO, fontSize: 11, color: C.accent }}>&#10003; Active</Text>}
                      {isDownloaded && !isActive && (
                        <TouchableOpacity onPress={() => deleteModel(name)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Text style={{ fontSize: 14, color: C.muted }}>&#128465;</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                  {isDownloading && downloadProgress > 0 && (
                    <View style={{ marginTop: 8 }}>
                      <View style={{ height: 4, backgroundColor: C.border, borderRadius: 2, overflow: 'hidden' }}>
                        <View style={{ height: '100%', backgroundColor: C.accent, width: `${Math.round(downloadProgress * 100)}%` }} />
                      </View>
                      <Text style={{ fontFamily: MONO, fontSize: 10, color: C.muted, textAlign: 'center', marginTop: 2 }}>{Math.round(downloadProgress * 100)}%</Text>
                    </View>
                  )}
                  {!isActive && (
                    <TouchableOpacity style={[s.tealBtn, { paddingVertical: 8, marginTop: 8, marginBottom: 0 }, isDownloading && { opacity: 0.5 }]}
                      onPress={() => downloadAndActivateModel(name)} disabled={!!downloadingModel}>
                      <Text style={[s.tealBtnTxt, { fontSize: 12 }]}>
                        {isDownloading ? 'Downloading...' : isDownloaded ? 'Switch to this' : `Download (${m.size})`}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}

            <View style={s.divider} />
            <Text style={s.sLabel}>Language</Text>
            <Text style={s.sDesc}>Choose the language for voice transcription, or let BunNotes detect it automatically.</Text>
            {[{ key: 'en', label: 'English' }, { key: 'ro', label: 'Romanian' }].map(opt => (
              <TouchableOpacity key={opt.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 }}
                onPress={async () => { setTransLanguage(opt.key); await AsyncStorage.setItem('transcription_language', opt.key); }}>
                <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: transLanguage === opt.key ? C.accent : C.muted, justifyContent: 'center', alignItems: 'center' }}>
                  {transLanguage === opt.key && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: C.accent }} />}
                </View>
                <Text style={{ fontFamily: MONO, fontSize: 14, color: transLanguage === opt.key ? C.accent : C.text }}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
            {transLanguage === 'ro' && currentModel !== 'small' && (
              <View style={{ backgroundColor: C.surface, borderWidth: 1, borderColor: C.accent, borderRadius: 10, padding: 12, marginTop: 8 }}>
                <Text style={{ fontFamily: MONO, fontSize: 12, color: C.text, marginBottom: 8 }}>For best Romanian results, use the Small model (466 MB)</Text>
                <TouchableOpacity style={[s.tealBtn, { paddingVertical: 10, marginBottom: 0 }]} onPress={() => downloadAndActivateModel('small')}>
                  <Text style={[s.tealBtnTxt, { fontSize: 12 }]}>Upgrade to Small</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={s.divider} />
            <Text style={s.sLabel}>Save Folder</Text>
            <Text style={s.sDesc}>Save notes as markdown files to a folder on your device.</Text>
            <View style={s.sRow}><Text style={s.sKey}>Folder</Text><Text style={[s.sVal, { maxWidth: 160 }]} numberOfLines={1}>{saveFolderName || 'Not set'}</Text></View>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
              <TouchableOpacity style={[s.tealBtn, { flex: 1, paddingVertical: 10 }]} onPress={pickSaveFolder}>
                <Text style={[s.tealBtnTxt, { fontSize: 12 }]}>{saveFolderUri ? 'Change' : 'Pick Folder'}</Text></TouchableOpacity>
              {saveFolderUri && <TouchableOpacity style={[s.tealBtn, { paddingVertical: 10, paddingHorizontal: 16, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border }]} onPress={clearSaveFolder}>
                <Text style={[s.tealBtnTxt, { fontSize: 12, color: C.muted }]}>Clear</Text></TouchableOpacity>}
            </View>
            <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 }} onPress={toggleAutoSave}>
              <View style={{ width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: autoSave ? C.accent : C.muted, backgroundColor: autoSave ? C.accent : 'transparent', justifyContent: 'center', alignItems: 'center' }}>
                {autoSave && <Text style={{ color: '#000', fontSize: 12, fontWeight: '700' }}>&#10003;</Text>}
              </View>
              <Text style={s.sKey}>Auto-save new notes</Text>
            </TouchableOpacity>

            <View style={s.divider} />
            <Text style={s.sLabel}>Sounds</Text>
            <Text style={s.sDesc}>Customize the sounds played when you start and stop recording.</Text>
            <View style={s.sRow}><Text style={s.sKey}>Record Start</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={[s.sVal, { maxWidth: 120 }]} numberOfLines={1}>{startSoundName || 'Default'}</Text>
                {startSoundPath && <>
                  <TouchableOpacity onPress={() => playSound(startSoundPath)}><Text style={{ fontSize: 16, color: C.accent }}>&#9654;</Text></TouchableOpacity>
                  <TouchableOpacity onPress={() => clearSound('start')}><Text style={{ fontSize: 14, color: C.muted }}>&#10005;</Text></TouchableOpacity>
                </>}
              </View>
            </View>
            <TouchableOpacity style={[s.tealBtn, { paddingVertical: 10, marginBottom: 12 }]} onPress={() => pickSound('start')}><Text style={[s.tealBtnTxt, { fontSize: 12 }]}>Pick Start Sound</Text></TouchableOpacity>
            <View style={s.sRow}><Text style={s.sKey}>Record Stop</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={[s.sVal, { maxWidth: 120 }]} numberOfLines={1}>{stopSoundName || 'Default'}</Text>
                {stopSoundPath && <>
                  <TouchableOpacity onPress={() => playSound(stopSoundPath)}><Text style={{ fontSize: 16, color: C.accent }}>&#9654;</Text></TouchableOpacity>
                  <TouchableOpacity onPress={() => clearSound('stop')}><Text style={{ fontSize: 14, color: C.muted }}>&#10005;</Text></TouchableOpacity>
                </>}
              </View>
            </View>
            <TouchableOpacity style={[s.tealBtn, { paddingVertical: 10, marginBottom: 4 }]} onPress={() => pickSound('stop')}><Text style={[s.tealBtnTxt, { fontSize: 12 }]}>Pick Stop Sound</Text></TouchableOpacity>

            <View style={s.divider} />
            <Text style={s.sLabel}>Audio Storage</Text>
            <Text style={s.sDesc}>Recorded audio is stored on your device. Clear to free up space.</Text>
            <View style={s.sRow}><Text style={s.sKey}>Used</Text>
              <Text style={s.sVal}>{audioStorageSize > 1048576 ? `${Math.round(audioStorageSize / 1048576)} MB` : audioStorageSize > 1024 ? `${Math.round(audioStorageSize / 1024)} KB` : '0 KB'}</Text></View>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4 }}>
              <TouchableOpacity style={[s.tealBtn, { flex: 1, paddingVertical: 10 }]} onPress={calcAudioStorage}><Text style={[s.tealBtnTxt, { fontSize: 12 }]}>Refresh</Text></TouchableOpacity>
              <TouchableOpacity style={[s.tealBtn, { paddingVertical: 10, paddingHorizontal: 16, backgroundColor: C.error }]} onPress={clearAllAudio}><Text style={[s.tealBtnTxt, { fontSize: 12, color: C.white }]}>Clear All</Text></TouchableOpacity>
            </View>

            <View style={s.divider} />
            <Text style={s.sLabel}>About</Text>
            <Text style={{ fontFamily: MONO, fontSize: 14, color: C.bright, marginBottom: 4 }}>BunNotes v1.1.3</Text>
            <Text style={{ fontFamily: MONO, fontSize: 12, color: C.muted, lineHeight: 20, marginBottom: 8 }}>On-device voice transcription{'\n'}powered by whisper.cpp</Text>
            <Text style={{ fontFamily: MONO, fontSize: 11, color: C.muted, lineHeight: 18, marginBottom: 8 }}>BunNotes can also be used as a live captioning tool for deaf and hard-of-hearing users.</Text>
            <TouchableOpacity onPress={() => Linking.openURL('https://endreendi.com')} style={{ marginBottom: 6 }}>
              <Text style={{ fontFamily: MONO, fontSize: 13, color: C.accent }}>Made by EndreEndi</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ marginBottom: 6 }}>
              <Text style={{ fontFamily: MONO, fontSize: 13, color: C.muted }}>Rate on Google Play</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ marginBottom: 4 }}>
              <Text style={{ fontFamily: MONO, fontSize: 13, color: C.muted }}>Privacy Policy</Text>
            </TouchableOpacity>

            <View style={s.divider} />
            <TouchableOpacity style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: serverExpanded ? 12 : 0 }} onPress={() => setServerExpanded(!serverExpanded)}>
              <Text style={[s.sLabel, { marginBottom: 0 }]}>Advanced: Self-hosted Server</Text>
              <Text style={{ color: C.muted, fontSize: 14 }}>{serverExpanded ? '\u25B2' : '\u25BC'}</Text>
            </TouchableOpacity>
            {serverExpanded && (
              <View>
                <Text style={s.sDesc}>Optional — for power users with a self-hosted BunNotes server.</Text>
                <TextInput style={s.input} placeholder="http://your-server:8642" placeholderTextColor={C.muted}
                  defaultValue={serverUrl} onChangeText={t => serverInputRef.current = t}
                  autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="done" />
                {!offlineMode && serverOnline ? (
                  <TouchableOpacity style={[s.tealBtn, { backgroundColor: C.error }]} onPress={disconnectServer}><Text style={[s.tealBtnTxt, { color: C.white }]}>Disconnect</Text></TouchableOpacity>
                ) : (
                  <TouchableOpacity style={s.tealBtn} onPress={connectServer}><Text style={s.tealBtnTxt}>Connect</Text></TouchableOpacity>
                )}
                <View style={s.sRow}><Text style={s.sKey}>Status</Text>
                  <Text style={[s.sVal, { color: offlineMode ? C.muted : serverOnline ? C.accent : C.error }]}>{offlineMode ? 'Disconnected' : serverOnline ? 'Online' : 'Offline'}</Text></View>
                {!offlineMode && <View style={s.sRow}><Text style={s.sKey}>Pending sync</Text><Text style={s.sVal}>{syncStatus.pending || 0}</Text></View>}
                <View style={{ marginTop: 12 }}>
                  <Text style={{ fontFamily: MONO, fontSize: 12, color: C.muted, lineHeight: 18, marginBottom: 6 }}>Set up your own BunNotes server for better transcription accuracy with GPU acceleration.</Text>
                  <TouchableOpacity onPress={() => Linking.openURL('https://github.com/EndreEndi/BunNotes')}>
                    <Text style={{ fontFamily: MONO, fontSize: 13, color: C.accent }}>Server setup guide on GitHub {'\u2192'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
            <View style={{ height: 60 }} />
          </ScrollView>
        </View>
    );
  };

  // -------------------------------------------------------------------------
  // Main screen
  // -------------------------------------------------------------------------
  if (onboardingDone === null) return <SafeAreaView style={s.container}><StatusBar style="light" /></SafeAreaView>;
  if (!onboardingDone) return <OnboardingScreen onComplete={handleOnboardingComplete} />;

  return (
    <SafeAreaView style={s.container}>
      <StatusBar style="light" />
      {renderSettings()}

      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Image source={bunnyLogo} style={s.headerLogo} />
          <Text style={s.headerTitle}><Text style={{ color: C.accent }}>Bun</Text>Notes</Text>
        </View>
        <View style={s.headerRight}>
          <View style={{ flexDirection: 'row', backgroundColor: C.surface, borderRadius: 8, overflow: 'hidden', marginRight: 4 }}>
            <TouchableOpacity onPress={async () => { setTransLanguage('en'); await AsyncStorage.setItem('transcription_language', 'en'); }}
              style={{ paddingHorizontal: 10, paddingVertical: 5, backgroundColor: transLanguage === 'en' ? C.accent : 'transparent' }}>
              <Text style={{ fontFamily: MONO, fontSize: 11, fontWeight: '700', color: transLanguage === 'en' ? '#000' : C.muted }}>EN</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={async () => { setTransLanguage('ro'); await AsyncStorage.setItem('transcription_language', 'ro'); }}
              style={{ paddingHorizontal: 10, paddingVertical: 5, backgroundColor: transLanguage === 'ro' ? C.accent : 'transparent' }}>
              <Text style={{ fontFamily: MONO, fontSize: 11, fontWeight: '700', color: transLanguage === 'ro' ? '#000' : C.muted }}>RO</Text>
            </TouchableOpacity>
          </View>
          {!offlineMode && <View style={[s.dot, serverOnline ? s.dotOn : s.dotOff]} />}
          {!offlineMode && syncStatus.pending > 0 && <View style={s.badge}><Text style={s.badgeTxt}>{syncStatus.pending}</Text></View>}
          <TouchableOpacity onPress={() => { setSettingsVisible(true); calcAudioStorage(); }} style={{ padding: 6 }}>
            <Text style={{ fontSize: 20, color: C.muted }}>&#9881;</Text>
            {!modelReady && <View style={{ position: 'absolute', top: 4, right: 4, width: 8, height: 8, borderRadius: 4, backgroundColor: C.accent }} />}
          </TouchableOpacity>
        </View>
      </View>

      {/* Notes list */}
      {notes.length === 0 ? (
        <View style={s.emptyState}>
          <Image source={bunnyLogo} style={{ width: 80, height: 80, borderRadius: 20, marginBottom: 20, opacity: 0.6 }} />
          <Text style={[s.emptyTxt, { fontSize: 18, color: C.text, marginBottom: 8 }]}>No notes yet</Text>
          <Text style={s.emptyTxt}>Tap the button below to record your first note</Text>
        </View>
      ) : (
        <FlatList data={notes} keyExtractor={item => item.id} contentContainerStyle={{ paddingBottom: 100 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await syncFromServer(); setRefreshing(false); }} tintColor={C.accent} colors={[C.accent]} progressBackgroundColor={C.surface} />}
          renderItem={({ item }) => {
            const expanded = expandedId === item.id;
            return (
              <TouchableOpacity style={s.noteItem} onPress={() => setExpandedId(expanded ? null : item.id)} activeOpacity={0.7}>
                <View style={s.noteTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.noteTitle} numberOfLines={1}>{item.title || 'New Recording'}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                      <Text style={s.noteDate}>{fmtDate(item.createdAt)}</Text>
                      {item.language && <Text style={{ fontFamily: MONO, fontSize: 9, color: C.accent, backgroundColor: C.surface, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, overflow: 'hidden' }}>{item.language.toUpperCase()}</Text>}
                    </View>
                  </View>
                  {expanded && (
                    <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
                      {item.audioPath && <TouchableOpacity onPress={() => togglePlayback(item.id, item.audioPath)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                        <Text style={{ fontSize: 18, color: C.accent }}>{playingId === item.id ? '\u275A\u275A' : '\u25B6'}</Text></TouchableOpacity>}
                      <TouchableOpacity onPress={() => saveNoteToFolder(item)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                        <Text style={{ fontSize: 18, color: C.accent }}>&#128190;</Text></TouchableOpacity>
                      <TouchableOpacity onPress={() => deleteNote(item.id)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                        <Text style={{ fontSize: 18, color: C.muted }}>&#128465;</Text></TouchableOpacity>
                    </View>
                  )}
                </View>
                {expanded && (
                  <View>
                    {playingId === item.id && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, marginBottom: 4 }}>
                        <View style={{ flex: 1, height: 3, backgroundColor: C.border, borderRadius: 2, overflow: 'hidden' }}>
                          <View style={{ width: `${Math.round(playbackProgress * 100)}%`, height: '100%', backgroundColor: C.accent, borderRadius: 2 }} />
                        </View>
                        <Text style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>{fmtDuration(audioDuration)}</Text>
                      </View>
                    )}
                    {item.audioPath && playingId !== item.id && <Text style={{ fontFamily: MONO, fontSize: 10, color: C.muted, marginTop: 6 }}>{'\u25B6'} Audio available</Text>}
                    <Text style={s.noteBody}>{item.text}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
          ItemSeparatorComponent={() => <View style={s.separator} />}
        />
      )}

      {/* Bottom controls */}
      <View style={s.bottomBar}>
        {recording ? (
          <>
            <TouchableOpacity onPress={cancelRecording} style={s.bottomSideBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={{ fontSize: 18, color: C.muted }}>&#10005;</Text></TouchableOpacity>
            <TouchableOpacity style={[s.recBtn, { backgroundColor: C.error, shadowColor: C.error }]} onPress={stopRecording} activeOpacity={0.7}>
              <View style={s.stopSquare} /></TouchableOpacity>
            <Text style={s.recTimer}>{fmtTimer(seconds)}</Text>
          </>
        ) : transcribing ? (
          <>
            <View style={s.bottomSideBtn} />
            <View style={[s.recBtn, { opacity: 0.5 }]}><ActivityIndicator color="#000" size="small" /></View>
            <View style={s.bottomSideBtn} />
          </>
        ) : (
          <>
            <View style={s.bottomSideBtn} />
            <TouchableOpacity style={s.recBtn} onPress={startRecording} activeOpacity={0.7}><View style={s.recDot} /></TouchableOpacity>
            <View style={s.bottomSideBtn} />
          </>
        )}
      </View>

      {/* Toast */}
      {toast && <View style={[s.toast, toast.isError && s.toastErr]}><Text style={[s.toastTxt, toast.isError && { color: C.error }]}>{toast.msg}</Text></View>}

      {showCelebration && (
        <View style={s.celebration}>
          <Text style={{ fontSize: 48, marginBottom: 12 }}>{'\u2728'}</Text>
          <Text style={{ fontFamily: MONO, fontSize: 20, fontWeight: '700', color: C.accent }}>Your first note!</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  input: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, fontFamily: MONO, fontSize: 14, color: C.text, marginBottom: 16 },
  tealBtn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginBottom: 8 },
  tealBtnTxt: { fontFamily: MONO, fontSize: 14, fontWeight: '600', color: '#000' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 },
  headerLeft: { flexDirection: 'row', alignItems: 'center' },
  headerLogo: { width: 30, height: 30, borderRadius: 7, marginRight: 12 },
  headerTitle: { fontSize: 28, fontWeight: '700', color: C.white },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOn: { backgroundColor: C.accent },
  dotOff: { backgroundColor: C.muted },
  badge: { backgroundColor: C.accentDk, borderRadius: 8, minWidth: 18, height: 18, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 5 },
  badgeTxt: { fontFamily: MONO, fontSize: 10, fontWeight: '700', color: C.white },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyTxt: { fontSize: 16, color: C.muted },
  noteItem: { paddingHorizontal: 20, paddingVertical: 14 },
  noteTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  noteTitle: { fontSize: 16, fontWeight: '600', color: C.bright },
  noteDate: { fontSize: 13, color: C.muted },
  noteBody: { fontSize: 14, lineHeight: 22, color: C.text, marginTop: 10 },
  separator: { height: 1, backgroundColor: C.border, marginHorizontal: 20 },
  bottomBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingBottom: 24, paddingTop: 12, gap: 20 },
  bottomSideBtn: { width: 40, alignItems: 'center', justifyContent: 'center' },
  recBtn: { width: 68, height: 68, borderRadius: 34, backgroundColor: C.accent, justifyContent: 'center', alignItems: 'center', shadowColor: C.accent, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 10 },
  recDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#000', opacity: 0.2 },
  stopSquare: { width: 22, height: 22, borderRadius: 4, backgroundColor: '#fff' },
  recTimer: { fontFamily: MONO, fontSize: 14, fontWeight: '600', color: C.error, minWidth: 50, textAlign: 'center' },
  toast: { position: 'absolute', bottom: 110, alignSelf: 'center', backgroundColor: C.surface, borderWidth: 1, borderColor: C.accent, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  toastErr: { borderColor: C.error },
  toastTxt: { fontFamily: MONO, fontSize: 13, color: C.accent },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
  modalTitle: { fontFamily: MONO, fontSize: 22, fontWeight: '700', color: C.bright },
  doneBtn: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8 },
  doneBtnTxt: { fontFamily: MONO, fontSize: 13, fontWeight: '600', color: C.accent },
  sLabel: { fontFamily: MONO, fontSize: 11, fontWeight: '600', color: C.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },
  divider: { height: 1, backgroundColor: C.border, marginVertical: 20 },
  sRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  sKey: { fontFamily: MONO, fontSize: 13, color: C.muted },
  sVal: { fontFamily: MONO, fontSize: 13, color: C.text },
  sDesc: { fontFamily: MONO, fontSize: 12, color: C.muted, lineHeight: 18, marginBottom: 12 },
  celebration: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.7)' },
});
