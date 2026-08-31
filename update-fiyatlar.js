// scripts/update-fiyatlar.js
//
// GitHub Actions tarafından günde bir kez otomatik çalıştırılır.
// Yaptığı iş:
//   1) Depodaki mevcut fiyatlar.json'u okur, her ilçenin "today" (bugün)
//      değerlerini "yesterday" (dün) olarak saklar — çünkü fiyatlar
//      gerçek hayatta da böyle karşılaştırılıyor: dünün bugünü.
//   2) ucuzyakitbul.com.tr API'sinden 81 ilin istasyon fiyatlarını çeker,
//      ilçelere göre gruplayıp ortalamasını alır (yeni "today" değeri olur).
//   3) Sonucu fiyatlar.json'a yazar. Workflow dosyası bu değişikliği
//      otomatik commit'leyip depoya gönderir.
//
// ÖNEMLİ: UCUZYAKITBUL_API_KEY tanımlı değilse script hiçbir şeyi
// bozmadan sessizce çıkar (mevcut dosya olduğu gibi kalır).

const fs = require("fs");
const path = require("path");

const OUT_PATH = path.join(__dirname, "..", "fiyatlar.json");
const API_KEY = process.env.UCUZYAKITBUL_API_KEY || "";
const BASE_URL = "https://ucuzyakitbul.com.tr/api";

// Uygulamadaki 81 il ile birebir aynı liste.
const ILLER = [
  "Ankara", "İstanbul", "İzmir", "Adana", "Adıyaman", "Afyonkarahisar", "Ağrı", "Amasya",
  "Antalya", "Artvin", "Aydın", "Balıkesir", "Bilecik", "Bingöl", "Bitlis", "Bolu", "Burdur",
  "Bursa", "Çanakkale", "Çankırı", "Çorum", "Denizli", "Diyarbakır", "Edirne", "Elazığ",
  "Erzincan", "Erzurum", "Eskişehir", "Gaziantep", "Giresun", "Gümüşhane", "Hakkari", "Hatay",
  "Isparta", "Mersin", "Kars", "Kastamonu", "Kayseri", "Kırklareli", "Kırşehir", "Kocaeli",
  "Konya", "Kütahya", "Malatya", "Manisa", "Kahramanmaraş", "Mardin", "Muğla", "Muş",
  "Nevşehir", "Niğde", "Ordu", "Rize", "Sakarya", "Samsun", "Siirt", "Sinop", "Sivas",
  "Tekirdağ", "Tokat", "Trabzon", "Tunceli", "Şanlıurfa", "Uşak", "Van", "Yozgat",
  "Zonguldak", "Aksaray", "Bayburt", "Karaman", "Kırıkkale", "Batman", "Şırnak", "Bartın",
  "Ardahan", "Iğdır", "Yalova", "Karabük", "Kilis", "Osmaniye", "Düzce",
];

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { "x-api-key": API_KEY } });
  if (!res.ok) throw new Error(url + " -> HTTP " + res.status);
  return res.json();
}

// Resmî API dokümantasyonuna (ucuzyakitbul.com.tr/api-docs) göre doğrulanmış
// şema: her istasyon {district, fuelPrices:[{fuelType, price}, ...]} içerir.
// Şehir başına 500'lük sayfalarla, hasMore bitene kadar çekilir.
async function fetchIlIstasyonlari(il) {
  const all = [];
  let offset = 0;
  const limit = 500;
  while (true) {
    const url = BASE_URL + "/stations?city=" + encodeURIComponent(il) + "&limit=" + limit + "&offset=" + offset;
    const data = await fetchJSON(url);
    const batch = data.stations || data.data || data.results || [];
    all.push(...batch);
    if (!data.hasMore || batch.length === 0 || offset >= 1000) break;
    offset += limit;
  }
  return all;
}

function groupByDistrict(il, stations) {
  const byDistrict = new Map();
  for (const s of stations) {
    const ilce = s.district || s.ilce || s.county || "Merkez";
    if (!byDistrict.has(ilce)) byDistrict.set(ilce, { benzin: [], motorin: [], lpg: [] });
    const bucket = byDistrict.get(ilce);
    // Her istasyonun fiyatları "fuelPrices" adlı alt dizide gelir:
    // { fuelType: "Benzin", price: 74.29, ... }
    for (const fp of s.fuelPrices || []) {
      const fuel = String(fp.fuelType || "").toLowerCase();
      const price = Number(fp.price);
      if (!price) continue;
      if (fuel.includes("benzin")) bucket.benzin.push(price);
      else if (fuel.includes("motorin")) bucket.motorin.push(price);
      else if (fuel.includes("lpg")) bucket.lpg.push(price);
    }
  }
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null);
  const out = [];
  for (const [ilce, b] of byDistrict) {
    out.push({ il, ilce, benzin: avg(b.benzin), motorin: avg(b.motorin), lpg: avg(b.lpg) });
  }
  return out;
}

async function main() {
  if (!API_KEY) {
    console.log("UCUZYAKITBUL_API_KEY tanımlı değil — il/ilçe güncellemesi atlanıyor, dosya değiştirilmedi.");
    return;
  }

  let onceki = { ilceler: [] };
  if (fs.existsSync(OUT_PATH)) {
    try { onceki = JSON.parse(fs.readFileSync(OUT_PATH, "utf8")); } catch { /* bozuk dosya, boş say */ }
  }
  const dunMap = new Map();
  for (const d of onceki.ilceler || []) dunMap.set(d.il + "|" + d.ilce, d);

  const tumIlceler = [];
  for (const il of ILLER) {
    try {
      const stations = await fetchIlIstasyonlari(il);
      const gruplar = groupByDistrict(il, stations);
      for (const g of gruplar) {
        if (g.benzin == null && g.motorin == null && g.lpg == null) continue;
        const key = g.il + "|" + g.ilce;
        const dun = dunMap.get(key);
        tumIlceler.push({
          il: g.il,
          ilce: g.ilce,
          benzin: { today: g.benzin, yesterday: dun?.benzin?.today ?? g.benzin },
          motorin: { today: g.motorin, yesterday: dun?.motorin?.today ?? g.motorin },
          lpg: { today: g.lpg, yesterday: dun?.lpg?.today ?? g.lpg },
        });
      }
      console.log(il + ": " + gruplar.length + " ilçe işlendi.");
    } catch (e) {
      console.error(il + " çekilemedi: " + e.message);
    }
    // API'yi yormamak için istekler arasında kısa bir bekleme
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!tumIlceler.length) {
    console.log("Hiç veri çekilemedi, mevcut dosya korunuyor.");
    return;
  }

  const out = { guncelleme: new Date().toISOString(), ilceler: tumIlceler };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log("fiyatlar.json güncellendi: " + tumIlceler.length + " ilçe.");
}

main().catch((e) => { console.error(e); process.exit(1); });
