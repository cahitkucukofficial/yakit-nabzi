#!/usr/bin/env node
/**
 * update-fiyatlar.js
 * ---------------------------------------------------------------------
 * Turkiye genelinde il/ilce bazinda akaryakit fiyatlarini uretir.
 *
 * Kaynaklar:
 *  1) Il/ilce listesi: TurkiyeAPI (https://api.turkiyeapi.dev) - ucretsiz,
 *     anahtarsiz, resmi acik kaynak API. Gercek il/ilce isimlerini verir.
 *  2) Fiyat: hasanadiguzel.com.tr/api/akaryakit - ucretsiz, anahtarsiz.
 *     Bu API il bazinda fiyat verir (ilce kirilimi yok), bu yuzden bir
 *     ilin tum ilcelerine o ilin ortalama fiyati uygulanir. Gercek ilce
 *     bazli fiyat icin ucuzyakitbul.com.tr API anahtari alindiginda bu
 *     script'in fiyat cekme kismi degistirilip il/ilce listesi aynen
 *     korunabilir.
 *
 * Cikti: ./fiyatlar.json (uygulamanin FIYAT_JSON_URL ile cektigi dosya)
 * ---------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const CIKTI_YOLU = path.join(process.cwd(), "fiyatlar.json");
const MAKS_GECMIS = 14; // ilce basina saklanacak gunluk fiyat sayisi
const ISTEK_ARASI_MS = 250; // hasanadiguzel'e ardisik istekler arasi bekleme

function bekle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function virgulluSayi(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function ortalama(sayilar) {
  const gecerli = sayilar.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (!gecerli.length) return null;
  const toplam = gecerli.reduce((a, b) => a + b, 0);
  return Math.round((toplam / gecerli.length) * 100) / 100;
}

// Turkce karakterleri hasanadiguzel API'sinin bekledigi sade Latin buyuk harfe cevirir.
function ilAdiniApiFormatinaCevir(ad) {
  const harfler = { ç: "c", Ç: "C", ğ: "g", Ğ: "G", ı: "i", İ: "I", ö: "o", Ö: "O", ş: "s", Ş: "S", ü: "u", Ü: "U" };
  const sade = ad.replace(/[çÇğĞıİöÖşŞüÜ]/g, (h) => harfler[h] || h);
  return sade.toLocaleUpperCase("en-US");
}

async function ilListesiniGetir() {
  const res = await fetch("https://api.turkiyeapi.dev/v2/provinces?fields=id,name&limit=100");
  if (!res.ok) throw new Error("TurkiyeAPI il listesi alinamadi (" + res.status + ")");
  const gövde = await res.json();
  return (gövde.data || []).map((p) => ({ id: p.id, ad: p.name }));
}

async function ilceListesiniGetir(ilId) {
  const res = await fetch("https://api.turkiyeapi.dev/v2/districts?provinceId=" + ilId + "&fields=id,name&limit=100");
  if (!res.ok) throw new Error("TurkiyeAPI ilce listesi alinamadi (il " + ilId + ", " + res.status + ")");
  const gövde = await res.json();
  return (gövde.data || []).map((d) => d.name);
}

async function ilFiyatiniGetir(ilAdi) {
  const apiAdi = ilAdiniApiFormatinaCevir(ilAdi);
  const res = await fetch("http://hasanadiguzel.com.tr/api/akaryakit/sehir=" + encodeURIComponent(apiAdi), {
    headers: { "User-Agent": "yakit-nabzi-fiyat-botu/1.0" },
  });
  if (!res.ok) throw new Error("hasanadiguzel yaniti basarisiz (" + ilAdi + ", " + res.status + ")");
  const gövde = await res.json();
  const kayitlar = Object.values(gövde.data || {});
  if (!kayitlar.length) return null;

  const benzinler = kayitlar.map((k) => virgulluSayi(k["Kursunsuz_95(Excellium95)_TL/lt"]));
  const motorinler = kayitlar.map((k) => virgulluSayi(k["Motorin(Eurodiesel)_TL/lt"]));
  const lpgler = kayitlar.map((k) => virgulluSayi(k["Otogaz_TL/lt"]));

  return {
    benzin: ortalama(benzinler),
    motorin: ortalama(motorinler),
    lpg: ortalama(lpgler),
  };
}

function eskiVeriyiOku() {
  try {
    const ham = fs.readFileSync(CIKTI_YOLU, "utf-8");
    const veri = JSON.parse(ham);
    const harita = new Map();
    for (const d of veri.ilceler || []) {
      harita.set(d.il + "|" + d.ilce, d);
    }
    return harita;
  } catch {
    return new Map(); // dosya yok ya da bozuk - ilk calistirma gibi davran
  }
}

function yakitAlaniOlustur(bugunFiyat, eskiKayit, yakitAdi) {
  const eskiYakit = eskiKayit ? eskiKayit[yakitAdi] : null;
  const dun = eskiYakit && typeof eskiYakit.today === "number" ? eskiYakit.today : bugunFiyat;
  const eskiGecmis = eskiYakit && Array.isArray(eskiYakit.history) ? eskiYakit.history : [];

  let gecmis = eskiGecmis.length ? eskiGecmis.slice() : [dun];
  if (typeof bugunFiyat === "number") {
    gecmis.push(bugunFiyat);
  }
  gecmis = gecmis.slice(-MAKS_GECMIS);

  return {
    today: bugunFiyat,
    yesterday: dun,
    history: gecmis,
  };
}

async function main() {
  console.log("Il listesi cekiliyor (TurkiyeAPI)...");
  const iller = await ilListesiniGetir();
  console.log(iller.length + " il bulundu.");

  const eskiVeri = eskiVeriyiOku();
  const ilceler = [];
  let basariliIl = 0;

  for (const il of iller) {
    let ilceAdlari = [];
    let ilFiyati = null;

    try {
      ilceAdlari = await ilceListesiniGetir(il.id);
    } catch (err) {
      console.error("[uyari] " + il.ad + " ilceleri alinamadi: " + err.message);
      continue;
    }

    try {
      ilFiyati = await ilFiyatiniGetir(il.ad);
    } catch (err) {
      console.error("[uyari] " + il.ad + " fiyati alinamadi: " + err.message);
    }

    if (ilFiyati) basariliIl++;

    for (const ilceAdi of ilceAdlari) {
      const eskiKayit = eskiVeri.get(il.ad + "|" + ilceAdi) || null;
      ilceler.push({
        il: il.ad,
        ilce: ilceAdi,
        benzin: yakitAlaniOlustur(ilFiyati ? ilFiyati.benzin : null, eskiKayit, "benzin"),
        motorin: yakitAlaniOlustur(ilFiyati ? ilFiyati.motorin : null, eskiKayit, "motorin"),
        lpg: yakitAlaniOlustur(ilFiyati ? ilFiyati.lpg : null, eskiKayit, "lpg"),
      });
    }

    await bekle(ISTEK_ARASI_MS);
  }

  const cikti = {
    guncelleme: new Date().toISOString(),
    not: "Fiyatlar il bazinda ortalamadir; bir ildeki tum ilcelere ayni deger uygulanir.",
    ilceler,
  };

  fs.writeFileSync(CIKTI_YOLU, JSON.stringify(cikti, null, 2), "utf-8");
  console.log("Yazildi: " + CIKTI_YOLU + " - " + ilceler.length + " ilce, " + basariliIl + "/" + iller.length + " il icin fiyat bulundu.");
}

main().catch((err) => {
  console.error("Beklenmeyen hata:", err);
  process.exit(1);
});
