// UZ PROJECTS — hududlar, matnni normallashtirish, hudud nomlarini topish, URL tahlili.
// Bu fayl tashqi kutubxonalarsiz ishlaydi (testlash oson).

export const REGIONS = [
  { id: 'qoraqalpogiston', name: 'Qoraqalpog‘iston', en: 'Karakalpakstan' },
  { id: 'andijon', name: 'Andijon', en: 'Andijan' },
  { id: 'buxoro', name: 'Buxoro', en: 'Bukhara' },
  { id: 'fargona', name: 'Farg‘ona', en: 'Fergana' },
  { id: 'jizzax', name: 'Jizzax', en: 'Jizzakh' },
  { id: 'xorazm', name: 'Xorazm', en: 'Khorezm' },
  { id: 'namangan', name: 'Namangan', en: 'Namangan' },
  { id: 'navoiy', name: 'Navoiy', en: 'Navoi' },
  { id: 'qashqadaryo', name: 'Qashqadaryo', en: 'Kashkadarya' },
  { id: 'samarqand', name: 'Samarqand', en: 'Samarkand' },
  { id: 'sirdaryo', name: 'Sirdaryo', en: 'Syrdarya' },
  { id: 'surxondaryo', name: 'Surxondaryo', en: 'Surkhandarya' },
  { id: 'toshkent_v', name: 'Toshkent viloyati', en: 'Tashkent Region' },
  { id: 'toshkent_sh', name: 'Toshkent shahri', en: 'Tashkent City' },
];
export const REGION_IDS = REGIONS.map((r) => r.id);

// Normallashtirilgan matndagi (lotin, kichik harf, apostrofsiz) qidiruv o‘zaklari.
// Qo‘shimchalar ("Samarqandga", "Buxoroliklar") va heshteglar ham topiladi.
const STEMS = {
  qoraqalpogiston: ['qoraqalpo', 'qoraqolpo', 'qaraqalpa', 'karakalpa'],
  andijon: ['andijon', 'andijan', 'andizhan'],
  buxoro: ['buxoro', 'bukhara', 'bukhoro', 'buxara', 'buhara', 'buhoro'],
  fargona: ['fargona', 'fargana', 'fergana', 'ferghana', 'fargona'],
  jizzax: ['jizzax', 'jizzakh', 'jizzah', 'jizzak', 'jizax', 'jizak', 'djizak', 'dzhizak'],
  xorazm: ['xorazm', 'xorezm', 'khorazm', 'khorezm', 'horazm', 'horezm', 'khwarazm', 'khwarezm'],
  namangan: ['namangan'],
  navoiy: ['navoiy', 'navoi', 'navoy'],
  qashqadaryo: ['qashqadar', 'qashkadar', 'kashkadar', 'qashqadarya'],
  samarqand: ['samarqand', 'samarkand', 'samarqant', 'samarkant'],
  sirdaryo: ['sirdar', 'syrdar'],
  surxondaryo: ['surxondar', 'surxandar', 'surkhandar', 'surkhondar', 'surhandar', 'surhondar'],
};
const TASHKENT_ANY = /(toshkent|tashkent|toshkand)/;
// "Toshkent viloyati", "Tashkent region", "Ташкентская область", "#toshkentviloyati"
const TASHKENT_REGION = /(toshkent|tashkent|toshkand)[a-z]*[\s\-_#.,]*(viloyat|vil\b|vil\.|region|oblast|obl\b|obl\.|province)/g;

// O‘zbek kirill va rus harflarini lotinga o‘girish
const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', ғ: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y',
  к: 'k', қ: 'q', л: 'l', м: 'm', н: 'n', о: 'o', ў: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'x', ҳ: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu',
  я: 'ya', ә: 'a', ө: 'o', ү: 'u', ң: 'n', і: 'i',
};

export function normalize(input) {
  let s = String(input || '').normalize('NFC').toLowerCase();
  let out = '';
  for (const ch of s) out += ch in CYR ? CYR[ch] : ch;
  out = out.replace(/[\u2018\u2019\u02BB\u02BC\u02B9\u0060\u00B4'’‘]/g, '');
  out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return out;
}

/** Bitta matnda tilga olingan hududlar (har biri faqat bir marta). */
export function matchRegions(text) {
  let t = normalize(text);
  const found = new Set();
  if (!t) return [];
  // Shoir Alisher Navoiy nomi Navoiy viloyati deb sanalmasin
  t = t.replace(/alisher\s*navoi[a-z]*/g, ' ');
  if (TASHKENT_REGION.test(t)) {
    found.add('toshkent_v');
    TASHKENT_REGION.lastIndex = 0;
    t = t.replace(TASHKENT_REGION, ' ');
  }
  TASHKENT_REGION.lastIndex = 0;
  // Viloyat so‘zisiz "Toshkent" — Toshkent shahri deb hisoblanadi.
  if (TASHKENT_ANY.test(t)) found.add('toshkent_sh');
  for (const [id, stems] of Object.entries(STEMS)) {
    if (stems.some((st) => t.includes(st))) found.add(id);
  }
  return REGION_IDS.filter((id) => found.has(id));
}

/** Unutilgan Ruhlar loyihasini va til versiyasini aniqlash. */
export function detectProject(text) {
  const compact = normalize(text).replace(/[^a-z0-9]/g, '');
  const uz = compact.includes('unutilganruhlar');
  const en = compact.includes('forgottenspirits');
  return {
    isForgottenSpirits: uz || en,
    lang: uz && !en ? 'uz' : en && !uz ? 'en' : null,
    markers: { uz, en },
  };
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const IG_CODE = /^[A-Za-z0-9_-]{5,64}$/;

/** YouTube yoki Instagram havolasini tekshiradi. Natija: {platform:'yt'|'ig', extId} yoki null. */
export function parseVideoUrl(input) {
  const s = String(input || '').trim();
  if (!s || s.length > 500) return null;
  if (YT_ID.test(s)) return { platform: 'yt', extId: s };
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be') {
    const id = parts[0];
    return YT_ID.test(id || '') ? { platform: 'yt', extId: id } : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    let id = u.searchParams.get('v');
    if (!id && ['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1];
    return YT_ID.test(id || '') ? { platform: 'yt', extId: id } : null;
  }
  if (host === 'instagram.com' || host === 'instagr.am') {
    const i = parts.findIndex((p) => ['reel', 'reels', 'p', 'tv'].includes(p));
    const code = i >= 0 ? parts[i + 1] : null;
    return IG_CODE.test(code || '') ? { platform: 'ig', extId: code } : null;
  }
  return null;
}

export function canonicalUrl(platform, extId) {
  return platform === 'yt'
    ? `https://www.youtube.com/watch?v=${extId}`
    : `https://www.instagram.com/reel/${extId}/`;
}
