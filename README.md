# CUDDLY Trustpilot Slack Bot 🐾

Auto-drafts Trustpilot review replies in your #cs-trustpilot-reviews channel.
React with 🔁 on any review to regenerate a fresh draft.

---

## Setup Guide

### Step 1 — Create your Slack App

1. Go to **api.slack.com/apps** → click **"Create New App"**
2. Choose **"From scratch"**
3. Name it `CUDDLY Review Bot` and select your CUDDLY workspace
4. Click **Create App**

### Step 2 — Configure Bot Permissions

In your app dashboard, go to **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**. Add:

- `channels:history`
- `channels:read`
- `chat:write`
- `groups:history` ← needed for private channels
- `groups:read`
- `reactions:read`
- `users:read`
- `users:read.email`

### Step 3 — Enable Event Subscriptions

1. Go to **Event Subscriptions** → toggle **Enable Events** ON
2. Set the Request URL to: `https://your-vercel-url.vercel.app/slack/events`
3. Under **Subscribe to bot events**, add:
   - `message.channels`
   - `message.groups` ← for private channels
   - `reaction_added`
4. Click **Save Changes**

### Step 4 — Enable Socket Mode (for local dev only)

If testing locally:
1. Go to **Socket Mode** → Enable Socket Mode
2. Create an App-Level Token with `connections:write` scope
3. Copy the `xapp-...` token → that's your `SLACK_APP_TOKEN`

### Step 5 — Install App to Workspace

1. Go to **OAuth & Permissions** → click **"Install to Workspace"**
2. Copy the **Bot User OAuth Token** (starts with `xoxb-`) → `SLACK_BOT_TOKEN`
3. Go to **Basic Information** → copy **Signing Secret** → `SLACK_SIGNING_SECRET`

### Step 6 — Invite Bot to Channel

In Slack, open **#cs-trustpilot-reviews** and type:
```
/invite @CUDDLY Review Bot
```

Then right-click the channel → **View channel details** → scroll to bottom to find the **Channel ID** (starts with `C`) → copy it → `TP_CHANNEL_ID`

### Step 7 — Get your Supabase Service Key

1. Go to **Supabase → Project Settings → API**
2. Copy the **service_role** key (NOT the anon key)
3. That's your `SUPABASE_SERVICE_KEY`

### Step 8 — Get your Anthropic API Key

1. Go to **console.anthropic.com → API Keys**
2. Create a new key and copy it → `ANTHROPIC_API_KEY`

### Step 9 — Deploy to Vercel

1. Create a new GitHub repo called `cuddly-slack-bot`
2. Push all these files to it
3. Go to **vercel.com** → New Project → Import the repo
4. Under **Environment Variables**, add all 6 variables from `.env.example`
5. Deploy!

### Step 10 — Update Slack Event URL

Once deployed, copy your Vercel URL and update it in:
**Slack App → Event Subscriptions → Request URL**
```
https://your-vercel-url.vercel.app/slack/events
```

---

## How It Works

1. A Trustpilot review posts in **#cs-trustpilot-reviews**
2. Bot parses the star rating and review text from the Slack message format
3. AI classifies the tone (positive / negative / mixed / specific concern)
4. Best-fit macro selected from your 38-macro library (same as browser tool)
5. AI generates a fresh, varied draft using your style profile from Supabase
6. Draft posted as a thread reply with detection bar showing stars + tone + macro used
7. Anyone in the channel can copy the draft and paste into Trustpilot
8. React with 🔁 to regenerate a completely fresh draft at any time

---

## Retrigger Emoji

The bot watches for 🔁 reactions on any review message.
To change the emoji, update `RETRIGGER_EMOJI` in `api/bot.js` (line 17).

---

## Shared Learning

This bot reads from the same Supabase tables as your browser tool:
- `macros` (side = 'trustpilot')
- `style_profiles` (side = 'trustpilot')
- `override_patterns` (side = 'trustpilot')

Style edits made in the browser tool automatically improve Slack drafts too.
