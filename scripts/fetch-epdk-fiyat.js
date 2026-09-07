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

function tarihGGAAYYYY(gunFarki) {
  // ONEMLI: GitHub Actions sunuculari UTC kullanir. Turkiye (UTC+3) ile arada
  // fark oldugu icin, gece saatlerinde new Date().getDate() yanlis (bir onceki)
  // gunu dondurebilir. Bunun onune gecmek icin tarihi acikca Europe/Istanbul
  // saat dilimine gore hesapliyoruz. gunFarki negatifse gecmis bir gunu verir.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + (gunFarki || 0));
  const formatter = new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const parcalar = formatter.formatToParts(d);
  const gg = parcalar.find((p) => p.type === "day").value;
  const aa = parcalar.find((p) => p.type === "month").value;
  const yyyy = parcalar.find((p) => p.type === "year").value;
  return gg + "." + aa + "." + yyyy;
}

function bugunTarihGGAAYYYY() {
  return tarihGGAAYYYY(0);
}

// EPDK bazen "bugunun" verisini henuz yayinlamamis oluyor (bildirimler gun
// icinde/ertesi gun tamamlaniyor olabilir). Bu yuzden sorguyu tek gun yerine
// SON 3 GUNLUK bir aralikla yapiyoruz, sonra veri islerken her il/yakit icin
// o araliktaki EN GUNCEL tarihi otomatik seciyoruz - "bugun" bossa sessizce
// "dun"e, o da bossa "evvelsi gune" duser.
const SORGU_ARALIGI_GUN = 3;

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
  // Petrol raporu buyuk (35.000+ satir) oldugundan sunucunun hazirlayip
  // indirmeye baslamasi uzun surebilir; LPG'ye gore cok daha comert bir
  // zaman asimi veriyoruz (2 dakika).
  const zamanAsimi = Date.now() + 120000;
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

async function sayfayiSorgulaVeIndir(browser, url, indirmeKlasoru, baslangicTarih, bitisTarih, hataAyiklamaAdi) {
  const sayfa = await browser.newPage();
  try {
    await sayfa.setViewport({ width: 1280, height: 900 });
    console.log("Aciliyor: " + url);
    await sayfa.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // Index'e degil, kutunun yanindaki etiket metnine gore bul - sayfada aralarda
    // gizli/baska metin kutulari (ornegin ozel acilir menu bilesenleri) olsa bile
    // saglam calisir.
    async function etiketeGoreTarihKutusuBul(etiket) {
      const elemanlar = await sayfa.$$("xpath/" + "//*[contains(text(), '" + etiket + "')]/following::input[1]");
      if (!elemanlar.length) throw new Error("'" + etiket + "' etiketine ait kutu bulunamadi.");
      return elemanlar[0];
    }

    const baslangicKutusu = await etiketeGoreTarihKutusuBul("Başlangıç Tarihi");
    const bitisKutusu = await etiketeGoreTarihKutusuBul("Bitiş Tarihi");

    await baslangicKutusu.click({ clickCount: 3 });
    await baslangicKutusu.type(baslangicTarih, { delay: 30 });
    // Baslangic'ta bir takvim acilmis olabilir - baska bir yere tiklayip kapat.
    await sayfa.keyboard.press("Escape").catch(() => {});
    await bekle(400);

    // Bitis Tarihi kutusu iki farkli sekilde calisabilir:
    //  A) Duz metin kutusu (LPG sayfasi gibi) - direkt yazilabilir.
    //  B) Tiklaninca acilan bir takvim widget'i (Petrol sayfasi gibi) -
    //     yazi kabul etmez, gunun uzerine TIKLAMAK gerekir.
    // Once takvim varsa gunu tiklamayi deniyoruz; yoksa yazma yontemine geciyoruz.
    const gunSayisi = String(parseInt(bitisTarih.split(".")[0], 10));

    async function takvimdenGunuTikla() {
      const gunLinkleri = await sayfa.$$("xpath/" + "//a[normalize-space(text())='" + gunSayisi + "']");
      if (gunLinkleri.length) {
        await gunLinkleri[0].click();
        return true;
      }
      const gunHucreleri = await sayfa.$$("xpath/" + "//td[normalize-space(text())='" + gunSayisi + "']");
      if (gunHucreleri.length) {
        await gunHucreleri[0].click();
        return true;
      }
      return false;
    }

    await bitisKutusu.click({ clickCount: 3 });
    await bekle(400);

    const takvimdenSecildi = await takvimdenGunuTikla();
    if (takvimdenSecildi) {
      console.log("Bitis Tarihi takvimden secildi (gun: " + gunSayisi + ").");
      await bekle(400);
    } else {
      console.log("Takvimde tiklanacak gun bulunamadi, duz yazma yontemine geciliyor.");
      await bitisKutusu.click({ clickCount: 3 });
      await bitisKutusu.type(bitisTarih, { delay: 30 });
      await bekle(300);
    }

    // Guvenlik icin: Bitis kutusunun gercekten dogru degeri tasidigini dogrula.
    const bitisDegeri = await sayfa.evaluate((el) => el.value, bitisKutusu);
    if (bitisDegeri !== bitisTarih) {
      console.log("Bitis Tarihi hala yanlis (" + bitisDegeri + "), DOM uzerinden zorla duzeltiliyor...");
      await sayfa.evaluate(
        (el, deger) => {
          el.value = deger;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        },
        bitisKutusu,
        bitisTarih
      );
      await bekle(300);
    }

    const sorgulamadanOncekiBaslangic = await sayfa.evaluate((el) => el.value, baslangicKutusu);
    const sorgulamadanOncekiBitis = await sayfa.evaluate((el) => el.value, bitisKutusu);
    console.log("Sorgula'ya basmadan hemen once - Baslangic: " + sorgulamadanOncekiBaslangic + " | Bitis: " + sorgulamadanOncekiBitis);

    const sorgulaButon = await sayfa.$$("xpath/" + "//*[contains(text(), 'Sorgula')]");
    if (!sorgulaButon.length) throw new Error("'Sorgula' butonu bulunamadi.");
    await sorgulaButon[0].click();
    await sayfa.waitForNetworkIdle({ idleTime: 1000, timeout: 60000 }).catch(() => {});
    await bekle(2000);

    // Sorgu sonrasi ekranda "Kayit Bulunamadi" mi yoksa gercek tablo mu var - logla.
    const sayfaMetni = await sayfa.evaluate(() => document.body.innerText).catch(() => "");
    const kayitYok = sayfaMetni.includes("Kayıt Bulunamadı") || sayfaMetni.includes("Kayit Bulunamadi");
    console.log((hataAyiklamaAdi || url) + " - sorgu sonucu: " + (kayitYok ? "KAYIT BULUNAMADI (bos sonuc)" : "veri var gibi gorunuyor"));

    // Sorgula sonrasi ekran goruntusu - her zaman al, sorun cikarsa repo'ya commit'lenip incelenebilir.
    if (hataAyiklamaAdi) {
      try {
        await sayfa.screenshot({ path: path.join(process.cwd(), "debug-" + hataAyiklamaAdi + "-sorgu.png") });
      } catch (ssErr) { console.error("Ekran goruntusu alinamadi: " + ssErr.message); }
    }

    console.log("Rapor indiriliyor: " + url);
    const dosyaYolu = await xlsIndir(sayfa, indirmeKlasoru);
    console.log("Indirildi: " + dosyaYolu);
    return dosyaYolu;
  } catch (hata) {
    if (hataAyiklamaAdi) {
      try {
        await sayfa.screenshot({ path: path.join(process.cwd(), "debug-" + hataAyiklamaAdi + "-hata.png") });
        console.log("Hata ekran goruntusu kaydedildi: debug-" + hataAyiklamaAdi + "-hata.png");
      } catch (ssErr) { console.error("Hata ekran goruntusu alinamadi: " + ssErr.message); }
    }
    throw hata;
  } finally {
    await sayfa.close();
  }
}

async function main() {
  const { ILCE_MAP } = require("./ilce-map.js");

  // EPDK'nin ham verisinde Turkce "I" harfleri bazen bozuk geliyor (ozellikle
  // "Istanbul" - noktali "İ" yerine ASCII "I" kullanilmasi gibi). Bunu asmak
  // icin, il adlarini I/İ/ı/i farkini yok sayarak GEVSEK esletiriyoruz, ama
  // sonuc olarak HER ZAMAN ILCE_MAP'teki dogru/kanonik ismi kullaniyoruz.
  function gevsekAnahtar(ad) {
    return ad
      .toLocaleUpperCase("tr-TR")
      .replace(/[İI]/g, "I")
      .replace(/Ç/g, "C")
      .replace(/Ğ/g, "G")
      .replace(/Ö/g, "O")
      .replace(/Ş/g, "S")
      .replace(/Ü/g, "U")
      .trim();
  }
  const ilGevsekHarita = new Map();
  for (const kanonikIl of Object.keys(ILCE_MAP)) {
    ilGevsekHarita.set(gevsekAnahtar(kanonikIl), kanonikIl);
  }
  function kanonikIlAdiniBul(hamAd) {
    const normalize = ilAdiniNormalize(String(hamAd || "").trim());
    if (ILCE_MAP[normalize]) return normalize; // dogrudan eslesme - hizli yol
    return ilGevsekHarita.get(gevsekAnahtar(hamAd || "")) || null;
  }

  const bitisTarih = bugunTarihGGAAYYYY();
  const baslangicTarih = tarihGGAAYYYY(-(SORGU_ARALIGI_GUN - 1));
  console.log("Sorgulanacak aralik: " + baslangicTarih + " - " + bitisTarih);

  const indirmeKlasoruPetrol = fs.mkdtempSync(path.join(os.tmpdir(), "epdk-petrol-"));
  const indirmeKlasoruLpg = fs.mkdtempSync(path.join(os.tmpdir(), "epdk-lpg-"));

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let petrolXlsYolu, lpgXlsYolu;
  try {
    petrolXlsYolu = await sayfayiSorgulaVeIndir(browser, EPDK_PETROL_URL, indirmeKlasoruPetrol, baslangicTarih, bitisTarih, "petrol");
  } catch (err) {
    console.error("[uyari] Petrol raporu cekilemedi: " + err.message);
  }
  try {
    lpgXlsYolu = await sayfayiSorgulaVeIndir(browser, EPDK_LPG_URL, indirmeKlasoruLpg, baslangicTarih, bitisTarih, "lpg");
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

  // GG.AA.YYYY formatindaki bir tarihi siralanabilir bir sayiya cevirir (YYYYAAGG).
  function tarihSiraDegeri(ggaayyyy) {
    const parcalar = String(ggaayyyy || "").split(".");
    if (parcalar.length !== 3) return -1;
    const [gg, aa, yyyy] = parcalar;
    return parseInt(yyyy, 10) * 10000 + parseInt(aa, 10) * 100 + parseInt(gg, 10);
  }

  // Bir satir listesinde gecen EN GUNCEL tarihi bulur, sonra sadece o tarihe
  // ait satirlari dondurur. Boylece "bugun" bossa otomatik olarak "dun"e,
  // o da bossa "evvelsi gune" duser - EPDK'nin yayinlama gecikmesine karsi.
  function enGuncelGuneGoreSuz(satirlar, tarihSutunAdi) {
    let enBuyuk = -1;
    for (const satir of satirlar) {
      const deger = tarihSiraDegeri(satir[tarihSutunAdi]);
      if (deger > enBuyuk) enBuyuk = deger;
    }
    if (enBuyuk === -1) return { satirlar: [], kullanilanTarih: null };
    const suzulmus = satirlar.filter((s) => tarihSiraDegeri(s[tarihSutunAdi]) === enBuyuk);
    return { satirlar: suzulmus, kullanilanTarih: enBuyuk };
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
  let petrolSatirlari = xlsOku(petrolXlsYolu);
  if (petrolSatirlari.length) {
    const sutunlar = Object.keys(petrolSatirlari[0]);
    const ilSutun = sutunBul(sutunlar, "il");
    const yakitSutun = sutunBul(sutunlar, "yak");
    const fiyatSutun = sutunBul(sutunlar, "fiyat");
    const tarihSutun = sutunBul(sutunlar, "tarih");
    if (!ilSutun || !yakitSutun || !fiyatSutun) {
      console.error("[uyari] Petrol raporunda beklenen sutunlar bulunamadi: " + sutunlar.join(", "));
      petrolSatirlari = [];
    } else if (tarihSutun) {
      const { satirlar: suzulmus, kullanilanTarih } = enGuncelGuneGoreSuz(petrolSatirlari, tarihSutun);
      console.log("Petrol: aralikta en guncel tarih = " + kullanilanTarih + " (" + suzulmus.length + " satir kullanilacak).");
      petrolSatirlari = suzulmus;
    }
    for (const satir of petrolSatirlari) {
      const il = kanonikIlAdiniBul(satir[ilSutun]);
      const yakit = String(satir[yakitSutun] || "");
      const fiyat = parseFloat(satir[fiyatSutun]);
      if (!il || !Number.isFinite(fiyat)) continue;
      if (yakit.includes("Kurşunsuz Benzin 95")) ekle(il, "benzin", fiyat);
      else if (yakit.trim() === "Motorin" || yakit.includes("Motorin (Biodizel")) ekle(il, "motorin", fiyat);
    }
  }

  // ---- LPG raporu (sadece Otogaz - tupluu/dokme LPG farkli birim, karistirilmaz) ----
  let lpgSatirlari = xlsOku(lpgXlsYolu);
  if (lpgSatirlari.length) {
    const sutunlar = Object.keys(lpgSatirlari[0]);
    const ilSutun = sutunBul(sutunlar, "il");
    const yakitSutun = sutunBul(sutunlar, "yak");
    const fiyatSutun = sutunBul(sutunlar, "fiyat");
    const tarihSutun = sutunBul(sutunlar, "geçerlilik") || sutunBul(sutunlar, "tarih");
    if (!ilSutun || !yakitSutun || !fiyatSutun) {
      console.error("[uyari] LPG raporunda beklenen sutunlar bulunamadi: " + sutunlar.join(", "));
      lpgSatirlari = [];
    } else if (tarihSutun) {
      const { satirlar: suzulmus, kullanilanTarih } = enGuncelGuneGoreSuz(lpgSatirlari, tarihSutun);
      console.log("LPG: aralikta en guncel tarih = " + kullanilanTarih + " (" + suzulmus.length + " satir kullanilacak).");
      lpgSatirlari = suzulmus;
    }
    for (const satir of lpgSatirlari) {
      const il = kanonikIlAdiniBul(satir[ilSutun]);
      const yakit = String(satir[yakitSutun] || "").trim();
      const fiyat = parseFloat(satir[fiyatSutun]);
      if (!il || !Number.isFinite(fiyat)) continue;
      if (yakit === "Otogaz") ekle(il, "lpg", fiyat);
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
