#!/usr/bin/env node
/**
 * fetch-haberler.js
 * ---------------------------------------------------------------------
 * Birden fazla haber ajansinin RSS beslemesini ceker, akaryakit/benzin/
 * motorin/LPG/EPDK ile ilgili basliklari suzer, tek bir haberler.json
 * dosyasinda birlestirir. GitHub Actions icinde calisip repo'ya
 * commit'lenmesi ve GitHub Pages'te yayinlanmasi icin tasarlandi.
 *
 * Calistirma: node scripts/fetch-haberler.js
 * Cikti: ./haberler.json
 * ---------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const Parser = require("rss-parser");

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "yakit-nabzi-haber-bot/1.0" },
});

/* ---------- kaynak tanimlari ----------
   Her kaynagin kisa kodu (kaynak), gorunen adi ve RSS adresi burada
   tanimlanir. Yeni bir ajans eklemek icin bu listeye bir satir eklemek
   yeterli. NOT: Asagidaki URL'ler ornektir; her ajansin guncel, herkese
   acik RSS adresini ve kullanim sartlarini kendiniz dogrulayin. */
const KAYNAKLAR = [
  {
    kod: "AA",
    ad: "Anadolu Ajansi",
    rss: "https://www.aa.com.tr/tr/rss/default?cat=ekonomi",
  },
  {
    kod: "IHA",
    ad: "Ihlas Haber Ajansi",
    rss: "https://www.iha.com.tr/rss/ekonomi.xml",
  },
  {
    kod: "DHA",
    ad: "Demiroren Haber Ajansi",
    rss: "https://www.dha.com.tr/rss/ekonomi.xml",
  },
];

/* Baslik/ozet bu anahtar kelimelerden en az birini icermiyorsa
   habere alinmaz. */
const ANAHTAR_KELIMELER = [
  "akaryakit", "benzin", "motorin", "mazot", "lpg", "otogaz",
  "epdk", "petrol", "pompa fiyat", "zam", "indirim",
];

const MAKS_HABER = 40;
const MAKS_YAS_GUN = 10;

function icerirAnahtarKelime(metin) {
  const t = (metin || "").toLocaleLowerCase("tr-TR");
  return ANAHTAR_KELIMELER.some((k) => t.includes(k));
}

function temizleOzet(html) {
  if (!html) return "";
  const duz = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return duz.length > 220 ? duz.slice(0, 217) + "..." : duz;
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
    console.error("[uyari] " + kaynak.ad + " (" + kaynak.kod + ") cekilemedi: " + err.message);
    return [];
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
  console.log(KAYNAKLAR.length + " kaynaktan haber cekiliyor: " + KAYNAKLAR.map((k) => k.kod).join(", "));

  const tumSonuclar = await Promise.all(KAYNAKLAR.map(kaynaktanCek));
  let haberler = tumSonuclar.flat();

  haberler = tekillestir(haberler).filter((h) => !eskimisMi(h.tarih));

  haberler.sort((a, b) => new Date(b.tarih || 0) - new Date(a.tarih || 0));
  haberler = haberler.slice(0, MAKS_HABER);

  const cikti = {
    guncelleme: new Date().toISOString(),
    kaynaklar: Array.from(new Set(haberler.map((h) => h.kaynak))),
    haberler: haberler,
  };

  const hedefYol = path.join(process.cwd(), "haberler.json");
  fs.writeFileSync(hedefYol, JSON.stringify(cikti, null, 2), "utf-8");
  console.log("Yazildi: " + hedefYol + " - " + haberler.length + " haber, " + cikti.kaynaklar.length + " kaynak.");
}

main().catch((err) => {
  console.error("Beklenmeyen hata:", err);
  process.exit(1);
});
