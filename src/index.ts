import joplin from 'api';
import { SettingItemType } from 'api/types';
import * as crypto from 'crypto';
import * as https from 'https';

// ─── Encryption helpers ───────────────────────────────────────────────────────
// AES-256-GCM with a key derived from a fixed material + salt.
// The IV is random per-encryption, stored alongside the ciphertext.
// This keeps the API key safe at rest in Joplin's settings store.
const ENCRYPTION_MATERIAL = 'joplin-ai-chat-plugin-v1-aes-key';
const ENCRYPTION_SALT = 'joplin-ai-chat-plugin-v1-salt';

function deriveKey(): Buffer {
	return crypto.scryptSync(ENCRYPTION_MATERIAL, ENCRYPTION_SALT, 32);
}

function encryptApiKey(plaintext: string): string {
	const key = deriveKey();
	const iv = crypto.randomBytes(12); // 96-bit IV recommended for GCM
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	// Format:  base64(iv):base64(tag):base64(ciphertext)
	return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptApiKey(stored: string): string {
	const [ivB64, tagB64, encB64] = stored.split(':');
	if (!ivB64 || !tagB64 || !encB64) throw new Error('Invalid encrypted API key format');
	const key = deriveKey();
	const iv = Buffer.from(ivB64, 'base64');
	const tag = Buffer.from(tagB64, 'base64');
	const encrypted = Buffer.from(encB64, 'base64');
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ─── Cohere v2 Chat API ───────────────────────────────────────────────────────
interface CohereMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

function callCohere(apiKey: string, messages: CohereMessage[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({
			model: 'command-r-plus-08-2024',
			messages: messages,
		});

		const options: https.RequestOptions = {
			hostname: 'api.cohere.com',
			path: '/v2/chat',
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body),
			},
		};

		const req = https.request(options, (res) => {
			let data = '';
			res.on('data', (chunk) => { data += chunk; });
			res.on('end', () => {
				try {
					// Detect authentication failures immediately from HTTP status
					if (res.statusCode === 401 || res.statusCode === 403) {
						return reject(new Error('INVALID_API_KEY: The Cohere API key is invalid or unauthorized. Please check your key in the Settings tab.'));
					}

					const parsed = JSON.parse(data);
					// Cohere v2 response shape: { message: { content: [{ type: 'text', text: '...' }] } }
					const content = parsed?.message?.content;
					if (Array.isArray(content)) {
						const textBlock = content.find((c: any) => c.type === 'text');
						return resolve(textBlock?.text ?? 'No text response returned.');
					}
					// Fallback for error responses — check for auth-related messages
					const rawErr: string = parsed?.message ?? parsed?.detail ?? JSON.stringify(parsed);
					const lower = (typeof rawErr === 'string' ? rawErr : JSON.stringify(rawErr)).toLowerCase();
					if (lower.includes('invalid api') || lower.includes('unauthorized') || lower.includes('invalid token')) {
						return reject(new Error('INVALID_API_KEY: The Cohere API key is invalid. Please check your key in the Settings tab.'));
					}
					reject(new Error(`Cohere API error: ${rawErr}`));
				} catch (e: any) {
					reject(new Error(`Failed to parse Cohere response: ${e.message}`));
				}
			});
		});

		req.on('error', (e) => reject(new Error(`Network error: ${e.message}`)));
		req.write(body);
		req.end();
	});
}

// ─── Panel HTML ───────────────────────────────────────────────────────────────
function getPanelHtml(): string {
	return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <link rel="stylesheet" href="webview.css"/>
</head>
<body>
  <!-- Tab navigation -->
  <div class="tab-bar">
    <button class="tab-btn active" data-tab="chat" id="tab-chat-btn">
      <span class="tab-icon">💬</span> Chat
    </button>
    <button class="tab-btn" data-tab="settings" id="tab-settings-btn">
      <span class="tab-icon">⚙️</span> Settings
    </button>
  </div>

  <!-- ── Chat Tab ── -->
  <div class="tab-content active" id="tab-chat">
    <div class="chat-messages" id="chat-messages">
      <div class="welcome-msg">
        <div class="welcome-icon">🤖</div>
        <p>Hello! I can answer questions based on your Joplin notes.</p>
        <p class="welcome-sub">Make sure you've saved your Cohere API key in the <strong>Settings</strong> tab first.</p>
      </div>
    </div>
    <div class="chat-footer">
      <div class="chat-input-row">
        <textarea
          id="chat-input"
          placeholder="Ask something about your notes… (Enter to send, Shift+Enter for new line)"
          rows="2"
        ></textarea>
        <button id="send-btn" title="Send">&#9654;</button>
      </div>
      <div id="chat-status" class="status-bar"></div>
    </div>
  </div>

  <!-- ── Settings Tab ── -->
  <div class="tab-content" id="tab-settings">
    <div class="settings-panel">
      <h2>Cohere API Settings</h2>
      <p class="settings-desc">
        Enter your personal <a href="https://dashboard.cohere.com/api-keys" target="_blank">Cohere API key</a>.
        It is encrypted with AES-256-GCM before being stored.
      </p>

      <div class="form-group">
        <label for="api-key-input">API Key</label>
        <div class="input-row">
          <input
            type="password"
            id="api-key-input"
            autocomplete="off"
            placeholder="sk-…"
          />
          <button id="toggle-visibility-btn" class="icon-btn" title="Show/hide key">👁</button>
        </div>
      </div>

      <button id="save-settings-btn" class="primary-btn">Save &amp; Encrypt</button>
      <div id="settings-status" class="status-bar"></div>

      <hr/>
      <div class="settings-info">
        <h3>About encryption</h3>
        <ul>
          <li>Your key is encrypted with <strong>AES-256-GCM</strong> before storage.</li>
          <li>A random 96-bit IV is generated for every save.</li>
          <li>The key is never stored in plain text.</li>
        </ul>
      </div>
    </div>
  </div>

  <script src="webview.js"></script>
</body>
</html>
`.trim();
}

// ─── Plugin registration ──────────────────────────────────────────────────────
joplin.plugins.register({
	onStart: async function () {

		// Register settings section + one hidden setting for the encrypted key
		await joplin.settings.registerSection('aiChatSection', {
			label: 'AI Chat on Notes',
			iconName: 'fas fa-comment-alt',
		});

		await joplin.settings.registerSettings({
			encryptedCohereApiKey: {
				value: '',
				type: SettingItemType.String,
				section: 'aiChatSection',
				public: false,                          // hidden from the standard settings UI
				label: 'Encrypted Cohere API Key',
				description: 'AES-256-GCM encrypted Cohere API key managed by the AI Chat plugin.',
			},
		});

		// ── Create panel ──────────────────────────────────────────────────────
		const panel = await joplin.views.panels.create('aiChatOnNotesPanel');
		await joplin.views.panels.setHtml(panel, getPanelHtml());
		await joplin.views.panels.addScript(panel, './webview.css');
		await joplin.views.panels.addScript(panel, './webview.js');

		// ── Message handler ───────────────────────────────────────────────────
		await joplin.views.panels.onMessage(panel, async (msg: any) => {

			// ── save-settings ─────────────────────────────────────────────────
			if (msg.type === 'save-settings') {
				try {
					if (!msg.apiKey || !msg.apiKey.trim()) {
						return { ok: false, error: 'API key cannot be empty.' };
					}
					const encrypted = encryptApiKey(msg.apiKey.trim());
					await joplin.settings.setValue('encryptedCohereApiKey', encrypted);
					return { ok: true };
				} catch (e: any) {
					return { ok: false, error: e.message };
				}
			}

			// ── load-settings ─────────────────────────────────────────────────
			if (msg.type === 'load-settings') {
				const stored = await joplin.settings.value('encryptedCohereApiKey') as string;
				return { hasApiKey: !!(stored && stored.trim()) };
			}

			// ── chat ──────────────────────────────────────────────────────────
			if (msg.type === 'chat') {
				const stored = await joplin.settings.value('encryptedCohereApiKey') as string;
				if (!stored || !stored.trim()) {
					return { ok: false, error: 'No API key configured. Open the Settings tab to add your Cohere API key.' };
				}

				let apiKey: string;
				try {
					apiKey = decryptApiKey(stored);
				} catch (e: any) {
					return { ok: false, error: `Could not decrypt API key: ${e.message}` };
				}

				// Fetch up to 30 notes (title + body) to build context
				let notesContext = '';
				try {
					const result = await joplin.data.get(['notes'], {
						fields: ['title', 'body'],
						limit: 30,
					});
					const items: Array<{ title: string; body: string }> = result.items ?? [];
					if (items.length > 0) {
						notesContext = items
							.map((n) => `### ${n.title}\n${(n.body || '').substring(0, 2000)}`)
							.join('\n\n---\n\n');
					}
				} catch (e: any) {
					// Non-fatal — continue without notes context
					console.error('AI Chat: failed to load notes:', e.message);
				}

				// Build message array
				const systemContent = notesContext
					? `You are a helpful AI assistant. Answer the user's questions using the following Joplin notes as context.\n\n${notesContext}`
					: 'You are a helpful AI assistant. The user has no notes yet.';

				// Conversation history comes from the webview
				const history: CohereMessage[] = (msg.history ?? []).map((h: any) => ({
					role: h.role as 'user' | 'assistant',
					content: h.content as string,
				}));

				const messages: CohereMessage[] = [
					{ role: 'system', content: systemContent },
					...history,
					{ role: 'user', content: msg.message as string },
				];

				try {
					const reply = await callCohere(apiKey, messages);
					return { ok: true, reply };
				} catch (e: any) {
					const errMsg: string = e.message || 'Unknown error';
					// Surface invalid-key errors with a dedicated flag
					if (errMsg.startsWith('INVALID_API_KEY:')) {
						return { ok: false, invalidApiKey: true, error: errMsg.replace('INVALID_API_KEY: ', '') };
					}
					return { ok: false, error: errMsg };
				}
			}

			return { ok: false, error: 'Unknown message type' };
		});
	},
});

