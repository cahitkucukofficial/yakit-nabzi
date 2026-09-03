#!/usr/bin/env node
/**
 * update-fiyatlar.js
 * ---------------------------------------------------------------------
 * Turkiye genelinde il/ilce bazinda akaryakit fiyatlarini uretir.
 *
 * ONEMLI DEGISIKLIK: il/ilce listesi artik disaridan (TurkiyeAPI) her
 * calistirmada tekrar cekilmiyor - uygulamanin kendi ILCE_MAP'i ile
 * birebir ayni statik liste bu dosyanin icine gomulu. Boylece dis API
 * gecici olarak calismasa/hiz siniri koysa bile il/ilce listesi hep
 * eksiksiz kalir; sadece fiyat cekme adimi basarisiz olursa o il/ilcede
 * "veri yok" gorunur, tum liste bos kalmaz.
 *
 * Kaynak (sadece fiyat icin):
 *   hasanadiguzel.com.tr/api/akaryakit - ucretsiz, anahtarsiz. Il bazinda
 *   fiyat verir (ilce kirilimi yok), bu yuzden bir ilin tum ilcelerine o
 *   ilin ortalama fiyati uygulanir.
 *
 * Cikti: ./fiyatlar.json (uygulamanin FIYAT_JSON_URL ile cektigi dosya)
 * ---------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const CIKTI_YOLU = path.join(process.cwd(), "fiyatlar.json");
const MAKS_GECMIS = 14;
const ISTEK_ARASI_MS = 300;
const MAKS_DENEME = 2; // bir il icin gecici hatada tekrar deneme sayisi

function bekle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ILCE_MAP = {
  "Ankara": ["Merkez", "Çankaya", "Keçiören", "Yenimahalle", "Mamak", "Etimesgut", "Sincan", "Altındağ", "Pursaklar", "Gölbaşı", "Polatlı", "Beypazarı", "Çubuk", "Elmadağ", "Kazan", "Akyurt", "Kalecik", "Şereflikoçhisar", "Nallıhan", "Ayaş", "Haymana", "Kızılcahamam", "Bala", "Güdül", "Evren", "Çamlıdere"],
  "İstanbul": ["Merkez", "Adalar", "Arnavutköy", "Ataşehir", "Avcılar", "Bağcılar", "Bahçelievler", "Bakırköy", "Başakşehir", "Bayrampaşa", "Beşiktaş", "Beykoz", "Beylikdüzü", "Beyoğlu", "Büyükçekmece", "Çatalca", "Çekmeköy", "Esenler", "Esenyurt", "Eyüpsultan", "Fatih", "Gaziosmanpaşa", "Güngören", "Kadıköy", "Kağıthane", "Kartal", "Küçükçekmece", "Maltepe", "Pendik", "Sancaktepe", "Sarıyer", "Silivri", "Sultanbeyli", "Sultangazi", "Şile", "Şişli", "Tuzla", "Ümraniye", "Üsküdar", "Zeytinburnu"],
  "İzmir": ["Merkez", "Konak", "Karşıyaka", "Bornova", "Buca", "Bayraklı", "Çiğli", "Gaziemir", "Balçova", "Narlıdere", "Güzelbahçe", "Karabağlar", "Bergama", "Aliağa", "Menemen", "Foça", "Dikili", "Kınık", "Kemalpaşa", "Torbalı", "Menderes", "Selçuk", "Tire", "Ödemiş", "Bayındır", "Kiraz", "Beydağ", "Urla", "Çeşme", "Karaburun", "Seferihisar"],
  "Adana": ["Merkez", "Seyhan", "Çukurova", "Yüreğir", "Sarıçam", "Aladağ", "Ceyhan", "Feke", "İmamoğlu", "Karaisalı", "Karataş", "Kozan", "Pozantı", "Saimbeyli", "Tufanbeyli", "Yumurtalık"],
  "Adıyaman": ["Merkez", "Besni", "Çelikhan", "Gerger", "Gölbaşı", "Kahta", "Samsat", "Sincik", "Tut"],
  "Afyonkarahisar": ["Merkez", "Başmakçı", "Bayat", "Bolvadin", "Çay", "Çobanlar", "Dazkırı", "Dinar", "Emirdağ", "Evciler", "Hocalar", "İhsaniye", "İscehisar", "Kızılören", "Sandıklı", "Sinanpaşa", "Sultandağı", "Şuhut"],
  "Ağrı": ["Merkez", "Diyadin", "Doğubayazıt", "Eleşkirt", "Hamur", "Patnos", "Taşlıçay", "Tutak"],
  "Amasya": ["Merkez", "Göynücek", "Gümüşhacıköy", "Hamamözü", "Merzifon", "Suluova", "Taşova"],
  "Antalya": ["Merkez", "Muratpaşa", "Kepez", "Konyaaltı", "Aksu", "Döşemealtı", "Alanya", "Elmalı", "Finike", "Gazipaşa", "Gündoğmuş", "İbradı", "Kaş", "Kemer", "Korkuteli", "Kumluca", "Manavgat", "Serik", "Demre", "Akseki"],
  "Artvin": ["Merkez", "Ardanuç", "Arhavi", "Borçka", "Hopa", "Murgul", "Şavşat", "Yusufeli", "Kemalpaşa"],
  "Aydın": ["Merkez", "Efeler", "Bozdoğan", "Buharkent", "Çine", "Didim", "Germencik", "İncirliova", "Karacasu", "Karpuzlu", "Koçarlı", "Köşk", "Kuşadası", "Kuyucak", "Nazilli", "Söke", "Sultanhisar", "Yenipazar"],
  "Balıkesir": ["Merkez", "Altıeylül", "Karesi", "Ayvalık", "Bandırma", "Bigadiç", "Burhaniye", "Dursunbey", "Edremit", "Erdek", "Gömeç", "Gönen", "Havran", "İvrindi", "Kepsut", "Manyas", "Marmara", "Savaştepe", "Sındırgı", "Susurluk", "Balya"],
  "Bilecik": ["Merkez", "Bozüyük", "Gölpazarı", "İnhisar", "Osmaneli", "Pazaryeri", "Söğüt", "Yenipazar"],
  "Bingöl": ["Merkez", "Adaklı", "Genç", "Karlıova", "Kiğı", "Solhan", "Yayladere", "Yedisu"],
  "Bitlis": ["Merkez", "Adilcevaz", "Ahlat", "Güroymak", "Hizan", "Mutki", "Tatvan"],
  "Bolu": ["Merkez", "Dörtdivan", "Gerede", "Göynük", "Kıbrıscık", "Mengen", "Mudurnu", "Seben", "Yeniçağa"],
  "Burdur": ["Merkez", "Ağlasun", "Altınyayla", "Bucak", "Çavdır", "Çeltikçi", "Gölhisar", "Karamanlı", "Kemer", "Tefenni", "Yeşilova"],
  "Bursa": ["Merkez", "Osmangazi", "Nilüfer", "Yıldırım", "Gemlik", "İnegöl", "Mudanya", "Gürsu", "Kestel", "Mustafakemalpaşa", "Karacabey", "Orhangazi", "İznik", "Orhaneli", "Keles", "Harmancık", "Büyükorhan", "Yenişehir"],
  "Çanakkale": ["Merkez", "Ayvacık", "Bayramiç", "Biga", "Bozcaada", "Çan", "Eceabat", "Ezine", "Gelibolu", "Gökçeada", "Lapseki", "Yenice"],
  "Çankırı": ["Merkez", "Atkaracalar", "Bayramören", "Çerkeş", "Eldivan", "Ilgaz", "Kızılırmak", "Korgun", "Kurşunlu", "Orta", "Şabanözü", "Yapraklı"],
  "Çorum": ["Merkez", "Alaca", "Bayat", "Boğazkale", "Dodurga", "İskilip", "Kargı", "Laçin", "Mecitözü", "Oğuzlar", "Ortaköy", "Osmancık", "Sungurlu", "Uğurludağ"],
  "Denizli": ["Merkez", "Pamukkale", "Merkezefendi", "Acıpayam", "Babadağ", "Baklan", "Bekilli", "Beyağaç", "Bozkurt", "Buldan", "Çal", "Çameli", "Çardak", "Çivril", "Güney", "Honaz", "Kale", "Sarayköy", "Serinhisar", "Tavas"],
  "Diyarbakır": ["Merkez", "Kayapınar", "Bağlar", "Yenişehir", "Sur", "Bismil", "Çermik", "Çınar", "Çüngüş", "Dicle", "Eğil", "Ergani", "Hani", "Hazro", "Kocaköy", "Kulp", "Lice", "Silvan"],
  "Edirne": ["Merkez", "Enez", "Havsa", "İpsala", "Keşan", "Lalapaşa", "Meriç", "Süloğlu", "Uzunköprü"],
  "Elazığ": ["Merkez", "Ağın", "Alacakaya", "Arıcak", "Baskil", "Karakoçan", "Keban", "Kovancılar", "Maden", "Palu", "Sivrice"],
  "Erzincan": ["Merkez", "Çayırlı", "İliç", "Kemah", "Kemaliye", "Otlukbeli", "Refahiye", "Tercan", "Üzümlü"],
  "Erzurum": ["Merkez", "Yakutiye", "Palandöken", "Aziziye", "Aşkale", "Çat", "Hınıs", "Horasan", "İspir", "Karaçoban", "Karayazı", "Köprüköy", "Narman", "Oltu", "Olur", "Pasinler", "Pazaryolu", "Şenkaya", "Tekman", "Tortum", "Uzundere"],
  "Eskişehir": ["Merkez", "Tepebaşı", "Odunpazarı", "Alpu", "Beylikova", "Çifteler", "Günyüzü", "Han", "İnönü", "Mahmudiye", "Mihalgazi", "Mihalıççık", "Sarıcakaya", "Seyitgazi", "Sivrihisar"],
  "Gaziantep": ["Merkez", "Şahinbey", "Şehitkamil", "Nizip", "Araban", "İslahiye", "Karkamış", "Nurdağı", "Oğuzeli", "Yavuzeli"],
  "Giresun": ["Merkez", "Alucra", "Bulancak", "Çamoluk", "Çanakçı", "Dereli", "Doğankent", "Espiye", "Eynesil", "Görele", "Güce", "Keşap", "Piraziz", "Şebinkarahisar", "Tirebolu", "Yağlıdere"],
  "Gümüşhane": ["Merkez", "Kelkit", "Köse", "Kürtün", "Şiran", "Torul"],
  "Hakkari": ["Merkez", "Çukurca", "Şemdinli", "Yüksekova"],
  "Hatay": ["Merkez", "Antakya", "Defne", "Arsuz", "Altınözü", "Belen", "Dörtyol", "Erzin", "Hassa", "İskenderun", "Kırıkhan", "Kumlu", "Payas", "Reyhanlı", "Samandağ", "Yayladağı"],
  "Isparta": ["Merkez", "Aksu", "Atabey", "Eğirdir", "Gelendost", "Gönen", "Keçiborlu", "Senirkent", "Sütçüler", "Şarkikaraağaç", "Uluborlu", "Yalvaç", "Yenişarbademli"],
  "Mersin": ["Merkez", "Akdeniz", "Mezitli", "Toroslar", "Yenişehir", "Anamur", "Aydıncık", "Bozyazı", "Çamlıyayla", "Erdemli", "Gülnar", "Mut", "Silifke", "Tarsus"],
  "Kars": ["Merkez", "Akyaka", "Arpaçay", "Digor", "Kağızman", "Sarıkamış", "Selim", "Susuz"],
  "Kastamonu": ["Merkez", "Abana", "Ağlı", "Araç", "Azdavay", "Bozkurt", "Cide", "Çatalzeytin", "Daday", "Devrekani", "Doğanyurt", "Hanönü", "İhsangazi", "İnebolu", "Küre", "Pınarbaşı", "Seydiler", "Şenpazar", "Taşköprü", "Tosya"],
  "Kayseri": ["Merkez", "Melikgazi", "Kocasinan", "Talas", "Develi", "Bünyan", "Felahiye", "Hacılar", "İncesu", "Özvatan", "Pınarbaşı", "Sarıoğlan", "Sarız", "Tomarza", "Yahyalı", "Yeşilhisar", "Akkışla"],
  "Kırklareli": ["Merkez", "Babaeski", "Demirköy", "Kofçaz", "Lüleburgaz", "Pehlivanköy", "Pınarhisar", "Vize"],
  "Kırşehir": ["Merkez", "Akçakent", "Akpınar", "Boztepe", "Çiçekdağı", "Kaman", "Mucur"],
  "Kocaeli": ["Merkez", "İzmit", "Gebze", "Darıca", "Gölcük", "Körfez", "Derince", "Kartepe", "Çayırova", "Başiskele", "Karamürsel", "Kandıra", "Dilovası"],
  "Konya": ["Merkez", "Selçuklu", "Meram", "Karatay", "Ahırlı", "Akören", "Akşehir", "Altınekin", "Beyşehir", "Bozkır", "Cihanbeyli", "Çeltik", "Çumra", "Derbent", "Derebucak", "Doğanhisar", "Emirgazi", "Ereğli", "Güneysınır", "Hadim", "Halkapınar", "Hüyük", "Ilgın", "Kadınhanı", "Karapınar", "Kulu", "Sarayönü", "Seydişehir", "Taşkent", "Tuzlukçu", "Yalıhüyük", "Yunak"],
  "Kütahya": ["Merkez", "Altıntaş", "Aslanapa", "Çavdarhisar", "Domaniç", "Dumlupınar", "Emet", "Gediz", "Hisarcık", "Pazarlar", "Simav", "Şaphane", "Tavşanlı"],
  "Malatya": ["Merkez", "Battalgazi", "Yeşilyurt", "Akçadağ", "Arapgir", "Arguvan", "Darende", "Doğanşehir", "Doğanyol", "Hekimhan", "Kale", "Kuluncak", "Pütürge", "Yazıhan"],
  "Manisa": ["Merkez", "Şehzadeler", "Yunusemre", "Akhisar", "Alaşehir", "Demirci", "Gölmarmara", "Gördes", "Kırkağaç", "Köprübaşı", "Kula", "Salihli", "Sarıgöl", "Saruhanlı", "Selendi", "Soma", "Turgutlu", "Ahmetli"],
  "Kahramanmaraş": ["Merkez", "Onikişubat", "Dulkadiroğlu", "Afşin", "Andırın", "Çağlayancerit", "Ekinözü", "Elbistan", "Göksun", "Nurhak", "Pazarcık", "Türkoğlu"],
  "Mardin": ["Merkez", "Artuklu", "Dargeçit", "Derik", "Kızıltepe", "Mazıdağı", "Midyat", "Nusaybin", "Ömerli", "Savur", "Yeşilli"],
  "Muğla": ["Merkez", "Menteşe", "Bodrum", "Fethiye", "Marmaris", "Milas", "Datça", "Dalaman", "Kavaklıdere", "Köyceğiz", "Ortaca", "Seydikemer", "Ula", "Yatağan"],
  "Muş": ["Merkez", "Bulanık", "Hasköy", "Korkut", "Malazgirt", "Varto"],
  "Nevşehir": ["Merkez", "Acıgöl", "Avanos", "Derinkuyu", "Gülşehir", "Hacıbektaş", "Kozaklı", "Ürgüp"],
  "Niğde": ["Merkez", "Altunhisar", "Bor", "Çamardı", "Çiftlik", "Ulukışla"],
  "Ordu": ["Merkez", "Altınordu", "Akkuş", "Aybastı", "Çamaş", "Çatalpınar", "Çaybaşı", "Fatsa", "Gölköy", "Gülyalı", "Gürgentepe", "İkizce", "Kabadüz", "Kabataş", "Korgan", "Kumru", "Mesudiye", "Perşembe", "Ulubey", "Ünye"],
  "Rize": ["Merkez", "Ardeşen", "Çamlıhemşin", "Çayeli", "Derepazarı", "Fındıklı", "Güneysu", "Hemşin", "İkizdere", "İyidere", "Kalkandere", "Pazar"],
  "Sakarya": ["Merkez", "Adapazarı", "Akyazı", "Arifiye", "Erenler", "Ferizli", "Geyve", "Hendek", "Karapürçek", "Karasu", "Kaynarca", "Kocaali", "Pamukova", "Sapanca", "Serdivan", "Söğütlü", "Taraklı"],
  "Samsun": ["Merkez", "İlkadım", "Atakum", "Canik", "Bafra", "Alaçam", "Asarcık", "Ayvacık", "Çarşamba", "Havza", "Kavak", "Ladik", "Ondokuzmayıs", "Salıpazarı", "Tekkeköy", "Terme", "Vezirköprü", "Yakakent"],
  "Siirt": ["Merkez", "Baykan", "Eruh", "Kurtalan", "Pervari", "Şirvan", "Tillo"],
  "Sinop": ["Merkez", "Ayancık", "Boyabat", "Dikmen", "Duraran", "Erfelek", "Gerze", "Saraydüzü", "Türkeli"],
  "Sivas": ["Merkez", "Akıncılar", "Altınyayla", "Divriği", "Doğanşar", "Gemerek", "Gölova", "Gürün", "Hafik", "İmranlı", "Kangal", "Koyulhisar", "Suşehri", "Şarkışla", "Ulaş", "Yıldızeli", "Zara"],
  "Tekirdağ": ["Merkez", "Süleymanpaşa", "Çerkezköy", "Çorlu", "Ergene", "Hayrabolu", "Kapaklı", "Malkara", "Marmaraereğlisi", "Muratlı", "Saray", "Şarköy"],
  "Tokat": ["Merkez", "Almus", "Artova", "Başçiftlik", "Erbaa", "Niksar", "Pazar", "Reşadiye", "Sulusaray", "Turhal", "Yeşilyurt", "Zile"],
  "Trabzon": ["Merkez", "Ortahisar", "Akçaabat", "Yomra", "Araklı", "Arsin", "Beşikdüzü", "Çarşıbaşı", "Çaykara", "Dernekpazarı", "Düzköy", "Hayrat", "Köprübaşı", "Maçka", "Of", "Sürmene", "Şalpazarı", "Tonya", "Vakfıkebir"],
  "Tunceli": ["Merkez", "Çemişgezek", "Hozat", "Mazgirt", "Nazımiye", "Ovacık", "Pertek", "Pülümür"],
  "Şanlıurfa": ["Merkez", "Eyyübiye", "Haliliye", "Karaköprü", "Akçakale", "Birecik", "Bozova", "Ceylanpınar", "Halfeti", "Harran", "Hilvan", "Siverek", "Suruç", "Viranşehir"],
  "Uşak": ["Merkez", "Banaz", "Eşme", "Karahallı", "Sivaslı", "Ulubey"],
  "Van": ["Merkez", "İpekyolu", "Edremit", "Erciş", "Muradiye", "Tuşba", "Bahçesaray", "Başkale", "Çaldıran", "Çatak", "Gevaş", "Gürpınar", "Özalp", "Saray"],
  "Yozgat": ["Merkez", "Akdağmadeni", "Aydıncık", "Boğazlıyan", "Çandır", "Çayıralan", "Çekerek", "Kadışehri", "Saraykent", "Sarıkaya", "Sorgun", "Şefaatli", "Yenifakılı", "Yerköy"],
  "Zonguldak": ["Merkez", "Alaplı", "Çaycuma", "Devrek", "Gökçebey", "Kilimli", "Kozlu", "Ereğli"],
  "Aksaray": ["Merkez", "Ağaçören", "Eskil", "Gülağaç", "Güzelyurt", "Ortaköy", "Sarıyahşi", "Sultanhanı"],
  "Bayburt": ["Merkez", "Aydıntepe", "Demirözü"],
  "Karaman": ["Merkez", "Ayrancı", "Başyayla", "Ermenek", "Kazımkarabekir", "Sarıveliler"],
  "Kırıkkale": ["Merkez", "Bahşılı", "Balışeyh", "Çelebi", "Delice", "Karakeçili", "Keskin", "Sulakyurt", "Yahşihan"],
  "Batman": ["Merkez", "Beşiri", "Gercüş", "Hasankeyf", "Kozluk", "Sason"],
  "Şırnak": ["Merkez", "Beytüşşebap", "Cizre", "Güçlükonak", "İdil", "Silopi", "Uludere"],
  "Bartın": ["Merkez", "Amasra", "Kurucaşile", "Ulus"],
  "Ardahan": ["Merkez", "Çıldır", "Damal", "Göle", "Hanak", "Posof"],
  "Iğdır": ["Merkez", "Aralık", "Karakoyunlu", "Tuzluca"],
  "Yalova": ["Merkez", "Altınova", "Armutlu", "Çınarcık", "Çiftlikköy", "Termal"],
  "Karabük": ["Merkez", "Eflani", "Eskipazar", "Ovacık", "Safranbolu", "Yenice"],
  "Kilis": ["Merkez", "Elbeyli", "Musabeyli", "Polateli"],
  "Osmaniye": ["Merkez", "Bahçe", "Düziçi", "Hasanbeyli", "Kadirli", "Sumbas", "Toprakkale"],
  "Düzce": ["Merkez", "Akçakoca", "Cumayeri", "Çilimli", "Gölyaka", "Gümüşova", "Kaynaşlı", "Yığılca"],
};
const ILLER = Object.keys(ILCE_MAP);

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

async function ilFiyatiniGetirTekDeneme(ilAdi) {
  const apiAdi = ilAdiniApiFormatinaCevir(ilAdi);
  const res = await fetch("http://hasanadiguzel.com.tr/api/akaryakit/sehir=" + encodeURIComponent(apiAdi), {
    headers: { "User-Agent": "yakit-nabzi-fiyat-botu/1.0" },
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const govde = await res.json();
  const kayitlar = Object.values(govde.data || {});
  if (!kayitlar.length) return null;

  const benzinler = kayitlar.map((k) => virgulluSayi(k["Kursunsuz_95(Excellium95)_TL/lt"]));
  const motorinler = kayitlar.map((k) => virgulluSayi(k["Motorin(Eurodiesel)_TL/lt"]));
  const lpgler = kayitlar.map((k) => virgulluSayi(k["Otogaz_TL/lt"]));

  return { benzin: ortalama(benzinler), motorin: ortalama(motorinler), lpg: ortalama(lpgler) };
}

async function ilFiyatiniGetir(ilAdi) {
  let sonHata = null;
  for (let deneme = 1; deneme <= MAKS_DENEME; deneme++) {
    try {
      return await ilFiyatiniGetirTekDeneme(ilAdi);
    } catch (err) {
      sonHata = err;
      if (deneme < MAKS_DENEME) await bekle(600);
    }
  }
  console.error("[uyari] " + ilAdi + " fiyati alinamadi (" + MAKS_DENEME + " deneme sonrasi): " + sonHata.message);
  return null;
}

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

function yakitAlaniOlustur(bugunFiyat, eskiKayit, yakitAdi) {
  const eskiYakit = eskiKayit ? eskiKayit[yakitAdi] : null;
  // Bugun fiyat cekilemediyse (null), eski "today" degerini koru - onu "dun"
  // yerine gecmis bir veri gibi kaybetmek yerine kullaniciya son bilinen
  // fiyati gostermeye devam ederiz.
  const kullanilacakBugun = typeof bugunFiyat === "number" ? bugunFiyat
    : (eskiYakit && typeof eskiYakit.today === "number" ? eskiYakit.today : null);
  const dun = eskiYakit && typeof eskiYakit.today === "number" ? eskiYakit.today : kullanilacakBugun;
  const eskiGecmis = eskiYakit && Array.isArray(eskiYakit.history) ? eskiYakit.history : [];

  let gecmis = eskiGecmis.length ? eskiGecmis.slice() : (typeof dun === "number" ? [dun] : []);
  if (typeof bugunFiyat === "number") gecmis.push(bugunFiyat);
  gecmis = gecmis.slice(-MAKS_GECMIS);

  return { today: kullanilacakBugun, yesterday: dun, history: gecmis };
}

/* ---------- ulusal kalibrasyon çapası ----------
   hasanadiguzel'in il bazlı fiyatları (ozellikle benzin) piyasadan sapabiliyor
   (muhtemelen premium/Excellium markali bir bayi fiyatini standart diye
   etiketliyor). Bunu duzeltmek icin ucuzyakitbul.com.tr'nin dogrulanmis,
   anahtarsiz ulusal ortalama ucunu (EPDK bazli) bir "kalibrasyon capasi"
   olarak kullaniyoruz: hasanadiguzel'den gelen tum illerin ortalamasini
   hesaplayip, bu capaya gore bir duzeltme orani uyguluyoruz. Boylece
   iller arasi goreceli fark korunur, ama mutlak seviye gercek piyasaya
   cekilir. */
const ULUSAL_FIYAT_URL = "https://ucuzyakitbul.com.tr/api/prices/national";
const FUEL_TYPE_TO_KEY = { Benzin: "benzin", Motorin: "motorin", LPG: "lpg" };

async function ulusalCapayiGetir() {
  try {
    const res = await fetch(ULUSAL_FIYAT_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const govde = await res.json();
    const cikti = {};
    for (const p of govde.prices || []) {
      const anahtar = FUEL_TYPE_TO_KEY[p.fuelType];
      if (anahtar && typeof p.price === "number") cikti[anahtar] = p.price;
    }
    return cikti;
  } catch (err) {
    console.error("[uyari] Ulusal kalibrasyon capasi alinamadi: " + err.message);
    return {};
  }
}

async function main() {
  console.log(ILLER.length + " il icin fiyat cekiliyor (il/ilce listesi statik, gomulu)...");

  console.log("Kalibrasyon capasi (ulusal ortalama) cekiliyor...");
  const ulusalCapa = await ulusalCapayiGetir();
  console.log("Ulusal capa: " + JSON.stringify(ulusalCapa));

  const eskiVeri = eskiVeriyiOku();
  const hamIlFiyatlari = {}; // il adi -> {benzin, motorin, lpg} (duzeltilmemis)
  let basariliIl = 0;

  for (const il of ILLER) {
    const ilFiyati = await ilFiyatiniGetir(il);
    if (ilFiyati) basariliIl++;
    hamIlFiyatlari[il] = ilFiyati;
    await bekle(ISTEK_ARASI_MS);
  }

  // Duzeltme orani: hasanadiguzel'in tum illerdeki ortalamasi ile
  // ucuzyakitbul'un dogrulanmis ulusal ortalamasinin orani.
  const oranlar = {};
  for (const yakit of ["benzin", "motorin"]) {
    const degerler = Object.values(hamIlFiyatlari)
      .map((f) => (f ? f[yakit] : null))
      .filter((v) => typeof v === "number");
    const hasanOrtalama = degerler.length ? degerler.reduce((a, b) => a + b, 0) / degerler.length : null;
    if (hasanOrtalama && ulusalCapa[yakit]) {
      oranlar[yakit] = ulusalCapa[yakit] / hasanOrtalama;
      console.log(yakit + ": hasanadiguzel ortalamasi=" + hasanOrtalama.toFixed(2) + ", ulusal capa=" + ulusalCapa[yakit] + ", duzeltme orani=" + oranlar[yakit].toFixed(4));
    } else {
      oranlar[yakit] = 1; // duzeltme yapilamiyorsa oldugu gibi birak
      console.log(yakit + ": duzeltme uygulanamadi (veri yetersiz), ham deger kullanilacak.");
    }
  }

  const ilceler = [];
  for (const il of ILLER) {
    const ilFiyati = hamIlFiyatlari[il];
    const duzeltilmis = ilFiyati
      ? {
          benzin: typeof ilFiyati.benzin === "number" ? Math.round(ilFiyati.benzin * oranlar.benzin * 100) / 100 : null,
          motorin: typeof ilFiyati.motorin === "number" ? Math.round(ilFiyati.motorin * oranlar.motorin * 100) / 100 : null,
          // LPG icin il bazli veri hic gelmiyor; dogrulanmis ulusal ortalamayi
          // tum illere uyguluyoruz (bu, "veri yok" gostermekten daha faydali).
          lpg: typeof ulusalCapa.lpg === "number" ? ulusalCapa.lpg : null,
        }
      : { benzin: null, motorin: null, lpg: typeof ulusalCapa.lpg === "number" ? ulusalCapa.lpg : null };

    for (const ilceAdi of ILCE_MAP[il]) {
      const eskiKayit = eskiVeri.get(il + "|" + ilceAdi) || null;
      ilceler.push({
        il,
        ilce: ilceAdi,
        benzin: yakitAlaniOlustur(duzeltilmis.benzin, eskiKayit, "benzin"),
        motorin: yakitAlaniOlustur(duzeltilmis.motorin, eskiKayit, "motorin"),
        lpg: yakitAlaniOlustur(duzeltilmis.lpg, eskiKayit, "lpg"),
      });
    }
  }

  const cikti = {
    guncelleme: new Date().toISOString(),
    not: "Fiyatlar il bazinda ortalamadir; bir ildeki tum ilcelere ayni deger uygulanir. Benzin/motorin, ucuzyakitbul.com.tr'nin dogrulanmis ulusal ortalamasina gore olceklenir (kaynak: hasanadiguzel.com.tr, il bazli). LPG icin il bazli kaynak olmadigindan dogrulanmis ulusal ortalama tum illere uygulanir. Bir il icin bugun veri cekilemediyse son bilinen fiyat korunur.",
    ilceler,
  };

  fs.writeFileSync(CIKTI_YOLU, JSON.stringify(cikti, null, 2), "utf-8");
  console.log("Yazildi: " + CIKTI_YOLU + " - " + ilceler.length + " ilce, " + basariliIl + "/" + ILLER.length + " il icin BUGUN fiyati bulundu (digerleri son bilinen fiyati korudu).");
}

main().catch((err) => {
  console.error("Beklenmeyen hata:", err);
  process.exit(1);
});
