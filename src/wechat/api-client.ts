// =============================================================================
// WeChat Work (企业微信) API Client — token, media, messaging
// =============================================================================

const API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";

interface TokenCache { token: string; expiresAt: number; }

let _tokenCache: TokenCache | null = null;

function getCorpId(): string { return process.env["WECHAT_CORP_ID"] || ""; }
function getAgentId(): string { return process.env["WECHAT_AGENT_ID"] || ""; }
function getSecret(): string { return process.env["WECHAT_SECRET"] || ""; }

// ---- Token ----

export async function getAccessToken(): Promise<string> {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt - 300_000) return _tokenCache.token;
  const corpId = getCorpId(); const secret = getSecret();
  if (!corpId || !secret) throw new Error("WECHAT_CORP_ID / WECHAT_SECRET not configured");
  const url = `${API_BASE}/gettoken?corpid=${corpId}&corpsecret=${secret}`;
  const r = await fetch(url); const j = await r.json() as any;
  if (j.errcode !== 0) throw new Error(`Token error: ${j.errmsg} (${j.errcode})`);
  _tokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 7200) * 1000 };
  console.log(`[WeChatAPI] Token refreshed, expires in ${j.expires_in}s`);
  return _tokenCache.token;
}

// ---- Media Upload ----

export type MediaType = "image" | "voice" | "video" | "file";

export async function uploadMedia(type: MediaType, filePath: string, filename?: string): Promise<string> {
  const token = await getAccessToken();
  const url = `${API_BASE}/media/upload?access_token=${token}&type=${type}`;
  const { readFileSync } = await import("node:fs");
  const buf = readFileSync(filePath);
  const name = filename || filePath.replace(/^.*[\\/]/, "");
  const form = new FormData();
  const blob = new Blob([buf]);
  form.append("media", blob, name);
  const r = await fetch(url, { method: "POST", body: form });
  const j = await r.json() as any;
  if (j.errcode !== 0) throw new Error(`Upload error: ${j.errmsg} (${j.errcode})`);
  console.log(`[WeChatAPI] Uploaded ${type}: ${name} → media_id=${j.media_id}`);
  return j.media_id;
}

export async function uploadImage(buf: Buffer, filename?: string): Promise<string> {
  const token = await getAccessToken();
  const url = `${API_BASE}/media/upload?access_token=${token}&type=image`;
  const form = new FormData();
  const blob = new Blob([buf]);
  form.append("media", blob, filename || "image.png");
  const r = await fetch(url, { method: "POST", body: form });
  const j = await r.json() as any;
  if (j.errcode !== 0) throw new Error(`Upload image error: ${j.errmsg}`);
  return j.media_id;
}

// ---- Message Sending ----

async function sendMsg(payload: Record<string, any>): Promise<void> {
  const token = await getAccessToken();
  const url = `${API_BASE}/message/send?access_token=${token}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const j = await r.json() as any;
  if (j.errcode !== 0) throw new Error(`Send error: ${j.errmsg} (${j.errcode})`);
  console.log(`[WeChatAPI] Sent: ${payload.msgtype} → ${payload.touser?.slice(0, 15)}...`);
}

export async function sendText(toUser: string, content: string): Promise<void> {
  await sendMsg({ touser: toUser, msgtype: "text", agentid: getAgentId(), text: { content: content.slice(0, 2048) }, safe: 0 });
}

export async function sendMarkdown(toUser: string, content: string): Promise<void> {
  await sendMsg({ touser: toUser, msgtype: "markdown", agentid: getAgentId(), markdown: { content: content.slice(0, 4096) }, safe: 0 });
}

export async function sendImage(toUser: string, mediaId: string): Promise<void> {
  await sendMsg({ touser: toUser, msgtype: "image", agentid: getAgentId(), image: { media_id: mediaId }, safe: 0 });
}

export async function sendFile(toUser: string, mediaId: string): Promise<void> {
  await sendMsg({ touser: toUser, msgtype: "file", agentid: getAgentId(), file: { media_id: mediaId }, safe: 0 });
}

export async function sendVoice(toUser: string, mediaId: string): Promise<void> {
  await sendMsg({ touser: toUser, msgtype: "voice", agentid: getAgentId(), voice: { media_id: mediaId }, safe: 0 });
}

export async function sendVideo(toUser: string, mediaId: string, title?: string, desc?: string): Promise<void> {
  await sendMsg({ touser: toUser, msgtype: "video", agentid: getAgentId(), video: { media_id: mediaId, title: title || "", description: desc || "" }, safe: 0 });
}

export interface Article {
  title: string; description?: string; url: string; picurl?: string;
}

export async function sendNews(toUser: string, articles: Article[]): Promise<void> {
  await sendMsg({ touser: toUser, msgtype: "news", agentid: getAgentId(), news: { articles: articles.slice(0, 8) }, safe: 0 });
}

export async function sendTextCard(toUser: string, title: string, description: string, url: string, btntxt?: string): Promise<void> {
  await sendMsg({ touser: toUser, msgtype: "textcard", agentid: getAgentId(), textcard: { title, description, url, btntxt: btntxt || "查看详情" }, safe: 0 });
}

export interface TemplateCard {
  card_type: "text_notice" | "news_notice";
  main_title: { title: string; desc?: string };
  emphasis_content?: { title: string; desc?: string };
  sub_title_text?: string;
  horizontal_content_list?: { keyname: string; value: string }[];
  jump_list?: { title: string; type: number; url?: string }[];
  card_action?: { type: number; url: string };
}

export async function sendTemplateCard(toUser: string, card: TemplateCard): Promise<void> {
  await sendMsg({ touser: toUser, msgtype: "template_card", agentid: getAgentId(), template_card: card, safe: 0 });
}

// ---- User Info ----

export async function getUserInfo(userId: string): Promise<{ name: string; department: string[] }> {
  const token = await getAccessToken();
  const url = `${API_BASE}/user/get?access_token=${token}&userid=${userId}`;
  const r = await fetch(url); const j = await r.json() as any;
  if (j.errcode !== 0) throw new Error(`UserInfo error: ${j.errmsg}`);
  return { name: j.name || userId, department: j.department || [] };
}
