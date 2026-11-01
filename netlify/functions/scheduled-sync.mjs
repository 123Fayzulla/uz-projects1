// UZ PROJECTS — har soat boshida avtomatik yangilash (Netlify Scheduled Function).
import * as core from '../lib/core.mjs';
import { skyStep } from '../lib/skyline.mjs';

export default async () => {
  const store = await core.netlifyStore();
  const ctx = { store, env: process.env, fetch: (...a) => fetch(...a), now: () => Date.now() };
  const started = ctx.now();
  const out = { at: started };
  try { out.instagramToken = await core.igRefreshIfNeeded(ctx); } catch (e) { out.instagramToken = { error: e.message }; }
  try { out.fs = await core.syncFs(ctx, { budgetMs: 6000 }); } catch (e) { out.fs = { error: e.message }; }
  try { out.sky = await skyStep(ctx, { budgetMs: Math.max(3000, 22000 - (ctx.now() - started)) }); } catch (e) { out.sky = { error: e.message }; }
  await core.saveStatus(ctx, { scheduled: out });
  console.log('scheduled-sync', JSON.stringify(out));
};

export const config = { schedule: '@hourly' };
