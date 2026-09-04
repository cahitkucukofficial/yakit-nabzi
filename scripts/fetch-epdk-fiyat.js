#!/usr/bin/env node
/**
 * fetch-epdk-fiyat.js
 * ---------------------------------------------------------------------
 * Turkiye genelinde il bazinda akaryakit fiyatlarini DOGRUDAN EPDK'nin
 * resmi sorgulama sayfasindan (bildirim.epdk.gov.tr) ceker.
 *
 * Bu sayfa basit bir REST/JSON API degil, eski tip bir form (JSF)
 * oldugu icin gercek bir tarayici (Puppeteer/headless Chrome) ile
 * "Baslangic/Bitis Tarihi gir -> Sorgula -> Raporu Indir" adimlari
 * otomatik tekrarlanir, sonra inen .xls dosyasi ayristirilir.
 *
 * Cikti: ./fiyatlar.json (uygulamanin FIYAT_JSON_URL ile cektigi dosya)
 * ---------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const puppeteer = require("puppeteer");
const XLSX = require("xlsx");

const EPDK_PETROL_URL = "https://bildirim.epdk.gov.tr/bildirim-portal/faces/pages/tarife/petrol/illereGorePetrolAkaryakitFiyatSorgula.xhtml";
const EPDK_LPG_URL = "https://bildirim.epdk.gov.tr/bildirim-portal/faces/pages/tarife/lpg/illereGoreLPGFiyatSorgula.xhtml";
const CIKTI_YOLU = path.join(process.cwd(), "fiyatlar.json");
const MAKS_GECMIS = 14;

function bugunTarihGGAAYYYY() {
  const d = new Date();
  const gg = String(d.getDate()).padStart(2, "0");
  const aa = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return gg + "." + aa + "." + yyyy;
}

function bekle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------- EPDK'nin il isimlerini bizim ILCE_MAP anahtarlarimizla eslestirme ----------
   EPDK raporunda il isimleri TAMAMEN BUYUK HARF (orn. "AFYONKARAHISAR"), bizim
   ILCE_MAP'te ise Turkce ilk-harf-buyuk format (orn. "Afyonkarahisar"). */
function ilAdiniNormalize(ad) {
  const harfler = { İ: "i", I: "ı", Ç: "ç", Ğ: "ğ", Ö: "ö", Ş: "ş", Ü: "ü" };
  // Once buyuk harften normal Turkce kucuk harfe cevir, sonra ilk harfi buyut.
  let kucuk = ad
    .split("")
    .map((h) => {
      if (h === "İ") return "i";
      if (h === "I") return "ı";
      return h.toLocaleLowerCase("tr-TR");
    })
    .join("");
  return kucuk.charAt(0).toLocaleUpperCase("tr-TR") + kucuk.slice(1);
}

async function xlsIndir(sayfa, indirmeKlasoru) {
  const client = await sayfa.createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: indirmeKlasoru,
  });

  // "Raporu Indir" butonuna metne gore tikla (id bilinmiyor, metinle arastir).
  const butonlar = await sayfa.$$("xpath/" + "//*[contains(text(), 'Raporu') and contains(text(), 'ndir')]");
  if (!butonlar.length) throw new Error("'Raporu Indir' butonu bulunamadi.");
  await butonlar[0].click();

  // Dosyanin inmesini bekle (en fazla 30 sn).
  const zamanAsimi = Date.now() + 30000;
  let dosyaAdi = null;
  while (Date.now() < zamanAsimi) {
    const dosyalar = fs.readdirSync(indirmeKlasoru).filter((f) => !f.endsWith(".crdownload"));
    if (dosyalar.length) {
      dosyaAdi = dosyalar[0];
      break;
    }
    await bekle(500);
  }
  if (!dosyaAdi) throw new Error("Rapor dosyasi indirilemedi (zaman asimi).");
  return path.join(indirmeKlasoru, dosyaAdi);
}

async function sayfayiSorgulaVeIndir(browser, url, indirmeKlasoru, tarih) {
  const sayfa = await browser.newPage();
  try {
    await sayfa.setViewport({ width: 1280, height: 900 });
    console.log("Aciliyor: " + url);
    await sayfa.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    const tarihKutulari = await sayfa.$$("input[type='text']");
    if (tarihKutulari.length < 2) throw new Error("Tarih kutulari bulunamadi (beklenen en az 2, bulunan " + tarihKutulari.length + ").");

    await tarihKutulari[0].click({ clickCount: 3 });
    await tarihKutulari[0].type(tarih, { delay: 30 });
    await tarihKutulari[1].click({ clickCount: 3 });
    await tarihKutulari[1].type(tarih, { delay: 30 });

    const sorgulaButon = await sayfa.$$("xpath/" + "//*[contains(text(), 'Sorgula')]");
    if (!sorgulaButon.length) throw new Error("'Sorgula' butonu bulunamadi.");
    await sorgulaButon[0].click();
    await sayfa.waitForNetworkIdle({ idleTime: 1000, timeout: 30000 }).catch(() => {});
    await bekle(2000);

    console.log("Rapor indiriliyor: " + url);
    const dosyaYolu = await xlsIndir(sayfa, indirmeKlasoru);
    console.log("Indirildi: " + dosyaYolu);
    return dosyaYolu;
  } finally {
    await sayfa.close();
  }
}

async function main() {
  const tarih = bugunTarihGGAAYYYY();
  console.log("Sorgulanacak tarih: " + tarih);

  const indirmeKlasoruPetrol = fs.mkdtempSync(path.join(os.tmpdir(), "epdk-petrol-"));
  const indirmeKlasoruLpg = fs.mkdtempSync(path.join(os.tmpdir(), "epdk-lpg-"));

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let petrolXlsYolu, lpgXlsYolu;
  try {
    petrolXlsYolu = await sayfayiSorgulaVeIndir(browser, EPDK_PETROL_URL, indirmeKlasoruPetrol, tarih);
  } catch (err) {
    console.error("[uyari] Petrol raporu cekilemedi: " + err.message);
  }
  try {
    lpgXlsYolu = await sayfayiSorgulaVeIndir(browser, EPDK_LPG_URL, indirmeKlasoruLpg, tarih);
  } catch (err) {
    console.error("[uyari] LPG raporu cekilemedi: " + err.message);
  }
  await browser.close();

  if (!petrolXlsYolu && !lpgXlsYolu) throw new Error("Ne petrol ne LPG raporu indirilebildi - EPDK sitesi erisilemez olabilir.");

  function xlsOku(dosyaYolu) {
    if (!dosyaYolu) return [];
    const workbook = XLSX.readFile(dosyaYolu);
    const ilkSayfa = workbook.Sheets[workbook.SheetNames[0]];
    const satirlar = XLSX.utils.sheet_to_json(ilkSayfa, { defval: null });
    console.log(dosyaYolu + ": " + satirlar.length + " satir okundu.");
    return satirlar;
  }

  function sutunBul(sutunlar, icerenMetin) {
    return sutunlar.find((s) => s.toLocaleLowerCase("tr-TR").includes(icerenMetin));
  }

  // Il bazinda, yakit tipine gore fiyatlari topla.
  const ilVerisi = {}; // il -> { benzin: [fiyatlar], motorin: [fiyatlar], lpg: [fiyatlar] }
  function ekle(il, anahtar, fiyat) {
    if (!ilVerisi[il]) ilVerisi[il] = { benzin: [], motorin: [], lpg: [] };
    ilVerisi[il][anahtar].push(fiyat);
  }

  // ---- Petrol raporu (Benzin + Motorin) ----
  const petrolSatirlari = xlsOku(petrolXlsYolu);
  if (petrolSatirlari.length) {
    const sutunlar = Object.keys(petrolSatirlari[0]);
    const ilSutun = sutunBul(sutunlar, "il");
    const yakitSutun = sutunBul(sutunlar, "yak");
    const fiyatSutun = sutunBul(sutunlar, "fiyat");
    if (!ilSutun || !yakitSutun || !fiyatSutun) {
      console.error("[uyari] Petrol raporunda beklenen sutunlar bulunamadi: " + sutunlar.join(", "));
    } else {
      for (const satir of petrolSatirlari) {
        const il = ilAdiniNormalize(String(satir[ilSutun] || "").trim());
        const yakit = String(satir[yakitSutun] || "");
        const fiyat = parseFloat(satir[fiyatSutun]);
        if (!il || !Number.isFinite(fiyat)) continue;
        if (yakit.includes("Kurşunsuz Benzin 95")) ekle(il, "benzin", fiyat);
        else if (yakit.trim() === "Motorin" || yakit.includes("Motorin (Biodizel")) ekle(il, "motorin", fiyat);
      }
    }
  }

  // ---- LPG raporu (sadece Otogaz - tupluu/dokme LPG farkli birim, karistirilmaz) ----
  const lpgSatirlari = xlsOku(lpgXlsYolu);
  if (lpgSatirlari.length) {
    const sutunlar = Object.keys(lpgSatirlari[0]);
    const ilSutun = sutunBul(sutunlar, "il");
    const yakitSutun = sutunBul(sutunlar, "yak");
    const fiyatSutun = sutunBul(sutunlar, "fiyat");
    if (!ilSutun || !yakitSutun || !fiyatSutun) {
      console.error("[uyari] LPG raporunda beklenen sutunlar bulunamadi: " + sutunlar.join(", "));
    } else {
      for (const satir of lpgSatirlari) {
        const il = ilAdiniNormalize(String(satir[ilSutun] || "").trim());
        const yakit = String(satir[yakitSutun] || "").trim();
        const fiyat = parseFloat(satir[fiyatSutun]);
        if (!il || !Number.isFinite(fiyat)) continue;
        if (yakit === "Otogaz") ekle(il, "lpg", fiyat);
      }
    }
  }

  function medyan(sayilar) {
    if (!sayilar.length) return null;
    const s = [...sayilar].sort((a, b) => a - b);
    const orta = Math.floor(s.length / 2);
    const v = s.length % 2 ? s[orta] : (s[orta - 1] + s[orta]) / 2;
    return Math.round(v * 100) / 100;
  }

  console.log(Object.keys(ilVerisi).length + " ilden veri islendi.");

  // Onceki fiyatlar.json'i oku (dun/gecmis icin).
  function eskiVeriyiOku() {
    try {
      const ham = fs.readFileSync(CIKTI_YOLU, "utf-8");
      const veri = JSON.parse(ham);
      const harita = new Map();
      for (const d of veri.ilceler || []) harita.set(d.il + "|" + d.ilce, d);
      return harita;
    } catch {
      return new Map();
    }
  }
  const eskiVeri = eskiVeriyiOku();

  function yakitAlaniOlustur(bugunFiyat, eskiKayit, yakitAdi) {
    const eskiYakit = eskiKayit ? eskiKayit[yakitAdi] : null;
    const kullanilacakBugun = typeof bugunFiyat === "number" ? bugunFiyat
      : (eskiYakit && typeof eskiYakit.today === "number" ? eskiYakit.today : null);
    const dun = eskiYakit && typeof eskiYakit.today === "number" ? eskiYakit.today : kullanilacakBugun;
    const eskiGecmis = eskiYakit && Array.isArray(eskiYakit.history) ? eskiYakit.history : [];
    let gecmis = eskiGecmis.length ? eskiGecmis.slice() : (typeof dun === "number" ? [dun] : []);
    if (typeof bugunFiyat === "number") gecmis.push(bugunFiyat);
    gecmis = gecmis.slice(-MAKS_GECMIS);
    return { today: kullanilacakBugun, yesterday: dun, history: gecmis };
  }

  // ILCE_MAP burada da lazim - onceki update-fiyatlar.js'deki ile birebir ayni.
  const { ILCE_MAP } = require("./ilce-map.js");

  const ilceler = [];
  let basariliIl = 0;
  for (const il of Object.keys(ILCE_MAP)) {
    const veri = ilVerisi[il];
    const benzinMedyan = veri ? medyan(veri.benzin) : null;
    const motorinMedyan = veri ? medyan(veri.motorin) : null;
    const lpgMedyan = veri ? medyan(veri.lpg) : null;
    if (benzinMedyan !== null || motorinMedyan !== null) basariliIl++;
    else console.error("[uyari] " + il + " icin EPDK raporunda veri bulunamadi.");

    for (const ilceAdi of ILCE_MAP[il]) {
      const eskiKayit = eskiVeri.get(il + "|" + ilceAdi) || null;
      ilceler.push({
        il,
        ilce: ilceAdi,
        benzin: yakitAlaniOlustur(benzinMedyan, eskiKayit, "benzin"),
        motorin: yakitAlaniOlustur(motorinMedyan, eskiKayit, "motorin"),
        lpg: yakitAlaniOlustur(lpgMedyan, eskiKayit, "lpg"),
      });
    }
  }

  const cikti = {
    guncelleme: new Date().toISOString(),
    not: "Benzin, motorin ve LPG (Otogaz) fiyatlari EPDK'nin resmi bayi fiyat raporlarindan (bildirim.epdk.gov.tr) alinir; o ildeki tum firmalarin bildirdigi fiyatlarin MEDYANI kullanilir. Bir ildeki tum ilcelere ayni il medyani uygulanir.",
    ilceler,
  };

  fs.writeFileSync(CIKTI_YOLU, JSON.stringify(cikti, null, 2), "utf-8");
  console.log("Yazildi: " + CIKTI_YOLU + " - " + ilceler.length + " ilce, " + basariliIl + "/" + Object.keys(ILCE_MAP).length + " il icin EPDK verisi bulundu.");

  try { fs.rmSync(indirmeKlasoruPetrol, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(indirmeKlasoruLpg, { recursive: true, force: true }); } catch {}
}

main().catch((err) => {
  console.error("Beklenmeyen hata:", err);
  process.exit(1);
});
