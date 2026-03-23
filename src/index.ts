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

type AiProvider = 'cohere' | 'gemini';

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

function callGeminiWithModel(apiKey: string, apiVersion: 'v1beta' | 'v1', model: string, systemContent: string, messages: CohereMessage[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({
			systemInstruction: {
				parts: [{ text: systemContent }],
			},
			contents: messages.map((m) => ({
				role: m.role === 'assistant' ? 'model' : 'user',
				parts: [{ text: m.content }],
			})),
		});

		const options: https.RequestOptions = {
			hostname: 'generativelanguage.googleapis.com',
			path: `/${apiVersion}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body),
			},
		};

		const req = https.request(options, (res) => {
			let data = '';
			res.on('data', (chunk) => { data += chunk; });
			res.on('end', () => {
				try {
					if (res.statusCode === 401 || res.statusCode === 403) {
						return reject(new Error('INVALID_API_KEY: The Gemini API key is invalid or unauthorized. Please check your key in the Settings tab.'));
					}

					const parsed = JSON.parse(data);
					const parts = parsed?.candidates?.[0]?.content?.parts;
					if (Array.isArray(parts)) {
						const text = parts
							.filter((p: any) => typeof p?.text === 'string')
							.map((p: any) => p.text)
							.join('\n')
							.trim();
						if (text) return resolve(text);
					}

					const rawErr: string = parsed?.error?.message ?? parsed?.message ?? JSON.stringify(parsed);
					const lower = (typeof rawErr === 'string' ? rawErr : JSON.stringify(rawErr)).toLowerCase();
					if (
						lower.includes('api key') ||
						lower.includes('unauthorized') ||
						lower.includes('permission denied')
					) {
						return reject(new Error('INVALID_API_KEY: The Gemini API key is invalid. Please check your key in the Settings tab.'));
					}
					reject(new Error(`Gemini API error: ${rawErr}`));
				} catch (e: any) {
					reject(new Error(`Failed to parse Gemini response: ${e.message}`));
				}
			});
		});

		req.on('error', (e) => reject(new Error(`Network error: ${e.message}`)));
		req.write(body);
		req.end();
	});
}

function listGeminiGenerateContentModels(apiKey: string, apiVersion: 'v1beta' | 'v1'): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const options: https.RequestOptions = {
			hostname: 'generativelanguage.googleapis.com',
			path: `/${apiVersion}/models?key=${encodeURIComponent(apiKey)}`,
			method: 'GET',
		};

		const req = https.request(options, (res) => {
			let data = '';
			res.on('data', (chunk) => { data += chunk; });
			res.on('end', () => {
				try {
					if (res.statusCode === 401 || res.statusCode === 403) {
						return reject(new Error('INVALID_API_KEY: The Gemini API key is invalid or unauthorized. Please check your key in the Settings tab.'));
					}

					const parsed = JSON.parse(data);
					const models = Array.isArray(parsed?.models) ? parsed.models : [];
					const names = models
						.filter((m: any) => {
							const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
							const name = String(m?.name || '').toLowerCase();
							return methods.includes('generateContent') && name.includes('gemini');
						})
						.map((m: any) => String(m.name || ''))
						.map((name: string) => name.startsWith('models/') ? name.substring('models/'.length) : name)
						.filter((name: string) => !!name);

					resolve(names);
				} catch (e: any) {
					reject(new Error(`Failed to parse Gemini model list: ${e.message}`));
				}
			});
		});

		req.on('error', (e) => reject(new Error(`Network error: ${e.message}`)));
		req.end();
	});
}

async function callGemini(apiKey: string, systemContent: string, messages: CohereMessage[]): Promise<string> {
	const apiVersions: Array<'v1beta' | 'v1'> = ['v1beta', 'v1'];
	const staticCandidates = [
		'gemini-2.5-flash',
		'gemini-2.0-flash',
		'gemini-2.0-flash-lite',
		'gemini-1.5-flash-latest',
		'gemini-1.5-flash',
		'gemini-pro',
	];

	let lastError: Error | null = null;

	for (const apiVersion of apiVersions) {
		let discovered: string[] = [];
		try {
			discovered = await listGeminiGenerateContentModels(apiKey, apiVersion);
		} catch (e: any) {
			const errMsg = String(e?.message || '');
			if (errMsg.startsWith('INVALID_API_KEY:')) throw e;
		}

		const seen = new Set<string>();
		const orderedCandidates = [...discovered, ...staticCandidates].filter((model) => {
			if (!model || seen.has(model)) return false;
			seen.add(model);
			return true;
		});

		for (const model of orderedCandidates.slice(0, 16)) {
			try {
				return await callGeminiWithModel(apiKey, apiVersion, model, systemContent, messages);
			} catch (e: any) {
				const errMsg = String(e?.message || '');
				if (errMsg.startsWith('INVALID_API_KEY:')) throw e;
				lastError = new Error(`Model ${model} failed (${apiVersion}): ${errMsg}`);
			}
		}
	}

	throw new Error(lastError?.message || 'Gemini API error: no supported Gemini model is available for this API key/account.');
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
	        <p class="welcome-sub">Make sure you've saved an API key for your selected provider in the <strong>Settings</strong> tab first.</p>
      </div>
    </div>
    <div class="chat-footer">
      <div class="chat-footer-inner">
        <!-- Note picker dropdown (floats above input) -->
        <div id="note-picker" class="note-picker" style="display:none">
          <div class="note-picker-search-wrap">
            <span class="note-picker-icon">🔍</span>
            <input type="text" id="note-picker-search" placeholder="Search notes…" autocomplete="off" />
          </div>
          <ul id="note-picker-list" class="note-picker-list"></ul>
          <div id="note-picker-empty" class="note-picker-empty" style="display:none">No matching notes</div>
        </div>
        <!-- Attached note chips -->
        <div id="attached-notes" class="attached-notes"></div>
        <!-- Input row -->
        <div class="chat-input-row">
          <button id="attach-btn" class="attach-btn" title="Attach a note (or type @ in the message)">📎</button>
          <textarea
            id="chat-input"
            placeholder="Ask something… (@ to mention a note, Enter to send)"
            rows="2"
          ></textarea>
          <button id="send-btn" title="Send">&#9654;</button>
        </div>
        <div id="chat-status" class="status-bar"></div>
      </div>
    </div>
  </div>

  <!-- ── Settings Tab ── -->
  <div class="tab-content" id="tab-settings">
    <div class="settings-panel">
	      <h2>AI Provider Settings</h2>
      <p class="settings-desc">
	        Choose your provider, then enter your API key.
	        Get keys from <a href="https://dashboard.cohere.com/api-keys" target="_blank">Cohere</a> or
	        <a href="https://aistudio.google.com/app/apikey" target="_blank">Google AI Studio (Gemini)</a>.
	        Keys are encrypted with AES-256-GCM before storage.
      </p>

	      <div class="form-group">
	        <label for="provider-select">Provider</label>
	        <select id="provider-select">
	          <option value="cohere">Cohere</option>
	          <option value="gemini">Gemini</option>
	        </select>
	      </div>

      <div class="form-group">
	        <label for="api-key-input" id="api-key-input-label">API Key</label>
        <div class="input-row">
          <input
            type="password"
            id="api-key-input"
            autocomplete="off"
	            placeholder="Paste API key…"
          />
          <button id="toggle-visibility-btn" class="icon-btn" title="Show/hide key">👁</button>
        </div>
      </div>

	      <button id="save-settings-btn" class="primary-btn">Save Provider &amp; Key</button>
      <div class="api-status-row">
	        <span class="form-label" id="provider-status-label">Provider Status:</span>
        <div id="settings-status" class="status-bar"></div>
      </div>

      <hr/>
      <div class="settings-info">
        <h3>About Security</h3>
        <ul>
          <li class="security-list">Your key is encrypted before storage.</li>
          <li class="security-list">A random 96-bit IV is generated for every save.</li>
          <li class="security-list">The key is never stored in plain text.</li>
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
			aiProvider: {
				value: 'cohere',
				type: SettingItemType.String,
				section: 'aiChatSection',
				public: false,
				label: 'AI Provider',
				description: 'Selected AI provider managed by the AI Chat plugin.',
			},
			encryptedCohereApiKey: {
				value: '',
				type: SettingItemType.String,
				section: 'aiChatSection',
				public: false,                          // hidden from the standard settings UI
				label: 'Encrypted Cohere API Key',
				description: 'AES-256-GCM encrypted Cohere API key managed by the AI Chat plugin.',
			},
			encryptedGeminiApiKey: {
				value: '',
				type: SettingItemType.String,
				section: 'aiChatSection',
				public: false,
				label: 'Encrypted Gemini API Key',
				description: 'AES-256-GCM encrypted Gemini API key managed by the AI Chat plugin.',
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
					const provider: AiProvider = msg.provider === 'gemini' ? 'gemini' : 'cohere';
					const settingKey = provider === 'gemini' ? 'encryptedGeminiApiKey' : 'encryptedCohereApiKey';
					const rawKey = (msg.apiKey ?? '').trim();

					if (rawKey) {
						const encrypted = encryptApiKey(rawKey);
						await joplin.settings.setValue(settingKey, encrypted);
					} else {
						const existing = await joplin.settings.value(settingKey) as string;
						if (!existing || !existing.trim()) {
							return { ok: false, error: `No ${provider === 'gemini' ? 'Gemini' : 'Cohere'} API key saved yet. Enter a key first.` };
						}
					}

					await joplin.settings.setValue('aiProvider', provider);
					return { ok: true };
				} catch (e: any) {
					return { ok: false, error: e.message };
				}
			}

			// ── load-settings ─────────────────────────────────────────────────
			if (msg.type === 'load-settings') {
				const providerRaw = await joplin.settings.value('aiProvider') as string;
				const provider: AiProvider = providerRaw === 'gemini' ? 'gemini' : 'cohere';
				const cohereStored = await joplin.settings.value('encryptedCohereApiKey') as string;
				const geminiStored = await joplin.settings.value('encryptedGeminiApiKey') as string;
				return {
					provider,
					hasCohereApiKey: !!(cohereStored && cohereStored.trim()),
					hasGeminiApiKey: !!(geminiStored && geminiStored.trim()),
				};
			}

			// ── get-notes-list ────────────────────────────────────────────────
			if (msg.type === 'get-notes-list') {
				try {
					const allNotes: Array<{ id: string; title: string }> = [];
					let page = 1;
					let hasMore = true;
					while (hasMore) {
						const result = await joplin.data.get(['notes'], {
							fields: ['id', 'title'],
							limit: 100,
							page: page,
						});
						const items: Array<{ id: string; title: string }> = result.items ?? [];
						allNotes.push(...items);
						hasMore = !!result.has_more;
						page++;
						if (page > 20) break; // safety cap: 2 000 notes max
					}
					return { ok: true, notes: allNotes };
				} catch (e: any) {
					console.error('AI Chat get-notes-list error:', e.message);
					return { ok: false, notes: [], error: e.message };
				}
			}

			// ── chat ──────────────────────────────────────────────────────────
			if (msg.type === 'chat') {
				const providerRaw = (msg.provider ?? (await joplin.settings.value('aiProvider'))) as string;
				const provider: AiProvider = providerRaw === 'gemini' ? 'gemini' : 'cohere';
				const settingKey = provider === 'gemini' ? 'encryptedGeminiApiKey' : 'encryptedCohereApiKey';
				const stored = await joplin.settings.value(settingKey) as string;
				if (!stored || !stored.trim()) {
					return { ok: false, error: `No API key configured for ${provider === 'gemini' ? 'Gemini' : 'Cohere'}. Open the Settings tab to add it.` };
				}

				let apiKey: string;
				try {
					apiKey = decryptApiKey(stored);
				} catch (e: any) {
					return { ok: false, error: `Could not decrypt API key: ${e.message}` };
				}

				// Fetch notes to build context:
				// If the user attached specific notes, load only those; otherwise load recent 30
				let notesContext = '';
				try {
					const attachedIds: string[] = msg.attachedNoteIds ?? [];
					if (attachedIds.length > 0) {
						const noteItems: Array<{ title: string; body: string }> = [];
						for (const id of attachedIds) {
							const note = await joplin.data.get(['notes', id], { fields: ['title', 'body'] });
							noteItems.push(note);
						}
						notesContext = noteItems
							.map((n) => `### ${n.title}\n${(n.body || '').substring(0, 4000)}`)
							.join('\n\n---\n\n');
					} else {
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
					}
				} catch (e: any) {
					// Non-fatal — continue without notes context
					console.error('AI Chat: failed to load notes:', e.message);
				}

				// Build message array
				const attachedIds: string[] = msg.attachedNoteIds ?? [];
				const systemContent = notesContext
					? attachedIds.length > 0
						? `You are a helpful AI assistant. The user has attached the following specific Joplin notes for context. Answer based on these notes.\n\n${notesContext}`
						: `You are a helpful AI assistant. Answer the user's questions using the following Joplin notes as context.\n\n${notesContext}`
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
					const reply = provider === 'gemini'
						? await callGemini(apiKey, systemContent, messages.filter((m) => m.role !== 'system'))
						: await callCohere(apiKey, messages);
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

