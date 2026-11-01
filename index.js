/**
 * Pocket Phone — character-bound SMS for SillyTavern
 * Options-menu entry · fullscreen H5 · dual send · multi <msg> replies · editable preset
 */
import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, saveSettings, eventSource, event_types } from '../../../../script.js';
import { promptManager, createGenerationParameters, getChatCompletionModel, getStreamingReply, model_list as stModelList, proxies as stProxies } from '../../../openai.js';
import { power_user } from '../../../power-user.js';
import { setUserAvatar, user_avatar, getUserAvatar } from '../../../personas.js';

const MODULE_NAME = 'st-pocket-phone';
const EXTENSION_FOLDER = `scripts/extensions/third-party/${MODULE_NAME}`;
/** 升级 UI 结构时递增，确保旧 DOM 被重建 */
const PP_UI_VERSION = '34';
const PP_EXPORT_VERSION = 1;
/** 导入/压缩触发阈值默认值（可在总结记忆页改） */
const DEFAULT_MEMORY_TOKEN_LIMIT = 10000;
/**
 * 小手机预设池名前缀：从主库拉「A」时生成独立副本「📱 A」，
 * 编辑副本不影响外面同名预设 A。
 */
const PP_PHONE_PRESET_PREFIX = '📱 ';

/** AIRP 向：聚焦情感互动与有趣梗的默认压缩提示词 */
const DEFAULT_MEMORY_SUMMARY_PROMPT = `你是 AIRP / 情感向角色扮演的记忆编辑。请将「手机短信记录」压缩为可继续扮演的长期记忆摘要。

优先保留：
- 情感节奏与关系变化（暧昧、别扭、吃醋、心动、和解等）
- 两人之间的有趣梗、暗号、口头禅、内部笑话
- 关键约定、未兑现承诺、悬念钩子
- 对后续互动有用的性格/边界线索

刻意淡化：寒暄废话、重复确认、纯行程流水账（除非影响剧情）。

写法：中文短散文，200～500 字；不要条目堆砌；不要复述整段聊天。
只输出摘要正文。`;

/** 官方音色服务（默认 URL / 模型列表） */
const BUILTIN_VOICE_PROVIDERS = Object.freeze({
    minimax: Object.freeze({
        id: 'minimax',
        name: 'MiniMax',
        url: 'https://api.minimax.io',
        models: Object.freeze([
            'speech-2.8-hd',
            'speech-2.8-turbo',
            'speech-2.6-hd',
            'speech-2.6-turbo',
            'speech-02-hd',
            'speech-02-turbo',
            'speech-01-hd',
            'speech-01-turbo',
        ]),
        defaultModel: 'speech-2.8-hd',
        family: 'minimax',
    }),
    elevenlabs: Object.freeze({
        id: 'elevenlabs',
        name: 'ElevenLabs',
        url: 'https://api.elevenlabs.io',
        models: Object.freeze([
            'eleven_v4',
            'eleven_v4_turbo',
            'eleven_v3',
            'eleven_multilingual_v2',
            'eleven_turbo_v2_5',
            'eleven_flash_v2_5',
        ]),
        defaultModel: 'eleven_v4',
        family: 'elevenlabs',
    }),
});

/**
 * 发给对话模型的「语音条写法」默认提示词（按厂商+模型族）
 * 依据官方：MiniMax T2A 圆括号语气词 / emotion；ElevenLabs v3/v4 Audio Tags。
 */
const DEFAULT_VOICE_TAG_PROMPTS = Object.freeze({
    'minimax:speech-2.8': `【语音条协议 · MiniMax speech-2.8】
低频使用语音：输出 <voice>…</voice>；单次最多 2 条；多数轮次不要用。
按 MiniMax T2A 官方规则写正文：
1) 句首可用方括号情绪（对应 voice_setting.emotion）：[happy] [sad] [angry] [fearful] [disgusted] [surprised] [calm] [fluent] [whisper]
2) 文中可插官方语气词（英文圆括号，仅 2.8 系列）：(laughs) (chuckle) (coughs) (clear-throat) (groans) (breath) (pant) (inhale) (exhale) (gasps) (sniffs) (sighs) (snorts) (burps) (lip-smacking) (humming) (hissing) (emm) (sneezes)
3) 停顿用 <#0.5#>（秒）
示例：<voice>[happy] 真的假的(laughs) <#0.3#> 我马上过去</voice>
禁止使用 ElevenLabs 的 [laughs]/[whispers] 这类方括号 Audio Tags。`,

    'minimax:default': `【语音条协议 · MiniMax】
低频使用：<voice>[情绪] 文本</voice>；单次最多 2 条。
情绪仅限官方枚举：happy / sad / angry / fearful / disgusted / surprised / calm / fluent / whisper
停顿可用 <#0.5#>。
示例：<voice>[sad] 算了… <#0.4#> 你先忙吧</voice>
不要用 ElevenLabs 方括号反应标签（如 [laughs] [sighs]）。`,

    'elevenlabs:v4': `【语音条协议 · ElevenLabs v4 / Audio Tags】
低频使用：<voice>…</voice>；单次最多 2 条；多数轮次不要用。
按 ElevenLabs 官方 Audio Tags（方括号）写表演提示，标签会被当成演绎指令而非朗读文字：
- 情绪/语气：[curious] [excited] [frustrated] [sorrowful] [calm] [mischievously]
- 演绎：[whispers] [shouts] [tired]
- 反应：[laughs] [sighs] [clears throat] [gasps]
- 停顿：[pause] [short pause] [long pause]
可组合：<voice>[tired][sighs] 今天好长啊… [pause] 你还在吗</voice>
不要改写成 MiniMax 的 (laughs) 圆括号语气词，也不要把情绪写成仅有的 [happy] 短枚举体系。`,

    'elevenlabs:v3': `【语音条协议 · ElevenLabs v3 / Audio Tags】
低频使用：<voice>…</voice>；单次最多 2 条。
使用方括号 Audio Tags（v3 不支持 SSML break）：[whispers] [laughs] [sighs] [excited] [worried] [pause] [short pause] [long pause] 等。
示例：<voice>[whispers] 其实… [pause] [laughs] 没事</voice>
不要用 MiniMax 圆括号语气词 (laughs)/(sighs)。`,

    'elevenlabs:default': `【语音条协议 · ElevenLabs】
低频使用：<voice>文本</voice>；单次最多 2 条。
若模型支持 Audio Tags，可在文中加方括号提示如 [whispers] [laughs]；否则保持干净口语文本。
不要使用 MiniMax 的 (laughs) 或 <#0.5#> 语法。`,

    custom: `【语音条协议 · 自定义 TTS】
低频使用：<voice>文本</voice>；单次最多 2 条。
按你所选第三方引擎的标签规则书写；若不确定，输出干净口语即可。`,
});

const FALLBACK_PRESET = `你正在扮演角色「{{char}}」，通过手机短信回复 User。
只输出闭合 XML 标签，标签外不要有任何文字。
普通短信用 <msg>文本</msg>，可连发多条。语音低频用 <voice>[happy] 内容</voice>。
口语短句，按人设决定 emoji/缩写。

角色设定：
{{char_description}}
{{char_personality}}
{{char_scenario}}

开场白：
{{char_first_mes}}

主聊天近期：
{{main_chat_history}}

最近短信：
{{sms_history}}

User 本轮消息：
{{user_input}}

开始发送：`;

const defaultSettings = Object.freeze({
    enabled: true,
    syncMainChat: true,
    showFab: false,
    apiMode: 'st',
    apiUrl: '',
    apiKey: '',
    apiModel: '',
    apiHint: '',
    presetPrompt: '',
    /** 小手机当前选用的预设名（优先为「📱 xxx」池内副本），只记在扩展设置里 */
    phonePresetName: '',
    /**
     * 进入小手机前主聊天正在用的预设名（A）。
     * 用于刷新/崩溃后把酒馆全局选中项掰回主聊天，避免和手机池串台。
     */
    outsidePresetName: '',
    /** true=曾经借用全局预设切到手机池，但还没干净还原 A（刷新中断等） */
    phoneSessionBorrowed: false,
    /** 小手机自有预设库存备份：name → 完整预设 JSON（扩展设置；主库另有 📱 副本文件） */
    phonePresets: {},
    /** 气泡颜色（短信页） */
    bubbleColors: {
        user: '#7ddec0',
        char: '#ffffff',
    },
    /** 按角色覆盖：头像 / 音色 ID */
    characterOverrides: {},
    /** 多语言：母语 + <i18n>中文翻译</i18n> */
    multilangEnabled: false,
    /** 气泡旁头像：none=都不显示，both=角色+用户都显示 */
    avatarDisplayMode: 'none',
    /** 小手机内自定义用户头像（可覆盖酒馆当前身份头像展示） */
    userAvatarDataUrl: '',
    /**
     * 多套 API 配置库
     * @type {{ id: string, name: string, apiMode: string, apiUrl: string, apiKey: string, apiModel: string, updatedAt: number }[]}
     */
    apiProfiles: [],
    /** 当前选中的配置库 id（仅 UI 记忆） */
    activeApiProfileId: '',
    /** 当前选中的酒馆反向代理预设名 */
    activeProxyPresetName: '',
    /**
     * 对话背景图库
     * @type {{ id: string, name: string, dataUrl: string, createdAt: number }[]}
     */
    backgroundLibrary: [],
    /** 当前启用的背景 id；空=默认 */
    activeBackgroundId: '',
    /** 生成时注入酒馆主聊天近期消息 + 开场白 */
    injectMainChatContext: true,
    /** 主聊天注入条数 */
    mainChatInjectCount: 12,
    /** 总结压缩提示词（空=用默认 AIRP 提示词） */
    memorySummaryPrompt: '',
    /** 超过该 token 才压缩；导入主对话时同阈值 */
    memoryTokenLimit: DEFAULT_MEMORY_TOKEN_LIMIT,
    /** 压缩模型：chat=跟随小手机对话 API；custom=独立接入 */
    memoryApiMode: 'chat',
    memoryApiUrl: '',
    memoryApiKey: '',
    memoryApiModel: '',
    /**
     * 音色服务
     * activeVoiceProviderId: minimax | elevenlabs | custom_*
     * voiceProviderConfigs: id → { key, model, url? }
     * voiceCustomProviders: [{ id, name, url, key, model, family }]
     * voicePromptOverrides: promptKey → 自定义提示词
     */
    activeVoiceProviderId: 'minimax',
    voiceProviderConfigs: {
        minimax: { key: '', model: 'speech-2.8-hd', url: 'https://api.minimax.io' },
        elevenlabs: { key: '', model: 'eleven_v4', url: 'https://api.elevenlabs.io' },
    },
    voiceCustomProviders: [],
    voicePromptOverrides: {},
    /** 小手机强制条目：输出格式 / 多语言 / 风格化（空=默认文案） */
    phoneFormatPrompt: '',
    phoneMultilangPrompt: '',
    phoneStylePrompt: '',
    /**
     * 旧版：charKey → messages[]
     * 新版并行：threadStore[charKey] = { activeId, threads: [{id,title,updatedAt,messages}] }
     */
    threads: {},
    threadStore: {},
    /**
     * 最近小手机角色列表元数据（软删除不删短信）
     * charKey → { nickname, pinned, hidden, lastAt, name, avatarUrl }
     */
    characterRoster: {},
});

/**
 * PromptManager 强制条目。
 * 注意：必须 system_prompt=false，否则酒馆只会注入 nsfw/jailbreak 两类 system，自定义 system 条目不会进模型。
 * 不可删除靠 isPromptDeletionAllowed / detach 钩子保证。
 */
const PP_PRESET_ENTRY = Object.freeze({
    format: 'pp_phone_format',
    style: 'pp_phone_style',
    voice: 'pp_phone_voice',
    multilang: 'pp_phone_multilang',
});

const PHONE_LANGUAGE_OPTIONS = Object.freeze([
    { id: 'en', label: '英语', native: 'English' },
    { id: 'ja', label: '日语', native: '日本語' },
    { id: 'ko', label: '韩语', native: '한국어' },
    { id: 'ru', label: '俄语', native: 'Русский' },
    { id: 'yue', label: '粤语', native: '粵語' },
    { id: 'fr', label: '法语', native: 'Français' },
    { id: 'de', label: '德语', native: 'Deutsch' },
    { id: 'es', label: '西班牙语', native: 'Español' },
]);

const DEFAULT_PHONE_FORMAT_PROMPT = [
    '[Output Format Instructions]',
    'Your output MUST and ONLY contain the chat messages sent by the other party.',
    '',
    '- **Bubble Constraint**: **Every independent message sent by the other party (text, abbreviations, emojis, etc.) MUST be strictly wrapped in `<msg>` and `</msg>`.**',
    '- **Pure Message Output**: It is strictly forbidden to include any narration, psychological activities, environmental descriptions, or explanatory text in the output. Directly output the pure text message bubbles.',
    '- **Consecutive Messages**: If sending multiple messages in a row, each message must be individually wrapped in a pair of `<msg></msg>` tags, with line breaks between different tags.',
    '- Language: English (incorporating common North American abbreviations and slang).',
    '',
    '[OUTPUT FORMAT]',
    'The final output must consist purely of messages wrapped in `<msg>` tags, without any leading explanations, concluding summaries, or extra blank lines.',
    '',
    'Example:',
    '<msg>are you seriously ghosting me rn?</msg>',
    '<msg>fine</msg>',
].join('\n');

const MULTILANG_PROMPT_HINT = `【小手机 · 多语言翻译】
目标语言变量 {{Language}} / {{.Language}} = 用户为当前角色选择的语言。
本轮请使用「{{Language}}」作为角色母语/回复语言：
- 先用该语言写台词，再附自然中文翻译方便中文读者
- 格式：<msg>{{Language}}台词 <i18n>中文翻译</i18n></msg>
- 可连发多条 <msg>；每条都可带自己的 <i18n>
- 若目标语言本身就是中文，可直接 <msg>中文</msg>，不必强行加 <i18n>
若 {{Language}} 为空，则不要强制双语。`.trim();

/** 📱 风格化：网感短信口吻（随 {{.Language}} 泛化；按人设判断网感/古板） */
const DEFAULT_PHONE_STYLE_PROMPT = [
    '<Style Guidelines>',
    'Target language: {{.Language}} / {{Language}}.',
    'First, briefly judge the character from persona: internet-native / chatty texter vs formal, old-fashioned, stiff, or official.',
    '- If internet-native (default unless persona clearly says otherwise): write like real phone chat in that language’s online culture—not email, not novel narration.',
    '- If formal / old-fashioned / superior / official: keep dignity; use little or no slang, shorthand, or playful emoji. Do not force “cool internet” voice.',
    'Actively draw on how people actually text and post in {{.Language}} (that language’s messengers, slang, shortenings, fillers, emoji habits). English examples below are only seeds: invent natural equivalents for the current {{.Language}}; do not paste English slang into a non-English reply.',
    'To make the online interaction feel real, strictly follow the character’s personality and current emotional state when using the texting behaviors below.',
    '',
    'The examples below are only seeds, not a fixed word list. Do not reuse the same phrases, abbreviations, or emoji every turn. Invent fresh variants that fit the persona, age, and mood. The same feeling should come out differently each time.',
    '',
    '1. Heavy SMS shorthand (when it fits the character): Prefer abbreviations, clipped words, and texting shortcuts over full, formal spelling.',
    '- Default toward short forms such as u/ur, rn, ngl, idk, tbh, omw, lol, bc, gonna—and the same family in {{.Language}}. Rotate them. Do not dump the whole set into one reply.',
    '- Drop letters the way a real person texts in that language (e.g. English “you”→“u”, “because”→“bc”, “right now”→“rn”). Invent other clippings instead of repeating these.',
    '- Prefer chatty fragments over complete sentences, such as “u free?”, “wait what”, “no way”—or local equivalents. Vary the fragments.',
    '- Avoid sounding like written prose. If a line looks like an email or an essay, rewrite it into SMS style for {{.Language}}.',
    '2. Allow punctuation abuse and typos (for example “???”, “!!!”, “...”, a missing period). Change how you stretch or misspell things. Do not always use the same pattern.',
    '3. Slang and internet speech: work in slang, fillers, and online phrasing that **matches the character’s background, age, and voice**, in {{.Language}}.',
    '- Lean on natural fillers and reactions (English seeds: “lowkey”, “bet”, “bruh”, “wait”, “literally”). Treat these as directions, then swap in other words that fit the language and persona.',
    '- Use tone markers common in that language’s texting (English seeds: “lol”, “omfg”, “ily”, “kk”). Do not end every line with the same one.',
    '- Match intensity to emotion: soft, annoyed, or excited should sound different from each other, and different from the last reply.',
    '4. Irrational and emotional replies: people text according to emotion.',
    '- When the situation calls for it, the character may occasionally ignore the user’s logic, fixate on one detail, or reply in a purely emotional and irrational way—such as firing off a burst of short messages, occasionally sending a long wall of text, or rambling.',
    '5. Emoji use: use emoji selectively according to the character’s personality, and rotate them. Some characters may use them often and expressively; others may rarely or never use them. Do not stamp the same emoji on consecutive bubbles.',
    '',
    'Strong preference: unless the character is explicitly formal or old-fashioned, most `<msg>` lines should contain at least one abbreviation, slang term, or clipped phrase natural to {{.Language}}. Full, polished sentences should be the exception, not the default. Vary the shorthand. Do not recycle one favorite example.',
    '</Style Guidelines>',
].join('\n');

/**
 * @typedef {{
 *   role: 'user' | 'char' | 'voice' | 'meta',
 *   text: string,
 *   ts: number,
 *   pending?: boolean,
 *   replyGroupId?: string,
 *   i18nCollapsed?: boolean,
 *   formatBroken?: boolean,
 *   errorKind?: 'network' | 'parse' | 'format' | 'other',
 *   dismissible?: boolean,
 *   thinking?: string,
 *   thinkingOpen?: boolean,
 * }} PhoneMessage
 */
/** @type {PhoneMessage[]} */
let activeThread = [];
let isGenerating = false;
let boundCharacterKey = '';
/** 当前短信线程绑定的主聊天 chat_id（与酒馆 getCurrentChatId 对齐） */
let boundChatId = '';
let defaultPresetCache = '';
/** @type {number | null} */
let bubbleMenuIndex = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let bubbleLongPressTimer = null;
/** 模型生成中：显示三点输入气泡 */
let phoneTyping = false;
/** @type {'char' | 'user' | null} */
let pendingAvatarTarget = null;
/** 模型下拉缓存 */
/** @type {string[]} */
let cachedModelOptions = [];

function newReplyGroupId() {
    return `rg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getActiveUserInfo() {
    const ctx = getContext();
    const avatarId = user_avatar || '';
    const name = ctx.name1 || power_user?.personas?.[avatarId] || 'User';
    const desc = power_user?.persona_descriptions?.[avatarId]?.description
        || power_user?.persona_description
        || '';
    const thumb = avatarId
        ? (typeof ctx.getThumbnailUrl === 'function'
            ? ctx.getThumbnailUrl('persona', avatarId)
            : getUserAvatar(avatarId))
        : '';
    return {
        name: String(name || 'User'),
        description: String(desc || ''),
        avatarId: String(avatarId || ''),
        avatarUrl: thumb || '',
    };
}

/** 打开小手机时暂存的外面聊天预设 A */
/** @type {{ name: string, value: any } | null} */
let outsidePresetSnapshot = null;
/** 打开小手机时暂存的外面 API 连接（防止切 B 预设时 bind_preset_to_connection 改掉） */
/** @type {Record<string, any> | null} */
let outsideConnectionSnapshot = null;
/** 小手机会话中（应使用 B 预设） */
let phoneSessionActive = false;
/** 程序切预设时忽略 change，避免把 A 误记成 B */
let ignoringPresetChange = false;

/** 与 API 连接相关的 oai_settings 字段（切预设时不得改外面的连接） */
const CONNECTION_SETTING_KEYS = Object.freeze([
    'chat_completion_source',
    'custom_url', 'custom_model', 'custom_include_body', 'custom_exclude_body',
    'custom_include_headers', 'custom_prompt_post_processing',
    'reverse_proxy', 'proxy_password',
    'openai_model', 'claude_model', 'openrouter_model', 'openrouter_use_fallback',
    'openrouter_group_models', 'openrouter_sort_models', 'openrouter_providers',
    'openrouter_quantizations', 'openrouter_allow_fallbacks', 'openrouter_middleout',
    'ai21_model', 'mistralai_model', 'cohere_model', 'perplexity_model', 'groq_model',
    'chutes_model', 'chutes_sort_models', 'siliconflow_model', 'electronhub_model',
    'electronhub_sort_models', 'electronhub_group_models', 'nanogpt_model',
    'deepseek_model', 'aimlapi_model', 'xai_model', 'pollinations_model',
    'moonshot_model', 'fireworks_model', 'cometapi_model', 'google_model',
    'vertexai_model', 'zai_model', 'zai_endpoint',
    'vertexai_auth_mode', 'vertexai_region', 'vertexai_express_project_id',
    'show_external_models', 'azure_openai_model',
]);

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
    // 一次性：把「短信同步主聊天」默认改为开启（仅迁移旧存档）
    const bag = extension_settings[MODULE_NAME];
    if (!bag.__syncMainChatDefaultOnV1) {
        bag.syncMainChat = true;
        bag.__syncMainChatDefaultOnV1 = true;
        try { saveSettingsDebounced(); } catch { /* ignore */ }
    }
    return bag;
}

/** 关键配置立刻落盘（debounce 1s，刷新页面会丢） */
function persistSettingsNow() {
    try {
        const maybePromise = saveSettings();
        if (maybePromise && typeof maybePromise.catch === 'function') {
            maybePromise.catch(err => console.warn('[st-pocket-phone] saveSettings failed', err));
        }
    } catch (err) {
        console.warn('[st-pocket-phone] saveSettings failed', err);
        saveSettingsDebounced();
    }
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
            firstMes: '',
            mesExamples: '',
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
    const mesExamples = Array.isArray(fields.mesExamples)
        ? fields.mesExamples.join('\n')
        : (fields.mesExamples || ch.mes_example || '');
    return {
        kind: 'character',
        key: `char:${ch.avatar || id}`,
        name: ch.name || fields.name || '角色',
        avatarUrl,
        description: fields.description || ch.description || '',
        personality: fields.personality || ch.personality || '',
        scenario: fields.scenario || ch.scenario || '',
        firstMes: String(ch.first_mes || '').trim(),
        mesExamples: String(mesExamples || '').trim(),
    };
}

/** 酒馆主聊天近期消息（不含 system），供小手机补上下文 */
function getMainChatHistorySnippet(limit = 12) {
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const picked = [];
    for (let i = chat.length - 1; i >= 0 && picked.length < limit; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        // 跳过已同步进主聊的小手机回写，避免循环复读
        const raw = String(m.mes || '');
        if (raw.startsWith('[小手机]')) continue;
        const name = m.name || (m.is_user ? (ctx.name1 || 'User') : (getActiveCharacter()?.name || '角色'));
        const text = raw
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!text) continue;
        picked.unshift(`${name}: ${truncate(text, 360)}`);
    }
    return picked.join('\n');
}

function threadKey() {
    return getActiveCharacter()?.key || 'char:unknown';
}

/** 酒馆当前主聊天 id；加载中可能为空 */
function getMainChatId() {
    try {
        const ctx = getContext();
        if (typeof ctx.getCurrentChatId === 'function') {
            const id = ctx.getCurrentChatId();
            if (id != null && String(id).trim()) return String(id).trim();
        }
    } catch (_) { /* ignore */ }
    return '';
}

function chatScopeId(chatId = getMainChatId()) {
    const id = String(chatId || '').trim();
    return id || '__none__';
}

function ensureThreadStore(charKey = threadKey()) {
    const s = getSettings();
    if (!s.threadStore || typeof s.threadStore !== 'object') s.threadStore = {};
    if (!s.threadStore[charKey] || typeof s.threadStore[charKey] !== 'object') {
        const legacy = Array.isArray(s.threads?.[charKey]) ? s.threads[charKey] : [];
        const id = newLocalId('th');
        s.threadStore[charKey] = {
            activeId: id,
            threads: [{
                id,
                title: legacy.length ? `对话 1（${legacy.length}条）` : '对话 1',
                updatedAt: Date.now(),
                messages: legacy,
                mainChatId: '',
            }],
        };
    }
    const bag = s.threadStore[charKey];
    if (!Array.isArray(bag.threads)) bag.threads = [];
    if (!bag.threads.length) {
        const id = newLocalId('th');
        bag.threads.push({
            id, title: '对话 1', updatedAt: Date.now(), messages: [], mainChatId: '',
        });
        bag.activeId = id;
    }
    for (const t of bag.threads) {
        if (!Object.prototype.hasOwnProperty.call(t, 'mainChatId')) t.mainChatId = '';
        if (!Array.isArray(t.messages)) t.messages = [];
    }
    if (!bag.threads.some(t => t.id === bag.activeId)) {
        bag.activeId = bag.threads[0].id;
    }
    return bag;
}

/** 同一主聊 chatId 只允许绑一条短信线程 */
function bindThreadToMainChat(thread, chatId, charKey = threadKey()) {
    if (!thread) return;
    const bag = ensureThreadStore(charKey);
    const cid = String(chatId || '').trim();
    if (!cid) {
        thread.mainChatId = '';
        return;
    }
    for (const t of bag.threads) {
        if (t !== thread && String(t.mainChatId || '') === cid) t.mainChatId = '';
    }
    thread.mainChatId = cid;
}

function findThreadByMainChat(charKey, chatId) {
    const cid = String(chatId || '').trim();
    if (!cid) return null;
    const bag = ensureThreadStore(charKey);
    return bag.threads.find(t => String(t.mainChatId || '') === cid) || null;
}

function getActiveThreadRecord(charKey = threadKey()) {
    const bag = ensureThreadStore(charKey);
    return bag.threads.find(t => t.id === bag.activeId) || bag.threads[0];
}

/**
 * 按「角色 + 主聊天 chat_id」加载短信线程。
 * - 已有绑定 → 切过去
 * - 整袋都还没绑过 → 把当前 active 迁到这个 chat（兼容旧数据）
 * - 否则 → 新建空线程并绑定（主聊新开对话时走这里）
 */
function loadThread() {
    const key = threadKey();
    const chatId = getMainChatId();
    boundCharacterKey = key;
    boundChatId = chatId || '';

    const bag = ensureThreadStore(key);
    let rec = chatId ? findThreadByMainChat(key, chatId) : null;

    if (!rec && chatId) {
        const anyBound = bag.threads.some(t => String(t.mainChatId || '').trim());
        if (!anyBound) {
            // 旧数据：首次遇到主聊 id，把当前线程挂上去
            rec = bag.threads.find(t => t.id === bag.activeId) || bag.threads[0];
            if (rec) bindThreadToMainChat(rec, chatId, key);
        }
    }

    if (!rec && chatId) {
        const id = newLocalId('th');
        const idx = bag.threads.length + 1;
        rec = {
            id,
            title: `对话 ${idx}`,
            updatedAt: Date.now(),
            messages: [],
            mainChatId: '',
        };
        bag.threads.push(rec);
        bindThreadToMainChat(rec, chatId, key);
        persistSettingsNow();
    }

    if (!rec) {
        rec = bag.threads.find(t => t.id === bag.activeId) || bag.threads[0];
    }

    bag.activeId = rec.id;
    if (!Array.isArray(rec.messages)) rec.messages = [];
    activeThread = rec.messages;
    getSettings().threads[key] = activeThread;
}

function persistThread() {
    // 注意：切主聊时 getMainChatId() 可能已经是新 id。
    // 落盘必须按 boundChatId / 线程已有 mainChatId，绝不能把旧短信改绑到新主聊。
    const key = boundCharacterKey || threadKey();
    const bag = ensureThreadStore(key);
    const rec = bag.threads.find(t => t.id === bag.activeId) || bag.threads[0];
    if (!rec) return;
    rec.messages = activeThread;
    rec.updatedAt = Date.now();
    if (!String(rec.mainChatId || '').trim()) {
        const keep = String(boundChatId || '').trim();
        if (keep) bindThreadToMainChat(rec, keep, key);
    }
    if (!rec.title || String(rec.title).startsWith('对话')) {
        const n = activeThread.filter(m => m.role === 'user' || m.role === 'char' || m.role === 'voice').length;
        const idx = bag.threads.findIndex(t => t.id === rec.id) + 1;
        rec.title = n ? `对话 ${idx}（${n}条）` : `对话 ${idx}`;
    }
    getSettings().threads[key] = activeThread;
    touchCharacterRoster(key);
    saveSettingsDebounced();
}

function listCharacterThreads(charKey = threadKey()) {
    return ensureThreadStore(charKey).threads.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function formatThreadMainChatLabel(thread) {
    const cid = String(thread?.mainChatId || '').trim();
    if (!cid) return '未绑定主聊';
    const cur = getMainChatId();
    if (cur && cid === cur) return `主聊：当前 · ${truncate(cid, 28)}`;
    return `主聊：${truncate(cid, 36)}`;
}

function switchToThread(threadId, charKey = threadKey()) {
    const bag = ensureThreadStore(charKey);
    const rec = bag.threads.find(t => t.id === threadId);
    if (!rec) return false;
    // 先落盘当前
    try { persistThread(); } catch (_) { /* ignore */ }
    bag.activeId = threadId;
    if (!Array.isArray(rec.messages)) rec.messages = [];
    activeThread = rec.messages;
    boundCharacterKey = charKey;
    boundChatId = String(rec.mainChatId || '');
    getSettings().threads[charKey] = activeThread;
    persistSettingsNow();
    renderMessages();
    updateHeader();
    return true;
}

/**
 * 小手机内手动开新短信线程：绑到当前主聊（并解除同 chat 上旧线程的绑定）。
 * 不会去改酒馆主聊天。
 */
function createNewThread({ title = '', mainChatId = getMainChatId() } = {}) {
    const key = threadKey();
    const bag = ensureThreadStore(key);
    persistThread();
    const id = newLocalId('th');
    const idx = bag.threads.length + 1;
    const rec = {
        id,
        title: title || `对话 ${idx}`,
        updatedAt: Date.now(),
        messages: [],
        mainChatId: '',
    };
    bag.threads.push(rec);
    if (mainChatId) bindThreadToMainChat(rec, mainChatId, key);
    bag.activeId = id;
    activeThread = rec.messages;
    boundChatId = String(rec.mainChatId || '');
    getSettings().threads[key] = activeThread;
    touchCharacterRoster(key);
    persistSettingsNow();
    renderMessages();
    return id;
}

/* ========== 最近角色列表（通讯录） ========== */

function ensureCharacterRoster() {
    const s = getSettings();
    if (!s.characterRoster || typeof s.characterRoster !== 'object') s.characterRoster = {};
    return s.characterRoster;
}

function getRosterMeta(charKey) {
    const bag = ensureCharacterRoster();
    if (!bag[charKey] || typeof bag[charKey] !== 'object') {
        bag[charKey] = {
            nickname: '',
            pinned: false,
            hidden: false,
            lastAt: 0,
            name: '',
            avatarUrl: '',
        };
    }
    return bag[charKey];
}

/** 有短信活动时点亮/更新最近列表（不取消 hidden） */
function touchCharacterRoster(charKey = threadKey()) {
    if (!charKey || charKey === 'char:unknown') return;
    const meta = getRosterMeta(charKey);
    const ch = getActiveCharacter();
    if (ch && ch.key === charKey) {
        meta.name = ch.name || meta.name || '';
        const ov = getCharacterOverride(charKey);
        meta.avatarUrl = ov.avatarDataUrl || ch.avatarUrl || meta.avatarUrl || '';
    } else if (!meta.name) {
        meta.name = resolveCharacterNameByKey(charKey) || charKey;
    }
    meta.lastAt = Date.now();
    // 若曾软删除，再次对话时重新出现在列表
    meta.hidden = false;
    saveSettingsDebounced();
}

function resolveCharacterNameByKey(charKey) {
    const ctx = getContext();
    if (String(charKey).startsWith('group:')) {
        const gid = String(charKey).slice(6);
        const g = ctx.groups?.find?.(x => String(x.id) === gid);
        return g?.name || '群聊';
    }
    const avatar = String(charKey).startsWith('char:') ? String(charKey).slice(5) : String(charKey);
    const ch = ctx.characters?.find?.(c => c.avatar === avatar);
    return ch?.name || '';
}

function resolveCharacterAvatarByKey(charKey) {
    const ov = getCharacterOverride(charKey);
    if (ov.avatarDataUrl) return ov.avatarDataUrl;
    const ctx = getContext();
    if (String(charKey).startsWith('group:')) return '';
    const avatar = String(charKey).startsWith('char:') ? String(charKey).slice(5) : String(charKey);
    const ch = ctx.characters?.find?.(c => c.avatar === avatar);
    if (!ch) return '';
    try {
        if (typeof ctx.getThumbnailUrl === 'function') return ctx.getThumbnailUrl('avatar', ch.avatar) || '';
    } catch (_) { /* ignore */ }
    return `/thumbnail?type=avatar&file=${encodeURIComponent(ch.avatar || '')}`;
}

function getThreadBagLastAt(charKey) {
    const bag = getSettings().threadStore?.[charKey];
    if (!bag || !Array.isArray(bag.threads)) return 0;
    let max = 0;
    for (const t of bag.threads) {
        const u = Number(t.updatedAt || 0);
        if (u > max) max = u;
        const msgs = Array.isArray(t.messages) ? t.messages : [];
        for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 3; i--) {
            const ts = Number(msgs[i]?.ts || 0);
            if (ts > max) max = ts;
        }
    }
    return max;
}

function getThreadPreview(charKey) {
    const bag = getSettings().threadStore?.[charKey];
    if (!bag || !Array.isArray(bag.threads)) return '';
    const active = bag.threads.find(t => t.id === bag.activeId) || bag.threads[0];
    const msgs = Array.isArray(active?.messages) ? active.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m || (m.role !== 'user' && m.role !== 'char' && m.role !== 'voice')) continue;
        return truncate(stripI18nForHistory(m.text), 42);
    }
    return '暂无短信';
}

/** 列表用：有过小手机线程、且未软删除 */
function listCharacterRosterEntries() {
    ensureCharacterRoster();
    const store = getSettings().threadStore || {};
    const keys = new Set([
        ...Object.keys(store),
        ...Object.keys(ensureCharacterRoster()),
    ]);
    const rows = [];
    for (const key of keys) {
        if (!key || key === 'char:unknown') continue;
        const hasThread = Array.isArray(store[key]?.threads) && store[key].threads.length > 0;
        const meta = getRosterMeta(key);
        if (!hasThread && !meta.lastAt) continue;
        if (meta.hidden) continue;
        const lastAt = Math.max(Number(meta.lastAt || 0), getThreadBagLastAt(key));
        rows.push({
            key,
            name: meta.name || resolveCharacterNameByKey(key) || key,
            nickname: String(meta.nickname || '').trim(),
            pinned: !!meta.pinned,
            hidden: !!meta.hidden,
            lastAt,
            avatarUrl: meta.avatarUrl || resolveCharacterAvatarByKey(key),
            preview: getThreadPreview(key),
        });
    }
    rows.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return (b.lastAt || 0) - (a.lastAt || 0);
    });
    return rows;
}

function softRemoveRosterEntry(charKey) {
    const meta = getRosterMeta(charKey);
    meta.hidden = true;
    persistSettingsNow();
}

function toggleRosterPinned(charKey) {
    const meta = getRosterMeta(charKey);
    meta.pinned = !meta.pinned;
    persistSettingsNow();
}

function setRosterNickname(charKey, nickname) {
    const meta = getRosterMeta(charKey);
    meta.nickname = String(nickname || '').trim();
    persistSettingsNow();
}

function rosterDisplayName(entry) {
    if (entry.nickname) return entry.nickname;
    return entry.name || entry.key;
}

async function openCharacterByPhoneKey(charKey) {
    const ctx = getContext();
    if (String(charKey).startsWith('group:')) {
        const gid = String(charKey).slice(6);
        if (typeof ctx.openGroupById === 'function') {
            await ctx.openGroupById(gid);
            return true;
        }
        toastr?.warning?.('当前酒馆无法从列表打开群聊');
        return false;
    }
    const avatar = String(charKey).startsWith('char:') ? String(charKey).slice(5) : String(charKey);
    const id = ctx.characters?.findIndex?.(c => c.avatar === avatar);
    if (id == null || id < 0) {
        toastr?.warning?.('角色卡不在库中（可能已删除）。短信记录仍保留，只是暂时打不开。');
        return false;
    }
    if (typeof ctx.selectCharacterById === 'function') {
        await ctx.selectCharacterById(id, { switchMenu: false });
        return true;
    }
    toastr?.warning?.('当前酒馆无法切换角色');
    return false;
}

async function openPhoneChatForCharacter(charKey) {
    // 先保证已记下外面 A 并处于小手机会话（避免切角后再 snapshot 拍到错误预设）
    if (!phoneSessionActive) enterPhonePresetSession();
    const ok = await openCharacterByPhoneKey(charKey);
    if (!ok) return false;
    // 等酒馆切角/加载聊天稍歇；切角可能改全局预设，必须再拉回 B
    await new Promise(r => setTimeout(r, 80));
    restorePhonePresetWithRetry();
    if (outsideConnectionSnapshot) {
        restoreConnectionSettings(outsideConnectionSnapshot);
        setTimeout(() => restoreConnectionSettings(outsideConnectionSnapshot), 120);
        setTimeout(() => restoreConnectionSettings(outsideConnectionSnapshot), 400);
    }
    touchCharacterRoster(charKey);
    loadThread();
    showView('sms');
    updateHeader();
    renderMessages();
    applyChatBackground();
    return true;
}

function renderCharacterRoster() {
    const box = document.getElementById('pp-roster-list');
    if (!box) return;
    const rows = listCharacterRosterEntries();
    if (!rows.length) {
        box.innerHTML = `
            <div class="pp-roster-empty">
                <p>还没有小手机对话</p>
                <p class="pp-help">在酒馆选好角色后点下方「打开当前角色」，或先去主聊天聊几句再回来。</p>
            </div>`;
        return;
    }
    box.innerHTML = rows.map(e => `
        <div class="pp-roster-item ${e.pinned ? 'is-pinned' : ''}" data-roster-key="${escapeHtml(e.key)}">
            <button type="button" class="pp-roster-main" data-roster-open="1" title="打开对话">
                ${e.avatarUrl
                    ? `<img class="pp-roster-avatar" src="${escapeHtml(e.avatarUrl)}" alt="" />`
                    : `<div class="pp-roster-avatar pp-roster-avatar-empty"></div>`}
                <div class="pp-roster-meta">
                    <div class="pp-roster-name">
                        ${e.pinned ? '<i class="fa-solid fa-thumbtack pp-roster-pin-icon"></i>' : ''}
                        ${escapeHtml(rosterDisplayName(e))}
                    </div>
                    ${e.nickname && e.nickname !== e.name
                        ? `<div class="pp-roster-sub">${escapeHtml(e.name)}</div>`
                        : ''}
                    <div class="pp-roster-preview">${escapeHtml(e.preview || '')}</div>
                </div>
            </button>
            <div class="pp-roster-actions">
                <button type="button" class="pp-roster-act" data-roster-act="pin" title="${e.pinned ? '取消置顶' : '置顶'}">
                    <i class="fa-solid fa-thumbtack"></i>
                </button>
                <button type="button" class="pp-roster-act" data-roster-act="nick" title="备注昵称">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button type="button" class="pp-roster-act pp-roster-act-danger" data-roster-act="hide" title="从列表移除（不删记录）">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
    `).join('');
}

function bindCharacterRosterEvents(root) {
    root.querySelector('#pp-roster-list')?.addEventListener('click', e => {
        const t = /** @type {HTMLElement} */ (e.target);
        const item = t.closest?.('[data-roster-key]');
        if (!item) return;
        const key = item.getAttribute('data-roster-key') || '';
        if (!key) return;

        const actBtn = t.closest?.('[data-roster-act]');
        if (actBtn) {
            e.preventDefault();
            e.stopPropagation();
            const act = actBtn.getAttribute('data-roster-act');
            if (act === 'pin') {
                toggleRosterPinned(key);
                renderCharacterRoster();
                return;
            }
            if (act === 'hide') {
                if (!window.confirm('从最近列表移除？短信记录不会删除，之后再聊会重新出现。')) return;
                softRemoveRosterEntry(key);
                renderCharacterRoster();
                toastr?.info?.('已从列表移除（记录仍保留）');
                return;
            }
            if (act === 'nick') {
                const meta = getRosterMeta(key);
                const curName = meta.name || resolveCharacterNameByKey(key) || key;
                openModal({
                    title: '备注昵称',
                    bodyHtml: `
                        <p class="pp-help">角色名：${escapeHtml(curName)}</p>
                        <label>备注（仅小手机列表显示）</label>
                        <input id="pp-roster-nick-input" type="text" value="${escapeHtml(meta.nickname || '')}" placeholder="例如：老公 / 死党" />
                    `,
                    onOk: () => {
                        const v = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-roster-nick-input'))?.value ?? '';
                        setRosterNickname(key, v);
                        renderCharacterRoster();
                        toastr?.success?.('已保存备注');
                    },
                });
                return;
            }
            return;
        }

        if (t.closest?.('[data-roster-open]')) {
            void openPhoneChatForCharacter(key);
        }
    });

    root.querySelector('#pp-roster-open-current')?.addEventListener('click', () => {
        const ch = getActiveCharacter();
        if (!ch) {
            toastr?.warning?.('酒馆还没有选中角色。请先在角色库点开一个角色，或从上方列表进入。');
            return;
        }
        void openPhoneChatForCharacter(ch.key);
    });
}

function getCharPhoneLanguage(charKey = threadKey()) {
    return String(getCharacterOverride(charKey).phoneLanguage || '').trim();
}

function setCharPhoneLanguage(langId, charKey = threadKey()) {
    getCharacterOverride(charKey).phoneLanguage = String(langId || '').trim();
    persistSettingsNow();
}

function getLanguageOption(langId = getCharPhoneLanguage()) {
    return PHONE_LANGUAGE_OPTIONS.find(o => o.id === langId) || null;
}

/** {{Language}} / {{.Language}} 宏内容：当前角色所选语言 */
function getLanguageMacroValue() {
    if (!getSettings().multilangEnabled) return '';
    const opt = getLanguageOption();
    if (!opt) return '';
    return `${opt.native}（${opt.label}）`;
}

/** 本地替换 {{Language}} / {{.Language}}（兼容 ST 不认点号宏名的情况） */
function applyPhoneLanguageMacros(text) {
    const value = getLanguageMacroValue();
    return String(text || '')
        .split('{{.Language}}').join(value)
        .split('{{Language}}').join(value);
}

function registerPhoneLanguageMacros() {
    try {
        const ctx = getContext();
        const value = () => getLanguageMacroValue();
        const desc = '小手机当前角色的目标语言（多语言开启且已选语言时）';
        if (typeof ctx.registerMacro === 'function') {
            // ST 宏标识符不能以 . 开头；{{.Language}} 走 applyPhoneLanguageMacros
            ctx.registerMacro('Language', value, desc);
        }
    } catch (err) {
        console.warn('[st-pocket-phone] register Language macro failed', err);
    }
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
        openPhone('roster');
    });

    const firstHr = host.querySelector('hr');
    if (firstHr) host.insertBefore(link, firstHr);
    else host.appendChild(link);
}

/** 酒馆最上面一排图标栏：快捷打开小手机 */
function injectTopBarEntry() {
    if (document.getElementById('pocket_phone_topbar')) return;
    const host = document.getElementById('top-settings-holder');
    if (!host) return;

    const wrap = document.createElement('div');
    wrap.id = 'pocket_phone_topbar';
    wrap.className = 'drawer';
    wrap.innerHTML = `
        <div class="drawer-toggle drawer-header">
            <div class="drawer-icon fa-solid fa-mobile-screen-button fa-fw closedIcon interactable"
                 id="pocket_phone_topbar_icon"
                 title="小手机"
                 tabindex="0"
                 role="button"
                 aria-label="打开小手机"></div>
        </div>
    `;
    const icon = wrap.querySelector('#pocket_phone_topbar_icon');
    const open = e => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        openPhone('roster');
    };
    icon?.addEventListener('click', open);
    icon?.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') open(e);
    });

    // 插到扩展按钮前，更靠左好找
    const extBtn = document.getElementById('extensions-settings-button');
    if (extBtn?.parentElement === host) host.insertBefore(wrap, extBtn);
    else host.appendChild(wrap);
}

function ensureUi() {
    if (!document.getElementById('pocket-phone-fab')) {
        const fab = document.createElement('button');
        fab.id = 'pocket-phone-fab';
        fab.type = 'button';
        fab.title = '打开小手机';
        fab.innerHTML = '<i class="fa-solid fa-comment-dots"></i>';
        fab.addEventListener('click', () => openPhone('roster'));
        document.body.appendChild(fab);
    }

    const existing = document.getElementById('pocket-phone-root');
    if (existing?.dataset?.ppUi === PP_UI_VERSION) return;
    // UI 结构升级时拆掉旧壳，重新挂载（保留设置与线程数据）
    existing?.remove();

    const root = document.createElement('div');
    root.id = 'pocket-phone-root';
    root.dataset.ppUi = PP_UI_VERSION;
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
                    </div>
                    <div class="pocket-phone-icon-tabs" role="tablist" aria-label="功能页">
                        <button type="button" class="pp-icon-tab active" data-tab="roster" title="最近对话" aria-label="最近对话">
                            <i class="fa-solid fa-address-book"></i>
                        </button>
                        <button type="button" class="pp-icon-tab" data-tab="sms" title="短信" aria-label="短信">
                            <i class="fa-solid fa-comment-dots"></i>
                        </button>
                        <button type="button" class="pp-icon-tab" data-tab="api" title="API" aria-label="API">
                            <i class="fa-solid fa-plug"></i>
                        </button>
                        <button type="button" class="pp-icon-tab" data-tab="preset" title="预设" aria-label="预设">
                            <i class="fa-solid fa-sliders"></i>
                        </button>
                        <button type="button" class="pp-icon-tab" data-tab="more" title="更多" aria-label="更多">
                            <i class="fa-solid fa-grip"></i>
                        </button>
                    </div>
                </div>

                <div class="pocket-phone-view pocket-phone-panel active" data-view="roster">
                    <div class="pp-page-title">最近对话</div>
                    <p class="pp-help">不依赖酒馆当前选中角色。删除只是移出列表，短信内容不会丢。</p>
                    <button type="button" class="pp-primary-btn" id="pp-roster-open-current">打开当前角色</button>
                    <div class="pp-roster-list" id="pp-roster-list"></div>
                </div>

                <div class="pocket-phone-view" data-view="sms">
                    <div class="pocket-phone-messages" id="pocket-phone-messages"></div>
                    <div class="pocket-phone-composer" id="pocket-phone-composer">
                        <button type="button" class="pp-composer-btn pp-composer-more" id="pocket-phone-more" title="更多" aria-label="更多功能">
                            <i class="fa-solid fa-plus"></i>
                        </button>
                        <div class="pp-composer-input-wrap">
                            <textarea id="pocket-phone-input" rows="1" placeholder="输入消息"></textarea>
                        </div>
                        <button type="button" class="pp-composer-btn pp-composer-bubble" id="pocket-phone-add" title="加入气泡" aria-label="加入气泡">
                            <i class="fa-regular fa-comment"></i>
                        </button>
                        <button type="button" class="pp-composer-btn pp-composer-send" id="pocket-phone-reply" title="请求回复" aria-label="请求回复">
                            <i class="fa-solid fa-paper-plane"></i>
                        </button>
                    </div>
                </div>

                <div class="pocket-phone-view pocket-phone-panel" data-view="api">
                    <div class="pp-mode-row">
                        <label><input type="radio" name="pp_inline_api_mode" value="st" /> 使用酒馆当前聊天 API</label>
                        <label><input type="radio" name="pp_inline_api_mode" value="custom" /> 使用自定义 API</label>
                    </div>
                    <button type="button" class="pp-primary-btn" id="pp-inline-import-st">一键接入正在使用的 API</button>
                    <div id="pp-inline-hint" class="pp-help"></div>

                    <label>酒馆反向代理预设</label>
                    <p class="pp-help">对应外面 API 页那串：ek / 小鸡 / 跑路… 拉取后在这里切换。</p>
                    <select id="pp-proxy-preset-select" class="pp-select">
                        <option value="">先点下方「拉取反向代理」</option>
                    </select>
                    <button type="button" class="pp-secondary-btn" id="pp-inline-pull-profiles">拉取反向代理</button>

                    <label>API Base URL</label>
                    <input id="pp-inline-api-url" type="text" placeholder="https://api.openai.com/v1" />
                    <label>API Key / 代理密码</label>
                    <input id="pp-inline-api-key" type="password" placeholder="sk-..." autocomplete="off" />
                    <label>Model</label>
                    <select id="pp-inline-api-model-select" class="pp-select">
                        <option value="">（从列表选择，或下方手输）</option>
                    </select>
                    <input id="pp-inline-api-model" type="text" list="pp-inline-api-model-list" placeholder="模型名" />
                    <datalist id="pp-inline-api-model-list"></datalist>
                    <button type="button" class="pp-secondary-btn" id="pp-refresh-models">刷新模型列表</button>
                    <button type="button" class="pp-primary-btn" id="pp-inline-save">保存 API 设置</button>

                    <div class="pp-section-title">小手机收藏</div>
                    <p class="pp-help">把当前 URL/Key/模型存成收藏，方便以后一键切回（和上面酒馆代理分开）。</p>
                    <select id="pp-api-profile-select" class="pp-select">
                        <option value="">（无收藏）</option>
                    </select>
                    <label>收藏名称</label>
                    <input id="pp-api-profile-name" type="text" placeholder="例如：家里线路 / 满血 gemini" />
                    <div class="pp-btn-row-2">
                        <button type="button" class="pp-secondary-btn" id="pp-api-profile-save-as">存为收藏</button>
                        <button type="button" class="pp-secondary-btn" id="pp-api-profile-rename">重命名</button>
                        <button type="button" class="pp-secondary-btn" id="pp-api-profile-delete">删除收藏</button>
                    </div>

                    <div class="pp-section-title">数据备份</div>
                    <div class="pp-btn-row-2">
                        <button type="button" class="pp-secondary-btn" id="pp-export-data">导出小手机数据</button>
                        <button type="button" class="pp-secondary-btn" id="pp-import-data">导入小手机数据</button>
                    </div>
                </div>

                <div class="pocket-phone-view pocket-phone-panel pp-preset-view" data-view="preset">
                    <p class="pp-help pp-preset-pool-hint">小手机使用独立预设池：在下方选主库「A」会自动生成副本「📱 A」，编辑副本不会改外面的 A。可随时切换其它「📱」预设。</p>
                    <div id="pp-st-preset-mount" class="pp-st-preset-mount"></div>
                </div>

                <div class="pocket-phone-view pocket-phone-panel" data-view="more">
                    <div class="pp-page-title">更多</div>
                    <p class="pp-help">聊天相关设置与工具（整页，不再用底部弹层）。</p>
                    <div class="pp-more-grid pp-more-grid-page">
                        <button type="button" class="pp-more-item" data-more-action="new-chat">
                            <span class="pp-more-icon pp-more-icon-new"><i class="fa-solid fa-comments"></i></span>
                            <span>开启新对话</span>
                        </button>
                        <button type="button" class="pp-more-item" data-more-action="bubble-color">
                            <span class="pp-more-icon pp-more-icon-color"><i class="fa-solid fa-palette"></i></span>
                            <span>气泡颜色</span>
                        </button>
                        <button type="button" class="pp-more-item" data-more-action="upload-avatar">
                            <span class="pp-more-icon pp-more-icon-avatar"><i class="fa-solid fa-image"></i></span>
                            <span>头像设置</span>
                        </button>
                        <button type="button" class="pp-more-item" data-more-action="voice-id">
                            <span class="pp-more-icon pp-more-icon-voice"><i class="fa-solid fa-microphone-lines"></i></span>
                            <span>音色设置</span>
                        </button>
                        <button type="button" class="pp-more-item" data-more-action="toggle-multilang" id="pp-more-multilang">
                            <span class="pp-more-icon pp-more-icon-lang"><i class="fa-solid fa-language"></i></span>
                            <span class="pp-more-multilang-label">多语言：关</span>
                        </button>
                        <button type="button" class="pp-more-item" data-more-action="switch-user">
                            <span class="pp-more-icon pp-more-icon-user"><i class="fa-solid fa-user-group"></i></span>
                            <span>切换 User</span>
                        </button>
                        <button type="button" class="pp-more-item" data-more-action="chat-bg">
                            <span class="pp-more-icon pp-more-icon-bg"><i class="fa-solid fa-image"></i></span>
                            <span>对话背景</span>
                        </button>
                        <button type="button" class="pp-more-item" data-more-action="memory">
                            <span class="pp-more-icon pp-more-icon-memory"><i class="fa-solid fa-book-open"></i></span>
                            <span>总结记忆</span>
                        </button>
                    </div>
                </div>

                <div class="pocket-phone-view pocket-phone-panel" data-view="memory">
                    <div class="pp-page-head">
                        <button type="button" class="pp-page-back" id="pp-memory-back" title="返回更多" aria-label="返回更多">
                            <i class="fa-solid fa-chevron-left"></i>
                        </button>
                        <div class="pp-page-title">总结记忆</div>
                    </div>
                    <p class="pp-help">按角色保存。有压缩记忆时导入/关闭小手机会写入记忆；没有则写新增原文。关闭时默认自动导入，可多次。</p>

                    <div class="pp-section-title">压缩提示词</div>
                    <p class="pp-help">默认面向 AIRP：情感互动 + 有趣梗。可改成你自己的规则。</p>
                    <textarea id="pp-memory-prompt" rows="8" placeholder="总结压缩提示词"></textarea>
                    <button type="button" class="pp-secondary-btn" id="pp-memory-prompt-reset">恢复默认提示词</button>

                    <div class="pp-section-title">触发阈值</div>
                    <label>压缩触发 Token（默认 10000）</label>
                    <div class="pp-token-slider-row">
                        <input id="pp-memory-token-limit" type="range" min="1000" max="50000" step="500" value="10000" />
                        <span id="pp-memory-token-limit-val" class="pp-token-slider-val">10000</span>
                        <button type="button" class="pp-mini-btn" id="pp-memory-token-save">保存</button>
                    </div>
                    <div id="pp-memory-token-status" class="pp-help">当前短信约 — tokens</div>

                    <div class="pp-section-title">已压缩记忆</div>
                    <textarea id="pp-memory-text" rows="10" placeholder="压缩后的记忆会出现在这里，也可手改…"></textarea>
                    <div class="pp-btn-row-2">
                        <button type="button" class="pp-primary-btn" id="pp-memory-compress">立即压缩短信</button>
                        <button type="button" class="pp-secondary-btn" id="pp-memory-save">保存记忆</button>
                    </div>
                    <div class="pp-btn-row-2">
                        <button type="button" class="pp-secondary-btn" id="pp-memory-import-main">导入主对话</button>
                        <button type="button" class="pp-secondary-btn" id="pp-memory-clear">清空记忆</button>
                    </div>

                    <div class="pp-section-title">压缩用模型</div>
                    <div class="pp-mode-row">
                        <label><input type="radio" name="pp_memory_api_mode" value="chat" /> 跟随小手机对话模型</label>
                        <label><input type="radio" name="pp_memory_api_mode" value="custom" /> 单独接入（OpenAI 兼容）</label>
                    </div>
                    <div id="pp-memory-custom-fields">
                        <label>酒馆反向代理预设</label>
                        <p class="pp-help">可拉取外面 API 页已存的代理名 / URL，再刷新模型列表。</p>
                        <select id="pp-memory-proxy-select" class="pp-select">
                            <option value="">先点下方「拉取反向代理」</option>
                        </select>
                        <button type="button" class="pp-secondary-btn" id="pp-memory-pull-proxy">拉取反向代理</button>
                        <label>API Base URL</label>
                        <input id="pp-memory-api-url" type="text" placeholder="https://api.openai.com/v1" />
                        <label>API Key</label>
                        <input id="pp-memory-api-key" type="password" placeholder="sk-..." autocomplete="off" />
                        <label>Model</label>
                        <select id="pp-memory-api-model-select" class="pp-select">
                            <option value="">（从列表选择，或下方手输）</option>
                        </select>
                        <input id="pp-memory-api-model" type="text" list="pp-memory-api-model-list" placeholder="模型名" />
                        <datalist id="pp-memory-api-model-list"></datalist>
                        <button type="button" class="pp-secondary-btn" id="pp-memory-refresh-models">刷新模型列表</button>
                    </div>
                    <button type="button" class="pp-secondary-btn" id="pp-memory-api-save">保存压缩模型设置</button>
                </div>

                <div class="pocket-phone-view pocket-phone-panel" data-view="voice">
                    <div class="pp-page-head">
                        <button type="button" class="pp-page-back" id="pp-voice-back" title="返回更多" aria-label="返回更多">
                            <i class="fa-solid fa-chevron-left"></i>
                        </button>
                        <div class="pp-page-title">音色设置</div>
                    </div>
                    <p class="pp-help">选择 TTS 服务商与模型；对应「语音条」提示词会注入对话生成。角色 Voice ID 按角色保存。</p>

                    <div class="pp-section-title">服务商</div>
                    <label>当前使用</label>
                    <select id="pp-voice-provider-select" class="pp-select"></select>

                    <div class="pp-section-title">接入信息</div>
                    <label>API Base URL</label>
                    <input id="pp-voice-api-url" type="text" placeholder="https://api.minimax.io" />
                    <label>API Key</label>
                    <input id="pp-voice-api-key" type="password" placeholder="填写密钥" autocomplete="off" />
                    <label>Model</label>
                    <select id="pp-voice-model-select" class="pp-select"></select>
                    <input id="pp-voice-model" type="text" list="pp-voice-model-list" placeholder="模型名，可手输" />
                    <datalist id="pp-voice-model-list"></datalist>

                    <div class="pp-section-title">角色 Voice ID</div>
                    <input id="pp-voice-id" type="text" placeholder="当前角色在该服务商下的 Voice ID" />

                    <div class="pp-section-title">语音条提示词（发给对话模型）</div>
                    <p class="pp-help" id="pp-voice-prompt-key-hint">随所选模型切换默认规则；可自定义。</p>
                    <textarea id="pp-voice-prompt" rows="10" placeholder="语音条写法提示词"></textarea>
                    <div class="pp-btn-row-2">
                        <button type="button" class="pp-secondary-btn" id="pp-voice-prompt-reset">恢复默认提示词</button>
                        <button type="button" class="pp-secondary-btn" id="pp-voice-save">保存音色设置</button>
                    </div>

                    <div class="pp-section-title">自定义第三方</div>
                    <p class="pp-help">填 URL 后命名保存，之后可在上方服务商列表里选用。</p>
                    <label>自定义名称</label>
                    <input id="pp-voice-custom-name" type="text" placeholder="例如：家里中转 / 兼容代理" />
                    <label>提示词族（决定默认标签规则）</label>
                    <select id="pp-voice-custom-family" class="pp-select">
                        <option value="custom">通用 / 自定义</option>
                        <option value="minimax">按 MiniMax 规则</option>
                        <option value="elevenlabs">按 ElevenLabs 规则</option>
                    </select>
                    <div class="pp-btn-row-2">
                        <button type="button" class="pp-secondary-btn" id="pp-voice-custom-save">命名并保存当前 URL</button>
                        <button type="button" class="pp-secondary-btn" id="pp-voice-custom-delete">删除当前自定义</button>
                    </div>
                </div>

                <div class="pp-bubble-menu" id="pp-bubble-menu" aria-hidden="true">
                    <button type="button" data-bubble-act="edit"><i class="fa-solid fa-pen"></i> 编辑</button>
                    <button type="button" data-bubble-act="delete"><i class="fa-solid fa-trash"></i> 删除</button>
                    <button type="button" data-bubble-act="reroll"><i class="fa-solid fa-rotate"></i> 重 roll</button>
                </div>

                <div class="pp-modal" id="pp-modal" aria-hidden="true">
                    <div class="pp-modal-backdrop" data-modal-close="1"></div>
                    <div class="pp-modal-panel" role="dialog" aria-modal="true">
                        <div class="pp-modal-title" id="pp-modal-title"></div>
                        <div class="pp-modal-body" id="pp-modal-body"></div>
                        <div class="pp-modal-actions">
                            <button type="button" class="pp-secondary-btn" data-modal-close="1">取消</button>
                            <button type="button" class="pp-primary-btn" id="pp-modal-ok">确定</button>
                        </div>
                    </div>
                </div>
                <input type="file" id="pp-avatar-file" accept="image/*" hidden />
                <input type="file" id="pp-bg-file" accept="image/*" hidden />
                <input type="file" id="pp-import-file" accept="application/json,.json" hidden />
            </div>
        </div>
    `;
    document.documentElement.appendChild(root);

    root.querySelector('[data-action="close"]')?.addEventListener('click', () => closePhone());
    root.querySelectorAll('.pocket-phone-icon-tabs [data-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.getAttribute('data-tab');
            if (tab !== 'preset') unmountStPresetUi();
            if (tab === 'sms' && !getActiveCharacter()) {
                toastr?.info?.('请先从「最近对话」选一个角色');
                showView('roster');
                renderCharacterRoster();
                updateHeader();
                return;
            }
            if (tab === 'preset' && !getActiveCharacter()) {
                toastr?.info?.('请先从「最近对话」选一个角色再打开预设');
                showView('roster');
                renderCharacterRoster();
                updateHeader();
                return;
            }
            showView(tab);
            if (tab === 'roster') {
                renderCharacterRoster();
                updateHeader();
            }
            if (tab === 'api') syncInlineApiForm();
            if (tab === 'preset') mountStPresetUi();
            if (tab === 'more') syncMultilangMoreLabel();
            if (tab === 'memory') void syncMemoryPage();
            if (tab === 'sms') {
                loadThread();
                updateHeader();
                renderMessages();
            }
        });
    });
    bindCharacterRosterEvents(root);
    root.querySelector('#pocket-phone-add')?.addEventListener('click', () => addUserBubble());
    root.querySelector('#pocket-phone-reply')?.addEventListener('click', () => void requestModelReply());
    root.querySelector('#pocket-phone-more')?.addEventListener('click', () => {
        unmountStPresetUi();
        showView('more');
        syncMultilangMoreLabel();
    });
    root.querySelector('[data-view="more"]')?.addEventListener('click', e => {
        const actionBtn = /** @type {HTMLElement} */ (e.target).closest('[data-more-action]');
        if (!actionBtn) return;
        handleMoreAction(actionBtn.getAttribute('data-more-action'));
    });
    bindMemoryPageEvents(root);
    bindVoicePageEvents(root);
    root.querySelector('#pocket-phone-input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            addUserBubble();
        }
    });
    root.querySelector('#pocket-phone-input')?.addEventListener('input', () => autoGrowComposerInput());
    root.querySelector('#pp-inline-import-st')?.addEventListener('click', () => {
        void (async () => {
            importCurrentTavernApi({ preferStMode: true });
            syncInlineApiForm();
            renderProxyPresetSelect();
            await refreshPocketModelList({ silent: false });
            toastr?.success?.('已一键接入，并同步模型列表');
        })();
    });
    root.querySelector('#pp-inline-pull-profiles')?.addEventListener('click', () => {
        void pullTavernProxyPresets();
    });
    root.querySelector('#pp-proxy-preset-select')?.addEventListener('change', () => {
        void applySelectedProxyPreset();
    });
    root.querySelector('#pp-refresh-models')?.addEventListener('click', () => void refreshPocketModelList({ silent: false }));
    root.querySelector('#pp-inline-api-model-select')?.addEventListener('change', e => {
        const v = /** @type {HTMLSelectElement} */ (e.target).value;
        const modelInput = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-inline-api-model'));
        if (modelInput && v) modelInput.value = v;
    });
    root.querySelector('#pp-inline-save')?.addEventListener('click', () => {
        saveInlineApiForm();
        toastr?.success?.('API 设置已保存');
    });
    root.querySelectorAll('input[name="pp_inline_api_mode"]').forEach(el => {
        el.addEventListener('change', () => {
            getSettings().apiMode = /** @type {HTMLInputElement} */ (el).value === 'custom' ? 'custom' : 'st';
            persistSettingsNow();
            updateHeader();
            syncInlineApiForm();
        });
    });
    root.querySelector('#pp-api-profile-select')?.addEventListener('change', () => {
        applySelectedApiProfile({ fromSelect: true });
    });
    root.querySelector('#pp-api-profile-save-as')?.addEventListener('click', () => saveApiProfileAsNew());
    root.querySelector('#pp-api-profile-rename')?.addEventListener('click', () => renameSelectedApiProfile());
    root.querySelector('#pp-api-profile-delete')?.addEventListener('click', () => deleteSelectedApiProfile());
    root.querySelector('#pp-export-data')?.addEventListener('click', () => exportPocketPhoneData());
    root.querySelector('#pp-import-data')?.addEventListener('click', () => {
        document.getElementById('pp-import-file')?.click();
    });

    bindBubbleInteractions(root);
    root.querySelector('#pp-avatar-file')?.addEventListener('change', onAvatarFilePicked);
    root.querySelector('#pp-bg-file')?.addEventListener('change', onBackgroundFilePicked);
    root.querySelector('#pp-import-file')?.addEventListener('change', onImportFilePicked);
    root.querySelector('#pp-modal')?.addEventListener('click', e => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (t.closest('[data-modal-close]')) closeModal();
    });
    applyBubbleColorVars();
    applyChatBackground();
}

function showView(name) {
    // 离开子页时先落盘表单
    const current = document.querySelector('#pocket-phone-root .pocket-phone-view.active')?.getAttribute('data-view');
    if (current === 'memory' && name !== 'memory') {
        try { saveMemoryPageForm(); } catch (_) { /* ignore */ }
    }
    if (current === 'voice' && name !== 'voice') {
        try { saveVoicePageForm({ quiet: true }); } catch (_) { /* ignore */ }
    }
    document.querySelectorAll('#pocket-phone-root .pocket-phone-view').forEach(view => {
        view.classList.toggle('active', view.getAttribute('data-view') === name);
    });
    // 记忆/音色页挂在「更多」下，顶栏高亮更多
    const tabName = (name === 'memory' || name === 'voice') ? 'more' : name;
    document.querySelectorAll('#pocket-phone-root .pocket-phone-icon-tabs [data-tab]').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
    });
    const root = document.getElementById('pocket-phone-root');
    root?.classList.toggle('pp-on-roster', name === 'roster');
}

function getCharacterOverride(key = boundCharacterKey || threadKey()) {
    const s = getSettings();
    if (!s.characterOverrides || typeof s.characterOverrides !== 'object') s.characterOverrides = {};
    if (!s.characterOverrides[key] || typeof s.characterOverrides[key] !== 'object') {
        s.characterOverrides[key] = {};
    }
    return s.characterOverrides[key];
}

function applyBubbleColorVars() {
    const root = document.getElementById('pocket-phone-root');
    if (!root) return;
    const colors = getSettings().bubbleColors || {};
    const user = colors.user || '#7ddec0';
    const char = colors.char || '#ffffff';
    root.style.setProperty('--pp-user-bubble', user);
    root.style.setProperty('--pp-char-bubble', char);
}

function newLocalId(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getApiProfiles() {
    const s = getSettings();
    if (!Array.isArray(s.apiProfiles)) s.apiProfiles = [];
    return s.apiProfiles;
}

function getBackgroundLibrary() {
    const s = getSettings();
    if (!Array.isArray(s.backgroundLibrary)) s.backgroundLibrary = [];
    return s.backgroundLibrary;
}

function applyChatBackground() {
    const box = document.getElementById('pocket-phone-messages');
    if (!box) return;
    const s = getSettings();
    const id = String(s.activeBackgroundId || '');
    const item = getBackgroundLibrary().find(b => b.id === id);
    if (item?.dataUrl) {
        box.classList.add('pp-has-custom-bg');
        box.style.setProperty('--pp-chat-bg-image', `url("${item.dataUrl}")`);
    } else {
        box.classList.remove('pp-has-custom-bg');
        box.style.removeProperty('--pp-chat-bg-image');
    }
}

/** 与酒馆左上角 Chat Completion 预设同一套真实 DOM（非复刻假 UI） */
const ST_PRESET_NODE_IDS = Object.freeze([
    'openai_api-presets',
    'range_block_openai',
    'openai_settings',
]);

/** @type {Map<string, { parent: Node, next: Node|null }>} */
const stPresetHomes = new Map();
let stPresetMounted = false;

function getOpenaiPresetManager() {
    const ctx = getContext();
    try {
        return ctx.getPresetManager?.('openai') || ctx.getPresetManager?.() || null;
    } catch {
        return null;
    }
}

function isPhonePoolPresetName(name) {
    return String(name || '').startsWith(PP_PHONE_PRESET_PREFIX);
}

function toPhonePoolPresetName(baseName) {
    const n = String(baseName || '').trim();
    if (!n) return '';
    if (isPhonePoolPresetName(n)) return n;
    return `${PP_PHONE_PRESET_PREFIX}${n}`;
}

function phonePoolSourceName(phoneName) {
    const n = String(phoneName || '').trim();
    if (isPhonePoolPresetName(n)) return n.slice(PP_PHONE_PRESET_PREFIX.length);
    return n;
}

function presetNameExists(name) {
    const pm = getOpenaiPresetManager();
    if (!pm || !name) return false;
    try {
        const value = pm.findPreset(name);
        return value !== undefined && value !== null && value !== '';
    } catch {
        return false;
    }
}

/**
 * 把主库预设 sourceName 复制为小手机池「📱 sourceName」（已存在则不覆盖，保护手机侧已有修改）。
 * @param {string} sourceName
 * @returns {Promise<string>} 池内副本名
 */
async function ensurePhonePoolCloneFrom(sourceName) {
    const src = String(sourceName || '').trim();
    if (!src) throw new Error('缺少源预设名');
    const cloneName = toPhonePoolPresetName(src);
    const pm = getOpenaiPresetManager();
    if (!pm) throw new Error('找不到 Chat Completion 预设管理器');

    if (presetNameExists(cloneName)) return cloneName;

    let settings = null;
    try {
        settings = pm.getCompletionPresetByName?.(src) || null;
    } catch {
        settings = null;
    }
    if (!settings) {
        // 源就是当前选中项时，用运行时设置兜底
        const cur = getCurrentPresetSnapshot()?.name;
        if (cur === src && getContext().chatCompletionSettings) {
            try {
                settings = structuredClone(getContext().chatCompletionSettings);
            } catch {
                settings = { ...getContext().chatCompletionSettings };
            }
        }
    } else {
        try {
            settings = structuredClone(settings);
        } catch {
            settings = JSON.parse(JSON.stringify(settings));
        }
    }
    if (!settings || typeof settings !== 'object') {
        throw new Error(`无法读取预设「${src}」的内容`);
    }

    const prevIgnore = ignoringPresetChange;
    ignoringPresetChange = true;
    try {
        await pm.savePreset(cloneName, settings);
    } finally {
        // selectPresetByName 会自己管 ignoring；这里先恢复，随后 select 再锁
        ignoringPresetChange = prevIgnore;
    }
    return cloneName;
}

/**
 * 选用小手机池预设：主库名会先克隆再选中；池内名直接选中。
 * @param {string} name
 * @param {{ fromUser?: boolean }} [opts]
 */
async function activatePhonePresetSelection(name, opts = {}) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    const s = getSettings();
    let target = raw;
    if (!isPhonePoolPresetName(raw)) {
        target = await ensurePhonePoolCloneFrom(raw);
        toastr?.info?.(`已为小手机创建副本「${target}」（不影响外面的「${raw}」）`);
    }
    const ok = selectPresetByName(target);
    if (!ok) {
        toastr?.warning?.(`无法切换到小手机预设「${target}」`);
        return '';
    }
    s.phonePresetName = target;
    snapshotActivePresetIntoPhoneStore(target);
    persistSettingsNow();
    setTimeout(() => ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true }), 80);
    setTimeout(() => ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true }), 400);
    if (opts.fromUser) {
        console.info('[st-pocket-phone] phone preset →', target, opts.fromUser ? '(user)' : '');
    }
    return target;
}

function getCurrentPresetSnapshot() {
    const pm = getOpenaiPresetManager();
    if (!pm) return null;
    try {
        return {
            name: String(pm.getSelectedPresetName?.() || ''),
            value: pm.getSelectedPreset?.(),
        };
    } catch {
        return null;
    }
}

function snapshotConnectionSettings() {
    const oai = getContext().chatCompletionSettings || {};
    /** @type {Record<string, any>} */
    const snap = {};
    for (const key of CONNECTION_SETTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(oai, key)) {
            try {
                snap[key] = structuredClone ? structuredClone(oai[key]) : JSON.parse(JSON.stringify(oai[key]));
            } catch {
                snap[key] = oai[key];
            }
        }
    }
    try {
        snap.__model = getContext().getChatCompletionModel?.() || '';
    } catch {
        snap.__model = '';
    }
    return snap;
}

/**
 * 切预设时锁住 API 连接。
 * 注意：酒馆 onSettingsPresetChange 是 async finally，必须延后恢复 bind，
 * 否则会在我们恢复之后又把 B 预设里的错误 API 写回去。
 */
function selectPresetByName(name) {
    const pm = getOpenaiPresetManager();
    if (!pm || !name) return false;
    let value;
    try {
        value = pm.findPreset(name);
    } catch {
        return false;
    }
    if (value === undefined || value === null || value === '') return false;

    const oai = getContext().chatCompletionSettings || {};
    const prevBind = !!oai.bind_preset_to_connection;
    const connBefore = outsideConnectionSnapshot || snapshotConnectionSettings();
    const bindEl = /** @type {HTMLInputElement|null} */ (document.getElementById('bind_preset_to_connection'));

    ignoringPresetChange = true;
    oai.bind_preset_to_connection = false;
    if (bindEl) bindEl.checked = false;

    try {
        pm.selectPreset(value);
    } catch (err) {
        console.warn('[st-pocket-phone] selectPreset failed', err);
        oai.bind_preset_to_connection = prevBind;
        if (bindEl) bindEl.checked = prevBind;
        ignoringPresetChange = false;
        return false;
    }

    const lockConnection = () => {
        restoreConnectionSettings(connBefore);
        oai.bind_preset_to_connection = false;
        if (bindEl) bindEl.checked = false;
    };
    lockConnection();
    // 覆盖酒馆异步应用预设的窗口
    setTimeout(lockConnection, 0);
    setTimeout(lockConnection, 100);
    setTimeout(lockConnection, 350);
    setTimeout(() => {
        restoreConnectionSettings(connBefore);
        // 会话中保持 bind=false，退出时再还原用户原来的 bind 偏好
        if (!phoneSessionActive) {
            oai.bind_preset_to_connection = prevBind;
            if (bindEl) bindEl.checked = prevBind;
        } else {
            oai.bind_preset_to_connection = false;
            if (bindEl) bindEl.checked = false;
            oai.__pp_prev_bind = prevBind;
        }
        ignoringPresetChange = false;
    }, 500);

    return true;
}

function restoreConnectionSettings(snap) {
    if (!snap) return;
    const oai = getContext().chatCompletionSettings;
    if (!oai) return;
    for (const key of CONNECTION_SETTING_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(snap, key)) continue;
        oai[key] = snap[key];
        // 同步关键 DOM，避免 UI 显示已变但内存又被别处读错
        if (key === 'chat_completion_source') {
            const el = document.getElementById('chat_completion_source');
            if (el && String(/** @type {HTMLSelectElement} */ (el).value) !== String(snap[key])) {
                $(el).val(snap[key]);
            }
        } else if (key === 'custom_url') {
            const el = document.getElementById('custom_api_url_text');
            if (el) /** @type {HTMLInputElement} */ (el).value = snap[key] || '';
        } else if (key === 'custom_model') {
            const el = document.getElementById('custom_model_id');
            if (el) /** @type {HTMLInputElement} */ (el).value = snap[key] || '';
        } else if (key === 'reverse_proxy') {
            const el = document.getElementById('openai_reverse_proxy');
            if (el) /** @type {HTMLInputElement} */ (el).value = snap[key] || '';
        }
    }
}

/** 当前酒馆全局选中的是否就是小手机专用预设 B */
function isOnPhonePreset() {
    const wanted = String(getSettings().phonePresetName || '').trim();
    if (!wanted) return false;
    return getCurrentPresetSnapshot()?.name === wanted;
}

/**
 * 只允许在「当前确实选中小手机预设 B」时改 PromptManager。
 * 防止切 B 尚未完成时把三条强制条目写进主聊天预设 A。
 */
function ensurePocketPhonePresetEntriesIfOnPhone(opts = {}) {
    if (!phoneSessionActive) return false;
    if (!isOnPhonePreset()) return false;
    return ensurePocketPhonePresetEntries(opts);
}

/** 把当前已加载的手机池预设运行时快照写入扩展库存 */
function snapshotActivePresetIntoPhoneStore(name) {
    if (!name || !phoneSessionActive) return;
    // 只快照手机池副本或已记录的 phonePreset；绝不把外面主库 A 误存成手机预设
    const outside = String(getSettings().outsidePresetName || outsidePresetSnapshot?.name || '').trim();
    if (outside && name === outside && !isPhonePoolPresetName(name)) return;
    try {
        const ctx = getContext();
        const pm = getOpenaiPresetManager();
        const selected = pm?.getSelectedPresetName?.() || name;
        if (outside && selected === outside && !isPhonePoolPresetName(selected)) return;
        const live = ctx.chatCompletionSettings ? structuredClone(ctx.chatCompletionSettings) : null;
        if (!live) return;
        const s = getSettings();
        if (!s.phonePresets || typeof s.phonePresets !== 'object') s.phonePresets = {};
        s.phonePresets[selected] = {
            savedAt: Date.now(),
            name: selected,
            source: phonePoolSourceName(selected),
            settings: live,
        };
        s.phonePresetName = selected;
        persistSettingsNow();
    } catch (err) {
        console.warn('[st-pocket-phone] snapshot preset failed', err);
    }
}

/** 用户在小手机预设下拉里点选时置位，用来区分「手切」与「切角色误拽」 */
let ppPresetUserGesture = false;

function bindPhonePresetTracker() {
    if (window.__pp_preset_tracker) return;
    window.__pp_preset_tracker = true;

    $(document).on('pointerdown.pocketphone', '#pp-st-preset-mount #settings_preset_openai, #pocket-phone-root #settings_preset_openai', () => {
        ppPresetUserGesture = true;
    });

    $(document).on('change.pocketphone', '#settings_preset_openai', () => {
        if (!phoneSessionActive || ignoringPresetChange) return;
        if (outsideConnectionSnapshot) restoreConnectionSettings(outsideConnectionSnapshot);

        const name = String(getOpenaiPresetManager()?.getSelectedPresetName?.() || '').trim();
        if (!name) return;
        const s = getSettings();
        const wanted = String(s.phonePresetName || '').trim();
        const fromUser = ppPresetUserGesture;
        ppPresetUserGesture = false;

        // 主库预设（无 📱 前缀）：用户手选 → 拉成手机池副本；误拽 → 拉回当前手机预设
        if (!isPhonePoolPresetName(name)) {
            if (fromUser) {
                void activatePhonePresetSelection(name, { fromUser: true });
            } else if (wanted) {
                setTimeout(() => {
                    if (!phoneSessionActive || ignoringPresetChange) return;
                    if (getCurrentPresetSnapshot()?.name !== wanted) selectPresetByName(wanted);
                }, 0);
            }
            return;
        }

        // 已在手机池内：允许自由切换，记下新的 B
        s.phonePresetName = name;
        snapshotActivePresetIntoPhoneStore(name);
        persistSettingsNow();
        ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true });
    });
}

/** 进入小手机后切到已记录的手机池预设；同名冲突时自动生成 📱 副本 */
function restorePhonePresetWithRetry() {
    const s = getSettings();
    let wanted = String(s.phonePresetName || '').trim();
    const outside = String(s.outsidePresetName || outsidePresetSnapshot?.name || '').trim();

    // 旧数据：手机预设名居然等于外面 A → 改成池内副本名
    if (wanted && outside && wanted === outside && !isPhonePoolPresetName(wanted)) {
        wanted = toPhonePoolPresetName(wanted);
        s.phonePresetName = wanted;
        persistSettingsNow();
    }

    if (!wanted) {
        toastr?.info?.('请到「预设」页选择预设；选主库同名项会自动生成「📱」小手机副本');
        return;
    }

    let warned = false;
    const attempt = () => {
        if (!phoneSessionActive) return true;
        const cur = getCurrentPresetSnapshot()?.name;
        if (cur === wanted) {
            ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true });
            return true;
        }
        // 池内副本尚不存在：从源名克隆
        if (isPhonePoolPresetName(wanted) && !presetNameExists(wanted)) {
            const src = phonePoolSourceName(wanted);
            if (src && presetNameExists(src)) {
                void activatePhonePresetSelection(src).then((got) => {
                    if (got) wanted = got;
                });
                return true;
            }
            return false;
        }
        const ok = selectPresetByName(wanted);
        if (ok) {
            setTimeout(() => ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true }), 80);
            setTimeout(() => ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true }), 400);
            return true;
        }
        return false;
    };

    if (attempt()) return;
    const delays = [200, 600, 1200, 2500];
    delays.forEach((ms, i) => {
        setTimeout(() => {
            if (!phoneSessionActive) return;
            if (attempt()) return;
            if (i === delays.length - 1 && !warned) {
                warned = true;
                toastr?.warning?.(`找不到小手机预设「${wanted}」，请在「预设」页重新选择`);
            }
        }, ms);
    });
}

/**
 * 进入小手机会话：记下外面 A，再切到手机池预设（不改连接）。
 * 手机侧使用「📱」副本，可与外面同名源并存且互不覆盖。
 */
function enterPhonePresetSession() {
    bindPhonePresetTracker();
    bindPresetAfterGuard();
    bindPresetUnloadGuard();
    patchPromptManagerPopup();
    patchPromptManagerSaveHook();
    if (!phoneSessionActive) {
        outsidePresetSnapshot = getCurrentPresetSnapshot();
        outsideConnectionSnapshot = snapshotConnectionSettings();
        const s = getSettings();
        const outsideName = String(outsidePresetSnapshot?.name || '').trim();
        const phoneName = String(s.phonePresetName || '').trim();
        // 当前停在手机池预设上时，不能把池内名误记成「外面 A」
        if (outsideName && !isPhonePoolPresetName(outsideName) && outsideName !== phoneName) {
            s.outsidePresetName = outsideName;
        } else if (outsideName && isPhonePoolPresetName(outsideName)) {
            // 上次没还原干净，外面名不可信；保留已有 outsidePresetName
        } else if (outsideName && outsideName === phoneName && !isPhonePoolPresetName(outsideName)) {
            s.outsidePresetName = outsideName;
        }
        s.phoneSessionBorrowed = true;
        persistSettingsNow();

        const oai = getContext().chatCompletionSettings || {};
        oai.__pp_prev_bind = !!oai.bind_preset_to_connection;
        oai.bind_preset_to_connection = false;
        const bindEl = /** @type {HTMLInputElement|null} */ (document.getElementById('bind_preset_to_connection'));
        if (bindEl) bindEl.checked = false;
        phoneSessionActive = true;
    }

    restorePhonePresetWithRetry();
    if (outsideConnectionSnapshot) {
        restoreConnectionSettings(outsideConnectionSnapshot);
        setTimeout(() => restoreConnectionSettings(outsideConnectionSnapshot), 100);
        setTimeout(() => restoreConnectionSettings(outsideConnectionSnapshot), 400);
    }
}

function bindPresetAfterGuard() {
    if (window.__pp_preset_after_guard) return;
    window.__pp_preset_after_guard = true;
    try {
        eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
            if (!phoneSessionActive) return;
            if (outsideConnectionSnapshot) restoreConnectionSettings(outsideConnectionSnapshot);
            const oai = getContext().chatCompletionSettings || {};
            oai.bind_preset_to_connection = false;
            const s = getSettings();
            const wanted = String(s.phonePresetName || '').trim();
            const cur = String(getCurrentPresetSnapshot()?.name || '').trim();
            if (ignoringPresetChange) return;

            // 被拽到主库预设：拉回当前手机池预设（用户手切会走 tracker 克隆）
            if (cur && !isPhonePoolPresetName(cur)) {
                if (wanted) {
                    setTimeout(() => {
                        if (!phoneSessionActive || ignoringPresetChange) return;
                        if (getCurrentPresetSnapshot()?.name !== wanted) selectPresetByName(wanted);
                    }, 0);
                }
                return;
            }

            // 已在手机池：若与记录不同，视为合法切换（例如 updateList 后）
            if (cur && isPhonePoolPresetName(cur) && cur !== wanted) {
                s.phonePresetName = cur;
                snapshotActivePresetIntoPhoneStore(cur);
            }
            setTimeout(() => ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true }), 50);
        });
    } catch (err) {
        console.warn('[st-pocket-phone] preset after guard failed', err);
    }
}

/** 刷新 / 关页时尽量把全局预设掰回 A，并留下 borrowed 标记供下次启动兜底 */
function bindPresetUnloadGuard() {
    if (window.__pp_preset_unload_guard) return;
    window.__pp_preset_unload_guard = true;
    const harden = () => {
        if (!phoneSessionActive) return;
        try {
            const s = getSettings();
            const restoreName = String(
                outsidePresetSnapshot?.name || s.outsidePresetName || '',
            ).trim();
            const cur = getCurrentPresetSnapshot()?.name;
            if (cur && isPhonePoolPresetName(cur)) {
                s.phonePresetName = cur;
            } else if (cur && cur !== restoreName && cur !== String(s.phonePresetName || '').trim()
                && !isPhonePoolPresetName(String(restoreName || ''))) {
                // 遗留非池内名：仍记为手机预设
                s.phonePresetName = cur;
            }
            s.phoneSessionBorrowed = true;
            if (restoreName) s.outsidePresetName = restoreName;
            // 尽力同步切回 A（可能来不及等异步 change 完成，启动时还会再 heal）
            if (restoreName) {
                const pm = getOpenaiPresetManager();
                const value = pm?.findPreset?.(restoreName);
                if (value !== undefined && value !== null && value !== '') {
                    ignoringPresetChange = true;
                    try { pm.selectPreset(value); } catch { /* ignore */ }
                }
            }
            persistSettingsNow();
        } catch (err) {
            console.warn('[st-pocket-phone] unload preset harden failed', err);
        }
    };
    window.addEventListener('pagehide', harden);
    window.addEventListener('beforeunload', harden);
}

/**
 * 页面加载时：若上次小手机会话没干净退出，把酒馆全局选中项还原成主聊天预设 A。
 * 这是「刷新后主聊天变成小手机预设」的主修复点。
 */
function healMainChatPresetAfterBorrow() {
    const s = getSettings();
    const outside = String(s.outsidePresetName || '').trim();
    const cur = String(getCurrentPresetSnapshot()?.name || '').trim();

    // 只在「借用标记未清」时还原，避免干净退出后误把用户后来手选的预设掰回去
    const needsHeal = !!(outside && s.phoneSessionBorrowed);
    if (!needsHeal) return false;
    if (cur === outside) {
        s.phoneSessionBorrowed = false;
        persistSettingsNow();
        return false;
    }

    console.info('[st-pocket-phone] heal main chat preset →', outside, '(was', cur || '(none)', ')');
    const ok = selectPresetByName(outside);
    // 先保持 borrowed=true，确认切回 A 后再清；避免中途失败丢标记
    [0, 300, 800, 1600, 3000].forEach(ms => {
        setTimeout(() => {
            if (phoneSessionActive) return;
            const now = String(getCurrentPresetSnapshot()?.name || '').trim();
            if (now === outside) {
                s.phoneSessionBorrowed = false;
                persistSettingsNow();
                return;
            }
            selectPresetByName(outside);
        }, ms);
    });
    if (ok && getCurrentPresetSnapshot()?.name === outside) {
        s.phoneSessionBorrowed = false;
        persistSettingsNow();
    }
    return true;
}

/** 离开小手机：把当前手机池预设记入扩展库存，再还原外面 A + API 连接 */
function exitPhonePresetSession() {
    if (!phoneSessionActive) return;

    const current = getCurrentPresetSnapshot();
    const s = getSettings();
    const outsideName = String(outsidePresetSnapshot?.name || s.outsidePresetName || '').trim();
    const curName = String(current?.name || '').trim();
    if (curName && isPhonePoolPresetName(curName)) {
        s.phonePresetName = curName;
        snapshotActivePresetIntoPhoneStore(curName);
    } else if (curName && curName !== outsideName) {
        // 遗留：非前缀但与外面不同的独立预设名
        s.phonePresetName = curName;
        snapshotActivePresetIntoPhoneStore(curName);
    }
    // 若仍停在外面 A 上，保留原 phonePresetName，避免把 A 写成手机预设

    const restoreName = outsideName;
    const restoreValue = outsidePresetSnapshot?.value;
    const conn = outsideConnectionSnapshot;
    const oai = getContext().chatCompletionSettings || {};
    const prevBind = !!oai.__pp_prev_bind;
    outsidePresetSnapshot = null;
    outsideConnectionSnapshot = null;
    phoneSessionActive = false;

    ignoringPresetChange = true;
    oai.bind_preset_to_connection = false;
    const bindEl = /** @type {HTMLInputElement|null} */ (document.getElementById('bind_preset_to_connection'));
    if (bindEl) bindEl.checked = false;

    try {
        const pm = getOpenaiPresetManager();
        if (restoreName && pm) {
            const value = pm.findPreset(restoreName);
            if (value !== undefined && value !== null && value !== '') {
                pm.selectPreset(value);
            } else if (restoreValue != null && restoreValue !== '') {
                pm.selectPreset(restoreValue);
            }
        }
    } catch {
        // ignore
    }

    const finish = () => {
        if (conn) restoreConnectionSettings(conn);
        oai.bind_preset_to_connection = prevBind;
        if (bindEl) bindEl.checked = prevBind;
        delete oai.__pp_prev_bind;
        ignoringPresetChange = false;
        // 确认已经回到 A 后清掉借用标记；失败则保留，下次启动 heal
        const now = getCurrentPresetSnapshot()?.name;
        if (!restoreName || now === restoreName) {
            s.phoneSessionBorrowed = false;
            s.outsidePresetName = '';
            persistSettingsNow();
        } else {
            s.phoneSessionBorrowed = true;
            if (restoreName) s.outsidePresetName = restoreName;
            persistSettingsNow();
        }
    };
    // 等酒馆异步应用完 A 预设后再锁回连接 + bind
    setTimeout(finish, 0);
    setTimeout(finish, 150);
    setTimeout(finish, 450);
    setTimeout(finish, 900);
}

/** @type {{ parent: Node, next: Node|null } | null} */
let stPopupHome = null;

/**
 * 小手机挂在 <html> 上全屏盖住，弹层若在 <body> 会被挡在后面（看起来像点了没反应）。
 * 必须把弹层塞进 #pocket-phone-root 内部。
 */
function ensureStPresetPopupLayer() {
    const popup = document.getElementById('completion_prompt_manager_popup');
    if (!popup) return null;

    if (!stPopupHome) {
        stPopupHome = { parent: popup.parentNode, next: popup.nextSibling };
    }

    const phone = document.getElementById('pocket-phone-root');
    popup.classList.add('pp-st-prompt-popup');
    if (phone && popup.parentElement !== phone) {
        phone.appendChild(popup);
    }
    return popup;
}

function restoreStPresetPopupLayer() {
    const popup = document.getElementById('completion_prompt_manager_popup');
    if (!popup || !stPopupHome?.parent) return;
    try {
        window.jQuery?.(popup).stop(true, true);
    } catch {
        // ignore
    }
    popup.classList.remove('openDrawer', 'pp-st-prompt-popup');
    popup.style.removeProperty('display');
    if (stPopupHome.next && stPopupHome.next.parentNode === stPopupHome.parent) {
        stPopupHome.parent.insertBefore(popup, stPopupHome.next);
    } else {
        stPopupHome.parent.appendChild(popup);
    }
}

function getPromptManager() {
    return promptManager || null;
}

function getPhoneFormatPrompt() {
    const s = getSettings();
    // 一次性：清掉旧版短格式文案，让新的 Output Format Instructions 生效
    if (!s.__ppFormatPromptV3) {
        const old = String(s.phoneFormatPrompt || '').trim();
        if (!old || old.includes('【小手机 · 输出格式】') || old.includes('普通短信：<msg>')) {
            s.phoneFormatPrompt = '';
        }
        s.__ppFormatPromptV3 = true;
        try { persistSettingsNow(); } catch (_) { /* ignore */ }
    }
    const custom = String(s.phoneFormatPrompt || '').trim();
    return custom || DEFAULT_PHONE_FORMAT_PROMPT;
}

function getPhoneMultilangPrompt() {
    const custom = String(getSettings().phoneMultilangPrompt || '').trim();
    return custom || MULTILANG_PROMPT_HINT;
}

function getPhoneStylePrompt() {
    const custom = String(getSettings().phoneStylePrompt || '').trim();
    return custom || DEFAULT_PHONE_STYLE_PROMPT;
}

function getPocketPhonePresetEntryDefs() {
    const voice = getActiveVoiceTagPrompt();
    return [
        {
            identifier: PP_PRESET_ENTRY.format,
            name: '📱 输出格式',
            content: getPhoneFormatPrompt(),
            defaultEnabled: true,
            syncEnabledFrom: null,
        },
        {
            identifier: PP_PRESET_ENTRY.style,
            name: '📱 风格化',
            content: getPhoneStylePrompt(),
            defaultEnabled: true,
            syncEnabledFrom: null,
        },
        {
            identifier: PP_PRESET_ENTRY.voice,
            name: '📱 语音条规则',
            content: voice.prompt,
            defaultEnabled: true,
            syncEnabledFrom: null,
        },
        {
            identifier: PP_PRESET_ENTRY.multilang,
            name: '📱 多语言翻译',
            content: getPhoneMultilangPrompt(),
            defaultEnabled: !!getSettings().multilangEnabled,
            // 首次插入时跟更多页开关；之后尊重预设里的开关
            syncEnabledFrom: 'multilangOnce',
        },
    ];
}

/**
 * 确保当前小手机预设里一定有：格式 / 风格化 / 语音 / 多语言。
 * system_prompt=false 才会真正注入；不可删除靠 isPromptDeletionAllowed / detach 钩子。
 */
function ensurePocketPhonePresetEntries({ render = false, save = false, forceContent = true } = {}) {
    const pm = getPromptManager();
    if (!pm || !pm.serviceSettings) return false;
    try {
        if (typeof pm.sanitizeServiceSettings === 'function') pm.sanitizeServiceSettings();
    } catch (_) { /* ignore */ }

    if (!pm.activeCharacter) {
        try {
            // 全局策略时用 dummy
            const strategy = pm.configuration?.promptOrder?.strategy;
            if (strategy === 'global') {
                pm.activeCharacter = { id: pm.configuration.promptOrder.dummyId };
            }
        } catch (_) { /* ignore */ }
    }
    if (!pm.activeCharacter) return false;

    const defs = getPocketPhonePresetEntryDefs();
    let changed = false;

    for (const def of defs) {
        let prompt = typeof pm.getPromptById === 'function' ? pm.getPromptById(def.identifier) : null;
        if (!prompt) {
            const created = {
                identifier: def.identifier,
                name: def.name,
                // false：才会进入相对提示词列表并真正发给模型
                system_prompt: false,
                marker: false,
                role: 'system',
                content: def.content,
                injection_position: 0,
                injection_depth: 4,
                injection_order: 100,
                forbid_overrides: true,
                extension: true,
            };
            if (typeof pm.addPrompt === 'function') {
                pm.addPrompt(created, def.identifier);
            } else {
                pm.serviceSettings.prompts = pm.serviceSettings.prompts || [];
                pm.serviceSettings.prompts.push(created);
            }
            prompt = typeof pm.getPromptById === 'function' ? pm.getPromptById(def.identifier) : created;
            changed = true;
        } else {
            // 旧版误设 system_prompt=true 会导致不进模型，这里强制纠正
            if (prompt.system_prompt) { prompt.system_prompt = false; changed = true; }
            if (prompt.marker) { prompt.marker = false; changed = true; }
            if (prompt.role !== 'system') { prompt.role = 'system'; changed = true; }
            if (prompt.name !== def.name) { prompt.name = def.name; changed = true; }
            if (forceContent && String(prompt.content || '') !== String(def.content || '')) {
                prompt.content = def.content;
                changed = true;
            }
        }

        const order = typeof pm.getPromptOrderForCharacter === 'function'
            ? pm.getPromptOrderForCharacter(pm.activeCharacter)
            : null;
        if (Array.isArray(order)) {
            let entry = order.find(e => e?.identifier === def.identifier);
            if (!entry) {
                // 默认插到列表最下方
                order.push({ identifier: def.identifier, enabled: !!def.defaultEnabled });
                changed = true;
            } else if (def.identifier === PP_PRESET_ENTRY.multilang) {
                // 多语言条目开关跟随小手机「多语言」设置，避免提示词在但未启用
                const want = !!getSettings().multilangEnabled;
                if (!!entry.enabled !== want) {
                    entry.enabled = want;
                    changed = true;
                }
            }
        }
    }

    // 一次性：把旧版插在顶部的三条挪到最下面（之后用户可自由拖）
    try {
        const bag = getSettings();
        const order = typeof pm.getPromptOrderForCharacter === 'function'
            ? pm.getPromptOrderForCharacter(pm.activeCharacter)
            : null;
        if (Array.isArray(order) && !bag.__ppPromptEntriesBottomV1) {
            const ppIds = defs.map(d => d.identifier);
            const extracted = [];
            for (let i = order.length - 1; i >= 0; i--) {
                if (ppIds.includes(order[i]?.identifier)) {
                    extracted.unshift(order.splice(i, 1)[0]);
                }
            }
            if (extracted.length) {
                order.push(...extracted);
                changed = true;
            }
            bag.__ppPromptEntriesBottomV1 = true;
            persistSettingsNow();
        }
    } catch (_) { /* ignore */ }

    if (changed && save && typeof pm.saveServiceSettings === 'function') {
        try { pm.saveServiceSettings(); } catch (_) { /* ignore */ }
    }
    if (changed && render && typeof pm.render === 'function') {
        try { pm.render(false); } catch (_) { /* ignore */ }
    }
    return changed;
}

/** 从 PromptManager 编辑结果回写到小手机设置（双向映射） */
function syncPocketPhoneEntriesFromPromptManager() {
    const pm = getPromptManager();
    if (!pm || !phoneSessionActive) return;
    const s = getSettings();
    let dirty = false;

    const format = pm.getPromptById?.(PP_PRESET_ENTRY.format);
    if (format && typeof format.content === 'string') {
        const text = format.content.trim();
        const next = text && text !== DEFAULT_PHONE_FORMAT_PROMPT.trim() ? text : '';
        if (s.phoneFormatPrompt !== next) {
            s.phoneFormatPrompt = next;
            dirty = true;
        }
    }

    const multilang = pm.getPromptById?.(PP_PRESET_ENTRY.multilang);
    if (multilang && typeof multilang.content === 'string') {
        const text = multilang.content.trim();
        const next = text && text !== MULTILANG_PROMPT_HINT.trim() ? text : '';
        if (s.phoneMultilangPrompt !== next) {
            s.phoneMultilangPrompt = next;
            dirty = true;
        }
        const orderEntry = pm.getPromptOrderEntry?.(pm.activeCharacter, PP_PRESET_ENTRY.multilang);
        if (orderEntry && typeof orderEntry.enabled === 'boolean') {
            if (!!s.multilangEnabled !== !!orderEntry.enabled) {
                s.multilangEnabled = !!orderEntry.enabled;
                dirty = true;
                syncMultilangMoreLabel();
            }
        }
    }

    const style = pm.getPromptById?.(PP_PRESET_ENTRY.style);
    if (style && typeof style.content === 'string') {
        const text = style.content.trim();
        const next = text && text !== DEFAULT_PHONE_STYLE_PROMPT.trim() ? text : '';
        if (s.phoneStylePrompt !== next) {
            s.phoneStylePrompt = next;
            dirty = true;
        }
    }

    const voice = pm.getPromptById?.(PP_PRESET_ENTRY.voice);
    if (voice && typeof voice.content === 'string') {
        const meta = getActiveVoiceProviderMeta();
        const promptKey = resolveVoicePromptKey(meta.family, meta.model);
        const text = voice.content.trim();
        const def = getDefaultVoiceTagPrompt(promptKey).trim();
        if (!s.voicePromptOverrides || typeof s.voicePromptOverrides !== 'object') s.voicePromptOverrides = {};
        if (!text || text === def) {
            if (s.voicePromptOverrides[promptKey]) {
                delete s.voicePromptOverrides[promptKey];
                dirty = true;
            }
        } else if (s.voicePromptOverrides[promptKey] !== text) {
            s.voicePromptOverrides[promptKey] = text;
            dirty = true;
        }
        // 若音色页正打开，刷新编辑框
        const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-voice-prompt'));
        if (ta && document.activeElement !== ta) {
            ta.value = text || def;
        }
    }

    if (dirty) persistSettingsNow();
}

function patchPromptManagerSaveHook() {
    const pm = getPromptManager();
    if (!pm || typeof pm.saveServiceSettings !== 'function' || pm.__pp_save_hooked) return;
    pm.__pp_save_hooked = true;
    const original = pm.saveServiceSettings.bind(pm);
    pm.saveServiceSettings = (...args) => {
        const result = original(...args);
        const finish = () => {
            try {
                if (phoneSessionActive) syncPocketPhoneEntriesFromPromptManager();
            } catch (err) {
                console.warn('[st-pocket-phone] sync from PromptManager failed', err);
            }
        };
        if (result && typeof result.then === 'function') {
            return result.then(v => { finish(); return v; }).catch(err => { finish(); throw err; });
        }
        finish();
        return result;
    };

    // 不可删除：detach + 删除按钮都不给这三条
    const isLockedId = (id) => (
        id === PP_PRESET_ENTRY.format
        || id === PP_PRESET_ENTRY.style
        || id === PP_PRESET_ENTRY.voice
        || id === PP_PRESET_ENTRY.multilang
    );
    if (typeof pm.detachPrompt === 'function' && !pm.__pp_detach_hooked) {
        pm.__pp_detach_hooked = true;
        const origDetach = pm.detachPrompt.bind(pm);
        pm.detachPrompt = (prompt, character) => {
            if (isLockedId(prompt?.identifier || '')) {
                toastr?.warning?.('小手机必要条目不能删除，可关闭开关或编辑内容');
                return;
            }
            return origDetach(prompt, character);
        };
    }
    if (typeof pm.isPromptDeletionAllowed === 'function' && !pm.__pp_del_hooked) {
        pm.__pp_del_hooked = true;
        const origDel = pm.isPromptDeletionAllowed.bind(pm);
        pm.isPromptDeletionAllowed = (prompt) => {
            if (isLockedId(prompt?.identifier || '')) return false;
            return origDel(prompt);
        };
    }
}

/**
 * 小手机里不用 jQuery slideDown，直接显示/隐藏（与外面同一套 DOM 表单）。
 */
function patchPromptManagerPopup() {
    const pm = getPromptManager();
    if (!pm || typeof pm.showPopup !== 'function') return;
    if (pm.__pp_showPopupPatched) return;
    pm.__pp_showPopupPatched = true;

    const originalShow = pm.showPopup.bind(pm);
    const originalHide = pm.hidePopup.bind(pm);

    pm.showPopup = (area = 'edit') => {
        if (!document.body.classList.contains('pp-st-preset-hosted')) {
            return originalShow(area);
        }

        const prefix = pm.configuration?.prefix || 'completion_';
        const popup = ensureStPresetPopupLayer();
        if (!popup) {
            console.warn('[st-pocket-phone] prompt popup DOM missing');
            return;
        }

        try {
            window.jQuery?.(popup).stop(true, true);
        } catch {
            // ignore
        }

        for (const name of ['edit', 'inspect', 'chathistory_edit', 'dialogueexamples_edit']) {
            const el = document.getElementById(`${prefix}prompt_manager_popup_${name}`);
            if (!el) continue;
            el.style.display = name === area ? 'flex' : 'none';
        }

        popup.classList.add('openDrawer', 'pp-st-prompt-popup');
        popup.style.setProperty('display', 'flex', 'important');
        popup.style.removeProperty('height');
        popup.style.removeProperty('max-height');
        popup.style.removeProperty('overflow');
        console.info('[st-pocket-phone] prompt popup opened:', area);
    };

    pm.hidePopup = () => {
        if (!document.body.classList.contains('pp-st-preset-hosted')) {
            return originalHide();
        }

        const popup = document.getElementById('completion_prompt_manager_popup');
        if (!popup) return originalHide();
        try {
            window.jQuery?.(popup).stop(true, true);
        } catch {
            // ignore
        }
        popup.classList.remove('openDrawer');
        popup.style.setProperty('display', 'none', 'important');
    };

    if (!window.__pp_pm_click_delegate) {
        window.__pp_pm_click_delegate = true;
        document.addEventListener('click', e => {
            if (!document.body.classList.contains('pp-st-preset-hosted')) return;
            const live = getPromptManager();
            if (!live) return;
            const t = /** @type {Element|null} */ (e.target instanceof Element ? e.target : null);
            if (!t) return;

            // 只处理小手机预设页里的点击
            if (!t.closest('#pocket-phone-root, #completion_prompt_manager_popup')) return;

            const editBtn = t.closest('.prompt-manager-edit-action');
            if (editBtn && typeof live.handleEdit === 'function') {
                e.preventDefault();
                e.stopImmediatePropagation();
                try {
                    live.handleEdit({
                        target: editBtn,
                        currentTarget: editBtn,
                        preventDefault() {},
                        stopPropagation() {},
                    });
                } catch (err) {
                    console.error('[st-pocket-phone] handleEdit failed', err);
                }
                return;
            }

            const inspectBtn = t.closest('.prompt-manager-inspect-action');
            if (inspectBtn && typeof live.handleInspect === 'function') {
                e.preventDefault();
                e.stopImmediatePropagation();
                try {
                    live.handleInspect({
                        target: inspectBtn,
                        currentTarget: inspectBtn,
                        preventDefault() {},
                        stopPropagation() {},
                    });
                } catch (err) {
                    console.error('[st-pocket-phone] handleInspect failed', err);
                }
                return;
            }

            const newBtn = t.closest('.completion_prompt_manager_footer .fa-plus-square, .completion_prompt_manager_footer [title="New prompt"]');
            if (newBtn && typeof live.handleNewPrompt === 'function') {
                e.preventDefault();
                e.stopImmediatePropagation();
                try {
                    live.handleNewPrompt(e);
                } catch (err) {
                    console.error('[st-pocket-phone] handleNewPrompt failed', err);
                }
            }
        }, true);
    }
}

/** 离开预设页时关掉可能还开着的编辑弹层 */
function closePromptPopupIfOpen() {
    const popup = document.getElementById('completion_prompt_manager_popup');
    if (!popup?.classList.contains('openDrawer')) return;
    try {
        const pm = getPromptManager();
        if (pm && typeof pm.hidePopup === 'function') {
            pm.hidePopup();
            return;
        }
    } catch {
        // fall through
    }
    popup.classList.remove('openDrawer');
    popup.style.setProperty('display', 'none', 'important');
}

function mountStPresetUi() {
    const host = document.getElementById('pp-st-preset-mount');
    if (!host) return;

    ensureStPresetPopupLayer();
    patchPromptManagerPopup();
    enterPhonePresetSession();

    for (const id of ST_PRESET_NODE_IDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (!stPresetHomes.has(id)) {
            stPresetHomes.set(id, { parent: el.parentNode, next: el.nextSibling });
        }
        // 占位，方便还原时插回原位
        if (!document.getElementById(`pp-st-home-${id}`)) {
            const marker = document.createElement('div');
            marker.id = `pp-st-home-${id}`;
            marker.className = 'pp-st-home-marker';
            marker.hidden = true;
            el.parentNode?.insertBefore(marker, el);
        }
        host.appendChild(el);
        el.classList.add('pp-st-preset-live');
    }

    // 在小手机里强制可见（原本可能因 API 页签隐藏）
    host.querySelectorAll('#openai_api-presets, #range_block_openai, #openai_settings').forEach(el => {
        el.style.display = '';
        el.classList.remove('displayNone');
    });

    stPresetMounted = true;
    document.body.classList.add('pp-st-preset-hosted');
    patchPromptManagerSaveHook();
    // 必须等真正切到小手机预设 B 后再写入条目，禁止污染主聊天 A
    ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true });
    setTimeout(() => ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true }), 400);
    reinitPromptListSortable();
}

/** DOM 搬进小手机后，用酒馆原生 makeDraggable 重建；并强制只用拖拽手柄，避免整行拖拽吞掉铅笔点击 */
function reinitPromptListSortable() {
    const pm = getPromptManager();
    const $ = window.jQuery;
    const $list = $('#completion_prompt_manager_list');
    if ($list?.length && $list.data('ui-sortable')) {
        try {
            $list.sortable('destroy');
        } catch {
            // ignore
        }
    }
    try {
        if (pm && typeof pm.makeDraggable === 'function') {
            pm.makeDraggable();
        }
        // 桌面端原生 handle=null（整行可拖），会抢走铅笔点击；小手机里只允许把手拖
        // helper 挂到小手机根节点，避免 overflow 裁切导致拖拽时条目“透明消失”
        const $live = $('#completion_prompt_manager_list');
        if ($live?.length && $live.data('ui-sortable')) {
            $live.sortable('option', 'handle', '.drag-handle');
            $live.sortable('option', 'cancel', 'input,textarea,button,select,a,.prompt-manager-edit-action,.prompt-manager-toggle-action,.prompt-manager-detach-action,.prompt-manager-inspect-action,.menu_button');
            $live.sortable('option', 'appendTo', '#pocket-phone-root');
            $live.sortable('option', 'helper', function (e, item) {
                const $helper = item.clone();
                $helper.css({
                    width: item.outerWidth(),
                    opacity: 1,
                    background: '#fff8f0',
                    boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
                    zIndex: 10050,
                    pointerEvents: 'none',
                });
                $helper.addClass('pp-sortable-helper');
                return $helper;
            });
            $live.sortable('option', 'start', function (e, ui) {
                ui.placeholder.height(ui.item.outerHeight());
                ui.item.css({ opacity: 0.25 });
            });
            $live.sortable('option', 'stop', function (e, ui) {
                ui.item.css({ opacity: '' });
            });
        }
    } catch (err) {
        console.warn('[st-pocket-phone] makeDraggable failed', err);
    }
}

function unmountStPresetUi() {
    if (!stPresetMounted && !document.getElementById('pp-st-preset-mount')?.children.length) {
        document.body.classList.remove('pp-st-preset-hosted');
        restoreStPresetPopupLayer();
        return;
    }

    closePromptPopupIfOpen();
    restoreStPresetPopupLayer();

    for (const id of ST_PRESET_NODE_IDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.classList.remove('pp-st-preset-live');
        const marker = document.getElementById(`pp-st-home-${id}`);
        if (marker?.parentNode) {
            marker.parentNode.insertBefore(el, marker);
            marker.remove();
        } else {
            const home = stPresetHomes.get(id);
            if (home?.parent) {
                if (home.next && home.next.parentNode === home.parent) {
                    home.parent.insertBefore(el, home.next);
                } else {
                    home.parent.appendChild(el);
                }
            }
        }
    }

    stPresetHomes.clear();
    stPresetMounted = false;
    document.body.classList.remove('pp-st-preset-hosted');
}

function updateHeader() {
    const title = document.getElementById('pocket-phone-title');
    const avatar = /** @type {HTMLImageElement|null} */ (document.getElementById('pocket-phone-avatar'));
    const onRoster = document.querySelector('#pocket-phone-root .pocket-phone-view.active')?.getAttribute('data-view') === 'roster';
    if (onRoster) {
        if (title) title.textContent = '最近对话';
        if (avatar) avatar.removeAttribute('src');
        applyBubbleColorVars();
        return;
    }
    const ch = getActiveCharacter();
    if (!ch) {
        if (title) title.textContent = '小手机';
        if (avatar) avatar.removeAttribute('src');
        return;
    }
    const meta = getRosterMeta(ch.key);
    if (title) title.textContent = meta.nickname || ch.name;
    if (avatar) {
        const ov = getCharacterOverride(ch.key);
        const src = ov.avatarDataUrl || ch.avatarUrl;
        if (src) avatar.src = src;
        else avatar.removeAttribute('src');
    }
    applyBubbleColorVars();
}

function parseI18nParts(text) {
    const raw = String(text || '');
    const m = raw.match(/^([\s\S]*?)<i18n>([\s\S]*?)<\/i18n>\s*$/i)
        || raw.match(/([\s\S]*?)<i18n>([\s\S]*?)<\/i18n>/i);
    if (!m) return { original: raw, translation: '' };
    return {
        original: String(m[1] || '').trim(),
        translation: String(m[2] || '').trim(),
    };
}

function stripI18nForHistory(text) {
    return String(text || '')
        .replace(/\s*<i18n>([\s\S]*?)<\/i18n>/gi, '（$1）')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 仅当本气泡自身带 thinking 时展示图标（通常挂在回复组第一条） */
function getMessageThinking(m) {
    if (!m || (m.role !== 'char' && m.role !== 'voice')) return '';
    return String(m.thinking || '').trim();
}

function renderThinkChrome(m) {
    const thinking = getMessageThinking(m);
    if (!thinking) return '';
    const open = !!m.thinkingOpen;
    return `
        <div class="pp-think-chrome">
            <button type="button" class="pp-think-btn${open ? ' is-open' : ''}" data-think-toggle="1" title="查看思考过程" aria-label="查看思考过程">
                <i class="fa-solid fa-brain"></i>
                <span class="pp-think-btn-label">思考</span>
            </button>
            <div class="pp-think-panel${open ? ' is-open' : ''}" data-think-panel="1" ${open ? '' : 'hidden'}>
                <div class="pp-think-panel-title">思考过程</div>
                <pre class="pp-think-panel-body">${escapeHtml(thinking)}</pre>
            </div>
        </div>
    `;
}

function renderBubbleInnerHtml(m) {
    const thinkChrome = renderThinkChrome(m);
    const multilang = !!getSettings().multilangEnabled;
    let bodyHtml = '';
    if (m.role === 'voice') {
        const body = multilang ? stripI18nForHistory(m.text) : String(m.text || '');
        bodyHtml = `🎙 ${escapeHtml(body)}`;
    } else if (!multilang || (m.role !== 'char' && m.role !== 'voice')) {
        bodyHtml = escapeHtml(String(m.text || ''));
    } else {
        const { original, translation } = parseI18nParts(m.text);
        if (!translation) {
            bodyHtml = escapeHtml(original || String(m.text || ''));
        } else {
            const collapsed = !!m.i18nCollapsed;
            bodyHtml = `<div class="pp-bubble-body"><div class="pp-bubble-original">${escapeHtml(original)}</div><div class="pp-i18n-wrap${collapsed ? ' is-collapsed' : ''}"><div class="pp-i18n-divider"></div><div class="pp-bubble-i18n">${escapeHtml(translation)}</div><button type="button" class="pp-i18n-toggle" data-i18n-toggle="1">${collapsed ? '展开翻译' : '收起翻译'}</button></div></div>`;
        }
    }
    if (!thinkChrome) return bodyHtml;
    return `${thinkChrome}<div class="pp-bubble-main">${bodyHtml}</div>`;
}

function getMessageAvatarUrl(role) {
    const s = getSettings();
    if (s.avatarDisplayMode !== 'both') return '';
    if (role === 'user') {
        return s.userAvatarDataUrl || getActiveUserInfo().avatarUrl || '';
    }
    if (role === 'char' || role === 'voice') {
        const ch = getActiveCharacter();
        if (!ch) return '';
        const ov = getCharacterOverride(ch.key);
        return ov.avatarDataUrl || ch.avatarUrl || '';
    }
    return '';
}

function wrapMessageRow(role, bubbleHtml, extraRowClass = '') {
    const showAvatars = getSettings().avatarDisplayMode === 'both' && (role === 'user' || role === 'char' || role === 'voice');
    const rowCls = ['pp-msg-row', role, extraRowClass].filter(Boolean).join(' ');
    if (!showAvatars) {
        return extraRowClass
            ? `<div class="${rowCls}">${bubbleHtml}</div>`
            : bubbleHtml;
    }
    const src = getMessageAvatarUrl(role);
    const img = src
        ? `<img class="pp-msg-avatar" src="${escapeHtml(src)}" alt="" />`
        : `<div class="pp-msg-avatar pp-msg-avatar-empty"></div>`;
    return `<div class="${rowCls}">${img}<div class="pp-msg-main">${bubbleHtml}</div></div>`;
}

function roleClass(role) {
    if (role === 'user') return 'pp-role-user';
    if (role === 'voice') return 'pp-role-voice';
    if (role === 'meta') return 'pp-role-meta';
    return 'pp-role-char';
}

function renderTypingBubbleHtml() {
    const bubble = `<div class="pocket-phone-bubble pp-role-char pp-typing" aria-label="对方正在输入"><span></span><span></span><span></span></div>`;
    return wrapMessageRow('char', bubble);
}

/**
 * @param {{ animateIdx?: number|null, forceBottom?: boolean }} [opts]
 */
function renderMessages(opts = {}) {
    const box = document.getElementById('pocket-phone-messages');
    if (!box) return;
    const animateIdx = Number.isFinite(opts.animateIdx) ? Number(opts.animateIdx) : null;
    const forceBottom = !!opts.forceBottom;
    const stickBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    hideBubbleMenu();
    const parts = activeThread.map((m, idx) => {
        const enter = animateIdx === idx ? 'pp-bubble-enter' : '';
        if (m.role === 'meta') {
            return `<div class="pocket-phone-bubble pp-role-meta ${enter}" data-idx="${idx}">${escapeHtml(m.text)}</div>`;
        }
        const hasThink = !!getMessageThinking(m);
        const cls = [
            'pocket-phone-bubble',
            roleClass(m.role),
            m.pending ? 'pending' : '',
            enter,
            hasThink ? 'has-thinking' : '',
            (getSettings().multilangEnabled && m.role === 'char' && parseI18nParts(m.text).translation) ? 'has-i18n' : '',
        ].filter(Boolean).join(' ');
        const bubble = `<div class="${cls}" data-idx="${idx}" data-role="${escapeHtml(m.role)}">${renderBubbleInnerHtml(m)}</div>`;
        return wrapMessageRow(m.role === 'voice' ? 'char' : m.role, bubble, enter);
    });
    if (phoneTyping) parts.push(renderTypingBubbleHtml());
    box.innerHTML = parts.join('');
    if (forceBottom || stickBottom || phoneTyping || animateIdx != null) {
        const pin = () => { box.scrollTop = box.scrollHeight; };
        pin();
        requestAnimationFrame(pin);
    }
}

function scrollMessagesToBottom() {
    const box = document.getElementById('pocket-phone-messages');
    if (!box) return;
    const pin = () => { box.scrollTop = box.scrollHeight; };
    pin();
    requestAnimationFrame(pin);
}

function setTypingIndicator(on) {
    phoneTyping = !!on;
    renderMessages({ forceBottom: !!on });
}

function refreshSmsUi() {
    loadThread();
    updateHeader();
    renderMessages();
}

async function openPhone(tab = 'roster') {
    const settings = getSettings();
    if (!settings.enabled) {
        toastr?.warning?.('小手机已在扩展设置中关闭');
        return;
    }
    ensureUi();
    await ensureDefaultPreset();
    // 关键：一打开就记下主聊预设 A 并切到小手机 B（在切角色/列表操作之前）
    // 最近列表曾把进入会话推迟到选角色之后，导致 A 被拍成切角后的错误预设、关闭后还原失败
    enterPhonePresetSession();
    document.getElementById('pocket-phone-root')?.classList.add('pocket-phone-open');
    document.body.classList.add('pocket-phone-open');
    startPhoneOverlayGuard();
    elevateToastsAbovePhone();
    refreshFab();

    // 默认进最近角色列表；不要求酒馆已选中角色
    const want = tab || 'roster';
    if (want === 'roster' || (want === 'sms' && !getActiveCharacter())) {
        unmountStPresetUi();
        showView('roster');
        renderCharacterRoster();
        updateHeader();
        return;
    }

    const ch = getActiveCharacter();
    if (!ch && (want === 'sms' || want === 'preset' || want === 'more' || want === 'memory' || want === 'voice')) {
        showView('roster');
        renderCharacterRoster();
        updateHeader();
        toastr?.info?.('请先从最近列表选择角色');
        return;
    }

    if (ch) {
        touchCharacterRoster(ch.key);
        loadThread();
    }
    showView(want);
    updateHeader();
    if (want === 'sms') {
        renderMessages();
        applyChatBackground();
    }
    if (want === 'api') syncInlineApiForm();
    if (want === 'preset') mountStPresetUi();
    else unmountStPresetUi();
    if (want === 'more') syncMultilangMoreLabel();
}

async function closePhone() {
    try { saveMemoryPageForm(); } catch (_) { /* ignore */ }
    try { saveVoicePageForm({ quiet: true }); } catch (_) { /* ignore */ }
    hideBubbleMenu();
    closeModal();
    unmountStPresetUi();

    // 必须先完成「整轮」导入，再还原外面预设（否则压缩/写入可能被打断）
    if (getSettings().syncMainChat) {
        try {
            await importPhoneThreadToMainChat({ auto: true, silent: false });
        } catch (err) {
            console.warn('[st-pocket-phone] auto import on close failed', err);
        }
    }

    exitPhonePresetSession();
    document.getElementById('pocket-phone-root')?.classList.remove('pocket-phone-open');
    document.body.classList.remove('pocket-phone-open');
    stopPhoneOverlayGuard();
}

/** @type {MutationObserver | null} */
let ppOverlayObserver = null;
/** @type {number} */
let ppOverlayElevateTimer = 0;
let ppOverlayElevating = false;
let ppDialogElevateBound = false;

const PP_OVERLAY_Z = '2147483000';

/**
 * 小手机全屏 z-index 很高时，酒馆 toastr / dialog 容易被盖住。
 * 策略：
 * 1) 有 open dialog → 把 toast 放进 dialog（与 ST fixToastrForDialogs 一致，进 top layer）
 * 2) 否则 toast 挂到 #pocket-phone-root 末尾（同层最高，且不被 .device overflow 裁切）
 * 3) 顺带抬高游离的提示词弹层 / select2
 */
function elevateToastsAbovePhone() {
    if (ppOverlayElevating) return;
    ppOverlayElevating = true;
    try {
        const phoneOpen = document.body.classList.contains('pocket-phone-open');
        const phone = document.getElementById('pocket-phone-root');
        const toast = document.getElementById('toast-container');
        const openDlg = /** @type {HTMLElement|null} */ (
            Array.from(document.querySelectorAll('dialog[open]:not([closing])')).pop() || null
        );

        if (toast) {
            toast.style.setProperty('z-index', PP_OVERLAY_Z, 'important');
            toast.style.setProperty('position', 'fixed', 'important');
            toast.style.setProperty('pointer-events', 'none', 'important');

            if (openDlg) {
                if (toast.parentElement !== openDlg) openDlg.appendChild(toast);
            } else if (phoneOpen && phone) {
                if (toast.parentElement !== phone) phone.appendChild(toast);
            } else if (toast.parentElement !== document.body) {
                document.body.appendChild(toast);
            }
        }

        if (!phoneOpen) return;

        document.querySelectorAll('dialog.popup, dialog[open]').forEach((dlg) => {
            const el = /** @type {HTMLElement} */ (dlg);
            if (el.style.zIndex !== PP_OVERLAY_Z) {
                el.style.setProperty('z-index', PP_OVERLAY_Z, 'important');
            }
        });

        const pmPopup = document.getElementById('completion_prompt_manager_popup');
        if (pmPopup && phone && !phone.contains(pmPopup) && pmPopup.classList.contains('openDrawer')) {
            pmPopup.style.setProperty('z-index', String(Number(PP_OVERLAY_Z) - 10), 'important');
            pmPopup.style.setProperty('position', 'fixed', 'important');
        }

        document.querySelectorAll('.select2-container--open').forEach((node) => {
            const el = /** @type {HTMLElement} */ (node);
            el.style.setProperty('z-index', String(Number(PP_OVERLAY_Z) - 20), 'important');
        });
    } finally {
        ppOverlayElevating = false;
    }
}

function scheduleElevateOverlays() {
    if (ppOverlayElevating) return;
    if (ppOverlayElevateTimer) cancelAnimationFrame(ppOverlayElevateTimer);
    ppOverlayElevateTimer = requestAnimationFrame(() => {
        ppOverlayElevateTimer = 0;
        elevateToastsAbovePhone();
    });
}

function startPhoneOverlayGuard() {
    if (ppOverlayObserver || typeof MutationObserver === 'undefined') {
        elevateToastsAbovePhone();
        return;
    }
    ppOverlayObserver = new MutationObserver((mutations) => {
        if (ppOverlayElevating) return;
        for (const m of mutations) {
            if (m.type !== 'childList') continue;
            scheduleElevateOverlays();
            return;
        }
    });
    ppOverlayObserver.observe(document.body, { childList: true, subtree: true });
    elevateToastsAbovePhone();
}

function stopPhoneOverlayGuard() {
    if (ppOverlayObserver) {
        ppOverlayObserver.disconnect();
        ppOverlayObserver = null;
    }
    if (ppOverlayElevateTimer) {
        cancelAnimationFrame(ppOverlayElevateTimer);
        ppOverlayElevateTimer = 0;
    }
    const toast = document.getElementById('toast-container');
    const phone = document.getElementById('pocket-phone-root');
    if (toast && phone && phone.contains(toast)) {
        document.body.appendChild(toast);
        toast.style.removeProperty('z-index');
    }
}

function refreshFab() {
    ensureUi();
    const fab = document.getElementById('pocket-phone-fab');
    const settings = getSettings();
    // 不再要求必须先选中角色才能出现入口
    const show = !!settings.enabled && !!settings.showFab;
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
    autoGrowComposerInput();
    renderMessages({ forceBottom: true });
}

function autoGrowComposerInput() {
    const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pocket-phone-input'));
    if (!input) return;
    input.style.height = 'auto';
    const next = Math.min(120, Math.max(36, input.scrollHeight));
    input.style.height = `${next}px`;
}

function syncMultilangMoreLabel() {
    const label = document.querySelector('#pp-more-multilang .pp-more-multilang-label');
    const item = document.getElementById('pp-more-multilang');
    const on = !!getSettings().multilangEnabled;
    const lang = getLanguageOption();
    if (label) {
        label.textContent = on
            ? `多语言：${lang?.label || '未选语言'}`
            : '多语言：关';
    }
    item?.classList.toggle('pp-more-item-on', on);
}

function openMoreSheet() {
    unmountStPresetUi();
    showView('more');
    syncMultilangMoreLabel();
}

function closeMoreSheet() {
    // 兼容旧调用：回到短信页
    showView('sms');
}

function clearCurrentSmsThread() {
    const ch = getActiveCharacter();
    if (!ch) {
        toastr?.warning?.('请先选择角色并进入对话');
        return;
    }
    if (boundCharacterKey !== ch.key) loadThread();
    activeThread.length = 0;
    persistThread();
    renderMessages();
    toastr?.success?.('已开启新对话');
}

function handleMoreAction(action) {
    switch (action) {
        case 'new-chat':
            startNewConversation();
            break;
        case 'bubble-color':
            openBubbleColorEditor();
            break;
        case 'upload-avatar':
            openAvatarSettingsEditor();
            break;
        case 'voice-id':
            showView('voice');
            syncVoicePage();
            break;
        case 'toggle-multilang':
            toggleMultilang();
            break;
        case 'switch-user':
            openPersonaSwitcher();
            break;
        case 'chat-bg':
            openChatBackgroundEditor();
            break;
        case 'memory':
            showView('memory');
            void syncMemoryPage();
            break;
        default:
            break;
    }
}

function getMemoryTokenLimit() {
    const n = Number(getSettings().memoryTokenLimit);
    return Number.isFinite(n) && n >= 500 ? Math.round(n) : DEFAULT_MEMORY_TOKEN_LIMIT;
}

function getMemorySummaryPrompt() {
    const custom = String(getSettings().memorySummaryPrompt || '').trim();
    return custom || DEFAULT_MEMORY_SUMMARY_PROMPT;
}

function updateMemoryTokenLimitLabel(n = getMemoryTokenLimit()) {
    const val = document.getElementById('pp-memory-token-limit-val');
    if (val) val.textContent = String(n);
}

function fillMemoryModelOptions(models, selected = '') {
    const uniq = [...new Set((models || []).map(m => String(m || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-memory-api-model-select'));
    const datalist = document.getElementById('pp-memory-api-model-list');
    const cur = selected || /** @type {HTMLInputElement|null} */ (document.getElementById('pp-memory-api-model'))?.value || '';
    if (select) {
        select.innerHTML = `<option value="">（从列表选择，或下方手输）</option>${
            uniq.map(id => `<option value="${escapeHtml(id)}"${id === cur ? ' selected' : ''}>${escapeHtml(id)}</option>`).join('')
        }`;
        if (cur && !uniq.includes(cur)) {
            const opt = document.createElement('option');
            opt.value = cur;
            opt.textContent = cur;
            opt.selected = true;
            select.appendChild(opt);
        }
    }
    if (datalist) {
        datalist.innerHTML = uniq.map(id => `<option value="${escapeHtml(id)}"></option>`).join('');
    }
}

function renderMemoryProxySelect(selectedName = '') {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-memory-proxy-select'));
    if (!select) return;
    const presets = listTavernProxyPresets();
    const s = getSettings();
    const cur = selectedName
        || select.value
        || (presets.find(p => p.url && p.url === s.memoryApiUrl)?.name)
        || '';
    if (!presets.length) {
        select.innerHTML = '<option value="">酒馆里还没有反向代理预设</option>';
        return;
    }
    select.innerHTML = `<option value="">选择代理预设…</option>${
        presets.map(p => {
            const tip = p.url ? ` — ${truncate(p.url, 40)}` : '';
            return `<option value="${escapeHtml(p.name)}"${p.name === cur ? ' selected' : ''}>${escapeHtml(p.name)}${escapeHtml(tip)}</option>`;
        }).join('')
    }`;
}

async function pullMemoryProxyPresets() {
    const presets = listTavernProxyPresets();
    if (!presets.length) {
        toastr?.info?.('酒馆 API 页还没有保存反向代理预设');
        renderMemoryProxySelect();
        return;
    }
    renderMemoryProxySelect();
    toastr?.success?.(`已拉取 ${presets.length} 个代理：${truncate(presets.map(p => p.name).join('、'), 80)}`);
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-memory-proxy-select'));
    if (select?.value) await applySelectedMemoryProxyPreset();
}

async function applySelectedMemoryProxyPreset() {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-memory-proxy-select'));
    const name = String(select?.value || '').trim();
    if (!name) return;
    const preset = listTavernProxyPresets().find(p => p.name === name);
    if (!preset) {
        toastr?.warning?.(`找不到代理预设「${name}」`);
        return;
    }
    const s = getSettings();
    s.memoryApiMode = 'custom';
    s.memoryApiUrl = preset.url || '';
    s.memoryApiKey = preset.password || '';
    persistSettingsNow();

    const modeCustom = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="pp_memory_api_mode"][value="custom"]'));
    if (modeCustom) modeCustom.checked = true;
    const url = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-memory-api-url'));
    const key = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-memory-api-key'));
    if (url) url.value = s.memoryApiUrl;
    if (key) key.value = s.memoryApiKey;
    toggleMemoryCustomFields();
    await refreshMemoryModelList({ silent: false });
    toastr?.success?.(`压缩模型已套用「${preset.name}」`);
}

async function refreshMemoryModelList({ silent = true } = {}) {
    const s = getSettings();
    const url = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-memory-api-url'))?.value?.trim()
        || s.memoryApiUrl
        || s.apiUrl
        || '';
    const key = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-memory-api-key'))?.value?.trim()
        || s.memoryApiKey
        || s.apiKey
        || '';
    const selected = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-memory-api-model'))?.value?.trim()
        || s.memoryApiModel
        || '';
    /** @type {string[]} */
    const models = [];
    for (const m of (stModelList || [])) {
        if (m?.id) models.push(String(m.id));
    }
    try {
        models.push(...await fetchModelsFromTavernStatus());
    } catch (err) {
        console.warn('[st-pocket-phone] memory status models failed', err);
    }
    if (url) {
        try {
            models.push(...await fetchModelsFromCustomEndpoint(url, key));
        } catch (err) {
            console.warn('[st-pocket-phone] memory custom models failed', err);
            if (!silent) toastr?.warning?.('压缩端点模型列表拉取失败，已尽量用酒馆已有列表');
        }
    }
    if (selected) models.push(selected);
    fillMemoryModelOptions(models, selected);
    if (!silent) {
        const n = new Set(models.filter(Boolean)).size;
        toastr?.success?.(n ? `压缩模型已同步 ${n} 个` : '暂无可用模型，可手动输入');
    }
}

function bindMemoryPageEvents(root) {
    root.querySelector('#pp-memory-back')?.addEventListener('click', () => {
        saveMemoryPageForm();
        showView('more');
        syncMultilangMoreLabel();
    });
    root.querySelector('#pp-memory-prompt-reset')?.addEventListener('click', () => {
        const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-memory-prompt'));
        if (ta) ta.value = DEFAULT_MEMORY_SUMMARY_PROMPT;
        getSettings().memorySummaryPrompt = '';
        persistSettingsNow();
        toastr?.success?.('已恢复默认压缩提示词');
    });
    root.querySelector('#pp-memory-save')?.addEventListener('click', () => {
        saveMemoryPageForm();
        toastr?.success?.('总结记忆已保存');
    });
    root.querySelector('#pp-memory-clear')?.addEventListener('click', () => {
        const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-memory-text'));
        if (ta) ta.value = '';
        const ch = getActiveCharacter();
        if (ch) setPhoneMemorySummary('', ch.key);
        toastr?.success?.('已清空记忆');
    });
    root.querySelector('#pp-memory-compress')?.addEventListener('click', () => {
        void autoSummarizePhoneMemory();
    });
    root.querySelector('#pp-memory-import-main')?.addEventListener('click', () => {
        // 手动导入允许强制再写一条（即使内容相同）
        void importPhoneThreadToMainChat({ force: true });
    });
    root.querySelector('#pp-memory-api-save')?.addEventListener('click', () => {
        saveMemoryPageForm();
        toastr?.success?.('压缩模型设置已保存');
    });
    root.querySelector('#pp-memory-token-limit')?.addEventListener('input', e => {
        updateMemoryTokenLimitLabel(Number(/** @type {HTMLInputElement} */ (e.target).value) || DEFAULT_MEMORY_TOKEN_LIMIT);
    });
    root.querySelector('#pp-memory-token-save')?.addEventListener('click', () => {
        saveMemoryPageForm();
        updateMemoryTokenLimitLabel();
        void syncMemoryPage();
        toastr?.success?.(`触发阈值已保存：${getMemoryTokenLimit()} tokens`);
    });
    root.querySelector('#pp-memory-pull-proxy')?.addEventListener('click', () => {
        void pullMemoryProxyPresets();
    });
    root.querySelector('#pp-memory-proxy-select')?.addEventListener('change', () => {
        void applySelectedMemoryProxyPreset();
    });
    root.querySelector('#pp-memory-refresh-models')?.addEventListener('click', () => {
        void refreshMemoryModelList({ silent: false });
    });
    root.querySelector('#pp-memory-api-model-select')?.addEventListener('change', e => {
        const v = /** @type {HTMLSelectElement} */ (e.target).value;
        const modelInput = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-memory-api-model'));
        if (modelInput && v) modelInput.value = v;
    });
    root.querySelectorAll('input[name="pp_memory_api_mode"]').forEach(el => {
        el.addEventListener('change', () => {
            toggleMemoryCustomFields();
            saveMemoryPageForm();
            if (/** @type {HTMLInputElement} */ (el).value === 'custom') {
                renderMemoryProxySelect();
            }
        });
    });
}

async function syncMemoryPage() {
    const s = getSettings();
    const ch = getActiveCharacter();
    const promptEl = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-memory-prompt'));
    const limitEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-memory-token-limit'));
    const memEl = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-memory-text'));
    const status = document.getElementById('pp-memory-token-status');
    const modeChat = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="pp_memory_api_mode"][value="chat"]'));
    const modeCustom = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="pp_memory_api_mode"][value="custom"]'));
    const url = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-memory-api-url'));
    const key = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-memory-api-key'));
    const model = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-memory-api-model'));

    if (promptEl && document.activeElement !== promptEl) {
        promptEl.value = s.memorySummaryPrompt || DEFAULT_MEMORY_SUMMARY_PROMPT;
    }
    const limit = getMemoryTokenLimit();
    if (limitEl) limitEl.value = String(limit);
    updateMemoryTokenLimitLabel(limit);
    if (memEl && document.activeElement !== memEl) {
        memEl.value = ch ? getPhoneMemorySummary(ch.key) : '';
    }
    if (modeChat) modeChat.checked = s.memoryApiMode !== 'custom';
    if (modeCustom) modeCustom.checked = s.memoryApiMode === 'custom';
    if (url) url.value = s.memoryApiUrl || '';
    if (key) key.value = s.memoryApiKey || '';
    if (model) model.value = s.memoryApiModel || '';
    fillMemoryModelOptions(
        [...(stModelList || []).map(m => m?.id).filter(Boolean), s.memoryApiModel].filter(Boolean),
        s.memoryApiModel || '',
    );
    renderMemoryProxySelect();
    toggleMemoryCustomFields();

    const transcript = formatPhoneThreadPlainTranscript();
    if (status) {
        if (!transcript.trim()) {
            status.textContent = `当前短信约 0 tokens · 触发压缩阈值 ${getMemoryTokenLimit()}`;
        } else {
            const tokens = await countPromptTokens(transcript);
            status.textContent = `当前短信约 ${tokens} tokens · 触发压缩阈值 ${getMemoryTokenLimit()}${
                tokens > getMemoryTokenLimit() ? '（已超限，建议压缩）' : '（未超限，导入主对话将用原文）'
            }`;
        }
    }
}

function toggleMemoryCustomFields() {
    const custom = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="pp_memory_api_mode"]:checked'));
    const box = document.getElementById('pp-memory-custom-fields');
    if (!box) return;
    box.style.display = custom?.value === 'custom' ? '' : 'none';
}

function saveMemoryPageForm() {
    const s = getSettings();
    const promptEl = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-memory-prompt'));
    const limitEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-memory-token-limit'));
    const memEl = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-memory-text'));
    const modeEl = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="pp_memory_api_mode"]:checked'));
    const promptVal = (promptEl?.value || '').trim();
    s.memorySummaryPrompt = (promptVal && promptVal !== DEFAULT_MEMORY_SUMMARY_PROMPT.trim())
        ? promptVal
        : '';
    const limit = Number(limitEl?.value);
    s.memoryTokenLimit = Number.isFinite(limit) && limit >= 1000 ? Math.round(limit) : DEFAULT_MEMORY_TOKEN_LIMIT;
    s.memoryApiMode = modeEl?.value === 'custom' ? 'custom' : 'chat';
    s.memoryApiUrl = /** @type {HTMLInputElement} */ (document.getElementById('pp-memory-api-url'))?.value?.trim() || '';
    s.memoryApiKey = /** @type {HTMLInputElement} */ (document.getElementById('pp-memory-api-key'))?.value?.trim() || '';
    s.memoryApiModel = /** @type {HTMLInputElement} */ (document.getElementById('pp-memory-api-model'))?.value?.trim() || '';
    const ch = getActiveCharacter();
    if (ch && memEl) setPhoneMemorySummary(memEl.value || '', ch.key);
    persistSettingsNow();
}

function setPocketPhonePromptEnabled(identifier, enabled) {
    const pm = getPromptManager();
    if (!pm?.activeCharacter || typeof pm.getPromptOrderForCharacter !== 'function') return;
    const order = pm.getPromptOrderForCharacter(pm.activeCharacter);
    if (!Array.isArray(order)) return;
    let entry = order.find(e => e?.identifier === identifier);
    if (!entry) {
        order.push({ identifier, enabled: !!enabled });
    } else {
        entry.enabled = !!enabled;
    }
    try { pm.saveServiceSettings?.(); } catch (_) { /* ignore */ }
    try { pm.render?.(false); } catch (_) { /* ignore */ }
}

function openMultilangLanguagePicker() {
    const ch = getActiveCharacter();
    if (!ch) {
        toastr?.warning?.('请先选择角色');
        return;
    }
    const cur = getCharPhoneLanguage(ch.key);
    const enabled = !!getSettings().multilangEnabled;
    openModal({
        title: '多语言设置（按角色）',
        bodyHtml: `
            <p class="pp-help">语言跟随当前角色；换角色不会沿用上一个角色的语言。预设里可用 <code>{{Language}}</code> / <code>{{.Language}}</code>。</p>
            <div class="pp-lang-grid" id="pp-lang-grid">
                <button type="button" class="pp-lang-item ${!enabled ? 'is-active' : ''}" data-lang="">关闭多语言</button>
                ${PHONE_LANGUAGE_OPTIONS.map(o => `
                    <button type="button" class="pp-lang-item ${enabled && cur === o.id ? 'is-active' : ''}" data-lang="${escapeHtml(o.id)}">
                        ${escapeHtml(o.label)}<small>${escapeHtml(o.native)}</small>
                    </button>
                `).join('')}
            </div>
        `,
        onOk: () => {
            const picked = /** @type {HTMLElement|null} */ (document.querySelector('#pp-lang-grid .pp-lang-item.is-active'));
            const langId = picked?.getAttribute('data-lang') || '';
            const s = getSettings();
            if (!langId) {
                s.multilangEnabled = false;
                persistSettingsNow();
            } else {
                s.multilangEnabled = true;
                setCharPhoneLanguage(langId, ch.key);
                persistSettingsNow();
            }
            syncMultilangMoreLabel();
            ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true, forceContent: true });
            setPocketPhonePromptEnabled(PP_PRESET_ENTRY.multilang, !!s.multilangEnabled);
            // 把当前语言立刻写进预设条目里的 {{Language}} / {{.Language}} 可见文本（仍保留宏名供编辑）
            try {
                const pm = getPromptManager();
                const entry = pm?.getPromptById?.(PP_PRESET_ENTRY.multilang);
                if (entry && typeof entry.content === 'string') {
                    // 内容保持带宏；生成时再 substitute / applyPhoneLanguageMacros
                    entry.content = getPhoneMultilangPrompt();
                    pm.saveServiceSettings?.();
                }
            } catch (_) { /* ignore */ }
            renderMessages();
            elevateToastsAbovePhone();
            toastr?.success?.(s.multilangEnabled
                ? `已开启多语言：${getLanguageOption(langId)?.label || langId}`
                : '已关闭多语言');
        },
    });
    setTimeout(() => {
        document.getElementById('pp-lang-grid')?.addEventListener('click', ev => {
            const btn = /** @type {HTMLElement} */ (ev.target).closest('.pp-lang-item');
            if (!btn) return;
            document.querySelectorAll('#pp-lang-grid .pp-lang-item').forEach(el => el.classList.remove('is-active'));
            btn.classList.add('is-active');
        });
    }, 0);
}

function toggleMultilang() {
    // 改为打开语言选择；不再单纯翻转开关
    openMultilangLanguagePicker();
}

function openThreadSwitcher() {
    const ch = getActiveCharacter();
    if (!ch) {
        toastr?.warning?.('请先选择角色并进入对话');
        return;
    }
    persistThread();
    const bag = ensureThreadStore(ch.key);
    const list = listCharacterThreads(ch.key);
    const curChat = getMainChatId();
    openModal({
        title: '开启新对话 / 切换旧对话',
        bodyHtml: `
            <p class="pp-help">短信线程与主聊天一对一绑定。主聊新开对话时会自动新开空短信；此处手动新开会绑到当前主聊（不改主聊天）。</p>
            <p class="pp-help">当前主聊：${escapeHtml(curChat || '（尚未就绪）')}</p>
            <button type="button" class="pp-primary-btn" id="pp-thread-new">开启新对话</button>
            <div class="pp-section-title">已保存的对话</div>
            <div class="pp-thread-list" id="pp-thread-list">
                ${list.map(t => `
                    <button type="button" class="pp-thread-item ${t.id === bag.activeId ? 'is-active' : ''}" data-thread-id="${escapeHtml(t.id)}">
                        <span class="pp-thread-title">${escapeHtml(t.title || t.id)}</span>
                        <small>${escapeHtml(formatThreadMainChatLabel(t))}</small>
                        <small>${new Date(t.updatedAt || Date.now()).toLocaleString()}</small>
                    </button>
                `).join('') || '<p class="pp-help">暂无历史对话</p>'}
            </div>
        `,
        onOk: () => {
            // 仅关闭；具体切换在列表点击里完成
        },
    });
    setTimeout(() => {
        document.getElementById('pp-thread-new')?.addEventListener('click', () => {
            if (!window.confirm('确定开启新对话？当前短信会保留；新线程会绑到当前主聊（主聊天本身不会变）。')) return;
            createNewThread();
            closeModal();
            showView('sms');
            elevateToastsAbovePhone();
            toastr?.success?.('已开启新对话（旧对话已保存）');
        });
        document.getElementById('pp-thread-list')?.addEventListener('click', ev => {
            const btn = /** @type {HTMLElement} */ (ev.target).closest('[data-thread-id]');
            if (!btn) return;
            const id = btn.getAttribute('data-thread-id');
            if (!id) return;
            if (switchToThread(id, ch.key)) {
                closeModal();
                showView('sms');
                elevateToastsAbovePhone();
                toastr?.success?.('已切换对话');
            }
        });
    }, 0);
}

function startNewConversation() {
    // 进入「开启新对话 / 切换旧对话」界面；真正新建时再二次确认并归档当前线程
    openThreadSwitcher();
}

function openModal({ title, bodyHtml, onOk }) {
    const modal = document.getElementById('pp-modal');
    const titleEl = document.getElementById('pp-modal-title');
    const bodyEl = document.getElementById('pp-modal-body');
    const okBtn = document.getElementById('pp-modal-ok');
    if (!modal || !titleEl || !bodyEl || !okBtn) return;
    titleEl.textContent = title || '';
    bodyEl.innerHTML = bodyHtml || '';
    modal.classList.add('pp-modal-open');
    modal.setAttribute('aria-hidden', 'false');
    const nextOk = () => {
        const ok = onOk?.();
        if (ok === false) return;
        closeModal();
    };
    okBtn.onclick = nextOk;
}

function closeModal() {
    const modal = document.getElementById('pp-modal');
    const okBtn = document.getElementById('pp-modal-ok');
    if (okBtn) okBtn.onclick = null;
    modal?.classList.remove('pp-modal-open');
    modal?.setAttribute('aria-hidden', 'true');
}

function openBubbleColorEditor() {
    const colors = getSettings().bubbleColors || {};
    openModal({
        title: '编辑气泡颜色',
        bodyHtml: `
            <label>我方气泡</label>
            <input id="pp-color-user" type="color" value="${escapeHtml(colors.user || '#7ddec0')}" />
            <label>对方气泡</label>
            <input id="pp-color-char" type="color" value="${escapeHtml(colors.char || '#ffffff')}" />
        `,
        onOk: () => {
            const user = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-color-user'))?.value;
            const char = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-color-char'))?.value;
            const s = getSettings();
            s.bubbleColors = {
                user: user || '#7ddec0',
                char: char || '#ffffff',
            };
            persistSettingsNow();
            applyBubbleColorVars();
            toastr?.success?.('气泡颜色已保存');
        },
    });
}

function ensureVoiceSettingsShape() {
    const s = getSettings();
    if (!s.voiceProviderConfigs || typeof s.voiceProviderConfigs !== 'object') s.voiceProviderConfigs = {};
    for (const id of Object.keys(BUILTIN_VOICE_PROVIDERS)) {
        const builtin = BUILTIN_VOICE_PROVIDERS[id];
        const cur = s.voiceProviderConfigs[id];
        if (!cur || typeof cur !== 'object') {
            s.voiceProviderConfigs[id] = {
                key: '',
                model: builtin.defaultModel,
                url: builtin.url,
            };
        } else {
            if (!cur.url) cur.url = builtin.url;
            if (!cur.model) cur.model = builtin.defaultModel;
            if (cur.key == null) cur.key = '';
        }
    }
    if (!Array.isArray(s.voiceCustomProviders)) s.voiceCustomProviders = [];
    if (!s.voicePromptOverrides || typeof s.voicePromptOverrides !== 'object') s.voicePromptOverrides = {};
    if (!s.activeVoiceProviderId) s.activeVoiceProviderId = 'minimax';
    return s;
}

function listVoiceProviderOptions() {
    ensureVoiceSettingsShape();
    const s = getSettings();
    const builtins = Object.values(BUILTIN_VOICE_PROVIDERS).map(p => ({
        id: p.id,
        name: `${p.name}（官方）`,
        builtin: true,
    }));
    const customs = (s.voiceCustomProviders || []).map(p => ({
        id: p.id,
        name: p.name || p.id,
        builtin: false,
    }));
    return [...builtins, ...customs];
}

function getActiveVoiceProviderMeta() {
    ensureVoiceSettingsShape();
    const s = getSettings();
    const id = String(s.activeVoiceProviderId || 'minimax');
    if (BUILTIN_VOICE_PROVIDERS[id]) {
        const b = BUILTIN_VOICE_PROVIDERS[id];
        const cfg = s.voiceProviderConfigs[id] || {};
        const otherOfficial = Object.values(BUILTIN_VOICE_PROVIDERS)
            .filter(p => p.id !== id)
            .map(p => p.url);
        // 旧 bug 可能把 A 的 URL 写进 B；若撞上另一家官方地址则回正
        let url = String(cfg.url || '').trim() || b.url;
        if (otherOfficial.includes(url)) url = b.url;
        return {
            id,
            name: b.name,
            url,
            key: cfg.key || '',
            model: cfg.model || b.defaultModel,
            models: [...b.models],
            family: b.family,
            builtin: true,
        };
    }
    const custom = (s.voiceCustomProviders || []).find(p => p.id === id);
    if (custom) {
        return {
            id: custom.id,
            name: custom.name || custom.id,
            url: custom.url || '',
            key: custom.key || '',
            model: custom.model || '',
            models: custom.model ? [custom.model] : [],
            family: custom.family === 'minimax' || custom.family === 'elevenlabs' ? custom.family : 'custom',
            builtin: false,
        };
    }
    // 回退 MiniMax
    s.activeVoiceProviderId = 'minimax';
    return getActiveVoiceProviderMeta();
}

function resolveVoicePromptKey(family, model) {
    const m = String(model || '').toLowerCase();
    const f = String(family || 'custom');
    if (f === 'minimax') {
        if (/speech-2\.8|2\.8/.test(m)) return 'minimax:speech-2.8';
        return 'minimax:default';
    }
    if (f === 'elevenlabs') {
        if (/eleven_v4|v4/.test(m)) return 'elevenlabs:v4';
        if (/eleven_v3|[^a-z]v3$/.test(m) || m === 'eleven_v3') return 'elevenlabs:v3';
        return 'elevenlabs:default';
    }
    return 'custom';
}

function getDefaultVoiceTagPrompt(promptKey) {
    return DEFAULT_VOICE_TAG_PROMPTS[promptKey] || DEFAULT_VOICE_TAG_PROMPTS.custom;
}

function getActiveVoiceTagPrompt() {
    ensureVoiceSettingsShape();
    const meta = getActiveVoiceProviderMeta();
    const promptKey = resolveVoicePromptKey(meta.family, meta.model);
    const override = String(getSettings().voicePromptOverrides?.[promptKey] || '').trim();
    return {
        promptKey,
        prompt: override || getDefaultVoiceTagPrompt(promptKey),
        isCustom: !!override,
        meta,
    };
}

/** 注入对话生成：按当前 TTS 模型给出语音条写法 */
function getVoiceProtocolHintForGenerate() {
    const { prompt } = getActiveVoiceTagPrompt();
    return String(prompt || '').trim();
}

function bindVoicePageEvents(root) {
    root.querySelector('#pp-voice-back')?.addEventListener('click', () => {
        saveVoicePageForm({ quiet: true });
        showView('more');
        syncMultilangMoreLabel();
    });
    root.querySelector('#pp-voice-provider-select')?.addEventListener('change', e => {
        const nextId = /** @type {HTMLSelectElement} */ (e.target).value || 'minimax';
        const prevId = getSettings().activeVoiceProviderId || 'minimax';
        // 先把「旧服务商」表单落盘，再切到新服务商读它自己的 URL/Key（避免把旧 URL 写进新服务商）
        if (prevId !== nextId) {
            saveVoicePageForm({ quiet: true, providerIdOverride: prevId });
        }
        getSettings().activeVoiceProviderId = nextId;
        persistSettingsNow();
        syncVoicePage();
    });
    root.querySelector('#pp-voice-model-select')?.addEventListener('change', e => {
        const v = /** @type {HTMLSelectElement} */ (e.target).value;
        const modelInput = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-model'));
        if (modelInput && v) modelInput.value = v;
        refreshVoicePromptEditor({ keepUserEdits: false });
        saveVoicePageForm({ quiet: true });
        ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true, forceContent: true });
    });
    root.querySelector('#pp-voice-model')?.addEventListener('change', () => {
        refreshVoicePromptEditor({ keepUserEdits: false });
        saveVoicePageForm({ quiet: true });
        ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true, forceContent: true });
    });
    root.querySelector('#pp-voice-prompt-reset')?.addEventListener('click', () => {
        const meta = readVoiceFormMeta();
        const promptKey = resolveVoicePromptKey(meta.family, meta.model);
        delete getSettings().voicePromptOverrides[promptKey];
        persistSettingsNow();
        const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-voice-prompt'));
        if (ta) ta.value = getDefaultVoiceTagPrompt(promptKey);
        const hint = document.getElementById('pp-voice-prompt-key-hint');
        if (hint) hint.textContent = `当前规则：${promptKey}（默认）`;
        ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true, forceContent: true });
        toastr?.success?.('已恢复该模型族的默认语音提示词');
    });
    root.querySelector('#pp-voice-save')?.addEventListener('click', () => {
        saveVoicePageForm({ quiet: false });
    });
    root.querySelector('#pp-voice-custom-save')?.addEventListener('click', () => {
        saveCurrentVoiceAsCustomProvider();
    });
    root.querySelector('#pp-voice-custom-delete')?.addEventListener('click', () => {
        deleteActiveCustomVoiceProvider();
    });
}

function readVoiceFormMeta() {
    ensureVoiceSettingsShape();
    const s = getSettings();
    const providerId = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-voice-provider-select'))?.value
        || s.activeVoiceProviderId
        || 'minimax';
    let family = 'custom';
    if (BUILTIN_VOICE_PROVIDERS[providerId]) family = BUILTIN_VOICE_PROVIDERS[providerId].family;
    else {
        const custom = (s.voiceCustomProviders || []).find(p => p.id === providerId);
        family = custom?.family === 'minimax' || custom?.family === 'elevenlabs' ? custom.family : 'custom';
    }
    const model = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-model'))?.value?.trim()
        || /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-voice-model-select'))?.value
        || '';
    return {
        providerId,
        family,
        model,
        url: /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-api-url'))?.value?.trim() || '',
        key: /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-api-key'))?.value?.trim() || '',
        voiceId: /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-id'))?.value?.trim() || '',
        prompt: /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-voice-prompt'))?.value || '',
    };
}

function fillVoiceModelOptions(models, selected = '') {
    const uniq = [...new Set((models || []).map(m => String(m || '').trim()).filter(Boolean))];
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-voice-model-select'));
    const datalist = document.getElementById('pp-voice-model-list');
    const cur = selected || '';
    if (select) {
        select.innerHTML = `<option value="">（选择模型，或下方手输）</option>${
            uniq.map(id => `<option value="${escapeHtml(id)}"${id === cur ? ' selected' : ''}>${escapeHtml(id)}</option>`).join('')
        }`;
    }
    if (datalist) {
        datalist.innerHTML = uniq.map(id => `<option value="${escapeHtml(id)}"></option>`).join('');
    }
}

function refreshVoicePromptEditor({ keepUserEdits = true } = {}) {
    const meta = readVoiceFormMeta();
    const promptKey = resolveVoicePromptKey(meta.family, meta.model);
    const override = String(getSettings().voicePromptOverrides?.[promptKey] || '').trim();
    const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-voice-prompt'));
    const hint = document.getElementById('pp-voice-prompt-key-hint');
    if (hint) {
        hint.textContent = override
            ? `当前规则：${promptKey}（已自定义）`
            : `当前规则：${promptKey}（默认，随模型切换）`;
    }
    if (!ta) return;
    if (keepUserEdits && document.activeElement === ta) return;
    ta.value = override || getDefaultVoiceTagPrompt(promptKey);
}

function syncVoicePage() {
    ensureVoiceSettingsShape();
    const s = getSettings();
    const ch = getActiveCharacter();
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-voice-provider-select'));
    const options = listVoiceProviderOptions();
    if (select) {
        const cur = s.activeVoiceProviderId || 'minimax';
        select.innerHTML = options.map(o => (
            `<option value="${escapeHtml(o.id)}"${o.id === cur ? ' selected' : ''}>${escapeHtml(o.name)}</option>`
        )).join('');
        if (!options.some(o => o.id === cur) && options[0]) {
            s.activeVoiceProviderId = options[0].id;
            select.value = options[0].id;
        }
    }
    const meta = getActiveVoiceProviderMeta();
    const url = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-api-url'));
    const key = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-api-key'));
    const model = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-model'));
    const voiceId = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-id'));
    const customName = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-custom-name'));
    const customFamily = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-voice-custom-family'));
    if (url) url.value = meta.url || '';
    if (key) key.value = meta.key || '';
    if (model) model.value = meta.model || '';
    fillVoiceModelOptions(meta.models.length ? meta.models : [meta.model].filter(Boolean), meta.model || '');
    if (voiceId) {
        const ov = ch ? getCharacterOverride(ch.key) : {};
        if (meta.id === 'minimax') voiceId.value = ov.voiceMinimax || ov.voiceId || '';
        else if (meta.id === 'elevenlabs') voiceId.value = ov.voiceElevenLabs || ov.voiceId || '';
        else voiceId.value = (ov.voiceByProvider && ov.voiceByProvider[meta.id]) || ov.voiceId || '';
    }
    if (customName && !meta.builtin) customName.value = meta.name || '';
    if (customFamily) {
        customFamily.value = meta.family === 'minimax' || meta.family === 'elevenlabs' ? meta.family : 'custom';
    }
    refreshVoicePromptEditor({ keepUserEdits: false });
}

function saveVoicePageForm({ quiet = false, providerIdOverride = '' } = {}) {
    ensureVoiceSettingsShape();
    const s = getSettings();
    const form = readVoiceFormMeta();
    const providerId = providerIdOverride || form.providerId || 'minimax';
    if (!providerIdOverride) {
        s.activeVoiceProviderId = providerId;
    }

    let family = form.family;
    if (BUILTIN_VOICE_PROVIDERS[providerId]) {
        const builtin = BUILTIN_VOICE_PROVIDERS[providerId];
        family = builtin.family;
        s.voiceProviderConfigs[providerId] = {
            key: form.key,
            model: form.model || builtin.defaultModel,
            url: form.url || builtin.url,
        };
    } else {
        const list = s.voiceCustomProviders || [];
        const idx = list.findIndex(p => p.id === providerId);
        if (idx >= 0) {
            list[idx].url = form.url;
            list[idx].key = form.key;
            list[idx].model = form.model;
            if (!providerIdOverride) {
                const famSel = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-voice-custom-family'));
                if (famSel?.value) list[idx].family = famSel.value;
                const nameEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-custom-name'));
                if (nameEl?.value?.trim()) list[idx].name = nameEl.value.trim();
            }
            family = list[idx].family === 'minimax' || list[idx].family === 'elevenlabs' ? list[idx].family : 'custom';
        }
    }

    // 仅在真正保存当前激活服务商时更新提示词覆盖（切换服务商落盘旧配置时不要误写）
    if (!providerIdOverride) {
        const promptKey = resolveVoicePromptKey(family, form.model);
        const defaultPrompt = getDefaultVoiceTagPrompt(promptKey);
        const promptVal = String(form.prompt || '').trim();
        if (!promptVal || promptVal === defaultPrompt.trim()) {
            delete s.voicePromptOverrides[promptKey];
        } else {
            s.voicePromptOverrides[promptKey] = promptVal;
        }
    }

    const ch = getActiveCharacter();
    if (ch) {
        const ov = getCharacterOverride(ch.key);
        const voiceId = form.voiceId;
        if (providerId === 'minimax') ov.voiceMinimax = voiceId;
        else if (providerId === 'elevenlabs') ov.voiceElevenLabs = voiceId;
        else {
            if (!ov.voiceByProvider || typeof ov.voiceByProvider !== 'object') ov.voiceByProvider = {};
            ov.voiceByProvider[providerId] = voiceId;
        }
        if (!providerIdOverride) {
            ov.voiceId = voiceId;
            ov.activeVoiceProviderId = providerId;
        }
    }

    persistSettingsNow();
    if (!providerIdOverride) {
        ensurePocketPhonePresetEntriesIfOnPhone({ render: true, save: true, forceContent: true });
    }
    if (!quiet) toastr?.success?.('音色设置已保存');
}

function saveCurrentVoiceAsCustomProvider() {
    ensureVoiceSettingsShape();
    const s = getSettings();
    const url = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-api-url'))?.value?.trim() || '';
    const name = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-custom-name'))?.value?.trim() || '';
    const key = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-api-key'))?.value?.trim() || '';
    const model = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-voice-model'))?.value?.trim() || '';
    const family = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-voice-custom-family'))?.value || 'custom';
    if (!url) {
        toastr?.warning?.('请先填写自定义 API Base URL');
        return;
    }
    if (!name) {
        toastr?.warning?.('请填写自定义名称');
        return;
    }
    const existing = (s.voiceCustomProviders || []).find(p => p.name === name);
    if (existing) {
        existing.url = url;
        existing.key = key;
        existing.model = model;
        existing.family = family;
        s.activeVoiceProviderId = existing.id;
        persistSettingsNow();
        syncVoicePage();
        toastr?.success?.(`已更新自定义「${name}」`);
        return;
    }
    const id = newLocalId('voice');
    s.voiceCustomProviders.push({ id, name, url, key, model, family, updatedAt: Date.now() });
    s.activeVoiceProviderId = id;
    persistSettingsNow();
    syncVoicePage();
    toastr?.success?.(`已保存自定义「${name}」`);
}

function deleteActiveCustomVoiceProvider() {
    ensureVoiceSettingsShape();
    const s = getSettings();
    const id = s.activeVoiceProviderId;
    if (BUILTIN_VOICE_PROVIDERS[id]) {
        toastr?.info?.('官方服务商不能删除，可改 Key / 模型');
        return;
    }
    const idx = (s.voiceCustomProviders || []).findIndex(p => p.id === id);
    if (idx < 0) {
        toastr?.info?.('当前不是自定义服务商');
        return;
    }
    const name = s.voiceCustomProviders[idx].name || id;
    if (!window.confirm(`删除自定义「${name}」？`)) return;
    s.voiceCustomProviders.splice(idx, 1);
    s.activeVoiceProviderId = 'minimax';
    persistSettingsNow();
    syncVoicePage();
    toastr?.success?.('已删除');
}

async function onAvatarFilePicked(e) {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const file = input.files?.[0];
    const target = pendingAvatarTarget;
    input.value = '';
    pendingAvatarTarget = null;
    if (!file || !target) return;
    if (!file.type.startsWith('image/')) {
        toastr?.warning?.('请选择图片文件');
        return;
    }
    if (file.size > 2.5 * 1024 * 1024) {
        toastr?.warning?.('头像请小于 2.5MB');
        return;
    }
    try {
        const dataUrl = await readFileAsDataUrl(file);
        if (target === 'char') {
            const ch = getActiveCharacter();
            if (!ch) {
                toastr?.warning?.('请先选择角色');
                return;
            }
            getCharacterOverride(ch.key).avatarDataUrl = dataUrl;
            toastr?.success?.('角色头像已更新');
        } else {
            getSettings().userAvatarDataUrl = dataUrl;
            toastr?.success?.('用户头像已更新');
        }
        persistSettingsNow();
        updateHeader();
        renderMessages();
        // 若设置弹窗还开着，刷新预览
        if (document.getElementById('pp-modal')?.classList.contains('pp-modal-open')) {
            openAvatarSettingsEditor();
        }
    } catch (err) {
        console.warn('[st-pocket-phone] avatar upload failed', err);
        toastr?.error?.('头像读取失败');
    }
}

function openAvatarSettingsEditor() {
    const s = getSettings();
    const ch = getActiveCharacter();
    const user = getActiveUserInfo();
    const mode = s.avatarDisplayMode === 'both' ? 'both' : 'none';
    const charSrc = ch ? (getCharacterOverride(ch.key).avatarDataUrl || ch.avatarUrl || '') : '';
    const userSrc = s.userAvatarDataUrl || user.avatarUrl || '';

    openModal({
        title: '头像设置',
        bodyHtml: `
            <p class="pp-help">选择气泡旁是否显示头像；可分别自定义角色与用户头像。</p>
            <label>显示模式</label>
            <div class="pp-mode-row">
                <label><input type="radio" name="pp_avatar_mode" value="none" ${mode === 'none' ? 'checked' : ''}/> 双方都无头像</label>
                <label><input type="radio" name="pp_avatar_mode" value="both" ${mode === 'both' ? 'checked' : ''}/> 双方都有头像</label>
            </div>
            <div class="pp-avatar-edit-row">
                <div class="pp-avatar-edit-card">
                    <div class="pp-avatar-edit-title">角色 ${escapeHtml(ch?.name || '')}</div>
                    ${charSrc ? `<img class="pp-avatar-preview" src="${escapeHtml(charSrc)}" alt="" />` : '<div class="pp-avatar-preview pp-msg-avatar-empty"></div>'}
                    <button type="button" class="pp-secondary-btn" id="pp-pick-char-avatar">上传角色头像</button>
                </div>
                <div class="pp-avatar-edit-card">
                    <div class="pp-avatar-edit-title">用户 ${escapeHtml(user.name)}</div>
                    ${userSrc ? `<img class="pp-avatar-preview" src="${escapeHtml(userSrc)}" alt="" />` : '<div class="pp-avatar-preview pp-msg-avatar-empty"></div>'}
                    <button type="button" class="pp-secondary-btn" id="pp-pick-user-avatar">上传用户头像</button>
                </div>
            </div>
        `,
        onOk: () => {
            const picked = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="pp_avatar_mode"]:checked'));
            getSettings().avatarDisplayMode = picked?.value === 'both' ? 'both' : 'none';
            persistSettingsNow();
            updateHeader();
            renderMessages();
            toastr?.success?.('头像设置已保存');
        },
    });

    setTimeout(() => {
        document.getElementById('pp-pick-char-avatar')?.addEventListener('click', () => {
            pendingAvatarTarget = 'char';
            document.getElementById('pp-avatar-file')?.click();
        });
        document.getElementById('pp-pick-user-avatar')?.addEventListener('click', () => {
            pendingAvatarTarget = 'user';
            document.getElementById('pp-avatar-file')?.click();
        });
    }, 0);
}

function listTavernPersonas() {
    const map = power_user?.personas || {};
    return Object.entries(map).map(([avatarId, name]) => ({
        avatarId,
        name: String(name || avatarId),
        description: String(power_user?.persona_descriptions?.[avatarId]?.description || ''),
        current: avatarId === user_avatar,
        thumb: typeof getContext().getThumbnailUrl === 'function'
            ? getContext().getThumbnailUrl('persona', avatarId)
            : getUserAvatar(avatarId),
    })).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function openPersonaSwitcher() {
    const list = listTavernPersonas();
    if (!list.length) {
        toastr?.warning?.('酒馆里还没有 User 身份卡');
        return;
    }
    const user = getActiveUserInfo();
    openModal({
        title: '切换 User 身份',
        bodyHtml: `
            <p class="pp-help">当前：${escapeHtml(user.name)}。列表来自酒馆 User 身份卡，切换后与外面身份同步。</p>
            <div class="pp-persona-list" id="pp-persona-list">
                ${list.map(p => `
                    <button type="button" class="pp-persona-item${p.current ? ' is-current' : ''}" data-persona-id="${escapeHtml(p.avatarId)}">
                        ${p.thumb ? `<img src="${escapeHtml(p.thumb)}" alt="" />` : '<div class="pp-msg-avatar-empty"></div>'}
                        <span class="pp-persona-meta">
                            <strong>${escapeHtml(p.name)}</strong>
                            <small>${escapeHtml(truncate(p.description || '无描述', 60))}</small>
                        </span>
                        ${p.current ? '<em>使用中</em>' : ''}
                    </button>
                `).join('')}
            </div>
        `,
        onOk: () => true,
    });

    setTimeout(() => {
        document.getElementById('pp-persona-list')?.addEventListener('click', async e => {
            const btn = /** @type {HTMLElement} */ (e.target)?.closest?.('[data-persona-id]');
            if (!btn) return;
            const id = btn.getAttribute('data-persona-id');
            if (!id || id === user_avatar) {
                closeModal();
                return;
            }
            try {
                await setUserAvatar(id, { toastPersonaNameChange: true });
                // 切身份后默认跟酒馆头像；若之前有自定义用户头像可保留，这里不强制清空
                updateHeader();
                renderMessages();
                closeModal();
                toastr?.success?.(`已切换为 ${power_user.personas?.[id] || id}`);
            } catch (err) {
                console.warn('[st-pocket-phone] switch persona failed', err);
                toastr?.error?.('切换 User 失败');
            }
        });
    }, 0);
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('read failed'));
        reader.readAsDataURL(file);
    });
}

function bindBubbleInteractions(root) {
    const box = root.querySelector('#pocket-phone-messages');
    const menu = root.querySelector('#pp-bubble-menu');
    if (!box || !menu) return;

    const clearTimer = () => {
        if (bubbleLongPressTimer) {
            clearTimeout(bubbleLongPressTimer);
            bubbleLongPressTimer = null;
        }
    };

    const startPress = (bubble, clientX, clientY) => {
        clearTimer();
        const idx = Number(bubble.getAttribute('data-idx'));
        if (!Number.isFinite(idx) || !activeThread[idx] || activeThread[idx].role === 'meta') return;
        bubbleLongPressTimer = setTimeout(() => {
            bubbleLongPressTimer = null;
            showBubbleMenu(idx, clientX, clientY);
        }, 480);
    };

    box.addEventListener('pointerdown', e => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (t?.closest?.('[data-think-toggle], [data-think-panel], [data-i18n-toggle]')) return;
        const bubble = t?.closest?.('.pocket-phone-bubble');
        if (!bubble || bubble.classList.contains('meta')) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        startPress(bubble, e.clientX, e.clientY);
    });
    box.addEventListener('pointerup', clearTimer);
    box.addEventListener('pointercancel', clearTimer);
    box.addEventListener('pointermove', e => {
        if (!bubbleLongPressTimer) return;
        // 轻微滑动就取消长按
        if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) clearTimer();
    });
    box.addEventListener('contextmenu', e => {
        const bubble = /** @type {HTMLElement} */ (e.target)?.closest?.('.pocket-phone-bubble');
        if (!bubble || bubble.classList.contains('meta')) return;
        e.preventDefault();
        const idx = Number(bubble.getAttribute('data-idx'));
        if (!Number.isFinite(idx)) return;
        showBubbleMenu(idx, e.clientX, e.clientY);
    });

    menu.addEventListener('click', e => {
        const btn = /** @type {HTMLElement} */ (e.target)?.closest?.('[data-bubble-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-bubble-act');
        const idx = bubbleMenuIndex;
        hideBubbleMenu();
        if (idx == null) return;
        if (act === 'edit') editBubbleAt(idx);
        else if (act === 'delete') deleteBubbleAt(idx);
        else if (act === 'reroll') void rerollBubbleAt(idx);
    });

    box.addEventListener('click', e => {
        const thinkToggle = /** @type {HTMLElement} */ (e.target)?.closest?.('[data-think-toggle]');
        if (thinkToggle) {
            e.preventDefault();
            e.stopPropagation();
            const bubble = thinkToggle.closest('.pocket-phone-bubble');
            const idx = Number(bubble?.getAttribute('data-idx'));
            if (!Number.isFinite(idx) || !activeThread[idx]) return;
            activeThread[idx].thinkingOpen = !activeThread[idx].thinkingOpen;
            persistThread();
            renderMessages();
            return;
        }

        const toggle = /** @type {HTMLElement} */ (e.target)?.closest?.('[data-i18n-toggle]');
        if (!toggle) return;
        e.preventDefault();
        e.stopPropagation();
        const bubble = toggle.closest('.pocket-phone-bubble');
        const idx = Number(bubble?.getAttribute('data-idx'));
        if (!Number.isFinite(idx) || !activeThread[idx]) return;
        activeThread[idx].i18nCollapsed = !activeThread[idx].i18nCollapsed;
        persistThread();
        renderMessages();
    });

    root.addEventListener('click', e => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (t.closest('#pp-bubble-menu') || t.closest('.pocket-phone-bubble')) return;
        hideBubbleMenu();
    });
}

function showBubbleMenu(idx, clientX, clientY) {
    const menu = /** @type {HTMLElement|null} */ (document.getElementById('pp-bubble-menu'));
    const root = document.getElementById('pocket-phone-root');
    if (!menu || !root) return;
    bubbleMenuIndex = idx;
    const msg = activeThread[idx];
    const rerollBtn = /** @type {HTMLElement|null} */ (menu.querySelector('[data-bubble-act="reroll"]'));
    if (rerollBtn) {
        rerollBtn.style.display = msg && (msg.role === 'char' || msg.role === 'voice' || msg.role === 'user')
            ? ''
            : 'none';
    }

    menu.classList.add('pp-bubble-menu-open');
    menu.setAttribute('aria-hidden', 'false');
    const rootRect = root.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rootRect.left, 12), rootRect.width - 140);
    const y = Math.min(Math.max(clientY - rootRect.top - 8, 56), rootRect.height - 140);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
}

function hideBubbleMenu() {
    bubbleMenuIndex = null;
    const menu = document.getElementById('pp-bubble-menu');
    menu?.classList.remove('pp-bubble-menu-open');
    menu?.setAttribute('aria-hidden', 'true');
}

function editBubbleAt(idx) {
    const msg = activeThread[idx];
    if (!msg || msg.role === 'meta') return;
    openModal({
        title: '编辑消息',
        bodyHtml: `<textarea id="pp-edit-bubble-text" rows="6">${escapeHtml(msg.text)}</textarea>`,
        onOk: () => {
            const next = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-edit-bubble-text'))?.value ?? '';
            const trimmed = next.trim();
            if (!trimmed) {
                toastr?.warning?.('内容不能为空');
                return false;
            }
            msg.text = trimmed;
            persistThread();
            renderMessages();
            toastr?.success?.('已更新');
        },
    });
}

function deleteBubbleAt(idx) {
    const msg = activeThread[idx];
    if (!msg || msg.role === 'meta') return;
    if (!window.confirm('删除这条消息？')) return;
    activeThread.splice(idx, 1);
    persistThread();
    renderMessages();
}

/**
 * 一次模型回复可能拆成多条气泡，共用 replyGroupId。
 * 无 id 的旧数据：按连续 char/voice 当作一组。
 * @param {number} idx
 * @returns {{ start: number, end: number } | null}
 */
function findReplyGroupRange(idx) {
    const msg = activeThread[idx];
    if (!msg || (msg.role !== 'char' && msg.role !== 'voice')) return null;

    if (msg.replyGroupId) {
        const gid = msg.replyGroupId;
        let start = idx;
        let end = idx + 1;
        while (start > 0 && activeThread[start - 1].replyGroupId === gid) start -= 1;
        while (end < activeThread.length && activeThread[end].replyGroupId === gid) end += 1;
        return { start, end };
    }

    let start = idx;
    let end = idx + 1;
    while (start > 0) {
        const prev = activeThread[start - 1];
        if (prev.role !== 'char' && prev.role !== 'voice') break;
        start -= 1;
    }
    while (end < activeThread.length) {
        const next = activeThread[end];
        if (next.role !== 'char' && next.role !== 'voice') break;
        end += 1;
    }
    return { start, end };
}

/** 取某次角色回复正前方的连续用户气泡文案 */
function findUserBundleBefore(startIdx) {
    const users = [];
    let i = startIdx - 1;
    while (i >= 0 && activeThread[i].role === 'meta') i -= 1;
    while (i >= 0 && activeThread[i].role === 'user') {
        users.unshift(activeThread[i].text);
        i -= 1;
    }
    return users;
}

/** 用户气泡后紧跟的一次角色回复区间 */
function findReplyGroupAfterUser(userIdx) {
    let i = userIdx + 1;
    while (i < activeThread.length && activeThread[i].role === 'meta') i += 1;
    // 跳过同轮其它用户气泡
    while (i < activeThread.length && activeThread[i].role === 'user') i += 1;
    while (i < activeThread.length && activeThread[i].role === 'meta') i += 1;
    if (i >= activeThread.length) return null;
    if (activeThread[i].role !== 'char' && activeThread[i].role !== 'voice') return null;
    return findReplyGroupRange(i);
}

async function rerollBubbleAt(idx) {
    const msg = activeThread[idx];
    if (!msg || msg.role === 'meta') return;
    if (isGenerating) {
        toastr?.info?.('正在生成中，请稍候');
        return;
    }

    if (msg.role === 'user') {
        // 找到这轮用户消息对应的整组角色回复删掉，再按这些用户文案重生成
        let userStart = idx;
        while (userStart > 0 && activeThread[userStart - 1].role === 'user') userStart -= 1;
        let userEnd = idx;
        while (userEnd + 1 < activeThread.length && activeThread[userEnd + 1].role === 'user') userEnd += 1;

        const users = [];
        for (let i = userStart; i <= userEnd; i++) {
            if (activeThread[i].role === 'user') users.push(activeThread[i].text);
        }
        const replyRange = findReplyGroupAfterUser(userEnd);
        const insertAt = replyRange ? replyRange.start : userEnd + 1;
        if (replyRange) {
            activeThread.splice(replyRange.start, replyRange.end - replyRange.start);
        }
        // 清掉夹在中间的 meta 失败提示
        while (insertAt < activeThread.length && activeThread[insertAt]?.role === 'meta') {
            activeThread.splice(insertAt, 1);
        }
        for (let i = userStart; i <= Math.min(userEnd, activeThread.length - 1); i++) {
            if (activeThread[i]?.role === 'user') activeThread[i].pending = true;
        }
        persistThread();
        renderMessages();
        await generateModelReply(users, { insertAt });
        return;
    }

    if (msg.role === 'char' || msg.role === 'voice') {
        const range = findReplyGroupRange(idx);
        if (!range) return;
        const users = findUserBundleBefore(range.start);
        if (!users.length) {
            toastr?.warning?.('找不到对应的用户消息，无法重 roll');
            return;
        }
        const insertAt = range.start;
        activeThread.splice(range.start, range.end - range.start);
        for (let i = insertAt - 1; i >= 0; i--) {
            if (activeThread[i].role === 'user') activeThread[i].pending = true;
            else if (activeThread[i].role === 'char' || activeThread[i].role === 'voice') break;
        }
        persistThread();
        renderMessages();
        // 必须走专用插入：不能依赖「末尾 pending」，否则中间轮次重 roll 会空跑
        await generateModelReply(users, { insertAt });
    }
}

function collectPendingUserTexts() {
    const pending = [];
    for (let i = activeThread.length - 1; i >= 0; i--) {
        const m = activeThread[i];
        if (m.role === 'char' || m.role === 'voice') break;
        if (m.role === 'user' && m.pending) pending.unshift(m.text);
    }
    // 兼容：末尾用户都没标 pending 时，仍收集末尾连续用户（点「请求回复」）
    if (pending.length) return pending;
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

/** 思维块开/闭标签名（用于深度判断与剥离） */
const PP_THINK_TAG_NAMES = [
    'think', 'thinking', 'thought', 'reasoning', 'reason',
    'redacted_reasoning', 'chain_of_thought', 'cot', 'analysis',
    'scratchpad', 'inner_monologue', 'reflection',
];

/**
 * 统计一段文本里未闭合的思维开标签深度（>0 表示仍在思维块内）。
 * 思维里举例写的 <msg> 不应降低深度。
 */
function unclosedThinkDepth(text) {
    const re = new RegExp(`</?(?:${PP_THINK_TAG_NAMES.join('|')})\\b[^>]*>`, 'gi');
    let depth = 0;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
        if (m[0].startsWith('</')) depth = Math.max(0, depth - 1);
        else depth += 1;
    }
    return depth;
}

/**
 * 查找「独立成行」的尾部 <msg>/<voice> 气泡区起点。
 * 行内举例（如：请使用 <msg>…</msg>）不会算作气泡区。
 * @returns {number} 起点下标；没有则 -1
 */
function findTrailingBubbleRegionStart(text) {
    const s = String(text || '');
    const re = /(?:^|\n)[ \t]*<(msg|voice)\b[^>]*>[\s\S]*?<\/\1>/gi;
    /** @type {{ index: number, end: number }[]} */
    const hits = [];
    let m;
    while ((m = re.exec(s)) !== null) {
        const rawIdx = m.index;
        const lead = m[0].match(/^\n/);
        const index = lead ? rawIdx + 1 : rawIdx;
        hits.push({ index, end: rawIdx + m[0].length });
    }
    if (!hits.length) return -1;

    let endPos = s.length;
    let i = hits.length - 1;
    while (i >= 0) {
        const after = s.slice(hits[i].end, endPos);
        if (after.trim() !== '') break;
        endPos = hits[i].index;
        i -= 1;
    }
    const first = i + 1;
    if (first >= hits.length) return -1;
    return hits[first].index;
}

/**
 * 从模型原文里抽出「预设要求的」思维链标签，并返回洗净后的可见正文。
 * 注意：不要把 API 原生 reasoning_content 混进来（那是另一路）。
 * 未闭合思维块时，不会因为块内举例写的 <msg> 而被截断；只在「独立成行」的尾部气泡前结束。
 * @param {string} raw
 * @param {{ allowUnclosed?: boolean }} [opts]
 * @returns {{ clean: string, thinking: string }}
 */
function extractThinkingFromText(raw, opts = {}) {
    const allowUnclosed = opts.allowUnclosed !== false;
    let text = String(raw || '');
    /** @type {string[]} */
    const parts = [];
    const pushPart = (body) => {
        const t = String(body || '')
            .replace(/^[\s\u200b]+|[\s\u200b]+$/g, '')
            .trim();
        if (t) parts.push(t);
    };

    const closeAlt = PP_THINK_TAG_NAMES.join('|');
    for (const name of PP_THINK_TAG_NAMES) {
        const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:${closeAlt})>`, 'gi');
        text = text.replace(re, (_, body) => {
            pushPart(body);
            return '\n';
        });
    }

    // DeepSeek / 特殊分隔符（已闭合）
    text = text.replace(/<\|begin_of_thought\|>([\s\S]*?)<\|end_of_thought\|>/gi, (_, body) => {
        pushPart(body);
        return '\n';
    });
    text = text.replace(/<\|thinking\|>([\s\S]*?)(?:<\/thinking>|<\|\/thinking\|>|<\|end_thinking\|>)/gi, (_, body) => {
        pushPart(body);
        return '\n';
    });
    text = text.replace(/◁think▷([\s\S]*?)◁\/think▷/gi, (_, body) => {
        pushPart(body);
        return '\n';
    });
    text = text.replace(/\[THINK\]([\s\S]*?)\[\/THINK\]/gi, (_, body) => {
        pushPart(body);
        return '\n';
    });

    // 方括号 / 中文包裹
    text = text.replace(/\[(?:thinking|thought|reasoning|think|cot|分析|思考|推理|思维链)\]([\s\S]*?)\[\/(?:thinking|thought|reasoning|think|cot|分析|思考|推理|思维链)\]/gi, (_, body) => {
        pushPart(body);
        return '\n';
    });
    text = text.replace(/【(?:思考|思维链|推理|内心独白)】([\s\S]*?)【\/(?:思考|思维链|推理|内心独白)】/g, (_, body) => {
        pushPart(body);
        return '\n';
    });

    // markdown fence
    text = text.replace(/```(?:thinking|thought|reasoning|reason|analysis|think|cot|scratchpad)[^\n]*\n([\s\S]*?)```/gi, (_, body) => {
        pushPart(body);
        return '\n';
    });

    if (allowUnclosed) {
        // markdown 标题思维块：只在「独立成行」气泡前结束
        text = text.replace(/(?:^|\n)#{1,3}\s*(?:thinking|thought|reasoning|analysis|思考|推理|思维链)\s*\n([\s\S]*?)(?=\n#{1,3}\s|(?:\r?\n)[ \t]*<(?:msg|voice)\b|$)/gi, (_, body) => {
            pushPart(body);
            return '\n';
        });

        // 未闭合 XML 思维块：行内举例 <msg> 不截断；只切在成行气泡前
        const openThinkRe = new RegExp(`<(${closeAlt})\\b[^>]*>`, 'i');
        const openHit = text.match(openThinkRe);
        if (openHit && openHit.index != null) {
            const openIdx = openHit.index;
            const bodyStart = openIdx + openHit[0].length;
            const after = text.slice(bodyStart);
            const trailRel = findTrailingBubbleRegionStart(after);
            if (trailRel >= 0) {
                pushPart(after.slice(0, trailRel));
                text = `${text.slice(0, openIdx)}\n${after.slice(trailRel)}`;
            } else {
                pushPart(after);
                text = text.slice(0, openIdx);
            }
        }

        text = text.replace(/<\|begin_of_thought\|>([\s\S]*?)(?=(?:\r?\n)[ \t]*<(?:msg|voice)\b|<\|end_of_thought\|>|$)/gi, (_, body) => {
            pushPart(body);
            return '\n';
        });

        // 终态再清残留标签
        text = text.replace(new RegExp(`</?(?:${closeAlt})\\b[^>]*>`, 'gi'), '');
        text = text.replace(/<\|(?:begin_of_thought|end_of_thought|thinking|\/thinking|end_thinking)\|>/gi, '');
        text = text.replace(/◁\/?think▷/gi, '');
        text = text.replace(/\[\/?(?:THINK|thinking|thought|reasoning|think|cot|分析|思考|推理|思维链)\]/gi, '');
    }

    return {
        clean: text.replace(/\n{3,}/g, '\n\n').trim(),
        thinking: parts.join('\n\n').trim(),
    };
}

function mergeThinkingParts(...chunks) {
    const seen = new Set();
    const out = [];
    for (const c of chunks) {
        const t = String(c || '').trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out.join('\n\n').trim();
}

/**
 * Parse Rich Message Protocol tags from model output.
 * @param {string} raw
 * @returns {{ role: 'char' | 'voice', text: string }[]}
 */
function parsePhoneReply(raw) {
    const { clean } = extractThinkingFromText(raw, { allowUnclosed: true });
    const text = String(clean || '').trim();
    const out = [];
    // 只认独立成行的气泡，避免思维/说明里的行内 <msg> 举例被当成短信
    const re = /(?:^|\n)[ \t]*<(msg|voice|sticker|ima)\b[^>]*>([\s\S]*?)<\/\1>/gi;
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

/**
 * 流式增量解析：
 * - 中段只剥已闭合思维块
 * - 未闭合思维块内的行内 <msg> 举例不触发出泡、也不截断思维
 * - 仅「独立成行」的 <msg>/<voice> 在思维块之外（或终态尾部气泡区）才出泡
 * @param {(bubble: { role: 'char' | 'voice', text: string }) => (void|Promise<void>)} onBubble
 */
function createTagStreamParser(onBubble) {
    let buf = '';
    let emitted = 0;
    let thinking = '';
    // 必须独立成行，避免「请使用 <msg>…</msg>」这类举例被当成气泡
    const tagRe = /(?:^|\n)[ \t]*<(msg|voice)\b[^>]*>([\s\S]*?)<\/\1>/i;

    const takeClosedThinking = () => {
        const extracted = extractThinkingFromText(buf, { allowUnclosed: false });
        if (extracted.thinking) thinking = mergeThinkingParts(thinking, extracted.thinking);
        buf = extracted.clean;
    };

    /** 若已出现成行尾部气泡，且前面还有未闭合思维，则先收思维 */
    const takeUnclosedThinkingBeforeTrailingBubbles = () => {
        if (unclosedThinkDepth(buf) <= 0) return;
        const trailAt = findTrailingBubbleRegionStart(buf);
        if (trailAt < 0) return;
        const head = buf.slice(0, trailAt);
        const extracted = extractThinkingFromText(head, { allowUnclosed: true });
        if (extracted.thinking) thinking = mergeThinkingParts(thinking, extracted.thinking);
        // head 里不应再残留成行气泡；拼回尾部气泡区
        buf = `${extracted.clean}\n${buf.slice(trailAt)}`.replace(/^\n+/, '');
    };

    const drain = async () => {
        takeClosedThinking();
        takeUnclosedThinkingBeforeTrailingBubbles();
        while (true) {
            const m = buf.match(tagRe);
            if (!m || m.index == null) break;

            // 仍在未闭合思维块内：哪怕匹配到成行 <msg>，也先等思维收束（或 end 时再拆尾部）
            const before = buf.slice(0, m.index);
            if (unclosedThinkDepth(before) > 0) break;

            const full = m[0];
            const tag = m[1].toLowerCase();
            const body = String(m[2] || '').trim();
            buf = buf.slice(m.index + full.length).replace(/^\n/, '');
            if (!body) continue;
            emitted += 1;
            await onBubble({
                role: tag === 'voice' ? 'voice' : 'char',
                text: body,
            });
        }
    };

    return {
        async push(chunk) {
            if (!chunk) return;
            buf += String(chunk);
            await drain();
        },
        /** @returns {Promise<number>} */
        async end() {
            await drain();
            const restExtract = extractThinkingFromText(buf, { allowUnclosed: true });
            if (restExtract.thinking) thinking = mergeThinkingParts(thinking, restExtract.thinking);
            const rest = restExtract.clean.trim();
            buf = '';
            if (!rest) return emitted;
            const hasTagged = /(?:^|\n)[ \t]*<(?:msg|voice)\b/i.test(rest);
            // 已出过泡时：只继续吐剩余标签泡，避免把说明残片按纯文本拆成假气泡
            if (emitted > 0 && !hasTagged) return emitted;
            for (const b of parsePhoneReply(rest)) {
                emitted += 1;
                await onBubble(b);
            }
            return emitted;
        },
        get emitted() { return emitted; },
        getThinking() { return thinking; },
    };
}

function fillPresetTemplate(tpl, vars) {
    let out = String(tpl || '');
    for (const [k, v] of Object.entries(vars)) {
        out = out.split(`{{${k}}}`).join(String(v ?? ''));
    }
    return out;
}

/** 小手机线程里的最近短信（仅作 quiet 任务补充；人设/WI/开场白走酒馆预设链路） */
function formatSmsHistoryForPrompt() {
    const ch = getActiveCharacter();
    const user = getActiveUserInfo();
    return activeThread
        .filter(m => m.role === 'user' || m.role === 'char' || m.role === 'voice')
        .slice(-24)
        .map(m => {
            const text = stripI18nForHistory(m.text);
            if (m.role === 'user') return `${user.name}: ${text}`;
            if (m.role === 'voice') return `${ch?.name || '角色'} <voice>: ${text}`;
            return `${ch?.name || '角色'}: ${text}`;
        })
        .join('\n');
}

/**
 * 酒馆模式：只构造 quiet 任务说明。
 * 角色卡 / 开场白 / 世界书 / 维纳斯提示词条目 → 全部交给 Generate + PromptManager。
 */
function getPhoneMemorySummary(key = boundCharacterKey || threadKey(), chatId = getMainChatId()) {
    const ov = getCharacterOverride(key);
    if (!ov.memoryByChat || typeof ov.memoryByChat !== 'object') ov.memoryByChat = {};
    const cid = chatScopeId(chatId);
    // 旧版按角色单份记忆 → 迁到当前主聊作用域一次
    if (typeof ov.memorySummary === 'string' && ov.memorySummary.trim()) {
        if (!ov.memoryByChat[cid]) ov.memoryByChat[cid] = ov.memorySummary;
        delete ov.memorySummary;
        persistSettingsNow();
    }
    return String(ov.memoryByChat[cid] || '').trim();
}

function setPhoneMemorySummary(text, key = boundCharacterKey || threadKey(), chatId = getMainChatId()) {
    const ov = getCharacterOverride(key);
    if (!ov.memoryByChat || typeof ov.memoryByChat !== 'object') ov.memoryByChat = {};
    ov.memoryByChat[chatScopeId(chatId)] = String(text || '').trim();
    if (Object.prototype.hasOwnProperty.call(ov, 'memorySummary')) delete ov.memorySummary;
    persistSettingsNow();
}

function buildPhoneTaskPrompt(userBundle) {
    const user = getActiveUserInfo();
    const history = formatSmsHistoryForPrompt();
    const memory = getPhoneMemorySummary();
    const lang = getLanguageMacroValue();
    const langHint = getSettings().multilangEnabled && lang
        ? `\n本轮目标语言 {{Language}} = ${lang}。请按预设中的多语言条目用该语言回复并附中文 <i18n>。`
        : '';
    // 格式 / 语音 / 多语言 已作为 PromptManager 强制条目注入，quiet 任务不再重复塞一遍
    return applyPhoneLanguageMacros(`【小手机短信任务】
这是手机短信私聊回合。请严格遵循「当前已启用的聊天补全预设」中的全部提示词、输出协议与格式（含多语言 / <msg> / <i18n> / 语音条 / 思维链规则等）。
若预设要求输出思维链 / 思考过程（如 <think>、<thinking>、<analysis> 等），必须按预设规定的标签与结构完整输出，再输出短信标签。
不要改用其它格式；不要输出旁白、系统说明或协议解释。${langHint}

【小手机总结记忆｜长期】
${memory || '（暂无总结记忆，仅依据主聊天与近期短信）'}

【最近短信】
${history || '（尚无短信历史）'}

【${user.name} 本轮发出的短信】
${userBundle}

请立刻按当前预设协议发送回复。`);
}

async function generateViaMemoryModel(prompt) {
    saveMemoryPageForm();
    const s = getSettings();
    if (s.memoryApiMode === 'custom') {
        const url = resolveCustomEndpoint(s.memoryApiUrl || s.apiUrl);
        const model = String(s.memoryApiModel || s.apiModel || '').trim();
        const key = String(s.memoryApiKey || s.apiKey || '').trim();
        if (!model) throw new Error('请填写压缩用 Model');
        if (!key) throw new Error('请填写压缩用 API Key');
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: 'You compress phone SMS roleplay memory. Output only the summary.' },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.4,
                max_tokens: 1200,
                stream: true,
            }),
        });
        if (!res.ok) {
            throw new Error(`压缩 API ${res.status}: ${truncate(await res.text().catch(() => ''), 160)}`);
        }
        let out = '';
        await consumeOpenAICompatStream(res, d => { out += d; });
        return out.trim();
    }
    // 跟随对话：自定义对话 API / 酒馆链路
    if (s.apiMode === 'custom') {
        let out = '';
        await generateViaCustomApiStream(prompt, d => { out += d; });
        return out.trim();
    }
    return String(await generateViaSt(prompt) || '').trim();
}

function buildMemoryCompressAsk(transcript, prevSummary) {
    return `${getMemorySummaryPrompt()}

【已有摘要（可合并修订）】
${prevSummary || '（无）'}

【近期短信】
${transcript}
`;
}

async function autoSummarizePhoneMemory() {
    const ch = getActiveCharacter();
    if (!ch) {
        toastr?.warning?.('请先选择角色');
        return;
    }
    if (boundCharacterKey !== ch.key) loadThread();
    saveMemoryPageForm();

    const history = formatSmsHistoryForPrompt();
    if (!history.trim()) {
        toastr?.info?.('当前没有可总结的短信');
        return;
    }
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('pp-memory-compress'));
    const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-memory-text'));
    if (btn) {
        btn.disabled = true;
        btn.textContent = '压缩中…';
    }
    try {
        const tokens = await countPromptTokens(history);
        const limit = getMemoryTokenLimit();
        if (tokens <= limit) {
            const go = window.confirm(
                `当前约 ${tokens} tokens，尚未超过阈值 ${limit}。仍要手动压缩吗？`,
            );
            if (!go) return;
        }
        const ask = buildMemoryCompressAsk(history, getPhoneMemorySummary(ch.key));
        const summary = await generateViaMemoryModel(ask);
        if (!summary) throw new Error('模型未返回摘要');
        if (ta) ta.value = summary;
        setPhoneMemorySummary(summary, ch.key);
        await syncMemoryPage();
        toastr?.success?.('已压缩并写入总结记忆');
    } catch (err) {
        console.warn('[st-pocket-phone] memory summarize failed', err);
        toastr?.error?.(`压缩失败：${err?.message || err}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '立即压缩短信';
        }
    }
}

/**
 * 自定义 API 模式兜底：仍用本地模板（自定义端不走酒馆 PromptManager）。
 * 酒馆模式请用 buildPhoneTaskPrompt + Generate 装配。
 */
function buildGenerationPrompt(userBundle) {
    const ch = getActiveCharacter();
    const user = getActiveUserInfo();
    const s = getSettings();
    const history = formatSmsHistoryForPrompt();
    const firstMes = String(ch?.firstMes || '').trim();
    const mesExamples = String(ch?.mesExamples || '').trim();
    const injectMain = s.injectMainChatContext !== false;
    const mainLimit = Math.max(0, Number(s.mainChatInjectCount) || 12);
    const mainChat = injectMain ? getMainChatHistorySnippet(mainLimit) : '';

    const preset = s.presetPrompt || FALLBACK_PRESET;
    let prompt = fillPresetTemplate(preset, {
        char: ch?.name || '角色',
        user: user.name,
        char_description: truncate(ch?.description || '', 2500),
        char_personality: truncate(ch?.personality || '', 1200),
        char_scenario: truncate(ch?.scenario || '', 1200),
        char_first_mes: truncate(firstMes, 1800),
        first_mes: truncate(firstMes, 1800),
        char_examples: truncate(mesExamples, 1600),
        user_description: truncate(user.description || '', 1000),
        sms_history: history || '（尚无历史）',
        main_chat_history: mainChat || '（主聊天暂无可用上下文）',
        user_input: userBundle,
        phone_memory: getPhoneMemorySummary(),
    });

    const memory = getPhoneMemorySummary();
    if (memory) {
        prompt = `${prompt.trim()}

【小手机总结记忆】
${memory}
`;
    }

    // 自定义 API 不走 PromptManager：本地拼上强制规则
    prompt = `${prompt.trim()}

${getPhoneFormatPrompt()}

${getPhoneStylePrompt()}

${getVoiceProtocolHintForGenerate()}
`;
    if (s.multilangEnabled) {
        prompt = `${prompt.trim()}\n\n${applyPhoneLanguageMacros(getPhoneMultilangPrompt())}\n`;
    }
    return applyPhoneLanguageMacros(prompt);
}

function resolveCustomEndpoint(baseUrl) {
    const raw = String(baseUrl || '').trim().replace(/\/$/, '');
    if (!raw) throw new Error('请填写 API Base URL');
    if (/\/chat\/completions\/?$/.test(raw)) return raw;
    if (/\/v1$/.test(raw)) return `${raw}/chat/completions`;
    return `${raw}/v1/chat/completions`;
}

function buildPhoneSystemPrompt() {
    // 仅自定义 API 兜底；酒馆模式以用户预设 PromptManager 为准，不再用这段顶替
    return getSettings().multilangEnabled
        ? '你是短信回复器。只输出 XML 消息标签。非中文母语时用 <msg>母语 <i18n>中文</i18n></msg>。'
        : '你是短信回复器。只输出 XML 消息标签。';
}

/**
 * dryRun 一次酒馆 Generate('quiet')，截获 PromptManager 装配好的完整 messages。
 * 这样会吃到：当前小手机选用的 CC 预设条目、角色卡、开场白、世界书、主聊天等。
 * @param {string} quietPrompt
 * @returns {Promise<object[]>}
 */
async function assembleMessagesFromPhonePreset(quietPrompt) {
    ensurePhonePresetForGenerate();
    const ctx = getContext();
    if (typeof ctx.generate !== 'function') {
        throw new Error('当前酒馆未暴露 generate，无法装配预设提示词');
    }

    /** @type {any[]|null} */
    let captured = null;

    const onPromptReady = (data) => {
        if (Array.isArray(data?.chat) && data.chat.length) {
            captured = data.chat;
        }
    };
    const onAfterData = (generateData) => {
        if (Array.isArray(generateData?.prompt) && generateData.prompt.length) {
            captured = generateData.prompt;
        }
    };

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.GENERATE_AFTER_DATA, onAfterData);
    try {
        await ctx.generate('quiet', {
            quiet_prompt: quietPrompt,
            quietToLoud: false,
            skipWIAN: false,
            force_name2: true,
        }, true);
    } finally {
        eventSource.removeListener(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
        eventSource.removeListener(event_types.GENERATE_AFTER_DATA, onAfterData);
    }

    if (!Array.isArray(captured) || !captured.length) {
        throw new Error('预设装配失败：未截获到消息列表（请确认主 API 为 Chat Completion，且已选择小手机预设）');
    }

    return captured
        .filter(m => m && typeof m === 'object' && m.role)
        .map(m => {
            /** @type {{ role: string, content: any, name?: string }} */
            const out = { role: m.role, content: m.content };
            if (typeof out.content === 'string') {
                out.content = applyPhoneLanguageMacros(out.content);
            } else if (Array.isArray(out.content)) {
                out.content = out.content.map(part => {
                    if (part && typeof part === 'object' && typeof part.text === 'string') {
                        return { ...part, text: applyPhoneLanguageMacros(part.text) };
                    }
                    return part;
                });
            }
            if (m.name) out.name = m.name;
            if (m.tool_calls) out.tool_calls = m.tool_calls;
            return out;
        });
}

/** 让出两帧 + 短延迟，确保浏览器先把当前气泡画出来，再处理下一条 */
function yieldToPaint() {
    return new Promise(resolve => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                setTimeout(resolve, 120);
            });
        });
    });
}

/**
 * 读取 OpenAI 兼容 SSE / 或整包 JSON。
 * @param {Response} response
 * @param {(delta: string) => (void|Promise<void>)} onDelta
 * @param {(reasoningDelta: string) => (void|Promise<void>)} [onReasoning]
 */
async function consumeOpenAICompatStream(response, onDelta, onReasoning) {
    const streamState = { reasoning: '', images: [], signature: '', toolSignatures: {} };

    if (!response.body) {
        const raw = await response.text();
        const { text, reasoning } = extractTextAndReasoningFromPayload(raw);
        if (reasoning && onReasoning) await onReasoning(reasoning);
        if (text) await onDelta(text);
        return { chunks: text ? 1 : 0, mode: 'text', reasoning: reasoning || '' };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = '';
    let fullBuf = '';
    let chunks = 0;
    let sawSse = false;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const piece = decoder.decode(value, { stream: true });
        fullBuf += piece;
        lineBuf += piece;

        const lines = lineBuf.split(/\r?\n/);
        lineBuf = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (!trimmed.startsWith('data:')) continue;
            sawSse = true;
            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
                const json = JSON.parse(data);
                const beforeReason = streamState.reasoning.length;
                let delta = '';
                try {
                    delta = getStreamingReply(json, streamState) || '';
                } catch {
                    delta = json?.choices?.[0]?.delta?.content
                        ?? json?.choices?.[0]?.text
                        ?? json?.choices?.[0]?.message?.content
                        ?? '';
                    const rd = json?.choices?.[0]?.delta?.reasoning_content
                        ?? json?.choices?.[0]?.delta?.reasoning
                        ?? json?.choices?.[0]?.message?.reasoning_content
                        ?? '';
                    if (rd) streamState.reasoning += String(rd);
                }
                if (onReasoning && streamState.reasoning.length > beforeReason) {
                    await onReasoning(streamState.reasoning.slice(beforeReason));
                }
                if (delta) {
                    chunks += 1;
                    await onDelta(String(delta));
                }
            } catch {
                // ignore
            }
        }
    }

    if (!sawSse && !chunks) {
        const { text, reasoning } = extractTextAndReasoningFromPayload(fullBuf);
        if (reasoning) {
            streamState.reasoning = mergeThinkingParts(streamState.reasoning, reasoning);
            if (onReasoning) await onReasoning(reasoning);
        }
        if (text) {
            await onDelta(text);
            return { chunks: 1, mode: 'json', reasoning: streamState.reasoning };
        }
    }
    return { chunks, mode: sawSse ? 'sse' : 'unknown', reasoning: streamState.reasoning };
}

function extractTextAndReasoningFromPayload(raw) {
    const s = String(raw || '').trim();
    if (!s) return { text: '', reasoning: '' };
    try {
        const data = JSON.parse(s);
        const choice = data?.choices?.[0] || {};
        const msg = choice.message || {};
        const delta = choice.delta || {};
        const text = String(
            msg.content
            || choice.text
            || data?.content
            || '',
        ).trim();
        const reasoning = String(
            msg.reasoning_content
            || msg.reasoning
            || msg.thinking
            || delta.reasoning_content
            || delta.reasoning
            || delta.thinking
            || choice.reasoning_content
            || '',
        ).trim();
        return { text, reasoning };
    } catch {
        return { text: s, reasoning: '' };
    }
}

function extractTextFromCompletionPayload(raw) {
    return extractTextAndReasoningFromPayload(raw).text;
}

/**
 * 自定义 API 流式：token 到达即回调；完整 </msg> 由上层 parser 拆气泡。
 * @param {string} prompt
 * @param {(delta: string) => void} onDelta
 */
/**
 * @param {string} prompt
 * @param {(delta: string) => (void|Promise<void>)} onDelta
 * @param {(reasoningDelta: string) => (void|Promise<void>)} [onReasoning]
 */
async function generateViaCustomApiStream(prompt, onDelta, onReasoning) {
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
                { role: 'system', content: buildPhoneSystemPrompt() },
                { role: 'user', content: prompt },
            ],
            temperature: 0.9,
            max_tokens: 900,
            stream: true,
        }),
    });
    if (!res.ok) {
        throw new Error(`自定义 API ${res.status}: ${truncate(await res.text().catch(() => ''), 160)}`);
    }

    const info = await consumeOpenAICompatStream(res, onDelta, onReasoning);
    console.info('[st-pocket-phone] custom stream', info);
    return info;
}

function ensurePhonePresetForGenerate() {
    if (!phoneSessionActive) return;
    const s = getSettings();
    if (s.phonePresetName) {
        const cur = getCurrentPresetSnapshot()?.name;
        if (cur !== s.phonePresetName) selectPresetByName(s.phonePresetName);
    }
    if (outsideConnectionSnapshot) restoreConnectionSettings(outsideConnectionSnapshot);
    // 仅当已在小手机预设 B 上才写入强制条目
    ensurePocketPhonePresetEntriesIfOnPhone({ render: false, save: true, forceContent: true });
}

async function generateViaSt(quietPrompt) {
    ensurePhonePresetForGenerate();
    const ctx = getContext();
    if (typeof ctx.generateQuietPrompt === 'function') {
        // 完整酒馆链路：当前预设 PromptManager + 角色卡 + WI + 主聊天 + quiet 任务
        return await ctx.generateQuietPrompt({
            quietPrompt,
            quietToLoud: false,
            skipWIAN: false,
        });
    }
    if (typeof ctx.generateRaw === 'function') {
        return await ctx.generateRaw({ prompt: quietPrompt, instructOverride: true });
    }
    throw new Error('当前酒馆未提供生成接口');
}

/**
 * 酒馆真流式：先 dryRun Generate('quiet') 用你选中的预设装配 messages，再 stream 请求。
 * 不再用「system 短句 + 本地拼 prompt」顶替维纳斯/用户预设。
 * @param {string} quietPrompt
 * @param {(delta: string) => (void|Promise<void>)} onDelta
 * @param {(reasoningDelta: string) => (void|Promise<void>)} [onReasoning]
 */
async function generateViaStStream(quietPrompt, onDelta, onReasoning) {
    ensurePhonePresetForGenerate();
    const ctx = getContext();
    const settings = ctx.chatCompletionSettings;
    if (!settings || typeof createGenerationParameters !== 'function' || typeof ctx.generate !== 'function') {
        const raw = String(await generateViaSt(quietPrompt) || '');
        if (raw) await onDelta(raw);
        return;
    }

    let messages;
    try {
        messages = await assembleMessagesFromPhonePreset(quietPrompt);
        console.info('[st-pocket-phone] preset-assembled messages', messages.length);
    } catch (assembleErr) {
        console.warn('[st-pocket-phone] preset assemble failed, fallback generateQuietPrompt', assembleErr);
        const raw = String(await generateViaSt(quietPrompt) || '');
        if (raw) await onDelta(raw);
        return;
    }

    const phoneModel = String(getSettings().apiModel || '').trim();
    const model = phoneModel
        || (typeof ctx.getChatCompletionModel === 'function'
            ? ctx.getChatCompletionModel(settings)
            : getChatCompletionModel(settings))
        || '';

    const { generate_data } = await createGenerationParameters(settings, model, 'quiet', messages);
    generate_data.stream = true;
    if (phoneModel) generate_data.model = phoneModel;

    if (phoneSessionActive && outsideConnectionSnapshot) {
        if (outsideConnectionSnapshot.chat_completion_source) {
            generate_data.chat_completion_source = outsideConnectionSnapshot.chat_completion_source;
        }
        if (Object.prototype.hasOwnProperty.call(outsideConnectionSnapshot, 'custom_url')) {
            generate_data.custom_url = outsideConnectionSnapshot.custom_url;
        }
        if (Object.prototype.hasOwnProperty.call(outsideConnectionSnapshot, 'reverse_proxy')) {
            generate_data.reverse_proxy = outsideConnectionSnapshot.reverse_proxy;
        }
        if (Object.prototype.hasOwnProperty.call(outsideConnectionSnapshot, 'proxy_password')) {
            generate_data.proxy_password = outsideConnectionSnapshot.proxy_password;
        }
    }

    const headers = typeof ctx.getRequestHeaders === 'function'
        ? ctx.getRequestHeaders()
        : { 'Content-Type': 'application/json' };

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify(generate_data),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`酒馆流式 ${response.status}: ${truncate(errText, 160)}`);
    }

    const info = await consumeOpenAICompatStream(response, onDelta, onReasoning);
    console.info('[st-pocket-phone] ST stream', info);
    return info;
}

/**
 * 正确写入酒馆主聊天：必须先 chat.push，再 addOneMessage，再 saveChat。
 * 只调 addOneMessage 只会短暂画 DOM，不会进入 chat history / 存档。
 * @param {object} message
 * @param {{ kind?: 'user' | 'char' }} [opts]
 */
async function appendMessageToMainChat(message, { kind = 'char' } = {}) {
    const ctx = getContext();
    if (!Array.isArray(ctx.chat)) {
        throw new Error('当前没有打开的主聊天');
    }
    if (typeof ctx.addOneMessage !== 'function') {
        throw new Error('当前酒馆无法写入主聊天');
    }

    const msg = {
        ...message,
        send_date: message.send_date || Date.now(),
        extra: {
            ...(message.extra && typeof message.extra === 'object' ? message.extra : {}),
            pocket_phone: true,
        },
    };

    ctx.chat.push(msg);
    const messageId = ctx.chat.length - 1;

    try {
        if (kind === 'user') {
            await eventSource.emit(event_types.MESSAGE_SENT, messageId);
            ctx.addOneMessage(msg);
            await eventSource.emit(event_types.USER_MESSAGE_RENDERED, messageId);
        } else {
            await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');
            ctx.addOneMessage(msg);
            await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
        }
    } catch (err) {
        console.warn('[st-pocket-phone] chat render events failed', err);
        // 事件失败也不回滚：消息已在 chat 数组里
        try { ctx.addOneMessage(msg); } catch (_) { /* ignore */ }
    }

    if (typeof ctx.saveChat === 'function') {
        await ctx.saveChat();
    }
    return messageId;
}

function getPhoneImportState(key = boundCharacterKey || threadKey(), chatId = getMainChatId()) {
    const ov = getCharacterOverride(key);
    if (!ov.importStateByChat || typeof ov.importStateByChat !== 'object') ov.importStateByChat = {};
    const cid = chatScopeId(chatId);
    // 旧版按角色单份游标 → 迁到当前主聊
    if (ov.importState && typeof ov.importState === 'object' && !ov.importStateByChat[cid]) {
        ov.importStateByChat[cid] = {
            lastMemoryFp: ov.importState.lastMemoryFp || '',
            lastMsgTs: Number(ov.importState.lastMsgTs || 0) || 0,
            lastSessionFp: ov.importState.lastSessionFp || '',
        };
        delete ov.importState;
        persistSettingsNow();
    }
    if (!ov.importStateByChat[cid] || typeof ov.importStateByChat[cid] !== 'object') {
        ov.importStateByChat[cid] = { lastMemoryFp: '', lastMsgTs: 0, lastSessionFp: '' };
    }
    return ov.importStateByChat[cid];
}

function fingerprintText(text) {
    const s = String(text || '').trim();
    // 轻量指纹：长度 + 头尾，够去重同内容重复导入
    if (!s) return '';
    const head = s.slice(0, 80);
    const tail = s.slice(-80);
    return `${s.length}:${head}:${tail}`;
}

/** 自上次导入以来的全部短信，拼成「一轮」原文（多气泡也不拆成多轮） */
function formatPhoneTranscriptSince(lastMsgTs = 0) {
    const ch = getActiveCharacter();
    const user = getActiveUserInfo();
    const msgs = activeThread.filter(m => (
        (m.role === 'user' || m.role === 'char' || m.role === 'voice')
        && Number(m.ts || 0) > Number(lastMsgTs || 0)
    ));
    if (!msgs.length && !lastMsgTs) {
        return formatPhoneThreadPlainTranscript();
    }
    return msgs.map(m => {
        const text = stripI18nForHistory(m.text);
        if (m.role === 'user') return `${user.name}: ${text}`;
        if (m.role === 'voice') return `${ch?.name || 'Char'} (voice): ${text}`;
        return `${ch?.name || 'Char'}: ${text}`;
    }).join('\n');
}

/** 将当前角色短信线程格式化为纯文本记录 */
function formatPhoneThreadPlainTranscript() {
    const ch = getActiveCharacter();
    const user = getActiveUserInfo();
    return activeThread
        .filter(m => m.role === 'user' || m.role === 'char' || m.role === 'voice')
        .map(m => {
            const text = stripI18nForHistory(m.text);
            if (m.role === 'user') return `${user.name}: ${text}`;
            if (m.role === 'voice') return `${ch?.name || 'Char'} (voice): ${text}`;
            return `${ch?.name || 'Char'}: ${text}`;
        })
        .join('\n');
}

async function countPromptTokens(text) {
    const ctx = getContext();
    const s = String(text || '');
    if (!s) return 0;
    try {
        if (typeof ctx.getTokenCountAsync === 'function') {
            const n = await ctx.getTokenCountAsync(s);
            if (Number.isFinite(n)) return Math.max(0, Math.round(n));
        }
        if (typeof ctx.getTokenCount === 'function') {
            const n = ctx.getTokenCount(s);
            if (Number.isFinite(n)) return Math.max(0, Math.round(n));
        }
    } catch (err) {
        console.warn('[st-pocket-phone] token count failed', err);
    }
    // 兜底：粗估
    return Math.ceil(s.length / 3.5);
}

/**
 * 包裹效果：
 * 顶部英文注释 → <phone>…</phone> → 底部英文注释（切回线下）
 */
function wrapPhoneBlockForMainChat(innerBody) {
    const ch = getActiveCharacter();
    const user = getActiveUserInfo();
    const charName = ch?.name || 'Char';
    const userName = user.name || 'User';
    const head = `[Note: The following dialogue occurred as an online phone conversation between ${charName} and ${userName}.]`;
    const foot = `[Note: The following new dialogue takes place offline in real life between ${charName} and ${userName}.]`;
    const body = String(innerBody || '').trim() || '(empty)';
    return `${head}\n<phone>\n${body}\n</phone>\n${foot}`;
}

async function compressPhoneTranscript(transcript) {
    const ask = buildMemoryCompressAsk(transcript, getPhoneMemorySummary());
    return generateViaMemoryModel(ask);
}

/**
 * 离开小手机 / 手动导入：整段只写「一条」主聊天记录（一轮注入）。
 * 优先级：
 *  1) 已有压缩记忆（含手动压缩）→ 注入压缩记忆
 *  2) 无记忆但超长 → 自动压缩后注入压缩记忆
 *  3) 无记忆且未超长 → 注入自上次以来的全部原文（多气泡仍是一条）
 * @param {{ auto?: boolean, silent?: boolean, force?: boolean }} [opts]
 */
async function importPhoneThreadToMainChat({ auto = false, silent = false, force = false } = {}) {
    const ch = getActiveCharacter();
    if (!ch) {
        if (!auto) toastr?.warning?.('请先选择角色并进入对话');
        return { ok: false, reason: 'no_char' };
    }
    if (boundCharacterKey !== ch.key) loadThread();
    try { saveMemoryPageForm(); } catch (_) { /* ignore */ }

    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('pp-memory-import-main'));
    if (btn && !auto) btn.disabled = true;

    try {
        const state = getPhoneImportState(ch.key);
        let memory = getPhoneMemorySummary(ch.key);
        const allMsgs = activeThread.filter(m => m.role === 'user' || m.role === 'char' || m.role === 'voice');
        const transcriptAll = formatPhoneThreadPlainTranscript();
        const transcriptNew = formatPhoneTranscriptSince(state.lastMsgTs).trim();
        const hasNewSms = !!transcriptNew;
        const limit = getMemoryTokenLimit();

        // 无记忆且（有全文）时：超长则先自动压缩
        if (!memory && transcriptAll.trim()) {
            const tokens = await countPromptTokens(transcriptAll);
            if (tokens > limit) {
                if (!auto && !force) {
                    const ok = window.confirm(
                        `当前短信约 ${tokens} tokens（>${limit}），将先压缩再作为一轮写入主对话。继续？`,
                    );
                    if (!ok) return { ok: false, reason: 'cancelled' };
                }
                if (btn && !auto) btn.textContent = '压缩中…';
                const compressed = await compressPhoneTranscript(transcriptAll);
                if (!compressed) throw new Error('压缩结果为空');
                setPhoneMemorySummary(compressed, ch.key);
                memory = compressed;
                const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('pp-memory-text'));
                if (ta) ta.value = compressed;
            }
        }

        let inner = '';
        let mode = 'raw';

        if (memory) {
            // 有压缩记忆就优先只用记忆（整段一条）；不回落到原文多轮
            const fp = fingerprintText(memory);
            if (!force && auto && fp && fp === state.lastMemoryFp) {
                // 记忆没变：若期间又聊了且已超长，再压一次后写入；否则跳过
                if (hasNewSms) {
                    const tokens = await countPromptTokens(transcriptAll);
                    if (tokens > limit) {
                        if (btn && !auto) btn.textContent = '压缩中…';
                        const compressed = await compressPhoneTranscript(transcriptAll);
                        if (!compressed) throw new Error('压缩结果为空');
                        setPhoneMemorySummary(compressed, ch.key);
                        memory = compressed;
                    } else {
                        if (!silent) toastr?.info?.('已有压缩记忆且未超长，未重复导入（可手动压缩后再关）');
                        // 仍推进游标，避免反复提示；原文等用户压缩后再以记忆形式导入
                        if (allMsgs.length) {
                            state.lastMsgTs = Math.max(...allMsgs.map(m => Number(m.ts || 0)));
                            persistSettingsNow();
                        }
                        return { ok: true, skipped: true, reason: 'prefer_memory_unchanged' };
                    }
                } else {
                    if (!silent) toastr?.info?.('没有新的小手机内容可导入');
                    return { ok: true, skipped: true, reason: 'same_memory' };
                }
            }
            inner = `【Compressed phone memory】\n${memory}`;
            mode = 'memory';
        } else {
            const piece = transcriptNew || (!state.lastMsgTs ? transcriptAll.trim() : '');
            if (!piece) {
                if (!auto && !silent) toastr?.info?.('没有可导入的小手机内容');
                return { ok: false, reason: 'empty' };
            }
            const fp = fingerprintText(piece);
            if (!force && auto && fp && fp === state.lastSessionFp) {
                return { ok: true, skipped: true, reason: 'same_raw' };
            }
            if (!auto && !force) {
                const ok = window.confirm('将把本段小手机原文作为一轮（一条记录）导入主对话。继续？');
                if (!ok) return { ok: false, reason: 'cancelled' };
            }
            inner = piece;
            mode = 'raw';
        }

        // 关键：无论多少气泡，只 append 一条主聊天消息 = 一轮
        const wrapped = wrapPhoneBlockForMainChat(inner);
        await appendMessageToMainChat({
            name: 'Phone',
            is_user: false,
            is_system: false,
            mes: wrapped,
            extra: {
                type: 'narrator',
                pocket_phone_import: true,
                pocket_phone_import_mode: mode,
                pocket_phone_import_auto: !!auto,
                pocket_phone_round: true,
            },
        }, { kind: 'char' });

        if (mode === 'memory') {
            state.lastMemoryFp = fingerprintText(memory);
            state.lastSessionFp = state.lastMemoryFp;
        } else {
            state.lastSessionFp = fingerprintText(inner);
            // 原文导入不覆盖记忆指纹，方便之后压缩记忆仍能再导
        }
        if (allMsgs.length) {
            state.lastMsgTs = Math.max(...allMsgs.map(m => Number(m.ts || 0)));
        }
        persistSettingsNow();
        await syncMemoryPage();

        if (!silent) {
            toastr?.success?.(mode === 'memory'
                ? (auto ? '已写入一轮压缩记忆到主对话' : '已导入一轮压缩记忆')
                : (auto ? '已写入一轮小手机原文到主对话' : '已导入一轮小手机原文'));
        }
        return { ok: true, mode };
    } catch (err) {
        console.error('[st-pocket-phone] import to main chat failed', err);
        if (!silent) toastr?.error?.(`导入失败：${err?.message || err}`);
        return { ok: false, reason: 'error', error: err };
    } finally {
        if (btn && !auto) {
            btn.disabled = false;
            btn.textContent = '导入主对话';
        }
    }
}

/**
 * 真正发请求生成一次回复；同一次回复的多条气泡共享 replyGroupId。
 * 流式：第一个完整 </msg> 出现就立刻插入气泡，不等全部写完。
 * @param {string[]} userTexts
 * @param {{ insertAt?: number|null }} [opts]
 */
async function generateModelReply(userTexts, opts = {}) {
    const users = (userTexts || []).map(t => String(t || '').trim()).filter(Boolean);
    if (!users.length) {
        toastr?.info?.('请先用「发送气泡」加入至少一条用户消息');
        return;
    }
    if (isGenerating) {
        toastr?.info?.('正在生成中，请稍候');
        return;
    }

    const ch = getActiveCharacter();
    if (!ch) {
        toastr?.warning?.('请先选择角色并进入对话');
        return;
    }
    if (boundCharacterKey !== ch.key) loadThread();

    let insertAt = Number.isFinite(opts.insertAt) ? Number(opts.insertAt) : null;
    const addBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('pocket-phone-add'));
    const replyBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('pocket-phone-reply'));
    isGenerating = true;
    if (addBtn) addBtn.disabled = true;
    if (replyBtn) replyBtn.disabled = true;

    clearPendingFlags();
    const replyGroupId = newReplyGroupId();
    let writeAt = insertAt == null ? activeThread.length : Math.max(0, insertAt);
    let firstBubbleShown = false;

    const pushBubbleLive = async (b) => {
        if (!firstBubbleShown) {
            firstBubbleShown = true;
            setTypingIndicator(false);
        }
        const msg = /** @type {PhoneMessage} */ ({
            role: b.role,
            text: b.text,
            ts: Date.now(),
            replyGroupId,
        });
        const at = writeAt;
        activeThread.splice(writeAt, 0, msg);
        writeAt += 1;
        persistThread();
        renderMessages({ animateIdx: at, forceBottom: true });
        // 强制让出：否则多个气泡会在同一渲染周期里一起出现
        await yieldToPaint();
        // 不再逐条同步主聊天；离开小手机时整段一轮注入
    };

    try {
        scrollMessagesToBottom();
        setTypingIndicator(true);
        const userBundle = users.map((t, i) => `${i + 1}. ${t}`).join('\n');
        const settings = getSettings();
        // 串行出泡：每个完整 </msg> 先画出来再读后续 token（整包到达也会逐条露出）
        const parserSerial = createTagStreamParser(bubble => pushBubbleLive(bubble));
        // API 原生 reasoning_content（DeepSeek/Claude thoughts 等）与预设要求的 <think> 不是一路；
        // 只作「正文里完全没有思维标签」时的兜底，避免把模型内部推理误当成预设思维链。
        let apiNativeReasoning = '';
        const onReasoning = (delta) => {
            apiNativeReasoning = mergeThinkingParts(apiNativeReasoning, delta);
        };

        if (settings.apiMode === 'custom') {
            // 自定义 API：不经酒馆 PromptManager，仍用本地模板
            const prompt = buildGenerationPrompt(userBundle);
            await generateViaCustomApiStream(prompt, delta => parserSerial.push(delta), onReasoning);
        } else {
            // 酒馆模式：quiet 任务 + 当前选用预设的完整提示词链路（含预设里的思维链条目）
            const quietPrompt = buildPhoneTaskPrompt(userBundle);
            try {
                await generateViaStStream(quietPrompt, delta => parserSerial.push(delta), onReasoning);
            } catch (streamErr) {
                console.warn('[st-pocket-phone] ST stream failed, fallback quiet', streamErr);
                const raw = String(await generateViaSt(quietPrompt) || '');
                if (raw) await parserSerial.push(raw);
            }
        }
        await parserSerial.end();

        const presetThinking = String(parserSerial.getThinking() || '').trim();
        const thinking = presetThinking || String(apiNativeReasoning || '').trim();
        if (thinking) {
            const first = activeThread.find(m =>
                m.replyGroupId === replyGroupId && (m.role === 'char' || m.role === 'voice'));
            if (first) {
                first.thinking = thinking;
                persistThread();
                renderMessages();
            }
        } else if (apiNativeReasoning) {
            console.info('[st-pocket-phone] ignored native reasoning (no preset think tags in content)');
        }

        if (!activeThread.some(m => m.replyGroupId === replyGroupId && (m.role === 'char' || m.role === 'voice'))) {
            throw new Error('模型未返回可解析的 <msg> 内容');
        }
        if (insertAt != null) toastr?.success?.('已重 roll 整组回复');
    } catch (err) {
        console.error('[st-pocket-phone] reply failed', err);
        const failMsg = /** @type {PhoneMessage} */ ({
            role: 'meta',
            text: `请求回复失败：${err?.message || err}`,
            ts: Date.now(),
        });
        activeThread.splice(writeAt, 0, failMsg);
        persistThread();
        renderMessages();
        toastr?.error?.('小手机请求回复失败');
    } finally {
        setTypingIndicator(false);
        isGenerating = false;
        if (addBtn) addBtn.disabled = false;
        if (replyBtn) replyBtn.disabled = false;
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
        renderMessages({ forceBottom: true });
    }

    const pending = collectPendingUserTexts();
    if (!pending.length) {
        toastr?.info?.('请先用「发送气泡」加入至少一条用户消息');
        return;
    }

    scrollMessagesToBottom();
    await generateModelReply(pending);
}

/**
 * 读取「外面正在用」的 API 连接。
 * 小手机会话中【只】用进入时快照，绝不读可能被 B 预设污染的 live 值。
 * 按 chat_completion_source 取对应字段，避免 openai 源误用残留的 custom_url。
 */
function readOutsideApiConnection() {
    const ctx = getContext();
    const snap = (phoneSessionActive && outsideConnectionSnapshot)
        ? outsideConnectionSnapshot
        : snapshotConnectionSettings();

    if (phoneSessionActive && outsideConnectionSnapshot) {
        restoreConnectionSettings(outsideConnectionSnapshot);
    }

    const source = String(snap.chat_completion_source || '');
    /** @type {string} */
    let url = '';
    if (source === 'custom') {
        url = String(snap.custom_url || '');
    } else {
        // OpenAI / Claude 等官方源：只用 reverse_proxy；空 = 走官方地址
        url = String(snap.reverse_proxy || '');
    }

    let model = String(snap.__model || '');
    if (!model) {
        const map = {
            custom: snap.custom_model,
            openai: snap.openai_model,
            openrouter: snap.openrouter_model,
            claude: snap.claude_model,
            makersuite: snap.google_model,
            deepseek: snap.deepseek_model,
            aimlapi: snap.aimlapi_model,
            xai: snap.xai_model,
        };
        model = String(map[source] || snap.custom_model || snap.openai_model || '');
    }

    return { source, url, model, mainApi: ctx.mainApi || '' };
}

function importCurrentTavernApi({ preferStMode = true } = {}) {
    const settings = getSettings();
    // 一键接入 = 跟随外面酒馆连接，不改酒馆任何连接字段
    if (preferStMode) settings.apiMode = 'st';

    const { source, url, model, mainApi } = readOutsideApiConnection();

    // 仅写入小手机扩展设置（自定义模式备用）；ST 模式实际请求仍走酒馆 live 连接
    settings.apiUrl = url ? String(url) : '';
    settings.apiModel = model ? String(model) : '';
    const modeLabel = settings.apiMode === 'st' ? '酒馆当前连接' : '已复制为自定义';
    const endpointLabel = source === 'custom'
        ? (url || '（无 URL）')
        : (url || '官方端点');
    settings.apiHint = `${modeLabel}：${source || mainApi || 'current'} / ${model || 'default'} @ ${endpointLabel}`;
    persistSettingsNow();
    updateExtSettingsHint();
    updateHeader();
    syncInlineApiForm();
}

function readApiFormValues() {
    const modeEl = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="pp_inline_api_mode"]:checked'));
    return {
        apiMode: modeEl?.value === 'custom' ? 'custom' : 'st',
        apiUrl: /** @type {HTMLInputElement} */ (document.getElementById('pp-inline-api-url'))?.value?.trim() || '',
        apiKey: /** @type {HTMLInputElement} */ (document.getElementById('pp-inline-api-key'))?.value?.trim() || '',
        apiModel: /** @type {HTMLInputElement} */ (document.getElementById('pp-inline-api-model'))?.value?.trim() || '',
    };
}

function fillModelOptions(models, selected = '') {
    const uniq = [...new Set((models || []).map(m => String(m || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    cachedModelOptions = uniq;
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-inline-api-model-select'));
    const datalist = document.getElementById('pp-inline-api-model-list');
    if (select) {
        const cur = selected || select.value || '';
        select.innerHTML = `<option value="">（从列表选择，或下方手输）</option>${
            uniq.map(id => `<option value="${escapeHtml(id)}"${id === cur ? ' selected' : ''}>${escapeHtml(id)}</option>`).join('')
        }`;
        if (cur && !uniq.includes(cur)) {
            const opt = document.createElement('option');
            opt.value = cur;
            opt.textContent = cur;
            opt.selected = true;
            select.appendChild(opt);
        }
    }
    if (datalist) {
        datalist.innerHTML = uniq.map(id => `<option value="${escapeHtml(id)}"></option>`).join('');
    }
}

function resolveModelsEndpoint(baseUrl) {
    const raw = String(baseUrl || '').trim().replace(/\/$/, '');
    if (!raw) return '';
    if (/\/models\/?$/.test(raw)) return raw;
    if (/\/chat\/completions\/?$/.test(raw)) return raw.replace(/\/chat\/completions\/?$/, '/models');
    if (/\/v1$/.test(raw)) return `${raw}/models`;
    return `${raw}/v1/models`;
}

async function fetchModelsFromCustomEndpoint(url, key) {
    const endpoint = resolveModelsEndpoint(url);
    if (!endpoint) return [];
    const headers = { Accept: 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(endpoint, { method: 'GET', headers });
    if (!res.ok) throw new Error(`models ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    return list.map(m => String(m?.id || m?.name || m || '').trim()).filter(Boolean);
}

async function fetchModelsFromTavernStatus() {
    const ctx = getContext();
    const snap = (phoneSessionActive && outsideConnectionSnapshot)
        ? outsideConnectionSnapshot
        : snapshotConnectionSettings();
    const body = {
        reverse_proxy: snap.reverse_proxy || '',
        proxy_password: snap.proxy_password || '',
        chat_completion_source: snap.chat_completion_source || '',
    };
    if (String(snap.chat_completion_source || '') === 'custom') {
        body.custom_url = snap.custom_url || '';
        body.custom_include_headers = snap.custom_include_headers || '';
    }
    const headers = typeof ctx.getRequestHeaders === 'function'
        ? ctx.getRequestHeaders()
        : { 'Content-Type': 'application/json' };
    const res = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-cache',
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data?.data)) return [];
    return data.data.map(m => String(m?.id || m?.name || '').trim()).filter(Boolean);
}

async function refreshPocketModelList({ silent = true } = {}) {
    const form = readApiFormValues();
    const s = getSettings();
    const url = form.apiUrl || s.apiUrl || '';
    const key = form.apiKey || s.apiKey || '';
    const selected = form.apiModel || s.apiModel || '';
    /** @type {string[]} */
    const models = [];

    for (const m of (stModelList || [])) {
        if (m?.id) models.push(String(m.id));
    }

    try {
        const fromStatus = await fetchModelsFromTavernStatus();
        models.push(...fromStatus);
    } catch (err) {
        console.warn('[st-pocket-phone] status models failed', err);
    }

    if (url) {
        try {
            const fromCustom = await fetchModelsFromCustomEndpoint(url, key);
            models.push(...fromCustom);
        } catch (err) {
            console.warn('[st-pocket-phone] custom models failed', err);
            if (!silent) toastr?.warning?.('自定义端点模型列表拉取失败，已尽量用酒馆已有列表');
        }
    }

    if (selected) models.push(selected);
    fillModelOptions(models, selected);
    if (!silent) {
        const n = new Set(models.filter(Boolean)).size;
        toastr?.success?.(n ? `已同步 ${n} 个模型` : '暂无可用模型，可手动输入');
    }
}

/** 读取酒馆 API 页「反向代理预设」列表（跑路 / 小鸡 / ek …） */
function listTavernProxyPresets() {
    try {
        const list = Array.isArray(stProxies) ? stProxies : [];
        return list
            .filter(p => p && String(p.name || '').trim() && String(p.name) !== 'None')
            .map(p => ({
                name: String(p.name || ''),
                url: String(p.url || ''),
                password: String(p.password || ''),
            }));
    } catch (err) {
        console.warn('[st-pocket-phone] list proxy presets failed', err);
        return [];
    }
}

function renderProxyPresetSelect(selectedName = '') {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-proxy-preset-select'));
    if (!select) return;
    const presets = listTavernProxyPresets();
    const cur = selectedName || select.value || getSettings().activeProxyPresetName || '';
    if (!presets.length) {
        select.innerHTML = '<option value="">酒馆里还没有反向代理预设</option>';
        return;
    }
    select.innerHTML = `<option value="">选择代理预设…</option>${
        presets.map(p => {
            const tip = p.url ? ` — ${truncate(p.url, 40)}` : '';
            return `<option value="${escapeHtml(p.name)}"${p.name === cur ? ' selected' : ''}>${escapeHtml(p.name)}${escapeHtml(tip)}</option>`;
        }).join('')
    }`;
}

/**
 * 拉取外面那串反向代理（ek/小鸡/跑路…）进下拉框，并可直接选用
 */
async function pullTavernProxyPresets() {
    const presets = listTavernProxyPresets();
    if (!presets.length) {
        toastr?.info?.('酒馆 API 页还没有保存反向代理预设');
        renderProxyPresetSelect();
        return;
    }
    renderProxyPresetSelect(getSettings().activeProxyPresetName || '');
    const names = presets.map(p => p.name).join('、');
    toastr?.success?.(`已拉取 ${presets.length} 个代理：${truncate(names, 80)}`);

    // 若当前有选中项，顺手套用并刷模型
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-proxy-preset-select'));
    if (select?.value) await applySelectedProxyPreset();
}

async function applySelectedProxyPreset() {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-proxy-preset-select'));
    const name = String(select?.value || '').trim();
    if (!name) return;

    const preset = listTavernProxyPresets().find(p => p.name === name);
    if (!preset) {
        toastr?.warning?.(`找不到代理预设「${name}」`);
        return;
    }

    const s = getSettings();
    s.apiMode = 'custom';
    s.apiUrl = preset.url || '';
    s.apiKey = preset.password || '';
    s.activeProxyPresetName = preset.name;
    s.apiHint = `反向代理「${preset.name}」@ ${preset.url || '（无 URL）'}`;
    // 清掉收藏选中，避免两套选择打架
    s.activeApiProfileId = '';
    persistSettingsNow();
    syncInlineApiForm();
    updateHeader();
    await refreshPocketModelList({ silent: false });
    toastr?.success?.(`已选用「${preset.name}」`);
}

function renderApiProfileSelect() {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-api-profile-select'));
    const nameInput = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-api-profile-name'));
    if (!select) return;
    const s = getSettings();
    const profiles = getApiProfiles();
    const active = String(s.activeApiProfileId || '');
    select.innerHTML = `<option value="">（无收藏）</option>${
        profiles.map(p => {
            const tip = [p.apiModel, p.apiUrl].filter(Boolean).join(' · ');
            const label = tip ? `${p.name} — ${truncate(tip, 36)}` : p.name;
            return `<option value="${escapeHtml(p.id)}"${p.id === active ? ' selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('')
    }`;
    const cur = profiles.find(p => p.id === active);
    if (nameInput && document.activeElement !== nameInput) {
        nameInput.value = cur?.name || '';
    }
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
    fillModelOptions(
        [...cachedModelOptions, s.apiModel].filter(Boolean),
        s.apiModel || '',
    );
    renderProxyPresetSelect(s.activeProxyPresetName || '');
    renderApiProfileSelect();
    if (hint) {
        hint.textContent = s.apiMode === 'st'
            ? `当前：酒馆聊天 API。${s.apiHint || '一键接入后可直接请求回复。'}`
            : `当前：自定义 API${s.activeProxyPresetName ? `（代理：${s.activeProxyPresetName}）` : ''}。可改 URL / Key / Model。`;
    }
}

function saveInlineApiForm() {
    const s = getSettings();
    const form = readApiFormValues();
    s.apiMode = form.apiMode;
    s.apiUrl = form.apiUrl;
    s.apiKey = form.apiKey;
    s.apiModel = form.apiModel;
    persistSettingsNow();
    syncInlineApiForm();
    updateHeader();
    updateExtSettingsForm();
}

function applySelectedApiProfile({ fromSelect = false, quiet = false } = {}) {
    const id = fromSelect
        ? (/** @type {HTMLSelectElement|null} */ (document.getElementById('pp-api-profile-select'))?.value || '')
        : (getSettings().activeApiProfileId
            || /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-api-profile-select'))?.value
            || '');
    const profile = getApiProfiles().find(p => p.id === id);
    if (!profile) {
        if (fromSelect) {
            getSettings().activeApiProfileId = '';
            persistSettingsNow();
            renderApiProfileSelect();
        }
        return;
    }
    const s = getSettings();
    s.apiMode = profile.apiMode === 'custom' ? 'custom' : 'st';
    s.apiUrl = profile.apiUrl || '';
    s.apiKey = profile.apiKey || '';
    s.apiModel = profile.apiModel || '';
    s.activeApiProfileId = profile.id;
    s.activeProxyPresetName = '';
    s.apiHint = `收藏「${profile.name}」`;
    if (Array.isArray(profile.models) && profile.models.length) {
        fillModelOptions(profile.models, profile.apiModel || '');
    }
    persistSettingsNow();
    syncInlineApiForm();
    updateHeader();
    void refreshPocketModelList({ silent: true });
    if (!quiet) toastr?.success?.(`已切换到收藏「${profile.name}」`);
}

function readFavoriteNameInput(fallback = '') {
    const nameInput = /** @type {HTMLInputElement|null} */ (document.getElementById('pp-api-profile-name'));
    return (nameInput?.value || '').trim() || String(fallback || '').trim();
}

function saveApiProfileAsNew() {
    const suggested = getSettings().activeProxyPresetName
        || `收藏 ${getApiProfiles().length + 1}`;
    const name = readFavoriteNameInput(suggested);
    if (!name) {
        toastr?.warning?.('请先填写收藏名称');
        document.getElementById('pp-api-profile-name')?.focus();
        return;
    }
    const existing = getApiProfiles().find(p => p.name === name);
    if (existing && !window.confirm(`已有同名收藏「${name}」，要覆盖吗？`)) return;

    saveInlineApiForm();
    const form = readApiFormValues();
    if (existing) {
        existing.apiMode = form.apiMode;
        existing.apiUrl = form.apiUrl;
        existing.apiKey = form.apiKey;
        existing.apiModel = form.apiModel;
        existing.models = [...cachedModelOptions];
        existing.updatedAt = Date.now();
        getSettings().activeApiProfileId = existing.id;
    } else {
        const profile = {
            id: newLocalId('api'),
            name,
            apiMode: form.apiMode,
            apiUrl: form.apiUrl,
            apiKey: form.apiKey,
            apiModel: form.apiModel,
            models: [...cachedModelOptions],
            source: 'manual',
            updatedAt: Date.now(),
        };
        getApiProfiles().push(profile);
        getSettings().activeApiProfileId = profile.id;
    }
    persistSettingsNow();
    renderApiProfileSelect();
    toastr?.success?.(`已保存收藏「${name}」`);
}

function renameSelectedApiProfile() {
    const id = getSettings().activeApiProfileId
        || /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-api-profile-select'))?.value
        || '';
    const profile = getApiProfiles().find(p => p.id === id);
    if (!profile) {
        toastr?.info?.('请先选择要重命名的收藏');
        return;
    }
    const nextName = readFavoriteNameInput();
    if (!nextName) {
        toastr?.warning?.('请填写新名称');
        document.getElementById('pp-api-profile-name')?.focus();
        return;
    }
    if (nextName !== profile.name && getApiProfiles().some(p => p.name === nextName && p.id !== profile.id)) {
        toastr?.warning?.('已有同名收藏');
        return;
    }
    profile.name = nextName;
    profile.updatedAt = Date.now();
    persistSettingsNow();
    renderApiProfileSelect();
    toastr?.success?.(`已重命名为「${nextName}」`);
}

function deleteSelectedApiProfile() {
    const id = getSettings().activeApiProfileId
        || /** @type {HTMLSelectElement|null} */ (document.getElementById('pp-api-profile-select'))?.value
        || '';
    const profiles = getApiProfiles();
    const idx = profiles.findIndex(p => p.id === id);
    if (idx < 0) {
        toastr?.info?.('请先选择要删除的收藏');
        return;
    }
    const name = profiles[idx].name;
    if (!window.confirm(`确定删除收藏「${name}」？`)) return;
    profiles.splice(idx, 1);
    getSettings().activeApiProfileId = '';
    persistSettingsNow();
    renderApiProfileSelect();
    toastr?.success?.('已删除收藏');
}

function collectExportPayload() {
    const s = getSettings();
    return {
        type: 'st-pocket-phone-backup',
        version: PP_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        data: {
            apiMode: s.apiMode,
            apiUrl: s.apiUrl,
            apiKey: s.apiKey,
            apiModel: s.apiModel,
            apiHint: s.apiHint,
            apiProfiles: s.apiProfiles || [],
            activeApiProfileId: s.activeApiProfileId || '',
            activeProxyPresetName: s.activeProxyPresetName || '',
            presetPrompt: s.presetPrompt || '',
            phonePresetName: s.phonePresetName || '',
            outsidePresetName: s.outsidePresetName || '',
            phoneSessionBorrowed: !!s.phoneSessionBorrowed,
            phonePresets: s.phonePresets || {},
            bubbleColors: s.bubbleColors || {},
            characterOverrides: s.characterOverrides || {},
            characterRoster: s.characterRoster || {},
            multilangEnabled: !!s.multilangEnabled,
            avatarDisplayMode: s.avatarDisplayMode || 'none',
            userAvatarDataUrl: s.userAvatarDataUrl || '',
            backgroundLibrary: s.backgroundLibrary || [],
            activeBackgroundId: s.activeBackgroundId || '',
            threads: s.threads || {},
            threadStore: s.threadStore || {},
            syncMainChat: !!s.syncMainChat,
            injectMainChatContext: s.injectMainChatContext !== false,
            mainChatInjectCount: s.mainChatInjectCount || 12,
            memorySummaryPrompt: s.memorySummaryPrompt || '',
            memoryTokenLimit: getMemoryTokenLimit(),
            memoryApiMode: s.memoryApiMode === 'custom' ? 'custom' : 'chat',
            memoryApiUrl: s.memoryApiUrl || '',
            memoryApiKey: s.memoryApiKey || '',
            memoryApiModel: s.memoryApiModel || '',
            activeVoiceProviderId: s.activeVoiceProviderId || 'minimax',
            voiceProviderConfigs: s.voiceProviderConfigs || {},
            voiceCustomProviders: s.voiceCustomProviders || [],
            voicePromptOverrides: s.voicePromptOverrides || {},
            phoneFormatPrompt: s.phoneFormatPrompt || '',
            phoneMultilangPrompt: s.phoneMultilangPrompt || '',
            phoneStylePrompt: s.phoneStylePrompt || '',
            showFab: !!s.showFab,
            enabled: !!s.enabled,
        },
    };
}

function exportPocketPhoneData() {
    try {
        const payload = collectExportPayload();
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        a.href = url;
        a.download = `pocket-phone-backup-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        toastr?.success?.('已导出小手机数据');
    } catch (err) {
        console.error('[st-pocket-phone] export failed', err);
        toastr?.error?.('导出失败');
    }
}

async function onImportFilePicked(e) {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
        if (!data || typeof data !== 'object') throw new Error('无效备份文件');
        if (!window.confirm('导入将覆盖当前小手机里的对话、API、头像、背景等用户数据，确定继续？')) return;
        const s = getSettings();
        const keys = [
            'apiMode', 'apiUrl', 'apiKey', 'apiModel', 'apiHint',
            'apiProfiles', 'activeApiProfileId', 'activeProxyPresetName',
            'presetPrompt', 'phonePresetName', 'outsidePresetName', 'phoneSessionBorrowed', 'phonePresets',
            'bubbleColors', 'characterOverrides', 'characterRoster',
            'multilangEnabled', 'avatarDisplayMode', 'userAvatarDataUrl',
            'backgroundLibrary', 'activeBackgroundId',
            'threads', 'threadStore', 'syncMainChat', 'injectMainChatContext', 'mainChatInjectCount',
            'memorySummaryPrompt', 'memoryTokenLimit',
            'memoryApiMode', 'memoryApiUrl', 'memoryApiKey', 'memoryApiModel',
            'activeVoiceProviderId', 'voiceProviderConfigs', 'voiceCustomProviders', 'voicePromptOverrides',
            'phoneFormatPrompt', 'phoneMultilangPrompt', 'phoneStylePrompt',
            'showFab', 'enabled',
        ];
        for (const k of keys) {
            if (Object.prototype.hasOwnProperty.call(data, k)) s[k] = data[k];
        }
        if (s.memoryApiMode !== 'custom') s.memoryApiMode = 'chat';
        {
            const lim = Number(s.memoryTokenLimit);
            s.memoryTokenLimit = Number.isFinite(lim) && lim >= 500 ? Math.round(lim) : DEFAULT_MEMORY_TOKEN_LIMIT;
        }
        ensureVoiceSettingsShape();
        if (!Array.isArray(s.apiProfiles)) s.apiProfiles = [];
        if (!Array.isArray(s.backgroundLibrary)) s.backgroundLibrary = [];
        if (!s.threads || typeof s.threads !== 'object') s.threads = {};
        persistSettingsNow();
        loadThread();
        syncInlineApiForm();
        updateExtSettingsForm();
        applyBubbleColorVars();
        applyChatBackground();
        updateHeader();
        renderMessages();
        toastr?.success?.('导入完成');
    } catch (err) {
        console.error('[st-pocket-phone] import failed', err);
        toastr?.error?.(`导入失败：${err?.message || err}`);
    }
}

function openChatBackgroundEditor() {
    const lib = getBackgroundLibrary();
    const active = String(getSettings().activeBackgroundId || '');
    openModal({
        title: '对话背景',
        bodyHtml: `
            <p class="pp-help">可上传并保存多张背景图，点选一张应用到短信页；选「默认」可恢复。</p>
            <div class="pp-bg-grid" id="pp-bg-grid">
                <button type="button" class="pp-bg-item ${!active ? 'is-active' : ''}" data-bg-id="">
                    <span class="pp-bg-item-default">默认</span>
                </button>
                ${lib.map(b => `
                    <button type="button" class="pp-bg-item ${b.id === active ? 'is-active' : ''}" data-bg-id="${escapeHtml(b.id)}" title="${escapeHtml(b.name || '')}">
                        <img src="${escapeHtml(b.dataUrl)}" alt="" />
                        <span class="pp-bg-item-del" data-bg-del="${escapeHtml(b.id)}" title="删除">×</span>
                    </button>
                `).join('')}
            </div>
            <button type="button" class="pp-secondary-btn" id="pp-bg-upload">上传背景图</button>
        `,
        onOk: () => {
            const picked = /** @type {HTMLElement|null} */ (document.querySelector('#pp-bg-grid .pp-bg-item.is-active'));
            const id = picked?.getAttribute('data-bg-id') || '';
            getSettings().activeBackgroundId = id;
            persistSettingsNow();
            applyChatBackground();
            toastr?.success?.(id ? '背景已应用' : '已恢复默认背景');
        },
    });

    setTimeout(() => {
        const grid = document.getElementById('pp-bg-grid');
        grid?.addEventListener('click', ev => {
            const t = /** @type {HTMLElement} */ (ev.target);
            const del = t.closest('[data-bg-del]');
            if (del) {
                ev.preventDefault();
                ev.stopPropagation();
                const id = del.getAttribute('data-bg-del');
                const arr = getBackgroundLibrary();
                const idx = arr.findIndex(b => b.id === id);
                if (idx < 0) return;
                if (!window.confirm('删除这张背景？')) return;
                arr.splice(idx, 1);
                if (getSettings().activeBackgroundId === id) getSettings().activeBackgroundId = '';
                persistSettingsNow();
                applyChatBackground();
                openChatBackgroundEditor();
                return;
            }
            const item = t.closest('.pp-bg-item');
            if (!item || !grid) return;
            grid.querySelectorAll('.pp-bg-item').forEach(el => el.classList.remove('is-active'));
            item.classList.add('is-active');
        });
        document.getElementById('pp-bg-upload')?.addEventListener('click', () => {
            document.getElementById('pp-bg-file')?.click();
        });
    }, 0);
}

async function onBackgroundFilePicked(e) {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        toastr?.warning?.('请选择图片文件');
        return;
    }
    if (file.size > 4.5 * 1024 * 1024) {
        toastr?.warning?.('背景图请小于 4.5MB');
        return;
    }
    try {
        const dataUrl = await readFileAsDataUrl(file);
        const item = {
            id: newLocalId('bg'),
            name: file.name || '背景',
            dataUrl,
            createdAt: Date.now(),
        };
        getBackgroundLibrary().push(item);
        getSettings().activeBackgroundId = item.id;
        persistSettingsNow();
        applyChatBackground();
        toastr?.success?.('背景已添加并应用');
        if (document.getElementById('pp-modal')?.classList.contains('pp-modal-open')) {
            openChatBackgroundEditor();
        }
    } catch (err) {
        console.warn('[st-pocket-phone] bg upload failed', err);
        toastr?.error?.('背景读取失败');
    }
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
    const injectMain = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_inject_main'));
    const showFab = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_show_fab'));
    const modeSt = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_mode_st'));
    const modeCustom = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_mode_custom'));
    const url = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_url'));
    const key = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_key'));
    const model = /** @type {HTMLInputElement|null} */ (document.getElementById('pocket_phone_api_model'));
    if (enabled) enabled.checked = !!s.enabled;
    if (sync) sync.checked = !!s.syncMainChat;
    if (injectMain) injectMain.checked = s.injectMainChatContext !== false;
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
    document.getElementById('pocket_phone_inject_main')?.addEventListener('input', e => {
        getSettings().injectMainChatContext = Boolean(/** @type {HTMLInputElement} */ (e.target).checked);
        persistSettingsNow();
    });
    document.getElementById('pocket_phone_show_fab')?.addEventListener('input', e => {
        getSettings().showFab = Boolean(/** @type {HTMLInputElement} */ (e.target).checked);
        saveSettingsDebounced();
        refreshFab();
    });
    document.querySelectorAll('input[name="pocket_phone_api_mode"]').forEach(el => {
        el.addEventListener('change', () => {
            getSettings().apiMode = /** @type {HTMLInputElement} */ (el).value === 'custom' ? 'custom' : 'st';
            persistSettingsNow();
            updateExtSettingsHint();
            updateHeader();
        });
    });
    const bindField = (id, key) => {
        document.getElementById(id)?.addEventListener('change', e => {
            getSettings()[key] = /** @type {HTMLInputElement} */ (e.target).value.trim();
            persistSettingsNow();
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
    document.getElementById('pocket_phone_open_from_settings')?.addEventListener('click', () => openPhone('roster'));
}

/**
 * 主聊天 / 角色上下文变化：
 * - 角色变了，或主聊 chat_id 变了 → 按「角色+chatId」重载短信线程
 * - 主聊新开对话时会落到空线程（loadThread 内自动 create）
 */
function onChatContextChanged() {
    refreshFab();
    const ch = getActiveCharacter();
    // 切角色过程中 characterId 会短暂清空，不要因此把全屏关掉
    if (!ch) return;

    const chatId = getMainChatId();
    // 主聊 id 尚未就绪时先不乱建线程
    if (!chatId && !boundChatId) {
        const root = document.getElementById('pocket-phone-root');
        if (root?.classList.contains('pocket-phone-open')) {
            updateHeader();
            syncMultilangMoreLabel();
        }
        return;
    }

    const charChanged = ch.key !== boundCharacterKey;
    const chatChanged = String(chatId || '') !== String(boundChatId || '');
    if (!charChanged && !chatChanged) {
        const root = document.getElementById('pocket-phone-root');
        if (root?.classList.contains('pocket-phone-open')) {
            updateHeader();
            syncMultilangMoreLabel();
        }
        return;
    }

    // 切走前尽量落盘旧线程
    if (boundCharacterKey) {
        try { persistThread(); } catch (_) { /* ignore */ }
    }
    loadThread();

    const root = document.getElementById('pocket-phone-root');
    if (root?.classList.contains('pocket-phone-open')) {
        refreshSmsUi();
        showView('sms');
        syncMultilangMoreLabel();
    }
}

function getCsrfToken() {
    try {
        const t = SillyTavern?.getContext?.().getRequestHeaders?.()?.['X-CSRF-Token'];
        if (t) {
            window.__pp_csrf_token = t;
            return t;
        }
    } catch {
        // keep cached
    }
    return window.__pp_csrf_token || '';
}

/**
 * Cursor 内置浏览器里，原生 XHR 经常带不上 session cookie，
 * /api/tokenizers/* 等会 403；同 URL 的 fetch 却正常。
 * 用 jQuery ajaxTransport 把同源 /api/ 请求改走 fetch。
 * 另：XHR.send 仍补 CSRF，给未走 transport 的请求兜底。
 */
function ensureJqueryCsrf() {
    if (window.__pp_csrf_patched) return;
    window.__pp_csrf_patched = true;

    const rawSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function patchedSend(body) {
        try {
            const t = getCsrfToken();
            if (t) {
                try {
                    this.setRequestHeader('X-CSRF-Token', t);
                } catch {
                    // header may already be set / request state invalid
                }
            }
        } catch {
            // ignore
        }
        return rawSend.call(this, body);
    };

    if (window.jQuery?.ajaxTransport) {
        window.jQuery.ajaxTransport('+*', options => {
            const url = String(options.url || '');
            if (!url.startsWith('/api/') && !url.startsWith('/csrf-token')) {
                return undefined;
            }
            let aborted = false;
            return {
                send(headers, complete) {
                    const reqHeaders = { ...(headers || {}) };
                    const t = getCsrfToken();
                    if (t) reqHeaders['X-CSRF-Token'] = t;
                    if (options.contentType && !reqHeaders['Content-Type']) {
                        reqHeaders['Content-Type'] = options.contentType;
                    }
                    const method = (options.type || 'GET').toUpperCase();
                    fetch(url, {
                        method,
                        credentials: 'same-origin',
                        headers: reqHeaders,
                        body: method === 'GET' || method === 'HEAD' ? undefined : options.data,
                    }).then(async res => {
                        if (aborted) return;
                        const text = await res.text();
                        complete(res.status, res.statusText, { text }, (() => {
                            const h = {};
                            res.headers.forEach((v, k) => { h[k] = v; });
                            return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n');
                        })());
                    }).catch(err => {
                        if (aborted) return;
                        complete(0, 'error', { text: String(err?.message || err) }, '');
                    });
                },
                abort() {
                    aborted = true;
                },
            };
        });
    }
}

async function refreshCsrfCache() {
    try {
        const t = SillyTavern?.getContext?.().getRequestHeaders?.()?.['X-CSRF-Token'];
        if (t) {
            window.__pp_csrf_token = t;
            return t;
        }
    } catch {
        // continue
    }
    try {
        const data = await fetch('/csrf-token').then(r => r.json());
        if (data?.token) window.__pp_csrf_token = data.token;
        return data?.token || '';
    } catch {
        return '';
    }
}

/**
 * 当页面 URL 带 ?query 时，jQuery UI Tabs + <base href="/"> 会把
 * #bg_global_tab 判定为「远程面板」，把整页 HTML AJAX 进 #bg_tabs，
 * 造成重复的 #right-nav-panel / #character_name_pole。
 * getElementById 写到隐藏副本，用户看到的角色卡是空的。
 */
function fixBgTabHrefs() {
    document.querySelectorAll('#bg_tabs a[href*="bg_"]').forEach(a => {
        const raw = a.getAttribute('href') || '';
        const hashIdx = raw.indexOf('#');
        if (hashIdx < 0) return;
        const hash = raw.slice(hashIdx);
        const desired = `${location.pathname}${location.search}${hash}`;
        if (raw !== desired) a.setAttribute('href', desired);
    });
}

function countElementsById(id) {
    let n = 0;
    document.querySelectorAll('*').forEach(el => {
        if (el.id === id) n += 1;
    });
    return n;
}

function healBgTabsDomCorruption() {
    try {
        const $tabs = window.jQuery?.('#bg_tabs');
        if ($tabs?.length) {
            $tabs.off('tabsbeforeload.pocketphone');
            $tabs.on('tabsbeforeload.pocketphone', event => {
                event.preventDefault();
            });
        }

        fixBgTabHrefs();

        let removed = false;
        document.querySelectorAll('#bg_tabs > .ui-tabs-panel, #bg_tabs > [role="tabpanel"]').forEach(panel => {
            if (panel.id === 'bg_global_tab' || panel.id === 'bg_chat_tab') return;
            if (panel.querySelector('title, #sheld, #top-settings-holder, #preloader, #right-nav-panel')) {
                panel.remove();
                removed = true;
            }
        });

        // 清理残留的重复角色面板（不在 body>#top-settings-holder 下的）
        const panels = [];
        document.querySelectorAll('*').forEach(el => {
            if (el.id === 'right-nav-panel') panels.push(el);
        });
        if (panels.length > 1) {
            const canonical = panels.find(p => {
                const top = p.closest('#top-settings-holder');
                return top && top.parentElement === document.body;
            }) || panels[panels.length - 1];
            panels.forEach(p => {
                if (p !== canonical) {
                    p.remove();
                    removed = true;
                }
            });
        }

        if (removed && $tabs?.data?.('ui-tabs')) {
            try {
                $tabs.tabs('refresh');
            } catch {
                // ignore
            }
        }

        if (removed) {
            console.info('[st-pocket-phone] healed bg_tabs DOM corruption (duplicate character panel)');
            const ctx = window.SillyTavern?.getContext?.();
            const id = ctx?.characterId;
            if (id != null && String(id) !== 'none' && typeof ctx.selectCharacterById === 'function') {
                setTimeout(() => {
                    try {
                        ctx.selectCharacterById(String(id));
                    } catch {
                        // ignore
                    }
                }, 150);
            }
        }

        window.__pp_dom_healed = true;
        return removed;
    } catch (err) {
        console.warn('[st-pocket-phone] DOM heal failed', err);
        return false;
    }
}

jQuery(async () => {
    ensureJqueryCsrf();
    await refreshCsrfCache();
    // backgrounds.js 可能已把带 query 的页面 AJAX 进 tabs；先清掉
    healBgTabsDomCorruption();
    // AJAX 注入可能稍晚完成，再补两枪
    setTimeout(() => healBgTabsDomCorruption(), 800);
    setTimeout(() => healBgTabsDomCorruption(), 2500);

    getSettings();
    registerPhoneLanguageMacros();
    await ensureDefaultPreset();
    try {
        const settingsHtml = await $.get(`${EXTENSION_FOLDER}/settings.html`);
        $('#extensions_settings2').append(settingsHtml);
        bindSettingsUi();
    } catch (err) {
        console.warn('[st-pocket-phone] settings panel load failed', err);
    }

    // 关键：刷新后若全局预设还粘在小手机 B 上，立刻掰回主聊天 A
    bindPresetUnloadGuard();
    healMainChatPresetAfterBorrow();
    setTimeout(() => healMainChatPresetAfterBorrow(), 500);
    setTimeout(() => healMainChatPresetAfterBorrow(), 1500);

    injectOptionsMenuEntry();
    injectTopBarEntry();
    // 顶栏可能稍后才渲染完，再补一次
    setTimeout(() => injectTopBarEntry(), 800);
    refreshFab();
    elevateToastsAbovePhone();

    // toastr / Popup 弹出时再抬一次层级，避免被小手机盖住
    try {
        if (window.toastr && !window.toastr.__pp_elevated) {
            window.toastr.__pp_elevated = true;
            const wrap = (fn) => (...args) => {
                const ret = fn?.(...args);
                if (document.body.classList.contains('pocket-phone-open')) scheduleElevateOverlays();
                return ret;
            };
            if (window.toastr.success) window.toastr.success = wrap(window.toastr.success.bind(window.toastr));
            if (window.toastr.info) window.toastr.info = wrap(window.toastr.info.bind(window.toastr));
            if (window.toastr.warning) window.toastr.warning = wrap(window.toastr.warning.bind(window.toastr));
            if (window.toastr.error) window.toastr.error = wrap(window.toastr.error.bind(window.toastr));
        }
    } catch (_) { /* ignore */ }

    // dialog 打开/关闭时同步 toast 挂载点
    try {
        if (!ppDialogElevateBound) {
            ppDialogElevateBound = true;
            document.addEventListener('close', (ev) => {
                if (/** @type {HTMLElement} */ (ev.target)?.tagName === 'DIALOG') scheduleElevateOverlays();
            }, true);
            document.addEventListener('cancel', (ev) => {
                if (/** @type {HTMLElement} */ (ev.target)?.tagName === 'DIALOG') scheduleElevateOverlays();
            }, true);
        }
    } catch (_) { /* ignore */ }

    const events = [
        event_types.CHAT_CHANGED,
        event_types.CHAT_CREATED,
        event_types.CHARACTER_EDITED,
        event_types.CHARACTER_PAGE_LOADED,
    ].filter(Boolean);
    for (const ev of events) {
        eventSource.on(ev, () => onChatContextChanged());
    }
});
