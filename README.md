# mcp-gmail

### Multi-Account Gmail MCP — read, write, archive, label, unsubscribe, **send, draft, reply**

> **Fork status:** This is a personal fork by Chaz Clark, built on top of [navbuildz/gmail-mcp-server](https://github.com/navbuildz/gmail-mcp-server). Adds compose-side tools — `send_email`, `save_draft`, `reply_to_email` (with reply-all + save-draft-only modes + RFC 5322 threading via `In-Reply-To` / `References`) — plus a `docker-compose.yml` for local self-host. Upstream is read-mostly; this fork makes it usable for personal email triage and ghostwriting workflows.

An open-source [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives AI agents and assistants full Gmail access — read, write, archive, label, auto-unsubscribe, **plus send / draft / reply with proper thread headers**. Connect multiple Gmail accounts through one server.

![Gmail MCP Server Banner](banner.png)

Works with **Claude Code**, **Claude Desktop**, **Cursor**, **Windsurf**, **Cline**, **Continue**, and any MCP-compatible client.

> The original upstream README below covers the Railway-hosted deploy path. This fork is self-host-first via Docker Compose — see the next section. Railway deploy still works as documented in the upstream sections but isn't required.

## Fork additions

| Tool | Description |
|---|---|
| `send_email` | Send an email from a specified account (To / Cc / Bcc / Subject / Body). |
| `save_draft` | Save a draft to Gmail Drafts without sending — review and send manually or via `reply_to_email(save_draft_only: true)`. |
| `reply_to_email` | Reply to an existing message. Threads correctly via `In-Reply-To` / `References` / `threadId`. Supports `reply_all` flag, extra Cc/Bcc additions, and `save_draft_only` for propose-then-send workflows. |

Plus: `gmail.compose` OAuth scope added (required for send and draft creation); `docker-compose.yml` shipped for local Docker self-host with health checks.

---

## Local self-host quickstart (Docker Compose)

End-to-end from "fresh clone" to "tools callable in Claude Code". About 15–20 minutes total, most of which is clicking through Google Cloud Console.

### Prerequisites

- **Docker** (Desktop or Engine), with `docker compose` v2
- **Google account** for each Gmail address you want to connect
- **Claude Code** (or another MCP client) installed locally
- A free local port for the server (default `3000`, configurable in `.env`)

### Step 1 — Google Cloud Console (one-time per developer)

You need an OAuth client so the server can talk to Gmail on your behalf. This happens in [console.cloud.google.com](https://console.cloud.google.com/).

1. **Create a project.** Project picker → New Project → name it `mcp-gmail` → Create → switch to it.
2. **Enable the Gmail API.** APIs & Services → Library → search "Gmail API" → Enable.
3. **Configure the OAuth consent screen.** APIs & Services → OAuth consent screen.
   - User Type: **External** (works for personal `@gmail.com` accounts).
   - App name: `mcp-gmail`. User support email + Developer contact: yours.
   - Continue → **Scopes** → click **Add or Remove Scopes** and check all four:
     | Scope | Tier | Why |
     |---|---|---|
     | `https://www.googleapis.com/auth/gmail.readonly` | Sensitive | Read messages |
     | `https://www.googleapis.com/auth/gmail.modify` | **Restricted** | Archive, label, mark read/unread |
     | `https://www.googleapis.com/auth/gmail.compose` | **Restricted** | Send + draft (fork additions) |
     | `https://www.googleapis.com/auth/userinfo.email` | Non-sensitive | Identify the user at OAuth completion |
   - The "Restricted" warning is **fine in Testing mode** — Google caps you at 100 test users without verification. Don't publish; leave it in Testing forever.
   - **Test users** → add every email address you plan to connect (e.g., your personal + church). Save.
4. **Create OAuth client ID.** APIs & Services → Credentials → **+ Create Credentials → OAuth client ID**.
   - Application type: **Web application**
   - Name: `mcp-gmail local`
   - **Authorized redirect URIs**: `http://localhost:3000/oauth/callback` (and any other port you'll use, e.g. `http://localhost:3030/oauth/callback`)
   - Create → copy the **Client ID** and **Client Secret** from the modal.

### Step 2 — Configure `.env`

```bash
cp .env.example .env
```

Fill in `.env`:

```env
# Server
PORT=3000
SERVER_URL=http://localhost:3000

# Google OAuth credentials (from Step 1)
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your-client-secret>

# Encryption key for stored refresh tokens — generate with:
#   openssl rand -hex 32
ENCRYPTION_KEY=<64-hex-char random string>

# Admin password gating the /setup page — generate with:
#   openssl rand -hex 16
ADMIN_PASSWORD=<32-hex-char random string>

# Data directory
DATA_DIR=./data
```

`.env` is in `.gitignore` — your secrets stay local.

**Port collision?** If `localhost:3000` is taken (run `lsof -nP -iTCP:3000 -sTCP:LISTEN` to find out), pick another port (e.g. `3030`). Update `PORT` and `SERVER_URL` in `.env` accordingly, and **add the matching redirect URI** (`http://localhost:3030/oauth/callback`) in Google Cloud Console. The `docker-compose.yml` reads `${PORT}` for both host and container ports.

### Step 3 — Start the container

```bash
docker compose up -d --build
```

Verify it's healthy:

```bash
curl http://localhost:3000/health
# → {"status":"ok","accounts":0}
```

Container logs (`docker logs mcp-gmail`) should show:

```
Gmail MCP server listening on port 3000
  MCP endpoint:  http://localhost:3000/mcp
  Setup page:    http://localhost:3000/setup
  Health check:  http://localhost:3000/health
  Accounts:      0
```

### Step 4 — Connect Gmail accounts via `/setup`

Open in your browser:

```
http://localhost:3000/setup?key=<your-ADMIN_PASSWORD>
```

You'll see an empty account table. Per account you want to connect:

1. Click **+ Add Gmail Account** → redirects to Google.
2. Sign in as the account you want to connect. Approve the consent screen.
3. Google may show **"This app isn't verified"** — click **Advanced → Go to mcp-gmail (unsafe)**. Normal for Testing-mode apps you developed yourself.
4. Browser redirects back to `/setup` with "Successfully connected <email>".

**Adding a second (different) account:** if your browser is signed into only one Google account, clicking "Add Gmail Account" again silently re-authorizes the same one. **Open `/setup` in an Incognito / Private window** to force the Google account picker, then sign in as the second account.

**Ignore the yellow `TOKENS_DATA` banner** on the setup page — that's an upstream Railway-deploy hint and doesn't apply to local Docker Compose. Your encrypted tokens live in `./data/` on the host filesystem, mounted into the container; they survive `docker compose down/up`, container rebuilds, and reboots automatically.

### Step 5 — Wire into Claude Code

```bash
claude mcp add --transport http --scope user mcp-gmail http://localhost:3000/mcp
```

Scopes:

- `--scope user` (recommended) — available across every Claude Code session on this Mac
- `--scope local` — only the current project
- `--scope project` — committed to project config, shared with collaborators (don't use unless they all run the same server)

**You must restart Claude Code** for the new MCP server to be picked up. Then `mcp__mcp-gmail__list_accounts` and the rest of the namespace become callable.

Quick sanity check from a new Claude Code session:

> "List my connected Gmail accounts."

The agent should return both addresses. Then:

> "Show me my 5 most recent unread emails in `tylerchaz5@gmail.com`."

If that works, the install is done.

---

## Care + feeding

| Need | Command |
|---|---|
| Stop the server | `docker compose -f ~/path/to/mcp-gmail/docker-compose.yml stop` |
| Start it again | `docker compose -f ~/path/to/mcp-gmail/docker-compose.yml start` |
| Restart (e.g., after `.env` edit) | `docker compose -f ~/path/to/mcp-gmail/docker-compose.yml restart` |
| Rebuild from source | `docker compose -f ~/path/to/mcp-gmail/docker-compose.yml up -d --build` |
| See logs | `docker logs mcp-gmail --tail 50` or `docker logs -f mcp-gmail` |
| Add or remove an account | Re-open the `/setup` page (admin URL) |
| Reset everything | Stop, delete `./data/`, restart — re-authorize all accounts |

Auto-start on boot is on by default (`restart: unless-stopped` in `docker-compose.yml`). The container survives Mac reboots without intervention.

**Rotating secrets:**

- **Admin password:** edit `ADMIN_PASSWORD` in `.env`, `docker compose restart`. Old setup URLs (with old key) stop working.
- **Encryption key:** changing this invalidates all stored refresh tokens — you'll have to re-authorize every account via `/setup`. Don't rotate unless you suspect compromise.
- **Google OAuth client secret:** rotate in Google Cloud Console → Credentials, update `GOOGLE_CLIENT_SECRET` in `.env`, restart. Existing refresh tokens stay valid.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Bind for 0.0.0.0:3000 failed: port is already allocated` | Another process on 3000 | Find with `lsof -nP -iTCP:3000 -sTCP:LISTEN`; either stop it, or change `PORT` in `.env` + add the matching redirect URI in GCP |
| `Connection reset by peer` on `curl http://localhost:PORT/health` | Container side port mismatch | Verify `docker-compose.yml` maps `${PORT:-3000}:${PORT:-3000}` (both sides), not `${PORT}:3000` |
| Google: "This app isn't verified" warning | App is in Testing mode (expected) | Click **Advanced → Go to mcp-gmail (unsafe)** — you're connecting your own account to your own server |
| Google: "Access blocked: mcp-gmail has not completed the Google verification process" | The account isn't in the test-users list | Add it: GCP → OAuth consent screen → Audience → Test users → Add Users |
| Only one account ever gets connected, second attempt silently replaces it | Browser only knows one Google account; OAuth flow auto-picks it | Open `/setup` in Incognito for the second account, OR sign into the second account in another tab first to surface the picker |
| `claude mcp list` doesn't show `mcp-gmail` | You added at user scope but listed at local | `claude mcp list --scope user`, or just check `~/.claude.json` |
| Tools don't appear in your current Claude Code session after `claude mcp add` | Claude Code only loads MCP config at session start | Restart Claude Code |
| Token store error / "Failed to get access token" | Refresh token expired or was revoked in Google account | Re-authorize the account via `/setup` |

---

## Why This Exists

Most AI tools ship with a Gmail integration that can only read emails from a single account. No archiving. No labeling. No unsubscribing. And if you use multiple Gmail accounts? You're out of luck.

This MCP server fixes that. One server, all your accounts, full read and write access.

## Gmail MCP Server vs Built-in Connectors

| Feature | Built-in Gmail (Claude) | Gmail MCP Server |
|---|---|---|
| Read emails | Yes | Yes |
| Write / modify emails | No | **Yes** |
| Multiple Gmail accounts | No | **Yes** |
| Archive emails | No | **Yes** |
| Apply labels | No | **Yes** |
| Auto-unsubscribe | No | **Yes** |
| Works with OpenClaw | No | **Yes** |
| Works with Cursor | No | **Yes** |
| Works with Windsurf | No | **Yes** |
| Works with Cline | No | **Yes** |
| Open source | No | **Yes** |

---

## What is an MCP Server?

[Model Context Protocol (MCP)](https://modelcontextprotocol.io) is an open standard that lets AI agents and assistants connect to external tools and data sources. An MCP server exposes tools that any compatible client can call. Think of it as a plugin system for AI.

This Gmail MCP server turns any MCP-compatible AI client into a full-featured email agent.

---

## Gmail MCP Server Features

- **Multi-account support.** Connect multiple Gmail accounts and switch between them, or query all at once.
- **Full read and write access.** Not just reading emails. Archive, label, modify, and unsubscribe.
- **Gmail search syntax.** Use Gmail's query language: `is:unread`, `from:`, `newer_than:7d`, `has:attachment`, and more.
- **Auto-unsubscribe.** Finds and triggers unsubscribe links automatically. Supports List-Unsubscribe headers, mailto links, and body link scanning.
- **Batch operations.** Fetch batches of emails for AI-powered triage and bulk actions.
- **Secure by design.** OAuth 2.0 authentication, AES-256-GCM encrypted token storage, minimal Gmail scopes.
- **Deploy anywhere.** Railway, Docker, or your own server.

---

## Available Tools

| Tool | Description |
|---|---|
| `list_accounts` | List all connected Gmail accounts |
| `list_emails` | Search and list emails using Gmail query syntax. Supports `account="all"` |
| `get_email` | Get full email content, headers, and parsed unsubscribe links |
| `archive_email` | Archive an email by removing it from the inbox |
| `apply_label` | Apply a label to an email. Creates the label if it doesn't exist |
| `unsubscribe_email` | Auto-unsubscribe from mailing lists and newsletters |
| `batch_process` | Fetch a batch of emails for triage. Supports `account="all"` |

---

## Setup Guide: Deploy in 5 Minutes

### Prerequisites

1. A [Google Cloud](https://console.cloud.google.com) project with the **Gmail API** enabled
2. OAuth 2.0 credentials (Web application type)
3. A hosting platform ([Railway](https://railway.app), your own server, or Docker)

### Step 1: Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create a new project
2. Enable the **Gmail API** (APIs & Services → Library → search "Gmail API" → Enable)
3. Configure the **OAuth consent screen**:
   - User type: External
   - Add scopes: `gmail.readonly`, `gmail.modify`
   - Add your Gmail addresses as test users
4. Create **OAuth credentials**:
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: Web application
   - Authorized redirect URI: `https://your-server-url/oauth/callback`
   - Save the **Client ID** and **Client Secret**

### Step 2: Deploy

#### Option A: Deploy to Railway (Recommended)

1. Click the Deploy button above, or create a new project on [Railway](https://railway.app) connected to this repo
2. Add these environment variables:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | Your OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | Your OAuth Client Secret |
| `ENCRYPTION_KEY` | Any random string (32+ characters) |
| `ADMIN_PASSWORD` | Password for the setup page |
| `SERVER_URL` | Your Railway app URL (e.g., `https://your-app.railway.app`) |
| `PORT` | `3000` |

3. Generate a domain in Railway (Service → Settings → Networking → Generate Domain)
4. Update `SERVER_URL` with the generated domain
5. Update the **Authorized redirect URI** in Google Cloud Console to `https://your-domain.railway.app/oauth/callback`

#### Option B: Self-Host

```bash
git clone https://github.com/navbuildz/gmail-mcp-server.git
cd gmail-mcp-server
npm install
cp .env.example .env
# Edit .env with your values
npm run build
npm start
```

#### Option C: Docker

```bash
docker build -t gmail-mcp-server .
docker run -p 3000:3000 \
  -e GOOGLE_CLIENT_ID=your-client-id \
  -e GOOGLE_CLIENT_SECRET=your-client-secret \
  -e ENCRYPTION_KEY=your-random-string \
  -e ADMIN_PASSWORD=your-password \
  -e SERVER_URL=https://your-domain.com \
  gmail-mcp-server
```

### Step 3: Connect Gmail Accounts

1. Visit `https://your-server-url/setup`
2. Enter your admin password
3. Click **+ Add Gmail Account**
4. Sign in with Google and grant permissions
5. Repeat for each Gmail account you want to connect

> **Railway users:** After adding accounts, copy the `TOKENS_DATA` value shown on the setup page and add it as an environment variable in Railway. This keeps your accounts connected across redeploys.

---

## How to Connect Gmail MCP Server to Claude

1. Go to [Claude](https://claude.ai) → Settings → Connectors
2. Click **+** → Add custom connector
3. Fill in:
   - **Name**: `Gmail` (or any name you prefer)
   - **Remote MCP server URL**: `https://your-server-url/mcp`
   - Leave OAuth fields blank
4. Click **Add**
5. Start a new conversation and try: *"List my connected Gmail accounts"*

---

## How to Connect Gmail MCP Server to Cursor

Add to your Cursor MCP settings (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "gmail": {
      "url": "https://your-server-url/mcp"
    }
  }
}
```

---

## How to Connect Gmail MCP Server to Windsurf

Add to your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "gmail": {
      "serverUrl": "https://your-server-url/mcp"
    }
  }
}
```

---

## Multi-Account Gmail Setup

Connect as many Gmail accounts as you need. Every tool accepts an `account` parameter:

- Use a specific email: `"account": "user@gmail.com"`
- Query all accounts at once: `"account": "all"`

**Example prompts you can try:**
- *"Show me unread emails from the last 2 days across all accounts"*
- *"Archive all promotional emails in user@gmail.com"*
- *"Unsubscribe from newsletters in all accounts"*
- *"Find emails with attachments from the last week in work@gmail.com"*

---

## Auto-Unsubscribe from Newsletters with AI

The `unsubscribe_email` tool handles the entire unsubscribe process:

1. Checks the `List-Unsubscribe` header (RFC 8058 one-click POST)
2. Tries HTTP unsubscribe links from the header
3. Sends an unsubscribe email via `mailto:` links
4. Scans the email body for unsubscribe URLs
5. Returns manual links if automatic unsubscribe isn't possible

Try it: *"Find newsletters from the last month and unsubscribe from all of them"*

---

## Supported MCP Clients

| Client | Status | Configuration |
|---|---|---|
| [Claude](https://claude.ai) (Web, Desktop, Code) | Supported | Custom connector → Remote MCP server URL |
| [OpenClaw](https://openclaw.com) | Supported | MCP configuration |
| [Cursor](https://cursor.com) | Supported | `.cursor/mcp.json` |
| [Windsurf](https://codeium.com/windsurf) | Supported | MCP configuration |
| [Cline](https://github.com/cline/cline) | Supported | MCP settings |
| [Continue](https://continue.dev) | Supported | MCP configuration |
| Any MCP-compatible client | Supported | Point to the `/mcp` endpoint |

---

## Architecture

```
AI Agent / Assistant (Claude, OpenClaw, Cursor, Windsurf, Cline)
  ↓ MCP Protocol (Streamable HTTP)
Gmail MCP Server (Railway / Self-hosted / Docker)
  ├── /mcp             MCP endpoint (tools)
  ├── /setup           Admin page (add/remove accounts)
  ├── /oauth/callback  Google OAuth callback
  └── Token Store      Encrypted refresh tokens
        ↓
Gmail API (per-account OAuth tokens)
```

---

## Security

- **OAuth 2.0** for authentication with Google
- **AES-256-GCM** encrypted refresh token storage
- **Minimal scopes** using only `gmail.readonly` and `gmail.modify`
- **No passwords stored.** Your Gmail password never touches the server
- **Password-protected setup.** The `/setup` page requires admin authentication
- **Revocable anytime** from [Google Account Permissions](https://myaccount.google.com/permissions)

---

## Gmail Search Query Examples

The `list_emails` and `batch_process` tools accept Gmail's full search syntax:

| Query | What it finds |
|---|---|
| `is:unread` | Unread emails |
| `is:unread newer_than:2d` | Unread emails from the last 2 days |
| `from:user@example.com` | Emails from a specific sender |
| `subject:invoice` | Emails with "invoice" in the subject |
| `has:attachment` | Emails with attachments |
| `category:promotions` | Promotional emails |
| `newer_than:7d` | Emails from the last week |
| `after:2025/01/01 before:2025/02/01` | Emails in a date range |
| `label:important is:unread` | Unread important emails |
| `larger:5M` | Emails larger than 5MB |

---

## Contributing

Want to help make this better? Here are some open ideas:

- [ ] Add `send_email` tool for composing and sending emails
- [ ] Add `reply_to_email` tool
- [ ] Add email attachment download support
- [ ] Add `delete_email` tool
- [ ] Add `mark_as_read` / `mark_as_unread` tools
- [ ] Add `remove_label` tool
- [ ] Add support for Google Workspace accounts

PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## Tech Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript
- **MCP SDK**: [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **Gmail API**: [googleapis](https://github.com/googleapis/google-api-nodejs-client)
- **HTTP**: Express 5
- **Auth**: Google OAuth 2.0

---

## License

[MIT](LICENSE)

---

If this project is useful to you, give it a star. It helps others find it.
