const MAX_RAW_BYTES = 512 * 1024;
const MAX_BODY_CHARS = 120000;

export default {
  async email(message, env) {
    const recipient = normalizeAddress(message.to);
    const rawResult = await readStreamBytes(message.raw, MAX_RAW_BYTES);
    const rawText = bytesToBinaryString(rawResult.bytes);
    const parsed = parseMime(rawText);
    const sender = decodeMimeHeader(message.headers.get("from") || message.from || "");
    const subject = decodeMimeHeader(message.headers.get("subject") || parsed.headers.subject || "");
    const dateHeader = message.headers.get("date") || parsed.headers.date || "";
    const messageId = message.headers.get("message-id") || parsed.headers["message-id"] || crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT OR IGNORE INTO messages (
        recipient, sender, subject, date_header, message_id,
        body, raw_excerpt, raw_truncated, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        recipient,
        sender,
        subject,
        dateHeader,
        messageId,
        parsed.body.slice(0, MAX_BODY_CHARS),
        decodeBytes(rawResult.bytes.slice(0, 20000), "utf-8"),
        rawResult.truncated ? 1 : 0,
        now
      )
      .run();
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return redirectResponse("/login");
    }

    if (request.method === "GET" && url.pathname === "/login") {
      return htmlResponse(renderLogin(url.searchParams.get("return") || "/domains"));
    }

    if (request.method === "POST" && url.pathname === "/login") {
      return login(request, env);
    }

    if (request.method === "GET" && url.pathname === "/logout") {
      return logout();
    }

    if (request.method === "GET" && url.pathname === "/latest") {
      return renderLatest(request, env);
    }

    if (request.method === "GET" && url.pathname === "/latest.json") {
      return renderLatestJson(request, env);
    }

    if (request.method === "GET" && url.pathname === "/domains") {
      return renderDomains(request, env);
    }

    if (request.method === "GET" && url.pathname === "/domains.json") {
      return renderDomainsJson(request, env);
    }

    if (request.method === "GET" && url.pathname === "/mailboxes") {
      return renderAllMailboxes(request, env);
    }

    if (request.method === "POST" && url.pathname === "/admin/link") {
      return createAddressLinkPage(request, env);
    }

    if (request.method === "POST" && url.pathname === "/admin/link.json") {
      return createAddressLinkJson(request, env);
    }

    if (request.method === "GET" && url.pathname.startsWith("/domain/")) {
      const domain = domainFromPath(url.pathname, "/domain/");
      return renderDomainMailbox(request, env, domain);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/domain/") && url.pathname.endsWith("/latest")) {
      const domain = domainFromPath(url.pathname, "/api/domain/", "/latest");
      return renderDomainMailboxJson(request, env, domain);
    }

    if (request.method === "GET" && url.pathname.startsWith("/inbox/")) {
      const address = addressFromPath(url.pathname, "/inbox/");
      return renderOpenMailbox(request, env, address);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/inbox/") && url.pathname.endsWith("/latest")) {
      const address = addressFromPath(url.pathname, "/api/inbox/", "/latest");
      return renderOpenMailboxJson(request, env, address);
    }

    if (request.method === "GET" && url.pathname.startsWith("/m/")) {
      const token = url.pathname.slice("/m/".length);
      return renderMailbox(request, env, token);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/m/") && url.pathname.endsWith("/latest")) {
      const token = url.pathname.slice("/api/m/".length, -"/latest".length).replace(/^\/|\/$/g, "");
      return renderMailboxJson(request, env, token);
    }

    if (url.pathname === "/admin/address") {
      if (!isAuthorized(request, env)) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      if (request.method === "POST") {
        return createAddress(request, env);
      }
      if (request.method === "DELETE") {
        return deleteAddress(request, env);
      }
    }

    if (request.method === "GET" && url.pathname === "/admin/addresses") {
      if (!isAuthorized(request, env)) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      return listAddresses(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function createAddress(request, env) {
  const payload = await request.json().catch(() => ({}));
  const address = normalizeAddress(payload.address || "");
  const displayName = String(payload.displayName || "");
  if (!address || !address.includes("@")) {
    return jsonResponse({ error: "address_required" }, 400);
  }

  return jsonResponse(await ensureAddressLink(request, env, address, displayName));
}

async function createAddressLinkPage(request, env) {
  const form = await request.formData().catch(() => null);
  const token = String(form?.get("token") || "");
  if (!isLatestToken(token, env) && !(await hasValidSession(request, env))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const address = normalizeAddress(form?.get("address") || "");
  const displayName = String(form?.get("displayName") || address.split("@")[0] || "");
  if (!isValidAddress(address)) {
    return htmlResponse(renderLinkResult({ error: "请输入完整邮箱地址。" }, token), 400);
  }

  const result = await ensureAddressLink(request, env, address, displayName);
  return htmlResponse(renderLinkResult(result, token));
}

async function createAddressLinkJson(request, env) {
  const payload = await request.json().catch(() => ({}));
  const token = String(payload.token || "");
  if (!isLatestToken(token, env) && !(await hasValidSession(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const address = normalizeAddress(payload.address || "");
  const displayName = String(payload.displayName || address.split("@")[0] || "");
  if (!isValidAddress(address)) {
    return jsonResponse({ error: "address_required" }, 400);
  }

  return jsonResponse(await ensureAddressLink(request, env, address, displayName));
}

async function ensureAddressLink(request, env, address, displayName) {
  const existing = await env.DB.prepare("SELECT address, token, display_name FROM addresses WHERE address = ?")
    .bind(address)
    .first();
  if (existing) {
    return {
      address: existing.address,
      displayName: existing.display_name,
      link: `${baseUrl(request, env)}/m/${existing.token}`,
      token: existing.token,
      existed: true,
    };
  }

  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO addresses (address, token, display_name, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(address, token, displayName, new Date().toISOString())
    .run();

  return {
    address,
    displayName,
    link: `${baseUrl(request, env)}/m/${token}`,
    token,
    existed: false,
  };
}

async function deleteAddress(request, env) {
  const url = new URL(request.url);
  const address = normalizeAddress(url.searchParams.get("address") || "");
  if (!address) {
    return jsonResponse({ error: "address_required" }, 400);
  }
  const result = await env.DB.prepare("DELETE FROM addresses WHERE address = ?").bind(address).run();
  return jsonResponse({ address, deleted: result.meta.changes || 0 });
}

async function listAddresses(request, env) {
  const rows = await env.DB.prepare(
    "SELECT address, token, display_name, created_at FROM addresses ORDER BY address"
  ).all();
  return jsonResponse({
    addresses: rows.results.map((row) => ({
      address: row.address,
      displayName: row.display_name,
      createdAt: row.created_at,
      link: `${baseUrl(request, env)}/m/${row.token}`,
    })),
  });
}

async function renderLatest(request, env) {
  const auth = await viewerAuth(request, env);
  if (!auth.ok) {
    return auth.response;
  }

  const limit = parseLimit(new URL(request.url).searchParams.get("limit") || "1");
  const rows = await latestAllMessages(env, limit);
  return htmlResponse(renderLatestHtml(rows.results));
}

async function renderLatestJson(request, env) {
  if (!(await isLatestAuthorized(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const limit = parseLimit(new URL(request.url).searchParams.get("limit") || "1");
  const rows = await latestAllMessages(env, limit);
  return jsonResponse({
    emails: rows.results.map(messageJson),
  });
}

async function renderDomains(request, env) {
  const auth = await viewerAuth(request, env);
  if (!auth.ok) {
    return auth.response;
  }

  const [domainRows, messageRows] = await Promise.all([domainSummaries(env), allMessages(env)]);
  return htmlResponse(renderDomainsHtml(request, domainRows.results, auth, messageRows.results));
}

async function renderDomainsJson(request, env) {
  if (!(await isLatestAuthorized(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const rows = await domainSummaries(env);
  return jsonResponse({
    domains: rows.results.map((row) => ({
      domain: row.domain,
      count: row.count,
      latestAt: row.latest_at,
      link: `${baseUrl(request, env)}/domain/${encodeURIComponent(row.domain)}?token=${encodeURIComponent(new URL(request.url).searchParams.get("token") || "")}`,
    })),
  });
}

async function renderAllMailboxes(request, env) {
  const auth = await viewerAuth(request, env);
  if (!auth.ok) {
    return auth.response;
  }

  const rows = await allMessages(env);
  return htmlResponse(renderAllMessagesHtml(rows.results, auth.token));
}

async function renderDomainMailbox(request, env, domain) {
  const auth = await viewerAuth(request, env);
  if (!auth.ok) {
    return auth.response;
  }
  if (!isValidDomain(domain)) {
    return new Response("Domain required", { status: 400 });
  }

  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
  const rows = await latestDomainMessages(env, domain, limit);
  const token = auth.token;
  return htmlResponse(renderDomainHtml(domain, rows.results, token));
}

async function renderDomainMailboxJson(request, env, domain) {
  if (!(await isLatestAuthorized(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!isValidDomain(domain)) {
    return jsonResponse({ error: "domain_required" }, 400);
  }

  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
  const rows = await latestDomainMessages(env, domain, limit);
  return jsonResponse({
    domain,
    mailboxes: groupedMailboxJson(rows.results),
    emails: rows.results.map(messageJson),
  });
}

async function renderOpenMailbox(request, env, address) {
  const auth = await viewerAuth(request, env);
  if (!auth.ok) {
    return auth.response;
  }
  if (!isValidAddress(address)) {
    return new Response("Address required", { status: 400 });
  }

  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
  const rows = await latestMessages(env, address, limit);
  return htmlResponse(renderMailboxHtml({ address, display_name: address }, rows.results, auth.token, true));
}

async function renderOpenMailboxJson(request, env, address) {
  if (!(await isLatestAuthorized(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!isValidAddress(address)) {
    return jsonResponse({ error: "address_required" }, 400);
  }

  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
  const rows = await latestMessages(env, address, limit);
  return jsonResponse({
    address,
    emails: rows.results.map(messageJson),
  });
}

async function renderMailbox(request, env, token) {
  const address = await env.DB.prepare("SELECT address, display_name FROM addresses WHERE token = ?")
    .bind(token)
    .first();
  if (!address) {
    return new Response("Not found", { status: 404 });
  }

  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
  const rows = await latestMessages(env, address.address, limit);
  return htmlResponse(renderMailboxHtml(address, rows.results, "", false));
}

async function renderMailboxJson(request, env, token) {
  const address = await env.DB.prepare("SELECT address FROM addresses WHERE token = ?").bind(token).first();
  if (!address) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
  const rows = await latestMessages(env, address.address, limit);
  return jsonResponse({
    address: address.address,
    emails: rows.results.map(messageJson),
  });
}

function latestAllMessages(env, limit) {
  return env.DB.prepare(
    `SELECT id, recipient, sender, subject, date_header, body, raw_truncated, created_at
     FROM messages
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();
}

function domainSummaries(env) {
  return env.DB.prepare(
    `SELECT lower(substr(recipient, instr(recipient, '@') + 1)) AS domain,
            count(*) AS count,
            max(created_at) AS latest_at
     FROM messages
     WHERE instr(recipient, '@') > 0
     GROUP BY domain
     ORDER BY latest_at DESC`
  ).all();
}

function allMessages(env) {
  return env.DB.prepare(
    `SELECT id, recipient, sender, subject, date_header, body, raw_truncated, created_at
     FROM messages
     ORDER BY created_at DESC`
  ).all();
}

function latestDomainMessages(env, domain, limit) {
  return env.DB.prepare(
    `SELECT id, recipient, sender, subject, date_header, body, raw_truncated, created_at
     FROM messages
     WHERE recipient LIKE ?
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(`%@${normalizeDomain(domain)}`, limit)
    .all();
}

function latestMessages(env, address, limit) {
  return env.DB.prepare(
    `SELECT id, recipient, sender, subject, date_header, body, raw_truncated, created_at
     FROM messages
     WHERE recipient = ?
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(normalizeAddress(address), limit)
    .all();
}

function messageJson(row) {
  return {
    id: row.id,
    recipient: row.recipient,
    sender: row.sender,
    subject: row.subject,
    date: row.date_header,
    body: row.body,
    receivedAt: row.created_at,
    rawTruncated: Boolean(row.raw_truncated),
  };
}

function groupedMailboxJson(messages) {
  return groupMessagesByRecipient(messages).map((group) => ({
    address: group.address,
    count: group.messages.length,
    latestAt: group.messages[0]?.created_at || "",
    emails: group.messages.map(messageJson),
  }));
}

function groupMessagesByRecipient(messages) {
  const groups = new Map();
  for (const message of messages) {
    const address = normalizeAddress(message.recipient);
    if (!groups.has(address)) {
      groups.set(address, []);
    }
    groups.get(address).push(message);
  }
  return [...groups.entries()].map(([address, groupedMessages]) => ({
    address,
    messages: groupedMessages.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))),
    latestAt: groupedMessages[0]?.created_at || "",
  })).sort((a, b) => String(b.latestAt || "").localeCompare(String(a.latestAt || "")));
}

function isAuthorized(request, env) {
  const token = env.ADMIN_TOKEN;
  if (!token) {
    return false;
  }
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${token}`;
}

async function isLatestAuthorized(request, env) {
  const token = env.MAIL_VIEW_TOKEN || env.ADMIN_TOKEN;
  if (!token) {
    return hasValidSession(request, env);
  }
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token") || "";
  const header = request.headers.get("authorization") || "";
  return isLatestToken(queryToken, env) || header === `Bearer ${token}` || (await hasValidSession(request, env));
}

function isLatestToken(value, env) {
  const token = env.MAIL_VIEW_TOKEN || env.ADMIN_TOKEN;
  return Boolean(token) && value === token;
}

async function viewerAuth(request, env) {
  if (await isLatestAuthorized(request, env)) {
    return { ok: true, token: new URL(request.url).searchParams.get("token") || "" };
  }
  const url = new URL(request.url);
  return {
    ok: false,
    response: redirectResponse(`/login?return=${encodeURIComponent(url.pathname + url.search)}`),
  };
}

async function login(request, env) {
  const form = await request.formData().catch(() => null);
  const username = String(form?.get("username") || "");
  const password = String(form?.get("password") || "");
  const returnTo = safeReturnPath(String(form?.get("return") || "/domains"));
  const expectedUser = env.LOGIN_USERNAME || env.ADMIN_USERNAME || "admin";
  const expectedPassword = env.LOGIN_PASSWORD || env.ADMIN_PASSWORD || "";

  if (!expectedPassword || username !== expectedUser || password !== expectedPassword) {
    return htmlResponse(renderLogin(returnTo, "账号或密码错误。"), 401);
  }

  const maxAge = 60 * 60 * 12;
  const expires = Math.floor(Date.now() / 1000) + maxAge;
  const value = await signSession(`${username}.${expires}`, env);
  return redirectResponse(returnTo, {
    "Set-Cookie": `mail_session=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  });
}

function logout() {
  return redirectResponse("/login", {
    "Set-Cookie": "mail_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
  });
}

async function hasValidSession(request, env) {
  const cookie = cookieValue(request.headers.get("cookie") || "", "mail_session");
  if (!cookie) {
    return false;
  }
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) {
    return false;
  }
  const expected = await hmacHex(sessionSecret(env), payload);
  if (signature !== expected) {
    return false;
  }
  const raw = decodeBase64Url(payload);
  const expires = Number(raw.split(".").at(-1));
  return Number.isFinite(expires) && expires > Math.floor(Date.now() / 1000);
}

async function signSession(value, env) {
  const payload = encodeBase64Url(value);
  const signature = await hmacHex(sessionSecret(env), payload);
  return `${payload}.${signature}`;
}

function sessionSecret(env) {
  return env.SESSION_SECRET || env.ADMIN_TOKEN || env.MAIL_VIEW_TOKEN || env.LOGIN_PASSWORD || "change-me";
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64Url(value) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}

function cookieValue(cookieHeader, name) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || "";
}

function safeReturnPath(value) {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/domains";
}

function redirectResponse(location, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      ...headers,
    },
  });
}

function baseUrl(request, env) {
  if (env.PUBLIC_BASE_URL) {
    return env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDomain(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidAddress(value) {
  return normalizeAddress(value).includes("@");
}

function isValidDomain(value) {
  const domain = normalizeDomain(value);
  return domain.includes(".") && !domain.includes("@") && !domain.includes("/");
}

function addressFromPath(pathname, prefix, suffix = "") {
  if (!pathname.startsWith(prefix)) {
    return "";
  }
  let value = pathname.slice(prefix.length);
  if (suffix) {
    value = value.slice(0, -suffix.length);
  }
  try {
    return normalizeAddress(decodeURIComponent(value));
  } catch {
    return "";
  }
}

function domainFromPath(pathname, prefix, suffix = "") {
  if (!pathname.startsWith(prefix)) {
    return "";
  }
  let value = pathname.slice(prefix.length);
  if (suffix) {
    value = value.slice(0, -suffix.length);
  }
  try {
    return normalizeDomain(decodeURIComponent(value));
  } catch {
    return "";
  }
}

function parseLimit(value) {
  const parsed = Number.parseInt(value || "10", 10);
  if (Number.isNaN(parsed)) {
    return 10;
  }
  return Math.min(Math.max(parsed, 1), 50);
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function readStreamBytes(stream, maxBytes) {
  if (typeof stream === "string") {
    const bytes = new TextEncoder().encode(stream);
    return {
      bytes: bytes.slice(0, maxBytes),
      truncated: bytes.length > maxBytes,
    };
  }
  if (stream instanceof ArrayBuffer) {
    return {
      bytes: new Uint8Array(stream.slice(0, maxBytes)),
      truncated: stream.byteLength > maxBytes,
    };
  }

  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.length <= maxBytes) {
      chunks.push(value);
      total += value.length;
      continue;
    }
    chunks.push(value.slice(0, Math.max(0, maxBytes - total)));
    truncated = true;
    break;
  }

  return {
    bytes: concatBytes(chunks),
    truncated,
  };
}

function bytesToBinaryString(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.slice(i, i + 0x8000)));
  }
  return chunks.join("");
}

function binaryStringToBytes(value) {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    bytes[i] = value.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function concatBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function parseMime(rawText) {
  const parsed = splitMime(rawText);
  if (!parsed) {
    return { headers: {}, body: rawText };
  }
  return {
    headers: parsed.headers,
    body: extractBody(parsed.bodyText, parsed.headers),
  };
}

function splitMime(rawText) {
  const separator = rawText.match(/\r?\n\r?\n/);
  if (!separator || separator.index === undefined) {
    return null;
  }
  const headerText = rawText.slice(0, separator.index);
  const bodyText = rawText.slice(separator.index + separator[0].length);
  const headers = parseHeaders(headerText);
  return {
    headers,
    bodyText,
  };
}

function parseHeaders(headerText) {
  const lines = headerText.replace(/\r\n/g, "\n").split("\n");
  const unfolded = [];
  for (const line of lines) {
    if (/^\s/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }

  const headers = {};
  for (const line of unfolded) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

function extractBody(bodyText, headers) {
  const contentType = headers["content-type"] || "";
  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
  const charset = charsetFromContentType(contentType);
  if (boundary) {
    const parts = bodyText.split(`--${boundary}`).filter((part) => part.trim() && !part.trim().startsWith("--"));
    const parsedParts = parts.map((part) => {
      const parsed = splitMime(part.replace(/^\r?\n/, "")) || { headers: {}, bodyText: part };
      const partContentType = parsed.headers["content-type"] || "";
      return {
        contentType: partContentType.toLowerCase(),
        encoding: (parsed.headers["content-transfer-encoding"] || "").toLowerCase(),
        charset: charsetFromContentType(partContentType),
        body: parsed.bodyText,
        headers: parsed.headers,
      };
    });
    const plain = parsedParts.find((part) => part.contentType.includes("text/plain"));
    const html = parsedParts.find((part) => part.contentType.includes("text/html"));
    const chosen = plain || html || parsedParts[0];
    if (!chosen) {
      return "";
    }
    if (chosen.contentType.includes("multipart/")) {
      return extractBody(chosen.body, chosen.headers);
    }
    const decoded = decodeBytes(decodeTransferBytes(chosen.body, chosen.encoding), chosen.charset);
    return chosen.contentType.includes("text/html") ? stripHtml(decoded) : decoded.trim();
  }

  const decoded = decodeBytes(
    decodeTransferBytes(bodyText, (headers["content-transfer-encoding"] || "").toLowerCase()),
    charset
  );
  return contentType.toLowerCase().includes("text/html") ? stripHtml(decoded) : decoded.trim();
}

function charsetFromContentType(contentType) {
  return contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i)?.[1] || "utf-8";
}

function normalizeCharset(charset) {
  const normalized = String(charset || "utf-8").trim().toLowerCase();
  if (["gb2312", "gbk", "gb18030"].includes(normalized)) {
    return "gb18030";
  }
  if (["utf8", "utf-8"].includes(normalized)) {
    return "utf-8";
  }
  return normalized;
}

function decodeBytes(bytes, charset = "utf-8") {
  try {
    return new TextDecoder(normalizeCharset(charset), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function decodeTransferBytes(value, encoding) {
  if (encoding.includes("base64")) {
    return decodeBase64Bytes(value.replace(/\s/g, ""));
  }
  if (encoding.includes("quoted-printable")) {
    return decodeQuotedPrintableBytes(value);
  }
  return binaryStringToBytes(value);
}

function decodeBase64Bytes(value) {
  try {
    const binary = atob(value);
    return binaryStringToBytes(binary);
  } catch {
    return binaryStringToBytes(value);
  }
}

function decodeQuotedPrintableBytes(value) {
  const compact = value.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < compact.length; i += 1) {
    if (compact[i] === "=" && /^[0-9a-fA-F]{2}$/.test(compact.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(compact.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(compact.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function decodeMimeHeader(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_match, charset, mode, text) => {
    try {
      if (mode.toLowerCase() === "b") {
        const binary = atob(text);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder(charset, { fatal: false }).decode(bytes);
      }
      const qp = text.replace(/_/g, " ").replace(/=([0-9a-fA-F]{2})/g, (_, hex) => {
        return String.fromCharCode(Number.parseInt(hex, 16));
      });
      const bytes = Uint8Array.from(qp, (char) => char.charCodeAt(0));
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      return text;
    }
  });
}

function stripHtml(value) {
  return value
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<title[\s\S]*?<\/title>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/table>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderHome() {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloudflare Mail Links</title></head>
<body style="font-family:Arial,'Microsoft YaHei',sans-serif;margin:40px;line-height:1.6">
  <h1>Cloudflare Mail Links</h1>
  <p>使用 <code>/domains?token=&lt;MAIL_VIEW_TOKEN&gt;</code> 按子域查看邮件。</p>
  <p>管理员也可以使用 <code>/latest?token=&lt;MAIL_VIEW_TOKEN&gt;</code> 查看全站最新邮件。</p>
</body>
</html>`;
}

function renderLogin(returnTo, error = "") {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>登录</title>
  <style>${mailboxCss()}</style>
</head>
<body class="login-page">
  <main class="login-main">
    <form class="login-form" method="post" action="/login">
      <h1>邮件管理</h1>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <input type="hidden" name="return" value="${escapeHtml(returnTo)}">
      <label>账号<input name="username" autocomplete="username" required></label>
      <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">登录</button>
    </form>
  </main>
</body>
</html>`;
}

function renderLatestHtml(messages) {
  const empty = messages.length ? "" : "<p class='empty'>当前没有邮件。</p>";
  const items = messages.map(renderMessage).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>最新邮件</title>
  <style>${mailboxCss()}</style>
</head>
<body>
  <header>
    <h1>最新邮件</h1>
    <div class="sub">显示 Worker 最近收到的邮件。</div>
    <a class="btn" href="">刷新最新邮件</a>
  </header>
  <main>${empty}${items}</main>
</body>
</html>`;
}

function renderDomainsHtml(request, domains, auth, messages = []) {
  const token = auth.token || "";
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
  const empty = domains.length ? "" : "<p class='empty'>当前没有邮件域。</p>";
  const items = domains
    .map((row) => {
      const href = `/domain/${encodeURIComponent(row.domain)}${tokenQuery}`;
      return `<article class="mail domain-card">
  <h2 class="subject"><a href="${escapeHtml(href)}">${escapeHtml(row.domain)}</a></h2>
  <div class="meta">${row.count} 封邮件 &nbsp; 最新: ${escapeHtml(formatBeijingTime(row.latest_at))}</div>
</article>`;
    })
    .join("");
  const messageEmpty = messages.length ? "" : "<p class='empty'>当前没有邮件。</p>";
  const messageItems = messages.map(renderMessage).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>邮件域</title>
  <style>${mailboxCss()}</style>
</head>
<body class="domains-page">
  <header class="split-header">
    <div class="title-row">
      <h1>邮件域</h1>
      <a class="btn secondary inline-btn" href="/mailboxes${tokenQuery}">查看全部邮件</a>
    </div>
    <form class="link-form" id="linkForm" method="post" action="/admin/link">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <label for="address">创建专属链接</label>
  <div class="form-row">
    <input id="address" name="address" type="email" placeholder="name@example.com" required>
    <button type="submit">生成</button>
    <button type="button" id="copyAddress" class="secondary-button">复制邮箱</button>
  </div>
  <div class="link-result" id="linkResult"></div>
</form>
  </header>
  <main class="domains-layout">
    <aside class="domain-sidebar">
      <div class="panel-title">子域名</div>
      ${empty}${items}
    </aside>
    <section class="domain-mail-window">
      <div class="panel-title">按时间倒序的邮件</div>
      ${messageEmpty}${messageItems}
    </section>
  </main>
  <script>
    const form = document.getElementById("linkForm");
    const result = document.getElementById("linkResult");
    const addressInput = document.getElementById("address");
    const copyAddress = document.getElementById("copyAddress");
    async function copyText(text, button, label) {
      if (!text) return;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "fixed";
          textarea.style.left = "-9999px";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          textarea.remove();
        }
        const old = button.textContent;
        button.textContent = "已复制";
        setTimeout(() => { button.textContent = old || label; }, 1200);
      } catch {
        button.textContent = "复制失败";
        setTimeout(() => { button.textContent = label; }, 1200);
      }
    }
    copyAddress.addEventListener("click", () => copyText(addressInput.value.trim(), copyAddress, "复制邮箱"));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      result.textContent = "生成中...";
      const formData = new FormData(form);
      const response = await fetch("/admin/link.json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: formData.get("token"),
          address: formData.get("address"),
          displayName: String(formData.get("address") || "").split("@")[0],
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        result.innerHTML = '<span class="error-inline">生成失败</span>';
        return;
      }
      result.replaceChildren();
      const link = document.createElement("a");
      link.href = payload.link;
      link.textContent = payload.link;
      const copyLink = document.createElement("button");
      copyLink.type = "button";
      copyLink.className = "mini-button";
      copyLink.textContent = "复制链接";
      copyLink.addEventListener("click", () => copyText(payload.link, copyLink, "复制链接"));
      result.append(link, copyLink);
    });
  </script>
</body>
</html>`;
}

function renderLinkResult(result, token) {
  const body = result.error
    ? `<p class="error">${escapeHtml(result.error)}</p>`
    : `<article class="mail">
  <h2 class="subject">${escapeHtml(result.address)}</h2>
  <div class="meta">${result.existed ? "已有链接" : "已创建链接"}</div>
  <p><a href="${escapeHtml(result.link)}">${escapeHtml(result.link)}</a></p>
</article>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>专属链接</title>
  <style>${mailboxCss()}</style>
</head>
<body>
  <header>
    <h1>专属链接</h1>
    <a class="btn" href="/domains?token=${encodeURIComponent(token)}">返回</a>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

function renderDomainHtml(domain, messages, token) {
  const empty = messages.length ? "" : "<p class='empty'>当前没有邮件。</p>";
  const items = groupMessagesByRecipient(messages).map((group) => renderMailboxGroup(group, token)).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(domain)} - 最新邮件</title>
  <style>${mailboxCss()}</style>
</head>
<body class="domain-page">
  <header class="domain-header">
    <h1>${escapeHtml(domain)}</h1>
    <div class="search-row">
      <input id="mailboxSearch" type="search" placeholder="搜索邮箱" autocomplete="off">
      <span id="searchCount">${groupMessagesByRecipient(messages).length} 个邮箱</span>
    </div>
  </header>
  <main>${empty}${items}</main>
  <script>${mailboxListScript(token)}</script>
</body>
</html>`;
}

function renderAllMessagesHtml(messages, token) {
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
  const empty = messages.length ? "" : "<p class='empty'>当前没有邮件。</p>";
  const items = messages.map((message) => `<div class="message-search-item" data-search="${escapeHtml([
    message.recipient,
    message.sender,
    message.subject,
    message.body,
  ].join(" ").toLowerCase())}">${renderMessage(message)}</div>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>全部邮件</title>
  <style>${mailboxCss()}</style>
</head>
<body class="all-mail-page">
  <header class="domain-header">
    <div class="title-row">
      <h1>全部邮件</h1>
      <a class="btn secondary inline-btn" href="/domains${tokenQuery}">返回邮件域</a>
    </div>
    <div class="search-row">
      <input id="messageSearch" type="search" placeholder="搜索邮件" autocomplete="off">
      <span id="searchCount">${messages.length} 封邮件</span>
    </div>
  </header>
  <main>${empty}${items}</main>
  <script>${messageListScript()}</script>
</body>
</html>`;
}

function renderMailboxGroup(group, token) {
  return renderMailboxRow(group.address, group.messages.length, group.latestAt, token);
}

function renderMailboxRow(address, count, latestAt, token) {
  const href = `/inbox/${encodeURIComponent(address)}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  return `<section class="mailbox-group" data-address="${escapeHtml(address)}">
  <div class="mailbox-head">
    <div class="mailbox-title">
      <h2><a href="${escapeHtml(href)}">${escapeHtml(address)}</a></h2>
    </div>
    <div class="mailbox-actions">
      <button type="button" class="mini-button copy-button" data-copy="${escapeHtml(address)}">复制</button>
      <button type="button" class="mini-button create-link-button" data-link-address="${escapeHtml(address)}">生成并复制专属链接</button>
      <div class="mailbox-stats">
        <span>${count} 封邮件</span>
        <span class="mailbox-time">最新: ${escapeHtml(formatBeijingTime(latestAt))}</span>
      </div>
    </div>
  </div>
</section>`;
}

function mailboxListScript(token) {
  return `
    const linkToken = ${JSON.stringify(token || "")};
    const search = document.getElementById("mailboxSearch");
    const count = document.getElementById("searchCount");
    const groups = [...document.querySelectorAll(".mailbox-group")];
    async function copyText(text, button) {
      if (!text) return;
      const label = button.textContent;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "fixed";
          textarea.style.left = "-9999px";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          textarea.remove();
        }
        button.textContent = "已复制";
      } catch {
        button.textContent = "复制失败";
      }
      setTimeout(() => { button.textContent = label; }, 1200);
    }
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", () => copyText(button.dataset.copy, button));
    });
    async function createAndCopyLink(address, button) {
      if (!address) return;
      const label = button.textContent;
      button.textContent = "生成中...";
      try {
        const response = await fetch("/admin/link.json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: linkToken,
            address,
            displayName: address.split("@")[0],
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.link) throw new Error("link_failed");
        await copyText(payload.link, button);
        button.textContent = "已复制链接";
      } catch {
        button.textContent = "生成失败";
      }
      setTimeout(() => { button.textContent = label; }, 1600);
    }
    document.querySelectorAll("[data-link-address]").forEach((button) => {
      button.addEventListener("click", () => createAndCopyLink(button.dataset.linkAddress, button));
    });
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let visible = 0;
      for (const group of groups) {
        const address = group.dataset.address || "";
        const matched = !q || address.includes(q);
        group.hidden = !matched;
        if (matched) visible += 1;
      }
      count.textContent = visible + " 个邮箱";
    });
  `;
}

function messageListScript() {
  return `
    const search = document.getElementById("messageSearch");
    const count = document.getElementById("searchCount");
    const messages = [...document.querySelectorAll(".message-search-item")];
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let visible = 0;
      for (const message of messages) {
        const text = message.dataset.search || "";
        const matched = !q || text.includes(q);
        message.hidden = !matched;
        if (matched) visible += 1;
      }
      count.textContent = visible + " 封邮件";
    });
  `;
}

function renderMailboxHtml(address, messages, token = "", showLinkTools = false) {
  const name = escapeHtml(address.display_name || address.address);
  const empty = messages.length ? "" : "<p class='empty'>当前没有邮件。</p>";
  const items = messages.map(renderMessage).join("");
  const linkTools = showLinkTools
    ? `<button type="button" class="btn secondary" id="createMailboxLink" data-link-address="${escapeHtml(address.address)}">生成并复制专属链接</button>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${name} - 最新邮件</title>
  <style>${mailboxCss()}</style>
</head>
<body class="inbox-page">
  <header class="compact-header">
    <div>
      <h1>${name}</h1>
      <div class="sub">${escapeHtml(address.address)} · ${messages.length} 封邮件</div>
    </div>
    <div class="header-actions">
      ${linkTools}
      <a class="btn secondary" href="">刷新</a>
    </div>
  </header>
  <main>
    <section class="notice">本邮箱仅用于临时收信，有效期为 1 个月。请勿用于注册、绑定或找回重要账户；继续使用所产生的风险由使用者自行承担。</section>
    ${empty}${items}
  </main>
  ${showLinkTools ? `<script>${singleMailboxLinkScript(token)}</script>` : ""}
</body>
</html>`;
}

function singleMailboxLinkScript(token) {
  return `
    const linkToken = ${JSON.stringify(token || "")};
    const createButton = document.getElementById("createMailboxLink");
    async function copyText(text) {
      if (!text) return;
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    createButton.addEventListener("click", async () => {
      const label = createButton.textContent;
      const address = createButton.dataset.linkAddress;
      createButton.textContent = "生成中...";
      try {
        const response = await fetch("/admin/link.json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: linkToken,
            address,
            displayName: address.split("@")[0],
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.link) throw new Error("link_failed");
        await copyText(payload.link);
        createButton.textContent = "已复制链接";
      } catch {
        createButton.textContent = "生成失败";
      }
      setTimeout(() => { createButton.textContent = label; }, 1600);
    });
  `;
}
function mailboxCss() {
  return `
    :root { --bg:#f5f7fb; --panel:#fff; --text:#172033; --muted:#667085; --border:#d7deea; --accent:#1769aa; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Arial,"Microsoft YaHei",sans-serif; background:var(--bg); color:var(--text); }
    header { background:var(--panel); border-bottom:1px solid var(--border); padding:18px 20px; position:sticky; top:0; }
    main { max-width:980px; margin:0 auto; padding:22px 14px 48px; }
    h1 { font-size:20px; line-height:1.3; margin:0 0 4px; word-break:break-word; }
    a { color:var(--accent); }
    .sub { color:var(--muted); font-size:14px; }
    .btn { display:inline-block; margin-top:14px; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:6px; padding:9px 12px; text-decoration:none; font-size:14px; line-height:1; }
    .btn.secondary { margin-top:0; background:#fff; color:var(--accent); }
    .inline-btn { white-space:nowrap; }
    .split-header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; padding:20px 30px; }
    .title-row { display:flex; align-items:center; gap:12px; }
    .domains-layout { display:grid; grid-template-columns:minmax(240px, 320px) minmax(0, 1fr); gap:18px; max-width:1280px; margin:0 auto; padding:18px 18px 48px; }
    .domain-sidebar, .domain-mail-window { min-width:0; }
    .domain-sidebar { position:sticky; top:88px; align-self:start; max-height:calc(100vh - 112px); overflow:auto; }
    .domain-mail-window { max-height:calc(100vh - 112px); overflow:auto; padding-right:4px; }
    .panel-title { color:var(--muted); font-size:13px; font-weight:700; margin:0 0 10px; }
    .domains-page .mail { margin-bottom:10px; }
    .domain-card { padding:12px; }
    .domain-card .subject { font-size:16px; margin-bottom:5px; }
    .link-form { width:min(420px, 48vw); border:1px solid var(--border); border-radius:8px; padding:12px; background:#fbfcff; }
    .link-form label { display:block; color:var(--muted); font-size:13px; margin-bottom:8px; }
    .form-row { display:flex; gap:8px; }
    .form-row input { flex:1; min-width:0; border:1px solid var(--border); border-radius:6px; padding:9px 10px; font:14px Arial,"Microsoft YaHei",sans-serif; }
    .form-row button { border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:6px; padding:9px 14px; font-size:14px; cursor:pointer; }
    .form-row .secondary-button { background:#fff; color:var(--accent); white-space:nowrap; }
    .mini-button { border:1px solid var(--border); background:#fff; color:var(--accent); border-radius:6px; padding:6px 9px; font-size:12px; line-height:1; cursor:pointer; white-space:nowrap; }
    .link-result { display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12px; word-break:break-all; line-height:1.35; min-height:16px; }
    .link-result a { text-decoration:none; }
    .error-inline { color:#9b1c1c; }
    .login-page { min-height:100vh; display:grid; place-items:center; }
    .login-main { width:min(380px, 100%); padding:16px; }
    .login-form { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:22px; }
    .login-form h1 { margin-bottom:18px; }
    .login-form label { display:block; color:var(--muted); font-size:13px; margin-bottom:12px; }
    .login-form input { display:block; width:100%; margin-top:6px; border:1px solid var(--border); border-radius:6px; padding:10px; font:15px Arial,"Microsoft YaHei",sans-serif; }
    .login-form button { width:100%; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:6px; padding:10px; font-size:15px; cursor:pointer; }
    .domain-page main { max-width:880px; }
    .domain-header { padding:22px 30px; }
    .search-row { display:flex; align-items:center; gap:12px; margin-top:12px; max-width:520px; }
    .search-row input { flex:1; min-width:0; border:1px solid var(--border); border-radius:6px; padding:9px 10px; font:14px Arial,"Microsoft YaHei",sans-serif; }
    .search-row span { color:var(--muted); font-size:13px; white-space:nowrap; }
    .inbox-page main { max-width:860px; margin:0 auto; padding:16px 14px 40px; }
    .all-mail-page main { max-width:920px; margin:0 auto; padding:18px 14px 44px; }
    .compact-header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 24px; position:static; }
    .compact-header h1 { font-size:19px; }
    .header-actions { display:flex; align-items:center; justify-content:flex-end; gap:10px; flex-wrap:wrap; }
    .mailbox-group { margin-bottom:22px; }
    .mailbox-head { display:flex; align-items:center; justify-content:space-between; gap:16px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin:0; padding:16px 18px; }
    .mailbox-title { display:flex; align-items:center; gap:10px; min-width:0; }
    .mailbox-head h2 { font-size:17px; line-height:1.3; margin:0; word-break:break-word; }
    .mailbox-actions { display:flex; align-items:center; justify-content:flex-end; gap:12px; margin-left:auto; }
    .mailbox-stats { display:flex; flex-direction:column; align-items:flex-end; gap:4px; color:var(--muted); font-size:13px; white-space:nowrap; }
    .mailbox-time { font-size:12px; }
    .notice { border:1px solid #f0c36d; background:#fff8e6; color:#7a4b00; border-radius:8px; margin:0 0 12px; padding:12px 14px; font-size:15px; font-weight:700; line-height:1.45; }
    .mail, .empty { background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:10px; padding:12px 14px; }
    .error { background:#fff4f4; color:#9b1c1c; border:1px solid #ffd6d6; border-radius:8px; padding:14px; }
    .subject { font-size:18px; font-weight:700; margin:0 0 7px; word-break:break-word; }
    .meta { color:var(--muted); font-size:13px; margin-bottom:8px; word-break:break-word; }
    .code { display:inline-block; border:1px solid #b8d4f1; background:#eef6ff; color:#0f4e8a; border-radius:6px; padding:5px 10px; margin:0 0 8px; font:700 22px/1.15 Consolas,monospace; letter-spacing:0; }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; font:15px/1.34 Consolas,"Microsoft YaHei",monospace; }
    @media (max-width:760px) {
      .split-header { display:block; padding:18px 16px; }
      .title-row { align-items:flex-start; justify-content:space-between; }
      .link-form { width:100%; margin-top:14px; }
      .domains-layout { display:block; max-width:none; padding:14px 12px 32px; }
      .domain-sidebar, .domain-mail-window { position:static; max-height:none; overflow:visible; }
      .domain-mail-window { margin-top:16px; padding-right:0; }
      .domain-page main { max-width:none; padding:18px 16px 40px; }
      .inbox-page main, .all-mail-page main { max-width:none; padding:14px 12px 32px; }
      .compact-header { padding:12px; }
      .header-actions { width:100%; justify-content:flex-start; }
      .form-row { display:block; }
      .form-row button { width:100%; margin-top:8px; }
      .link-result { display:block; }
      .link-result .mini-button { width:100%; margin-top:8px; }
      .mailbox-head { align-items:flex-start; flex-direction:column; }
      .mailbox-title { width:100%; }
      .mailbox-actions { width:100%; justify-content:space-between; margin-left:0; }
      .mailbox-stats { align-items:flex-end; }
      .search-row { max-width:none; }
    }
  `;
}

function renderMessage(row) {
  const body = compactBody(row.body || "");
  const code = verificationCode(body);
  return `<article class="mail">
  <h2 class="subject">${escapeHtml(row.subject || "(无主题)")}</h2>
  <div class="meta">To: ${escapeHtml(row.recipient || "")} &nbsp; From: ${escapeHtml(row.sender || "(未知发件人)")} &nbsp; Date: ${escapeHtml(formatBeijingTime(row.date_header || row.created_at))}</div>
  ${code ? `<div class="code">${escapeHtml(code)}</div>` : ""}
  <pre>${escapeHtml(body || "(邮件正文为空)")}</pre>
</article>`;
}

function formatBeijingTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) {
    return value || "";
  }
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} 北京时间`;
}

function compactBody(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function verificationCode(value) {
  return String(value || "").match(/(?:^|\D)(\d{4,8})(?:\D|$)/)?.[1] || "";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
