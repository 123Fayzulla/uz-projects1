// UZ PROJECTS — Regional Skyline (v2).
// Har yurishda: 1) yangi izohlar, 2) har hudud top-5 izohlari like’i yangilanadi,
// 3) izohlarning bir qismi (ROT_PAGES) navbat bilan qayta o‘qiladi.
// Chaqiruvlar soni MAX_CALLS bilan cheklanadi (Instagram so‘rov limiti uchun).
import { REGIONS, REGION_IDS, matchRegions } from './regions.mjs';
import { KEYS, loadSky, igFetch, igUrl, getIgToken, igFindMedia, AppError, skyExcluded } from './core.mjs';

const MAX_CALLS = 1000;  // bir yurishda umumiy so‘rovlar (imkon qadar ko‘p)   // bir yurishda umumiy so‘rovlar chegarasi
const NEW_PAGES = 10;     // yangi izohlar uchun eng ko‘pi bilan sahifalar
const ROT_PAGES = 40;    // navbatdagi qayta o‘qish: 40 sahifa = 2 000 izoh
const TOP_PER_REGION = 5;

async function fetchPage(ctx, mediaId, next) {
  let j;
  if (next) j = await igFetch(ctx, next);
  else {
    const tk = await getIgToken(ctx);
    if (!tk) throw new AppError('IG_NOT_CONNECTED', 'Instagram ulanmagan.', 503);
    j = await igFetch(ctx, igUrl(ctx, tk.mode, `${mediaId}/comments`,
      { fields: 'id,text,timestamp,like_count,username', limit: 50 }, tk.token));
  }
  const items = (j.data || []).map((c) => ({
    id: c.id, text: c.text || '', like: Number(c.like_count || 0), author: c.username || '—', at: c.timestamp || null,
  }));
  return { items, next: j.paging?.next || null };
}

async function fetchOne(ctx, commentId) {
  const tk = await getIgToken(ctx);
  const j = await igFetch(ctx, igUrl(ctx, tk.mode, commentId,
    { fields: 'id,text,timestamp,like_count,username' }, tk.token));
  return { text: j.text, like: Number(j.like_count || 0), author: j.username || '—', at: j.timestamp || null };
}

export async function skyStep(ctx, { budgetMs = 13 * 60 * 1000 } = {}) {
  const deadline = ctx.now() + budgetMs;
  const sky = await loadSky(ctx);
  if (!sky.active) return { skipped: 'inactive' };
  if (!(await getIgToken(ctx))) return { skipped: 'no-token' };

  let calls = 0;
  let added = 0, refreshed = 0, rotated = 0, removed = 0;
  const errors = [];
  let vidLimit = MAX_CALLS;
  const canCall = () => calls < MAX_CALLS && ctx.now() < deadline;
  const vcan = () => calls < vidLimit && canCall();
  // Har bir videoga teng ulush; boshlang‘ich video har yurishda almashadi (navbat)
  const igVids = sky.videos.filter((v) => v.platform === 'ig');
  const share = Math.max(20, Math.floor(MAX_CALLS / Math.max(1, igVids.length)));
  const startAt = (sky.rr || 0) % Math.max(1, igVids.length);
  const order = [...igVids.slice(startAt), ...igVids.slice(0, startAt)];
  sky.rr = (startAt + 1) % Math.max(1, igVids.length);
  const upsert = (key, c, vid) => {
    if (skyExcluded({ a: c.author })) return 'skip';
    const cur = sky.comments[key];
    if (!cur) {
      sky.comments[key] = { r: matchRegions(c.text), t: c.text.slice(0, 200), l: c.like, a: c.author, at: c.at, vid };
      return 'added';
    }
    cur.l = c.like; cur.a = c.author; cur.t = c.text.slice(0, 200); cur.r = matchRegions(c.text);
    return 'updated';
  };

  // 1) Har bir video: yangi izohlar va navbatdagi qayta o‘qish
  // 1-o‘tish: har bir videoga teng ulush. 2-o‘tish: qolgan barcha so‘rovlar ishlatiladi.
  for (const pass of [1, 2]) for (const v of order) {
    if (!canCall()) break;
    vidLimit = pass === 1 ? calls + share : MAX_CALLS;
    try {
      if (v.platform !== 'ig') continue; // Skyline — faqat Instagram
      if (!v.mediaId) { calls++; v.mediaId = (await igFindMedia(ctx, v.extId)).mediaId; }

      if (!v.backfillDone) {
        // Tarixiy izohlar: bo‘laklab, qayerda to‘xtasa shu yerdan davom etadi
        let token = v.cursor || null;
        while (vcan()) {
          const p = await fetchPage(ctx, v.mediaId, token); calls++;
          for (const c of p.items) if (!sky.comments[`ig:${c.id}`]) { upsert(`ig:${c.id}`, c, v.id); added++; }
          token = p.next;
          if (!token) { v.backfillDone = true; v.cursor = null; break; }
          v.cursor = token;
        }
        continue;
      }

      // Yangi izohlar: eng oxirgi sahifalardan, yangi topilmasa to‘xtaydi
      let token = null;
      for (let i = 0; i < NEW_PAGES && vcan(); i++) {
        const p = await fetchPage(ctx, v.mediaId, token); calls++;
        let fresh = 0;
        for (const c of p.items) {
          if (sky.comments[`ig:${c.id}`]) continue;
          upsert(`ig:${c.id}`, c, v.id); fresh++; added++;
        }
        token = p.next;
        if (!token || fresh === 0) break;
      }

      // Navbatdagi qayta o‘qish (like va matn yangilanadi)
      let rot = v.rotNext || null;
      for (let i = 0; i < ROT_PAGES && vcan(); i++) {
        const p = await fetchPage(ctx, v.mediaId, rot); calls++;
        for (const c of p.items) {
          if (sky.comments[`ig:${c.id}`]) { upsert(`ig:${c.id}`, c, v.id); rotated++; }
          else { upsert(`ig:${c.id}`, c, v.id); added++; }
        }
        rot = p.next;
        if (!rot) break;
      }
      v.rotNext = rot || null;
      v.error = null;
      v.lastScan = ctx.now();
    } catch (e) {
      v.error = e.message;
      errors.push(`${v.day}-kun: ${e.message}`);
      if (e.code === 'IG_RATE' || e.code === 'IG_TOKEN') break;
    }
  }

  // 2) Har hudud uchun eng yuqori like olgan izohlar — like’ini alohida yangilash
  
  const keys = new Set();
  for (const reg of REGION_IDS) {
    Object.entries(sky.comments)
      .filter(([, c]) => (c.r || []).includes(reg))
      .sort((a, b) => (b[1].l || 0) - (a[1].l || 0))
      .slice(0, TOP_PER_REGION)
      .forEach(([k]) => keys.add(k));
  }
  for (const k of keys) {
    if (!canCall()) break;
    const id = k.slice(3);
    try {
      const c = await fetchOne(ctx, id); calls++;
      upsert(k, c, sky.comments[k].vid); refreshed++;
    } catch (e) {
      // Izoh o‘chirilgan yoki yashirilgan bo‘lsa — hisobdan chiqaramiz, xato emas
      if (e.code === 'NOT_FOUND') { delete sky.comments[k]; removed = (removed || 0) + 1; continue; }
      errors.push(`izoh ${id}: ${e.message}`);
      if (e.code === 'IG_RATE' || e.code === 'IG_TOKEN') break;
    }
  }

  // O‘zimizning izohlar Skyline’dan chiqariladi
  for (const k of Object.keys(sky.comments)) if (skyExcluded(sky.comments[k])) delete sky.comments[k];
  const at = ctx.now();
  sky.lastSync = at;
  sky.lastResult = { at, processed: sky.videos.length, meters: added, newComments: added, refreshed, rotated, removed, calls, failed: errors.length, errors, partial: calls >= MAX_CALLS };
  sky.history = [{ at, type: 'scan', text: `Yangilash: +${added} yangi, ${refreshed} top izoh yangilandi, ${rotated} izoh qayta o‘qildi` }, ...(sky.history || [])].slice(0, 300);
  await ctx.store.set(KEYS.sky, sky);
  return sky.lastResult;
}
