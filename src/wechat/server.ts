// =============================================================================
// WeChat Work (企业微信) Callback Server — shared by REPL and headless bot
// =============================================================================

import { createServer } from "node:http";
import type { Server } from "node:http";
import { createHash, createDecipheriv, createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync as fexists, statSync, readdirSync, readFileSync } from "node:fs";
import { uploadMedia, sendText, sendMarkdown, sendImage, sendFile } from "./api-client.js";
import { sanitizeExternal } from "../security/injection-guard.js";
import { listenFallback } from "../coordination/listen-fallback.js";

// ---- Config (from env) ----
const TOKEN = process.env["WECHAT_TOKEN"] || "";
const ENCODING_AES_KEY = process.env["WECHAT_ENCODING_AES_KEY"] || "HpdzIGY5hbA1rxiPDmdUEQw1JsAdgUrMcA2vsSfjsJs";
const CORP_ID = process.env["WECHAT_CORP_ID"] || "";
const AES_KEY = Buffer.from(ENCODING_AES_KEY + "=", "base64");

// ---- Crypto ----
function wechatDecrypt(encrypted: string): string {
  const decipher = createDecipheriv("aes-256-cbc", AES_KEY, AES_KEY.subarray(0, 16));
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([decipher.update(encrypted, "base64"), decipher.final()]);
  const padLen = decrypted[decrypted.length - 1];
  decrypted = decrypted.subarray(0, decrypted.length - padLen);
  const msgLen = decrypted.readUInt32BE(16);
  return decrypted.subarray(20, 20 + msgLen).toString("utf-8");
}

function wechatEncrypt(text: string): string {
  const random = randomBytes(16);
  const msgLen = Buffer.alloc(4); msgLen.writeUInt32BE(Buffer.byteLength(text, "utf-8"), 0);
  const corpId = Buffer.from(CORP_ID || "", "utf-8");
  const raw = Buffer.concat([random, msgLen, Buffer.from(text, "utf-8"), corpId]);
  const padLen = 32 - (raw.length % 32);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const cipher = createCipheriv("aes-256-cbc", AES_KEY, AES_KEY.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function wechatSignature(timestamp: string, nonce: string, encrypt: string): string {
  return createHash("sha1").update([TOKEN, timestamp, nonce, encrypt].sort().join("")).digest("hex");
}

function encryptXmlReply(toUser: string, fromUser: string, innerXml: string): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID().slice(0, 8);
  const xml = `<xml><ToUserName><![CDATA[${toUser}]]></ToUserName><FromUserName><![CDATA[${fromUser}]]></FromUserName><CreateTime>${ts}</CreateTime>${innerXml}</xml>`;
  const encrypted = wechatEncrypt(xml);
  const sig = wechatSignature(ts, nonce, encrypted);
  return `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt><MsgSignature><![CDATA[${sig}]]></MsgSignature><TimeStamp>${ts}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`;
}

// ---- Message Types ----
interface WechatMessage {
  fromUser: string; toUser: string; msgType: string; msgId: string;
  createTime: string; agentId: string;
  content?: string; picUrl?: string; mediaId?: string; format?: string;
  recognition?: string; locationX?: string; locationY?: string; label?: string;
  title?: string; description?: string; url?: string;
}

function parseMessage(decrypted: string): WechatMessage {
  const tag = (n: string) => { const m = decrypted.match(new RegExp(`<${n}><!\\[CDATA\\[(.*?)\\]\\]></${n}>`)); return m?.[1] || ""; };
  return {
    fromUser: tag("FromUserName"), toUser: tag("ToUserName"),
    msgType: tag("MsgType"), msgId: tag("MsgId"), createTime: tag("CreateTime"),
    agentId: tag("AgentID"), content: tag("Content"),
    picUrl: tag("PicUrl"), mediaId: tag("MediaId"), format: tag("Format"),
    recognition: tag("Recognition"),
    locationX: tag("Location_X"), locationY: tag("Location_Y"), label: tag("Label"),
    title: tag("Title"), description: tag("Description"), url: tag("Url"),
  };
}

// ---- File detection ----
function dirSnapshot(): Set<string> {
  const s = new Set<string>();
  try { for (const f of readdirSync(".")) s.add(f); } catch {}
  return s;
}

function findNewFiles(before: Set<string>): string[] {
  const news: string[] = [];
  try {
    for (const f of readdirSync(".")) {
      if (!before.has(f) && !f.endsWith(".jsonl") && !f.endsWith(".log") && !f.includes("node_modules") && !f.includes(".git")) {
        try { if (statSync(f).isFile()) news.push(f); } catch {}
      }
    }
  } catch {}
  return news;
}

// ---- Dependencies injected by engine ----
export interface WechatServerDeps {
  enqueueQuery: (input: string, msgType: string) => Promise<{ text: string; files: string[] }>;
  onEvent?: (event: string, data: any) => void;
}

// ---- Build passive reply XML ----
function buildPassiveReply(
  toUser: string, fromUser: string,
  result: { text: string; files: string[] },
): { replyXml: string; extraFiles: string[] } {
  const text = result.text;
  let files = result.files;

  // Detect markdown request
  const mdMatch = text.match(/<markdown>\s*([\s\S]*?)\s*<\/markdown>/);
  let cleanText = text.replace(/<markdown>[\s\S]*?<\/markdown>/g, "").replace(/<send_file>.*?<\/send_file>/g, "").trim();

  // Detect explicit file sends
  const sfMatches = text.matchAll(/<send_file>(.*?)<\/send_file>/g);
  for (const m of sfMatches) {
    const fp = m[1].trim();
    if (fexists(fp) && !files.includes(fp)) files = [...files, fp];
  }

  let innerXml: string;

  if (files.length > 0 && cleanText) {
    // Text in the passive reply, files via active push
    innerXml = `<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${cleanText.slice(0, 2000)}]]></Content>`;
  } else if (files.length > 0 && !cleanText) {
    // File-only: send a placeholder text, files via active push
    innerXml = `<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[文件已生成，正在发送...]]></Content>`;
  } else if (mdMatch) {
    // Markdown → use markdown msgtype in response
    innerXml = `<MsgType><![CDATA[markdown]]></MsgType><Markdown><Content><![CDATA[${mdMatch[1].slice(0, 4096)}]]></Content></Markdown>`;
  } else {
    innerXml = `<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${cleanText.slice(0, 2000) || " "}]]></Content>`;
  }

  const replyXml = encryptXmlReply(toUser, fromUser, innerXml);
  return { replyXml, extraFiles: files };
}

// ---- Active file push ----
async function pushFiles(toUser: string, files: string[]): Promise<void> {
  for (const fp of files) {
    try {
      if (!fexists(fp)) continue;
      const ext = fp.split(".").pop()?.toLowerCase() || "";
      const imageExts = ["png", "jpg", "jpeg", "gif", "bmp", "webp"];
      const mediaType = imageExts.includes(ext) ? "image" : "file";
      const mediaId = await uploadMedia(mediaType, fp);
      if (mediaType === "image") {
        await sendImage(toUser, mediaId);
      } else {
        await sendFile(toUser, mediaId);
      }
      console.log(`[WeChat] Sent ${mediaType}: ${fp}`);
    } catch (e: any) {
      console.error(`[WeChat] Upload failed for ${fp}:`, e.message);
      try { await sendText(toUser, `文件 ${fp} 发送失败: ${e.message}`); } catch {}
    }
  }
}

// ---- Create server ----
export function createWechatServer(deps: WechatServerDeps, port?: number, onPort?: (port: number) => void): Server {
  const PORT = port || parseInt(process.env["WECHAT_PORT"] || "9878");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    // GET: URL verification
    if (req.method === "GET" && url.pathname === "/wechat") {
      const echostr = url.searchParams.get("echostr") || "";
      const timestamp = url.searchParams.get("timestamp") || "";
      const nonce = url.searchParams.get("nonce") || "";
      const sig = url.searchParams.get("msg_signature") || "";

      const expected = wechatSignature(timestamp, nonce, echostr);
      if (sig !== expected) {
        console.log("[WeChat] Sig mismatch — Forbidden");
        res.writeHead(403); res.end("Forbidden"); return;
      }

      const decrypted = wechatDecrypt(echostr);
      console.log(`[WeChat] URL verified → "${decrypted}"`);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(decrypted);
      return;
    }

    // POST: message callback
    if (req.method === "POST" && url.pathname === "/wechat") {
      let body = ""; req.on("data", (c: Buffer) => body += c.toString());
      req.on("end", async () => {
        try {
          const encMatch = body.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);
          if (!encMatch) { res.end("success"); return; }
          const decrypted = wechatDecrypt(encMatch[1]);
          const msg = parseMessage(decrypted);

          console.log(`[WeChat] ${msg.fromUser} [${msg.msgType}]: ${(msg.content || msg.recognition || msg.picUrl || "").slice(0, 80)}`);

          // Handle events
          if (msg.msgType === "event") {
            const eventType = decrypted.match(/<Event><!\[CDATA\[(.*?)\]\]><\/Event>/)?.[1] || "";
            console.log(`[WeChat] Event: ${eventType}`);
            if (eventType === "enter_agent") {
              const replyXml = encryptXmlReply(msg.fromUser, msg.toUser,
                `<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好！我是 Ouroboros，你的 AI 助手。有什么可以帮你的？]]></Content>`);
              res.writeHead(200, { "Content-Type": "application/xml" }); res.end(replyXml); return;
            }
            res.end("success"); return;
          }

          // Build user input from message
          let userInput = msg.content || "";
          if (msg.msgType === "image") userInput = `[用户发送了一张图片] ${userInput || "请描述或分析这张图片"}`;
          else if (msg.msgType === "voice") userInput = `[用户发送了语音${msg.recognition ? `: ${msg.recognition}` : ""}] ${userInput || "请回复这条语音"}`;
          else if (msg.msgType === "video") userInput = `[用户发送了视频] ${userInput || "请描述这个视频"}`;
          else if (msg.msgType === "file") userInput = `[用户发送了文件] ${userInput || "请回复这个文件"}`;
          else if (msg.msgType === "location") userInput = `[用户发送了位置: ${msg.label || ""}] ${userInput || "这是什么地方"}`;
          else if (msg.msgType === "link") userInput = `[用户分享了链接: ${msg.title || ""}] ${userInput || "请回复这个链接"}`;

          if (!userInput && !["image", "voice", "video", "file"].includes(msg.msgType)) {
            res.end("success"); return;
          }

          // P1-D: incoming chat messages are untrusted — tag + scan for prompt-injection
          userInput = sanitizeExternal(userInput, "wechat");

          // Snapshot before query
          const beforeSnap = dirSnapshot();

          // Execute via shared engine (enqueued)
          const result = await deps.enqueueQuery(userInput || "请提供分析", msg.msgType);

          // Detect new files
          const newFiles = findNewFiles(beforeSnap);
          const allFiles = [...new Set([...result.files, ...newFiles])];

          console.log(`[Ouroboros] → ${result.text.slice(0, 100)}${allFiles.length > 0 ? ` + ${allFiles.length} files` : ""}`);

          // Build passive reply (first message via encrypted response)
          const { replyXml, extraFiles } = buildPassiveReply(msg.fromUser, msg.toUser, {
            text: result.text,
            files: allFiles,
          });

          res.writeHead(200, { "Content-Type": "application/xml" });
          res.end(replyXml);

          // Push extra files via active API
          if (extraFiles.length > 0) {
            await pushFiles(msg.fromUser, extraFiles);
          }
        } catch (e: any) {
          console.error("[WeChat] Error:", e.message);
          res.end("success");
        }
      });
      return;
    }

    if (url.pathname === "/health") { res.writeHead(200); res.end("OK"); return; }
    res.writeHead(404); res.end("Not found");
  });

  // Port fallback: a second instance sharing the same env must not crash on EADDRINUSE.
  listenFallback(server, PORT, { name: "WeChat", onPort: (p) => {
    console.log(`[WeChat] Server :${p}  (AgentID: ${process.env["WECHAT_AGENT_ID"] || "?"})`);
    onPort?.(p);
  } });

  return server;
}
