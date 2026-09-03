// OpenAI 兼容接口的流式(SSE)请求封装,独立成模块以便测试脚本复用同一份解析代码。
// 约定:普通翻译默认关闭思考(快且省);深度模式开启思考;服务端不认参数回 400 时自动去掉重试一次。
// 流中只取 delta.content(思考流 delta.reasoning_content 直接丢弃),结尾用 usage 统计精确 token。

function friendlyError(e) {
  return new Error(e && e.name === 'AbortError' ? '请求超时或已取消(60 秒上限),请检查网络或更换接口地址' : e.message);
}

async function streamChatCompletion(baseUrl, model, apiKey, body, { thinking = false, effort = 'low', signal, onDelta } = {}) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const extra = thinking
    ? { thinking: { type: 'enabled' }, reasoning_effort: effort }
    : { thinking: { type: 'disabled' } };
  const payload = { model, stream: true, stream_options: { include_usage: true }, ...body };
  const send = (p) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(p),
    signal,
  });
  let res;
  try {
    res = await send({ ...payload, ...extra });
  } catch (e) {
    throw friendlyError(e);
  }
  if (res.status === 400) {
    // 服务端不识别 thinking / reasoning_effort 参数:去掉后重试一次
    try {
      res = await send(payload);
    } catch (e) {
      throw friendlyError(e);
    }
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${t.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let usage = null;
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      throw friendlyError(e);
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '').trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (d && typeof d.content === 'string' && d.content) {
          content += d.content;
          if (onDelta) onDelta(d.content);
        }
        if (j.usage) usage = j.usage; // include_usage:最后一个块带精确 token
      } catch {}
    }
  }
  return { translation: content.trim(), tokens: (usage && usage.total_tokens) || 0 };
}

module.exports = { streamChatCompletion };
