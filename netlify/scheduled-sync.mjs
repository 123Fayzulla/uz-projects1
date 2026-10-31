// UZ PROJECTS — har soatda avtomatik sinxronlash (Netlify Scheduled Function).
// Faqat "published deploy"da ishlaydi; Netlify > Logs > Functions bo‘limida ko‘rinadi.
import * as core from '../lib/core.mjs';

export default async () => {
  const store = await core.netlifyStore();
  const ctx = { store, env: process.env, fetch: (...a) => fetch(...a), now: () => Date.now() };
  const out = await core.scheduledRun(ctx);
  console.log('scheduled-sync', JSON.stringify(out));
};

export const config = { schedule: '@hourly' };
