const $ = (id) => document.getElementById(id);

// ---- Markdown 渲染管线:marked 解析(关闭原始 HTML)→ DOMPurify 消毒 → innerHTML ----
// AI 输出是外部不可信输入,消毒必须在插入 DOM 前完成
if (typeof marked !== 'undefined') {
  marked.use({ breaks: true, gfm: true, html: false });
}

function setResultHtml(md) {
  const raw = String(md ?? '');
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    $('resultDst').textContent = raw; // 库加载失败的兜底:纯文本
    return;
  }
  $('resultDst').innerHTML = DOMPurify.sanitize(marked.parse(raw), {
    USE_PROFILES: { html: true },
    SANITIZE_NAMED_PROPS: true,
  });
}

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
  $('deepWarn').classList.toggle('open', deepMode);
  updateIsland();
  updateModelLabel();
  // 首次启动:预填引导表单(若已有配置)并展示两步引导
  const ob = $('obForm');
  ob.baseUrl.value = s.baseUrl || '';
  ob.model.value = s.model || '';
  ob.apiKey.value = s.apiKey || '';
  if (!s.onboarded) $('onboarding').classList.remove('hidden');
  // 数据存储位置选择器的初始高亮与提示
  refreshStoragePickers().catch(() => {});
}).catch((e) => console.log('[frost-mirror] 读取配置失败:', e));

function updateModelLabel() {
  $('btnModel').textContent = $('settingsForm').model.value.trim() || '未配置模型';
}

// ---- 数据存储位置选择(首次告知弹窗 + 设置弹窗共用同一逻辑) ----
const noticeDialog = $('noticeDialog');
let noticePending = false;
function showDataDirNotice() {
  if (noticeDialog.open) return;
  noticePending = true;
  // 等设置弹窗先关掉(节省的 setTimeout 关闭时机可能竞态),避免两个弹窗叠在一起
  setTimeout(openPendingNotice, 850);
}
async function openPendingNotice() {
  if (!noticePending) return;
  const settingsDlg = $('settingsDialog');
  if (settingsDlg.open) {
    settingsDlg.addEventListener('close', () => openPendingNotice(), { once: true });
    return; // 设置弹窗还开着,等它 close 再弹
  }
  noticePending = false;
  byId('storagePickerNotice').classList.remove('hidden');
  await refreshStoragePickers();
  noticeDialog.showModal();
}

function byId(id) { return document.getElementById(id); }

// 数据目录选择器:点击选项立即切换(主进程迁移数据),渲染层保持高亮与现状一致
async function storageSelect(mode, pickerId, hintId) {
  const r = await window.api.setDataDir(mode);
  if (r.ok) {
    await refreshStoragePickers();
  } else {
    const msg = byId(hintId);
    msg.textContent = '✗ 切换失败:' + r.error;
    msg.classList.add('fail');
    await refreshStoragePickers();
  }
}

async function refreshStoragePickers() {
  const info = await window.api.getDataDir();
  for (const pickerId of ['storagePickerNotice', 'storagePickerSettings']) {
    const picker = byId(pickerId);
    if (!picker) continue;
    for (const b of picker.querySelectorAll('[data-storage]')) {
      b.classList.toggle('active', b.dataset.storage === info.mode);
      b.disabled = info.mode === 'dev';
    }
  }
  for (const hintId of ['storageHintNotice', 'storageHintSettings']) {
    const hint = byId(hintId);
    if (!hint) continue;
    const cur = info.mode === 'portable' ? '程序目录(便携)' : info.mode === 'appdata' ? '系统用户目录' : '开发模式';
    hint.textContent = info.mode === 'dev'
      ? '开发模式(未打包):数据固定存项目目录,忽略此设置。'
      : `当前:${cur} → ${info.dataDir}`;
    hint.classList.remove('fail');
  }
}

// 两个入口(通知弹窗 + 设置弹窗)共用一份绑定,setDataDir 主进程负责迁移与标志。
// 注意后续新增入口时同步补充 DOM id。
for (const [pickerId, hintId] of [['storagePickerNotice', 'storageHintNotice'], ['storagePickerSettings', 'storageHintSettings']]) {
  const picker = byId(pickerId);
  if (!picker) continue;
  for (const btn of picker.querySelectorAll('[data-storage]')) {
    btn.addEventListener('click', () => storageSelect(btn.dataset.storage, pickerId, hintId));
  }
}

$('btnNotice').addEventListener('click', () => noticeDialog.close());

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
  $('deepWarn').classList.toggle('open', deepMode);
  // 提示展开期间逐帧钉住面板底部:内容随文字生长平滑上滑,文字自然浮入视野,
  // 与过渡同时结束,避免 scrollHeight 未计入展开高度导致滚动落点偏差
  if (deepMode) {
    const p = $('islandPanel');
    const t0 = performance.now();
    const pinBottom = (t) => {
      p.scrollTop = p.scrollHeight;
      if (t - t0 < 400) requestAnimationFrame(pinBottom);
    };
    requestAnimationFrame(pinBottom);
  }
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

// 底部 meta 区的词典/翻译模式小标记(两枚线性 SVG 切换,与全站图标同风格)
function setModeBadge(isDict) {
  $('icDict').classList.toggle('hidden', !isDict);
  $('icTrans').classList.toggle('hidden', isDict);
  $('modeText').textContent = isDict ? '词典' : '翻译';
  $('modeBadge').classList.remove('hidden');
}

// ---- 流式输出:主进程按 seq 推增量,40ms 节流渲染(每次全量 marked+DOMPurify,文本量小无压力) ----
let streamBuf = '';
let streamFlushTimer = null;

function flushStream() {
  streamFlushTimer = null;
  if (streamBuf) {
    setResultHtml(streamBuf);
    $('resultDst').scrollTop = $('resultDst').scrollHeight; // 流式期间跟随滚到底部
  }
}

window.api.onTranslateDelta(({ seq, delta }) => {
  if (seq !== translateSeq) return; // 已有更新的请求,丢弃过期增量
  streamBuf += delta;
  if (!streamFlushTimer) streamFlushTimer = setTimeout(flushStream, 40);
});

async function runTranslate(sourceText) {
  if (sourceText !== undefined) input.value = sourceText; // 剪贴板/热键触发的直翻
  const text = input.value.trim();
  if (!text) return;
  const seq = ++translateSeq;
  window.api.cancelTranslate(seq - 1); // 中止还在进行的旧流,别让它白烧 token
  const isDict = detectMode(text) === 'dict';
  const target = isDict ? 'zh-CN' : detectTarget(text); // 词典模式固定输出中文义项
  $('btnCopy').textContent = '复制';
  streamBuf = '';
  setResultHtml('翻译中…');
  updateMeta('-- ms', '-- tokens');
  $('inputHint').classList.add('hidden');
  lastSourceText = text;
  setModeBadge(isDict);
  input.classList.add('shrunk');
  result.classList.remove('hidden');
  try {
    const r = await window.api.translate({ text, target, mode: isDict ? 'dict' : 'translate', seq });
    if (seq !== translateSeq) return; // 已有更新的请求,丢弃过期结果
    lastTranslation = r.translation || '';
    setResultHtml(lastTranslation || '(无结果)');
    updateMeta(`${r.ms} ms`, `${r.tokens} tokens`);
    updateTermWarn(r.termConflicts);
  } catch (err) {
    if (seq !== translateSeq) return;
    lastTranslation = '';
    setResultHtml('翻译失败:' + err.message);
  }
}

// ---- 术语表:管理弹窗 + 结果一键收录 + "译文未采用译名"冲突标记 ----
let termsData = { enabled: true, channel: 'context', terms: [] };

const CHANNEL_HINTS = {
  context: '语境模式:命中的词条作为对照表交给模型,优先遵循但保留自然语感。',
  strict: '严格模式:原文中的术语先替换为占位符,译文再还原成你的译名,结果确定不移。',
};

function updateChannelUI() {
  document.querySelectorAll('.channel-opt').forEach((b) => {
    b.classList.toggle('active', b.dataset.ch === termsData.channel);
  });
  $('termsChannelHint').textContent = CHANNEL_HINTS[termsData.channel] || '';
}

function renderTermList() {
  const box = $('termList');
  if (!termsData.terms.length) {
    box.innerHTML = '<p class="hint">还没有术语。点下方"恢复预置包"或手动添加。</p>';
    return;
  }
  box.innerHTML = termsData.terms.map((t) => `
    <div class="t-row" data-id="${t.id}">
      <input type="checkbox" class="t-on" ${t.enabled !== false ? 'checked' : ''} />
      <span class="t-src">${escHtml(t.source)}</span>
      <span class="cap-arrow">→</span>
      <span class="t-dst">${escHtml(t.target)}</span>
      <button class="t-del" title="删除">×</button>
    </div>`).join('');
}

async function openTermsDialog() {
  try { termsData = await window.api.getTerms(); } catch { /* 保持默认 */ }
  $('termsEnabled').checked = termsData.enabled;
  updateChannelUI();
  renderTermList();
  $('termsMsg').textContent = '';
  $('termsDialog').showModal();
  // 术语开关/通道/删除都是即时保存,只有新增术语的两个输入框受保护(未点击"添加"前别误关)
  snapshotDialog($('termsDialog'), '#termNewSrc, #termNewDst');
}

$('btnOpenTerms').onclick = () => {
  $('settingsDialog').close();
  openTermsDialog();
};
$('btnTermsClose').onclick = () => $('termsDialog').close();

$('termsEnabled').onchange = async () => {
  termsData.enabled = $('termsEnabled').checked;
  await window.api.setTermsConfig({ enabled: termsData.enabled }).catch(() => {});
};

document.querySelectorAll('.channel-opt').forEach((b) => {
  b.onclick = async () => {
    termsData.channel = b.dataset.ch;
    updateChannelUI();
    await window.api.setTermsConfig({ channel: termsData.channel }).catch(() => {});
  };
});

$('btnTermAdd').onclick = async () => {
  const src = $('termNewSrc').value.trim();
  const dst = $('termNewDst').value.trim();
  if (!src || !dst) {
    $('termsMsg').textContent = '✗ 原文与译名都要填写';
    $('termsMsg').className = 'validate-msg fail';
    return;
  }
  try {
    const r = await window.api.addTerm({ source: src, target: dst, desc: '' });
    $('termNewSrc').value = '';
    $('termNewDst').value = '';
    termsData = await window.api.getTerms();
    renderTermList();
    $('termsMsg').textContent = r.updated ? '✓ 已更新同名条目' : '✓ 已添加';
    $('termsMsg').className = 'validate-msg ok';
  } catch (err) {
    $('termsMsg').textContent = '✗ ' + err.message;
    $('termsMsg').className = 'validate-msg fail';
  }
};

$('termList').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('t-on')) return;
  const id = e.target.closest('.t-row').dataset.id;
  await window.api.toggleTerm({ id, enabled: e.target.checked }).catch(() => {});
  const item = termsData.terms.find((x) => x.id === id);
  if (item) item.enabled = e.target.checked;
});

$('termList').addEventListener('click', async (e) => {
  const del = e.target.closest('.t-del');
  if (!del) return;
  const id = del.closest('.t-row').dataset.id;
  await window.api.removeTerm(id).catch(() => {});
  termsData.terms = termsData.terms.filter((x) => x.id !== id);
  renderTermList();
});

$('btnTermsCsv').onclick = () => $('termsCsvFile').click();
$('termsCsvFile').onchange = async () => {
  const file = $('termsCsvFile').files[0];
  if (!file) return;
  try {
    const r = await window.api.importTermsCsv(await file.text());
    termsData = await window.api.getTerms();
    renderTermList();
    $('termsMsg').textContent = `✓ 导入完成:新增 ${r.added} 条,更新 ${r.updated} 条`;
    $('termsMsg').className = 'validate-msg ok';
  } catch (err) {
    $('termsMsg').textContent = '✗ ' + err.message;
    $('termsMsg').className = 'validate-msg fail';
  }
  $('termsCsvFile').value = '';
};

$('btnTermsPreset').onclick = async () => {
  try {
    const r = await window.api.restoreTermsPreset();
    termsData = await window.api.getTerms();
    renderTermList();
    $('termsMsg').textContent = r.added ? `✓ 已补充预置术语 ${r.added} 条` : '✓ 预置术语已在表中,无新增';
    $('termsMsg').className = 'validate-msg ok';
  } catch (err) {
    $('termsMsg').textContent = '✗ ' + err.message;
    $('termsMsg').className = 'validate-msg fail';
  }
};

// 冲突小标记:原文命中条目但译文没采用译名时点亮,点击进术语管理
function updateTermWarn(conflicts) {
  const warn = $('termWarn');
  if (conflicts && conflicts.length) {
    warn.title = '这些术语未按你的译名翻译:' + conflicts.join('、');
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }
}
$('termWarn').onclick = openTermsDialog;

// 一键收录:默认把译文里选中的文字当译名,孤词原文自动填入
$('btnTerm').onclick = () => {
  const sel = String(window.getSelection() || '').trim();
  const src = detectMode(input.value.trim()) === 'dict' ? input.value.trim() : '';
  $('capSrc').value = src;
  $('capDst').value = sel;
  $('capDesc').value = '';
  $('termCapture').classList.remove('hidden');
  (src ? $('capDst') : $('capSrc')).focus();
};
$('capCancel').onclick = () => $('termCapture').classList.add('hidden');
$('capSave').onclick = async () => {
  const src = $('capSrc').value.trim();
  const dst = $('capDst').value.trim();
  if (!src || !dst) {
    $('btnTerm').textContent = '两栏都填';
    setTimeout(() => { $('btnTerm').textContent = '＋术语'; }, 1500);
    return;
  }
  try {
    const r = await window.api.addTerm({ source: src, target: dst, desc: $('capDesc').value.trim() });
    $('termCapture').classList.add('hidden');
    $('btnTerm').textContent = r.updated ? '已更新 ✓' : '已收录 ✓';
  } catch (err) {
    $('btnTerm').textContent = '收录失败';
  }
  setTimeout(() => { $('btnTerm').textContent = '＋术语'; }, 1500);
};

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
  $('termWarn').classList.add('hidden');
  $('termCapture').classList.add('hidden');
  lastTranslation = '';
  lastSourceText = '';
  window.api.cancelTranslate(translateSeq); // 先中止正在跑的旧流(seq 是它发起时的值)
  translateSeq++; // 再使其结果作废
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

// 双击结果区或按 Esc 回到输入模式;单击链接在系统浏览器打开(不劫持窗口)
result.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a');
  if (a && a.href) {
    e.preventDefault();
    window.api.openExternal(a.href).catch(() => {});
  }
});
result.addEventListener('dblclick', reset);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const open = document.querySelector('dialog[open]');
    if (open) {
      open.close(); // Esc 优先关掉最上层弹窗
    } else {
      reset();
    }
    closeIsland();
  }
});

// ---- 历史记录:点击条目回看,条目内复译/复制/删除;翻译成功由主进程自动落盘 ----
let histCache = [];
let clearArmed = null;

function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function renderHistory() {
  const box = $('histList');
  if (!histCache.length) {
    box.innerHTML = '<p class="hint">还没有记录。</p>';
    return;
  }
  box.innerHTML = histCache.map((it) => `
    <div class="h-item" data-id="${it.id}">
      <div class="h-head">
        <span class="h-time">${fmtTime(it.time)}</span>
        <span class="h-mode">${it.mode === 'dict' ? '词典' : '翻译'}</span>
        <span class="h-acts">
          <button data-act="retry">复译</button>
          <button data-act="copy">复制</button>
          <button data-act="del">×</button>
        </span>
      </div>
      <div class="h-src">${escHtml(it.text)}</div>
      <div class="h-dst">${escHtml(it.translation)}</div>
    </div>`).join('');
}

// 把一条历史载入主界面(回看);进行中的翻译流先作废,避免覆盖回看内容
function reviewItem(it) {
  window.api.cancelTranslate(translateSeq);
  translateSeq++;
  input.value = it.text || '';
  input.classList.add('shrunk');
  result.classList.remove('hidden');
  $('inputHint').classList.add('hidden');
  $('termWarn').classList.add('hidden');
  $('termCapture').classList.add('hidden');
  setModeBadge(it.mode === 'dict');
  lastTranslation = it.translation || '';
  lastSourceText = it.text || '';
  setResultHtml(lastTranslation || '(无结果)');
  updateMeta(`${it.ms || '--'} ms`, `${it.tokens || '--'} tokens`);
  $('btnCopy').textContent = '复制';
}

$('btnHistory').onclick = async () => {
  try { histCache = await window.api.listHistory(); } catch { histCache = []; }
  renderHistory();
  $('historyDialog').showModal();
  snapshotDialog($('historyDialog'), ''); // 无输入控件,点空白随时可关
};
$('btnHistClose').onclick = () => $('historyDialog').close();
$('btnHistClear').onclick = async () => {
  // 两击确认,避免误触直接清空全部
  if (!clearArmed) {
    $('btnHistClear').textContent = '确认清空?';
    clearArmed = setTimeout(() => {
      $('btnHistClear').textContent = '清空';
      clearArmed = null;
    }, 3000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  $('btnHistClear').textContent = '清空';
  await window.api.clearHistory();
  histCache = [];
  renderHistory();
};

$('histList').addEventListener('click', async (e) => {
  const item = e.target.closest('.h-item');
  if (!item) return;
  const it = histCache.find((x) => x.id === item.dataset.id);
  if (!it) return;
  const btn = e.target.closest('button');
  if (!btn) {
    $('historyDialog').close();
    reviewItem(it);
    return;
  }
  if (btn.dataset.act === 'del') {
    await window.api.deleteHistory(it.id);
    histCache = histCache.filter((x) => x.id !== it.id);
    renderHistory();
  } else if (btn.dataset.act === 'copy') {
    if (!it.translation) return;
    await window.api.copyText(it.translation);
    btn.textContent = '已复制 ✓';
    setTimeout(() => { btn.textContent = '复制'; }, 1200);
  } else if (btn.dataset.act === 'retry') {
    $('historyDialog').close();
    input.value = it.text || '';
    runTranslate();
  }
});

// ---- 设置弹窗(点击底部模型名打开)----
$('btnModel').onclick = () => {
  $('settingsDialog').showModal();
  snapshotDialog($('settingsDialog'));
};
$('btnCancel').onclick = () => $('settingsDialog').close();

// ---- 弹窗点空白自动关闭:打开时快照"未保存改动"范围,点击遮罩且无改动才关闭 ----
// guardSel:受保护控件(改动未保存/会丢失);不传则全弹窗控件受保护,传 '' 表示随时可点空白关闭
const dlgDirty = new WeakMap(); // dialog -> () => boolean
function snapshotDialog(dlg, guardSel) {
  const sel = guardSel || 'input:not([type="file"]):not([type="hidden"]), select, textarea';
  const read = () => [...dlg.querySelectorAll(sel)]
    .map((el) => (el.type === 'checkbox' ? el.checked : el.value)).join('\u0001');
  const base = read();
  dlgDirty.set(dlg, guardSel === '' ? null : () => read() !== base);
}
function bindBackdropDismiss(dlg) {
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return; // 只处理点在弹窗自身(遮罩/留白)上的点击
    const r = dlg.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
    if (dlgDirty.get(dlg)?.()) return; // 有未保存改动:留给保存/取消,不误关
    dlg.close();
  });
}
bindBackdropDismiss($('settingsDialog'));
bindBackdropDismiss($('termsDialog'));
bindBackdropDismiss($('historyDialog'));

// 复制即翻开关:改动立即生效
$('clipWatchCheck').onchange = () => {
  window.api.setClipWatch($('clipWatchCheck').checked).catch(() => {});
};

// 全局热键:聚焦后直接按组合键,即时捕获显示并保存(如按 Alt+O 即显示 Alt+O);
// 不再要求手输 accelerator。退格/删除清空停用,Esc 恢复未捕获状态。
const hotkeyInput = $('hotkeyInput');
hotkeyInput.addEventListener('focus', () => {
  hotkeyInput.dataset.prev = hotkeyInput.value;
});
hotkeyInput.addEventListener('keydown', (e) => {
  // 纯功能键(修饰键/Shift/Ctrl/Alt)不构成组合,等待下一个键
  const MOD = ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock'];
  if (MOD.includes(e.key)) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  e.stopPropagation(); // 防止 Esc 触发全局"关弹窗/重置"
  const msg = $('hotkeyMsg');
  if (e.key === 'Backspace' || e.key === 'Delete') {
    hotkeyInput.value = '';
    saveHotkey('');
    msg.textContent = '✓ 已停用全局热键';
    msg.className = 'validate-msg ok';
    return;
  }
  if (e.key === 'Escape') {
    hotkeyInput.value = hotkeyInput.dataset.prev || '';
    hotkeyInput.blur();
    return;
  }
  const accel = buildAccel(e);
  if (!accel) {
    msg.textContent = '✗ 请同时按 Ctrl / Alt / Shift 之一与一个字符键';
    msg.className = 'validate-msg fail';
    return;
  }
  hotkeyInput.value = accel;
  saveHotkey(accel);
  msg.textContent = `✓ 已捕获 ${accel}`;
  msg.className = 'validate-msg ok';
});

// 把键盘事件转成 accelerator 字符串:修饰键在前,主键规范化(如 Alt+O、Ctrl+Shift+A、F5)
function buildAccel(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  let key = '';
  const k = e.key;
  if (/^[a-z]$/i.test(k)) key = k.toUpperCase();
  else if (/^[0-9]$/.test(k)) key = k;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(k)) key = k.toUpperCase();
  else if (k === ' ') key = 'Space';
  else if (k === 'Tab') key = 'Tab';
  else if (k === 'Enter') key = 'Enter';
  else if (k === 'ArrowUp') key = 'Up';
  else if (k === 'ArrowDown') key = 'Down';
  else if (k === 'ArrowLeft') key = 'Left';
  else if (k === 'ArrowRight') key = 'Right';
  else if (k === 'Home') key = 'Home';
  else if (k === 'End') key = 'End';
  else if (k === 'PageUp') key = 'PageUp';
  else if (k === 'PageDown') key = 'PageDown';
  else if (k === 'Insert') key = 'Insert';
  else if (k === 'Delete') key = 'Delete';
  else if (k && k.length === 1) key = k.toUpperCase(); // 其他单字符(符号等)
  else return '';
  // 主键必须带至少一个修饰键,避免纯字母键误触发
  if (!mods.length) return '';
  return [...mods, key].join('+');
}

async function saveHotkey(accel) {
  const msg = $('hotkeyMsg');
  try {
    const ok = await window.api.setHotkey(accel);
    if (!ok) {
      msg.textContent = `✗ 注册失败:${accel} 可能被其他程序占用`;
      msg.className = 'validate-msg fail';
    }
  } catch (err) {
    msg.textContent = '✗ ' + err.message;
    msg.className = 'validate-msg fail';
  }
}

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
    const saved = await window.api.saveSettings(s);
    configured = true;
    msg.textContent = '✓ 连接成功,已保存';
    msg.className = 'validate-msg ok';
    updateModelLabel();
    if (saved?.firstConfig) showDataDirNotice();
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
  // 步长必须落在 setTint 的 1% 取整网格上:此前 0.5%/50ms 的半格步长会被取整吞掉,长按纹丝不动
  tintHold = setInterval(() => setTint(currentTint + delta * 0.01), 100);
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
    const saved = await window.api.saveSettings(s);
    configured = true;
    msg.textContent = '✓ 连接成功,开始使用';
    msg.className = 'validate-msg ok';
    // 引导表单与设置弹窗是两个表单:同步过去,标签立刻显示模型名(否则要重启才出现)
    const sf = $('settingsForm');
    sf.baseUrl.value = s.baseUrl;
    sf.model.value = s.model;
    sf.apiKey.value = s.apiKey;
    updateModelLabel();
    if (saved?.firstConfig) showDataDirNotice();
    setTimeout(() => $('onboarding').classList.add('hidden'), 700);
  } catch (err) {
    msg.textContent = '✗ ' + err.message;
    msg.className = 'validate-msg fail';
  }
};
