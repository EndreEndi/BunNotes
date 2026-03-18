# BunNotes

**Voice notes that never leave your device.**

BunNotes is an open-source Android voice notes app with on-device AI transcription. Record a voice note, get instant text — no cloud, no subscriptions, no data leaving your phone.

Powered by [whisper.cpp](https://github.com/ggerganov/whisper.cpp) via [whisper.rn](https://github.com/mybigday/whisper.rn).

## Features

- **On-device transcription** — AI runs locally on your phone. Nothing is sent to the cloud.
- **Three model sizes** — Tiny (75 MB), Base (142 MB), Small (466 MB). Pick the right balance of speed and accuracy.
- **Home screen widget** — One-tap recording from your home screen.
- **Auto-save to folder** — Automatically save transcribed notes as markdown files.
- **Audio playback** — Listen back to any recorded note.
- **Dark theme** — Monospace, minimal, easy on the eyes.
- **Optional self-hosted server** — Re-transcribe with a larger model and sync to Obsidian.

## Screenshots

*Coming soon*

## Getting Started

### Install from APK

Download the latest APK from [Releases](https://github.com/EndreEndi/BunNotes/releases) and sideload it on your Android device.

### Build from Source

```bash
# Prerequisites
# - Node.js 18+
# - Android SDK (API 34)
# - NDK 26 + CMake 3.22

# Install dependencies
npm install

# Generate native project
npx expo prebuild --platform android

# Build release APK
cd android && ./gradlew assembleRelease

# APK location:
# android/app/build/outputs/apk/release/app-release.apk
```

### Development (Expo)

```bash
npm install
npx expo start
```

> Note: On-device whisper requires a native build. Expo Go can be used to test UI and server connectivity only.

## Architecture

```
Phone (BunNotes)                    Self-hosted Server (optional)
┌────────────────────┐          ┌──────────────────────┐
│  Record voice note  │          │  faster-whisper       │
│  ↓                  │  audio   │  (larger model)       │
│  whisper.rn         │ ───────→ │  ↓                    │
│  (on-device model)  │  WiFi    │  Re-transcribes       │
│  ↓                  │          │  ↓                    │
│  Instant text       │          │  Saves to Obsidian    │
│  on screen          │          │  vault as .md         │
└────────────────────┘          └──────────────────────┘
```

## Voice Models

| Model | Size | Quality | Best for |
|-------|------|---------|----------|
| Tiny  | 75 MB | Basic | Quick notes, low-end devices |
| Base  | 142 MB | Good | Most users (recommended) |
| Small | 466 MB | Excellent | Best accuracy, flagship devices |

Models are downloaded on first launch and stored locally. You can switch models anytime in Settings.

## Self-hosted Server (Optional)

BunNotes works fully offline. The server is optional — for power users who want:
- Re-transcription with a larger whisper model
- Automatic saving to an Obsidian vault

### Server Setup

```bash
cd server/
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Edit config
nano config.py

# Run
python server.py

# Or install as systemd service
sudo cp bunnotes.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bunnotes

# Verify
curl http://localhost:8642/api/health
```

In the app, go to **Settings → Advanced: Self-hosted Server** and enter your server URL.

## Project Structure

```
BunNotes/
├── App.js                  # Main app UI and logic
├── OnboardingScreen.js     # First-launch onboarding flow
├── WhisperManager.js       # On-device whisper model management
├── SyncManager.js          # Server sync queue
├── plugins/
│   └── withRecordWidget.js # Expo plugin: Android home screen widget
├── server/
│   ├── server.py           # FastAPI backend
│   ├── config.py           # Server configuration
│   ├── requirements.txt    # Python dependencies
│   └── bunnotes.service    # systemd service file
├── assets/
│   ├── icon.png            # App icon
│   ├── store-icon-512.png  # Google Play icon (512x512)
│   └── feature-graphic-1024x500.png  # Google Play feature graphic
└── app.json                # Expo config
```

## Privacy

BunNotes processes everything on your device. No audio or text is sent anywhere unless you explicitly configure a self-hosted server. There are no analytics, no telemetry, no third-party services.

## License

[MIT](LICENSE) — Copyright (c) 2026 EndreEndi

## Links

- **Website:** [endreendi.com](https://endreendi.com)
- **Issues:** [GitHub Issues](https://github.com/EndreEndi/BunNotes/issues)
