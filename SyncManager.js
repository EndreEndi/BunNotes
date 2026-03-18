/**
 * SyncManager — handles uploading audio to eendi-ai for re-transcription
 * with a bigger model, and saving to Obsidian vault.
 */
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';

const QUEUE_KEY = 'whisper_notes_sync_queue';
const AUDIO_DIR = `${FileSystem.documentDirectory}recordings/`;

class SyncManager {
  constructor() {
    this.serverUrl = '';
    this.syncing = false;
  }

  setServerUrl(url) {
    this.serverUrl = url.replace(/\/+$/, '');
  }

  /**
   * Save audio file locally and queue for server sync.
   */
  async queueForSync(audioUri, localTranscript, language) {
    await FileSystem.makeDirectoryAsync(AUDIO_DIR, { intermediates: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `voice-note-${timestamp}.wav`;
    const localPath = AUDIO_DIR + filename;

    // Copy audio to our managed directory
    await FileSystem.copyAsync({ from: audioUri, to: localPath });

    // Add to sync queue
    const queue = await this.getQueue();
    queue.push({
      id: timestamp,
      audioPath: localPath,
      localTranscript,
      language,
      status: 'pending',    // pending | syncing | done | failed
      createdAt: new Date().toISOString(),
      serverTranscript: null,
      retries: 0,
    });
    await this.saveQueue(queue);

    // Try to sync immediately
    this.processQueue();

    return { id: timestamp, filename };
  }

  /**
   * Process the sync queue — upload pending items to server.
   */
  async processQueue() {
    if (this.syncing || !this.serverUrl) return;
    this.syncing = true;

    try {
      const queue = await this.getQueue();
      const pending = queue.filter(
        item => item.status === 'pending' || (item.status === 'failed' && item.retries < 3)
      );

      for (const item of pending) {
        try {
          item.status = 'syncing';
          await this.saveQueue(queue);

          // Upload audio to server for re-transcription
          const result = await this.uploadToServer(item);

          if (result.text) {
            item.serverTranscript = result.text;
            item.serverLanguage = result.language;
            item.status = 'done';

            // Save the improved transcript to Obsidian via server
            await this.saveToObsidian(
              result.text,
              item.language,
              item.createdAt
            );
          } else {
            item.status = 'failed';
            item.retries += 1;
          }
        } catch (err) {
          item.status = 'failed';
          item.retries += 1;
        }
        await this.saveQueue(queue);
      }

      // Clean up completed items older than 24h
      await this.cleanup();
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Upload audio file to eendi-ai for re-transcription.
   */
  async uploadToServer(item) {
    const resp = await FileSystem.uploadAsync(
      `${this.serverUrl}/api/transcribe`,
      item.audioPath,
      {
        fieldName: 'audio',
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        headers: {
          'X-Local-Transcript': encodeURIComponent(item.localTranscript || ''),
          'X-Detected-Language': item.language || 'auto',
        },
      }
    );

    if (resp.status !== 200) {
      throw new Error(`Server returned ${resp.status}`);
    }

    return JSON.parse(resp.body);
  }

  /**
   * Tell the server to save transcript to Obsidian vault.
   */
  async saveToObsidian(text, language, createdAt) {
    const resp = await fetch(`${this.serverUrl}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        language,
        created_at: createdAt,
      }),
    });
    return resp.json();
  }

  /**
   * Quick save — just save local transcript to Obsidian (no re-transcription).
   */
  async quickSave(text, language) {
    if (!this.serverUrl) {
      throw new Error('Server URL not configured');
    }
    const resp = await fetch(`${this.serverUrl}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language }),
    });
    return resp.json();
  }

  /**
   * Check server connectivity.
   */
  async checkConnection() {
    if (!this.serverUrl) return false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await fetch(`${this.serverUrl}/api/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      return resp.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // --- Queue persistence ---

  async getQueue() {
    try {
      const data = await AsyncStorage.getItem(QUEUE_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  async saveQueue(queue) {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  }

  async cleanup() {
    const queue = await this.getQueue();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const cleaned = queue.filter(item => {
      if (item.status === 'done' && new Date(item.createdAt).getTime() < cutoff) {
        // Delete the local audio file
        FileSystem.deleteAsync(item.audioPath, { idempotent: true }).catch(() => {});
        return false;
      }
      return true;
    });
    await this.saveQueue(cleaned);
  }

  /**
   * Get sync status summary.
   */
  async getStatus() {
    const queue = await this.getQueue();
    return {
      pending: queue.filter(i => i.status === 'pending').length,
      syncing: queue.filter(i => i.status === 'syncing').length,
      done: queue.filter(i => i.status === 'done').length,
      failed: queue.filter(i => i.status === 'failed').length,
      total: queue.length,
    };
  }
}

export default new SyncManager();
