/**
 * Pocket Phone — character-bound SMS for SillyTavern
 * Options-menu entry · fullscreen H5 · dual send · multi <msg> replies · editable preset
 */
import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

const MODULE_NAME = 'st-pocket-phone';
const EXTENSION_FOLDER = `scripts/extensions/third-party/${MODULE_NAME}`;

const FALLBACK_PRESET = `你正在扮演角色「{{char}}」，通过手机短信回复 User。
只输出闭合 XML 标签，标签外不要有任何文字。
普通短信用 <msg>文本</msg>，可连发多条。语音低频用 <voice>[happy] 内容</voice>。
口语短句，按人设决定 emoji/缩写。

角色设定：
{{char_description}}
{{char_personality}}

最近短信：
{{sms_history}}

User 本轮消息：
{{user_input}}

开始发送：`;

const defaultSettings = Object.freeze({
    enabled: true,
    syncMainChat: false,
    showFab: false,
    apiMode: 'st',
    apiUrl: '',
    apiKey: '',
    apiModel: '',
    apiHint: '',
    presetPrompt: '',
    threads: {},
});

/** @type {{ role: 'user' | 'char' | 'voice' | 'meta', text: string, ts: number, pending?: boolean }[]} */
let activeThread = [];
let isGenerating = false;
let boundCharacterKey = '';
let defaultPresetCache = '';

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = structuredClone
                ? structuredClone(value)
                : JSON.parse(JSON.stringify(value));
        }
    }
    return extension_settings[MODULE_NAME];
}

async function ensureDefaultPreset() {
    const s = getSettings();
    if (s.presetPrompt) return s.presetPrompt;
    if (!defaultPresetCache) {
        try {
            defaultPresetCache = await $.get(`${EXTENSION_FOLDER}/default-preset.txt`);
        } catch {
            defaultPresetCache = FALLBACK_PRESET;
        }
    }
    s.presetPrompt = String(defaultPresetCache || FALLBACK_PRESET);
    saveSettingsDebounced();
    return s.presetPrompt;
}

function getActiveCharacter() {
    const ctx = getContext();
    if (ctx.groupId) {
        const group = ctx.groups?.find?.(g => g.id === ctx.groupId);
        return {
            kind: 'group',
            key: `group:${ctx.groupId}`,
            name: group?.name || '群聊',
            avatarUrl: '',
            description: '',
            personality: '',
            scenario: '',
        };
    }
    const id = ctx.characterId;
    if (id == null || !ctx.characters?.[id]) return null;
    const ch = ctx.characters[id];
    let fields = {};
    try {
        fields = typeof ctx.getCharacterCardFields === 'function' ? (ctx.getCharacterCardFields() || {}) : {};
    } catch {
        fields = {};
    }
    const avatarUrl = typeof ctx.getThumbnailUrl === 'function'
        ? ctx.getThumbnailUrl('avatar', ch.avatar)
        : `/thumbnail?type=avatar&file=${encodeURIComponent(ch.avatar || '')}`;
    return {
        kind: 'character',
        key: `char:${ch.avatar || id}`,
        name: ch.name || fields.name || '角色',
        avatarUrl,
        description: fields.description || ch.description || '',
        personality: fields.personality || ch.personality || '',
        scenario: fields.scenario || ch.scenario || '',
    };
}

function threadKey() {
    return getActiveCharacter()?.key || 'char:unknown';
}

function loadThread() {
    const settings = getSettings();
    const key = threadKey();
    boundCharacterKey = key;
    if (!settings.threads[key]) settings.threads[key] = [];
    activeThread = settings.threads[key];
}

function persistThread() {
    getSettings().threads[threadKey()] = activeThread;
    saveSettingsDebounced();
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function truncate(text, n = 280) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

function apiModeLabel() {
    return getSettings().apiMode === 'custom' ? '自定义 API' : '酒馆当前 API';
}

function injectOptionsMenuEntry() {
    if (document.getElementById('option_pocket_phone')) return;
    const host = document.querySelector('#options .options-content');
    if (!host) return;

    const link = document.createElement('a');
    link.id = 'option_pocket_phone';
    link.className = 'interactable';
    link.innerHTML = `
        <i class="fa-lg fa-solid fa-mobile-screen-button pp-opt-icon"></i>
        <span>小手机</span>
    `;
    link.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        $('#options').hide();
        openPhone('sms');
    });

    const firstHr = host.querySelector('hr');
    if (firstHr) host.insertBefore(link, firstHr);
    else host.appendChild(link);
}

function ensureUi() {
    if (document.getElementById('pocket-phone-root')) return;

    const fab = document.createElement('button');
    fab.id = 'pocket-phone-fab';
    fab.type = 'button';
    fab.title = '打开小手机';
    fab.innerHTML = '<i class="fa-solid fa-comment-dots"></i>';
    fab.addEventListener('click', () => openPhone('sms'));
    document.body.appendChild(fab);

    const root = document.createElement('div');
    root.id = 'pocket-phone-root';
    root.innerHTML = `
        <div class="pocket-phone-backdrop"></div>
        <div class="pocket-phone-device" role="dialog" aria-label="Pocket Phone">
            <div class="pocket-phone-screen">
                <div class="pocket-phone-topbar">
                    <button type="button" class="pp-back" data-action="close" title="关闭">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                    <img class="pocket-phone-avatar" id="pocket-phone-avatar" alt="" />
                    <div class="pocket-phone-top-meta">
                        <div class="name" id="pocket-phone-title">小手机</div>
                        <div class="sub" id="pocket-phone-subtitle"></div>
                    </div>
                </div>
                <div class="pocket-phone-tabs">
                    <button type="button" data-tab="sms" class="active">短信</button>
                    <button type="button" data-tab="api">API</button>
                    <button type="button" data-tab="preset">预设</button>
                </div>

                <div class="pocket-phone-view active" data-view="sms">
                    <div class="pocket-phone-messages" id="pocket-phone-messages"></div>
                    <div class="pocket-phone-composer">
                        <textarea id="pocket-phone-input" rows="2" placeholder="输入一条短信…"></textarea>
                        <div class="pocket-phone-composer-actions">
                            <button type="button" id="pocket-phone-add" title="只加入界面，不请求模型">发送气泡</button>
                            <button type="button" id="pocket-phone-reply" title="根据未回复的用户气泡请求模型回复">请求回复</button>
                        </div>
                        <p class="pp-help">「发送气泡」可连发多条用户消息；「请求回复」才会让角色按预设协议一次回多条 &lt;msg&gt;。</p>
                    </div>
                </div>

                <div class="pocket-phone-view pocket-phone-panel" data-view="api">
                    <div class="pp-mode-row">
                        <label><input type="radio" name="pp_inline_api_mode" value="st" /> 使用酒馆当前聊天 API</label>
                        <label><input type="radio" name="pp_inline_api_mode" value="custom" /> 使用自定义 API</label>
                    </div>
                    <button type="button" class="pp-primary-btn" id="pp-inline-import-st">一键接入正在使用的 API</button>
                    <div id="pp-inline-hint" class="pp-help"></div>
                    <label>API Base URL</label>
                    <input id="pp-inline-api-url" type="text" placeholder="https://api.openai.com/v1" />
                    <label>API Key</label>
                    <input id="pp-inline-api-key" type="password" placeholder="sk-..." autocomplete="off" />
                    <label>Model</label>
                    <input id="pp-inline-api-model" type="text" placeholder="模型名" />
                    <button type="button" class="pp-secondary-btn" id="pp-inline-save">保存 API 设置</button>
                </div>

                <div class="pocket-phone-view pocket-phone-panel" data-view="preset">
                    <p class="pp-help">参考本地 Phone Reply 协议：只输出 &lt;msg&gt;/&lt;voice&gt;；可用变量 {{char}} {{char_description}} {{char_personality}} {{char_scenario}} {{sms_history}} {{user_input}}</p>
                    <label>短信系统预设提示词</label>
                    <textarea id="pp-preset-editor" spellcheck="false"></textarea>
                    <button type="button" class="pp-primary-btn" id="pp-preset-save">保存预设</button>
                    <button type="button" class="pp-secondary-btn" id="pp-preset-reset">恢复默认预设</button>
                </div>
            </div>
        </div>
    `;
    document.documentElement.appendChild(root);

    root.querySelector('[data-action="close"]')?.addEventListener('click', () => closePhone());
    root.querySelectorAll('.pocket-phone-tabs [data-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.getAttribute('data-tab');
            showView(tab);
            if (tab === 'api') syncInlineApiForm();
            if (tab === 'preset') syncPresetEditor();
        });
    });
    root.querySelector('#pocket-phone-add')?.addEventListener('click', () => addUserBubble());
    root.querySelector('#pocket-phone-reply')?.addEventListener('click', () => void requestModelReply());
    root.querySelector('#pocket-phone-input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            addUserBubble();
        }
    });
    root.querySelector('#pp-inline-import-st')?.addEventListener('click', () => {
        importCurrentTavernApi({ preferStMode: true });
        syncInlineApiForm();
        toastr?.success?.('已一键接入酒馆正在使用的 API');
    });
    root.querySelector('#pp-inline-save')?.addEventListener('click', () => {
        saveInlineApiForm();
        toastr?.success?.('API 设置已保存');
    });
    root.querySelectorAll('input[name="pp_inline_api_mode"]').forEach(el => {
        el.addEventListener('change', () => {
            getSettings().apiMode = /** @type {HTMLInputElement} */ (el).value === 'custom' ? 'custom' : 'st';
            saveSettingsDebounced();
            updateHeader();
        });
    });
    root.querySelector('#pp-preset-save')?.addEventListener('click', () => {
        const ta = /** @type {HTMLTextAreaElement} */ (document.getElementById('pp-preset-editor'));
        getSettings().presetPrompt = ta?.value || '';
        saveSettingsDebounced();
        toastr?.success?.('预设已保存');
    });
    root.querySelector('#pp-preset-reset')?.addEventListener('click', async () => {
        defaultPresetCache = '';
        getSettings().presetPrompt = '';
        await ensureDefaultPreset();
        syncPresetEditor();
        toastr?.success?.('已恢复默认预设');
    });
}

function showView(name) {
    document.querySelectorAll('#pocket-phone-root .pocket-phone-view').forEach(view => {
        view.classList.toggle('active', view.getAttribute('data-view') === name);
    });
    document.querySelectorAll('#pocket-phone-root .pocket-phone-tabs [data-tab]').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === name);
    });
}

function updateHeader() {
    const ch = getActiveCharacter();
    const title = document.getElementById('pocket-phone-title');
    const sub = document.getElementById('pocket-phone-subtitle');
    const avatar = /** @type {HTMLImageElement|null} */ (document.getElementById('pocket-phone-avatar'));
    if (!ch) {
        if (title) title.textContent = '小手机';
        if (sub) sub.textContent = '请先打开角色对话';
        return;
    }
    if (title) title.textContent = ch.name;
    if (sub) sub.textContent = `${apiModeLabel()} · 角色绑定`;
    if (avatar) {
        if (ch.avatarUrl) avatar.src = ch.avatarUrl;
        else avatar.removeAttribute('src');
    }
}

function renderMessages() {
    const box = document.getElementById('pocket-phone-messages');
    if (!box) return;
    const ch = getActiveCharacter();
    if (!activeThread.length) {
        box.innerHTML = `<div class="pocket-phone-bubble meta">和「${escapeHtml(ch?.name || '角色')}」的专属短信还是空的。先用「发送气泡」连发几条，再点「请求回复」。</div>`;
        return;
    }
    box.innerHTML = activeThread.map(m => {
        const cls = [
            'pocket-phone-bubble',
            m.role === 'voice' ? 'voice' : m.role,
            m.pending ? 'pending' : '',
        ].filter(Boolean).join(' ');
        const prefix = m.role === 'voice' ? '🎙 ' : '';
        return `<div class="${cls}">${prefix}${escapeHtml(m.text)}</div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
}

function refreshSmsUi() {
    loadThread();
    updateHeader();
    renderMessages();
}

async function openPhone(tab = 'sms') {
    const settings = getSettings();
    if (!settings.enabled) {
        toastr?.warning?.('小手机已在扩展设置中关闭');
        return;
    }
    const ch = getActiveCharacter();
    if (!ch) {
        toastr?.warning?.('请先选择角色并进入对话');
        return;
    }
    ensureUi();
    await ensureDefaultPreset();
    loadThread();
    showView(tab);
    updateHeader();
    renderMessages();
    if (tab === 'api') syncInlineApiForm();
    if (tab === 'preset') syncPresetEditor();
    document.getElementById('pocket-phone-root')?.classList.add('pocket-phone-open');
    refreshFab();
}

function closePhone() {
    document.getElementById('pocket-phone-root')?.classList.remove('pocket-phone-open');
}

function refreshFab() {
    ensureUi();
    const fab = document.getElementById('pocket-phone-fab');
    const settings = getSettings();
    const ch = getActiveCharacter();
    const show = !!settings.enabled && !!settings.showFab && !!ch;
    fab?.classList.toggle('pocket-phone-fab-on', !!settings.showFab);
    fab?.classList.toggle('pocket-phone-hidden', !show);
}

function addUserBubble() {
    const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pocket-phone-input'));
    const text = (input?.value || '').trim();
    if (!text) return;
    const ch = getActiveCharacter();
    if (!ch) {
        toastr?.warning?.('请先选择角色并进入对话');
        return;
    }
    if (boundCharacterKey !== ch.key) loadThread();

    activeThread.push({ role: 'user', text, ts: Date.now(), pending: true });
    persistThread();
    if (input) input.value = '';
    renderMessages();
}

function collectPendingUserTexts() {
    const pending = [];
    for (let i = activeThread.length - 1; i >= 0; i--) {
        const m = activeThread[i];
        if (m.role === 'char' || m.role === 'voice') break;
        if (m.role === 'user') pending.unshift(m.text);
    }
    return pending;
}

function clearPendingFlags() {
    for (const m of activeThread) {
        if (m.role === 'user') m.pending = false;
    }
}

/**
 * Parse Rich Message Protocol tags from model output.
 * @param {string} raw
 * @returns {{ role: 'char' | 'voice', text: string }[]}
 */
function parsePhoneReply(raw) {
    const text = String(raw || '').trim();
    const out = [];
    const re = /<(msg|voice|sticker|ima)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;
    while ((match = re.exec(text)) !== null) {
        const tag = match[1].toLowerCase();
        const body = String(match[2] || '').trim();
        if (!body) continue;
        if (tag === 'msg') out.push({ role: 'char', text: body });
        else if (tag === 'voice') out.push({ role: 'voice', text: body });
        // sticker/ima ignored in MVP UI (protocol-compatible skip)
    }
    if (out.length) return out;

    // Fallback: plain text → split short lines into bubbles
    const lines = text
        .split(/\n+/)
        .map(x => x.trim())
        .filter(Boolean)
        .filter(x => !/^```/.test(x));
    if (lines.length > 1) return lines.map(line => ({ role: 'char', text: line }));
    if (text) return [{ role: 'char', text }];
    return [];
}

function fillPresetTemplate(tpl, vars) {
    let out = String(tpl || '');
    for (const [k, v] of Object.entries(vars)) {
        out = out.split(`{{${k}}}`).join(String(v ?? ''));
    }
    return out;
}

function buildGenerationPrompt(userBundle) {
    const ch = getActiveCharacter();
    const history = activeThread
        .filter(m => m.role === 'user' || m.role === 'char' || m.role === 'voice')
        .slice(-24)
        .map(m => {
            if (m.role === 'user') return `User: ${m.text}`;
            if (m.role === 'voice') return `${ch?.name || '角色'} <voice>: ${m.text}`;
            return `${ch?.name || '角色'}: ${m.text}`;
        })
        .join('\n');

    const preset = getSettings().presetPrompt || FALLBACK_PRESET;
    return fillPresetTemplate(preset, {
        char: ch?.name || '角色',
        char_description: truncate(ch?.description || '', 900),
        char_personality: truncate(ch?.personality || '', 500),
        char_scenario: truncate(ch?.scenario || '', 500),
        sms_history: history || '（尚无历史）',
        user_input: userBundle,
    });
}

function resolveCustomEndpoint(baseUrl) {
    const raw = String(baseUrl || '').trim().replace(/\/$/, '');
    if (!raw) throw new Error('请填写 API Base URL');
    if (/\/chat\/completions\/?$/.test(raw)) return raw;
    if (/\/v1$/.test(raw)) return `${raw}/chat/completions`;
    return `${raw}/v1/chat/completions`;
}

async function generateViaCustomApi(prompt) {
    const s = getSettings();
    const url = resolveCustomEndpoint(s.apiUrl);
    const model = String(s.apiModel || '').trim();
    if (!model) throw new Error('请填写 Model');
    if (!String(s.apiKey || '').trim()) throw new Error('请填写 API Key');

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${s.apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: '你是短信回复器。只输出 XML 消息标签。' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.9,
            max_tokens: 700,
        }),
    });
    if (!res.ok) {
        throw new Error(`自定义 API ${res.status}: ${truncate(await res.text().catch(() => ''), 160)}`);
    }
    const data = await res.json();
    return String(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '').trim();
}

async function generateViaSt(prompt) {
    const ctx = getContext();
    if (typeof ctx.generateQuietPrompt === 'function') {
        return await ctx.generateQuietPrompt({
            quietPrompt: prompt,
            quietToLoud: false,
            skipWIAN: false,
        });
    }
    if (typeof ctx.generateRaw === 'function') {
        return await ctx.generateRaw({ prompt, instructOverride: true });
    }
    throw new Error('当前酒馆未提供生成接口');
}

async function maybeSyncMainChat(role, text) {
    if (!getSettings().syncMainChat) return;
    const ctx = getContext();
    const name = role === 'user' ? (ctx.name1 || 'User') : (getActiveCharacter()?.name || '角色');
    if (typeof ctx.addOneMessage === 'function') {
        await ctx.addOneMessage({
            name,
            is_user: role === 'user',
            is_system: false,
            send_date: Date.now(),
            mes: `[小手机] ${text}`,
        });
    }
}

async function requestModelReply() {
    if (isGenerating) return;
    const ch = getActiveCharacter();
    if (!ch) {
        toastr?.warning?.('请先选择角色并进入对话');
        return;
    }
    if (boundCharacterKey !== ch.key) loadThread();

    // If textarea has text, treat it as one more pending bubble first
    const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pocket-phone-input'));
    const draft = (input?.value || '').trim();
    if (draft) {
        activeThread.push({ role: 'user', text: draft, ts: Date.now(), pending: true });
        if (input) input.value = '';
        persistThread();
        renderMessages();
    }

    const pending = collectPendingUserTexts();
    if (!pending.length) {
        toastr?.info?.('请先用「发送气泡」加入至少一条用户消息');
        return;
    }

    const addBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('pocket-phone-add'));
    const replyBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('pocket-phone-reply'));
    isGenerating = true;
    if (addBtn) addBtn.disabled = true;
    if (replyBtn) replyBtn.disabled = true;

    try {
        const userBundle = pending.map((t, i) => `${i + 1}. ${t}`).join('\n');
        const prompt = buildGenerationPrompt(userBundle);
        const settings = getSettings();
        const raw = settings.apiMode === 'custom'
            ? await generateViaCustomApi(prompt)
            : await generateViaSt(prompt);

        const bubbles = parsePhoneReply(raw);
        if (!bubbles.length) throw new Error('模型未返回可解析的 <msg> 内容');

        clearPendingFlags();
        for (const b of bubbles) {
            activeThread.push({ role: b.role, text: b.text, ts: Date.now() });
            await maybeSyncMainChat(b.role === 'user' ? 'user' : 'char', b.text);
        }
        persistThread();
        renderMessages();
    } catch (err) {
        console.error('[st-pocket-phone] reply failed', err);
        activeThread.push({
            role: 'meta',
            text: `请求回复失败：${err?.message || err}`,
            ts: Date.now(),
        });
        persistThread();
        renderMessages();
        toastr?.error?.('小手机请求回复失败');
    } finally {
        isGenerating = false;
        if (addBtn) addBtn.disabled = false;
        if (replyBtn) replyBtn.disabled = false;
    }
}

function importCurrentTavernApi({ preferStMode = true } = {}) {
    const ctx = getContext();
    const oai = ctx.chatCompletionSettings || {};
    const settings = getSettings();
    if (preferStMode) settings.apiMode = 'st';

    const source = oai.chat_completion_source || '';
    let url = '';
    if (source === 'custom' && oai.custom_url) url = oai.custom_url;
    else if (oai.reverse_proxy) url = oai.reverse_proxy;
    else if (oai.custom_url) url = oai.custom_url;

    let model = '';
    try {
        model = typeof ctx.getChatCompletionModel === 'function'
            ? (ctx.getChatCompletionModel() || '')
            : (oai.openai_model || oai.custom_model || '');
    } catch {
        model = oai.openai_model || oai.custom_model || '';
    }

    if (url) settings.apiUrl = String(url);
    if (model) settings.apiModel = String(model);
    settings.apiHint = `已接入酒馆连接（${source || ctx.mainApi || 'current'} / ${model || 'default'}）。自定义模式请自行粘贴 Key。`;
    saveSettingsDebounced();
    updateExtSettingsHint();
    updateHeader();
}

function syncInlineApiForm() {
    const s = getSettings();
    const st = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="pp_inline_api_mode"][value="st"]'));
    const custom = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="pp_inline_api_mode"][value="custom"]'));
    if (st) st.checked = s.apiMode !== 'custom';
    if (custom) custom.checked = s.apiMode === 'custom';
    const url = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-inline-api-url'));
    const key = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-inline-api-key'));
    const model = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-inline-api-model'));
    const hint = document.getElementById('pp-inline-hint');
    if (url) url.value = s.apiUrl || '';
    if (key) key.value = s.apiKey || '';
    if (model) model.value = s.apiModel || '';
    if (hint) {
        hint.textContent = s.apiMode === 'st'
            ? `当前：酒馆聊天 API。${s.apiHint || '一键接入后可直接请求回复，无需填 Key。'}`
            : `当前：自定义 API。请确认 URL / Key / Model。`;
    }
}

function saveInlineApiForm() {
    const s = getSettings();
    const modeEl = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="pp_inline_api_mode"]:checked'));
    s.apiMode = modeEl?.value === 'custom' ? 'custom' : 'st';
    s.apiUrl = /** @type {HTMLInputElement} */ (document.getElementById('pp-inline-api-url'))?.value?.trim() || '';
    s.apiKey = /** @type {HTMLInputElement} */ (document.getElementById('pp-inline-api-key'))?.value?.trim() || '';
    s.apiModel = /** @type {HTMLInputElement} */ (document.getElementById('pp-inline-api-model'))?.value?.trim() || '';
    saveSettingsDebounced();
    syncInlineApiForm();
    updateHeader();
    updateExtSettingsForm();
}

function syncPresetEditor() {
    const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-preset-editor'));
    if (ta) ta.value = getSettings().presetPrompt || FALLBACK_PRESET;
}

function updateExtSettingsHint() {
    const hint = document.getElementById('pocket_phone_api_hint');
    const s = getSettings();
    if (hint) {
        hint.textContent = s.apiMode === 'st'
            ? `模式：酒馆当前 API。${s.apiHint || ''}`
            : `模式：自定义 API（${s.apiModel || '未填模型'}）。`;
    }
}

function updateExtSettingsForm() {
    const s = getSettings();
    const enabled = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_enabled'));
    const sync = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_sync_main'));
    const showFab = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_show_fab'));
    const modeSt = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_mode_st'));
    const modeCustom = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_mode_custom'));
    const url = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_url'));
    const key = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_key'));
    const model = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_model'));
    if (enabled) enabled.checked = !!s.enabled;
    if (sync) sync.checked = !!s.syncMainChat;
    if (showFab) showFab.checked = !!s.showFab;
    if (modeSt) modeSt.checked = s.apiMode !== 'custom';
    if (modeCustom) modeCustom.checked = s.apiMode === 'custom';
    if (url) url.value = s.apiUrl || '';
    if (key) key.value = s.apiKey || '';
    if (model) model.value = s.apiModel || '';
    updateExtSettingsHint();
}

function bindSettingsUi() {
    updateExtSettingsForm();
    document.getElementById('pocket_phone_enabled')?.addEventListener('input', e => {
        getSettings().enabled = Boolean(/** @type {HTMLInputElement} */ (e.target).checked);
        saveSettingsDebounced();
        refreshFab();
    });
    document.getElementById('pocket_phone_sync_main')?.addEventListener('input', e => {
        getSettings().syncMainChat = Boolean(/** @type {HTMLInputElement} */ (e.target).checked);
        saveSettingsDebounced();
    });
    document.getElementById('pocket_phone_show_fab')?.addEventListener('input', e => {
        getSettings().showFab = Boolean(/** @type {HTMLInputElement} */ (e.target).checked);
        saveSettingsDebounced();
        refreshFab();
    });
    document.querySelectorAll('input[name="pocket_phone_api_mode"]').forEach(el => {
        el.addEventListener('change', () => {
            getSettings().apiMode = /** @type {HTMLInputElement} */ (el).value === 'custom' ? 'custom' : 'st';
            saveSettingsDebounced();
            updateExtSettingsHint();
            updateHeader();
        });
    });
    const bindField = (id, key) => {
        document.getElementById(id)?.addEventListener('change', e => {
            getSettings()[key] = /** @type {HTMLInputElement} */ (e.target).value.trim();
            saveSettingsDebounced();
        });
    };
    bindField('pocket_phone_api_url', 'apiUrl');
    bindField('pocket_phone_api_key', 'apiKey');
    bindField('pocket_phone_api_model', 'apiModel');
    document.getElementById('pocket_phone_import_st_api')?.addEventListener('click', () => {
        importCurrentTavernApi({ preferStMode: true });
        updateExtSettingsForm();
        toastr?.success?.('已一键接入酒馆正在使用的 API');
    });
    document.getElementById('pocket_phone_open_from_settings')?.addEventListener('click', () => openPhone('sms'));
}

function onChatContextChanged() {
    refreshFab();
    const root = document.getElementById('pocket-phone-root');
    if (root?.classList.contains('pocket-phone-open')) {
        const ch = getActiveCharacter();
        if (!ch) {
            closePhone();
            return;
        }
        if (ch.key !== boundCharacterKey) {
            loadThread();
            refreshSmsUi();
            showView('sms');
        } else {
            updateHeader();
        }
    }
}

jQuery(async () => {
    getSettings();
    await ensureDefaultPreset();
    try {
        const settingsHtml = await $.get(`${EXTENSION_FOLDER}/settings.html`);
        $('#extensions_settings2').append(settingsHtml);
        bindSettingsUi();
    } catch (err) {
        console.warn('[st-pocket-phone] settings panel load failed', err);
    }

    injectOptionsMenuEntry();
    refreshFab();

    const events = [
        event_types.CHAT_CHANGED,
        event_types.CHARACTER_EDITED,
        event_types.CHARACTER_PAGE_LOADED,
    ].filter(Boolean);
    for (const ev of events) {
        eventSource.on(ev, () => onChatContextChanged());
    }
});
