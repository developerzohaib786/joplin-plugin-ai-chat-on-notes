/* global webviewApi */

(function () {
    'use strict';

    // ── State ────────────────────────────────────────────────────────────────
    const chatHistory = []; // { role: 'user'|'assistant', content: string }
    let isBusy = false;
    let apiKeySet = false;

    // ── Element refs ─────────────────────────────────────────────────────────
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const chatStatus = document.getElementById('chat-status');
    const apiKeyInput = document.getElementById('api-key-input');
    const saveSettingsBtn = document.getElementById('save-settings-btn');
    const settingsStatus = document.getElementById('settings-status');
    const toggleVisBtn = document.getElementById('toggle-visibility-btn');
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    // ── Tab switching ────────────────────────────────────────────────────────
    tabBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
            const target = btn.getAttribute('data-tab');
            tabBtns.forEach(function (b) { b.classList.remove('active'); });
            tabContents.forEach(function (c) { c.classList.remove('active'); });
            btn.classList.add('active');
            document.getElementById('tab-' + target).classList.add('active');
        });
    });

    // ── Show / hide API key ──────────────────────────────────────────────────
    toggleVisBtn.addEventListener('click', function () {
        if (apiKeyInput.type === 'password') {
            apiKeyInput.type = 'text';
            toggleVisBtn.textContent = '🙈';
        } else {
            apiKeyInput.type = 'password';
            toggleVisBtn.textContent = '👁';
        }
    });

    // ── Helpers ──────────────────────────────────────────────────────────────
    function setStatus(el, msg, isError) {
        el.textContent = msg;
        el.className = 'status-bar ' + (isError ? 'status-error' : 'status-ok');
        if (msg) {
            setTimeout(function () { el.textContent = ''; el.className = 'status-bar'; }, 4000);
        }
    }

    function appendMessage(role, text) {
        // Remove welcome message on first real message
        const welcome = chatMessages.querySelector('.welcome-msg');
        if (welcome) welcome.remove();

        const div = document.createElement('div');
        div.className = 'chat-msg ' + (role === 'user' ? 'msg-user' : 'msg-assistant');

        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        bubble.textContent = text;

        div.appendChild(bubble);
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function appendErrorBubble(text) {
        const div = document.createElement('div');
        div.className = 'chat-msg msg-error';
        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble bubble-error';
        bubble.textContent = text;
        div.appendChild(bubble);
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function setBusy(busy) {
        isBusy = busy;
        sendBtn.disabled = busy;
        chatInput.disabled = busy;
        setStatus(chatStatus, busy ? 'Thinking…' : '', false);
    }

    function isInvalidKeyError(errMsg) {
        const lower = (errMsg || '').toLowerCase();
        return (
            lower.includes('invalid api') ||
            lower.includes('unauthorized') ||
            lower.includes('401') ||
            lower.includes('authentication') ||
            lower.includes('forbidden') ||
            lower.includes('access denied') ||
            lower.includes('invalid token') ||
            lower.includes('expired')
        );
    }

    // ── Send chat message ────────────────────────────────────────────────────
    async function sendMessage() {
        if (isBusy) return;
        const text = chatInput.value.trim();
        if (!text) return;

        // Guard: API key not set
        if (!apiKeySet) {
            appendErrorBubble('⚠️ API key is not set. Please go to the Settings tab and save your Cohere API key first.');
            return;
        }

        chatInput.value = '';
        appendMessage('user', text);
        setBusy(true);

        try {
            const response = await webviewApi.postMessage({
                type: 'chat',
                message: text,
                history: chatHistory.slice(),
            });

            setBusy(false);

            if (response && response.ok) {
                const reply = response.reply || '(no response)';
                appendMessage('assistant', reply);
                chatHistory.push({ role: 'user', content: text });
                chatHistory.push({ role: 'assistant', content: reply });
            } else {
                const errMsg = (response && response.error) ? response.error : 'Unknown error.';
                if (response && response.invalidApiKey) {
                    appendErrorBubble('❌ API key is not valid. Please check your Cohere API key in the Settings tab.');
                } else if (isInvalidKeyError(errMsg)) {
                    appendErrorBubble('❌ API key is not valid. Please check your Cohere API key in the Settings tab.');
                } else if (errMsg.toLowerCase().includes('no api key') || errMsg.toLowerCase().includes('not configured')) {
                    appendErrorBubble('⚠️ API key is not set. Please go to the Settings tab and save your Cohere API key first.');
                    apiKeySet = false;
                } else {
                    appendErrorBubble('❌ Error: ' + errMsg);
                }
            }
        } catch (e) {
            setBusy(false);
            appendErrorBubble('❌ Unexpected error: ' + (e.message || String(e)));
        }
    }

    sendBtn.addEventListener('click', sendMessage);

    chatInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // ── Save settings ────────────────────────────────────────────────────────
    saveSettingsBtn.addEventListener('click', async function () {
        const key = apiKeyInput.value.trim();
        if (!key) {
            setStatus(settingsStatus, 'API key cannot be empty.', true);
            return;
        }

        saveSettingsBtn.disabled = true;
        setStatus(settingsStatus, 'Saving…', false);

        try {
            const response = await webviewApi.postMessage({
                type: 'save-settings',
                apiKey: key,
            });

            if (response && response.ok) {
                apiKeySet = true;
                apiKeyInput.value = '';
                setStatus(settingsStatus, '✅ API key saved and encrypted successfully!', false);
            } else {
                const errMsg = (response && response.error) ? response.error : 'Failed to save settings.';
                setStatus(settingsStatus, '❌ ' + errMsg, true);
            }
        } catch (e) {
            setStatus(settingsStatus, '❌ Unexpected error: ' + (e.message || String(e)), true);
        } finally {
            saveSettingsBtn.disabled = false;
        }
    });

    // ── Load initial state ───────────────────────────────────────────────────
    async function init() {
        try {
            const response = await webviewApi.postMessage({ type: 'load-settings' });
            if (response && response.hasApiKey) {
                apiKeySet = true;
                setStatus(settingsStatus, '✅ API key is configured.', false);
            } else {
                apiKeySet = false;
                // Show a prompt in chat to configure the key
                const welcome = chatMessages.querySelector('.welcome-msg');
                if (welcome) {
                    const notice = document.createElement('p');
                    notice.className = 'welcome-sub api-warning';
                    notice.innerHTML = '⚠️ <strong>No API key set.</strong> Go to the <strong>Settings</strong> tab to add your Cohere API key.';
                    welcome.appendChild(notice);
                }
            }
        } catch (e) {
            console.error('AI Chat init error:', e);
        }
    }

    init();
})();
