// UZ PROJECTS — server yadrosi: saqlash, YouTube/Instagram, sinxronlash, hisob-kitob.
// Ikki loyiha ma'lumotlari alohida kalitlarda saqlanadi: "fs-state" va "sky-state".

import { REGIONS, REGION_IDS, matchRegions, detectProject, parseVideoUrl, canonicalUrl } from './regions.mjs';

export const KEYS = { fs: 'fs-state', sky: 'sky-state', settings: 'settings', status: 'status' };
const TEXT_MAX = 200;
const DAY = 24 * 60 * 60 * 1000;

// ---------- Xatolar ----------
export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const E = (code, msg, status) => new AppError(code, msg, status);

// ---------- Saqlash ----------
export async function netlifyStore() {
  const { getStore } = await import('@netlify/blobs');
  const s = getStore({ name: 'uz-projects', consistency: 'strong' });
  return {
    get: (k) => s.get(k, { type: 'json' }),
    set: (k, v) => s.setJSON(k, v),
    del: (k) => s.delete(k),
  };
}
export function memoryStore(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null),
    set: async (k, v) => void m.set(k, JSON.stringify(v)),
    del: async (k) => void m.delete(k),
    _map: m,
  };
}

const emptyFs = () => ({ v: 1, videos: {}, comments: {}, corrections: {}, log: [], lastSync: null, lastResult: null });
const emptySky = () => ({ v: 1, active: false, videos: [], comments: {}, corrections: {}, history: [], lastSync: null, lastResult: null });

export async function loadFs(ctx) { return { ...emptyFs(), ...((await ctx.store.get(KEYS.fs)) || {}) }; }
export async function loadSky(ctx) { return { ...emptySky(), ...((await ctx.store.get(KEYS.sky)) || {}) }; }
async function loadSettings(ctx) { return (await ctx.store.get(KEYS.settings)) || {}; }
async function saveStatus(ctx, patch) {
  const cur = (await ctx.store.get(KEYS.status)) || {};
  await ctx.store.set(KEYS.status, { ...cur, ...patch });
}

async function withLock(ctx, name, fn) {
  const key = 'lock-' + name;
  const lock = await ctx.store.get(key);
  if (lock && ctx.now() - lock.at < 90_000) {
    throw E('BUSY', 'Sinxronlash hozir boshqa jarayonda ishlayapti. Bir daqiqadan keyin qayta urinib ko‘ring.', 409);
  }
  await ctx.store.set(key, { at: ctx.now() });
  try {
    return await fn();
  } finally {
    await ctx.store.del(key);
  }
}

// ---------- YouTube Data API v3 ----------
const YT_REASONS = {
  quotaExceeded: ['YT_QUOTA', 'YouTube API kunlik limiti tugadi. Ertaga avtomatik davom etadi.'],
  dailyLimitExceeded: ['YT_QUOTA', 'YouTube API kunlik limiti tugadi. Ertaga avtomatik davom etadi.'],
  rateLimitExceeded: ['YT_RATE', 'YouTube juda ko‘p so‘rov qabul qildi. Birozdan keyin qayta urinib ko‘ring.'],
  commentsDisabled: ['COMMENTS_DISABLED', 'Bu videoda izohlar o‘chirilgan.'],
  videoNotFound: ['NOT_FOUND', 'Video topilmadi (o‘chirilgan yoki yopiq).'],
  keyInvalid: ['YT_KEY', 'YOUTUBE_API_KEY noto‘g‘ri. Netlify sozlamalarida kalitni tekshiring.'],
  accessNotConfigured: ['YT_KEY', 'Google Cloud loyihasida YouTube Data API v3 yoqilmagan.'],
  forbidden: ['YT_FORBIDDEN', 'YouTube bu ma’lumotga ruxsat bermadi.'],
  ipRefererBlocked: ['YT_KEY', 'API kalit cheklovlari Netlify serveridan so‘rovni bloklayapti. Kalitda "Website restrictions" o‘rniga faqat "API restrictions" qo‘ying.'],
};

export async function ytGet(ctx, path, params) {
  const key = ctx.env.YOUTUBE_API_KEY;
  if (!key) throw E('YT_NO_KEY', 'YOUTUBE_API_KEY Netlify sozlamalarida topilmadi.', 503);
  const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  url.searchParams.set('key', key);
  let r;
  try {
    r = await ctx.fetch(url.toString());
  } catch {
    throw E('NETWORK', 'YouTube serveriga ulanib bo‘lmadi.', 502);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = j?.error?.errors?.[0]?.reason || (j?.error?.details?.[0]?.reason === 'API_KEY_INVALID' ? 'keyInvalid' : '');
    const [code, msg] = YT_REASONS[reason] || ['YT_ERROR', `YouTube xatosi (${r.status}).`];
    throw E(code, msg, r.status === 403 || r.status === 404 ? r.status : 502);
  }
  return j;
}

export async function ytVideos(ctx, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const j = await ytGet(ctx, 'videos', { part: 'snippet,statistics', id: ids.slice(i, i + 50).join(','), maxResults: 50 });
    for (const it of j.items || []) {
      const st = it.statistics || {};
      out[it.id] = {
        title: it.snippet?.title || '',
        caption: it.snippet?.description || '',
        publishedAt: it.snippet?.publishedAt || null,
        likes: st.likeCount != null ? Number(st.likeCount) : null,
        commentCount: st.commentCount != null ? Number(st.commentCount) : null,
      };
    }
  }
  return out;
}

/** Videoning barcha ochiq izohlari va javoblari. knownReplies: {threadId: soni} */
export async function ytComments(ctx, videoId, { knownReplies = {}, deadline = Infinity } = {}) {
  const list = [];
  let pageToken;
  let pages = 0;
  let complete = true;
  do {
    if (ctx.now() > deadline) { complete = false; break; }
    const j = await ytGet(ctx, 'commentThreads', {
      part: 'snippet,replies', videoId, maxResults: 100, textFormat: 'plainText', pageToken,
    });
    for (const th of j.items || []) {
      const top = th.snippet?.topLevelComment;
      if (!top) continue;
      list.push({ id: top.id, text: top.snippet?.textOriginal || top.snippet?.textDisplay || '', at: top.snippet?.publishedAt });
      const inc = th.replies?.comments || [];
      const total = th.snippet?.totalReplyCount || 0;
      if (total > inc.length && (knownReplies[top.id] || 0) < total && ctx.now() < deadline) {
        let rt;
        do {
          const rj = await ytGet(ctx, 'comments', { part: 'snippet', parentId: top.id, maxResults: 100, textFormat: 'plainText', pageToken: rt });
          for (const c of rj.items || []) list.push({ id: c.id, parent: top.id, text: c.snippet?.textOriginal || c.snippet?.textDisplay || '', at: c.snippet?.publishedAt });
          rt = rj.nextPageToken;
        } while (rt && ctx.now() < deadline);
      } else {
        for (const c of inc) list.push({ id: c.id, parent: top.id, text: c.snippet?.textOriginal || c.snippet?.textDisplay || '', at: c.snippet?.publishedAt });
      }
    }
    pageToken = j.nextPageToken;
    pages++;
  } while (pageToken && pages < 60);
  if (pageToken) complete = false;
  return { list, complete };
}

// ---------- Instagram API ----------
// Ikki rejim:
//  "ig" — Instagram Login tokeni (graph.instagram.com, /me/...), 60 kunlik, yangilanadi.
//  "fb" — Unified login / Facebook login tokeni (graph.facebook.com, /{ig-user-id}/...).
//         2026-oktabrdan yangi Meta ilovalari faqat shu rejimni oladi; tizim foydalanuvchisi tokeni muddatsiz.
const igVer = (ctx) => ctx.env.INSTAGRAM_API_VERSION || 'v25.0';
const IG_HOST = { ig: 'https://graph.instagram.com', fb: 'https://graph.facebook.com' };

export async function getIgToken(ctx) {
  const s = await loadSettings(ctx);
  if (s.igToken) return { token: s.igToken, source: 'app', mode: s.igMode || 'ig', igUserId: s.igUserId || null };
  if (ctx.env.INSTAGRAM_ACCESS_TOKEN) {
    const id = ctx.env.INSTAGRAM_USER_ID || null;
    return { token: ctx.env.INSTAGRAM_ACCESS_TOKEN, source: 'env', mode: id ? 'fb' : 'ig', igUserId: id };
  }
  return null;
}

export async function igFetch(ctx, url) {
  let r;
  try {
    r = await ctx.fetch(url);
  } catch {
    throw E('NETWORK', 'Instagram serveriga ulanib bo‘lmadi.', 502);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const c = j?.error?.code;
    if (c === 190) throw E('IG_TOKEN', 'Instagram tokeni eskirgan, noto‘g‘ri yoki bekor qilingan. Sozlamalar bo‘limida yangi token kiriting.', 401);
    if (c === 10 || c === 200 || (c >= 200 && c < 300)) throw E('IG_PERMISSION', 'Instagram ruxsati yetarli emas (profil/media o‘qish va izohlarni boshqarish ruxsatlari kerak).', 403);
    if ([4, 17, 32, 613].includes(c)) throw E('IG_RATE', 'Instagram so‘rovlar limiti. Birozdan keyin avtomatik davom etadi.', 429);
    if (c === 100) throw E('NOT_FOUND', 'Instagram media topilmadi yoki bu akkauntga tegishli emas.', 404);
    throw E('IG_ERROR', `Instagram xatosi${c ? ' (' + c + ')' : ''}.`, 502);
  }
  return j;
}

export function igUrl(ctx, mode, path, params, token) {
  const url = new URL(`${IG_HOST[mode]}/${igVer(ctx)}/${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  url.searchParams.set('access_token', token);
  return url.toString();
}

async function igGet(ctx, path, params = {}) {
  const tk = await getIgToken(ctx);
  if (!tk) throw E('IG_NOT_CONNECTED', 'Instagram hali ulanmagan. Sozlamalar bo‘limida tokenni kiriting.', 503);
  let p = path;
  if (tk.mode === 'fb') {
    if (!tk.igUserId) throw E('IG_NO_ACCOUNT', 'Instagram akkaunt ID saqlanmagan. Tokenni qayta ulang.', 503);
    p = path.replace(/^me(\/|$)/, tk.igUserId + '$1');
  }
  return igFetch(ctx, igUrl(ctx, tk.mode, p, params, tk.token));
}

const IG_MEDIA_FIELDS = 'id,caption,permalink,timestamp,like_count,comments_count,media_type,media_product_type';
const igInfo = (m) => ({
  mediaId: m.id,
  title: '',
  caption: m.caption || '',
  publishedAt: m.timestamp || null,
  likes: m.like_count != null ? Number(m.like_count) : null,
  commentCount: m.comments_count != null ? Number(m.comments_count) : null,
  permalink: m.permalink || null,
});

/** Havoladagi shortcode bo‘yicha ulangan akkaunt mediasini topadi. */
export async function igFindMedia(ctx, shortcode) {
  let j = await igGet(ctx, 'me/media', { fields: IG_MEDIA_FIELDS, limit: 50 });
  for (let page = 0; page < 40; page++) {
    const hit = (j.data || []).find((m) => (m.permalink || '').includes('/' + shortcode));
    if (hit) return igInfo(hit);
    const next = j.paging?.next;
    if (!next) break;
    j = await igFetch(ctx, next);
  }
  throw E('NOT_FOUND', 'Bu Instagram video ulangan akkauntda topilmadi. Havola @milliy_animatsiya akkauntiga tegishli ekanini tekshiring.', 404);
}

export async function igMedia(ctx, mediaId) {
  return igInfo(await igGet(ctx, mediaId, { fields: IG_MEDIA_FIELDS }));
}

export async function igComments(ctx, mediaId, { deadline = Infinity } = {}) {
  const list = [];
  let j = await igGet(ctx, `${mediaId}/comments`, { fields: 'id,text,timestamp,replies{id,text,timestamp}', limit: 50 });
  let complete = true;
  for (let page = 0; page < 80; page++) {
    for (const c of j.data || []) {
      list.push({ id: c.id, text: c.text || '', at: c.timestamp });
      for (const r of c.replies?.data || []) list.push({ id: r.id, parent: c.id, text: r.text || '', at: r.timestamp });
    }
    const next = j.paging?.next;
    if (!next) break;
    if (ctx.now() > deadline) { complete = false; break; }
    j = await igFetch(ctx, next);
  }
  return { list, complete };
}

/**
 * Tokenni tekshirib saqlaydi. Avval Instagram Login (graph.instagram.com), bo‘lmasa
 * Unified/Facebook login (graph.facebook.com) sinab ko‘riladi.
 * Akkaunt ID avtomatik topilmasa: "TOKEN 1784xxxxxxxxxxx" ko‘rinishida kiritish mumkin.
 */
export async function igConnect(ctx, input) {
  let raw = String(input || '').trim();
  let manualId = null;
  const parts = raw.split(/\s+/);
  if (parts.length === 2 && /^\d{5,25}$/.test(parts[1])) { raw = parts[0]; manualId = parts[1]; }
  const token = raw;
  if (token.length < 20 || /\s/.test(token)) throw E('BAD_INPUT', 'Token formati noto‘g‘ri.');
  const s = await loadSettings(ctx);
  const save = (patch) => ctx.store.set(KEYS.settings, {
    ...s, igToken: token, igTokenAt: ctx.now(), igTokenRefreshedAt: null, ...patch,
  });

  // 1) Instagram Login tokeni
  if (!manualId) {
    try {
      const me = await igFetch(ctx, igUrl(ctx, 'ig', 'me', { fields: 'user_id,username,account_type' }, token));
      await save({ igMode: 'ig', igUsername: me.username || null, igUserId: me.user_id || me.id || null });
      return { username: me.username || null, mode: 'ig' };
    } catch (e) {
      if (!(e instanceof AppError) || e.code === 'NETWORK') throw e;
    }
  }

  // 2) Unified login / Facebook login tokeni
  const fbGet = (path, params) => igFetch(ctx, igUrl(ctx, 'fb', path, params, token));
  let ids = manualId ? [manualId] : [];
  if (!ids.length) {
    try {
      const dbg = await fbGet('debug_token', { input_token: token });
      for (const sc of dbg?.data?.granular_scopes || []) {
        if (/^instagram/.test(sc.scope || '')) ids.push(...(sc.target_ids || []));
      }
    } catch { /* keyingi usul */ }
  }
  if (!ids.length) {
    try {
      const acc = await fbGet('me/accounts', { fields: 'instagram_business_account{id,username}', limit: 100 });
      for (const pg of acc.data || []) if (pg.instagram_business_account?.id) ids.push(pg.instagram_business_account.id);
    } catch { /* keyingi usul */ }
  }
  ids = [...new Set(ids.map(String))];
  if (!ids.length) {
    // Token umuman ishlaydimi — aniq xabar berish uchun
    try { await fbGet('me', { fields: 'id' }); } catch (e) { throw e; }
    throw E('IG_NO_ACCOUNT', 'Token ishlayapti, lekin Instagram akkaunt ID topilmadi. Tokendan keyin bitta bo‘sh joy qoldirib, Instagram akkaunt ID raqamini yozing (masalan: TOKEN 17841400000000000).', 400);
  }
  const found = [];
  let lastErr = null;
  for (const id of ids.slice(0, 10)) {
    try { found.push(await fbGet(id, { fields: 'id,username' })); } catch (e) { lastErr = e; }
  }
  if (!found.length) throw lastErr || E('IG_ERROR', 'Instagram akkauntini tekshirib bo‘lmadi.', 502);
  const pick = found.find((f) => f.username === 'milliy_animatsiya') || found[0];
  await save({ igMode: 'fb', igUserId: String(pick.id), igUsername: pick.username || null });
  return { username: pick.username || null, mode: 'fb' };
}

export async function igDisconnect(ctx) {
  const s = await loadSettings(ctx);
  for (const k of ['igToken', 'igUsername', 'igUserId', 'igTokenAt', 'igMode', 'igTokenRefreshedAt', 'igTokenExpiresIn']) delete s[k];
  await ctx.store.set(KEYS.settings, s);
}

/** Instagram Login tokenini yangilaydi (60 kun). Unified login tokeni muddatsiz — yangilanmaydi. */
export async function igRefreshIfNeeded(ctx, { force = false } = {}) {
  const tk = await getIgToken(ctx);
  if (!tk) return { skipped: 'no-token' };
  if (tk.mode === 'fb') return { skipped: 'non-expiring' };
  const s = await loadSettings(ctx);
  if (!force && s.igTokenRefreshedAt && ctx.now() - s.igTokenRefreshedAt < 7 * DAY) return { skipped: 'fresh' };
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', tk.token);
  const j = await igFetch(ctx, url.toString());
  if (!j.access_token) throw E('IG_ERROR', 'Instagram tokenni yangilab bo‘lmadi.', 502);
  if (tk.source === 'app') await ctx.store.set(KEYS.settings, { ...s, igToken: j.access_token, igTokenRefreshedAt: ctx.now(), igTokenExpiresIn: j.expires_in || null });
  else await ctx.store.set(KEYS.settings, { ...s, igToken: j.access_token, igMode: 'ig', igTokenRefreshedAt: ctx.now(), igTokenExpiresIn: j.expires_in || null });
  return { refreshed: true };
}

// ---------- Video ma'lumoti va tasnif ----------
export async function fetchVideoInfo(ctx, platform, extId, mediaId) {
  if (platform === 'yt') {
    const map = await ytVideos(ctx, [extId]);
    if (!map[extId]) throw E('NOT_FOUND', 'YouTube video topilmadi (o‘chirilgan, yopiq yoki havola noto‘g‘ri).', 404);
    return map[extId];
  }
  return mediaId ? igMedia(ctx, mediaId) : igFindMedia(ctx, extId);
}

export async function classify(ctx, url) {
  const p = parseVideoUrl(url);
  if (!p) throw E('BAD_URL', 'Havola tanilmadi. YouTube yoki Instagram video havolasini kiriting.');
  const res = {
    platform: p.platform, extId: p.extId, url: canonicalUrl(p.platform, p.extId),
    info: null, infoError: null, project: null, lang: null, regions: [], slot: null,
    confident: false, reasons: [], duplicates: [],
  };
  try {
    res.info = await fetchVideoInfo(ctx, p.platform, p.extId);
  } catch (e) {
    res.infoError = e.message;
    res.reasons.push('Video ma’lumotini olib bo‘lmadi — hudud va tilni qo‘lda tanlang.');
  }
  if (res.info) {
    const text = `${res.info.title || ''}\n${res.info.caption || ''}`;
    const d = detectProject(text);
    res.project = d.isForgottenSpirits ? 'fs' : null;
    res.lang = d.lang;
    res.regions = matchRegions(text);
    if (!d.isForgottenSpirits) res.reasons.push('Tavsifda "Unutilgan Ruhlar" yoki "Forgotten Spirits" nomi topilmadi.');
    if (d.markers.uz && d.markers.en) res.reasons.push('Tavsifda ikkala nom ham bor — tilni tasdiqlang.');
    if (!res.regions.length) res.reasons.push('Tavsifda hudud nomi topilmadi.');
    if (res.regions.length > 1) res.reasons.push('Tavsifda bir nechta hudud bor — to‘g‘risini tanlang.');
    if (res.project === 'fs' && res.lang && res.regions.length === 1) {
      res.slot = slotKey(res.regions[0], p.platform, res.lang);
      res.confident = true;
    }
  }
  const fs = await loadFs(ctx);
  for (const v of Object.values(fs.videos)) if (v.platform === p.platform && v.extId === p.extId) res.duplicates.push({ project: 'fs', slot: v.slot });
  const sky = await loadSky(ctx);
  for (const v of sky.videos) if (v.platform === p.platform && v.extId === p.extId) res.duplicates.push({ project: 'sky', id: v.id });
  if (res.duplicates.length) res.reasons.push('Bu video allaqachon qo‘shilgan.');
  return res;
}

// ---------- Unutilgan Ruhlar ----------
export const slotKey = (region, platform, lang) => `${region}|${platform}|${lang}`;
export function parseSlot(slot) {
  const [region, platform, lang] = String(slot || '').split('|');
  if (!REGION_IDS.includes(region) || !['yt', 'ig'].includes(platform) || !['uz', 'en'].includes(lang)) return null;
  return { region, platform, lang };
}
const vkey = (platform, extId) => `${platform}:${extId}`;

function logPush(state, entry, max = 200) {
  state.log = [entry, ...(state.log || [])].slice(0, max);
}

export async function fsSaveVideo(ctx, { slot, url, replace }) {
  const s = parseSlot(slot);
  if (!s) throw E('BAD_INPUT', 'Hudud, platforma yoki til noto‘g‘ri.');
  const p = parseVideoUrl(url);
  if (!p) throw E('BAD_URL', 'Havola tanilmadi.');
  if (p.platform !== s.platform) throw E('BAD_INPUT', `Bu havola ${p.platform === 'yt' ? 'YouTube' : 'Instagram'} uchun, lekin tanlangan joy ${s.platform === 'yt' ? 'YouTube' : 'Instagram'}.`);
  const sky = await loadSky(ctx);
  if (sky.videos.some((v) => v.platform === p.platform && v.extId === p.extId)) throw E('CONFLICT', 'Bu video Skyline loyihasida turibdi. Loyihalar aralashmasligi uchun avval u yerdan o‘chiring.', 409);
  const fs = await loadFs(ctx);
  const other = Object.values(fs.videos).find((v) => v.extId === p.extId && v.platform === p.platform && v.slot !== slot);
  if (other) throw E('CONFLICT', 'Bu video boshqa joyga qo‘shilgan. Avval o‘sha joydan o‘chiring.', 409);
  const cur = fs.videos[slot];
  if (cur && cur.extId !== p.extId && !replace) throw E('NEEDS_CONFIRM', 'Bu joyda boshqa video bor. Almashtirishni tasdiqlang.', 409);
  if (cur && cur.extId !== p.extId) removeFsComments(fs, cur);
  fs.videos[slot] = {
    slot, ...s, url: canonicalUrl(p.platform, p.extId), extId: p.extId,
    mediaId: cur?.extId === p.extId ? cur.mediaId : null,
    title: cur?.extId === p.extId ? cur.title : '', likes: cur?.extId === p.extId ? cur.likes : null,
    commentCount: null, manualLikes: cur?.extId === p.extId ? cur.manualLikes ?? null : null,
    publishedAt: null, lastSync: null, error: null, addedAt: ctx.now(),
  };
  logPush(fs, { at: ctx.now(), type: 'video', text: `${slot} ← ${p.extId}` });
  await ctx.store.set(KEYS.fs, fs);
  return fs.videos[slot];
}

function removeFsComments(fs, video) {
  const prefix = vkey(video.platform, video.extId);
  let n = 0;
  for (const [k, c] of Object.entries(fs.comments)) if (c.x === prefix) { delete fs.comments[k]; n++; }
  return n;
}

export async function fsRemoveVideo(ctx, slot) {
  const fs = await loadFs(ctx);
  const v = fs.videos[slot];
  if (!v) throw E('NOT_FOUND', 'Bu joyda video yo‘q.', 404);
  const removed = removeFsComments(fs, v);
  delete fs.videos[slot];
  logPush(fs, { at: ctx.now(), type: 'remove', text: `${slot} o‘chirildi (${removed} izoh)` });
  await ctx.store.set(KEYS.fs, fs);
  return { removedComments: removed };
}

export async function fsSetManualLikes(ctx, slot, likes) {
  const fs = await loadFs(ctx);
  const v = fs.videos[slot];
  if (!v) throw E('NOT_FOUND', 'Bu joyda video yo‘q.', 404);
  v.manualLikes = likes === null || likes === '' ? null : toInt(likes, 0, 1e9);
  logPush(fs, { at: ctx.now(), type: 'manual', text: `${slot}: qo‘lda like = ${v.manualLikes ?? 'o‘chirildi'}` });
  await ctx.store.set(KEYS.fs, fs);
}

export async function fsSetCorrection(ctx, region, mentions) {
  if (!REGION_IDS.includes(region)) throw E('BAD_INPUT', 'Hudud noto‘g‘ri.');
  const fs = await loadFs(ctx);
  fs.corrections[region] = { mentions: toInt(mentions, -1e7, 1e7) };
  logPush(fs, { at: ctx.now(), type: 'correction', text: `${region}: eslatma tuzatish = ${fs.corrections[region].mentions}` });
  await ctx.store.set(KEYS.fs, fs);
}

function toInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) throw E('BAD_INPUT', 'Son noto‘g‘ri.');
  return n;
}

/** Izohlarni qo‘shadi. Har bir izoh ID bo‘yicha faqat bir marta saqlanadi. */
function ingest(commentsMap, platform, list, extra) {
  let added = 0;
  let mentions = 0;
  for (const c of list) {
    const key = `${platform}:${c.id}`;
    if (commentsMap[key]) continue;
    const r = matchRegions(c.text);
    commentsMap[key] = { r, t: String(c.text || '').slice(0, TEXT_MAX), at: c.at || null, ...(c.parent ? { p: c.parent } : {}), ...extra };
    added++;
    mentions += r.length;
  }
  return { added, mentions };
}

function knownRepliesFor(commentsMap, prefix) {
  const out = {};
  for (const c of Object.values(commentsMap)) if (c.x === prefix && c.p) out[c.p] = (out[c.p] || 0) + 1;
  return out;
}

/** Unutilgan Ruhlar: like va izohlarni yangilash. */
export async function syncFs(ctx, { budgetMs = 8500, only = null } = {}) {
  return withLock(ctx, 'fs', async () => {
    const deadline = ctx.now() + budgetMs;
    const fs = await loadFs(ctx);
    let vids = Object.values(fs.videos);
    if (only) vids = vids.filter((v) => only.includes(v.slot));
    vids.sort((a, b) => (a.lastSync || 0) - (b.lastSync || 0));
    const result = { at: ctx.now(), total: vids.length, updated: 0, failed: 0, skipped: 0, newComments: 0, newMentions: 0, partial: false, errors: [] };
    const upd = {};
    const newComments = {};

    // 1) YouTube statistikasi (bitta so‘rovda 50 tagacha)
    const yt = vids.filter((v) => v.platform === 'yt');
    let ytMap = {};
    let ytErr = null;
    if (yt.length) {
      try { ytMap = await ytVideos(ctx, yt.map((v) => v.extId)); } catch (e) { ytErr = e; }
    }
    const igTk = vids.some((v) => v.platform === 'ig') ? await getIgToken(ctx) : null;

    for (const v of vids) {
      if (ctx.now() > deadline) { result.partial = true; break; }
      const u = { error: null };
      try {
        let info;
        if (v.platform === 'yt') {
          if (ytErr) throw ytErr;
          info = ytMap[v.extId];
          if (!info) throw E('NOT_FOUND', 'Video topilmadi (o‘chirilgan yoki yopiq).', 404);
        } else {
          if (!igTk) throw E('IG_NOT_CONNECTED', 'Instagram ulanmagan — like qo‘lda kiritilgan qiymatdan olinadi.', 503);
          info = v.mediaId ? await igMedia(ctx, v.mediaId) : await igFindMedia(ctx, v.extId);
          u.mediaId = info.mediaId;
        }
        Object.assign(u, { title: info.title, likes: info.likes, commentCount: info.commentCount, publishedAt: info.publishedAt });

        const prefix = vkey(v.platform, v.extId);
        let got;
        try {
          got = v.platform === 'yt'
            ? await ytComments(ctx, v.extId, { knownReplies: knownRepliesFor(fs.comments, prefix), deadline })
            : await igComments(ctx, u.mediaId, { deadline });
        } catch (e) {
          if (e.code !== 'COMMENTS_DISABLED') throw e;
          got = { list: [], complete: true };
          u.note = e.message;
        }
        const merged = { ...fs.comments, ...newComments };
        const before = Object.keys(newComments).length;
        const tmp = {};
        for (const c of got.list) if (!merged[`${v.platform}:${c.id}`]) tmp[`${v.platform}:${c.id}`] = c;
        const r = ingest(newComments, v.platform, Object.values(tmp), { x: prefix });
        result.newComments += Object.keys(newComments).length - before;
        result.newMentions += r.mentions;
        if (!got.complete) result.partial = true;
        u.lastSync = ctx.now();
        result.updated++;
      } catch (e) {
        u.error = e.message;
        u.lastSync = ctx.now();
        if (e.code === 'IG_NOT_CONNECTED') result.skipped++;
        else { result.failed++; result.errors.push(`${v.slot}: ${e.message}`); }
        if (['YT_QUOTA', 'YT_KEY', 'YT_NO_KEY'].includes(e.code) && !result.errors.includes(e.message)) result.errors.unshift(e.message);
      }
      upd[v.slot] = { url: v.url, patch: u };
    }

    // Saqlashdan oldin eng so‘nggi holatni o‘qib, birlashtiramiz (parallel tahrirlar yo‘qolmasligi uchun)
    const fresh = await loadFs(ctx);
    for (const [slot, { url, patch }] of Object.entries(upd)) {
      if (fresh.videos[slot]?.url === url) Object.assign(fresh.videos[slot], patch);
    }
    const liveX = new Set(Object.values(fresh.videos).map((v) => vkey(v.platform, v.extId)));
    for (const [k, c] of Object.entries(newComments)) if (!fresh.comments[k] && liveX.has(c.x)) fresh.comments[k] = c;
    fresh.lastSync = ctx.now();
    fresh.lastResult = result;
    await ctx.store.set(KEYS.fs, fresh);
    return result;
  });
}

export function fsSummary(fs, { includeComments = false } = {}) {
  const mentions = Object.fromEntries(REGION_IDS.map((id) => [id, 0]));
  for (const c of Object.values(fs.comments)) for (const r of c.r || []) if (r in mentions) mentions[r]++;
  const regions = REGIONS.map((reg) => {
    const slots = {};
    let likes = 0;
    for (const platform of ['ig', 'yt']) for (const lang of ['uz', 'en']) {
      const v = fs.videos[slotKey(reg.id, platform, lang)];
      if (v) {
        const eff = v.likes ?? v.manualLikes ?? 0;
        likes += eff;
        slots[`${platform}|${lang}`] = {
          url: v.url, extId: v.extId, title: v.title, likes: v.likes, manualLikes: v.manualLikes, effectiveLikes: eff,
          likesSource: v.likes != null ? 'api' : v.manualLikes != null ? 'manual' : 'none',
          commentCount: v.commentCount, lastSync: v.lastSync, error: v.error, note: v.note || null, publishedAt: v.publishedAt,
        };
      }
    }
    const corr = fs.corrections[reg.id]?.mentions || 0;
    return { id: reg.id, name: reg.name, en: reg.en, likes, mentionsCounted: mentions[reg.id], mentionCorrection: corr, mentions: mentions[reg.id] + corr, slots };
  });
  const out = {
    regions,
    totals: {
      likes: regions.reduce((a, r) => a + r.likes, 0),
      mentions: regions.reduce((a, r) => a + r.mentions, 0),
      videos: Object.keys(fs.videos).length,
      slots: 56,
      comments: Object.keys(fs.comments).length,
    },
    lastSync: fs.lastSync, lastResult: fs.lastResult, log: (fs.log || []).slice(0, 30),
  };
  if (includeComments) out.comments = fs.comments;
  return out;
}

export function fsCommentsFor(fs, region, limit = 60) {
  return Object.entries(fs.comments)
    .filter(([, c]) => (c.r || []).includes(region))
    .sort((a, b) => String(b[1].at || '').localeCompare(String(a[1].at || '')))
    .slice(0, limit)
    .map(([k, c]) => ({ id: k, text: c.t, at: c.at, regions: c.r, video: c.x }));
}

// ---------- Regional Skyline ----------
export async function skySetActive(ctx, active) {
  const sky = await loadSky(ctx);
  sky.active = !!active;
  sky.history = [{ at: ctx.now(), type: 'active', text: active ? 'Loyiha ishga tushirildi' : 'Loyiha to‘xtatildi' }, ...sky.history].slice(0, 300);
  await ctx.store.set(KEYS.sky, sky);
}

export async function skyAddVideo(ctx, { url, day }) {
  const p = parseVideoUrl(url);
  if (!p) throw E('BAD_URL', 'Havola tanilmadi.');
  const fs = await loadFs(ctx);
  if (Object.values(fs.videos).some((v) => v.platform === p.platform && v.extId === p.extId)) throw E('CONFLICT', 'Bu video "Unutilgan Ruhlar" loyihasiga qo‘shilgan. Loyihalar aralashmasligi uchun bu yerga qo‘shib bo‘lmaydi.', 409);
  const sky = await loadSky(ctx);
  if (sky.videos.some((v) => v.platform === p.platform && v.extId === p.extId)) throw E('CONFLICT', 'Bu video Skyline’da allaqachon bor.', 409);
  const maxDay = sky.videos.reduce((m, v) => Math.max(m, v.day), 0);
  const d = day == null || day === '' ? maxDay + 1 : toInt(day, 1, 10000);
  if (sky.videos.some((v) => v.day === d)) throw E('CONFLICT', `${d}-kun uchun video allaqachon bor.`, 409);
  let info = null;
  let infoError = null;
  try { info = await fetchVideoInfo(ctx, p.platform, p.extId); } catch (e) { infoError = e.message; }
  const v = {
    id: `${p.platform}-${p.extId}`, day: d, platform: p.platform, extId: p.extId, url: canonicalUrl(p.platform, p.extId),
    mediaId: info?.mediaId || null, title: info?.title || '', caption: (info?.caption || '').slice(0, 300),
    publishedAt: info?.publishedAt || null, addedAt: ctx.now(), status: 'waiting', processedAt: null,
    counted: 0, added: {}, error: infoError,
  };
  sky.videos.push(v);
  sky.videos.sort((a, b) => a.day - b.day);
  sky.history = [{ at: ctx.now(), type: 'video', text: `${d}-kun videosi qo‘shildi` }, ...sky.history].slice(0, 300);
  await ctx.store.set(KEYS.sky, sky);
  return v;
}

export async function skyEditVideo(ctx, id, { day }) {
  const sky = await loadSky(ctx);
  const v = sky.videos.find((x) => x.id === id);
  if (!v) throw E('NOT_FOUND', 'Video topilmadi.', 404);
  const d = toInt(day, 1, 10000);
  if (sky.videos.some((x) => x.day === d && x.id !== id)) throw E('CONFLICT', `${d}-kun band.`, 409);
  v.day = d;
  sky.videos.sort((a, b) => a.day - b.day);
  await ctx.store.set(KEYS.sky, sky);
}

export async function skyRemoveVideo(ctx, id) {
  const sky = await loadSky(ctx);
  const v = sky.videos.find((x) => x.id === id);
  if (!v) throw E('NOT_FOUND', 'Video topilmadi.', 404);
  let n = 0;
  for (const [k, c] of Object.entries(sky.comments)) if (c.vid === id) { delete sky.comments[k]; n++; }
  sky.videos = sky.videos.filter((x) => x.id !== id);
  sky.history = [{ at: ctx.now(), type: 'remove', text: `${v.day}-kun videosi o‘chirildi (${n} izoh balandlikdan ayirildi)` }, ...sky.history].slice(0, 300);
  await ctx.store.set(KEYS.sky, sky);
  return { removedComments: n };
}

export async function skySetCorrection(ctx, region, meters) {
  if (region === 'toshkent') region = 'toshkent_v';
  if (!REGION_IDS.includes(region)) throw E('BAD_INPUT', 'Hudud noto‘g‘ri.');
  const sky = await loadSky(ctx);
  sky.corrections[region] = toInt(meters, -1e7, 1e7);
  sky.history = [{ at: ctx.now(), type: 'correction', text: `${region}: tuzatish = ${sky.corrections[region]} m` }, ...sky.history].slice(0, 300);
  await ctx.store.set(KEYS.sky, sky);
}

/** Video "hisoblashga tayyor": undan keyingi kun videosi bor yoki chiqqaniga 24 soat bo‘lgan. */
export function skyIsDue(sky, v, now) {
  if (v.status === 'processed') return false;
  const later = sky.videos.some((x) => x.day > v.day);
  const t = Date.parse(v.publishedAt || '') || v.addedAt;
  return later || now - t >= DAY;
}

async function processOne(ctx, sky, v, deadline) {
  let info = null;
  if (v.platform === 'ig' && !v.mediaId) { info = await igFindMedia(ctx, v.extId); v.mediaId = info.mediaId; }
  let got;
  try {
    got = v.platform === 'yt'
      ? await ytComments(ctx, v.extId, { knownReplies: {}, deadline })
      : await igComments(ctx, v.mediaId, { deadline });
  } catch (e) {
    if (e.code !== 'COMMENTS_DISABLED') throw e;
    got = { list: [], complete: true };
  }
  if (!got.complete) throw E('PARTIAL', 'Izohlar to‘liq yuklanmadi (vaqt yetmadi). Qayta bosing.', 504);
  const before = {};
  const fresh = {};
  ingest(fresh, v.platform, got.list.filter((c) => !sky.comments[`${v.platform}:${c.id}`]), { vid: v.id });
  for (const c of Object.values(fresh)) for (const r of c.r) before[r] = (before[r] || 0) + 1;
  Object.assign(sky.comments, fresh);
  const n = Object.keys(fresh).length;
  v.counted = (v.counted || 0) + n;
  for (const [r, m] of Object.entries(before)) v.added[r] = (v.added[r] || 0) + m;
  v.status = 'processed';
  v.processedAt = ctx.now();
  v.error = null;
  const meters = Object.values(before).reduce((a, b) => a + b, 0);
  sky.history = [{ at: ctx.now(), type: 'process', day: v.day, text: `${v.day}-kun videosi hisoblandi: ${n} ta yangi izoh, +${meters} m`, added: before }, ...sky.history].slice(0, 300);
  return { newComments: n, meters };
}

/** Skyline: tayyor videolarni hisoblash. id berilsa — faqat o‘sha video (force=true bo‘lsa qayta tekshiradi, eski izohlar qayta sanalmaydi). */
export async function syncSky(ctx, { budgetMs = 8500, id = null, force = false } = {}) {
  return withLock(ctx, 'sky', async () => {
    const deadline = ctx.now() + budgetMs;
    const sky = await loadSky(ctx);
    const result = { at: ctx.now(), processed: 0, failed: 0, newComments: 0, meters: 0, errors: [], waiting: 0 };
    let targets;
    if (id) {
      const v = sky.videos.find((x) => x.id === id);
      if (!v) throw E('NOT_FOUND', 'Video topilmadi.', 404);
      if (v.status === 'processed' && !force) throw E('NEEDS_CONFIRM', 'Bu video allaqachon hisoblangan.', 409);
      targets = [v];
    } else {
      if (!sky.active) return { ...result, skipped: 'inactive' };
      targets = sky.videos.filter((v) => skyIsDue(sky, v, ctx.now()));
      result.waiting = sky.videos.filter((v) => v.status !== 'processed').length - targets.length;
    }
    for (const v of targets) {
      if (ctx.now() > deadline) break;
      try {
        const r = await processOne(ctx, sky, v, deadline);
        result.processed++;
        result.newComments += r.newComments;
        result.meters += r.meters;
      } catch (e) {
        v.error = e.message;
        result.failed++;
        result.errors.push(`${v.day}-kun: ${e.message}`);
      }
    }
    const fresh = await loadSky(ctx);
    for (const v of targets) {
      const f = fresh.videos.find((x) => x.id === v.id);
      if (!f) continue;
      Object.assign(f, { status: v.status, processedAt: v.processedAt, counted: v.counted, added: v.added, error: v.error, mediaId: v.mediaId });
      for (const [k, c] of Object.entries(sky.comments)) if (c.vid === v.id && !fresh.comments[k]) fresh.comments[k] = c;
    }
    const newHist = sky.history.filter((h) => h.at >= result.at);
    fresh.history = [...newHist, ...fresh.history].slice(0, 300);
    fresh.lastSync = ctx.now();
    fresh.lastResult = result;
    await ctx.store.set(KEYS.sky, fresh);
    return result;
  });
}

// Skyline uchun: Toshkent viloyati va Toshkent shahri bitta "Toshkent" hududi sifatida sanaladi.
// Bu faqat Skyline’ga tegishli; Unutilgan Ruhlar hisobi o‘zgarmaydi.
export const skyKey = (r) => (r === 'toshkent_v' || r === 'toshkent_sh' ? 'toshkent' : r);
export const skyCommentKeys = (c) => [...new Set((c.r || []).map(skyKey))];
export const SKY_REGIONS = (() => {
  const out = []; const seen = new Set();
  for (const r of REGIONS) {
    const id = skyKey(r.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: id === 'toshkent' ? 'Toshkent' : r.name });
  }
  return out;
})();

export function skySummary(sky, now) {
  const m = {};
  for (const c of Object.values(sky.comments)) for (const k of skyCommentKeys(c)) m[k] = (m[k] || 0) + 1;
  const corr = (k) => (k === 'toshkent'
    ? (sky.corrections.toshkent_v || 0) + (sky.corrections.toshkent_sh || 0)
    : (sky.corrections[k] || 0));
  const regions = SKY_REGIONS.map((r) => ({
    id: r.id, name: r.name, fromComments: m[r.id] || 0, correction: corr(r.id),
    meters: (m[r.id] || 0) + corr(r.id),
  }));
  return {
    active: !!sky.active,
    regions,
    videos: sky.videos.map((v) => ({ ...v, due: skyIsDue(sky, v, now) })),
    history: sky.history.slice(0, 60),
    totals: { meters: regions.reduce((a, r) => a + r.meters, 0), comments: Object.keys(sky.comments).length, videos: sky.videos.length },
    lastSync: sky.lastSync, lastResult: sky.lastResult,
    owners: skyOwners(sky),
  };
}

// ---------- Umumiy holat ----------
export async function fullState(ctx) {
  const [fs, sky, settings, status] = await Promise.all([loadFs(ctx), loadSky(ctx), loadSettings(ctx), ctx.store.get(KEYS.status)]);
  return {
    regions: REGIONS,
    fs: fsSummary(fs),
    sky: skySummary(sky, ctx.now()),
    integrations: {
      youtube: { configured: !!ctx.env.YOUTUBE_API_KEY },
      instagram: {
        connected: !!(settings.igToken || ctx.env.INSTAGRAM_ACCESS_TOKEN),
        source: settings.igToken ? 'app' : ctx.env.INSTAGRAM_ACCESS_TOKEN ? 'env' : null,
        username: settings.igUsername || null,
        tokenAt: settings.igTokenAt || null,
        refreshedAt: settings.igTokenRefreshedAt || null,
        mode: settings.igToken ? settings.igMode || 'ig' : ctx.env.INSTAGRAM_USER_ID ? 'fb' : ctx.env.INSTAGRAM_ACCESS_TOKEN ? 'ig' : null,
      },
      admin: { configured: !!ctx.env.ADMIN_PASSWORD },
    },
    status: status || {},
    serverTime: ctx.now(),
  };
}

/** Rejali (har soatlik) ish. */
export async function scheduledRun(ctx) {
  const out = { at: ctx.now() };
  try { out.instagramToken = await igRefreshIfNeeded(ctx); } catch (e) { out.instagramToken = { error: e.message }; }
  try { out.fs = await syncFs(ctx, { budgetMs: 17000 }); } catch (e) { out.fs = { error: e.message }; }
  try { out.sky = await syncSky(ctx, { budgetMs: Math.max(3000, 26000 - (ctx.now() - out.at)) }); } catch (e) { out.sky = { error: e.message }; }
  await saveStatus(ctx, { scheduled: out });
  return out;
}

export { saveStatus };

/** Har bir Skyline hududi uchun bitta egasi: shu hudud haqidagi eng ko‘p like olgan izoh muallifi. */
export function skyOwners(sky) {
  const best = {};
  for (const c of Object.values(sky.comments || {})) {
    for (const r of skyCommentKeys(c)) {
      const cur = best[r];
      const better = !cur || (c.l || 0) > cur.likes || ((c.l || 0) === cur.likes && String(c.at) < String(cur.at));
      if (better) best[r] = { name: c.a || '—', likes: c.l || 0, text: c.t, at: c.at, video: c.vid };
    }
  }
  return SKY_REGIONS.map((r) => ({ id: r.id, name: r.name, owner: best[r.id] || null }));
}
