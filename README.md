# AI Note Assistant: Joplin Plugin

An AI-powered chat panel for Joplin that lets you have a conversation with your notes. Ask questions, get summaries, brainstorm ideas, and dig into your knowledge base, all without leaving the editor.

---

## Features

- **Chat with your notes:** Ask anything and the assistant answers using the content of your Joplin notes as context.
- **Attach specific notes:** Click the 📎 button or type `@` in the message box to pick and attach individual notes to a prompt, so the AI focuses only on what you choose.
- **@ mention autocomplete:** Type `@` followed by any part of a note title to get an instant searchable dropdown. Select a note to pin it to the message.
- **Conversation memory:** The assistant remembers the full back-and-forth within a session, so you can ask follow-up questions naturally.
- **Multiple AI providers:** Choose between **Cohere** and **Google Gemini** in the Settings tab.
- **Secure API key storage:** Your API keys are encrypted with **AES-256-GCM** (random 96-bit IV per save) before being stored, and are never kept in plain text.
- **Theme aware:** Automatically adapts to your Joplin theme (Light, Dark, Dracula, etc.) using native CSS variables.
- **Keyboard friendly:** Press `Enter` to send, `Shift+Enter` for a new line, and navigate the note picker entirely with the keyboard.

---

## Installation

### Via Joplin Plugin Marketplace (Recommended)

1. Open Joplin and go to **Tools › Options** (or **Joplin › Settings** on macOS).
2. Click **Plugins** in the left sidebar.
3. Search for **`joplin-plugin-ai-note-assistant`**.
4. Click **Install** and restart Joplin.

### Manual Installation

1. Download the `.jpl` file from the [GitHub Releases](https://github.com/developerzohaib786/joplin-plugin-ai-chat-on-notes/releases) page.
2. In Joplin, go to **Tools › Options › Plugins**.
3. Click the gear icon (top right) and select **Install from file**.
4. Select the downloaded `.jpl` file and restart Joplin.

---

## Setup

This plugin supports **Cohere** and **Google Gemini**.

1. Create a key at [dashboard.cohere.com/api-keys](https://dashboard.cohere.com/api-keys) or [Google AI Studio](https://aistudio.google.com/app/apikey).
2. In Joplin, open the **AI Note Assistant** panel and switch to the **⚙️ Settings** tab.
3. Select your provider (**Cohere** or **Gemini**).
4. Paste your key and click **Save Provider & Key**.
5. The status row will confirm when the selected provider key is configured.

---

## How to Use

Once installed and configured, the **AI Note Assistant** panel appears automatically on the side.

### Asking a question (no attachment)
Type your question in the input box and press **Enter**. The assistant will use up to 30 of your most recent notes as background context to answer.

### Attaching specific notes
1. **Click the 📎 button** next to the input box to open the note picker dropdown.
2. Search by title and click a note to attach it. Repeat for multiple notes.
3. Attached notes appear as chips above the input. Click **×** on a chip to remove one.
4. Send your message — the assistant will use *only* the attached notes as context, giving you a more focused answer.

### @ mention shortcut
Type `@` directly in the message followed by part of the note title (e.g. `@project plan`). The picker opens automatically. Select a note with the mouse or keyboard — the `@query` text is removed and the note is attached as a chip.

### Keyboard shortcuts (in the note picker)
| Key | Action |
|-----|--------|
| `↓` / `↑` | Navigate the list |
| `Enter` | Select the focused note |
| `Escape` | Close the picker |

---

## Technical Summary

| Detail | Value |
|--------|-------|
| AI Model | Cohere `command-r-plus-08-2024` or Gemini `gemini-1.5-flash` |
| Encryption | AES-256-GCM, key derived with `scrypt`, random 96-bit IV per save |
| Note fetching | Paginates through all notes (up to 2 000) for the picker; loads up to 30 notes as fallback context |
| Context window | 4 000 chars per attached note, 2 000 chars per fallback note |
| Min Joplin version | 3.5 |

---

## License

MIT © [Zohaib Irshad](https://github.com/developerzohaib786)
