/**
 * WhisperManager — on-device whisper.cpp transcription via whisper.rn.
 * Supports multiple models. User picks which to use.
 */
import { initWhisper } from 'whisper.rn';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';

const MODEL_DIR = `${FileSystem.documentDirectory}models/`;

const MODELS = {
  tiny: {
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
    filename: 'ggml-tiny.bin', label: 'Tiny', size: '75 MB', sizeBytes: 78000000, quality: 'Basic',
  },
  base: {
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    filename: 'ggml-base.bin', label: 'Base', size: '142 MB', sizeBytes: 148000000, quality: 'Good',
  },
  small: {
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    filename: 'ggml-small.bin', label: 'Small', size: '466 MB', sizeBytes: 488000000, quality: 'Excellent',
  },
};

const MODEL_NAMES = ['tiny', 'base', 'small'];

class WhisperManager {
  constructor() {
    this.context = null;
    this.modelReady = false;
    this.modelName = null;
  }

  async getActiveModel() {
    try {
      const saved = await AsyncStorage.getItem('whisper_model');
      if (saved && MODELS[saved]) return saved;
    } catch {}
    return null;
  }

  async setActiveModel(name) {
    await AsyncStorage.setItem('whisper_model', name);
  }

  getModelPath(name) { return MODEL_DIR + MODELS[name].filename; }

  async isModelDownloaded(name) {
    try {
      const info = await FileSystem.getInfoAsync(this.getModelPath(name));
      return info.exists;
    } catch { return false; }
  }

  async getDownloadedModels() {
    const result = {};
    for (const name of MODEL_NAMES) {
      result[name] = await this.isModelDownloaded(name);
    }
    return result;
  }

  async getModelFileSize(name) {
    try {
      const info = await FileSystem.getInfoAsync(this.getModelPath(name));
      return info.exists ? info.size || 0 : 0;
    } catch { return 0; }
  }

  async downloadModel(onProgress, name) {
    const m = MODELS[name];
    if (!m) throw new Error(`Unknown model: ${name}`);
    await FileSystem.makeDirectoryAsync(MODEL_DIR, { intermediates: true });
    const dl = FileSystem.createDownloadResumable(
      m.url, this.getModelPath(name), {},
      (p) => onProgress?.(p.totalBytesWritten, p.totalBytesExpectedToWrite)
    );
    const result = await dl.downloadAsync();
    if (!result?.uri) throw new Error('Download failed');
    return result.uri;
  }

  async deleteModel(name) {
    if (this.modelName === name) {
      await this.release();
    }
    try { await FileSystem.deleteAsync(this.getModelPath(name), { idempotent: true }); } catch {}
  }

  async initialize(name) {
    if (!MODELS[name]) throw new Error(`Unknown model: ${name}`);
    const path = this.getModelPath(name);
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) throw new Error('Model not downloaded');
    if (this.context) { try { await this.context.release(); } catch {} }
    this.context = await initWhisper({ filePath: path });
    this.modelReady = true;
    this.modelName = name;
    await this.setActiveModel(name);
  }

  _buildOpts(language) {
    const lang = language || 'en';
    const opts = { maxLen: 0, translate: false, language: lang };
    if (lang === 'ro') {
      opts.prompt = 'Aceasta este o transcriere în limba română cu diacritice corecte: ă, â, î, ș, ț.';
      opts.beamSize = 5;
      opts.wordTimestamps = false;
    } else {
      opts.prompt = 'Clear English transcription with proper punctuation.';
    }
    return opts;
  }

  async transcribe(audioPath, language) {
    if (!this.context || !this.modelReady) throw new Error('Whisper not initialized');
    const opts = this._buildOpts(language);
    const { promise } = this.context.transcribe(audioPath, opts);
    const result = await promise;
    return { text: result.result?.trim() || '', segments: result.segments || [], language: result.language || language };
  }

  async startRealtimeTranscribe(audioOutputPath, language) {
    if (!this.context || !this.modelReady) throw new Error('Whisper not initialized');
    this._realtimeAudioPath = audioOutputPath;
    this._realtimeLanguage = language;
    const opts = { ...this._buildOpts(language), audioOutputPath, realtimeAudioSec: 120, realtimeAudioSliceSec: 60, realtimeAudioMinSec: 1 };
    const { stop, subscribe } = await this.context.transcribeRealtime(opts);
    this._realtimeStop = stop;
    this._realtimePromise = new Promise((resolve) => {
      subscribe((event) => { if (!event.isCapturing) resolve(); });
    });
  }

  async stopRealtimeTranscribe() {
    if (this._realtimeStop) { await this._realtimeStop(); this._realtimeStop = null; }
    if (this._realtimePromise) { await this._realtimePromise; this._realtimePromise = null; }
    const audioPath = this._realtimeAudioPath;
    const language = this._realtimeLanguage;
    try {
      const opts = this._buildOpts(language);
      const { promise } = this.context.transcribe(audioPath, opts);
      const result = await promise;
      return { text: result.result?.trim() || '', segments: result.segments || [], audioPath, language: result.language || language };
    } catch {
      return { text: '', segments: [], audioPath };
    }
  }

  async release() {
    if (this.context) { try { await this.context.release(); } catch {} }
    this.context = null;
    this.modelReady = false;
    this.modelName = null;
  }

  getModelInfo(name) { return MODELS[name]; }
  getAllModels() { return MODELS; }
  getModelNames() { return MODEL_NAMES; }
  getCurrentModel() { return this.modelName; }
}

export default new WhisperManager();
export { MODELS, MODEL_NAMES };
