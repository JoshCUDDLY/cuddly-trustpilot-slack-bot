const { App, ExpressReceiver } = require('@slack/bolt');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_KEY         = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY        = process.env.ANTHROPIC_API_KEY;
const TP_CHANNEL           = process.env.TP_CHANNEL_ID;
const RETRIGGER_EMOJI      = 'repeat';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

const app = new App({ token: SLACK_BOT_TOKEN, receiver });

let tpUsedResponses = [];
let cachedMacros = [];
let macroLoadedAt = null;

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

async function logSession(ts, channel, reviewText, stars, tone, macroTitle, draft) {
  try {
    await sb.from('bot_sessions').upsert({ slack_message_ts: ts, slack_channel: channel, review_text: reviewText.substring(0, 500), stars, tone, macro_used: macroTitle, draft_posted: draft.substring(0, 1000), created_at: new Date().toISOString() }, { onConflict: 'slack_message_ts' });
  } catch (e) { console.error('Session log error:', e.message); }
}

function formatDetectionBar(stars, tone, macroTitle) {
  const starStr = stars > 0 ? '★'.repeat(stars) + '☆'.repeat(5 - stars) : '☆☆☆☆☆';
  const toneEmoji = { positive:'😊', negative:'😟', mixed:'😐', concern_pricing:'💰', concern_tax:'🧾', concern_email:'📧', concern_platform:'❓', concern_updates:'📋' };
  const toneLabel = { positive:'Positive', negative:'Negative', mixed:'Mixed', concern_pricing:'Pricing concern', concern_tax:'Tax concern', concern_email:'Email concern', concern_platform:'Platform concern', concern_updates:'Updates request' };
  return `${starStr}  ${toneEmoji[tone] || '💬'} ${toneLabel[tone] || tone}  ·  📎 ${macroTitle}`;
}

async function processReview(client, channelId, messageTs, rawText) {
  const hasStars = /[★✭⭐]/.test(rawText);
  const hasVerified = /verified/i.test(rawText);
  if (!hasStars && !hasVerified && rawText.length < 20) return;
  const { stars, reviewText } = parseSlackReview(rawText);
  const [macros, styleProfile, overridePatterns, tone] = await Promise.all([getMacros(), getStyleProfile(), getOverridePatterns(), detectTone(reviewText, stars)]);
  if (!macros.length) { console.error('No macros loaded'); return; }
  const macro = selectMacro(macros, tone);
  const draft = await generateDraft(reviewText, stars, tone, macro, styleProfile, overridePatterns);
  const detectionBar = formatDetectionBar(stars, tone, macro.title);
  await client.chat.postMessage({ channel: channelId, thread_ts: messageTs, text: `*CUDDLY Response Draft* 🐾\n\n${detectionBar}\n\n---\n\n${draft}\n\n---\n_React with 🔁 to regenerate_`, unfurl_links: false });
  await logSession(messageTs, channelId, reviewText, stars, tone, macro.title, draft);
  console.log(`✅ Draft posted | tone:${tone} | macro:${macro.title}`);
}

app.message(async ({ message, client }) => {
  try {
    if (message.channel !== TP_CHANNEL) return;
    if (message.bot_id) return;
    if (message.thread_ts && message.thread_ts !== message.ts) return;
    await processReview(client, message.channel, message.ts, message.text || '');
  } catch (e) { console.error('Message handler error:', e.message); }
});

app.event('reaction_added', async ({ event, client }) => {
  try {
    if (event.reaction !== RETRIGGER_EMOJI) return;
    if (event.item.type !== 'message') return;
    const result = await client.conversations.history({ channel: event.item.channel, latest: event.item.ts, limit: 1, inclusive: true });
    const originalMsg = result.messages?.[0];
    if (!originalMsg || originalMsg.bot_id) return;
    await processReview(client, event.item.channel, event.item.ts, originalMsg.text || '');
  } catch (e) { console.error('Reaction handler error:', e.message); }
});

// ── EXPORT HANDLER FOR VERCEL ─────────────────────────────────────────
module.exports = async (req, res) => {
  // Handle Slack URL verification challenge
  if (req.body && req.body.type === 'url_verification') {
    res.status(200).json({ challenge: req.body.challenge });
    return;
  }
  // Hand off to Bolt receiver
  await receiver.app(req, res);
};
