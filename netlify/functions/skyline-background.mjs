// UZ PROJECTS — Skyline fon funksiyasi (15 daqiqagacha ishlaydi).
import * as core from '../lib/core.mjs';
import { skyStep } from '../lib/skyline.mjs';

export default async (req) => {
  let mode = 'all';
  try { const b = await req.json(); if (b && b.mode) mode = b.mode; } catch {}
  const store = await core.netlifyStore();
  const ctx = { store, env: process.env, fetch: (...a) => fetch(...a), now: () => Date.now() };
  const r = await skyStep(ctx, { budgetMs: 13 * 60 * 1000, mode });
  await core.saveStatus(ctx, { skyBackground: { at: ctx.now(), ...r } });
  console.log('skyline-background', JSON.stringify(r));
};
