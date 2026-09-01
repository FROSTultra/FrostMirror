const { app, BrowserWindow, ipcMain, safeStorage, Tray, Menu, clipboard, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const koffi = require('koffi');
const { streamChatCompletion } = require('./stream');
const { buildTermRegex, findTermHits, parseCsv } = require('./terms-core');

// 便携软件路线:不写用户 C 盘。
// 打包后:配置存在 exe 旁边(便携 exe 取 PORTABLE_EXECUTABLE_DIR,zip 版取 exe 所在目录);
// 开发模式(未打包):配置在项目根目录,方便查看修改。
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR
  || (app.isPackaged ? path.dirname(app.getPath('exe')) : '');

const SETTINGS_FILE = path.join(PORTABLE_DIR || __dirname, 'settings.json');

// 历史记录:与 settings.json 同目录(便携=exe 旁),最新在前,超过 200 条裁掉最旧
const HISTORY_FILE = path.join(path.dirname(SETTINGS_FILE), 'history.json');
const HISTORY_LIMIT = 200;

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}

function saveHistory(list) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list));
}

function addHistory(entry) {
  const list = loadHistory();
  list.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    time: Date.now(),
    ...entry,
  });
  if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
  try { saveHistory(list); } catch (e) { console.log('[frost-mirror] 历史写入失败:', e.message); }
}

// ---- 术语表:与 settings.json 同目录 terms.json;双通道(语境=提示词软约束,默认 / 严格=占位符保护) ----
const TERMS_FILE = path.join(path.dirname(SETTINGS_FILE), 'terms.json');
const PRESET_FILE = path.join(__dirname, 'assets', 'terms-preset.json');

function loadTerms() {
  try {
    const t = JSON.parse(fs.readFileSync(TERMS_FILE, 'utf8'));
    return {
      enabled: t.enabled !== false,
      channel: t.channel === 'strict' ? 'strict' : 'context',
      terms: Array.isArray(t.terms) ? t.terms : [],
    };
  } catch {
    return { enabled: true, channel: 'context', terms: [] };
  }
}

function saveTerms(data) {
  fs.writeFileSync(TERMS_FILE, JSON.stringify(data, null, 2));
}

function termId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

if (PORTABLE_DIR) {
  // Chromium 的缓存/存储也搬到 exe 旁的 glass-data,彻底不占用 C 盘
  app.setPath('userData', path.join(PORTABLE_DIR, 'glass-data'));
}

let win = null;
let tray = null;
let isQuitting = false;
// 剪贴板监听状态:主进程轮询记录上次读到的内容与本应用最近写入的内容(防自循环)
let lastClipText = '';
let lastAppWrittenText = '';
let lastDispatchedClip = ''; // 最近一次已触发翻译的剪贴板内容:热键只翻新内容,不重复翻旧内容
let clipWatchEnabled = true;

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    // API Key 用系统 DPAPI 加密存储,读出后解密,绝不落明文
    if (raw.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
      try {
        raw.apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64'));
        delete raw.apiKeyEnc;
      } catch (e) {
        // 便携场景换机/换账户后密文解不开:丢弃失效密文,其余配置保留,提示重新填写
        console.log('[frost-mirror] API Key 解密失败(可能换了电脑或账户):', e.message);
        delete raw.apiKeyEnc;
      }
    }
    return {
      baseUrl: raw.baseUrl || '',
      model: raw.model || '',
      apiKey: raw.apiKey || '',
      tint: typeof raw.tint === 'number' ? raw.tint : 0.3,
      onboarded: !!raw.onboarded,
      langTarget: typeof raw.langTarget === 'string' ? raw.langTarget : 'auto',
      deepMode: !!raw.deepMode,
      clipWatch: raw.clipWatch !== false, // 复制即翻开关,默认开
      hotkey: typeof raw.hotkey === 'string' && raw.hotkey ? raw.hotkey : 'Alt+Q',
    };
  } catch {
    return { baseUrl: '', model: '', apiKey: '', tint: 0.3, onboarded: false, langTarget: 'auto', deepMode: false, clipWatch: true, hotkey: 'Alt+Q' };
  }
}

function saveSettings(s) {
  // 与旧配置合并,避免部分更新时丢失 tint/onboarded 等字段
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  const data = {
    ...existing,
    baseUrl: (s.baseUrl || '').trim(),
    model: (s.model || '').trim(),
  };
  if (typeof s.tint === 'number') data.tint = s.tint;
  if (typeof s.onboarded === 'boolean') data.onboarded = s.onboarded;
  if (typeof s.langTarget === 'string') data.langTarget = s.langTarget;
  if (typeof s.deepMode === 'boolean') data.deepMode = s.deepMode;
  if (typeof s.clipWatch === 'boolean') data.clipWatch = s.clipWatch;
  if (typeof s.hotkey === 'string') data.hotkey = s.hotkey;
  if (s.apiKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用');
    data.apiKeyEnc = safeStorage.encryptString(s.apiKey).toString('base64');
  }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

// 思考模式由调用方决定:普通翻译关闭(快且省);深度模式开启(thinking enabled + low 强度,更慢更贵)
async function chatCompletion(baseUrl, model, apiKey, body, { thinking = false, effort = 'low' } = {}) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const extra = thinking
    ? { thinking: { type: 'enabled' }, reasoning_effort: effort }
    : { thinking: { type: 'disabled' } };
  const send = (ex) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000); // 60 秒超时,避免永远"翻译中…"
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, ...body, ...ex }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  };
  const friendly = (e) => new Error(e.name === 'AbortError' ? '请求超时(60 秒),请检查网络或更换接口地址' : e.message);
  let res;
  try {
    res = await send(extra);
  } catch (e) {
    throw friendly(e);
  }
  if (res.status === 400) {
    // 服务端不识别 thinking / reasoning_effort 参数:去掉后重试一次
    try {
      res = await send({});
    } catch (e) {
      throw friendly(e);
    }
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

function validateSettings({ baseUrl, model, apiKey }) {
  return chatCompletion(baseUrl, model, apiKey, {
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
  }).then(() => true);
}

// 语言代码 → 提示词用的自然语言名;未收录的代码直接原样给模型(模型认识语言代码)
const LANG_NAMES = {
  'zh': '简体中文', 'zh-CN': '简体中文', 'zh-TW': '繁体中文', 'zh-HK': '繁体中文',
  'en': 'English', 'en-US': 'English', 'en-GB': 'English',
  'ja': '日语', 'ko': '韩语', 'fr': '法语', 'de': '德语', 'es': '西班牙语',
  'ru': '俄语', 'pt': '葡萄牙语', 'it': '意大利语', 'ar': '阿拉伯语',
  'hi': '印地语', 'vi': '越南语', 'th': '泰语', 'id': '印尼语',
};

// 词典模式提示词:孤词查询时列出全部常见义项,而非按句子翻译
const DICT_PROMPT = '这是一个词典查询。请列出该词的所有常见义项:按词性分组,每项给出中文释义和一条简短例句;常用搭配与习语也请列出。';

async function translate({ baseUrl, model, apiKey, text, target, deep, mode, signal, onDelta }) {
  const isDict = mode === 'dict';
  const langName = LANG_NAMES[target] || target;
  let system = isDict
    ? `你是一个词典。只输出词典内容本身,不要任何解释或额外文字。${DICT_PROMPT}`
    : `你是一个翻译引擎。只输出译文本身,不要任何解释或额外文字。目标语言:${langName}。`;

  // 术语表联动:仅整句翻译通道生效;词典通道只做"用户译名置顶"
  const terms = loadTerms();
  const activeTerms = terms.enabled ? terms.terms.filter((t) => t.enabled !== false) : [];
  let termHits = [];
  let placeholderMap = null;
  let work = text;

  if (isDict) {
    const hit = activeTerms.find((t) => t.source.trim().toLowerCase() === text.trim().toLowerCase());
    if (hit) {
      system += `\n注意:用户已为该词指定译名「${hit.target}」,请把对应义项放在最前面并标注为用户指定译法。`;
    }
  } else if (activeTerms.length) {
    termHits = findTermHits(text, activeTerms);
    if (termHits.length && terms.channel === 'strict') {
      // 严格通道:命中的词先替换成占位符,提示词要求原样保留,返回后还原成译名(确定性)
      placeholderMap = [];
      termHits.forEach((t, i) => {
        const re = buildTermRegex(t.source, !!t.caseSensitive);
        const before = work;
        work = work.replace(re, `⟪${i}⟫`);
        if (work !== before) placeholderMap[i] = t;
      });
      if (placeholderMap.some(Boolean)) {
        system += '\n文本中形如 ⟪数字⟫ 的是占位符,请在译文中原样保留,不要翻译、改写或删除它们。';
      } else {
        placeholderMap = null; // 全都没实际替换成功,按无术语处理
      }
    } else if (termHits.length) {
      // 语境通道(默认):对照表软约束,词性/语境不符时允许自然译法
      const lines = termHits.map((t) =>
        `- ${t.source} → ${t.target === t.source ? '(保持原文不译)' : t.target}${t.desc ? `(${t.desc})` : ''}`
      );
      system += `\n\n术语对照表(翻译时优先遵循;若词性/语境明显不符,可选更自然的译法):\n${lines.join('\n')}`;
    }
  }

  const r = await streamChatCompletion(baseUrl, model, apiKey, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: work },
    ],
    temperature: 0.2,
  }, { thinking: !!deep, effort: 'low', signal, onDelta });

  let translation = r.translation;
  if (placeholderMap) {
    // 占位符还原;模型改写导致对不上的残留占位符直接清掉,避免露出奇怪符号
    translation = (translation || '').replace(/⟪(\d+)⟫/g, (m, n) => {
      const t = placeholderMap[Number(n)];
      return t ? t.target : m;
    }).replace(/⟪\d+⟫/g, '');
  }

  // 冲突检测(语境通道):原文命中了条目但译文没采用译名 → 渲染层显示小标记
  const termConflicts = placeholderMap || isDict || !termHits.length
    ? []
    : termHits.filter((t) => t.target !== t.source && !(translation || '').includes(t.target)).map((t) => t.source);

  return { translation, tokens: r.tokens, termConflicts };
}

// ---- Win32 亚克力模糊 ----
// Electron 的 backgroundMaterial 在 Win11 24H2+ 有已知 bug(客户端区域不生效等),
// 这里直接调系统 API:SetWindowCompositionAttribute + ACCENT 策略,可指定灰色 tint。
let user32 = null;
try {
  user32 = koffi.load('user32.dll');
} catch (e) {
  console.log('[frost-mirror] 加载 user32 失败:', e.message);
}

function tryAccent(hwnd, state) {
  if (!user32) return false;
  try {
    const SetWindowCompositionAttribute = user32.func(
      'int __stdcall SetWindowCompositionAttribute(uintptr_t, void*)'
    );
    // ACCENT_POLICY:AccentState, AccentFlags, GradientColor(ABGR), AnimationId
    const policy = Buffer.alloc(16);
    policy.writeInt32LE(state, 0);
    policy.writeInt32LE(2, 4);
    policy.writeUInt32LE(0x001f2123, 8); // tint 由 CSS 变量实时调节,这里 alpha 置 0
    policy.writeInt32LE(0, 12);
    // WINDOWCOMPOSITIONATTRIBDATA:Attrib, pvData, cbData
    const data = Buffer.alloc(24);
    data.writeInt32LE(19, 0); // WCA_ACCENT_POLICY
    data.writeBigUInt64LE(BigInt(koffi.address(policy)), 8);
    data.writeBigUInt64LE(16n, 16);
    return SetWindowCompositionAttribute(hwnd, data) !== 0;
  } catch (e) {
    console.log('[frost-mirror] SetWindowCompositionAttribute 失败:', e.message);
    return false;
  }
}

function applyAcrylic(targetWin) {
  const hwndBuf = targetWin.getNativeWindowHandle();
  const hwnd = hwndBuf.length === 4 ? hwndBuf.readUInt32LE(0) : Number(hwndBuf.readBigUInt64LE(0));
  if (tryAccent(hwnd, 4)) {
    // ACCENT_ENABLE_ACRYLICBLURBEHIND(Win10 1803+ / Win11)
    console.log('[frost-mirror] 亚克力已应用(acrylic + 灰色 tint)');
    return;
  }
  if (tryAccent(hwnd, 3)) {
    // ACCENT_ENABLE_BLURBEHIND(更老系统,无 tint)
    console.log('[frost-mirror] 亚克力已应用(blur-behind)');
    return;
  }
  // 兜底:恢复不透明底色,否则透明窗口会完全看不见
  targetWin.setBackgroundColor('#1f2123');
  console.log('[frost-mirror] 系统不支持亚克力,回退实色背景');
}

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 340,
    minWidth: 380,
    minHeight: 240,
    frame: false,
    resizable: true,
    show: false,
    alwaysOnTop: true,
    icon: path.join(__dirname, 'assets', 'icons', 'icon-256.png'),
    // 透明底色让 DWM 亚克力模糊透进来;不用 transparent:true(会丢阴影和最大化)
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  applyAcrylic(win);
  // 最大化/还原等操作后 DWM 有时会丢掉亚克力,重新应用
  win.on('show', () => applyAcrylic(win));
  win.on('restore', () => applyAcrylic(win));
  win.on('maximize', () => applyAcrylic(win));
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
  // 关闭按钮不退出,只隐藏到托盘;真正退出时 isQuitting 已置位
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  console.log('[frost-mirror] 窗口已创建');
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'icon.png'));
  tray.setToolTip('FrostMirror · 镜语');
  tray.on('click', () => {
    win.show();
    win.focus();
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  console.log('[frost-mirror] 托盘已创建');
}

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:save', (e, s) => saveSettings(s));
ipcMain.handle('settings:validate', (e, s) => validateSettings(s));
ipcMain.handle('settings:set-tint', (e, t) => {
  const cur = readSettings();
  cur.tint = Math.min(1, Math.max(0, Number(t) || 0));
  saveSettings(cur);
});
ipcMain.handle('settings:set-lang-target', (e, t) => {
  const cur = readSettings();
  cur.langTarget = typeof t === 'string' && t ? t : 'auto';
  saveSettings(cur);
});
ipcMain.handle('settings:set-deep-mode', (e, v) => {
  const cur = readSettings();
  cur.deepMode = !!v;
  saveSettings(cur);
});

// 进行中的流式翻译:seq → AbortController。渲染层 reset/发起新请求时中止旧流,避免白白消耗 token。
const activeRuns = new Map();

ipcMain.handle('translate:run', async (e, { text, target, mode, seq }) => {
  const s = readSettings();
  if (!s.apiKey || !s.baseUrl || !s.model) {
    throw new Error('请先在设置里填写 API Key、接口地址和模型');
  }
  const controller = new AbortController();
  activeRuns.set(seq, controller);
  const timer = setTimeout(() => controller.abort(), 60000); // 60 秒整体上限,避免永远"翻译中…"
  const started = Date.now();
  try {
    const r = await translate({
      ...s, text, target, deep: s.deepMode, mode,
      signal: controller.signal,
      onDelta: (delta) => {
        try { e.sender.send('translate:delta', { seq, delta }); } catch {}
      },
    });
    const out = { ...r, ms: Date.now() - started };
    addHistory({ text, translation: r.translation || '', mode, target, tokens: r.tokens, ms: out.ms });
    return out;
  } finally {
    clearTimeout(timer);
    activeRuns.delete(seq);
  }
});

ipcMain.handle('translate:cancel', (e, seq) => {
  const c = activeRuns.get(seq);
  if (c) {
    c.abort();
    activeRuns.delete(seq);
  }
});

// ---- 历史记录 IPC ----
ipcMain.handle('history:list', () => loadHistory());
ipcMain.handle('history:delete', (e, id) => {
  const list = loadHistory().filter((x) => x.id !== id);
  try { saveHistory(list); } catch (err) { console.log('[frost-mirror] 历史写入失败:', err.message); }
});
ipcMain.handle('history:clear', () => {
  try { saveHistory([]); } catch (err) { console.log('[frost-mirror] 历史清空失败:', err.message); }
});

// ---- 术语表 IPC ----
ipcMain.handle('terms:get', () => loadTerms());

ipcMain.handle('terms:set-config', (e, cfg) => {
  const t = loadTerms();
  if (typeof cfg.enabled === 'boolean') t.enabled = cfg.enabled;
  if (cfg.channel === 'strict' || cfg.channel === 'context') t.channel = cfg.channel;
  saveTerms(t);
});

ipcMain.handle('terms:add', (e, { source, target, desc }) => {
  const src = String(source || '').trim();
  const dst = String(target || '').trim();
  if (!src || !dst) throw new Error('原文与译名都要填写');
  const t = loadTerms();
  const exist = t.terms.find((x) => (x.source || '').toLowerCase() === src.toLowerCase());
  if (exist) {
    exist.target = dst;
    exist.desc = String(desc || '').trim();
    saveTerms(t);
    return { updated: true };
  }
  t.terms.push({ id: termId(), source: src, target: dst, desc: String(desc || '').trim(), caseSensitive: false, enabled: true });
  saveTerms(t);
  return { updated: false };
});

ipcMain.handle('terms:remove', (e, id) => {
  const t = loadTerms();
  t.terms = t.terms.filter((x) => x.id !== id);
  saveTerms(t);
});

ipcMain.handle('terms:toggle', (e, { id, enabled }) => {
  const t = loadTerms();
  const item = t.terms.find((x) => x.id === id);
  if (item) {
    item.enabled = !!enabled;
    saveTerms(t);
  }
});

ipcMain.handle('terms:import-csv', (e, text) => {
  const rows = parseCsv(text).filter((r) => r[0] && r[1]);
  if (rows[0] && /^source$/i.test(rows[0][0])) rows.shift(); // 跳过表头
  const t = loadTerms();
  let added = 0;
  let updated = 0;
  for (const r of rows) {
    const [src, dst, desc = '', cs = ''] = r;
    const exist = t.terms.find((x) => (x.source || '').toLowerCase() === src.toLowerCase());
    if (exist) {
      exist.target = dst;
      if (desc) exist.desc = desc;
      exist.caseSensitive = /^true$/i.test(cs);
      updated++;
    } else {
      t.terms.push({ id: termId(), source: src, target: dst, desc, caseSensitive: /^true$/i.test(cs), enabled: true });
      added++;
    }
  }
  saveTerms(t);
  return { added, updated };
});

ipcMain.handle('terms:restore-preset', () => {
  const preset = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8'));
  const t = loadTerms();
  let added = 0;
  for (const p of preset) {
    if (!p.source || !p.target) continue;
    if (t.terms.some((x) => (x.source || '').toLowerCase() === p.source.toLowerCase())) continue;
    t.terms.push({ id: termId(), source: p.source, target: p.target, desc: p.desc || '', caseSensitive: false, enabled: true });
    added++;
  }
  saveTerms(t);
  return { added };
});

ipcMain.handle('window:minimize', () => win?.minimize());
ipcMain.handle('window:maximize', () => {
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle('window:close', () => win?.close());
ipcMain.handle('window:pin', (e, on) => {
  win.setAlwaysOnTop(on, 'screen-saver');
});
ipcMain.handle('clipboard:write', (e, t) => {
  const s = String(t ?? '');
  clipboard.writeText(s);
  lastAppWrittenText = s; // 记录本应用写入的内容,轮询读到时忽略,避免复制译文又触发翻译
  lastDispatchedClip = s; // 复制译文后按热键,也不应把译文再翻一遍
});
ipcMain.handle('shell:open-external', (e, url) => {
  // 只允许 http/https,防止渲染层借道打开任意本地程序/协议
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.href);
  } catch {}
});

// ---- 剪贴板监听(复制即翻)----
// Electron 剪贴板没有变化事件,只能轮询(500ms,Pot/CopyTranslator 同款方案);
// 必须放主进程:窗口隐藏时渲染进程定时器会被系统节流。
function startClipWatch() {
  clipWatchEnabled = readSettings().clipWatch;
  try { lastClipText = clipboard.readText(); } catch {}
  setInterval(() => {
    if (!clipWatchEnabled || !win || win.isDestroyed()) return;
    let text = '';
    try { text = clipboard.readText(); } catch { return; }
    if (!text || text === lastClipText) return;
    lastClipText = text;
    if (text === lastAppWrittenText) {
      lastAppWrittenText = ''; // 本应用自己写入的已消费,之后外部复制相同内容仍可触发
      return;
    }
    if (text.length > 2000) return;
    lastDispatchedClip = text; // 复制即翻已处理过该内容,之后热键呼出不再重复翻译
    // 不夺焦点:窗口显示但焦点留在用户当前应用,不打断阅读;热键呼出才抢焦点
    if (!win.isVisible()) win.showInactive();
    win.webContents.send('clipboard:changed', { text, source: 'watch' });
  }, 500);
  console.log('[frost-mirror] 剪贴板监听已启动');
}

ipcMain.handle('settings:set-clip-watch', (e, v) => {
  const cur = readSettings();
  cur.clipWatch = !!v;
  saveSettings(cur);
  clipWatchEnabled = cur.clipWatch;
  if (clipWatchEnabled) {
    try { lastClipText = clipboard.readText(); } catch {} // 重新开启时对齐当前剪贴板,避免误触发
  }
});

// ---- 全局热键:任意应用里呼出窗口(抢焦点),剪贴板有新内容则直接翻译 ----
function onHotkeyTrigger() {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
  let text = '';
  try { text = clipboard.readText(); } catch {}
  // 只翻"新"内容:与最近一次已触发翻译的剪贴板相同 → 只呼出窗口,不重复翻译
  if (text && text.length <= 2000 && text !== lastDispatchedClip) {
    lastDispatchedClip = text;
    win.webContents.send('clipboard:changed', { text, source: 'hotkey' });
  }
}

function registerHotkey(accel) {
  globalShortcut.unregisterAll(); // 只保留一个热键,换绑时先全清
  if (!accel) return true; // 空值 = 用户主动停用
  try {
    if (!globalShortcut.register(accel, onHotkeyTrigger)) return false;
    console.log('[frost-mirror] 全局热键已注册:', accel);
    return true;
  } catch (e) {
    console.log('[frost-mirror] 全局热键注册失败:', e.message);
    return false;
  }
}

ipcMain.handle('settings:set-hotkey', (e, v) => {
  const accel = typeof v === 'string' ? v.trim() : '';
  const cur = readSettings();
  cur.hotkey = accel;
  saveSettings(cur);
  const ok = registerHotkey(accel);
  if (!ok) console.log('[frost-mirror] 全局热键注册失败(可能被其他程序占用):', accel);
  return ok;
});

// 单实例:重复启动时聚焦已有窗口,避免出现两个窗口两个托盘;
// 冒烟测试(DEMO_AUTOCLOSE)模式跳过锁,避免测试被正在运行的实例"吃掉"
const IS_DEMO = !!process.env.DEMO_AUTOCLOSE;
if (!IS_DEMO && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null); // 移除默认菜单,释放 Ctrl+= / Ctrl+- 快捷键(否则会触发缩放)
    app.setAppUserModelId('FrostMirror'); // 任务栏图标分组使用本应用身份
    createWindow();
    createTray();
    startClipWatch();
    if (!registerHotkey(readSettings().hotkey)) {
      console.log('[frost-mirror] 启动时全局热键注册失败,可在设置里改绑');
    }
  });
  app.on('before-quit', () => { isQuitting = true; });
  // 退出时注销全局热键,避免残留在系统里
  app.on('will-quit', () => { globalShortcut.unregisterAll(); });
  // 常驻托盘:窗口全关不代表退出
  app.on('window-all-closed', () => {});

  // 开发调试用:DEMO_AUTOCLOSE=6000 时启动后自动退出,便于自动化冒烟测试
  if (process.env.DEMO_AUTOCLOSE) {
    setTimeout(() => app.quit(), Number(process.env.DEMO_AUTOCLOSE));
  }
}
