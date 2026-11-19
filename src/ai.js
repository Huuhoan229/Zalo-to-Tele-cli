function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Thiếu AI_BASE_URL (hoặc ROUTER_BASE_URL).');
  return /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

export async function completeChat({ baseUrl, apiKey, model, systemPrompt, history = [], text, imageUrls = [] }) {
  if (!apiKey) throw new Error('Thiếu AI_API_KEY (hoặc ROUTER_API_KEY).');
  if (!model) throw new Error('Thiếu AI_MODEL (hoặc DEFAULT_MODEL).');
  const userContent = imageUrls.length
    ? [
        { type: 'text', text: String(text || 'Mô tả và phân tích hình ảnh này.') },
        ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
      ]
    : String(text || '');
  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...history.filter((item) => ['user', 'assistant'].includes(item.role)),
    { role: 'user', content: userContent },
  ];
  const response = await fetch(chatCompletionsUrl(baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(90000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`AI trả lỗi HTTP ${response.status}: ${raw.slice(0, 400)}`);
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error('AI trả về JSON không hợp lệ.'); }
  const answer = result?.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('AI không trả về nội dung.');
  return answer.trim();
}
