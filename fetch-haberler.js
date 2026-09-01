#!/usr/bin/env node
/**
 * fetch-haberler.js
 * ---------------------------------------------------------------------
 * Birden fazla haber ajansının RSS beslemesini çeker, akaryakıt/benzin/
 * motorin/LPG/EPDK ile ilgili başlıkları süzer, tek bir haberler.json
 * dosyasında birleştirir. GitHub Actions içinde günde birkaç kez
 * çalıştırılıp repo'ya commit'lenmesi ve GitHub Pages'te yayınlanması
 * için tasarlandı (bkz. dosya sonundaki örnek workflow).
 *
 * Kurulum:
 *   npm init -y
 *   npm install rss-parser
 *
 * Çalıştırma:
 *   node scripts/fetch-haberler.js
 *
 * Çıktı:
 *   ./haberler.json  (uygulamanın HABER_JSON_URL ile çektiği dosyayla aynı şema)
 * ---------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const Parser = require("rss-parser");

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "yakit-nabzi-haber-bot/1.0" },
});

/* ---------- kaynak tanımları ----------
   Her kaynağın kısa kodu (kaynak), görünen adı ve RSS adresi burada
   tanımlanır. Yeni bir ajans eklemek için bu listeye bir satır eklemek
   yeterli — geri kalan kod otomatik olarak çoklu kaynağı işler.
   NOT: Aşağıdaki URL'ler örnektir; her ajansın güncel, herkese açık RSS
   adresini ve kullanım şartlarını kendiniz doğrulayın. */
const KAYNAKLAR = [
  {
    kod: "AA",
    ad: "Anadolu Ajansı",
    rss: "https://www.aa.com.tr/tr/rss/default?cat=ekonomi",
  },
  {
    kod: "İHA",
    ad: "İhlas Haber Ajansı",
    rss: "https://www.iha.com.tr/rss/ekonomi.xml",
  },
  {
    kod: "DHA",
    ad: "Demirören Haber Ajansı",
    rss: "https://www.dha.com.tr/rss/ekonomi.xml",
  },
];

/* Başlık/özet bu anahtar kelimelerden en az birini içermiyorsa
   habere alınmaz — akaryakıt gündemine odaklanmak için. */
const ANAHTAR_KELIMELER = [
  "akaryakıt", "benzin", "motorin", "mazot", "lpg", "otogaz",
  "epdk", "petrol", "pompa fiyat", "zam", "indirim",
];

const MAKS_HABER = 40; // dosyada tutulacak toplam üst sınır
const MAKS_YAS_GUN = 10; // bu günden eski haberler elenir

function icerirAnahtarKelime(metin) {
  const t = (metin || "").toLocaleLowerCase("tr-TR");
  return ANAHTAR_KELIMELER.some((k) => t.includes(k));
}

function temizleOzet(html) {
  if (!html) return "";
  const duz = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return duz.length > 220 ? duz.slice(0, 217) + "…" : duz;
}

async function kaynaktanCek(kaynak) {
  try {
    const feed = await parser.parseURL(kaynak.rss);
    return (feed.items || [])
      .filter((item) => icerirAnahtarKelime(item.title) || icerirAnahtarKelime(item.contentSnippet))
      .map((item) => ({
        baslik: (item.title || "").trim(),
        ozet: temizleOzet(item.contentSnippet || item.content),
        link: item.link,
        tarih: item.isoDate || item.pubDate || null,
        kaynak: kaynak.kod,
      }));
  } catch (err) {
    console.error(`[uyarı] ${kaynak.ad} (${kaynak.kod}) çekilemedi: ${err.message}`);
    return []; // bir kaynak başarısız olursa diğerlerini etkilemesin
  }
}

function tekillestir(haberler) {
  const gorulen = new Set();
  const sonuc = [];
  for (const h of haberler) {
    const anahtar = (h.link || h.baslik || "").trim().toLowerCase();
    if (!anahtar || gorulen.has(anahtar)) continue;
    gorulen.add(anahtar);
    sonuc.push(h);
  }
  return sonuc;
}

function eskimisMi(iso) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t > MAKS_YAS_GUN * 24 * 60 * 60 * 1000;
}

async function main() {
  console.log(`${KAYNAKLAR.length} kaynaktan haber çekiliyor: ${KAYNAKLAR.map((k) => k.kod).join(", ")}`);

  const tumSonuclar = await Promise.all(KAYNAKLAR.map(kaynaktanCek));
  let haberler = tumSonuclar.flat();

  haberler = tekillestir(haberler).filter((h) => !eskimisMi(h.tarih));

  // en yeni en üstte
  haberler.sort((a, b) => new Date(b.tarih || 0) - new Date(a.tarih || 0));
  haberler = haberler.slice(0, MAKS_HABER);

  const cikti = {
    guncelleme: new Date().toISOString(),
    kaynaklar: Array.from(new Set(haberler.map((h) => h.kaynak))),
    haberler,
  };

  const hedefYol = path.join(process.cwd(), "haberler.json");
  fs.writeFileSync(hedefYol, JSON.stringify(cikti, null, 2), "utf-8");
  console.log(`Yazıldı: ${hedefYol} — ${haberler.length} haber, ${cikti.kaynaklar.length} kaynak.`);
}

main().catch((err) => {
  console.error("Beklenmeyen hata:", err);
  process.exit(1);
});

/* ---------------------------------------------------------------------
   Örnek GitHub Actions workflow (.github/workflows/haberler.yml):

   name: Haberleri Güncelle
   on:
     schedule:
       - cron: "0 */4 * * *"   # günde 6 kez
     workflow_dispatch: {}      # elle tetiklemeye izin ver

   jobs:
     guncelle:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: "20"
         - run: npm install rss-parser
         - run: node scripts/fetch-haberler.js
         - run: |
             git config user.name "haber-bot"
             git config user.email "haber-bot@users.noreply.github.com"
             git add haberler.json
             git diff --cached --quiet || git commit -m "haberler.json güncellendi"
             git push

   Not: Repo'da GitHub Pages "main" dalından yayın yapacak şekilde
   ayarlıysa (Settings → Pages), push sonrası haberler.json otomatik
   olarak https://<kullanıcı>.github.io/<repo>/haberler.json adresinde
   güncellenmiş olur — uygulama tarafında ek bir işlem gerekmez.
   --------------------------------------------------------------------- */
