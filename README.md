# CUDDLY Trustpilot Slack Bot 🐾

Auto-drafts Trustpilot review replies in your #cs-trustpilot-reviews channel.
React with 🔁 on any review to regenerate a fresh draft.

---

## Setup Guide

> **Important:** Follow these steps in order. You need your live Vercel URL before
> Slack can verify your endpoint — so we deploy first, then finish the Slack setup.

---

### Step 1 — Create your Slack App (partial)

1. Go to **api.slack.com/apps** → click **"Create New App"**
2. Choose **"From scratch"**
3. Name it `CUDDLY Trustpilot Review Bot` and select your CUDDLY workspace
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

### Step 3 — Install App to Workspace & collect tokens

1. Go to **OAuth & Permissions** → click **"Install to Workspace"**
2. Copy the **Bot User OAuth Token** (starts with `xoxb-`) → `SLACK_BOT_TOKEN`
3. Go to **Basic Information** → copy **Signing Secret** → `SLACK_SIGNING_SECRET`
4. Go to **Basic Information** → **App-Level Tokens** → click **"Generate Token"**
   - Name it anything, add scope `connections:write`
   - Copy the token (starts with `xapp-`) → `SLACK_APP_TOKEN`

### Step 4 — Get your Supabase Service Key

1. Go to **Supabase → Project Settings → API**
2. Copy the **service_role** key (NOT the anon key)
3. That's your `SUPABASE_SERVICE_KEY`

### Step 5 — Get your Anthropic API Key

1. Go to **console.anthropic.com → API Keys**
2. Create a new key and copy it → `ANTHROPIC_API_KEY`

### Step 6 — Get your Slack Channel ID

In Slack, open **#cs-trustpilot-reviews** → right-click the channel name → **View channel details** → scroll to the very bottom to find the **Channel ID** (starts with `C`) → copy it → `TP_CHANNEL_ID`

### Step 7 — Deploy to Vercel

1. Create a new GitHub repo called `cuddly-slack-bot`
2. Upload all these files to it
3. Go to **vercel.com** → New Project → Import the repo
4. Under **Environment Variables**, add all 6 variables:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `SLACK_APP_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `ANTHROPIC_API_KEY`
   - `TP_CHANNEL_ID`
5. Click **Deploy** and copy your live Vercel URL

### Step 8 — Enable Event Subscriptions (now that you have a live URL)

1. Go back to your Slack App → **Event Subscriptions** → toggle **Enable Events** ON
2. Set the Request URL to:
   ```
   https://your-vercel-url.vercel.app/slack/events
   ```
3. Wait for the green **✅ Verified** confirmation
4. Under **Subscribe to bot events**, add:
   - `message.channels`
   - `message.groups` ← for private channels
   - `reaction_added`
5. Click **Save Changes**

### Step 9 — Invite Bot to Channel

In Slack, open **#cs-trustpilot-reviews** and type:
```
/invite @CUDDLY Trustpilot Review Bot
```

That's it — the bot is live! 🐾

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
