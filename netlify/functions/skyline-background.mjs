// UZ PROJECTS — Skyline fon funksiyasi (15 daqiqagacha ishlaydi).
import * as core from '../lib/core.mjs';
import { skyStep } from '../lib/skyline.mjs';

export default async () => {
  const store = await core.netlifyStore();
  const ctx = { store, env: process.env, fetch: (...a) => fetch(...a), now: () => Date.now() };
  const r = await skyStep(ctx, { budgetMs: 13 * 60 * 1000 });
  await core.saveStatus(ctx, { skyBackground: { at: ctx.now(), ...r } });
  console.log('skyline-background', JSON.stringify(r));
};
