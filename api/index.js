const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const crypto = require('crypto');

const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_KEY         = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY        = process.env.ANTHROPIC_API_KEY;
const TP_CHANNEL           = process.env.TP_CHANNEL_ID;
const RETRIGGER_EMOJI      = 'repeat';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

let tpUsedResponses = [];
let cachedMacros = [];
let macroLoadedAt = null;

// ── VERIFY SLACK SIGNATURE ────────────────────────────────────────────
function verifySlackSignature(req, rawBody) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!timestamp || !signature) return false;
  // Prevent replay attacks
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const sigBase = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET);
  hmac.update(sigBase);
  const computed = `v0=${hmac.digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

// ── GET RAW BODY ──────────────────────────────────────────────────────
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── SLACK API HELPER ──────────────────────────────────────────────────
async function slackPost(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify(body)
  });
  return res.json();
}

// ── MACROS ────────────────────────────────────────────────────────────
async function getMacros() {
  if (cachedMacros.length > 0 && macroLoadedAt && Date.now() - macroLoadedAt < 600000) return cachedMacros;
  try {
    const { data, error } = await sb.from('macros').select('*').eq('side', 'trustpilot');
    if (error) throw error;
    if (data && data.length > 0) { cachedMacros = data; macroLoadedAt = Date.now(); }
  } catch (e) { console.error('Macro load error:', e.message); }
  return cachedMacros;
}

async function getStyleProfile() {
  try {
    const { data } = await sb.from('style_profiles').select('preferences').eq('side', 'trustpilot').limit(1).single();
    if (data) return JSON.parse(data.preferences || '[]');
  } catch (e) {}
  return [];
}

async function getOverridePatterns() {
  try {
    const { data } = await sb.from('override_patterns').select('*').eq('side', 'trustpilot').order('created_at', { ascending: false }).limit(8);
    return data || [];
  } catch (e) { return []; }
}

// ── PARSE REVIEW ──────────────────────────────────────────────────────
function parseSlackReview(raw) {
  const starMatch = raw.match(/[★✭⭐]+/);
  const stars = starMatch ? starMatch[0].replace(/[^★✭⭐]/g, '').length : 0;
  let reviewText = raw;
  reviewText = reviewText.replace(/[★✭⭐].*/s, '').trim();
  reviewText = reviewText.replace(/\|.*$/gm, '').trim();
  reviewText = reviewText.replace(/Added by \[.*?\]\(.*?\)/gi, '').trim();
  reviewText = reviewText.replace(/<[^>]+>/g, '').trim();
  if (!reviewText || reviewText.length < 5) reviewText = raw;
  return { stars, reviewText };
}

// ── TONE DETECTION ────────────────────────────────────────────────────
async function detectTone(reviewText, stars) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 60, messages: [{ role: 'user', content: `Classify this Trustpilot review. Stars: ${stars || 'unknown'}. Review: "${reviewText}"\n\nRespond with ONLY one word: positive, negative, mixed, concern_pricing, concern_tax, concern_email, concern_platform, concern_updates` }] })
    });
    const data = await res.json();
    return (data.content?.[0]?.text || 'positive').trim().toLowerCase().replace(/[^a-z_]/g, '');
  } catch (e) {
    return stars >= 4 ? 'positive' : stars > 0 && stars <= 2 ? 'negative' : 'mixed';
  }
}

// ── MACRO SELECTION ───────────────────────────────────────────────────
function selectMacro(macros, tone) {
  const positivePool = macros.filter(m => m.title.includes('5 Star') || m.title.includes('Thank You') || m.title.includes('Support') || m.title.includes('Community') || m.title.includes('Platform v') || m.title.includes('Warm') || m.title.includes('Rescue') || m.title.includes('Brief'));
  const concernMap = { concern_pricing: macros.find(m => m.title.includes('Platform / Mission')), concern_tax: macros.find(m => m.title.includes('Sales Tax')), concern_email: macros.find(m => m.title.includes('Unsubscribe')), concern_platform: macros.find(m => m.title.includes('Platform / Mission')), concern_updates: macros.find(m => m.title.includes('Updates')) };
  const negativePool = macros.filter(m => !m.title.includes('5 Star') && !m.title.includes('Thank You') && !m.title.includes('Support') && !m.title.includes('Community') && !m.title.includes('Warm') && !m.title.includes('Rescue') && !m.title.includes('Brief'));
  let pool;
  if (concernMap[tone]) return concernMap[tone];
  else if (tone === 'negative' || tone === 'mixed') pool = negativePool.length > 0 ? negativePool : macros;
  else pool = positivePool.length > 0 ? positivePool : macros;
  const unused = pool.filter(m => !tpUsedResponses.includes(m.title));
  const rotationPool = unused.length > 0 ? unused : pool;
  const selected = rotationPool[Math.floor(Math.random() * rotationPool.length)];
  tpUsedResponses.push(selected.title);
  if (tpUsedResponses.length > macros.length - 1) tpUsedResponses = tpUsedResponses.slice(-Math.floor(macros.length / 2));
  return selected;
}

// ── DRAFT GENERATION ──────────────────────────────────────────────────
async function generateDraft(reviewText, stars, tone, macro, styleProfile, overridePatterns) {
  const styleNote = styleProfile.length > 0 ? `\n\nStyle notes:\n${styleProfile.slice(-4).join('\n')}` : '';
  const patternNote = overridePatterns.length > 0 ? `\n\nOverride history:\n${overridePatterns.map(p => `• "${p.email_snippet?.substring(0, 60)}..." → ${p.chosen_macro}`).join('\n')}` : '';
  const prompt = `You are a Trustpilot review response writer for CUDDLY, an animal welfare platform.\n\nThe customer left this ${stars ? stars + '-star' : ''} review:\n---\n${reviewText}\n---\n\nTone: ${tone}\n\nBase response:\n---\n${macro.response}\n---\n\nKeep the same meaning and tone but rephrase naturally so it feels handwritten, not templated. Do not imply CUDDLY directly helps animals.${styleNote}${patternNote}\n\nReturn ONLY the final reply text.`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    return data.content?.[0]?.text || macro.response;
  } catch (e) { return macro.response; }
}

// ── LOG SESSION ───────────────────────────────────────────────────────
async function logSession(ts, channel, reviewText, stars, tone, macroTitle, draft) {
  try {
    await sb.from('bot_sessions').upsert({ slack_message_ts: ts, slack_channel: channel, review_text: reviewText.substring(0, 500), stars, tone, macro_used: macroTitle, draft_posted: draft.substring(0, 1000), created_at: new Date().toISOString() }, { onConflict: 'slack_message_ts' });
  } catch (e) { console.error('Session log error:', e.message); }
}

// ── DETECTION BAR ─────────────────────────────────────────────────────
function formatDetectionBar(stars, tone, macroTitle) {
  const starStr = stars > 0 ? '★'.repeat(stars) + '☆'.repeat(5 - stars) : '☆☆☆☆☆';
  const toneEmoji = { positive:'😊', negative:'😟', mixed:'😐', concern_pricing:'💰', concern_tax:'🧾', concern_email:'📧', concern_platform:'❓', concern_updates:'📋' };
  const toneLabel = { positive:'Positive', negative:'Negative', mixed:'Mixed', concern_pricing:'Pricing concern', concern_tax:'Tax concern', concern_email:'Email concern', concern_platform:'Platform concern', concern_updates:'Updates request' };
  return `${starStr}  ${toneEmoji[tone] || '💬'} ${toneLabel[tone] || tone}  ·  📎 ${macroTitle}`;
}

// ── PROCESS REVIEW ────────────────────────────────────────────────────
async function processReview(channelId, messageTs, rawText) {
  const hasStars = /[★✭⭐]/.test(rawText);
  const hasVerified = /verified/i.test(rawText);
  if (!hasStars && !hasVerified && rawText.length < 20) return;
  const { stars, reviewText } = parseSlackReview(rawText);
  const [macros, styleProfile, overridePatterns, tone] = await Promise.all([getMacros(), getStyleProfile(), getOverridePatterns(), detectTone(reviewText, stars)]);
  if (!macros.length) { console.error('No macros loaded'); return; }
  const macro = selectMacro(macros, tone);
  const draft = await generateDraft(reviewText, stars, tone, macro, styleProfile, overridePatterns);
  const detectionBar = formatDetectionBar(stars, tone, macro.title);
  await slackPost('chat.postMessage', { channel: channelId, thread_ts: messageTs, text: `*CUDDLY Response Draft* 🐾\n\n${detectionBar}\n\n---\n\n${draft}\n\n---\n_React with 🔁 to regenerate_`, unfurl_links: false });
  await logSession(messageTs, channelId, reviewText, stars, tone, macro.title, draft);
  console.log(`✅ Draft posted | tone:${tone} | macro:${macro.title}`);
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Always respond 200 immediately to prevent Slack retries
  res.status(200).end();

  if (req.method === 'GET') return;

  try {
    const rawBody = await getRawBody(req);

    // Verify signature
    if (!verifySlackSignature(req, rawBody)) {
      console.error('Invalid Slack signature');
      return;
    }

    const body = JSON.parse(rawBody);

    // URL verification challenge
    if (body.type === 'url_verification') {
      res.status(200).json({ challenge: body.challenge });
      return;
    }

    const event = body.event;
    if (!event) return;

    // New message in TP channel
    if (event.type === 'message' && event.channel === TP_CHANNEL) {
      if (event.thread_ts && event.thread_ts !== event.ts) return;
      if (event.bot_profile?.name?.toLowerCase().includes('cuddly')) return;
      await processReview(event.channel, event.ts, event.text || '');
      return;
    }

    // Reaction added — retrigger
    if (event.type === 'reaction_added' && event.reaction === RETRIGGER_EMOJI) {
      if (event.item?.type !== 'message') return;
      const result = await slackPost('conversations.history', { channel: event.item.channel, latest: event.item.ts, limit: 1, inclusive: true });
      const msg = result.messages?.[0];
      if (!msg || msg.bot_profile?.name?.toLowerCase().includes('cuddly')) return;
      await processReview(event.item.channel, event.item.ts, msg.text || '');
      return;
    }

  } catch (e) {
    console.error('Handler error:', e.message);
  }
};
