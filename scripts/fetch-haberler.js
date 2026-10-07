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
  headers: {
    // Bazi kaynaklar (orn. IHA) sunucu/bot trafigini User-Agent'a bakarak
    // 403 ile reddediyor olabilir; gercek bir tarayici gibi gorunen bir
    // UA deniyoruz. Garanti degil - IP bazli engelleme de olabilir.
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept": "application/rss+xml, application/xml, text/xml, */*",
  },
});

/* ---------- kaynak tanimlari ----------
   Her kaynagin kisa kodu (kaynak), gorunen adi ve RSS adresi burada
   tanimlanir. Yeni bir ajans eklemek icin bu listeye bir satir eklemek
   yeterli.
   ONEMLI: Bu URL'lerin cogu genel bilinen adres kaliplarindan derlendi,
   TEK TEK canli test edilmedi (18 kaynagi tek tek dogrulamak pratik
   degildi). Ama bu ZARARSIZ: her kaynak kendi try/catch'inde calisiyor
   (bkz. kaynaktanCek), biri 403/404/bozuk XML verirse sadece o kaynak
   [uyari] ile loglanip atlaniyor, digerlerini ya da genel calismayi
   etkilemiyor. Ilk calistirmanin "Haberleri cek" logunda hangi kaynaklarin
   gercekten calistigini gorup, calismayanlarin adresini tek tek
   duzeltmek/cikarmak gerekecek - bu normal, beklenen bir ilk-tur sureci. */
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
    // UYARI: bu adres su an 404 donduruyor (24 Eylul 2026'da tespit edildi).
    // DHA'nin guncel RSS adresini dha.com.tr uzerinden (genelde sayfa
    // altbilgisinde "RSS" linki olur) bulup burayi guncellemek gerekiyor.
    rss: "https://www.dha.com.tr/rss/ekonomi.xml",
  },
  { kod: "HURRIYET", ad: "Hurriyet", rss: "https://www.hurriyet.com.tr/rss/ekonomi" },
  { kod: "MILLIYET", ad: "Milliyet", rss: "https://www.milliyet.com.tr/rss/rssnew/ekonomirss.xml" },
  { kod: "SABAH", ad: "Sabah", rss: "https://www.sabah.com.tr/rss/ekonomi.xml" },
  { kod: "HABERTURK", ad: "Haberturk", rss: "https://www.haberturk.com/rss/ekonomi.xml" },
  { kod: "NTV", ad: "NTV", rss: "https://www.ntv.com.tr/ekonomi.rss" },
  { kod: "SOZCU", ad: "Sozcu", rss: "https://www.sozcu.com.tr/kategori/ekonomi/feed/" },
  { kod: "CUMHURIYET", ad: "Cumhuriyet", rss: "https://www.cumhuriyet.com.tr/rss/ekonomi.xml" },
  { kod: "STAR", ad: "Star", rss: "https://www.star.com.tr/rss/ekonomi.xml" },
  { kod: "AKSAM", ad: "Aksam", rss: "https://www.aksam.com.tr/rss/ekonomi.xml" },
  { kod: "YENISAFAK", ad: "Yeni Safak", rss: "https://www.yenisafak.com/rss?xml=ekonomi" },
  { kod: "DUNYA", ad: "Dunya Gazetesi", rss: "https://www.dunya.com/rss?kategori=ekonomi" },
  { kod: "BLOOMBERGHT", ad: "Bloomberg HT", rss: "https://www.bloomberght.com/rss" },
  { kod: "CNNTURK", ad: "CNN Turk", rss: "https://www.cnnturk.com/feed/rss/ekonomi/news" },
  { kod: "HABER7", ad: "Haber7", rss: "https://www.haber7.com/ekonomi_articles.rss" },
  { kod: "ENSONHABER", ad: "Ensonhaber", rss: "https://www.ensonhaber.com/rss/ekonomi.xml" },
  { kod: "TAKVIM", ad: "Takvim", rss: "https://www.takvim.com.tr/rss/ekonomi.xml" },
  { kod: "TRTHABER", ad: "TRT Haber", rss: "https://www.trthaber.com/ekonomi.rss" },
];

/* Baslik/ozet bu anahtar kelimelerden en az birini icermiyorsa
   habere alinmaz. */
const KESIN_KELIMELER = [
  "akaryakit", "benzin", "motorin", "mazot", "lpg", "otogaz",
  "epdk", "petrol", "pompa fiyat",
];
// "zam"/"indirim" tek basina belirsiz - baska her konuda (elektrik, dogalgaz,
// maas, vergi vb.) da gecebilir. Bunlar ancak metinde KESIN_KELIMELER'den
// biriyle BIRLIKTE geçtiginde akaryakit haberi sayilir.
const BELIRSIZ_KELIMELER = ["zam", "indirim"];

const MAKS_HABER = 40;
const MAKS_YAS_GUN = 10;

function icerirAnahtarKelime(baslik, ozet) {
  const t = ((baslik || "") + " " + (ozet || "")).toLocaleLowerCase("tr-TR");
  const kesinVar = KESIN_KELIMELER.some((k) => t.includes(k));
  if (kesinVar) return true;
  // Kesin kelime yoksa, belirsiz kelimeler (zam/indirim) tek basina yeterli
  // degil - onlari da saymayalim.
  return false;
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
      .filter((item) => icerirAnahtarKelime(item.title, item.contentSnippet))
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

/* ---------- eksik tutar/tarih icin tam makaleyi cekme ----------
   RSS ozetleri genelde kisa kesiliyor ("...rekor bir artis yasanabi...") -
   asil TL tutari cogu zaman kesilen kismin hemen otesinde, makalenin
   govdesinde oluyor. Baslik+ozette "zam/indirim...bekleniyor" gibi net bir
   sinyal var ama tutar/tarih eksikse, tam makaleyi bir kez cekip orada
   arıyoruz. Istek sayisini sinirliyoruz (TAM_METIN_SINIRI) ki calisma
   suresi kontrolsuz uzamasin. */
const TAM_METIN_SINIRI = 12;
let tamMetinKullanilan = 0;

async function tamMetniCek(url) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const zamanAsimi = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
    });
    clearTimeout(zamanAsimi);
    if (!res.ok) { console.log("[tam-metin] HTTP " + res.status + ": " + url); return null; }
    const html = await res.text();
    // Kaba ama yeterli HTML->duz metin donusumu: script/style'i at, etiketleri
    // sok, bosluklari sadelestir. Tam bir HTML parser'a gerek yok, sadece
    // fiyat/tarih regex'lerinin calisabilecegi duz bir metin lazim.
    const metin = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
    return metin.slice(0, 20000);
  } catch (e) {
    console.log("[tam-metin] hata (" + (e && e.message) + "): " + url);
    return null;
  }
}

/* ---------- tutar-merkezli beklenti cikarimi ----------
   Eski yontem "urun kelimesini bul, yakinindaki ILK tutari al" diyordu. Iki
   sorunu vardi: (1) tutar ozette olup tarih yoksa tam makaleyi hic cekmiyordu
   (canli ornek: "Motorine indirim yolda: Tarih belli oldu" -> "...4,95 lira
   indirim bekleniyor", tarih baslikta yok), (2) "2,22 TL indirim UYGULANDI"
   gibi gecmis cumleyi "4,95 TL indirim BEKLENIYOR" ile karistirabiliyordu.
   Yeni yontem her TL tutarini tek tek degerlendirir: o tutarin yakininda
   (a) bir urun, (b) zam/indirim yonu, (c) "bekleniyor" gibi gelecek ifadesi,
   (d) bugunden sonraki bir tarih varsa aday sayilir; gecmis-zaman cumleleri ve
   fiyat SEVIYESI (orn. "Ankara'da 91,13 liraya") atlanir. */
const BEKLENTI_IFADESI = /bekleniyor|beklentisi|beklenen|bekleyen|gelecek|yapılacak|olacak|öngörülüyor|geliyor|gelebilir|yolda|gündemde|gundemde|kesinleşirse|kesinlesirse/i;
const BEKLENTI_KAPISI = /bekle|geliyor|yolda|gelecek|yapılacak|olacak|gündem|gundem|tarih belli|tabela|öngörül|kesinleş|kesinles|müjde|mujde/i;
const YON_KAPISI = /indirim|\bzam|zamm|artış|artis|artacak|yükselecek|yukselecek|düşüş|dusus|düşecek|dusecek/i;
const GECMIS_ZAMAN = /uygulan(?:dı|di|ırken|irken|mıştı|mistı|mıştır)|yapıldı|yapildi|yapılmıştı|yapilmisti|gerçekleşti|gerceklesti|geldi\b|oldu\b|edildi/i;
const MAKS_DEGISIM_TL = 25; // yakit fiyat SEVIYELERI (28+ TL) tutar sanilmasin

function tarihleriBul(metin) {
  const bulunanlar = [];
  const simdi = new Date();
  function normalize(gun, ay, yilVar) {
    if (!ay || gun < 1 || gun > 31) return null;
    let yil = yilVar || simdi.getFullYear();
    let aday = new Date(Date.UTC(yil, ay - 1, gun));
    if (!yilVar && aday.getTime() < simdi.getTime() - 5 * 24 * 60 * 60 * 1000) {
      aday = new Date(Date.UTC(yil + 1, ay - 1, gun));
    }
    return aday.toISOString().slice(0, 10);
  }
  const ayDeseni = /(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)(?:\s+(20\d{2}))?/gi;
  let m;
  while ((m = ayDeseni.exec(metin)) !== null) {
    const iso = normalize(parseInt(m[1], 10), AY_ISIMLERI[m[2].toLocaleLowerCase("tr-TR")], m[3] ? parseInt(m[3], 10) : null);
    if (iso) bulunanlar.push({ index: m.index, iso });
  }
  const sayisalDeseni = /\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b/g;
  while ((m = sayisalDeseni.exec(metin)) !== null) {
    const iso = normalize(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
    if (iso) bulunanlar.push({ index: m.index, iso });
  }
  return bulunanlar;
}

function enYakinUrun(metin, tutarBas, tutarSon) {
  // Once tutardan ONCE gelen en yakin urun kelimesi (140 karakter icinde);
  // yoksa tutardan hemen SONRA gelen (50 karakter icinde, "5,5 TL'lik motorin indirimi").
  let enIyi = null;
  const onceki = metin.slice(Math.max(0, tutarBas - 140), tutarBas);
  for (const urun of Object.keys(URUN_DESENLERI)) {
    for (const d of URUN_DESENLERI[urun]) {
      const g = new RegExp(d.source, "gi");
      let m;
      while ((m = g.exec(onceki)) !== null) {
        if (!enIyi || m.index > enIyi.konum) enIyi = { urun, konum: m.index };
        if (g.lastIndex === m.index) g.lastIndex++;
      }
    }
  }
  if (enIyi) return enIyi.urun;
  const sonraki = metin.slice(tutarSon, tutarSon + 50);
  let enYakin = null;
  for (const urun of Object.keys(URUN_DESENLERI)) {
    for (const d of URUN_DESENLERI[urun]) {
      const m = new RegExp(d.source, "i").exec(sonraki);
      if (m && (!enYakin || m.index < enYakin.konum)) enYakin = { urun, konum: m.index };
    }
  }
  return enYakin ? enYakin.urun : null;
}

function adaylariCikar(metin) {
  const sonuc = [];
  const tarihler = tarihleriBul(metin);
  const tutarDeseni = /(\d{1,3}[.,]\d{1,2})\s*(?:TL|lira)/gi;
  let m;
  while ((m = tutarDeseni.exec(metin)) !== null) {
    const tutar = parseFloat(m[1].replace(",", "."));
    if (!(tutar >= 0.05 && tutar <= MAKS_DEGISIM_TL)) continue;
    const bas = m.index;
    const son = m.index + m[0].length;

    // Fiyat SEVIYESI gibi gorunenleri ele: "...liraya/TL'ye/liradan" (hedef fiyat),
    // "Ankara'da 91,13", "Benzin: 85,40".
    const sonrasi3 = metin.slice(son, son + 4);
    if (/^(?:['’]?(?:ya|ye|dan|den)\b|ya\b|ye\b|dan\b|den\b)/i.test(sonrasi3)) continue;
    const oncesi = metin.slice(Math.max(0, bas - 22), bas);
    if (/['’](?:da|de|ta|te)\s*$/i.test(oncesi) || /:\s*$/.test(oncesi)) continue;

    // Gecmis zaman ("2,22 TL indirim uygulanirken/yapildi") -> zaten gerceklesmis.
    const hemenSonra = metin.slice(son, son + 70);
    if (GECMIS_ZAMAN.test(hemenSonra)) continue;

    const yerel = metin.slice(Math.max(0, bas - 120), son + 160);
    if (!BEKLENTI_IFADESI.test(yerel)) continue;

    // Yon: tutara en yakin zam/indirim ifadesi (dar pencere).
    const dar = metin.slice(Math.max(0, bas - 90), son + 90);
    const merkez = bas - Math.max(0, bas - 90);
    let enYakinYon = null;
    const yonDeseni = /(indirim)|(\bzam)|(zamm)|(artış|artis|artacak|yükselecek|yukselecek)|(düşüş|dusus|düşecek|dusecek)/gi;
    let ym;
    while ((ym = yonDeseni.exec(dar)) !== null) {
      const uzaklik = Math.abs(ym.index - merkez);
      const yon = (ym[1] || ym[5]) ? "dusus" : "artis";
      if (!enYakinYon || uzaklik < enYakinYon.uzaklik) enYakinYon = { yon, uzaklik };
      if (yonDeseni.lastIndex === ym.index) yonDeseni.lastIndex++;
    }
    if (!enYakinYon) continue;

    const urun = enYakinUrun(metin, bas, son);
    if (!urun) continue;

    // Tarih: tutara en yakin, BUGUNDEN SONRAKI (veya bugun) tarih (+-140 karakter).
    let secilen = null;
    for (const t of tarihler) {
      if (t.index < bas - 140 || t.index > son + 140) continue;
      if (tarihGecmisMi(t.iso)) continue;
      const uzaklik = Math.abs(t.index - bas);
      if (!secilen || uzaklik < secilen.uzaklik) secilen = { iso: t.iso, uzaklik };
    }
    // Tarih bulunamazsa aday tarihsiz (null) olarak tutulur; ancak baska bir
    // kaynakta AYNI urun+yon+tutarla tarihli bir aday varsa birlestirme
    // asamasinda tarihi oradan alir, yoksa elenir (tarih UYDURULMAZ).
    sonuc.push({ urun, yon: enYakinYon.yon, tutar, tarih: secilen ? secilen.iso : null });
  }
  return sonuc;
}

async function beklentiCikarBirHaberden(haber) {
  // 4 gunden eski haber artik "yaklasan" bir degisiklik haberi olamaz.
  if (haber.tarih) {
    const t = new Date(haber.tarih).getTime();
    if (!Number.isNaN(t) && Date.now() - t > 4 * 24 * 60 * 60 * 1000) return [];
  }
  const ozetMetin = (haber.baslik || "") + " " + (haber.ozet || "");

  // Ucuz on elemeler (tam makale cekmeden once): urun + yon + gelecek ifadesi.
  const urunVar = Object.values(URUN_DESENLERI).some((ds) => ds.some((d) => d.test(ozetMetin)));
  if (!urunVar || !YON_KAPISI.test(ozetMetin) || !BEKLENTI_KAPISI.test(ozetMetin)) return [];

  const etiket = (c) => ({ ...c, kaynakBaslik: haber.baslik, kaynakLink: haber.link, kaynak: haber.kaynak });

  // 1) Once sadece baslik+ozetten dene; TARIHLI aday varsa tamam.
  let adaylar = adaylariCikar(ozetMetin);
  if (adaylar.some((a) => a.tarih)) return adaylar.map(etiket);
  let yedek = adaylar; // tutar+yon+urun var ama tarih yok

  // 2) Tarihli aday yoksa (tutar YA DA tarih eksik olabilir) tam makaleyi cek.
  if (tamMetinKullanilan < TAM_METIN_SINIRI) {
    tamMetinKullanilan++;
    const tamMetin = await tamMetniCek(haber.link);
    if (tamMetin) {
      const a2 = adaylariCikar(ozetMetin + " " + tamMetin);
      if (a2.some((a) => a.tarih)) return a2.map(etiket);
      if (a2.length) yedek = a2;
    }
  }
  // 3) Tarih hala yok: tarihsiz adaylar birlestirme asamasinda baska
  //    kaynaktaki ayni (urun+yon+tutar) tarihli adayla eslesirse kullanilir.
  return yedek.map(etiket);
}

function tarihGecmisMi(isoTarih) {
  // "Bugun" UTC gun basi ile karsilastiriyoruz (tarih alani zaten UTC
  // gun-basi olarak uretiliyor, bkz. turkceTarihiCoz). Yururluk tarihi
  // bugunden ONCEYSE, bu artik "beklenen" bir degisiklik degil - ya
  // gerceklesti ya da haber eskidi, "bekleniyor" demek anlamsiz olur.
  const [y, m, d] = isoTarih.split("-").map(Number);
  const yururluk = Date.UTC(y, m - 1, d);
  const bugun = new Date();
  const bugunUTC = Date.UTC(bugun.getUTCFullYear(), bugun.getUTCMonth(), bugun.getUTCDate());
  return yururluk < bugunUTC;
}

async function beklentileriBirlestir(haberler) {
  const adaylar = { motorin: [], benzin: [], lpg: [] };
  for (const h of haberler) {
    const cikanlar = await beklentiCikarBirHaberden(h);
    for (const c of cikanlar) {
      if (!adaylar[c.urun]) continue;
      if (c.tarih && tarihGecmisMi(c.tarih)) continue;
      adaylar[c.urun].push(c);
    }
  }
  // Tarihsiz adaylari, ayni urun+yon+tutarla TARIHLI baska bir adaydan tamamla;
  // eslesme yoksa at (tarih uydurmuyoruz).
  for (const urun of Object.keys(adaylar)) {
    const tarihliler = adaylar[urun].filter((a) => a.tarih);
    adaylar[urun] = adaylar[urun]
      .map((a) => {
        if (a.tarih) return a;
        const es = tarihliler.find((b) => b.yon === a.yon && b.tutar === a.tutar);
        return es ? { ...a, tarih: es.tarih } : null;
      })
      .filter(Boolean);
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

/* ---------- Seçenek A: sessiz çapraz-doğrulama (kullanıcıya gösterilmez) ----------
   Haberlerde "X TL zam/indirim GELDİ/YAPILDI" gibi GEÇMİŞ ZAMAN, kesinleşmiş
   ifadeleri ara (beklentiCikar'dan farkli - o "bekleniyor" gibi gelecek zaman
   ifadelerini ariyordu). Bunu, ayni gunku fiyatlar.json'daki EPDK gunluk
   farkiyla karsilastirip, uyusmuyorsa SADECE Actions logunda bir
   [SAGLIK-UYARISI] birakiyoruz - uygulamaya/JSON ciktisina hicbir sey
   yazilmiyor. Amac: EPDK scraping'imizde sessiz bir kirilma olursa (site
   degisir, selector kirilir vb.) bunu erken fark etmek. */
function sonDegisimCikarBirHaberden(haber) {
  if (eskimisMi(haber.tarih)) return [];
  const metin = (haber.baslik || "") + " " + (haber.ozet || "");

  // "bekleniyor" turu ifadeler varsa bu henuz GERCEKLESMEMIS bir tahmin -
  // onu zaten beklentiCikarBirHaberden isliyor, burada saymayalim.
  if (/bekleniyor|beklentisi|gelebilir/i.test(metin)) return [];

  let yon = null;
  if (/indirim/i.test(metin)) yon = "dusus";
  else if (/\bzam\b/i.test(metin)) yon = "artis";
  if (!yon) return [];

  // Kesinlesmis/gecmis zaman ifadesi ariyoruz. "indi"/"arttı" gibi kisa
  // koklerden kacinildi (orn. "indi" -> "indirim" icinde de gecer, yanlis
  // eslesir); daha uzun, daha az belirsiz ifadeler kullanildi.
  if (!/geldi|yapildi|uyguland|yururluge gir|yururlukte|resmiyet kazandi|yansidi/i.test(metin)) return [];

  const tutarEslesme = metin.match(/(\d+[,.]\d{1,2})\s*(?:TL|lira)/i);
  const tutar = tutarEslesme ? parseFloat(tutarEslesme[1].replace(",", ".")) : null;
  if (!tutar) return [];

  const sonuc = [];
  for (const urun of Object.keys(URUN_DESENLERI)) {
    if (URUN_DESENLERI[urun].some((d) => d.test(metin))) {
      sonuc.push({ urun, yon, tutar, kaynakBaslik: haber.baslik, kaynak: haber.kaynak });
    }
  }
  return sonuc;
}

function sonDegisimleriBirlestir(haberler) {
  const adaylar = { motorin: [], benzin: [], lpg: [] };
  for (const h of haberler) {
    for (const c of sonDegisimCikarBirHaberden(h)) {
      if (adaylar[c.urun]) adaylar[c.urun].push(c);
    }
  }
  const sonuc = {};
  for (const urun of Object.keys(adaylar)) {
    const liste = adaylar[urun];
    if (!liste.length) { sonuc[urun] = { expected: false }; continue; }
    const gruplu = {};
    for (const a of liste) {
      const anahtar = a.yon + "|" + a.tutar;
      (gruplu[anahtar] = gruplu[anahtar] || []).push(a);
    }
    const enIyiGrup = Object.values(gruplu).sort((a, b) => b.length - a.length)[0];
    const ornek = enIyiGrup[0];
    sonuc[urun] = {
      expected: true,
      direction: ornek.yon,
      amount: ornek.tutar,
      dogrulayanKaynakSayisi: new Set(enIyiGrup.map((e) => e.kaynak)).size,
      kaynakBaslik: ornek.kaynakBaslik,
    };
  }
  return sonuc;
}

function eskiFiyatlariOku() {
  try {
    const ham = fs.readFileSync(path.join(process.cwd(), "fiyatlar.json"), "utf-8");
    return JSON.parse(ham);
  } catch (e) {
    return null;
  }
}

function epdkGunlukFarkHesapla(fiyatVerisi, urun) {
  if (!fiyatVerisi || !Array.isArray(fiyatVerisi.ilceler)) return null;
  const ornek = fiyatVerisi.ilceler.find(
    (d) => d[urun] && typeof d[urun].today === "number" && typeof d[urun].yesterday === "number"
  );
  if (!ornek) return null;
  return Math.round((ornek[urun].today - ornek[urun].yesterday) * 100) / 100;
}

function saglikKontroluYap(haberler) {
  const teyitliDegisim = sonDegisimleriBirlestir(haberler);
  const fiyatVerisi = eskiFiyatlariOku();
  if (!fiyatVerisi) {
    console.log("[saglik-kontrolu] fiyatlar.json bulunamadi/okunamadi, karsilastirma atlaniyor.");
    return;
  }
  for (const urun of Object.keys(teyitliDegisim)) {
    const h = teyitliDegisim[urun];
    if (!h.expected) continue;
    const epdkFark = epdkGunlukFarkHesapla(fiyatVerisi, urun);
    if (epdkFark === null) {
      console.log("[saglik-kontrolu] " + urun + ": EPDK gunluk farki hesaplanamadi (fiyatlar.json'da yeterli veri yok).");
      continue;
    }
    const haberFark = h.direction === "artis" ? h.amount : -h.amount;
    if ((haberFark > 0) !== (epdkFark > 0) && Math.abs(epdkFark) > 0.05 && Math.abs(haberFark) > 0.05) {
      console.warn(
        "[SAGLIK-UYARISI] " + urun + ": haberler '" + (h.direction === "artis" ? "+" : "-") + h.amount +
        " TL' diyor (" + h.dogrulayanKaynakSayisi + " kaynak, orn: \"" + h.kaynakBaslik + "\"), " +
        "ama EPDK verimiz TERS yonde bir fark gosteriyor (" + epdkFark.toFixed(2) + " TL). " +
        "EPDK scraping'inde bir sorun olabilir, kontrol edilmeli."
      );
    } else {
      const fark = Math.abs(haberFark - epdkFark);
      if (fark > 0.5) {
        console.warn(
          "[SAGLIK-UYARISI] " + urun + ": haber tutari (" + haberFark.toFixed(2) + " TL) ile EPDK gunluk farki (" +
          epdkFark.toFixed(2) + " TL) arasinda " + fark.toFixed(2) + " TL fark var. Kaynak: \"" + h.kaynakBaslik + "\""
        );
      } else {
        console.log("[saglik-kontrolu] " + urun + ": haber (" + haberFark.toFixed(2) + " TL) ve EPDK (" + epdkFark.toFixed(2) + " TL) farki tutarli.");
      }
    }
  }
}

async function main() {
  console.log(KAYNAKLAR.length + " kaynaktan haber cekiliyor: " + KAYNAKLAR.map((k) => k.kod).join(", "));

  const tumSonuclar = await Promise.all(KAYNAKLAR.map(kaynaktanCek));
  let haberler = tumSonuclar.flat();

  haberler = tekillestir(haberler).filter((h) => !eskimisMi(h.tarih));

  haberler.sort((a, b) => new Date(b.tarih || 0) - new Date(a.tarih || 0));
  haberler = haberler.slice(0, MAKS_HABER);

  const hedefYol = path.join(process.cwd(), "haberler.json");

  // Guvenlik agi: butun kaynaklar ayni anda basarisiz olursa (gecici RSS/ag sorunu),
  // bos veriyle eskiyi EZMEYELIM - fiyat script'indeki "eski veriyi koru" mantiginin
  // ayni burada da olmasi lazimdi, eksikti.
  if (haberler.length === 0) {
    console.error("[uyari] Hicbir kaynaktan haber gelmedi - eski haberler.json korunuyor (varsa).");
    try {
      const eskiHam = fs.readFileSync(hedefYol, "utf-8");
      const eski = JSON.parse(eskiHam);
      if (eski.haberler && eski.haberler.length > 0) {
        console.log("Eski veri korundu: " + eski.haberler.length + " haber (guncellenmedi).");
        return;
      }
    } catch (e) {
      console.error("[uyari] Eski haberler.json da okunamadi: " + e.message);
    }
    // Eski veri de yoksa/bozuksa, en azindan bos-ama-gecerli bir dosya yazalim ki
    // uygulama "yuklenemedi" hatasi yerine "haber yok" bos durumunu gostersin.
  }

  const beklenti = await beklentileriBirlestir(haberler);
  console.log("[beklenti] " + Object.entries(beklenti).map(([u, v]) => v.expected ? (u + ": " + (v.direction === "dusus" ? "-" : "+") + v.amount + " @" + v.tarih + " (" + v.dogrulayanKaynakSayisi + " kaynak)") : (u + ": yok")).join(" | ") + " | tam makale istegi: " + tamMetinKullanilan);
  saglikKontroluYap(haberler); // sessiz caprazdogrulama - sadece log, JSON'a yazilmiyor

  const cikti = {
    guncelleme: new Date().toISOString(),
    kaynaklar: Array.from(new Set(haberler.map((h) => h.kaynak))),
    beklenti,
    haberler: haberler,
  };

  fs.writeFileSync(hedefYol, JSON.stringify(cikti, null, 2), "utf-8");
  console.log("Yazildi: " + hedefYol + " - " + haberler.length + " haber, " + cikti.kaynaklar.length + " kaynak.");
}

main().catch((err) => {
  console.error("Beklenmeyen hata:", err);
  process.exit(1);
});
