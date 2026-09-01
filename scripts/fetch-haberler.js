// scripts/fetch-haberler.js
//
// GitHub Actions tarafından 5 saatte bir otomatik çalıştırılır.
// Yaptığı iş:
//   1) Anadolu Ajansı'nın genel haber RSS beslemesini çeker.
//   2) Başlığında veya özetinde akaryakıt ile ilgili anahtar kelimeler
//      geçen haberleri süzer (yorum/analiz eklemez, sadece filtreler).
//   3) Sonucu haberler.json'a yazar. Workflow dosyası bu değişikliği
//      otomatik commit'leyip depoya gönderir.
//
// Not: Bu script paket kurmadan (npm install olmadan) çalışacak şekilde
// RSS XML'ini basit regex ile ayrıştırır — besleme yapısı standart RSS 2.0
// olduğu sürece yeterlidir.

const fs = require("fs");
const path = require("path");

const OUT_PATH = path.join(__dirname, "..", "haberler.json");
const RSS_URL = "https://www.aa.com.tr/tr/rss/default?cat=guncel";
const MAX_HABER = 20;

// Akaryakıt ile ilgisiz genel "zam" haberlerini elemek için, kelimelerin
// çoğu doğrudan yakıt bağlamına özgü; sadece "zam"/"indirim" tek başına
// kullanılmıyor.
const ANAHTAR_KELIMELER = [
  "benzin", "motorin", "akaryakıt", "akaryakit", "mazot", "otogaz",
  "lpg", "pompa fiyat", "ötv", "otv", "petrol fiyat", "yakıt fiyat", "yakit fiyat",
];

function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">"));
  return m ? decodeEntities(m[1]) : "";
}

function parseItems(xml) {
  const items = [];
  const blocks = xml.split("<item>").slice(1);
  for (const raw of blocks) {
    const block = raw.split("</item>")[0];
    items.push({
      baslik: extractTag(block, "title"),
      ozet: extractTag(block, "description"),
      link: extractTag(block, "link"),
      tarih: extractTag(block, "pubDate"),
    });
  }
  return items;
}

function ilgiliMi(haber) {
  const metin = (haber.baslik + " " + haber.ozet).toLocaleLowerCase("tr-TR");
  return ANAHTAR_KELIMELER.some((k) => metin.includes(k));
}

function tarihToIso(pubDate) {
  const d = new Date(pubDate);
  return isNaN(d) ? null : d.toISOString();
}

async function main() {
  const res = await fetch(RSS_URL);
  if (!res.ok) throw new Error("RSS çekilemedi: HTTP " + res.status);
  const xml = await res.text();

  const tumHaberler = parseItems(xml);
  const filtreli = tumHaberler
    .filter(ilgiliMi)
    .slice(0, MAX_HABER)
    .map((h) => ({ baslik: h.baslik, ozet: h.ozet, link: h.link, tarih: tarihToIso(h.tarih) }));

  const out = { guncelleme: new Date().toISOString(), haberler: filtreli };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log("haberler.json güncellendi: " + filtreli.length + " haber (" + tumHaberler.length + " taranan haber içinden).");
}

main().catch((e) => { console.error(e); process.exit(1); });
