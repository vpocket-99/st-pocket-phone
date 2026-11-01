/**
 * Pocket Phone — SillyTavern third-party UI extension (MVP)
 * Floating phone shell + SMS app. Does not inject complex HTML into chat bubbles.
 */
import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'st-pocket-phone';
const EXTENSION_FOLDER = `scripts/extensions/third-party/${MODULE_NAME}`;

const defaultSettings = Object.freeze({
    enabled: true,
    syncMainChat: false,
    threads: {},
});

/** @type {{ role: 'user' | 'char' | 'meta', text: string, ts: number }[]} */
let activeThread = [];
let isGenerating = false;

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

function threadKey() {
    const ctx = getContext();
    if (ctx.groupId) {
        return `group:${ctx.groupId}`;
    }
    const id = ctx.characterId;
    const ch = id != null ? ctx.characters?.[id] : null;
    const avatar = ch?.avatar || 'unknown';
    return `char:${avatar}`;
}

function loadThread() {
    const settings = getSettings();
    const key = threadKey();
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

function currentCharacterName() {
    const ctx = getContext();
    if (ctx.groupId) {
        const group = ctx.groups?.find?.(g => g.id === ctx.groupId);
        return group?.name || '群聊';
    }
    const id = ctx.characterId;
    const ch = id != null ? ctx.characters?.[id] : null;
    return ch?.name || '角色';
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatClock() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ensureUi() {
    if (document.getElementById('pocket-phone-root')) {
        return;
    }

    const fab = document.createElement('button');
    fab.id = 'pocket-phone-fab';
    fab.type = 'button';
    fab.title = '打开 Pocket Phone 小手机';
    fab.innerHTML = '<i class="fa-solid fa-mobile-screen-button"></i>';
    fab.addEventListener('click', () => openPhone());
    document.body.appendChild(fab);

    const root = document.createElement('div');
    root.id = 'pocket-phone-root';
    root.innerHTML = `
        <div class="pocket-phone-backdrop" data-pocket-close="1"></div>
        <div class="pocket-phone-device" role="dialog" aria-label="Pocket Phone">
            <div class="pocket-phone-notch"></div>
            <div class="pocket-phone-screen">
                <div class="pocket-phone-statusbar">
                    <span class="pocket-phone-clock">${formatClock()}</span>
                    <span>LTE · 100%</span>
                </div>
                <div class="pocket-phone-view active" data-view="home">
                    <div class="pocket-phone-home-grid">
                        <button type="button" class="pocket-phone-app-icon" data-open-app="sms">
                            <div class="icon-tile"><i class="fa-solid fa-comment-sms"></i></div>
                            <span>短信</span>
                        </button>
                    </div>
                </div>
                <div class="pocket-phone-view" data-view="sms">
                    <div class="pocket-phone-app-header">
                        <button type="button" data-go-home="1" title="返回桌面">
                            <i class="fa-solid fa-chevron-left"></i>
                        </button>
                        <div class="title" id="pocket-phone-sms-title">短信</div>
                    </div>
                    <div class="pocket-phone-messages" id="pocket-phone-messages"></div>
                    <div class="pocket-phone-composer">
                        <textarea id="pocket-phone-input" rows="1" placeholder="输入短信…"></textarea>
                        <button type="button" id="pocket-phone-send">发送</button>
                    </div>
                </div>
                <div class="pocket-phone-home-bar">
                    <button type="button" data-go-home="1" title="Home"></button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(root);

    root.querySelector('.pocket-phone-backdrop')?.addEventListener('click', () => closePhone());
    root.querySelectorAll('[data-go-home]').forEach(el => {
        el.addEventListener('click', () => showView('home'));
    });
    root.querySelector('[data-open-app="sms"]')?.addEventListener('click', () => {
        showView('sms');
        refreshSms();
    });
    root.querySelector('#pocket-phone-send')?.addEventListener('click', () => void sendSms());
    root.querySelector('#pocket-phone-input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void sendSms();
        }
    });

    setInterval(() => {
        const clock = document.querySelector('.pocket-phone-clock');
        if (clock) {
            clock.textContent = formatClock();
        }
    }, 30_000);
}

function showView(name) {
    document.querySelectorAll('#pocket-phone-root .pocket-phone-view').forEach(view => {
        view.classList.toggle('active', view.getAttribute('data-view') === name);
    });
}

function openPhone() {
    const settings = getSettings();
    if (!settings.enabled) {
        toastr?.warning?.('小手机已在设置中关闭');
        return;
    }
    ensureUi();
    loadThread();
    showView('home');
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
    fab?.classList.toggle('pocket-phone-hidden', !settings.enabled);
}

function renderMessages() {
    const box = document.getElementById('pocket-phone-messages');
    if (!box) {
        return;
    }
    if (!activeThread.length) {
        box.innerHTML = `<div class="pocket-phone-bubble meta">还没有短信。跟「${escapeHtml(currentCharacterName())}」发一条吧。</div>`;
        return;
    }
    box.innerHTML = activeThread
        .map(m => `<div class="pocket-phone-bubble ${m.role}">${escapeHtml(m.text)}</div>`)
        .join('');
    box.scrollTop = box.scrollHeight;
}

function refreshSms() {
    loadThread();
    const title = document.getElementById('pocket-phone-sms-title');
    if (title) {
        title.textContent = currentCharacterName();
    }
    renderMessages();
}

async function maybeSyncMainChat(role, text) {
    const settings = getSettings();
    if (!settings.syncMainChat) {
        return;
    }
    const ctx = getContext();
    const name = role === 'user' ? (ctx.name1 || 'User') : currentCharacterName();
    const isUser = role === 'user';
    // Best-effort: append a plain chat message if API exists on context
    if (typeof ctx.addOneMessage === 'function') {
        await ctx.addOneMessage({
            name,
            is_user: isUser,
            is_system: false,
            send_date: Date.now(),
            mes: `[小手机短信] ${text}`,
        });
        return;
    }
    // Fallback: surface a toast so user knows sync is incomplete on this ST version
    toastr?.info?.('已开启同步，但当前酒馆版本未暴露 addOneMessage；短信仅保存在小手机内。');
}

function buildSmsPrompt(userText) {
    const name = currentCharacterName();
    const history = activeThread
        .filter(m => m.role === 'user' || m.role === 'char')
        .slice(-12)
        .map(m => `${m.role === 'user' ? 'User' : name}: ${m.text}`)
        .join('\n');

    return [
        `你正在以角色「${name}」的身份通过手机短信回复。`,
        '要求：只输出一条短信正文；口语化、短句；不要旁白、不要引号、不要角色名冒号前缀。',
        history ? `最近短信记录：\n${history}` : '（尚无历史短信）',
        `User 刚发送：${userText}`,
        `${name} 的短信回复：`,
    ].join('\n\n');
}

async function sendSms() {
    if (isGenerating) {
        return;
    }
    const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pocket-phone-input'));
    const sendBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('pocket-phone-send'));
    const text = (input?.value || '').trim();
    if (!text) {
        return;
    }

    const ctx = getContext();
    if (ctx.characterId == null && !ctx.groupId) {
        toastr?.warning?.('请先选择一个角色或群聊');
        return;
    }

    activeThread.push({ role: 'user', text, ts: Date.now() });
    persistThread();
    if (input) {
        input.value = '';
    }
    renderMessages();
    await maybeSyncMainChat('user', text);

    isGenerating = true;
    if (sendBtn) {
        sendBtn.disabled = true;
    }

    try {
        const prompt = buildSmsPrompt(text);
        let reply = '';
        if (typeof ctx.generateQuietPrompt === 'function') {
            reply = await ctx.generateQuietPrompt({
                quietPrompt: prompt,
                quietToLoud: false,
                skipWIAN: true,
            });
        } else if (typeof ctx.generateRaw === 'function') {
            reply = await ctx.generateRaw({ prompt, instructOverride: true });
        } else {
            throw new Error('当前酒馆上下文未提供 generateQuietPrompt / generateRaw');
        }

        reply = String(reply || '')
            .trim()
            .replace(/^["「]|["」]$/g, '');
        if (!reply) {
            reply = '……';
        }

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
        toastr?.error?.('小手机短信生成失败，请查看控制台');
    } finally {
        isGenerating = false;
        if (sendBtn) {
            sendBtn.disabled = false;
        }
    }
}

function bindSettingsUi() {
    const settings = getSettings();
    const enabled = document.getElementById('pocket_phone_enabled');
    const sync = document.getElementById('pocket_phone_sync_main');
    const openBtn = document.getElementById('pocket_phone_open_from_settings');

    if (enabled) {
        enabled.checked = !!settings.enabled;
        enabled.addEventListener('input', () => {
            getSettings().enabled = Boolean(enabled.checked);
            saveSettingsDebounced();
            refreshFab();
        });
    }
    if (sync) {
        sync.checked = !!settings.syncMainChat;
        sync.addEventListener('input', () => {
            getSettings().syncMainChat = Boolean(sync.checked);
            saveSettingsDebounced();
        });
    }
    openBtn?.addEventListener('click', () => openPhone());
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
});
