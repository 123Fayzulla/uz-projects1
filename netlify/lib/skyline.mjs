// UZ PROJECTS — Regional Skyline: soatlik, bo‘laklab o‘qiydigan hisoblash.
// Har bir yurishda har bir video uchun cheklangan vaqt ichida izohlar o‘qiladi.
// Tarixiy izohlar (backfill) bir necha soat davomida to‘liq yig‘iladi, keyin faqat yangilari olinadi.
import { matchRegions } from './regions.mjs';
import { KEYS, loadSky, ytGet, igFetch, igUrl, getIgToken, igFindMedia, AppError } from './core.mjs';

async function fetchYtPage(ctx, videoId, pageToken) {
  const j = await ytGet(ctx, 'commentThreads', {
    part: 'snippet', videoId, maxResults: 100, order: 'time', textFormat: 'plainText', pageToken,
  });
  const items = (j.items || []).map((th) => {
    const c = th.snippet?.topLevelComment;
    if (!c) return null;
    const s = c.snippet || {};
    return {
      id: c.id,
      text: s.textOriginal || s.textDisplay || '',
      like: Number(s.likeCount || 0),
      author: s.authorDisplayName || '—',
      at: s.publishedAt || null,
    };
  }).filter(Boolean);
  return { items, next: j.nextPageToken || null };
}

async function fetchIgPage(ctx, mediaId, next) {
  let j;
  if (next) {
    j = await igFetch(ctx, next);
  } else {
    const tk = await getIgToken(ctx);
    if (!tk) throw new AppError('IG_NOT_CONNECTED', 'Instagram ulanmagan.', 503);
    j = await igFetch(ctx, igUrl(ctx, tk.mode, `${mediaId}/comments`,
      { fields: 'id,text,timestamp,like_count,username', limit: 50 }, tk.token));
  }
  const items = (j.data || []).map((c) => ({
    id: c.id,
    text: c.text || '',
    like: Number(c.like_count || 0),
    author: c.username || '—',
    at: c.timestamp || null,
  }));
  return { items, next: j.paging?.next || null };
}

/**
 * Bir yurish. budgetMs ichida barcha Skyline videolarini tekshiradi.
 * Yangi izohlar sky.comments ga qo‘shiladi (ID bo‘yicha takrorlanmaydi).
 */
export async function skyStep(ctx, { budgetMs = 18000 } = {}) {
  const deadline = ctx.now() + budgetMs;
  const sky0 = await loadSky(ctx);
  if (!sky0.active) return { skipped: 'inactive' };

  const newC = {};
  const updates = {};
  const errors = [];
  let scanned = 0;
  let videosDone = 0;
  let partial = false;

  for (const v of sky0.videos) {
    if (ctx.now() > deadline) { partial = true; break; }
    try {
      if (v.platform === 'ig' && !v.mediaId) v.mediaId = (await igFindMedia(ctx, v.extId)).mediaId;
      const backfilling = !v.backfillDone;
      let token = backfilling ? (v.cursor || null) : null;
      let finished = false;
      let pages = 0;
      while (ctx.now() < deadline && pages < 80) {
        const page = v.platform === 'yt'
          ? await fetchYtPage(ctx, v.extId, token)
          : await fetchIgPage(ctx, v.mediaId, token);
        pages++;
        let fresh = 0;
        for (const c of page.items) {
          const key = `${v.platform}:${c.id}`;
          if (sky0.comments[key] || newC[key]) continue;
          newC[key] = { r: matchRegions(c.text), t: c.text.slice(0, 200), l: c.like, a: c.author, at: c.at, vid: v.id };
          fresh++;
        }
        scanned += page.items.length;
        token = page.next;
        if (!token) { finished = true; break; }
        // Tarix to‘liq yig‘ilgach: yangi izoh chiqmagan sahifada to‘xtaymiz
        if (!backfilling && fresh === 0) { finished = true; break; }
      }
      updates[v.id] = {
        backfillDone: backfilling ? finished : true,
        cursor: backfilling && !finished ? token : null,
        mediaId: v.mediaId || null,
        error: null,
        note: null,
        lastScan: ctx.now(),
      };
      if (finished || !backfilling) videosDone++;
    } catch (e) {
      if (e.code === 'COMMENTS_DISABLED') {
        updates[v.id] = { backfillDone: true, cursor: null, error: null, note: e.message, lastScan: ctx.now() };
      } else {
        updates[v.id] = { error: e.message, lastScan: ctx.now() };
        errors.push(`${v.day}-kun: ${e.message}`);
      }
    }
  }

  // Saqlashdan oldin eng so‘nggi holatni o‘qib, birlashtiramiz
  const fresh = await loadSky(ctx);
  for (const [id, u] of Object.entries(updates)) {
    const f = fresh.videos.find((x) => x.id === id);
    if (f) Object.assign(f, u);
  }
  const liveIds = new Set(fresh.videos.map((x) => x.id));
  let added = 0;
  for (const [k, c] of Object.entries(newC)) {
    if (!fresh.comments[k] && liveIds.has(c.vid)) { fresh.comments[k] = c; added++; }
  }
  const at = ctx.now();
  fresh.lastSync = at;
  fresh.lastResult = { at, processed: videosDone, meters: added, newComments: added, scanned, failed: errors.length, errors, partial };
  if (added) {
    fresh.history = [{ at, type: 'scan', text: `Yangilash: ${added} ta yangi izoh o‘qildi` }, ...fresh.history].slice(0, 300);
  }
  await ctx.store.set(KEYS.sky, fresh);
  return fresh.lastResult;
}
