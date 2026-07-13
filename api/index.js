const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const crypto = require('crypto');

const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_KEY         = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY        = process.env.ANTHROPIC_API_KEY;
const TP_CHANNEL           = process.env.TP_CHANNEL_ID;
const ADMIN_EMAIL          = 'joshua@cuddly.com';
const ADMIN_SLACK_ID       = 'U06L2KNL17W';

const RETRIGGER_EMOJI  = 'arrows_counterclockwise';
const APPROVE_EMOJI    = 'white_check_mark';   // ✅ good draft — :white_check_mark:
const EDIT_EMOJI       = 'pencil2';            // ✏️ I edited before sending — :pencil2:
const REJECT_EMOJI     = 'thumbsdown';         // 👎 wrong macro/tone — :thumbsdown:

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

let tpUsedResponses = [];
let cachedMacros = [];
let macroLoadedAt = null;

// ── SLACK API ─────────────────────────────────────────────────────────
async function slackPost(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function getUserInfo(userId) {
  try {
    const res = await slackPost('users.info', { user: userId });
    const email = res.user?.profile?.email || null;
    const isAdmin = userId === ADMIN_SLACK_ID || email === ADMIN_EMAIL;
    return { email, isAdmin };
  } catch (e) {
    // Fallback — check Slack ID directly even if email lookup fails
    return { email: null, isAdmin: userId === ADMIN_SLACK_ID };
  }
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
    const { data } = await sb.from('style_preferences')
      .select('preference_text')
      .eq('side', 'trustpilot')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(10);
    return data ? data.map(r => r.preference_text) : [];
  } catch (e) { console.error('getStyleProfile error:', e.message); }
  return [];
}

async function saveStylePreference(userId, side, source, preferenceText, approvedBy = null) {
  try {
    await sb.from('style_preferences').insert({
      user_id: userId, side, source,
      preference_text: preferenceText,
      status: 'active',
      created_at: new Date().toISOString(),
      approved_by: approvedBy
    });
  } catch (e) { console.error('saveStylePreference error:', e.message); }
}

async function getOverridePatterns() {
  try {
    const { data } = await sb.from('override_patterns').select('*').eq('side', 'trustpilot').order('created_at', { ascending: false }).limit(8);
    return data || [];
  } catch (e) { return []; }
}

// ── PARSE REVIEW ──────────────────────────────────────────────────────
function extractMessageText(msg) {
  if (msg.text && msg.text.trim().length > 10) return msg.text;
  if (msg.attachments && msg.attachments.length > 0) {
    const parts = [];
    for (const att of msg.attachments) {
      if (att.fallback) parts.push(att.fallback);
      if (att.text) parts.push(att.text);
      if (att.pretext) parts.push(att.pretext);
      if (att.title) parts.push(att.title);
      if (att.fields) for (const f of att.fields) { if (f.value) parts.push(f.value); }
    }
    if (parts.length > 0) return parts.join(' ');
  }
  if (msg.blocks && msg.blocks.length > 0) {
    const parts = [];
    for (const block of msg.blocks) {
      if (block.text?.text) parts.push(block.text.text);
      if (block.fields) for (const f of block.fields) { if (f.text) parts.push(f.text); }
    }
    if (parts.length > 0) return parts.join(' ');
  }
  return msg.text || '';
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
    await sb.from('bot_sessions').upsert({
      slack_message_ts: ts, slack_channel: channel,
      review_text: reviewText.substring(0, 500), stars, tone,
      macro_used: macroTitle, draft_posted: draft.substring(0, 1000),
      created_at: new Date().toISOString()
    }, { onConflict: 'slack_message_ts' });
  } catch (e) { console.error('Session log error:', e.message); }
}

// ── ML: FIND DRAFT MESSAGE IN THREAD ─────────────────────────────────
async function findBotDraftInThread(channelId, threadTs) {
  try {
    const result = await slackPost('conversations.replies', {
      channel: channelId, ts: threadTs, limit: 20
    });
    if (!result.ok) return null;
    // Find the most recent bot draft message
    const drafts = result.messages?.filter(m =>
      m.bot_profile?.name?.toLowerCase().includes('cuddly') &&
      m.text?.includes('CUDDLY Response Draft')
    );
    return drafts?.[drafts.length - 1] || null;
  } catch (e) { return null; }
}

// ── ML: GET SESSION FOR MESSAGE ───────────────────────────────────────
async function getSession(messageTs) {
  try {
    const { data } = await sb.from('bot_sessions').select('*').eq('slack_message_ts', messageTs).single();
    return data || null;
  } catch (e) { return null; }
}

// ── ML: SAVE POSITIVE SIGNAL ──────────────────────────────────────────
async function savePositiveSignal(userEmail, isAdmin, session, draft) {
  try {
    // Extract style pattern via AI
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 200, messages: [{ role: 'user', content: `This Trustpilot response was approved as good:\n"${draft}"\n\nIn one concise sentence describe the writing style and tone. Start with "Prefers:"` }] })
    });
    const data = await res.json();
    const pattern = data.content?.[0]?.text || `Prefers: "${draft.substring(0, 200)}..."`;

    if (isAdmin) {
      // Admin signals go directly to style_preferences as their own row
      await saveStylePreference(null, 'trustpilot', 'slack', pattern, 'admin');
      console.log(`✅ Admin positive signal saved to style_preferences`);
    } else {
      // Non-admin goes to pending_edits
      await sb.from('pending_edits').insert({
        user_email: userEmail, side: 'trustpilot', source: 'slack',
        original_draft: draft.substring(0, 1000),
        suggested_edit: draft.substring(0, 1000),
        macro_title: session?.macro_used || '',
        review_snippet: session?.review_text?.substring(0, 200) || '',
        status: 'pending', created_at: new Date().toISOString()
      });
      console.log(`📋 Non-admin positive signal saved to pending_edits`);
    }
  } catch (e) { console.error('Positive signal error:', e.message); }
}

// ── ML: SAVE NEGATIVE SIGNAL ──────────────────────────────────────────
async function saveNegativeSignal(userEmail, isAdmin, session, draftText) {
  try {
    const macroUsed = session?.macro_used || 'unknown';
    const reviewSnippet = session?.review_text?.substring(0, 300) || '';
    const entry = {
      user_id: null, side: 'trustpilot', source: 'slack',
      email_snippet: reviewSnippet,
      ai_macro: macroUsed,
      chosen_macro: `[thumbsdown: ${macroUsed}]`,
      created_at: new Date().toISOString()
    };
    if (isAdmin) {
      await sb.from('override_patterns').insert({ ...entry, source: 'slack' });
      // Also save a human-readable negative signal to style_preferences
      await sb.from('style_preferences').insert({
        user_id: null, side: 'trustpilot', source: 'slack',
        preference_text: `Negative signal: avoid macro "${macroUsed}"${reviewSnippet ? ` for reviews like: "${reviewSnippet.substring(0, 80)}..."` : ''}`,
        status: 'active', created_at: new Date().toISOString(), approved_by: 'admin'
      });
      console.log(`✅ Admin negative signal saved to override_patterns + style_preferences`);
    } else {
      await sb.from('pending_edits').insert({
        user_email: userEmail, side: 'trustpilot', source: 'slack',
        original_draft: session?.draft_posted || draftText || '',
        suggested_edit: `[thumbsdown: wrong macro - ${macroUsed}]`,
        macro_title: macroUsed,
        review_snippet: reviewSnippet.substring(0, 200),
        status: 'pending', created_at: new Date().toISOString()
      });
      console.log(`📋 Non-admin negative signal saved to pending_edits`);
    }
  } catch (e) { console.error('Negative signal error:', e.message); }
}

// ── ML: HANDLE EDIT SIGNAL ────────────────────────────────────────────
async function handleEditSignal(client, userEmail, isAdmin, session, channelId, threadTs) {
  try {
    // Prompt user to paste their edited version in the thread
    await slackPost('chat.postMessage', {
      channel: channelId,
      thread_ts: threadTs,
      text: `✏️ <@${session?.user_id || 'there'}> — paste your edited version here and I'll learn from it! Just reply in this thread with your final response.`,
    });
    // Store a pending edit record waiting for the reply
    await sb.from('pending_edits').insert({
      user_email: userEmail, side: 'trustpilot', source: 'slack',
      original_draft: session?.draft_posted || '',
      suggested_edit: '',
      macro_title: session?.macro_used || '',
      review_snippet: session?.review_text?.substring(0, 200) || '',
      status: isAdmin ? 'awaiting_edit_admin' : 'awaiting_edit',
      created_at: new Date().toISOString()
    });
    console.log(`✏️ Edit signal — prompted user for edited version`);
  } catch (e) { console.error('Edit signal error:', e.message); }
}

// ── ML: HANDLE EDIT REPLY ─────────────────────────────────────────────
async function handleEditReply(userEmail, isAdmin, messageText, threadTs) {
  try {
    // Find the pending awaiting_edit record for this thread
    const { data: pending } = await sb.from('pending_edits')
      .select('*')
      .in('status', ['awaiting_edit_admin', 'awaiting_edit'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (!pending) return false;

    const editedDraft = messageText.trim();
    const originalDraft = pending.original_draft;

    if (isAdmin) {
      // Admin edit — extract pattern and save directly
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 200, messages: [{ role: 'user', content: `Original draft:\n"${originalDraft}"\n\nEdited version:\n"${editedDraft}"\n\nIn one concise sentence describe what changed stylistically and why. Start with "Prefers:"` }] })
      });
      const data = await res.json();
      const pattern = data.content?.[0]?.text || `Prefers: "${editedDraft.substring(0, 200)}..."`;

      // Save to style_preferences as its own row
      await saveStylePreference(null, 'trustpilot', 'slack', pattern, 'admin');

      // Log to edit_logs
      await sb.from('edit_logs').insert({
        side: 'trustpilot', source: 'slack',
        original_draft: originalDraft.substring(0, 1000),
        edited_draft: editedDraft.substring(0, 1000),
        macro_title: pending.macro_title,
        created_at: new Date().toISOString()
      });

      // Update pending record
      await sb.from('pending_edits').update({ suggested_edit: editedDraft, status: 'approved', reviewed_at: new Date().toISOString() }).eq('id', pending.id);
      console.log(`✅ Admin edit saved and learned from immediately`);
    } else {
      // Non-admin — update pending record for admin review
      await sb.from('pending_edits').update({ suggested_edit: editedDraft, status: 'pending', user_email: userEmail }).eq('id', pending.id);
      console.log(`📋 Non-admin edit saved to pending_edits for review`);
    }
    return true;
  } catch (e) { console.error('Edit reply error:', e.message); return false; }
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
  console.log(`Processing: ts=${messageTs} text="${rawText.substring(0,50)}"`);
  const hasStars = /[★✭⭐]/.test(rawText);
  const hasVerified = /verified/i.test(rawText);
  if (!hasStars && !hasVerified && rawText.length < 20) { console.log('Skipping — not TP review'); return; }
  const { stars, reviewText } = parseSlackReview(rawText);
  const [macros, styleProfile, overridePatterns, tone] = await Promise.all([getMacros(), getStyleProfile(), getOverridePatterns(), detectTone(reviewText, stars)]);
  if (!macros.length) { console.error('No macros loaded'); return; }
  const macro = selectMacro(macros, tone);
  const draft = await generateDraft(reviewText, stars, tone, macro, styleProfile, overridePatterns);
  const detectionBar = formatDetectionBar(stars, tone, macro.title);
  const postResult = await slackPost('chat.postMessage', {
    channel: channelId, thread_ts: messageTs,
    text: `*CUDDLY Response Draft* 🐾\n\n${detectionBar}\n\n---\n\n${draft}\n\n---\n_React to this draft: ✅ good  ·  ✏️ I edited this  ·  👎 wrong macro  ·  🔁 regenerate_`,
    unfurl_links: false
  });
  console.log(`Draft posted: ${postResult?.ok} error: ${postResult?.error}`);
  await logSession(messageTs, channelId, reviewText, stars, tone, macro.title, draft);
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method === 'GET') { res.status(200).send('CUDDLY Slack bot is running 🐾'); return; }

  try {
    const body = req.body || {};
    console.log(`Event: ${body.type} / ${body.event?.type}`);

    // URL verification
    if (body.type === 'url_verification') { res.status(200).json({ challenge: body.challenge }); return; }

    const event = body.event;
    if (!event) { res.status(200).end(); return; }

    // ── NEW REVIEW MESSAGE ──────────────────────────────────────────
    if (event.type === 'message' && event.channel === TP_CHANNEL) {
      console.log(`Message: subtype=${event.subtype} bot=${event.bot_profile?.name} username=${event.username} thread=${event.thread_ts} ts=${event.ts}`);
      // Only ignore OUR OWN bot's messages — allow other bots (like Trustpilot) through
      const isOwnBot = event.bot_profile?.name?.toLowerCase().includes('cuddly') ||
                        event.username?.toLowerCase().includes('cuddly');
      if (isOwnBot) {
        console.log('Skipping — own bot message');
        res.status(200).end(); return;
      }
      // Allow bot_message subtype through (Trustpilot posts this way) but skip
      // other non-review subtypes like message_changed, message_deleted, channel_join etc
      const allowedSubtypes = [undefined, 'bot_message'];
      if (!allowedSubtypes.includes(event.subtype)) {
        console.log(`Skipping — subtype not allowed: ${event.subtype}`);
        res.status(200).end(); return;
      }
      if (event.thread_ts && event.thread_ts !== event.ts) {
        // Thread reply — check if it's an edit response from a user
        try {
          const { email: userEmail, isAdmin } = await getUserInfo(event.user);
          const handled = await handleEditReply(userEmail, isAdmin, event.text || '', event.thread_ts);
          if (handled) {
            const confirmMsg = isAdmin
              ? '✅ Got it! I have learned from your edit.'
              : '📋 Got it! Your edit has been submitted for admin review.';
            await slackPost('chat.postMessage', { channel: event.channel, thread_ts: event.thread_ts, text: confirmMsg });
          }
        } catch(e) { console.error('Thread reply handler error:', e.message); }
        res.status(200).end(); return;
      }
      // Root level message — process as new review
      try {
        const eventText = extractMessageText(event);
        console.log(`New review text: "${eventText.substring(0,80)}"`);
        await processReview(event.channel, event.ts, eventText);
      } catch(e) { console.error('Process review error:', e.message); }
      res.status(200).end(); return;
    }

    // ── REACTION ADDED ──────────────────────────────────────────────
    if (event.type === 'reaction_added') {
      const emoji = event.reaction;
      console.log(`Reaction: ${emoji}`);

      // Regenerate
      if (emoji === RETRIGGER_EMOJI) {
        if (event.item?.type !== 'message') { res.status(200).end(); return; }
        const result = await slackPost('conversations.history', { channel: event.item.channel, latest: event.item.ts, limit: 1, inclusive: true });
        const msg = result.messages?.[0];
        if (!msg || msg.bot_profile?.name?.toLowerCase().includes('cuddly')) { res.status(200).end(); return; }
        await processReview(event.item.channel, event.item.ts, extractMessageText(msg));
        res.status(200).end(); return;
      }

      // ML feedback signals
      if ([APPROVE_EMOJI, EDIT_EMOJI, REJECT_EMOJI].includes(emoji)) {
        // First check — is this reaction on a bot draft message or the original review?
        // Bot drafts live in threads so we need conversations.replies, not history
        // Try replies first (for threaded draft messages), fall back to history
        let reactedMsg = null;
        let reviewTs = null;
        try {
          // Use reactions.getInfo — directly returns the message a reaction was added to
          // This is the most reliable approach regardless of thread depth or history window
          const reactionInfo = await fetch(
            `https://slack.com/api/reactions.get?channel=${event.item.channel}&timestamp=${event.item.ts}&full=true`,
            { headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` } }
          );
          const reactionData = await reactionInfo.json();
          console.log(`reactions.get: ok=${reactionData.ok} error=${reactionData.error} type=${reactionData.type}`);

          if (reactionData.ok && reactionData.message) {
            reactedMsg = reactionData.message;
            // thread_ts is the original review ts
            reviewTs = reactedMsg.thread_ts || event.item.ts;
            console.log(`Reacted msg found via reactions.get: text="${reactedMsg.text?.substring(0,60)}" thread_ts=${reviewTs}`);
          } else {
            console.log(`reactions.get failed: ${reactionData.error}`);
          }
        } catch(e) { console.error('Fetch reacted msg error:', e.message); }
        // Debug — log what we see on the reacted message
        console.log(`Reacted msg bot_profile: ${reactedMsg?.bot_profile?.name} username: ${reactedMsg?.username} text snippet: "${reactedMsg?.text?.substring(0,60)}"`);
        const isBotDraft = (
          reactedMsg?.text?.includes('CUDDLY Response Draft') ||
          reactedMsg?.text?.includes('CUDDLY Slack bot') ||
          reactedMsg?.username?.toLowerCase().includes('cuddly') ||
          reactedMsg?.bot_profile?.name?.toLowerCase().includes('cuddly')
        );
        if (!isBotDraft) {
          console.log('Reaction on non-bot message — skipping ML signal');
          res.status(200).end(); return;
        }

        const { email: userEmail, isAdmin } = await getUserInfo(event.user);
        console.log(`ML signal: ${emoji} from ${userEmail} isAdmin: ${isAdmin}`);

        // reviewTs was set during message fetch above
        reviewTs = reviewTs || reactedMsg?.thread_ts || event.item.ts;
        let session = await getSession(reviewTs);
        const draftMsg = reactedMsg;
        console.log(`Session found: ${!!session} reviewTs: ${reviewTs}`);

        if (emoji === APPROVE_EMOJI) {
          // Extract draft text — try splitting on ---, fall back to session, then full message
          let draft = draftMsg?.text?.split('---')?.[1]?.trim() || session?.draft_posted || draftMsg?.text || '';
          console.log(`Approve — draft extracted (${draft.length} chars): "${draft.substring(0,80)}"`);
          if (!draft) {
            console.error('Approve signal: no draft text found, skipping save');
          } else {
            await savePositiveSignal(userEmail, isAdmin, session, draft);
            console.log(`Positive signal saved for ${isAdmin ? 'admin' : 'non-admin'}`);
          }
          await slackPost('chat.postMessage', { channel: event.item.channel, thread_ts: reviewTs, text: isAdmin ? '✅ Great — learned from this draft!' : '📋 Thanks! Submitted for admin review.' });
        } else if (emoji === REJECT_EMOJI) {
          const draft = draftMsg?.text?.split('---')?.[1]?.trim() || session?.draft_posted || draftMsg?.text || '';
          await saveNegativeSignal(userEmail, isAdmin, session, draft);
          console.log(`Negative signal saved for ${isAdmin ? 'admin' : 'non-admin'}`);
          await slackPost('chat.postMessage', { channel: event.item.channel, thread_ts: reviewTs, text: isAdmin ? '👎 Noted — I will avoid this macro for similar reviews.' : '📋 Thanks! Submitted for admin review.' });
        } else if (emoji === EDIT_EMOJI) {
          await handleEditSignal(null, userEmail, isAdmin, session, event.item.channel, reviewTs);
        }
        res.status(200).end(); return;
      }
    }

    console.log(`Unhandled: ${event.type}`);
    res.status(200).end();

  } catch (e) {
    console.error('Handler error:', e.message);
    res.status(200).end();
  }
};
