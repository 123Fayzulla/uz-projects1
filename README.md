# UZ PROJECTS

Ikki alohida loyiha uchun statistika paneli:
- **Unutilgan Ruhlar / Forgotten Spirits** — 14 hudud × 4 video (Instagram UZ/EN, YouTube UZ/EN), like yig‘indisi va izohlardagi hudud eslatmalari.
- **Regional Skyline** — izohlarda tilga olingan hudud minorasi +1 metr; kunlik (rolling) hisob.

## Tuzilma
```
netlify.toml                      Netlify sozlamasi (publish: public, functions: netlify/functions)
package.json                      Yagona bog‘liqlik: @netlify/blobs
public/index.html                 Ilova (o‘zbek tilida, telefon uchun)
netlify/functions/api.mjs         API: /api/*  (kalitlar faqat serverda)
netlify/functions/scheduled-sync.mjs  Har soatda avtomatik yangilash
netlify/lib/core.mjs              YouTube, Instagram, sinxronlash, hisob-kitob
netlify/lib/regions.mjs           Hududlar, nomlarni aniqlash, havola tahlili
tests/run.mjs                     Testlar (ixtiyoriy; saytga yuklash shart emas)
```

## Ma’lumotlar bazasi
**Netlify Blobs** ishlatiladi — Netlify’ga o‘rnatilgan, alohida hisob, SQL yoki kalit kerak emas.
Kalitlar: `fs-state` (Unutilgan Ruhlar), `sky-state` (Skyline), `settings` (Instagram token), `status`.
Ikki loyiha ma’lumoti hech qachon bitta kalitda turmaydi. Har bir izoh `platforma:izohID` kaliti bilan
faqat bir marta saqlanadi — qayta yangilashda ikki marta sanalmaydi.

## Netlify o‘zgaruvchilari
| Nomi | Majburiy | Izoh |
|---|---|---|
| `YOUTUBE_API_KEY` | ha | allaqachon bor. Almashtirish tavsiya etiladi (pastga qarang) |
| `ADMIN_PASSWORD` | ha | o‘zingiz o‘ylagan parol; video qo‘shish/o‘chirish/yangilash uchun |
| `INSTAGRAM_ACCESS_TOKEN` | yo‘q | token ilovaning Sozlamalar bo‘limidan ham kiritiladi |
| `INSTAGRAM_API_VERSION` | yo‘q | standart: `v25.0` |

## Joylash (Android telefondan)
1. ZIP’ni telefonda oching (Files → Extract).
2. GitHub repoga fayllarni yuklang, papka tuzilmasini saqlab:
   - Repo → **Add file → Create new file** → nomiga `netlify/lib/regions.mjs` deb yozing → fayl ichidagini qo‘ying → Commit.
     Shu usulda `netlify/functions/api.mjs` ham yarating. Keyin har bir papkaga kirib **Add file → Upload files** bilan qolgan fayllarni yuklang.
   - Ildizga: `netlify.toml`, `package.json`, `README.md`. `public/` ichiga: `index.html`.
3. Netlify → sayt → **Site configuration → Build & deploy → Continuous deployment → Link repository** → GitHub repo’ni tanlang
   (agar sayt allaqachon GitHub’ga ulangan bo‘lsa, bu qadam kerak emas). Build command — bo‘sh, publish — `public`.
4. Netlify → **Environment variables → Add variable** → `ADMIN_PASSWORD`.
5. **Deploys → Trigger deploy → Deploy site.**
6. Saytni oching → **Sozlamalar** → parolni kiriting.

## Instagram (siz bajarishingiz kerak)
1. Chrome’da “Kompyuter versiyasi”ni yoqib, developers.facebook.com/apps ga kiring.
2. **Create app** → **Business** turi.
3. **Instagram** mahsulotini qo‘shing → **API setup with Instagram login**.
4. **Generate access tokens → Add account** → @milliy_animatsiya bilan kiring, ruxsat bering.
5. Tokenni nusxalang → ilova → Sozlamalar → Instagram → “Tekshirish va ulash”.
Ruxsatlar: `instagram_business_basic`, `instagram_business_manage_comments`. O‘z akkauntingiz uchun App Review shart emas.
Token 60 kun amal qiladi; ilova uni har hafta avtomatik yangilaydi.

## YouTube kalitini xavfsiz qilish
Google Cloud Console → APIs & Services → Credentials → kalit → **Regenerate key**;
**API restrictions** → faqat **YouTube Data API v3**. “Website restrictions” qo‘ymang (so‘rovlar serverdan ketadi).
Yangi kalitni Netlify’dagi `YOUTUBE_API_KEY` ga qo‘yib, qayta deploy qiling.

## Hisob qoidalari
- Hudud like = shu hududning 4 ta videosi like’lari yig‘indisi. API like bermasa, “Qo‘lda like” qiymati ishlatiladi.
- Bitta izohda har xil hududlar — har biri +1; bitta hudud takrorlansa — faqat +1. Izoh qaysi video ostida bo‘lishidan qat’i nazar sanaladi.
- Lotin, kirill, inglizcha yozuvlar va qo‘shimchalar tanib olinadi. Faqat “Toshkent” → Toshkent shahri; “Toshkent viloyati / Tashkent region” → Toshkent viloyati.
- Video o‘chirilsa, uning izohlaridan olingan hisob ham olib tashlanadi.
- Skyline: video undan keyingi kun videosi qo‘shilganda yoki chiqqaniga 24 soat bo‘lganda hisoblanadi. “Hisoblashni boshlash” bosilmaguncha avtomatik hisob ishlamaydi.

## Testlar
`node tests/run.mjs` — 19 ta test (tashqi API’lar soxta javoblar bilan).
