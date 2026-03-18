"""
WhisperNotes Server configuration.
"""

# Whisper — use a bigger model than the phone for better accuracy
# "small" is great, "medium" is best for Romanian
WHISPER_MODEL_SIZE = "medium"
WHISPER_DEVICE = "cuda"         # "cuda" or "cpu"
WHISPER_COMPUTE_TYPE = "float16" # "float16" (GPU) or "int8" (CPU)

# Obsidian vault — Syncthing picks up changes here
OBSIDIAN_VAULT_PATH = "/home/eendi/whisper-notes-vault"
OBSIDIAN_NOTES_FOLDER = "Voice Notes"

# Server
HOST = "0.0.0.0"
PORT = 8642
