/**
 * Pocket Phone — SillyTavern UI extension
 * Character-bound SMS + ST/custom API + LINE-like light H5 panel
 */
import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

const MODULE_NAME = 'st-pocket-phone';
const EXTENSION_FOLDER = `scripts/extensions/third-party/${MODULE_NAME}`;

const defaultSettings = Object.freeze({
    enabled: true,
    syncMainChat: false,
    apiMode: 'st', // 'st' | 'custom'
    apiUrl: '',
    apiKey: '',
    apiModel: '',
    threads: {},
});

/** @type {{ role: 'user' | 'char' | 'meta', text: string, ts: number }[]} */
let activeThread = [];
let isGenerating = false;
let boundCharacterKey = '';

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
    if (id == null || !ctx.characters?.[id]) {
        return null;
    }
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
        firstMes: ch.first_mes || '',
    };
}

function threadKey() {
    return getActiveCharacter()?.key || 'char:unknown';
}

function loadThread() {
    const settings = getSettings();
    const key = threadKey();
    boundCharacterKey = key;
    if (!settings.threads[key]) {
        settings.threads[key] = [];
    }
    activeThread = settings.threads[key];
}

function persistThread() {
    const settings = getSettings();
    settings.threads[threadKey()] = activeThread;
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
    const s = getSettings();
    return s.apiMode === 'custom' ? '自定义 API' : '酒馆当前 API';
}

function ensureUi() {
    if (document.getElementById('pocket-phone-root')) {
        return;
    }

    const fab = document.createElement('button');
    fab.id = 'pocket-phone-fab';
    fab.type = 'button';
    fab.title = '打开小手机短信';
    fab.innerHTML = '<i class="fa-solid fa-comment-dots"></i>';
    fab.addEventListener('click', () => openPhone());
    document.body.appendChild(fab);

    const root = document.createElement('div');
    root.id = 'pocket-phone-root';
    // Mount on body to avoid ST transformed ancestors collapsing fixed layers
    root.innerHTML = `
        <div class="pocket-phone-backdrop" data-pocket-close="1"></div>
        <div class="pocket-phone-device" role="dialog" aria-label="Pocket Phone">
            <div class="pocket-phone-screen">
                <div class="pocket-phone-topbar">
                    <button type="button" class="pp-back" data-nav="back" title="返回">
                        <i class="fa-solid fa-chevron-left"></i>
                    </button>
                    <img class="pocket-phone-avatar" id="pocket-phone-avatar" alt="" />
                    <div class="pocket-phone-top-meta">
                        <div class="name" id="pocket-phone-title">小手机</div>
                        <div class="sub" id="pocket-phone-subtitle">未选择角色</div>
                    </div>
                    <button type="button" class="pp-settings-btn" data-nav="settings" title="API 设置">
                        <i class="fa-solid fa-gear"></i>
                    </button>
                </div>

                <div class="pocket-phone-view active pocket-phone-home" data-view="home">
                    <div class="pocket-phone-hero">
                        <h2 id="pocket-phone-hero-name">角色短信</h2>
                        <p id="pocket-phone-hero-desc">与当前对话角色绑定的手机短信。上下文会跟随该角色人设。</p>
                    </div>
                    <div class="pocket-phone-home-grid">
                        <button type="button" class="pocket-phone-app-icon" data-open-app="sms">
                            <div class="icon-tile"><i class="fa-solid fa-comment"></i></div>
                            <span>短信</span>
                        </button>
                        <button type="button" class="pocket-phone-app-icon" data-open-app="settings">
                            <div class="icon-tile" style="background:linear-gradient(145deg,#ff8fb5,#ff5c9a)">
                                <i class="fa-solid fa-plug"></i>
                            </div>
                            <span>API</span>
                        </button>
                    </div>
                </div>

                <div class="pocket-phone-view" data-view="sms">
                    <div class="pocket-phone-messages" id="pocket-phone-messages"></div>
                    <div class="pocket-phone-composer">
                        <textarea id="pocket-phone-input" rows="1" placeholder="输入消息…"></textarea>
                        <button type="button" id="pocket-phone-send">发送</button>
                    </div>
                </div>

                <div class="pocket-phone-view pocket-phone-settings-panel" data-view="settings">
                    <div class="pp-mode-row">
                        <label><input type="radio" name="pp_inline_api_mode" value="st" /> 使用酒馆当前聊天 API</label>
                        <label><input type="radio" name="pp_inline_api_mode" value="custom" /> 使用自定义 API</label>
                    </div>
                    <button type="button" class="pp-primary-btn" id="pp-inline-import-st">一键接入正在使用的 API</button>
                    <div id="pp-inline-hint" style="font-size:12px;color:#8b93a1;margin-top:6px;"></div>
                    <label>API Base URL</label>
                    <input id="pp-inline-api-url" type="text" placeholder="https://api.openai.com/v1" />
                    <label>API Key</label>
                    <input id="pp-inline-api-key" type="password" placeholder="sk-..." autocomplete="off" />
                    <label>Model</label>
                    <input id="pp-inline-api-model" type="text" placeholder="模型名" />
                    <button type="button" class="pp-secondary-btn" id="pp-inline-save">保存 API 设置</button>
                </div>
            </div>
        </div>
    `;
    document.documentElement.appendChild(root);

    root.querySelector('.pocket-phone-backdrop')?.addEventListener('click', () => closePhone());
    root.querySelector('[data-nav="back"]')?.addEventListener('click', () => {
        const sms = root.querySelector('[data-view="sms"]');
        const settings = root.querySelector('[data-view="settings"]');
        if (sms?.classList.contains('active') || settings?.classList.contains('active')) {
            showView('home');
        } else {
            closePhone();
        }
    });
    root.querySelector('[data-nav="settings"]')?.addEventListener('click', () => {
        showView('settings');
        syncInlineApiForm();
    });
    root.querySelector('[data-open-app="sms"]')?.addEventListener('click', () => {
        showView('sms');
        refreshSmsUi();
    });
    root.querySelector('[data-open-app="settings"]')?.addEventListener('click', () => {
        showView('settings');
        syncInlineApiForm();
    });
    root.querySelector('#pocket-phone-send')?.addEventListener('click', () => void sendSms());
    root.querySelector('#pocket-phone-input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void sendSms();
        }
    });
    root.querySelector('#pp-inline-import-st')?.addEventListener('click', () => {
        importCurrentTavernApi({ preferStMode: true });
        syncInlineApiForm();
        toastr?.success?.('已一键接入酒馆正在使用的 API');
    });
    root.querySelector('#pp-inline-save')?.addEventListener('click', () => {
        saveInlineApiForm();
        toastr?.success?.('小手机 API 设置已保存');
    });
    root.querySelectorAll('input[name="pp_inline_api_mode"]').forEach(el => {
        el.addEventListener('change', () => {
            getSettings().apiMode = /** @type {HTMLInputElement} */ (el).value === 'custom' ? 'custom' : 'st';
            saveSettingsDebounced();
            updateHeader();
        });
    });
}

function showView(name) {
    document.querySelectorAll('#pocket-phone-root .pocket-phone-view').forEach(view => {
        view.classList.toggle('active', view.getAttribute('data-view') === name);
    });
}

function updateHeader() {
    const ch = getActiveCharacter();
    const title = document.getElementById('pocket-phone-title');
    const sub = document.getElementById('pocket-phone-subtitle');
    const heroName = document.getElementById('pocket-phone-hero-name');
    const heroDesc = document.getElementById('pocket-phone-hero-desc');
    const avatar = /** @type {HTMLImageElement|null} */ (document.getElementById('pocket-phone-avatar'));

    if (!ch) {
        if (title) title.textContent = '小手机';
        if (sub) sub.textContent = '请先打开角色对话';
        if (heroName) heroName.textContent = '未绑定角色';
        if (heroDesc) heroDesc.textContent = '请在酒馆中选择角色并进入对话后再使用。';
        if (avatar) avatar.removeAttribute('src');
        return;
    }

    if (title) title.textContent = ch.name;
    if (sub) sub.textContent = `${apiModeLabel()} · 角色绑定`;
    if (heroName) heroName.textContent = `${ch.name} 的短信`;
    if (heroDesc) {
        heroDesc.textContent = truncate(ch.description || ch.personality || '短信上下文已与当前角色人设绑定。', 120);
    }
    if (avatar) {
        if (ch.avatarUrl) {
            avatar.src = ch.avatarUrl;
            avatar.style.display = '';
        } else {
            avatar.removeAttribute('src');
        }
    }
}

function refreshSmsUi() {
    loadThread();
    updateHeader();
    renderMessages();
}

function openPhone() {
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
    loadThread();
    showView('home');
    updateHeader();
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
    const show = !!settings.enabled && !!ch;
    fab?.classList.toggle('pocket-phone-hidden', !show);
}

function renderMessages() {
    const box = document.getElementById('pocket-phone-messages');
    if (!box) return;
    const ch = getActiveCharacter();
    if (!activeThread.length) {
        box.innerHTML = `<div class="pocket-phone-bubble meta">和「${escapeHtml(ch?.name || '角色')}」的专属短信还是空的，发一条试试。</div>`;
        return;
    }
    box.innerHTML = activeThread
        .map(m => `<div class="pocket-phone-bubble ${m.role}">${escapeHtml(m.text)}</div>`)
        .join('');
    box.scrollTop = box.scrollHeight;
}

function buildSmsPrompt(userText) {
    const ch = getActiveCharacter();
    const name = ch?.name || '角色';
    const history = activeThread
        .filter(m => m.role === 'user' || m.role === 'char')
        .slice(-16)
        .map(m => `${m.role === 'user' ? 'User' : name}: ${m.text}`)
        .join('\n');

    return [
        `你正在扮演角色「${name}」，通过手机短信（类似 LINE）回复 User。`,
        '只输出一条短信正文：口语、短句、有情绪；不要旁白、不要引号、不要角色名前缀。',
        ch?.description ? `角色设定：${truncate(ch.description, 800)}` : '',
        ch?.personality ? `性格：${truncate(ch.personality, 400)}` : '',
        ch?.scenario ? `场景：${truncate(ch.scenario, 400)}` : '',
        history ? `最近短信：\n${history}` : '（尚无历史短信）',
        `User：${userText}`,
        `${name}：`,
    ].filter(Boolean).join('\n\n');
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

    const ch = getActiveCharacter();
    const messages = [
        {
            role: 'system',
            content: `你是角色「${ch?.name || '角色'}」的短信回复器。严格按角色设定用短短信回复。`,
        },
        { role: 'user', content: prompt },
    ];

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${s.apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages,
            temperature: 0.85,
            max_tokens: 400,
        }),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`自定义 API ${res.status}: ${truncate(errText, 180)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content
        || data?.choices?.[0]?.text
        || '';
    return String(text || '').trim();
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
    const settings = getSettings();
    if (!settings.syncMainChat) return;
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

async function sendSms() {
    if (isGenerating) return;
    const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pocket-phone-input'));
    const sendBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('pocket-phone-send'));
    const text = (input?.value || '').trim();
    if (!text) return;

    const ch = getActiveCharacter();
    if (!ch) {
        toastr?.warning?.('请先选择角色并进入对话');
        return;
    }

    // Re-bind if user switched character while phone open
    if (boundCharacterKey !== ch.key) {
        loadThread();
    }

    activeThread.push({ role: 'user', text, ts: Date.now() });
    persistThread();
    if (input) input.value = '';
    renderMessages();
    await maybeSyncMainChat('user', text);

    isGenerating = true;
    if (sendBtn) sendBtn.disabled = true;

    try {
        const prompt = buildSmsPrompt(text);
        const settings = getSettings();
        let reply = settings.apiMode === 'custom'
            ? await generateViaCustomApi(prompt)
            : await generateViaSt(prompt);

        reply = String(reply || '').trim().replace(/^["「]|["」]$/g, '');
        if (!reply) reply = '……';

        activeThread.push({ role: 'char', text: reply, ts: Date.now() });
        persistThread();
        renderMessages();
        await maybeSyncMainChat('char', reply);
    } catch (err) {
        console.error('[st-pocket-phone] send failed', err);
        activeThread.push({
            role: 'meta',
            text: `发送失败：${err?.message || err}`,
            ts: Date.now(),
        });
        persistThread();
        renderMessages();
        toastr?.error?.('小手机发送失败');
    } finally {
        isGenerating = false;
        if (sendBtn) sendBtn.disabled = false;
    }
}

/**
 * One-click: bind phone to current SillyTavern chat API.
 * Prefills custom fields from oai_settings when possible; sets mode to st by default.
 */
function importCurrentTavernApi({ preferStMode = true } = {}) {
    const ctx = getContext();
    const oai = ctx.chatCompletionSettings || {};
    const settings = getSettings();

    if (preferStMode) {
        settings.apiMode = 'st';
    }

    const source = oai.chat_completion_source || '';
    let url = '';
    if (source === 'custom' && oai.custom_url) {
        url = oai.custom_url;
    } else if (oai.reverse_proxy) {
        url = oai.reverse_proxy;
    } else if (oai.custom_url) {
        url = oai.custom_url;
    }

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
    // Key 通常由酒馆密钥库保管，一键接入酒馆模式无需复制明文 Key
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
            ? `当前：酒馆聊天 API。${s.apiHint || '一键接入后可直接发短信，无需填 Key。'}`
            : `当前：自定义 API。请确认 URL / Key / Model。${s.apiHint || ''}`;
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
    const modeSt = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_mode_st'));
    const modeCustom = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_mode_custom'));
    const url = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_url'));
    const key = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_key'));
    const model = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_model'));
    if (enabled) enabled.checked = !!s.enabled;
    if (sync) sync.checked = !!s.syncMainChat;
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
    document.getElementById('pocket_phone_open_from_settings')?.addEventListener('click', () => openPhone());
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
            showView('home');
        } else {
            updateHeader();
        }
    }
}

jQuery(async () => {
    getSettings();
    try {
        const settingsHtml = await $.get(`${EXTENSION_FOLDER}/settings.html`);
        $('#extensions_settings2').append(settingsHtml);
        bindSettingsUi();
    } catch (err) {
        console.warn('[st-pocket-phone] settings panel load failed', err);
    }

    refreshFab();

    const events = [
        event_types.CHAT_CHANGED,
        event_types.CHARACTER_EDITED,
        event_types.CHARACTER_PAGE_LOADED,
        event_types.GROUP_UPDATED,
    ].filter(Boolean);

    for (const ev of events) {
        eventSource.on(ev, () => onChatContextChanged());
    }
});
