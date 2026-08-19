const $ = (id) => document.getElementById(id);

function updateMeta(timeText, tokenText) {
  $('timeText').textContent = timeText;
  $('tokenText').textContent = tokenText;
}

const input = $('input');
const result = $('result');
let pinned = true;
let currentTint = 0.3;
let langTarget = 'auto';
let deepMode = false;
let lastTranslation = ''; // 最近一次真实译文,复制按钮只复制它
let lastSourceText = ''; // 最近一次翻译的原文,剪贴板事件与之相同则跳过
let configured = false; // 是否已配置接口;未配置时剪贴板内容只填入不自动翻译
let translateSeq = 0; // 请求序号,防止并发翻译乱序覆盖

// 启动时回填已保存的配置
window.api.getSettings().then((s) => {
  const f = $('settingsForm');
  f.baseUrl.value = s.baseUrl || '';
  f.model.value = s.model || '';
  f.apiKey.value = s.apiKey || '';
  currentTint = typeof s.tint === 'number' ? s.tint : 0.3;
  document.body.style.setProperty('--glass-alpha', currentTint);
  langTarget = typeof s.langTarget === 'string' ? s.langTarget : 'auto';
  deepMode = !!s.deepMode;
  configured = !!(s.baseUrl && s.model && s.apiKey);
  $('clipWatchCheck').checked = !!s.clipWatch;
  $('hotkeyInput').value = s.hotkey || 'Alt+Q';
  $('deepCheck').checked = deepMode;
  $('deepWarn').classList.toggle('hidden', !deepMode);
  updateIsland();
  updateModelLabel();
  // 首次启动:预填引导表单(若已有配置)并展示两步引导
  const ob = $('obForm');
  ob.baseUrl.value = s.baseUrl || '';
  ob.model.value = s.model || '';
  ob.apiKey.value = s.apiKey || '';
  if (!s.onboarded) $('onboarding').classList.remove('hidden');
}).catch((e) => console.log('[frost-mirror] 读取配置失败:', e));

function updateModelLabel() {
  $('btnModel').textContent = $('settingsForm').model.value.trim() || '未配置模型';
}

// ---- 顶栏:红绿灯 + 图钉 ----
$('btnClose').onclick = () => window.api.close();
$('btnMin').onclick = () => window.api.minimize();
$('btnMax').onclick = () => window.api.maximize();
$('btnPin').onclick = () => {
  pinned = !pinned;
  $('pinTip').textContent = pinned ? '取消置顶' : '恢复置顶';
  $('btnPin').classList.toggle('pinned-off', !pinned);
  window.api.setPin(pinned);
};

// ---- 翻译方向:固定目标语言优先;自动模式下含汉字→英文,其他→设备默认语言 ----
function detectTarget(text) {
  if (langTarget !== 'auto') return langTarget;
  if (/[\u4e00-\u9fa5]/.test(text)) return 'en';
  return navigator.language || 'zh-CN';
}

// ---- 语言"灵动岛":自动 / 固定目标语言 ----
const LANG_LABELS = {
  auto: '自动', 'zh-CN': '中文', en: 'English', ja: '日本語', ko: '한국어',
  fr: 'Français', de: 'Deutsch', es: 'Español', ru: 'Русский', pt: 'Português', it: 'Italiano',
};

function updateIsland() {
  const prefix = deepMode ? '✦ ' : '';
  $('islandLabel').textContent = prefix + (langTarget === 'auto' ? '自动' : '→ ' + LANG_LABELS[langTarget]);
  document.querySelectorAll('.lang-opt').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === langTarget);
  });
}

// 深度模式:开启思考(更慢更贵),面板内即时提示风险
$('deepCheck').onchange = () => {
  deepMode = $('deepCheck').checked;
  window.api.setDeepMode(deepMode).catch(() => {});
  $('deepWarn').classList.toggle('hidden', !deepMode);
  updateIsland();
};

function closeIsland() {
  $('islandPanel').classList.add('hidden');
  $('island').classList.remove('open');
}

$('islandPill').onclick = (e) => {
  e.stopPropagation();
  $('islandPanel').classList.toggle('hidden');
  $('island').classList.toggle('open');
};
document.addEventListener('click', (e) => {
  if (!$('island').contains(e.target)) closeIsland();
});
document.querySelectorAll('.lang-opt').forEach((b) => {
  b.onclick = () => {
    langTarget = b.dataset.lang;
    window.api.setLangTarget(langTarget).catch(() => {});
    updateIsland();
    closeIsland();
  };
});

// ---- 孤词词典模式判定:去空白后无空格、≤30 字符的英文词(允许连字符)→ 词典;否则正常翻译 ----
function detectMode(text) {
  const t = text.trim();
  if (!t || /\s/.test(t)) return 'translate';
  if (t.length > 30) return 'translate';
  if (/^[A-Za-z][A-Za-z-]*$/.test(t)) return 'dict';
  return 'translate';
}

// 底部 meta 区的词典/翻译模式小标记
function setModeBadge(isDict) {
  $('modeIc').textContent = isDict ? '📖' : '⇄';
  $('modeText').textContent = isDict ? '词典' : '翻译';
  $('modeBadge').classList.remove('hidden');
}

async function runTranslate(sourceText) {
  if (sourceText !== undefined) input.value = sourceText; // 剪贴板/热键触发的直翻
  const text = input.value.trim();
  if (!text) return;
  const seq = ++translateSeq;
  const isDict = detectMode(text) === 'dict';
  const target = isDict ? 'zh-CN' : detectTarget(text); // 词典模式固定输出中文义项
  $('btnCopy').textContent = '复制';
  $('resultDst').textContent = '翻译中…';
  updateMeta('-- ms', '-- tokens');
  $('inputHint').classList.add('hidden');
  lastSourceText = text;
  setModeBadge(isDict);
  input.classList.add('shrunk');
  result.classList.remove('hidden');
  try {
    const r = await window.api.translate({ text, target, mode: isDict ? 'dict' : 'translate' });
    if (seq !== translateSeq) return; // 已有更新的请求,丢弃过期结果
    lastTranslation = r.translation || '';
    $('resultDst').textContent = lastTranslation || '(无结果)';
    updateMeta(`${r.ms} ms`, `${r.tokens} tokens`);
  } catch (err) {
    if (seq !== translateSeq) return;
    lastTranslation = '';
    $('resultDst').textContent = '翻译失败:' + err.message;
  }
}

input.addEventListener('keydown', (e) => {
  // isComposing:中文输入法选词回车不应触发翻译
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    runTranslate();
  }
});

// 空输入时提示文字浮在正中,开始输入即隐去;删光文字则结果区一并复位回输入模式
input.addEventListener('input', () => {
  $('inputHint').classList.toggle('hidden', input.value.length > 0);
  if (input.value.length === 0) reset();
});

$('btnCopy').onclick = async () => {
  if (!lastTranslation) return;
  try {
    await window.api.copyText(lastTranslation);
    $('btnCopy').textContent = '已复制 ✓';
  } catch (err) {
    $('btnCopy').textContent = '复制失败';
  }
};

function reset() {
  input.value = '';
  input.classList.remove('shrunk');
  result.classList.add('hidden');
  updateMeta('-- ms', '-- tokens');
  $('inputHint').classList.remove('hidden');
  $('modeBadge').classList.add('hidden');
  lastTranslation = '';
  lastSourceText = '';
  translateSeq++; // 使进行中的旧请求结果作废
}

// ---- 剪贴板监听(复制即翻):主进程轮询到外部新内容后推送过来 ----
window.api.onClipboardChanged(({ text, source }) => {
  const t = String(text || '').trim();
  if (!t) return;
  // 用户正在本窗口内操作(比如复制输入框里的字)时不打断;热键触发是明确意图,照常处理
  if (source === 'watch' && document.hasFocus()) return;
  if (t === input.value.trim() || t === lastSourceText) return; // 与当前显示内容相同,忽略
  input.value = t;
  if (!configured) {
    $('inputHint').classList.add('hidden'); // 未配置接口:只把文字填进来,不自动翻译
    return;
  }
  runTranslate();
});

// 双击结果区或按 Esc 回到输入模式
result.addEventListener('dblclick', reset);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('settingsDialog').open) {
      $('settingsDialog').close();
    } else {
      reset();
    }
    closeIsland();
  }
});

// ---- 设置弹窗(点击底部模型名打开)----
$('btnModel').onclick = () => $('settingsDialog').showModal();
$('btnCancel').onclick = () => $('settingsDialog').close();

// 复制即翻开关:改动立即生效
$('clipWatchCheck').onchange = () => {
  window.api.setClipWatch($('clipWatchCheck').checked).catch(() => {});
};

// 全局热键:失焦即保存并重新注册,注册失败提示;回车等同失焦(不触发表单提交)
$('hotkeyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
  }
});
$('hotkeyInput').addEventListener('change', async () => {
  const accel = $('hotkeyInput').value.trim();
  const msg = $('hotkeyMsg');
  try {
    const ok = await window.api.setHotkey(accel);
    msg.textContent = ok
      ? (accel ? `✓ 已注册 ${accel}` : '✓ 已停用全局热键')
      : `✗ 注册失败:${accel} 可能被其他程序占用`;
    msg.className = ok ? 'validate-msg ok' : 'validate-msg fail';
  } catch (err) {
    msg.textContent = '✗ ' + err.message;
    msg.className = 'validate-msg fail';
  }
});

$('settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const s = {
    baseUrl: f.baseUrl.value.trim(),
    model: f.model.value.trim(),
    apiKey: f.apiKey.value.trim(),
  };
  const msg = $('validateMsg');
  msg.textContent = '验证中…';
  msg.className = 'validate-msg';
  try {
    await window.api.validateSettings(s);
    await window.api.saveSettings(s);
    configured = true;
    msg.textContent = '✓ 连接成功,已保存';
    msg.className = 'validate-msg ok';
    updateModelLabel();
    setTimeout(() => $('settingsDialog').close(), 800);
  } catch (err) {
    msg.textContent = '✗ ' + err.message;
    msg.className = 'validate-msg fail';
  }
};

// ---- 透明度调节:Ctrl+= / Ctrl+- ----
// 单击 ±5%;长按期间每 50ms 线性变化 0.5%(约 10%/s),松开停止;值自动保存。
function setTint(v) {
  currentTint = Math.min(1, Math.max(0, Math.round(v * 100) / 100));
  document.body.style.setProperty('--glass-alpha', currentTint);
}

function persistTint() {
  window.api.setTint(currentTint).catch(() => {});
}

let tintHold = null;
function startTintHold(delta) {
  stopTintHold();
  setTint(currentTint + delta * 0.05);
  tintHold = setInterval(() => setTint(currentTint + delta * 0.005), 50);
}
function stopTintHold() {
  if (tintHold) {
    clearInterval(tintHold);
    tintHold = null;
    persistTint(); // 只在松开时写盘,避免长按期间高频写 settings.json
  }
}

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
  if (e.code === 'Equal' || e.code === 'NumpadAdd') {
    e.preventDefault();
    if (!e.repeat) startTintHold(1);
  } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
    e.preventDefault();
    if (!e.repeat) startTintHold(-1);
  }
});
document.addEventListener('keyup', (e) => {
  if (['Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract'].includes(e.code)) stopTintHold();
});
window.addEventListener('blur', stopTintHold);

// ---- 首次启动引导:介绍 → 配置 → 验证,完成后写入 onboarded 标记 ----
$('obNext').onclick = () => {
  $('obStep1').classList.add('hidden');
  $('obStep2').classList.remove('hidden');
};
$('obBack').onclick = () => {
  $('obStep2').classList.add('hidden');
  $('obStep1').classList.remove('hidden');
};
$('obForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const s = {
    baseUrl: f.baseUrl.value.trim(),
    model: f.model.value.trim(),
    apiKey: f.apiKey.value.trim(),
    onboarded: true,
  };
  const msg = $('obMsg');
  msg.textContent = '验证中…';
  msg.className = 'validate-msg';
  try {
    await window.api.validateSettings(s);
    await window.api.saveSettings(s);
    configured = true;
    msg.textContent = '✓ 连接成功,开始使用';
    msg.className = 'validate-msg ok';
    updateModelLabel();
    setTimeout(() => $('onboarding').classList.add('hidden'), 700);
  } catch (err) {
    msg.textContent = '✗ ' + err.message;
    msg.className = 'validate-msg fail';
  }
};
