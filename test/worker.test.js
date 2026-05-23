import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/worker.js";

function envWithMessages(messages, token = "view-token") {
  return {
    MAIL_VIEW_TOKEN: token,
    LOGIN_USERNAME: "admin",
    LOGIN_PASSWORD: "password",
    SESSION_SECRET: "session-secret",
    DB: {
      prepare(sql) {
        const runAll = (args = []) => {
          if (sql.includes("GROUP BY domain")) {
            const byDomain = new Map();
            for (const message of messages) {
              const domain = message.recipient.split("@")[1]?.toLowerCase();
              if (!domain) continue;
              const current = byDomain.get(domain) || { domain, count: 0, latest_at: "" };
              current.count += 1;
              current.latest_at = current.latest_at > message.created_at ? current.latest_at : message.created_at;
              byDomain.set(domain, current);
            }
            return { results: [...byDomain.values()].sort((a, b) => b.latest_at.localeCompare(a.latest_at)) };
          }
          if (sql.includes("GROUP BY address")) {
            const byAddress = new Map();
            for (const message of messages) {
              const address = message.recipient.toLowerCase();
              const current = byAddress.get(address) || { address, count: 0, latest_at: "" };
              current.count += 1;
              current.latest_at = current.latest_at > message.created_at ? current.latest_at : message.created_at;
              byAddress.set(address, current);
            }
            return { results: [...byAddress.values()].sort((a, b) => b.latest_at.localeCompare(a.latest_at)) };
          }
          const limit = args.at(-1);
          let filtered = messages;
          if (sql.includes("WHERE recipient = ?")) {
            filtered = messages.filter((message) => message.recipient === args[0]);
          } else if (sql.includes("WHERE recipient LIKE ?")) {
            const domain = String(args[0]).slice(2);
            filtered = messages.filter((message) => message.recipient.endsWith(`@${domain}`));
          }
          if (sql.includes("ORDER BY created_at DESC")) {
            filtered = [...filtered].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
          }
          return { results: filtered.slice(0, limit) };
        };
        return {
          async all() {
            return runAll();
          },
          bind(...args) {
            assert.match(sql, /FROM messages/);
            return {
              async all() {
                return runAll(args);
              },
            };
          },
        };
      },
    },
  };
}

function envCapturingInsert(captured) {
  return {
    DB: {
      prepare(sql) {
        assert.match(sql, /INSERT OR IGNORE INTO messages/);
        return {
          bind(...args) {
            captured.args = args;
            return {
              async run() {
                return {};
              },
            };
          },
        };
      },
    },
  };
}

function envForAddressLink() {
  const addresses = new Map();
  return {
    MAIL_VIEW_TOKEN: "view-token",
    LOGIN_USERNAME: "admin",
    LOGIN_PASSWORD: "password",
    SESSION_SECRET: "session-secret",
    PUBLIC_BASE_URL: "https://mail.example.test",
    DB: {
      prepare(sql) {
        if (sql.includes("SELECT address, token, display_name FROM addresses")) {
          return {
            bind(address) {
              return {
                async first() {
                  return addresses.get(address) || null;
                },
              };
            },
          };
        }
        if (sql.includes("INSERT INTO addresses")) {
          return {
            bind(address, token, displayName, createdAt) {
              return {
                async run() {
                  addresses.set(address, {
                    address,
                    token,
                    display_name: displayName,
                    created_at: createdAt,
                  });
                  return {};
                },
              };
            },
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    },
  };
}

test("latest page requires token", async () => {
  const response = await worker.fetch(
    new Request("https://mail.example.test/latest"),
    envWithMessages([])
  );

  assert.equal(response.status, 302);
  assert.match(response.headers.get("location"), /^\/login/);
});

test("root redirects to login page", async () => {
  const response = await worker.fetch(
    new Request("https://mail.example.test/"),
    envWithMessages([])
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/login");
});

test("login sets a session cookie that can access domains", async () => {
  const loginResponse = await worker.fetch(
    new Request("https://mail.example.test/login", {
      method: "POST",
      body: new URLSearchParams({
        username: "admin",
        password: "password",
        return: "/domains",
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    envWithMessages([])
  );

  assert.equal(loginResponse.status, 302);
  const cookie = loginResponse.headers.get("set-cookie");
  assert.match(cookie, /mail_session=/);

  const response = await worker.fetch(
    new Request("https://mail.example.test/domains", {
      headers: { cookie },
    }),
    envWithMessages([])
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /邮件域/);
});

test("latest json returns newest messages when token matches", async () => {
  const response = await worker.fetch(
    new Request("https://mail.example.test/latest.json?token=view-token&limit=1"),
    envWithMessages([
      {
        id: 1,
        recipient: "inbox@example.test",
        sender: "sender@example.test",
        subject: "Hello",
        date_header: "Fri, 22 May 2026 15:00:00 +0800",
        body: "latest body",
        raw_truncated: 0,
        created_at: "2026-05-22T07:00:00.000Z",
      },
    ])
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    emails: [
      {
        id: 1,
        recipient: "inbox@example.test",
        sender: "sender@example.test",
        subject: "Hello",
        date: "Fri, 22 May 2026 15:00:00 +0800",
        body: "latest body",
        receivedAt: "2026-05-22T07:00:00.000Z",
        rawTruncated: false,
      },
    ],
  });
});

test("email handler decodes gb2312 body text", async () => {
  const captured = {};
  const raw = new Uint8Array([
    ...new TextEncoder().encode(
      "Subject: gb body\r\n" +
        "From: sender@example.test\r\n" +
        "Date: Fri, 22 May 2026 15:00:00 +0800\r\n" +
        "Content-Type: text/plain; charset=gb2312\r\n" +
        "Content-Transfer-Encoding: 8bit\r\n" +
        "\r\n"
    ),
    0xb2,
    0xe2,
    0xca,
    0xd4,
  ]);

  await worker.email(
    {
      to: "inbox@example.test",
      from: "sender@example.test",
      raw: raw.buffer,
      headers: new Headers({
        from: "sender@example.test",
        subject: "gb body",
        date: "Fri, 22 May 2026 15:00:00 +0800",
        "message-id": "gb2312-body@example.test",
      }),
    },
    envCapturingInsert(captured)
  );

  assert.equal(captured.args[5], "\u6d4b\u8bd5");
});

test("email handler decodes multipart base64 utf8 body once", async () => {
  const captured = {};
  const raw =
    "Subject: multipart body\r\n" +
    "From: sender@example.test\r\n" +
    "Date: Fri, 22 May 2026 15:00:00 +0800\r\n" +
    "Content-Type: multipart/alternative; boundary=\"b1\"\r\n" +
    "\r\n" +
    "--b1\r\n" +
    "Content-Type: text/plain; charset=UTF-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n" +
    "\r\n" +
    "5paw55qE5Lit5paH5rWL6K+VMTIz\r\n" +
    "--b1--\r\n";

  await worker.email(
    {
      to: "inbox@example.test",
      from: "sender@example.test",
      raw,
      headers: new Headers({
        from: "sender@example.test",
        subject: "multipart body",
        date: "Fri, 22 May 2026 15:00:00 +0800",
        "message-id": "multipart-body@example.test",
      }),
    },
    envCapturingInsert(captured)
  );

  assert.equal(captured.args[5], "\u65b0\u7684\u4e2d\u6587\u6d4b\u8bd5123");
});

test("email handler strips html style blocks from verification mail", async () => {
  const captured = {};
  const raw =
    "Subject: verification\r\n" +
    "From: sender@example.test\r\n" +
    "Date: Fri, 22 May 2026 15:00:00 +0800\r\n" +
    "Content-Type: text/html; charset=UTF-8\r\n" +
    "Content-Transfer-Encoding: 8bit\r\n" +
    "\r\n" +
    "<!doctype html><html><head><style>.ExternalClass{line-height:100%;}</style></head>" +
    "<body><h1>Your temporary ChatGPT verification code</h1><div>123456</div></body></html>";

  await worker.email(
    {
      to: "inbox@example.test",
      from: "sender@example.test",
      raw,
      headers: new Headers({
        from: "sender@example.test",
        subject: "verification",
        date: "Fri, 22 May 2026 15:00:00 +0800",
        "message-id": "html-style-body@example.test",
      }),
    },
    envCapturingInsert(captured)
  );

  assert.match(captured.args[5], /Your temporary ChatGPT verification code/);
  assert.match(captured.args[5], /123456/);
  assert.doesNotMatch(captured.args[5], /ExternalClass/);
  assert.doesNotMatch(captured.args[5], /line-height/);
});


test("open inbox json reads an address without pre-registering it", async () => {
  const response = await worker.fetch(
    new Request("https://mail.example.test/api/inbox/inbox%40example.test/latest?token=view-token&limit=1"),
    envWithMessages([
      {
        id: 1,
        recipient: "other@example.test",
        sender: "sender@example.test",
        subject: "Other",
        date_header: "",
        body: "other body",
        raw_truncated: 0,
        created_at: "2026-05-22T06:00:00.000Z",
      },
      {
        id: 2,
        recipient: "inbox@example.test",
        sender: "sender@example.test",
        subject: "Inbox",
        date_header: "",
        body: "inbox body",
        raw_truncated: 0,
        created_at: "2026-05-22T07:00:00.000Z",
      },
    ])
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    address: "inbox@example.test",
    emails: [
      {
        id: 2,
        recipient: "inbox@example.test",
        sender: "sender@example.test",
        subject: "Inbox",
        date: "",
        body: "inbox body",
        receivedAt: "2026-05-22T07:00:00.000Z",
        rawTruncated: false,
      },
    ],
  });
});

test("inbox page compacts body and highlights verification code", async () => {
  const response = await worker.fetch(
    new Request("https://mail.example.test/inbox/inbox%40example.test?token=view-token"),
    envWithMessages([
      {
        id: 1,
        recipient: "inbox@example.test",
        sender: "sender@example.test",
        subject: "Code",
        date_header: "",
        body: "Enter this code:\n\n\n123456\n\n\nBest",
        raw_truncated: 0,
        created_at: "2026-05-22T07:00:00.000Z",
      },
    ])
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /class="code">123456/);
  assert.match(html, /inbox-page/);
  assert.match(html, /本邮箱仅用于临时收信/);
  assert.match(html, /有效期为 1 个月/);
  assert.match(html, /2026-05-22 15:00:00 北京时间/);
  assert.doesNotMatch(html, /\n\nBest/);
});

test("domain json reads messages for one subdomain", async () => {
  const response = await worker.fetch(
    new Request("https://mail.example.test/api/domain/sss.example.test/latest?token=view-token&limit=10"),
    envWithMessages([
      {
        id: 1,
        recipient: "a@sss.example.test",
        sender: "sender@example.test",
        subject: "SSS",
        date_header: "",
        body: "sss body",
        raw_truncated: 0,
        created_at: "2026-05-22T07:00:00.000Z",
      },
      {
        id: 2,
        recipient: "b@mail.example.test",
        sender: "sender@example.test",
        subject: "Mail",
        date_header: "",
        body: "mail body",
        raw_truncated: 0,
        created_at: "2026-05-22T08:00:00.000Z",
      },
    ])
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    domain: "sss.example.test",
    mailboxes: [
      {
        address: "a@sss.example.test",
        count: 1,
        latestAt: "2026-05-22T07:00:00.000Z",
        emails: [
          {
            id: 1,
            recipient: "a@sss.example.test",
            sender: "sender@example.test",
            subject: "SSS",
            date: "",
            body: "sss body",
            receivedAt: "2026-05-22T07:00:00.000Z",
            rawTruncated: false,
          },
        ],
      },
    ],
    emails: [
      {
        id: 1,
        recipient: "a@sss.example.test",
        sender: "sender@example.test",
        subject: "SSS",
        date: "",
        body: "sss body",
        receivedAt: "2026-05-22T07:00:00.000Z",
        rawTruncated: false,
      },
    ],
  });
});

test("domain page groups messages by individual mailbox", async () => {
  const response = await worker.fetch(
    new Request("https://mail.example.test/domain/sss.example.test?token=view-token&limit=10"),
    envWithMessages([
      {
        id: 1,
        recipient: "a@sss.example.test",
        sender: "sender@example.test",
        subject: "A1",
        date_header: "",
        body: "a body",
        raw_truncated: 0,
        created_at: "2026-05-22T07:00:00.000Z",
      },
      {
        id: 2,
        recipient: "b@sss.example.test",
        sender: "sender@example.test",
        subject: "B1",
        date_header: "",
        body: "b body",
        raw_truncated: 0,
        created_at: "2026-05-22T08:00:00.000Z",
      },
    ])
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /a@sss\.example\.test/);
  assert.match(html, /b@sss\.example\.test/);
  assert.match(html, /\/inbox\/a%40sss\.example\.test\?token=view-token/);
  assert.match(html, /\/inbox\/b%40sss\.example\.test\?token=view-token/);
  assert.match(html, /id="mailboxSearch"/);
  assert.match(html, /data-address="a@sss\.example\.test"/);
  assert.match(html, /data-copy="a@sss\.example\.test"/);
  assert.match(html, /mailbox-actions/);
  assert.match(html, /最新: 2026-05-22 15:00:00 北京时间/);
  assert.match(html, /复制/);
  assert.match(html, /1 封邮件/);
  assert.doesNotMatch(html, /a body/);
  assert.doesNotMatch(html, /b body/);
});

test("mailboxes page lists every message without mailbox grouping", async () => {
  const response = await worker.fetch(
    new Request("https://mail.example.test/mailboxes?token=view-token"),
    envWithMessages([
      {
        id: 1,
        recipient: "a@sss.example.test",
        sender: "sender@example.test",
        subject: "A1",
        date_header: "",
        body: "a body",
        raw_truncated: 0,
        created_at: "2026-05-22T07:00:00.000Z",
      },
      {
        id: 2,
        recipient: "b@mail.example.test",
        sender: "sender@example.test",
        subject: "B1",
        date_header: "",
        body: "b body",
        raw_truncated: 0,
        created_at: "2026-05-22T08:00:00.000Z",
      },
    ])
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /全部邮件/);
  assert.match(html, /\/domains\?token=view-token/);
  assert.match(html, /id="messageSearch"/);
  assert.match(html, /2 封邮件/);
  assert.match(html, /<h2 class="subject">B1<\/h2>/);
  assert.match(html, /<h2 class="subject">A1<\/h2>/);
  assert.match(html, /b body/);
  assert.match(html, /a body/);
  assert.match(html, /2026-05-22 16:00:00 北京时间/);
  assert.doesNotMatch(html, /<section class="mailbox-group"/);
  assert.doesNotMatch(html, /data-copy="a@sss\.example\.test"/);
});

test("domains json lists observed recipient domains", async () => {
  const response = await worker.fetch(
    new Request("https://mail.example.test/domains.json?token=view-token"),
    envWithMessages([
      {
        id: 1,
        recipient: "a@sss.example.test",
        sender: "sender@example.test",
        subject: "SSS",
        date_header: "",
        body: "sss body",
        raw_truncated: 0,
        created_at: "2026-05-22T07:00:00.000Z",
      },
      {
        id: 2,
        recipient: "b@sss.example.test",
        sender: "sender@example.test",
        subject: "SSS 2",
        date_header: "",
        body: "sss body 2",
        raw_truncated: 0,
        created_at: "2026-05-22T08:00:00.000Z",
      },
    ])
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.domains[0].domain, "sss.example.test");
  assert.equal(payload.domains[0].count, 2);
});

test("domains page shows dedicated link form and latest messages panel", async () => {
  const response = await worker.fetch(
    new Request("https://mail.example.test/domains?token=view-token"),
    envWithMessages([
      {
        id: 1,
        recipient: "a@sss.example.test",
        sender: "sender@example.test",
        subject: "Old",
        date_header: "",
        body: "old body",
        raw_truncated: 0,
        created_at: "2026-05-22T07:00:00.000Z",
      },
      {
        id: 2,
        recipient: "b@mail.example.test",
        sender: "sender@example.test",
        subject: "New",
        date_header: "",
        body: "new body",
        raw_truncated: 0,
        created_at: "2026-05-22T08:00:00.000Z",
      },
    ])
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /class="split-header"/);
  assert.match(html, /class="domains-layout"/);
  assert.match(html, /class="domain-sidebar"/);
  assert.match(html, /class="domain-mail-window"/);
  assert.match(html, /子域名/);
  assert.match(html, /按时间倒序的邮件/);
  assert.match(html, /sss\.example\.test/);
  assert.match(html, /mail\.example\.test/);
  assert.match(html, /<h2 class="subject">New<\/h2>/);
  assert.match(html, /<h2 class="subject">Old<\/h2>/);
  assert.match(html, /new body/);
  assert.match(html, /\/mailboxes\?token=view-token/);
  assert.match(html, /查看全部邮件/);
  assert.match(html, /创建专属链接/);
  assert.match(html, /name="address"/);
  assert.match(html, /action="\/admin\/link"/);
  assert.match(html, /id="linkResult"/);
  assert.match(html, /id="copyAddress"/);
  assert.match(html, /复制邮箱/);
  assert.match(html, /复制链接/);
  assert.match(html, /\/admin\/link\.json/);
});

test("admin link form creates a dedicated mailbox link", async () => {
  const body = new URLSearchParams({
    token: "view-token",
    address: "user@sss.example.test",
    displayName: "user",
  });
  const response = await worker.fetch(
    new Request("https://mail.example.test/admin/link", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    envForAddressLink()
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /user@sss\.example\.test/);
  assert.match(html, /https:\/\/mail\.example\.test\/m\//);
});

test("admin link json creates a dedicated mailbox link in-place", async () => {
  const response = await worker.fetch(
    new Request("https://mail.example.test/admin/link.json", {
      method: "POST",
      body: JSON.stringify({
        token: "view-token",
        address: "user@sss.example.test",
        displayName: "user",
      }),
      headers: { "Content-Type": "application/json" },
    }),
    envForAddressLink()
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.address, "user@sss.example.test");
  assert.match(payload.link, /^https:\/\/mail\.example\.test\/m\//);
});

test("admin link json accepts a logged-in session without token", async () => {
  const env = envForAddressLink();
  const loginResponse = await worker.fetch(
    new Request("https://mail.example.test/login", {
      method: "POST",
      body: new URLSearchParams({
        username: "admin",
        password: "password",
        return: "/domains",
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    env
  );
  const cookie = loginResponse.headers.get("set-cookie");

  const response = await worker.fetch(
    new Request("https://mail.example.test/admin/link.json", {
      method: "POST",
      body: JSON.stringify({
        address: "session@sss.example.test",
        displayName: "session",
      }),
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
    }),
    env
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.address, "session@sss.example.test");
});
