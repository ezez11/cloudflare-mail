# Cloudflare Mail Links

一个轻量级 Cloudflare Worker 邮件接收和查看工具。它通过 Cloudflare Email Routing 接收邮件，把邮件保存到 D1，并提供网页、专属链接和 JSON 接口查看邮件。

## 功能

- 使用 Worker `email()` 入口接收 Cloudflare Email Routing 转发的邮件。
- 使用 Cloudflare D1 保存邮件和专属邮箱链接。
- 按收件域名查看邮件域，按单独邮箱查看某个域名下的邮箱。
- 支持“全部邮件”页面，按时间倒序直接查看所有邮件。
- 支持在邮件域页面基于现有子域名生成邮箱地址，并一键复制。
- 支持账号密码登录后台查看页面，也支持 `MAIL_VIEW_TOKEN` 链接访问。
- 支持为单个邮箱生成专属查看链接 `/m/<token>`。
- 支持管理员 API 创建、删除和查看专属邮箱链接。
- 支持常见邮件格式解析：纯文本、HTML、multipart、base64、quoted-printable、UTF-8、GBK/GB2312/GB18030。

## 工作原理

```text
外部邮件
-> Cloudflare Email Routing
-> Worker email(message, env)
-> 解析 MIME / 正文 / 标题
-> 写入 D1 messages 表
-> 浏览器访问 Worker 页面
-> Worker fetch(request, env)
-> 校验登录会话、MAIL_VIEW_TOKEN 或专属邮箱 token
-> 查询 D1
-> 返回 HTML 或 JSON
```

主要数据表：

```text
addresses
- address
- token
- display_name
- created_at

messages
- recipient
- sender
- subject
- date_header
- message_id
- body
- raw_excerpt
- raw_truncated
- created_at
```

## 页面

后台查看页面可以通过登录会话访问，也可以通过 `?token=<MAIL_VIEW_TOKEN>` 访问。

```text
/login                         登录页面
/logout                        退出登录
/domains                       按收件域名查看邮件数量
/mailboxes                     查看全部邮件，不按邮箱分类
/domain/<domain>               查看某个域名下的单独邮箱
/inbox/<email>                 查看某个邮箱的邮件
/latest                        查看全站最新邮件
/m/<mailbox_token>             单个邮箱的专属查看链接
```

如果没有登录且没有提供正确的 `MAIL_VIEW_TOKEN`，受保护页面会跳转到 `/login`。

## 完整链接与功能

下面的 `https://your-domain.example` 指你的 Worker 访问地址，可以是 Workers.dev 地址，也可以是你绑定的自定义域名。`<email>` 放在 URL 路径里时需要 URL 编码，例如 `user@sub.example.com` 写成 `user%40sub.example.com`。

| 方法 | 完整链接示例 | 权限 | 功能 |
| --- | --- | --- | --- |
| GET | `https://your-domain.example/` | 无 | 首页，显示基础访问提示。 |
| GET | `https://your-domain.example/login` | 无 | 登录页面。 |
| POST | `https://your-domain.example/login` | `LOGIN_USERNAME` / `LOGIN_PASSWORD` | 提交账号密码，登录成功后写入 `mail_session` Cookie。 |
| GET | `https://your-domain.example/logout` | 登录会话 | 退出登录并清除会话 Cookie。 |
| GET | `https://your-domain.example/domains` | 登录会话或 `MAIL_VIEW_TOKEN` | 查看所有收到过邮件的收件域名、邮件数量和最新收信时间；页面上方提供基于现有子域名的邮箱生成器。 |
| GET | `https://your-domain.example/domains?token=<MAIL_VIEW_TOKEN>` | `MAIL_VIEW_TOKEN` | 不登录，直接通过 token 查看邮件域页面，并使用邮箱生成器。 |
| GET | `https://your-domain.example/mailboxes` | 登录会话或 `MAIL_VIEW_TOKEN` | 查看全部邮件，按时间倒序直接显示每封邮件。 |
| GET | `https://your-domain.example/mailboxes?token=<MAIL_VIEW_TOKEN>` | `MAIL_VIEW_TOKEN` | 不登录，直接通过 token 查看全部邮件。 |
| GET | `https://your-domain.example/domain/<domain>` | 登录会话或 `MAIL_VIEW_TOKEN` | 查看某个域名下的单独邮箱列表，例如 `sss.example.com`。 |
| GET | `https://your-domain.example/domain/<domain>?token=<MAIL_VIEW_TOKEN>` | `MAIL_VIEW_TOKEN` | 不登录，直接通过 token 查看某个域名下的邮箱。 |
| GET | `https://your-domain.example/inbox/<email>` | 登录会话或 `MAIL_VIEW_TOKEN` | 查看某个邮箱的邮件，例如 `/inbox/user%40sss.example.com`。 |
| GET | `https://your-domain.example/inbox/<email>?token=<MAIL_VIEW_TOKEN>` | `MAIL_VIEW_TOKEN` | 不登录，直接通过 token 查看某个邮箱。 |
| GET | `https://your-domain.example/latest` | 登录会话或 `MAIL_VIEW_TOKEN` | 查看全站最新邮件。 |
| GET | `https://your-domain.example/latest?token=<MAIL_VIEW_TOKEN>` | `MAIL_VIEW_TOKEN` | 不登录，直接通过 token 查看全站最新邮件。 |
| GET | `https://your-domain.example/m/<mailbox_token>` | 专属邮箱 token | 查看单个邮箱的专属页面，适合给某个邮箱单独生成查看链接。 |
| POST | `https://your-domain.example/admin/link` | 登录会话或 `MAIL_VIEW_TOKEN` | 表单方式创建单个邮箱的专属查看链接。 |
| POST | `https://your-domain.example/admin/link.json` | 登录会话或 `MAIL_VIEW_TOKEN` | JSON 方式创建单个邮箱的专属查看链接，返回 `link` 和 `token`。 |
| GET | `https://your-domain.example/domains.json?token=<MAIL_VIEW_TOKEN>` | `MAIL_VIEW_TOKEN` | JSON 格式返回所有收件域名摘要。 |
| GET | `https://your-domain.example/latest.json?token=<MAIL_VIEW_TOKEN>` | `MAIL_VIEW_TOKEN` | JSON 格式返回全站最新邮件。 |
| GET | `https://your-domain.example/api/domain/<domain>/latest?token=<MAIL_VIEW_TOKEN>` | `MAIL_VIEW_TOKEN` | JSON 格式返回某个域名下的邮箱分组和邮件。 |
| GET | `https://your-domain.example/api/inbox/<email>/latest?token=<MAIL_VIEW_TOKEN>` | `MAIL_VIEW_TOKEN` | JSON 格式返回某个邮箱的邮件。 |
| GET | `https://your-domain.example/api/m/<mailbox_token>/latest` | 专属邮箱 token | JSON 格式返回专属邮箱链接对应邮箱的邮件。 |
| POST | `https://your-domain.example/admin/address` | `Authorization: Bearer <ADMIN_TOKEN>` | 管理 API：创建或获取某个邮箱的专属查看链接。 |
| DELETE | `https://your-domain.example/admin/address?address=<email>` | `Authorization: Bearer <ADMIN_TOKEN>` | 管理 API：删除某个邮箱的专属查看链接。 |
| GET | `https://your-domain.example/admin/addresses` | `Authorization: Bearer <ADMIN_TOKEN>` | 管理 API：列出所有已创建的专属邮箱链接。 |

## 登录配置

登录页面使用环境密钥配置一个管理员账号。部署前需要设置：

```cmd
npx.cmd wrangler secret put LOGIN_USERNAME
npx.cmd wrangler secret put LOGIN_PASSWORD
npx.cmd wrangler secret put SESSION_SECRET
```

说明：

```text
LOGIN_USERNAME   登录用户名
LOGIN_PASSWORD   登录密码
SESSION_SECRET   会话签名密钥，建议使用随机长字符串
```

登录成功后 Worker 会写入 `mail_session` Cookie。后续访问 `/domains`、`/mailboxes`、`/domain/<domain>`、`/inbox/<email>` 等页面时，可以不再手动输入 `MAIL_VIEW_TOKEN`。

`MAIL_VIEW_TOKEN` 仍然可用，适合直接分享管理员查看链接或在无 Cookie 场景中访问。

## JSON 接口

```text
/domains.json?token=<MAIL_VIEW_TOKEN>
/api/domain/<domain>/latest?token=<MAIL_VIEW_TOKEN>
/api/inbox/<email>/latest?token=<MAIL_VIEW_TOKEN>
/latest.json?token=<MAIL_VIEW_TOKEN>
```

## 管理接口

管理员 API 使用 `ADMIN_TOKEN`：

```text
POST /admin/address
DELETE /admin/address?address=<email>
GET /admin/addresses
```

也可以在 `/domains` 页面右上角创建专属邮箱链接。登录后或携带正确 `MAIL_VIEW_TOKEN` 都可以使用该页面功能。

## 安装

安装依赖：

```cmd
npm.cmd install
```

登录 Cloudflare：

```cmd
npx.cmd wrangler login
```

创建 D1 数据库：

```cmd
npx.cmd wrangler d1 create mail_links
```

把输出里的 `database_id` 填进 `wrangler.toml`：

```toml
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

执行数据库迁移：

```cmd
npx.cmd wrangler d1 migrations apply mail_links --remote
```

设置密钥：

```cmd
npx.cmd wrangler secret put ADMIN_TOKEN
npx.cmd wrangler secret put MAIL_VIEW_TOKEN
npx.cmd wrangler secret put LOGIN_USERNAME
npx.cmd wrangler secret put LOGIN_PASSWORD
npx.cmd wrangler secret put SESSION_SECRET
```

部署：

```cmd
npx.cmd wrangler deploy
```

## Cloudflare Email Routing 配置

在 Cloudflare Dashboard 中配置：

```text
Email Routing
-> Routing rules
-> Catch-all address 或 Custom address
-> Send to a Worker
-> cloudflare-mail-links
```

如果要接收子域名邮箱，例如：

```text
user@sub.example.com
```

需要先在 Email Routing 中添加该子域名，并给该子域名配置 MX/TXT 记录。然后把该子域名的邮件规则转发到这个 Worker。

## 用户需要自行修改的配置

部署前需要修改 `wrangler.toml`：

```toml
PUBLIC_BASE_URL = "https://your-domain.example"
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

还需要自行配置：

```text
ADMIN_TOKEN       管理接口 token
MAIL_VIEW_TOKEN   查看页面 token
LOGIN_USERNAME    登录用户名
LOGIN_PASSWORD    登录密码
SESSION_SECRET    会话签名密钥
Email Routing     把需要收信的域名或子域名转发到 Worker
Custom Domain     可选，用于网页访问 Worker
```

## 常用访问示例

登录后台：

```text
https://your-domain.example/login
```

查看所有收到过邮件的域名：

```text
https://your-domain.example/domains
https://your-domain.example/domains?token=<MAIL_VIEW_TOKEN>
```

查看全部邮件：

```text
https://your-domain.example/mailboxes
https://your-domain.example/mailboxes?token=<MAIL_VIEW_TOKEN>
```

查看某个域名下的邮箱：

```text
https://your-domain.example/domain/sub.example.com
https://your-domain.example/domain/sub.example.com?token=<MAIL_VIEW_TOKEN>
```

查看某个邮箱：

```text
https://your-domain.example/inbox/user%40sub.example.com
https://your-domain.example/inbox/user%40sub.example.com?token=<MAIL_VIEW_TOKEN>
```

查看最新邮件：

```text
https://your-domain.example/latest
https://your-domain.example/latest?token=<MAIL_VIEW_TOKEN>
```

## 开发

运行测试：

```cmd
npm.cmd test
```

检查 Worker 语法：

```cmd
node --check .\src\worker.js
```

部署前 dry-run：

```cmd
npx.cmd wrangler deploy --dry-run
```

## 安全说明

- 拿到 `MAIL_VIEW_TOKEN` 的人可以访问受保护的查看页面。
- 拿到登录账号密码的人可以访问后台页面。
- 拿到 `ADMIN_TOKEN` 的人可以创建或删除专属邮箱链接。
- `/m/<token>` 是 bearer link，谁拿到链接谁就能查看对应邮箱。
- 不要提交真实 token、`.dev.vars`、生产环境私密配置。
