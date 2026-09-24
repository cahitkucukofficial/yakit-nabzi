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

/* ---------- "zam/indirim bekleniyor" haberlerinden yapisal beklenti cikarma ----------
   EPDK, fiili degisikligi ancak yururlukten hemen once bildiriyor; ama basin, o gunku
   ham petrol/kur hareketine bakarak saatler ONCESINDEN "X TL zam/indirim bekleniyor"
   diye tahmin haberi yapiyor (rakip uygulamanin "Indirim beklentisi var!" kartinin
   kaynagi da muhtemelen budur). Biz bunu ayni sekilde, ama SAHTE degil GERCEKTEN o
   haberlerden regex ile cikararak yapiyoruz - eslesme yoksa "expected: false" kalir,
   uydurma bir sey gostermeyiz. */
const AY_ISIMLERI = {
  "ocak": 1, "şubat": 2, "mart": 3, "nisan": 4, "mayıs": 5, "haziran": 6,
  "temmuz": 7, "ağustos": 8, "eylül": 9, "ekim": 10, "kasım": 11, "aralık": 12,
};

function turkceTarihiCoz(metin) {
  const m = metin.match(/(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)/i);
  if (!m) return null;
  const gun = parseInt(m[1], 10);
  const ay = AY_ISIMLERI[m[2].toLocaleLowerCase("tr-TR")];
  if (!ay || gun < 1 || gun > 31) return null;
  const simdi = new Date();
  let yil = simdi.getFullYear();
  let aday = new Date(Date.UTC(yil, ay - 1, gun));
  // Olusan tarih bugunden 5+ gun eskideyse muhtemelen gelecek yila ait bir tarih
  // kastedilmis (yil donumu civarindaki haberler icin).
  if (aday.getTime() < simdi.getTime() - 5 * 24 * 60 * 60 * 1000) {
    aday = new Date(Date.UTC(yil + 1, ay - 1, gun));
  }
  return aday.toISOString().slice(0, 10);
}

const URUN_DESENLERI = {
  motorin: [/motorin/i],
  benzin: [/benzin/i],
  lpg: [/\blpg\b/i, /otogaz/i],
};

function beklentiCikarBirHaberden(haber) {
  const metin = (haber.baslik || "") + " " + (haber.ozet || "");

  // "bekleniyor" turu bir belirsizlik ifadesi gecmiyorsa bu bir TAHMIN degil,
  // kesinlesmis/gecmis bir haber olabilir - atla (yanlislikla "kesin" gibi sunmayalim).
  if (!/bekleniyor|beklentisi|bekleniyor mu|gelebilir/i.test(metin)) return [];

  let yon = null;
  if (/indirim/i.test(metin)) yon = "dusus";
  else if (/\bzam\b/i.test(metin)) yon = "artis";
  if (!yon) return [];

  const tutarEslesme = metin.match(/(\d+[,.]\d{1,2})\s*(?:TL|lira)/i);
  const tutar = tutarEslesme ? parseFloat(tutarEslesme[1].replace(",", ".")) : null;
  const tarih = turkceTarihiCoz(metin);
  if (!tutar || !tarih) return []; // eksik bilgiyle gosterme

  const sonuc = [];
  for (const urun of Object.keys(URUN_DESENLERI)) {
    if (URUN_DESENLERI[urun].some((d) => d.test(metin))) {
      sonuc.push({ urun, yon, tutar, tarih, kaynakBaslik: haber.baslik, kaynakLink: haber.link, kaynak: haber.kaynak });
    }
  }
  return sonuc;
}

function beklentileriBirlestir(haberler) {
  const adaylar = { motorin: [], benzin: [], lpg: [] };
  for (const h of haberler) {
    for (const c of beklentiCikarBirHaberden(h)) {
      if (adaylar[c.urun]) adaylar[c.urun].push(c);
    }
  }
  const sonuc = {};
  for (const urun of Object.keys(adaylar)) {
    const liste = adaylar[urun];
    if (!liste.length) { sonuc[urun] = { expected: false }; continue; }
    // Ayni yon+tutar+tarihte kac farkli haber/kaynak var say (guven sinyali);
    // en cok dogrulanan kombinasyonu goster.
    const gruplu = {};
    for (const a of liste) {
      const anahtar = a.yon + "|" + a.tutar + "|" + a.tarih;
      (gruplu[anahtar] = gruplu[anahtar] || []).push(a);
    }
    const enIyiGrup = Object.values(gruplu).sort((a, b) => b.length - a.length)[0];
    const ornek = enIyiGrup[0];
    sonuc[urun] = {
      expected: true,
      direction: ornek.yon,
      amount: ornek.tutar,
      tarih: ornek.tarih,
      dogrulayanKaynakSayisi: new Set(enIyiGrup.map((e) => e.kaynak)).size,
      kaynakBaslik: ornek.kaynakBaslik,
      kaynakLink: ornek.kaynakLink,
    };
  }
  return sonuc;
}

async function main() {
  console.log(KAYNAKLAR.length + " kaynaktan haber cekiliyor: " + KAYNAKLAR.map((k) => k.kod).join(", "));

  const tumSonuclar = await Promise.all(KAYNAKLAR.map(kaynaktanCek));
  let haberler = tumSonuclar.flat();

  haberler = tekillestir(haberler).filter((h) => !eskimisMi(h.tarih));

  haberler.sort((a, b) => new Date(b.tarih || 0) - new Date(a.tarih || 0));
  haberler = haberler.slice(0, MAKS_HABER);

  const beklenti = beklentileriBirlestir(haberler);

  const cikti = {
    guncelleme: new Date().toISOString(),
    kaynaklar: Array.from(new Set(haberler.map((h) => h.kaynak))),
    beklenti,
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
