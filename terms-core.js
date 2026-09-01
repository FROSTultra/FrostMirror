// 术语表纯逻辑:匹配正则、命中查找、CSV 解析。独立成模块以便测试脚本复用同一份代码。

// 术语匹配正则:ASCII 词用 \b 全词边界;结尾复数兼容(library→libraries,cache→caches)
function buildTermRegex(source, caseSensitive) {
  const esc = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+').trim();
  let body = esc;
  if (/[yY]$/.test(body)) {
    const last = body.slice(-1);
    body = body.slice(0, -1) + `(?:${last}|${last === 'y' ? 'ies' : 'IES'})`;
  }
  const tail = '(?:s|es)?';
  // 词边界只对 ASCII 词有意义;中文等直接字面匹配
  const pattern = /^[\x20-\x7E]+$/.test(source) ? `\\b${body}${tail}\\b` : `${body}${tail}`;
  return new RegExp(pattern, caseSensitive ? 'g' : 'gi');
}

// 命中原文的条目,按 source 长度降序(先长后短,避免 "API" 抢走 "API Gateway")
function findTermHits(text, terms) {
  const hits = [];
  const sorted = [...terms].sort((a, b) => (b.source || '').length - (a.source || '').length);
  for (const t of sorted) {
    if (!t.source || !t.target) continue;
    try {
      if (buildTermRegex(t.source, !!t.caseSensitive).test(text)) hits.push(t);
    } catch {}
  }
  return hits;
}

// CSV 解析:支持 "带,逗号/换行" 的双引号字段;每行 source,target,description,case_sensitive
function parseCsv(text) {
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else inQuote = false;
      } else cell += c;
    } else if (c === '"') inQuote = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some(Boolean));
}

module.exports = { buildTermRegex, findTermHits, parseCsv };
