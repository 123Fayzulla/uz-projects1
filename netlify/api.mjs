// UZ PROJECTS — asosiy API (Netlify Functions v2). Barcha kalitlar faqat serverda.
import crypto from 'node:crypto';
import * as core from '../lib/core.mjs';

export function makeCtx(store, env = process.env) {
  return { store, env, fetch: (...a) => fetch(...a), now: () => Date.now() };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function isAdmin(req, env) {
  const pass = env.ADMIN_PASSWORD;
  const got = req.headers.get('x-admin-key') || '';
  if (!pass) return false;
  const a = crypto.createHash('sha256').update(String(pass)).digest();
  const b = crypto.createHash('sha256').update(got).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function route(req, ctx) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)/, '') || '/';
  const method = req.method.toUpperCase();
  const body = method === 'POST' ? await req.json().catch(() => ({})) : {};

  // --- Ochiq (faqat o‘qish) ---
  if (method === 'GET' && path === '/state') return json(await core.fullState(ctx));
  if (method === 'GET' && path === '/fs/comments') {
    const fs = await core.loadFs(ctx);
    return json({ comments: core.fsCommentsFor(fs, url.searchParams.get('region')) });
  }

  if (method !== 'POST') return json({ error: 'Topilmadi', code: 'NOT_FOUND' }, 404);

  // --- Admin (yozish) ---
  if (!ctx.env.ADMIN_PASSWORD) return json({ error: 'ADMIN_PASSWORD Netlify sozlamalarida o‘rnatilmagan. Usiz ma’lumotni o‘zgartirib bo‘lmaydi.', code: 'NO_ADMIN' }, 503);
  if (!isAdmin(req, ctx.env)) return json({ error: 'Parol noto‘g‘ri. Sozlamalar bo‘limida parolni kiriting.', code: 'UNAUTHORIZED' }, 401);

  switch (path) {
    case '/login': return json({ ok: true });
    case '/classify': return json(await core.classify(ctx, body.url));
    case '/fs/video': return json({ video: await core.fsSaveVideo(ctx, body), sync: await safe(() => core.syncFs(ctx, { only: [body.slot], budgetMs: 7000 })) });
    case '/fs/video/remove': return json(await core.fsRemoveVideo(ctx, body.slot));
    case '/fs/manual-likes': await core.fsSetManualLikes(ctx, body.slot, body.likes); return json({ ok: true });
    case '/fs/correction': await core.fsSetCorrection(ctx, body.region, body.mentions); return json({ ok: true });
    case '/fs/sync': return json(await core.syncFs(ctx, { budgetMs: 8500 }));
    case '/sky/active': await core.skySetActive(ctx, body.active); return json({ ok: true });
    case '/sky/video': return json({ video: await core.skyAddVideo(ctx, body) });
    case '/sky/video/edit': await core.skyEditVideo(ctx, body.id, body); return json({ ok: true });
    case '/sky/video/remove': return json(await core.skyRemoveVideo(ctx, body.id));
    case '/sky/process': return json(await core.syncSky(ctx, { id: body.id, force: !!body.force, budgetMs: 8500 }));
    case '/sky/sync': return json(await core.syncSky(ctx, { budgetMs: 8500 }));
    case '/sky/correction': await core.skySetCorrection(ctx, body.region, body.meters); return json({ ok: true });
    case '/instagram/connect': return json(await core.igConnect(ctx, body.token));
    case '/instagram/disconnect': await core.igDisconnect(ctx); return json({ ok: true });
    case '/instagram/refresh': return json(await core.igRefreshIfNeeded(ctx, { force: true }));
    default: return json({ error: 'Topilmadi', code: 'NOT_FOUND' }, 404);
  }
}

async function safe(fn) {
  try { return await fn(); } catch (e) { return { error: e.message, code: e.code }; }
}

export async function handle(req, ctx) {
  try {
    return await route(req, ctx);
  } catch (e) {
    if (e instanceof core.AppError) return json({ error: e.message, code: e.code }, e.status || 400);
    console.error(e);
    return json({ error: 'Serverda kutilmagan xato. Keyinroq qayta urinib ko‘ring.', code: 'SERVER' }, 500);
  }
}

export default async (req) => {
  let store;
  try {
    store = await core.netlifyStore();
  } catch (e) {
    console.error(e);
    return json({ error: 'Ma’lumotlar bazasiga (Netlify Blobs) ulanib bo‘lmadi.', code: 'STORE' }, 500);
  }
  return handle(req, makeCtx(store));
};

export const config = { path: ['/api/*'] };
