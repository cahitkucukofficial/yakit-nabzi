const { useState, useEffect, useMemo, useCallback, useRef } = React;

/* =========================================================================
   YAKIT NABZI — Türkiye geneli akaryakıt fiyat değişim takipçisi
   3 sekme: Şehirler (il/ilçe seçimi) · Değişim (günlük takip + uyarılar)
   · Hakkında (indir, puan ver, gizlilik, bildirimler, paylaş)
   ========================================================================= */

/* ---------- kalıcı depolama katmanı ----------
   window.storage sadece Claude.ai'nin artifact önizleyicisinde bulunur.
   Bağımsız/yayınlanmış uygulamada aynı arayüzü (get/set/delete/list) veren,
   localStorage tabanlı bir karşılık koyuyoruz — böylece geri kalan kod
   (persistFavorites, persistAlerts, persistPrefs, vb.) değişmeden çalışır.
   Not: React Native / Capacitor'a taşırken bu bloğu AsyncStorage veya
   Capacitor Preferences ile değiştirmek yeterli, çağrı yapan kodun
   hiçbirine dokunmanıza gerek yok. */
if (typeof window !== "undefined" && !window.storage) {
  const NS = "yakitNabzi:"; // localStorage anahtar çakışmalarını önlemek için
  window.storage = {
    async get(key, shared = false) {
      try {
        const raw = window.localStorage.getItem(NS + (shared ? "shared:" : "") + key);
        if (raw === null) return null;
        return { key, value: raw, shared: !!shared };
      } catch (e) {
        throw new Error("storage.get başarısız: " + e.message);
      }
    },
    async set(key, value, shared = false) {
      try {
        window.localStorage.setItem(NS + (shared ? "shared:" : "") + key, value);
        return { key, value, shared: !!shared };
      } catch (e) {
        // Örn. localStorage kotası dolduğunda (QuotaExceededError) buraya düşer
        throw new Error("storage.set başarısız: " + e.message);
      }
    },
    async delete(key, shared = false) {
      try {
        window.localStorage.removeItem(NS + (shared ? "shared:" : "") + key);
        return { key, deleted: true, shared: !!shared };
      } catch (e) {
        throw new Error("storage.delete başarısız: " + e.message);
      }
    },
    async list(prefix = "", shared = false) {
      try {
        const base = NS + (shared ? "shared:" : "");
        const keys = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith(base + prefix)) keys.push(k.slice(base.length));
        }
        return { keys, prefix, shared: !!shared };
      } catch (e) {
        throw new Error("storage.list başarısız: " + e.message);
      }
    },
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
function fmtTL(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDelta(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "veri yok";
  const v = Math.abs(round2(n));
  if (v < 0.02) return "sabit";
  return (n > 0 ? "+" : "−") + v.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ---------- deterministik sahte-rastgele yardımcılar (Sonraki Değişim kartı için) ---------- */
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
function rnd(seed) {
  const x = Math.sin(seed * 999.77) * 10000;
  return x - Math.floor(x);
}
function seededRange(seed, min, max) {
  return min + rnd(seed) * (max - min);
}
function todayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}
function nextMidnight() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}
function fmtEffectiveDate(d) {
  return d.toLocaleDateString("tr-TR", { day: "numeric", month: "long" }) + " 00:00";
}
function buildNextChange(fuelKey) {
  const seed = hashStr(todayKey() + "|" + fuelKey);
  const r = rnd(seed);
  if (r < 0.6) return { expected: false };
  const direction = rnd(seed + 1) < 0.5 ? "artis" : "dusus";
  const amount = round2(seededRange(seed + 2, 0.25, 1.4));
  return { expected: true, direction, amount };
}
const NEXT_CHANGE_DATE = nextMidnight();
const NEXT_CHANGE = Object.fromEntries(["motorin", "benzin", "lpg"].map((k) => [k, buildNextChange(k)]));

/* ---------- il / ilçe iskeleti (örnek kapsama alanı) ---------- */
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

/* ---------- canlı veri katmanı (statik JSON) ----------
   Fiyatlar artık istemcide üretilmiyor. Siz (veya veriyi besleyen script'iniz)
   günde bir kez "fiyatlar.json" adlı bir dosya yayınlıyorsunuz; uygulama da
   açılışta bunu tek bir fetch ile çekiyor. Veritabanı, SQL, API anahtarı
   gerekmiyor.

   EN BASİT BARINDIRMA: bir GitHub deposuna fiyatlar.json dosyasını koyup
   "raw.githubusercontent.com" linkini kullanmak — her push'ta otomatik
   güncellenir, ücretsizdir, HTTPS'dir (Store gereksinimi). Dosyayı
   düzenli güncellemek istediğinizde deponuza yeni bir commit atmanız yeterli.
   Alternatif: aynı dosyayı Vercel'de statik olarak barındırmak da olur.

   Beklenen JSON biçimi:
   {
     "guncelleme": "2026-08-29T00:15:00+03:00",
     "ilceler": [
       { "il": "Ankara", "ilce": "Çankaya",
         "benzin": { "today": 75.26, "yesterday": 75.23, "history": [73.9,74.1,...,75.26] },
         "motorin": { "today": 78.53, "yesterday": 83.83, "history": [...] },
         "lpg": { "today": 33.89, "yesterday": 33.89, "history": [...] } },
       ...
     ]
   }
   "history" alanı opsiyoneldir; verilmezse sadece dün/bugün ile 2 noktalı
   bir çizgi gösterilir. */
const FIYAT_JSON_URL = "https://cahitkucukofficial.github.io/yakit-nabzi/fiyatlar.json";

function normalizeFuel(f) {
  const veriVar = typeof f.today === "number" && typeof f.yesterday === "number";
  const history = f.history && f.history.length ? f.history.filter((v) => typeof v === "number") : [f.yesterday, f.today].filter((v) => typeof v === "number");
  return {
    today: f.today,
    yesterday: f.yesterday,
    delta: veriVar ? round2(f.today - f.yesterday) : null,
    history: history.length ? history : [0],
  };
}

async function fetchFiyatlar() {
  const res = await fetch(FIYAT_JSON_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("Fiyat verisi çekilemedi (" + res.status + ")");
  const data = await res.json();
  return {
    guncelleme: data.guncelleme || null,
    districts: (data.ilceler || []).map((d) => ({
      id: d.il + "|" + d.ilce,
      il: d.il,
      ilce: d.ilce,
      benzin: normalizeFuel(d.benzin),
      motorin: normalizeFuel(d.motorin),
      lpg: normalizeFuel(d.lpg),
    })),
  };
}

/* ---------- haberler ----------
   fiyatlar.json ile aynı desen: statik bir JSON dosyası, günde birkaç kez
   GitHub Actions tarafından BİRDEN FAZLA RSS kaynağından süzülüp
   birleştiriliyor (bkz. scripts/fetch-haberler.js). Her habere hangi
   ajanstan geldiğini belirten bir "kaynak" alanı ekleniyor, böylece
   uygulama kaynağa göre etiket/filtre gösterebiliyor.

   Beklenen JSON biçimi:
   {
     "guncelleme": "2026-09-01T00:12:00+03:00",
     "kaynaklar": ["AA", "İHA", "DHA"],
     "haberler": [
       { "baslik": "...", "ozet": "...", "link": "https://...",
         "tarih": "2026-08-31T21:40:00+03:00", "kaynak": "AA" },
       ...
     ]
   } */
const HABER_JSON_URL = "https://cahitkucukofficial.github.io/yakit-nabzi/haberler.json";

async function fetchHaberler() {
  const res = await fetch(HABER_JSON_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("Haberler çekilemedi (" + res.status + ")");
  const data = await res.json();
  const haberler = (data.haberler || []).map((h, i) => ({
    id: h.link || String(i),
    baslik: h.baslik,
    ozet: h.ozet,
    link: h.link,
    tarih: h.tarih,
    kaynak: h.kaynak || null,
  }));
  const kaynaklar = data.kaynaklar && data.kaynaklar.length
    ? data.kaynaklar
    : Array.from(new Set(haberler.map((h) => h.kaynak).filter(Boolean)));
  return { guncelleme: data.guncelleme || null, haberler, kaynaklar };
}

/* "Ulusal Nabız" widget'ı için gerçek, anahtarsız Türkiye ortalaması.
   Kaynak: ucuzyakitbul.com.tr — EPDK ve dağıtıcı şirket verilerine dayanıyor,
   API anahtarı gerektirmez (günde 60 istek/IP sınırı yeterlidir).
   Not: bu uç sadece "bugün" değerini verir, "dün" hâlâ il/ilçe verisinden
   hesaplanan ortalamadan geliyor. */
const ULUSAL_FIYAT_URL = "https://ucuzyakitbul.com.tr/api/prices/national";
const FUEL_TYPE_TO_KEY = { "Benzin": "benzin", "Motorin": "motorin", "LPG": "lpg" };

async function fetchUlusalFiyat() {
  const res = await fetch(ULUSAL_FIYAT_URL);
  if (!res.ok) throw new Error("Ulusal fiyat çekilemedi (" + res.status + ")");
  const data = await res.json();
  const out = {};
  for (const p of data.prices || []) {
    const key = FUEL_TYPE_TO_KEY[p.fuelType];
    if (key) out[key] = p.price;
  }
  return out;
}

const FUEL_META = {
  motorin: { label: "Motorin", color: "var(--motorin)" },
  benzin: { label: "Benzin", color: "var(--benzin)" },
  lpg: { label: "LPG - Otogaz", color: "var(--lpg)" },
};

/* ---------- seçmeli temalar ----------
   Her tema, .app-root üzerinde tanımlı CSS değişkenlerini eleyle
   üzerine yazar (inline style, harici stylesheet'ten önceliklidir). */
const THEMES = {
  ios: {
    name: "iOS Native",
    swatch: ["#1C1C1E", "#FF9500", "#0A84FF"],
    vars: {
      "--sayfa": "#E4E4E7", "--panel": "#EFEFF1", "--panel-2": "#E3E3E6", "--panel-3": "#D7D7DB",
      "--kenar": "#D3D3D7", "--aksan": "#1C1C1E",
      "--motorin": "#1C1C1E", "--benzin": "#FF9500", "--lpg": "#0A84FF", "--zam": "#FF3B30", "--indirim": "#34C759",
      "--bilgi": "#5E5CE6", "--notr": "#8E8E93", "--metin": "#1C1C1E", "--metin-soluk": "#8A8A8E", "--metin-silik": "#B0B0B5",
      "--vurgu-panel": "#1C1C1E", "--vurgu-panel-alt": "#33383D", "--vurgu-panel-metin": "#F2F2F7", "--vurgu-panel-metin-soluk": "#9AA0A6",
      "--font-display": "'Space Grotesk',sans-serif", "--font-body": "'Manrope',sans-serif",
      "--font-mono": "'JetBrains Mono',monospace", "--font-poster": "'Anton',sans-serif",
      "--radius-card": "14px", "--card-border": "none", "--tabbar-bg": "rgba(249,249,249,0.94)",
    },
  },
  defter: {
    name: "Defter / Ajanda",
    swatch: ["#3A3226", "#B5673A", "#E3DAC6"],
    vars: {
      "--sayfa": "#F4EFE4", "--panel": "#FDFBF6", "--panel-2": "#EDE6D6", "--panel-3": "#E3DAC6",
      "--kenar": "#E3DAC6", "--aksan": "#B5673A",
      "--motorin": "#3A3226", "--benzin": "#B5673A", "--lpg": "#5B7A8C", "--zam": "#A3271C", "--indirim": "#4C8C6B",
      "--bilgi": "#8B7CF6", "--notr": "#9A8F78", "--metin": "#2E2A22", "--metin-soluk": "#8A7F68", "--metin-silik": "#B7AC94",
      "--vurgu-panel": "#3A3226", "--vurgu-panel-alt": "#4F4436", "--vurgu-panel-metin": "#FDF6E8", "--vurgu-panel-metin-soluk": "#C9BBA0",
      "--font-display": "'DM Serif Display',serif", "--font-body": "'Manrope',sans-serif",
      "--font-mono": "'JetBrains Mono',monospace", "--font-poster": "'DM Serif Display',serif",
      "--radius-card": "18px", "--card-border": "1px solid #E3DAC6", "--tabbar-bg": "rgba(244,239,228,0.94)",
      "--bg-pattern": "radial-gradient(#E3DAC6 1px, transparent 1px)", "--bg-pattern-size": "15px 15px",
    },
  },
  retro: {
    name: "Pompa Retro",
    swatch: ["#3D2A17", "#E08B22", "#2E6E6E"],
    vars: {
      "--sayfa": "#F2E4C8", "--panel": "#FFF7E6", "--panel-2": "#EAD9B0", "--panel-3": "#DEC98F",
      "--kenar": "#C9AE7C", "--aksan": "#B5432A",
      "--motorin": "#3D2A17", "--benzin": "#E08B22", "--lpg": "#2E6E6E", "--zam": "#B5432A", "--indirim": "#2E6E6E",
      "--bilgi": "#8B5E3C", "--notr": "#8a6640", "--metin": "#3D2A17", "--metin-soluk": "#8a6640", "--metin-silik": "#B79A6E",
      "--vurgu-panel": "#5A3212", "--vurgu-panel-alt": "#6E4420", "--vurgu-panel-metin": "#FFF3DD", "--vurgu-panel-metin-soluk": "#D9B98A",
      "--font-display": "'Fraunces',serif", "--font-body": "'Manrope',sans-serif",
      "--font-mono": "'JetBrains Mono',monospace", "--font-poster": "'Fraunces',serif",
      "--radius-card": "22px", "--card-border": "3px solid #5A3212", "--tabbar-bg": "rgba(242,228,200,0.94)",
    },
  },
  pastel: {
    name: "Sade Pastel / Cam",
    swatch: ["#6B6390", "#E8956B", "#6BA9C9"],
    vars: {
      "--sayfa": "#F1E9F2", "--panel": "rgba(255,255,255,0.6)", "--panel-2": "rgba(255,255,255,0.4)", "--panel-3": "rgba(255,255,255,0.75)",
      "--kenar": "rgba(255,255,255,0.7)", "--aksan": "#8F7FBF",
      "--motorin": "#6B6390", "--benzin": "#E8956B", "--lpg": "#6BA9C9", "--zam": "#E8748A", "--indirim": "#7BC4A4",
      "--bilgi": "#8F7FBF", "--notr": "#A79CC0", "--metin": "#3A3550", "--metin-soluk": "#8B84A6", "--metin-silik": "#C3BEDA",
      "--vurgu-panel": "#4A4266", "--vurgu-panel-alt": "#5C5480", "--vurgu-panel-metin": "#F3EEFB", "--vurgu-panel-metin-soluk": "#B7AED6",
      "--font-display": "'Sora',sans-serif", "--font-body": "'Manrope',sans-serif",
      "--font-mono": "'JetBrains Mono',monospace", "--font-poster": "'Sora',sans-serif",
      "--radius-card": "22px", "--card-border": "1px solid rgba(255,255,255,0.7)", "--tabbar-bg": "rgba(255,255,255,0.55)",
    },
  },
  saha: {
    name: "Saha / Parke",
    swatch: ["#0F1D3D", "#7E8C76", "#F2C230"],
    vars: {
      "--sayfa": "#DCD3B8", "--panel": "#F3ECD9", "--panel-2": "#DACD9F", "--panel-3": "#CBBB8C",
      "--kenar": "#BBAA78", "--aksan": "#F2C230",
      "--motorin": "#0F1D3D", "--benzin": "#C08A34", "--lpg": "#5C7A67", "--zam": "#8C3B2E", "--indirim": "#5C7A67",
      "--bilgi": "#3E5C76", "--notr": "#8F8570", "--metin": "#0F1D3D", "--metin-soluk": "#5B5340", "--metin-silik": "#B7AC94",
      "--vurgu-panel": "#0F1D3D", "--vurgu-panel-alt": "#1C2F55", "--vurgu-panel-metin": "#F8F1DD", "--vurgu-panel-metin-soluk": "#B9C2D9",
      "--font-display": "'Fraunces',serif", "--font-body": "'Manrope',sans-serif",
      "--font-mono": "'JetBrains Mono',monospace", "--font-poster": "'Oswald',sans-serif",
      "--radius-card": "10px", "--card-border": "1px solid rgba(15,29,61,0.16)", "--tabbar-bg": "rgba(220,211,184,0.94)",
      "--bg-pattern": "linear-gradient(135deg, rgba(126,140,118,0.30) 0%, rgba(126,140,118,0.30) 50%, rgba(196,178,138,0.30) 50%, rgba(196,178,138,0.30) 100%)",
      "--bg-pattern-size": "auto",
    },
  },
};
const THEME_ORDER = ["ios", "defter", "retro", "pastel", "saha"];

/* "Ajanda" teması için seçilebilir vurgu rengi — gerçek Defter uygulamasının
   Stil menüsündeki 5 seçeneğe birebir karşılık gelir. */
const ACCENTS = {
  terrakota: { name: "Terrakota", hex: "#B5673A" },
  altin: { name: "Altın", hex: "#B08C2E" },
  turkuaz: { name: "Turkuaz", hex: "#2E7C7C" },
  gul: { name: "Gül", hex: "#9C4A57" },
  adacayi: { name: "Adaçayı", hex: "#4C8C6B" },
};
const ACCENT_ORDER = ["terrakota", "altin", "turkuaz", "gul", "adacayi"];
const FUEL_ORDER = ["motorin", "benzin", "lpg"];


/* ---------- ikonlar (SF Symbols benzeri, çizgi ikonlar) ---------- */
const Icon = {
  palette: (p) => (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.9 1.2-1.9-.3-.6-.1-1.3.5-1.6.4-.2.8-.2 1.2 0 1.7.8 3.6-.5 3.6-2.4C18.5 10.8 15.6 3 12 3z" />
      <circle cx="7.5" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
  pump: (p) => (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4 21V6a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v15" />
      <path d="M4 21h9" />
      <path d="M15 8h1.5L19 10v6a1.5 1.5 0 0 0 3 0V9.5L19.5 6" />
      <path d="M7 6v4h4V6" />
    </svg>
  ),
  trend: (p) => (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4 16l5-5 4 4 7-8" />
      <path d="M14 7h6v6" />
    </svg>
  ),
  star: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill={p.filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" {...p}>
      <path d="M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.7z" />
    </svg>
  ),
  bell: (p) => (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9z" />
      <path d="M9.5 17a2.5 2.5 0 0 0 5 0" />
    </svg>
  ),
  info: (p) => (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6" />
      <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  chevronRight: (p) => (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M9 5l7 7-7 7" />
    </svg>
  ),
  chevronDown: (p) => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  back: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  ),
  search: (p) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.3-4.3" />
    </svg>
  ),
  check: (p) => (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M5 12l5 5 9-10" />
    </svg>
  ),
  download: (p) => (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 4v11" />
      <path d="M7.5 11L12 15.5 16.5 11" />
      <path d="M5 19h14" />
    </svg>
  ),
  share: (p) => (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 15V4" />
      <path d="M7.5 8L12 3.5 16.5 8" />
      <path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" />
    </svg>
  ),
  lock: (p) => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  ),
  send: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 19V6" />
      <path d="M6 12l6-6 6 6" />
    </svg>
  ),
  close: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  news: (p) => (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H16v14.5A1.5 1.5 0 0 1 14.5 20H5.5A1.5 1.5 0 0 1 4 18.5v-13Z" />
      <path d="M16 8h2.5A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5H14" />
      <path d="M7 8h6M7 11.5h6M7 15h4" />
    </svg>
  ),
};

/* ---------- ortak parçalar ---------- */
function DeltaTag({ delta }) {
  const veriYok = delta === null || delta === undefined || Number.isNaN(delta);
  const flat = !veriYok && Math.abs(delta) < 0.02;
  const up = !veriYok && delta > 0;
  const cls = veriYok ? "delta flat" : flat ? "delta flat" : up ? "delta up" : "delta down";
  const arrow = veriYok ? "•" : flat ? "•" : up ? "▲" : "▼";
  return <span className={cls}>{arrow} {fmtDelta(delta)}</span>;
}

function NextChangeCard({ fuelKey }) {
  const meta = FUEL_META[fuelKey];
  const nc = NEXT_CHANGE[fuelKey];
  let statusText;
  if (!nc.expected) {
    statusText = "Değişim beklenmiyor";
  } else {
    const yon = nc.direction === "artis" ? "zam" : "indirim";
    statusText = fmtTL(nc.amount) + " ₺ " + yon + " bekleniyor";
  }
  return (
    <div className="next-change-card">
      <div className="next-change-top">
        <span className="next-change-fuel" style={{ color: meta.color }}>{meta.label}</span>
        <span className={"next-change-status" + (nc.expected ? " active" : "")}>
          <Icon.info className="nc-info" />
          {statusText}
        </span>
      </div>
      {nc.expected && (
        <div className="next-change-date">Yürürlük: {fmtEffectiveDate(NEXT_CHANGE_DATE)}</div>
      )}
    </div>
  );
}

function NextChangeSection() {
  return (
    <div className="ios-section">
      <div className="ios-section-header">Sonraki Değişim</div>
      <div className="next-change-list">
        {FUEL_ORDER.map((k) => <NextChangeCard key={k} fuelKey={k} />)}
      </div>
      <div className="ios-section-footer">
        Fiyatlar günde bir kez, gece yarısından sonra yürürlüğe girer. Bir sonraki güncelleme: {fmtEffectiveDate(NEXT_CHANGE_DATE)}.
      </div>
    </div>
  );
}

function Sparkline({ values, color }) {
  const w = 74, h = 26, pad = 2;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = pad + (i * (w - pad * 2)) / (values.length - 1);
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    })
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={"0 0 " + w + " " + h}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FlipNumber({ text }) {
  return (
    <span className="flipnum">
      {text.split("").map((ch, i) => <span className="flipdigit" key={text + i}>{ch}</span>)}
    </span>
  );
}

function PulseWidget({ mode, onToggle, nat }) {
  return (
    <div className="pulse-widget" onClick={onToggle} role="button" aria-label="Bugün / dün karşılaştır">
      <div className="pulse-top">
        <span className="pulse-title">Ulusal Nabız</span>
        <span className="pulse-mode">{mode === "today" ? "Bugün" : "Dün"}</span>
      </div>
      <div className="pulse-row">
        {FUEL_ORDER.map((key) => {
          const meta = FUEL_META[key];
          return (
            <div className="pulse-cell" key={key}>
              <div className="pulse-fuel" style={{ color: meta.color }}>{meta.label}</div>
              <div className="pulse-price" style={{ color: meta.color }}>
                <FlipNumber text={typeof nat[key] === "number" ? nat[key].toFixed(2) : "—"} />
                <span className="pulse-cur">₺</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Segmented({ options, value, onChange }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={"seg-btn" + (value === o.value ? " active" : "")} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function IosSwitch({ checked, onChange }) {
  return (
    <button
      className={"ios-switch" + (checked ? " on" : "")}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      aria-pressed={checked}
    >
      <span className="knob" />
    </button>
  );
}

function IconBadge({ color, children }) {
  return <span className="icon-badge" style={{ background: color }}>{children}</span>;
}

function SettingsRow({ icon, color, label, onClick, trailing }) {
  return (
    <div
      className="ios-row settings-row"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (onClick && (e.key === "Enter" || e.key === " ")) onClick(); }}
    >
      <span className="settings-left">
        <IconBadge color={color}>{icon}</IconBadge>
        <span className="ios-row-title">{label}</span>
      </span>
      {trailing !== undefined ? trailing : <Icon.chevronRight className="chev" />}
    </div>
  );
}

function IosSection({ header, footer, children }) {
  return (
    <div className="ios-section">
      {header && <div className="ios-section-header">{header}</div>}
      <div className="ios-card">{children}</div>
      {footer && <div className="ios-section-footer">{footer}</div>}
    </div>
  );
}

/* ---------- şehir seçici (açılır sayfa) ---------- */
const BUYUKSEHIRLER = ["Ankara", "İstanbul", "İzmir"];

function CityPicker({ open, current, onClose, onSelect }) {
  const [query, setQuery] = useState("");
  useEffect(() => { if (open) setQuery(""); }, [open]);

  const q = query.toLocaleLowerCase("tr-TR");
  const filtered = ILLER.filter((n) => n.toLocaleLowerCase("tr-TR").includes(q));

  // Arama boşken büyükşehirler en üstte sabit kalır, ayrı bölüm oluşturur
  const pinned = query ? [] : BUYUKSEHIRLER.filter((n) => filtered.includes(n));
  const rest = filtered.filter((n) => !pinned.includes(n));
  const sorted = [...rest].sort((a, b) => a.localeCompare(b, "tr"));
  const grouped = {};
  sorted.forEach((n) => {
    const l = n[0].toLocaleUpperCase("tr-TR");
    (grouped[l] = grouped[l] || []).push(n);
  });

  return (
    <div className={"sheet-overlay" + (open ? " open" : "")} onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grabber" />
        <div className="sheet-header">Şehir Seçin</div>
        <div className="ios-search">
          <Icon.search />
          <input placeholder="Şehir ara" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="sheet-list">
          {pinned.length > 0 && (
            <div>
              <div className="ios-section-header sticky">Büyükşehirler</div>
              <div className="ios-card">
                {pinned.map((n) => (
                  <button key={n} className="ios-row" onClick={() => { onSelect(n); onClose(); }}>
                    <span className="ios-row-title">{n}</span>
                    {n === current && <Icon.check className="check-icon" />}
                  </button>
                ))}
              </div>
            </div>
          )}
          {Object.entries(grouped).map(([letter, names]) => (
            <div key={letter}>
              <div className="ios-section-header sticky">{letter}</div>
              <div className="ios-card">
                {names.map((il) => (
                  <button className="ios-row" key={il} onClick={() => { onSelect(il); onClose(); }}>
                    <span className="ios-row-title">{il}</span>
                    {il === current && <Icon.check className="check-icon" />}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {sorted.length === 0 && <div className="empty">Eşleşen şehir yok.</div>}
        </div>
      </div>
    </div>
  );
}

/* ---------- üç sütunlu ilçe kartı (Şehirler sekmesi) ---------- */
function DistrictCard({ d, favorites, toggleFav, onOpen, showIl }) {
  return (
    <IosSection
      header={
        <div className="district-header">
          <span>{d.ilce}{showIl && <span className="dim"> · {d.il}</span>}</span>
          <button className={"fav-btn" + (favorites.has(d.id) ? " on" : "")} onClick={(e) => { e.stopPropagation(); toggleFav(d.id); }}>
            <Icon.star filled={favorites.has(d.id)} />
          </button>
        </div>
      }
    >
      <button className="ios-row three-col" onClick={() => onOpen(d)}>
        {FUEL_ORDER.map((key) => {
          const f = d[key], meta = FUEL_META[key];
          return (
            <div className="fuel-col" key={key}>
              <div className="fuel-col-label" style={{ color: meta.color }}>{meta.label}</div>
              <div className="fuel-col-price" style={{ color: meta.color }}>{fmtTL(f.today)}</div>
              <DeltaTag delta={f.delta} />
            </div>
          );
        })}
      </button>
    </IosSection>
  );
}

function SehirlerView({ allDistricts, selectedIl, setPickerOpen, favorites, toggleFav, onOpenDistrict }) {
  const [query, setQuery] = useState("");
  const q = query.toLocaleLowerCase("tr-TR").trim();

  // Boş arama kutusunda sadece seçili şehrin ilçeleri; arama varsa tüm Türkiye'de ilçe adına göre ara
  const districts = (q
    ? allDistricts.filter((d) => d.ilce.toLocaleLowerCase("tr-TR").includes(q))
    : allDistricts.filter((d) => d.il === selectedIl)
  ).slice().sort((a, b) => a.ilce.localeCompare(b.ilce, "tr"));

  return (
    <>
      <IosSection>
        <button className="ios-row" onClick={() => setPickerOpen(true)}>
          <span className="ios-row-title">Şehir</span>
          <span className="ios-row-value">{selectedIl} <Icon.chevronDown /></span>
        </button>
      </IosSection>
      <div className="ios-search district-search">
        <Icon.search />
        <input placeholder="İlçe ara (tüm Türkiye)" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {q && (
        <div className="search-hint">
          "{query}" için {districts.length} sonuç
        </div>
      )}
      {districts.length === 0 && <div className="empty">Eşleşen ilçe yok.</div>}
      {districts.map((d) => (
        <DistrictCard key={d.id} d={d} favorites={favorites} toggleFav={toggleFav} onOpen={onOpenDistrict} showIl={!!q} />
      ))}
    </>
  );
}

function DistrictSheet({ open, d, favorites, toggleFav, goCreateAlert, onClose }) {
  const lastRef = useRef(null);
  if (d) lastRef.current = d;
  const shown = d || lastRef.current;
  return (
    <div className={"sheet-overlay" + (open ? " open" : "")} onClick={onClose}>
      <div className="sheet district-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grabber" />
        {shown && (
          <>
            <div className="sheet-header">{shown.ilce} · {shown.il}</div>
            <div className="sheet-list">
            <IosSection>
              <div className="detail-card">
                <div>
                  <div className="detail-title">{shown.ilce}</div>
                  <div className="detail-sub">{shown.il}</div>
                </div>
                <div className="detail-card-actions">
                  <button className={"fav-btn big" + (favorites.has(shown.id) ? " on" : "")} onClick={() => toggleFav(shown.id)}>
                    <Icon.star filled={favorites.has(shown.id)} />
                  </button>
                  <button className="rating-close" onClick={onClose}><Icon.close /></button>
                </div>
              </div>
            </IosSection>

            <IosSection header="Yakıt Fiyatları">
              {FUEL_ORDER.map((key) => {
                const f = shown[key], meta = FUEL_META[key];
                return (
                  <div className="ios-row fuel-detail-row" key={key}>
                    <div>
                      <div className="fuel-detail-name" style={{ color: meta.color }}>{meta.label}</div>
                      <div className="fuel-detail-price" style={{ color: meta.color }}>{fmtTL(f.today)} ₺</div>
                      <div className="fuel-detail-yest">Dün: {fmtTL(f.yesterday)} ₺</div>
                    </div>
                    <div className="fuel-detail-right">
                      <Sparkline values={f.history} color={meta.color} />
                      <DeltaTag delta={f.delta} />
                    </div>
                  </div>
                );
              })}
            </IosSection>

            <div className="ios-btn-wrap">
              <button className="ios-btn" onClick={() => goCreateAlert(shown)}>Bu ilçe için uyarı kur</button>
            </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- Değişim sekmesi: liderler + takip + uyarılar ---------- */
function LeaderRow({ d, fuelKey, onOpen }) {
  return (
    <button className="ios-row leader-row" onClick={() => onOpen(d)}>
      <div>
        <div className="ios-row-title">{d.ilce}</div>
        <div className="dim small">{d.il}</div>
      </div>
      <div className="leader-right">
        <span className="leader-price">{fmtTL(d[fuelKey].today)} ₺</span>
        <DeltaTag delta={d[fuelKey].delta} />
      </div>
    </button>
  );
}

function AlertsSection({ alerts, addAlert, removeAlert, prefill }) {
  const [il, setIl] = useState(prefill?.il || ILLER[0]);
  const [ilce, setIlce] = useState(prefill?.ilce || ILCE_MAP[ILLER[0]][0]);
  const [fuel, setFuel] = useState("motorin");
  const [direction, setDirection] = useState("herhangi");
  const [threshold, setThreshold] = useState("");

  useEffect(() => {
    if (prefill) { setIl(prefill.il); setIlce(prefill.ilce); }
  }, [prefill]);

  useEffect(() => {
    if (!ILCE_MAP[il].includes(ilce)) setIlce(ILCE_MAP[il][0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [il]);

  return (
    <>
      <IosSection header="Yeni Uyarı">
        <div className="ios-row form-line">
          <label>Şehir</label>
          <select value={il} onChange={(e) => setIl(e.target.value)}>
            {ILLER.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="ios-row form-line">
          <label>İlçe</label>
          <select value={ilce} onChange={(e) => setIlce(e.target.value)}>
            {ILCE_MAP[il].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="ios-row form-line">
          <label>Yakıt</label>
          <select value={fuel} onChange={(e) => setFuel(e.target.value)}>
            {FUEL_ORDER.map((k) => <option key={k} value={k}>{FUEL_META[k].label}</option>)}
          </select>
        </div>
        <div className="ios-row form-line">
          <label>Yön</label>
          <select value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="herhangi">Her değişim</option>
            <option value="artis">Sadece zam</option>
            <option value="dusus">Sadece indirim</option>
          </select>
        </div>
        <div className="ios-row form-line">
          <label>Eşik (₺, ops.)</label>
          <input className="form-input" placeholder="örn. 1.00" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </div>
      </IosSection>

      <div className="ios-btn-wrap">
        <button
          className="ios-btn"
          onClick={() => {
            addAlert({
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              il, ilce, fuel, direction,
              threshold: threshold ? parseFloat(threshold.replace(",", ".")) : null,
            });
            setThreshold("");
          }}
        >
          Uyarı Oluştur
        </button>
      </div>

      <IosSection header="Kurulu Uyarılar" footer="Uyarılar bu cihazda saklanır. Gerçek anlık bildirim için sunucu tarafında senkronizasyon ve push servisi gerekir — bkz. Hakkında › Veri Kaynağı.">
        {alerts.length === 0 && <div className="ios-row"><span className="dim">Henüz kurulu uyarı yok.</span></div>}
        {alerts.map((a) => (
          <div className="ios-row alert-row" key={a.id}>
            <div>
              <div className="ios-row-title">{FUEL_META[a.fuel].label} · {a.ilce}, {a.il}</div>
              <div className="dim small">
                {a.direction === "artis" ? "Sadece zam" : a.direction === "dusus" ? "Sadece indirim" : "Her değişim"}
                {a.threshold ? " · eşik " + a.threshold.toLocaleString("tr-TR") + " ₺" : ""}
              </div>
            </div>
            <button className="del-btn" onClick={() => removeAlert(a.id)}>Sil</button>
          </div>
        ))}
      </IosSection>
    </>
  );
}

function DegisimView({ districts, totemMode, setTotemMode, fuelFilter, setFuelFilter, favorites, districtsMap, toggleFav, onOpenDistrict, alerts, addAlert, removeAlert, alertPrefill, ulusalBugun }) {
  const sorted = [...districts].sort((a, b) => b[fuelFilter].delta - a[fuelFilter].delta);
  const gainers = sorted.filter((d) => d[fuelFilter].delta > 0.02).slice(0, 3);
  const losers = [...sorted].reverse().filter((d) => d[fuelFilter].delta < -0.02).slice(0, 3);
  const favList = [...favorites].map((id) => districtsMap[id]).filter(Boolean).sort((a, b) => a.ilce.localeCompare(b.ilce, "tr"));

  // Ulusal ortalama — "dün" il/ilçe verisinin ortalamasından hesaplanıyor;
  // "bugün" ise mevcutsa gerçek, anahtarsız ulusal API'den geliyor (daha güncel).
  const nat = useMemo(() => {
    const sums = { benzin: [0, 0, 0], motorin: [0, 0, 0], lpg: [0, 0, 0] }; // [todayToplam, yesterdayToplam, gecerliSayisi]
    for (const d of districts) {
      for (const k of FUEL_ORDER) {
        const f = d[k];
        if (typeof f.today === "number" && typeof f.yesterday === "number") {
          sums[k][0] += f.today; sums[k][1] += f.yesterday; sums[k][2] += 1;
        }
      }
    }
    const today = {}, yesterday = {};
    for (const k of FUEL_ORDER) {
      const n = sums[k][2] || 1;
      today[k] = ulusalBugun?.[k] ?? (sums[k][2] ? round2(sums[k][0] / n) : null);
      yesterday[k] = sums[k][2] ? round2(sums[k][1] / n) : null;
    }
    return { today, yesterday };
  }, [districts, ulusalBugun]);

  return (
    <>
      <NextChangeSection />
      <PulseWidget mode={totemMode} nat={nat[totemMode]} onToggle={() => setTotemMode((m) => (m === "today" ? "yesterday" : "today"))} />
      <Segmented options={FUEL_ORDER.map((k) => ({ value: k, label: FUEL_META[k].label }))} value={fuelFilter} onChange={setFuelFilter} />

      <IosSection header="Bugün En Çok Zamlananlar">
        {gainers.length === 0 && <div className="ios-row"><span className="dim">Bugün bu yakıtta zam yok.</span></div>}
        {gainers.map((d) => <LeaderRow key={d.id} d={d} fuelKey={fuelFilter} onOpen={onOpenDistrict} />)}
      </IosSection>

      <IosSection header="Bugün En Çok İnenler">
        {losers.length === 0 && <div className="ios-row"><span className="dim">Bugün bu yakıtta indirim yok.</span></div>}
        {losers.map((d) => <LeaderRow key={d.id} d={d} fuelKey={fuelFilter} onOpen={onOpenDistrict} />)}
      </IosSection>

      <IosSection header="Takip Ettiklerim">
        {favList.length === 0 && <div className="ios-row"><span className="dim">Şehirler sekmesinde bir ilçenin yıldızına dokun.</span></div>}
        {favList.map((d) => (
          <button className="ios-row takip-row" key={d.id} onClick={() => onOpenDistrict(d)}>
            <div className="ios-row-title">{d.ilce} <span className="dim">· {d.il}</span></div>
            <div className="takip-prices">
              {FUEL_ORDER.map((key) => <span key={key} style={{ color: FUEL_META[key].color }}>{fmtTL(d[key].today)}</span>)}
            </div>
          </button>
        ))}
      </IosSection>

      <AlertsSection alerts={alerts} addAlert={addAlert} removeAlert={removeAlert} prefill={alertPrefill} />
    </>
  );
}

/* ---------- Hakkında sekmesi ---------- */
/* ---------- Haberler sekmesi ---------- */
function fmtHaberTarih(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("tr-TR", { day: "numeric", month: "long" }) + " · " +
    d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}

function HaberCard({ h }) {
  return (
    <a className="haber-card" href={h.link} target="_blank" rel="noopener noreferrer">
      <div className="haber-baslik">{h.baslik}</div>
      {h.ozet && <div className="haber-ozet">{h.ozet}</div>}
      <div className="haber-alt">
        <span className="haber-alt-left">
          {h.kaynak && <span className="haber-kaynak">{h.kaynak}</span>}
          <span className="haber-tarih">{fmtHaberTarih(h.tarih)}</span>
        </span>
        <span className="haber-devam">Habere git <Icon.chevronRight className="chev" /></span>
      </div>
    </a>
  );
}

function HaberlerView({ haberler, guncelleme, kaynaklar }) {
  const [aktifKaynak, setAktifKaynak] = useState("hepsi");
  const gosterilen = aktifKaynak === "hepsi" ? haberler : haberler.filter((h) => h.kaynak === aktifKaynak);
  return (
    <>
      {kaynaklar && kaynaklar.length > 1 && (
        <div className="kaynak-filtre">
          <button
            className={"kaynak-chip" + (aktifKaynak === "hepsi" ? " on" : "")}
            onClick={() => setAktifKaynak("hepsi")}
          >
            Hepsi
          </button>
          {kaynaklar.map((k) => (
            <button
              key={k}
              className={"kaynak-chip" + (aktifKaynak === k ? " on" : "")}
              onClick={() => setAktifKaynak(k)}
            >
              {k}
            </button>
          ))}
        </div>
      )}
      <IosSection header="Akaryakıt Gündemi">
        {gosterilen.length === 0 ? (
          <div className="empty">Şu anda gösterilecek bir haber yok.</div>
        ) : (
          <div className="haber-list">
            {gosterilen.map((h) => <HaberCard key={h.id} h={h} />)}
          </div>
        )}
        {guncelleme && (
          <div className="ios-section-footer">Son güncelleme: {fmtHaberTarih(guncelleme)}. Başlıklar birden fazla ajansın RSS beslemesinden otomatik süzülür; yorum ya da analiz içermez.</div>
        )}
      </IosSection>
    </>
  );
}

function KaynakContent() {
  return (
    <>
      <IosSection header="Fiyatlar Nereden Geliyor">
        <div className="ios-row text-row">
          İl bazlı benzin ve motorin fiyatları hasanadiguzel.com.tr'nin herkese açık
          akaryakıt API'sinden çekiliyor. LPG için il bazlı bir kaynak bulunmadığından,
          tüm illere aynı ulusal ortalama uygulanıyor.
        </div>
        <div className="ios-row text-row">
          Bir ildeki tüm ilçelere şu an için o ilin tek bir ortalama fiyatı uygulanıyor;
          yani aynı ildeki ilçeler arasında henüz gerçek bir fark gösterilmiyor. Bu,
          kullandığımız kaynağın ilçe kırılımı vermemesinden kaynaklanıyor — ilçe bazlı
          gerçek veri sağlayan bir kaynağa (başvurusu yapılmış durumda) geçildiğinde bu
          sınırlama kalkacak.
        </div>
      </IosSection>
      <IosSection header="Doğrulama / Kalibrasyon">
        <div className="ios-row text-row">
          hasanadiguzel'in il bazlı rakamları zaman zaman piyasadan sapabildiği için,
          ucuzyakitbul.com.tr'nin EPDK bazlı, doğrulanmış ulusal ortalama fiyatı bir
          "kalibrasyon çapası" olarak kullanılıyor: hasanadiguzel'den gelen 81 ilin
          ortalaması bu çapayla karşılaştırılıp bir düzeltme oranı hesaplanıyor, sonra
          bu oran her ile uygulanıyor. Böylece iller arası göreceli fark korunurken genel
          seviye gerçek piyasaya yakın tutuluyor.
        </div>
        <div className="ios-row text-row">
          Bir il için o günkü veri hiç çekilemezse, o ilin son bilinen fiyatı korunur;
          veri aniden kaybolmaz.
        </div>
      </IosSection>
      <IosSection header="Nasıl Çalışıyor">
        <div className="ios-row text-row">
          Uygulama fiyatları istemcide üretmiyor; açılışta tek bir JSON dosyasını
          (fiyatlar.json) çekip gösteriyor. Bu dosya, GitHub Actions üzerinde otomatik
          çalışan bir script tarafından günde birkaç kez yeniden üretilip yayınlanıyor;
          uygulama her açılışta o dosyanın en güncel halini indirir.
        </div>
      </IosSection>
      <IosSection header="Planlanan İyileştirme">
        <div className="ios-row text-row">
          Gerçek istasyon/ilçe bazlı fiyat veren bir API için başvuru yapıldı; onay
          geldiğinde il ortalaması yerine gerçek ilçe bazlı fiyatlar gösterilecek ve
          kalibrasyon adımına artık gerek kalmayacak.
        </div>
      </IosSection>
    </>
  );
}

function PrivacyContent() {
  return (
    <IosSection header="Gizlilik İlkesi">
      <div className="ios-row text-row">
        Bu uygulama bir prototiptir ve kişisel hiçbir veriyi bir sunucuya göndermez. Takip
        listen, kurduğun uyarılar, bildirim tercihin ve verdiğin puan yalnızca bu cihazda/
        hesapta saklanır; bunlar hiçbir zaman bizimle veya üçüncü bir tarafla paylaşılmaz.
      </div>
      <div className="ios-row text-row">
        Şehirler ve Değişim sekmelerindeki fiyat verileri ile Haberler sekmesindeki başlıklar,
        GitHub Actions üzerinde otomatik çalışan script'lerle üretilip GitHub Pages'te herkese
        açık, anonim JSON dosyaları (fiyatlar.json, haberler.json) olarak yayınlanır; uygulama
        bu dosyaları sadece okur. Bu süreçte hangi cihazın, hangi kullanıcının ne zaman
        baktığına dair hiçbir kayıt tutulmaz.
      </div>
      <div className="ios-row text-row">
        Haberler sekmesindeki başlıklar, birden fazla haber ajansının (ör. AA, İHA, DHA)
        herkese açık RSS beslemelerinden otomatik süzülür; her başlığın yanında hangi
        ajanstan geldiği belirtilir. İçerik yorum ya da analiz eklenmeden, olduğu gibi
        gösterilir.
      </div>
      <div className="ios-row text-row">
        Adın, konumun veya kimliğini belirleyen herhangi bir bilgi toplanmaz. "Paylaş"
        özelliği cihazının kendi paylaşım menüsünü kullanır; ayrı bir sunucuya veri iletmez.
      </div>
      <div className="ios-row text-row">
        Gerçek bir yayına çıkmadan önce bu metnin, kullanılan gerçek altyapıya (özellikle
        resmi/ücretli fiyat API'sine geçildiğinde) göre bir hukuk danışmanınca güncellenmesi
        gerekir.
      </div>
    </IosSection>
  );
}

/* ---------- tema seçici (açılır sayfa) ---------- */
function ThemePicker({ open, current, onClose, onSelect, accent, onSelectAccent }) {
  return (
    <div className={"sheet-overlay" + (open ? " open" : "")} onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grabber" />
        <div className="sheet-header">Görünüm</div>
        <div className="sheet-list">
          <div className="ios-card">
            {THEME_ORDER.map((key) => {
              const t = THEMES[key];
              return (
                <button key={key} className="ios-row theme-row" onClick={() => onSelect(key)}>
                  <span className="theme-row-left">
                    <span className="theme-swatch">
                      {t.swatch.map((c, i) => <span key={i} style={{ background: c }} />)}
                    </span>
                    <span className="ios-row-title">{t.name}</span>
                  </span>
                  {key === current && <Icon.check className="check-icon" />}
                </button>
              );
            })}
          </div>

          <div className="ios-section-header sticky">Vurgu Rengi</div>
          <div className="ios-card">
            {ACCENT_ORDER.map((key) => {
              const a = ACCENTS[key];
              return (
                <button key={key} className="ios-row theme-row" onClick={() => onSelectAccent(key)}>
                  <span className="theme-row-left">
                    <span className="accent-dot" style={{ background: a.hex }} />
                    <span className="ios-row-title">{a.name}</span>
                  </span>
                  {key === accent && <Icon.check className="check-icon" />}
                </button>
              );
            })}
          </div>
          <div className="ios-section-footer">Seçtiğin görünüm bu cihazda kaydedilir.</div>
        </div>
      </div>
    </div>
  );
}

/* Formspree'ye kaydolup (https://formspree.io) kendi form endpoint'ini
   olusturduktan sonra asagidaki URL'yi kendi endpoint'inle degistir.
   Ornek: "https://formspree.io/f/xxxxabcd" */
const FORMSPREE_ENDPOINT_URL = "https://formspree.io/f/myeyjlvg";

function RatingSheet({ open, onClose, onSubmitted, showToast }) {
  const [stars, setStars] = useState(0);
  const [title, setTitle] = useState("");
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (open) { setStars(0); setTitle(""); setComment(""); }
  }, [open]);

  const submit = async () => {
    if (stars === 0) { showToast("Önce yıldızlarla puan ver"); return; }
    try {
      await window.storage.set("appRating", JSON.stringify({ stars, title, comment, ts: Date.now() }), false);
    } catch (e) { console.error(e); }

    // E-postaya iletim: Formspree endpoint'i ayarlandıysa oraya da gönder.
    if (FORMSPREE_ENDPOINT_URL && !FORMSPREE_ENDPOINT_URL.includes("BURAYA_")) {
      try {
        await fetch(FORMSPREE_ENDPOINT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            uygulama: "Yakıt Nabzı",
            puan: stars + " / 5",
            baslik: title || "(başlık girilmedi)",
            yorum: comment || "(yorum girilmedi)",
            tarih: new Date().toLocaleString("tr-TR"),
          }),
        });
      } catch (e) {
        console.error("Formspree gönderimi başarısız:", e);
        // Sessizce geç - kullanıcı deneyimini bozmasın, yorum yine de cihazda kayıtlı kaldı.
      }
    }

    onSubmitted();
    onClose();
    showToast("Değerlendirmen için teşekkürler!");
  };

  return (
    <div className={"sheet-overlay" + (open ? " open" : "")} onClick={onClose}>
      <div className="sheet rating-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="rating-top">
          <button className="rating-close" onClick={onClose}><Icon.close /></button>
          <span className="rating-top-title">Yorum Yaz</span>
          <button className="rating-send" onClick={submit}><Icon.send /></button>
        </div>
        <div className="rating-app-row">
          <div className="rating-app-icon"><Icon.pump /></div>
          <div>
            <div className="rating-app-name">Akaryakıt Alarm Programı</div>
            <div className="rating-app-tag">Yakıt Zam ve İndirim Habercisi</div>
          </div>
        </div>
        <div className="rating-stars-label">Puanlamak İçin Dokunun</div>
        <div className="rating-stars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className={"star-btn" + (n <= stars ? " on" : "")} onClick={() => setStars(n)}>
              <Icon.star filled={n <= stars} width={25} height={25} />
            </button>
          ))}
        </div>
        <div className="ios-card rating-fields">
          <div className="ios-row">
            <input className="rating-input" placeholder="Başlık (isteğe bağlı)" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="ios-row">
            <input className="rating-input" placeholder="Yorum (isteğe bağlı)" value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
        </div>
      </div>
    </div>
  );
}

function HakkindaView({ notifOn, setNotifOn, onOpenSub, onRate, onShare, showToast, theme, onOpenTheme }) {
  return (
    <>
      <div className="app-header-card">
        <div className="app-icon"><Icon.pump /></div>
        <div className="app-name">Akaryakıt Alarm Programı</div>
        <div className="app-tag">Türkiye geneli akaryakıt fiyat değişim takipçisi</div>
        <div className="app-version">Sürüm 1.0.0</div>
      </div>

      <IosSection header="Görünüm">
        <SettingsRow
          icon={<Icon.palette />}
          color="var(--aksan)"
          label="Tema"
          trailing={<span className="ios-row-value">{THEMES[theme].name} <Icon.chevronRight className="chev" /></span>}
          onClick={onOpenTheme}
        />
      </IosSection>

      <IosSection header="Topluluk">
        <SettingsRow icon={<Icon.download />} color="var(--lpg)" label="Uygulamayı İndir" onClick={() => showToast("Bu bir prototip — gerçek bir mağaza bağlantısı yok.")} />
        <SettingsRow icon={<Icon.star filled />} color="var(--benzin)" label="Puan Ver" onClick={onRate} />
        <SettingsRow icon={<Icon.share />} color="var(--indirim)" label="Paylaş" onClick={onShare} />
      </IosSection>

      <IosSection header="Ayarlar" footer="Not: Bu prototip gerçek anlık işletim sistemi bildirimi gönderemez; anahtar yalnızca tercihini bu cihazda kaydeder.">
        <SettingsRow icon={<Icon.bell />} color="var(--zam)" label="Bildirimler" trailing={<IosSwitch checked={notifOn} onChange={setNotifOn} />} onClick={() => setNotifOn(!notifOn)} />
        <SettingsRow icon={<Icon.info />} color="var(--bilgi)" label="Veri Kaynağı" onClick={() => onOpenSub("kaynak")} />
        <SettingsRow icon={<Icon.lock />} color="var(--notr)" label="Gizlilik İlkesi" onClick={() => onOpenSub("privacy")} />
      </IosSection>

      <div className="about-footer">Akaryakıt Alarm Programı bağımsız bir prototiptir; EPDK veya herhangi bir resmi kurumla bağlantılı değildir.</div>
    </>
  );
}

/* ---------- alt sekme çubuğu ---------- */
function TabBar({ tab, setTab }) {
  const items = [
    { id: "sehirler", label: "Şehirler", Icon: Icon.pump },
    { id: "degisim", label: "Değişim", Icon: Icon.trend },
    { id: "haberler", label: "Haberler", Icon: Icon.news },
    { id: "hakkinda", label: "Hakkında", Icon: Icon.info },
  ];
  return (
    <div className="tab-bar">
      {items.map((it) => (
        <button key={it.id} className={"tab-btn" + (tab === it.id ? " active" : "")} onClick={() => setTab(it.id)}>
          <it.Icon />
          <span>{it.label}</span>
        </button>
      ))}
      <div className="home-indicator" />
    </div>
  );
}

function Toast({ message }) {
  return message ? <div className="toast">{message}</div> : null;
}

const TAB_TITLES = { sehirler: "Şehirler", degisim: "Değişim", haberler: "Haberler", hakkinda: "Hakkında" };
const SUB_TITLES = { kaynak: "Veri Kaynağı", privacy: "Gizlilik İlkesi" };

/* ---------- ana uygulama ---------- */
function App() {
  const [tab, setTab] = useState("sehirler");
  const [selectedIl, setSelectedIl] = useState("Ankara");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedDistrict, setSelectedDistrict] = useState(null);
  const [favorites, setFavorites] = useState(new Set());
  const [alerts, setAlerts] = useState([]);
  const [totemMode, setTotemMode] = useState("today");
  const [fuelFilter, setFuelFilter] = useState("motorin");
  const [alertPrefill, setAlertPrefill] = useState(null);
  const [notifOn, setNotifOn] = useState(true);
  const [aboutSub, setAboutSub] = useState(null);
  const [ratingOpen, setRatingOpen] = useState(false);
  const [theme, setTheme] = useState("saha");
  const [accent, setAccent] = useState("terrakota");
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);
  const scrollRef = useRef(null);
  const prefsTimer = useRef(null);

  const [districts, setDistricts] = useState([]);
  const [fiyatDurum, setFiyatDurum] = useState("yukleniyor"); // yukleniyor | hazir | hata
  const [fiyatGuncelleme, setFiyatGuncelleme] = useState(null);
  const [ulusalBugun, setUlusalBugun] = useState(null); // gerçek API'den — yoksa il/ilçe ortalamasına düşülür
  const districtsMap = useMemo(() => Object.fromEntries(districts.map((d) => [d.id, d])), [districts]);

  const loadFiyatlar = useCallback(async () => {
    setFiyatDurum("yukleniyor");
    try {
      const { districts: list, guncelleme } = await fetchFiyatlar();
      setDistricts(list);
      setFiyatGuncelleme(guncelleme);
      setFiyatDurum("hazir");
    } catch (e) {
      console.error(e);
      setFiyatDurum("hata");
    }
  }, []);

  useEffect(() => { loadFiyatlar(); }, [loadFiyatlar]);
  useEffect(() => {
    fetchUlusalFiyat().then(setUlusalBugun).catch((e) => console.error(e));
  }, []);

  const [haberler, setHaberler] = useState([]);
  const [haberDurum, setHaberDurum] = useState("yukleniyor"); // yukleniyor | hazir | hata
  const [haberGuncelleme, setHaberGuncelleme] = useState(null);
  const [haberKaynaklar, setHaberKaynaklar] = useState([]);

  const loadHaberler = useCallback(async () => {
    setHaberDurum("yukleniyor");
    try {
      const { haberler: list, guncelleme, kaynaklar } = await fetchHaberler();
      setHaberler(list);
      setHaberGuncelleme(guncelleme);
      setHaberKaynaklar(kaynaklar);
      setHaberDurum("hazir");
    } catch (e) {
      console.error(e);
      setHaberDurum("hata");
    }
  }, []);

  useEffect(() => { loadHaberler(); }, [loadHaberler]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2200);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const favRes = await window.storage.get("favorites", false);
        if (favRes?.value) setFavorites(new Set(JSON.parse(favRes.value)));
      } catch (e) {}
      try {
        const alertRes = await window.storage.get("alerts", false);
        if (alertRes?.value) setAlerts(JSON.parse(alertRes.value));
      } catch (e) {}
      // Tema/vurgu rengi/bildirim tercihi tek bir "prefs" anahtarında birlikte tutulur
      // (art arda değişikliklerde ayrı ayrı kayıt isteği göndermemek için).
      let loadedFromPrefs = false;
      try {
        const prefsRes = await window.storage.get("prefs", false);
        if (prefsRes?.value) {
          const p = JSON.parse(prefsRes.value);
          if (p.theme && THEMES[p.theme]) setTheme(p.theme);
          if (p.accent && ACCENTS[p.accent]) setAccent(p.accent);
          if (typeof p.notifOn === "boolean") setNotifOn(p.notifOn);
          loadedFromPrefs = true;
        }
      } catch (e) {}
      // Geriye dönük uyumluluk: daha önce ayrı anahtarlarda kaydedilmiş tercihler varsa oku.
      if (!loadedFromPrefs) {
        try {
          const themeRes = await window.storage.get("theme", false);
          if (themeRes?.value && THEMES[JSON.parse(themeRes.value)]) setTheme(JSON.parse(themeRes.value));
        } catch (e) {}
        try {
          const accentRes = await window.storage.get("accent", false);
          if (accentRes?.value && ACCENTS[JSON.parse(accentRes.value)]) setAccent(JSON.parse(accentRes.value));
        } catch (e) {}
        try {
          const notifRes = await window.storage.get("notifOn", false);
          if (notifRes?.value) setNotifOn(JSON.parse(notifRes.value));
        } catch (e) {}
      }
      setReady(true);
    })();
  }, []);

  const persistFavorites = useCallback(async (set) => {
    try { await window.storage.set("favorites", JSON.stringify([...set]), false); }
    catch (e) { console.error(e); showToast("Favoriler kaydedilemedi"); }
  }, [showToast]);
  const persistAlerts = useCallback(async (list) => {
    try { await window.storage.set("alerts", JSON.stringify(list), false); }
    catch (e) { console.error(e); showToast("Uyarı kaydedilemedi"); }
  }, [showToast]);
  const persistPrefs = useCallback((next) => {
    // Art arda hızlı değişikliklerde her dokunuşta ayrı kayıt isteği göndermemek için
    // geciktiriyoruz; sadece son değer, kısa bir duraklamadan sonra bir kez kaydedilir.
    clearTimeout(prefsTimer.current);
    prefsTimer.current = setTimeout(async () => {
      try {
        await window.storage.set("prefs", JSON.stringify(next), false);
      } catch (e) {
        console.error(e);
        // Geçici bir sınırlama olabileceğinden kısa bir bekleme sonrası bir kez daha dene.
        // Kullanıcıya hata gösterilmiyor; tercih arayüzde zaten uygulanmış durumda.
        setTimeout(async () => {
          try { await window.storage.set("prefs", JSON.stringify(next), false); }
          catch (e2) { console.error(e2); }
        }, 1200);
      }
    }, 450);
  }, []);
  const changeTheme = useCallback((key) => {
    setTheme(key);
    persistPrefs({ theme: key, accent, notifOn });
  }, [persistPrefs, accent, notifOn]);
  const changeAccent = useCallback((key) => {
    setAccent(key);
    persistPrefs({ theme, accent: key, notifOn });
  }, [persistPrefs, theme, notifOn]);
  const changeNotif = useCallback((val) => {
    setNotifOn(val);
    persistPrefs({ theme, accent, notifOn: val });
  }, [persistPrefs, theme, accent]);

  const toggleFav = useCallback((id) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      persistFavorites(next);
      return next;
    });
  }, [persistFavorites]);

  const addAlert = useCallback((a) => {
    setAlerts((prev) => { const next = [a, ...prev]; persistAlerts(next); return next; });
    showToast("Uyarı oluşturuldu");
  }, [persistAlerts, showToast]);

  const removeAlert = useCallback((id) => {
    setAlerts((prev) => { const next = prev.filter((x) => x.id !== id); persistAlerts(next); return next; });
  }, [persistAlerts]);

  const goCreateAlert = (d) => {
    setAlertPrefill({ il: d.il, ilce: d.ilce });
    setSelectedDistrict(null);
    setTab("degisim");
  };

  const openDistrict = (d) => setSelectedDistrict(d);

  const handleShare = async () => {
    const text = "Akaryakıt Alarm Programı — Türkiye geneli akaryakıt fiyat değişim takipçisi";
    try {
      if (navigator.share) {
        await navigator.share({ title: "Akaryakıt Alarm Programı", text });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        showToast("Panoya kopyalandı");
      } else {
        showToast("Paylaşım bu tarayıcıda desteklenmiyor");
      }
    } catch (e) { /* kullanıcı paylaşımı iptal etmiş olabilir */ }
  };

  let body;
  if (tab === "sehirler" || tab === "degisim") {
    if (fiyatDurum === "yukleniyor") {
      body = (
        <div className="fiyat-durum">
          <div className="fiyat-durum-spinner" />
          <div className="fiyat-durum-text">Güncel fiyatlar yükleniyor…</div>
        </div>
      );
    } else if (fiyatDurum === "hata") {
      body = (
        <div className="fiyat-durum">
          <div className="fiyat-durum-text">Fiyatlar yüklenemedi. İnternet bağlantınızı kontrol edin.</div>
          <button className="ios-btn" onClick={loadFiyatlar}>Tekrar dene</button>
        </div>
      );
    } else if (tab === "sehirler") {
      body = (
        <SehirlerView allDistricts={districts} selectedIl={selectedIl} setPickerOpen={setPickerOpen} favorites={favorites} toggleFav={toggleFav} onOpenDistrict={(d) => setSelectedDistrict(d)} />
      );
    } else {
      body = (
        <DegisimView
          districts={districts}
          totemMode={totemMode} setTotemMode={setTotemMode}
          fuelFilter={fuelFilter} setFuelFilter={setFuelFilter}
          favorites={favorites} districtsMap={districtsMap} toggleFav={toggleFav}
          onOpenDistrict={openDistrict}
          alerts={alerts} addAlert={addAlert} removeAlert={removeAlert} alertPrefill={alertPrefill}
          ulusalBugun={ulusalBugun}
        />
      );
    }
  } else if (tab === "haberler") {
    if (haberDurum === "yukleniyor") {
      body = (
        <div className="fiyat-durum">
          <div className="fiyat-durum-spinner" />
          <div className="fiyat-durum-text">Haberler yükleniyor…</div>
        </div>
      );
    } else if (haberDurum === "hata") {
      body = (
        <div className="fiyat-durum">
          <div className="fiyat-durum-text">Haberler yüklenemedi. İnternet bağlantınızı kontrol edin.</div>
          <button className="ios-btn" onClick={loadHaberler}>Tekrar dene</button>
        </div>
      );
    } else {
      body = <HaberlerView haberler={haberler} guncelleme={haberGuncelleme} kaynaklar={haberKaynaklar} />;
    }
  } else {
    body = aboutSub ? (
      <div className="push-in">{aboutSub === "kaynak" ? <KaynakContent /> : <PrivacyContent />}</div>
    ) : (
      <HakkindaView notifOn={notifOn} setNotifOn={changeNotif} onOpenSub={setAboutSub} onRate={() => setRatingOpen(true)} onShare={handleShare} showToast={showToast} theme={theme} onOpenTheme={() => setThemePickerOpen(true)} />
    );
  }

  const showBack = tab === "hakkinda" && aboutSub;
  const backLabel = "Hakkında";
  const backAction = () => setAboutSub(null);
  const titleText = tab === "hakkinda" && aboutSub ? SUB_TITLES[aboutSub] : TAB_TITLES[tab];
  const themeVars = { ...THEMES[theme].vars, "--aksan": ACCENTS[accent].hex };

  return (
    <div className="app-root" style={themeVars} data-theme={theme}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Anton&family=Space+Grotesk:wght@600;700;800&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&family=DM+Serif+Display&family=Fraunces:wght@600;900&family=Sora:wght@600;700;800&family=Oswald:wght@500;600;700&display=swap');

        .app-root{
          --sayfa:#DCD3B8; --panel:#F3ECD9; --panel-2:#DACD9F; --panel-3:#CBBB8C;
          --kenar:#BBAA78; --aksan:#F2C230;
          --motorin:#0F1D3D; --benzin:#C08A34; --lpg:#5C7A67; --zam:#8C3B2E; --indirim:#5C7A67;
          --bilgi:#3E5C76; --notr:#8F8570; --metin:#0F1D3D; --metin-soluk:#5B5340; --metin-silik:#B7AC94;
          --vurgu-panel:#0F1D3D; --vurgu-panel-alt:#1C2F55; --vurgu-panel-metin:#F8F1DD; --vurgu-panel-metin-soluk:#B9C2D9;
          --font-display:'Fraunces',serif; --font-body:'Manrope',sans-serif; --font-mono:'JetBrains Mono',monospace; --font-poster:'Oswald',sans-serif;
          --radius-card:10px; --card-border:1px solid rgba(15,29,61,0.16); --tabbar-bg:rgba(220,211,184,0.94);
          display:flex; justify-content:center; background:#D3D3D6; transition:background .2s ease;
          padding:18px 0; font-family:var(--font-body); -webkit-font-smoothing:antialiased;
          min-height:100vh; min-height:100dvh; box-sizing:border-box;
        }
        .ios-card, .ios-btn, .ios-switch, .tab-btn, .sheet, .haber-card, .kaynak-chip, .pulse-widget{ transition:background-color .28s ease, color .28s ease, border-color .28s ease, box-shadow .28s ease; }
        .phone{ width:390px; max-width:100%; background:var(--sayfa); background-image:var(--bg-pattern, none); background-size:var(--bg-pattern-size, auto); border-radius:38px; overflow:hidden; box-shadow:0 24px 60px rgba(20,23,26,0.28); display:flex; flex-direction:column; height:calc(100vh - 36px); height:calc(100dvh - 36px); max-height:800px; border:1px solid #c8c9ce; position:relative; transition:background .28s ease; }

        .nav-bar{ padding:10px 16px 6px; background:var(--sayfa); flex-shrink:0; position:relative; z-index:2; }
        .nav-bar-row{ display:flex; align-items:center; min-height:22px; }
        .nav-back{ display:flex; align-items:center; gap:2px; background:none; border:none; color:var(--aksan); font-size:16px; font-weight:600; padding:0; cursor:pointer; font-family:var(--font-body); }
        .large-title{ font-size:29px; font-weight:800; letter-spacing:-0.4px; color:var(--aksan); font-family:var(--font-poster); margin:2px 0 8px; }

        .content-scroll{ flex:1; overflow-y:auto; padding:0 16px 16px; }
        .content-scroll::-webkit-scrollbar{ width:0; }

        .pulse-widget{ background:var(--vurgu-panel); border-radius:var(--radius-card); padding:14px 16px 12px; margin:6px 0 14px; cursor:pointer; user-select:none; box-shadow:0 8px 20px rgba(28,28,30,0.25); transition:background .2s ease, border-radius .2s ease; }
        .pulse-top{ display:flex; justify-content:space-between; align-items:center; }
        .pulse-title{ font-size:11px; font-weight:700; color:var(--vurgu-panel-metin-soluk); text-transform:uppercase; letter-spacing:.06em; font-family:var(--font-body); }
        .pulse-mode{ font-size:11px; font-weight:700; color:var(--vurgu-panel-metin); background:var(--vurgu-panel-alt); padding:3px 9px; border-radius:20px; }
        .pulse-row{ display:flex; justify-content:space-between; margin-top:10px; }
        .pulse-fuel{ font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; font-family:var(--font-body); }
        .pulse-price{ font-size:19px; font-weight:700; font-variant-numeric:tabular-nums; margin-top:3px; display:flex; align-items:baseline; gap:2px; font-family:var(--font-mono); }
        .pulse-cur{ font-size:11px; opacity:.7; }
        .flipnum{ display:inline-flex; overflow:hidden; }
        .flipdigit{ display:inline-block; animation: flipin .4s cubic-bezier(.2,.8,.2,1); }
        @keyframes flipin{ 0%{ transform:translateY(-55%) rotateX(70deg); opacity:0;} 100%{ transform:translateY(0) rotateX(0); opacity:1;} }

        .next-change-list{ display:flex; flex-direction:column; gap:14px; }
        .haber-list{ display:flex; flex-direction:column; gap:12px; }
        .haber-card{ display:block; background:var(--panel); border-radius:var(--radius-card); border:var(--card-border); padding:14px 16px; text-decoration:none; transition:transform .12s ease, opacity .12s ease; }
        .haber-card:active{ transform:scale(0.98); opacity:0.85; }
        .haber-baslik{ font-size:15px; font-weight:700; color:var(--metin); line-height:1.35; font-family:var(--font-body); }
        .haber-ozet{ font-size:13px; color:var(--metin-soluk); line-height:1.45; margin-top:6px; font-family:var(--font-body); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
        .haber-alt{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:10px; }
        .haber-alt-left{ display:flex; align-items:center; gap:8px; min-width:0; }
        .haber-kaynak{ font-size:10.5px; font-weight:800; letter-spacing:.03em; color:var(--aksan); background:var(--panel-2); border:1px solid var(--kenar); border-radius:6px; padding:2px 6px; flex-shrink:0; font-family:var(--font-body); }
        .haber-tarih{ font-size:11.5px; color:var(--metin-silik); font-family:var(--font-mono); }
        .haber-devam{ display:flex; align-items:center; gap:2px; font-size:12px; font-weight:700; color:var(--aksan); white-space:nowrap; }
        .haber-devam .chev{ width:14px; height:14px; }
        .kaynak-filtre{ display:flex; gap:8px; overflow-x:auto; padding:2px 16px 12px; }
        .kaynak-chip{ flex-shrink:0; border:1px solid var(--kenar); background:var(--panel); color:var(--metin-soluk); font-size:12.5px; font-weight:700; font-family:var(--font-body); border-radius:999px; padding:6px 13px; cursor:pointer; }
        .kaynak-chip.on{ background:var(--aksan); border-color:var(--aksan); color:#fff; }
        .next-change-card{ background:var(--panel); border-radius:var(--radius-card); border:var(--card-border); padding:18px 18px 16px; }
        .next-change-top{ display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:nowrap; }
        .next-change-fuel{ font-size:26px; font-weight:400; letter-spacing:0.2px; font-family:var(--font-poster); flex-shrink:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .next-change-status{ display:flex; align-items:center; gap:4px; font-size:11.5px; color:var(--metin-soluk); white-space:nowrap; font-family:var(--font-body); flex-shrink:0; }
        .next-change-status.active{ color:var(--benzin); font-weight:700; }
        .nc-info{ width:14px; height:14px; flex-shrink:0; color:inherit; }
        .next-change-date{ font-size:12px; color:var(--metin-silik); margin-top:6px; font-family:var(--font-mono); }

        .segmented{ display:flex; background:var(--panel-2); border-radius:9px; padding:2px; margin-bottom:16px; }
        .seg-btn{ flex:1; background:none; border:none; padding:6px 0; font-size:13px; font-weight:700; color:var(--metin); border-radius:7px; cursor:pointer; font-family:var(--font-body); }
        .seg-btn.active{ background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.15); }

        .ios-switch{ width:48px; height:29px; border-radius:15px; background:#E9E9EA; border:none; position:relative; cursor:pointer; padding:0; flex-shrink:0; transition:background .2s; }
        .ios-switch.on{ background:var(--indirim); }
        .ios-switch .knob{ position:absolute; top:2px; left:2px; width:25px; height:25px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.3); transition:left .2s; }
        .ios-switch.on .knob{ left:21px; }

        .icon-badge{ width:26px; height:26px; border-radius:7px; display:flex; align-items:center; justify-content:center; color:#fff; flex-shrink:0; }
        .settings-left{ display:flex; align-items:center; gap:11px; }
        .settings-row .chev{ color:var(--kenar); }

        .ios-section{ margin-bottom:20px; }
        .ios-section-header{ font-size:13px; font-weight:700; color:var(--aksan); text-transform:uppercase; letter-spacing:.03em; padding:0 4px 6px; font-family:var(--font-poster); }
        .ios-section-header.sticky{ padding-top:10px; }
        .ios-section-footer{ font-size:12.5px; color:var(--metin-soluk); padding:8px 4px 0; line-height:1.5; font-family:var(--font-body); }
        .ios-card{ background:var(--panel); border-radius:var(--radius-card); border:var(--card-border); overflow:hidden; }
        .ios-row{ width:100%; box-sizing:border-box; display:flex; align-items:center; justify-content:space-between; gap:10px; background:none; border:none; padding:12px 14px; text-align:left; cursor:pointer; font-family:var(--font-body); font-size:15px; color:var(--metin); position:relative; }
        .ios-row:not(:last-child)::after{ content:""; position:absolute; left:14px; right:0; bottom:0; height:1px; background:var(--kenar); }
        .ios-row:active{ background:var(--panel-2); }
        .ios-row-title{ font-size:15px; font-weight:600; color:var(--metin); }
        .ios-row-value{ display:flex; align-items:center; gap:5px; font-size:15px; color:var(--metin-soluk); }
        .text-row{ font-size:13.5px; line-height:1.55; color:#3C3C43; cursor:default; display:block; }

        .three-col{ display:flex; padding:16px 14px; align-items:flex-start; }
        .fuel-col{ flex:1; text-align:center; }
        .fuel-col-label{ font-size:13px; font-weight:600; font-family:var(--font-body); opacity:.55; }
        .fuel-col-price{ font-size:19px; font-weight:800; margin-top:6px; font-variant-numeric:tabular-nums; font-family:var(--font-mono); }

        .delta{ display:inline-block; font-size:10px; font-weight:700; margin-top:4px; font-family:var(--font-mono); }
        .delta.up{ color:var(--zam); }
        .delta.down{ color:var(--indirim); }
        .delta.flat{ color:var(--metin-silik); }

        .district-header{ display:flex; align-items:center; justify-content:space-between; font-size:15px; font-weight:800; color:var(--metin); text-transform:uppercase; letter-spacing:.02em; padding:0 4px 8px; font-family:var(--font-poster); }
        .fav-btn{ background:none; border:none; color:var(--kenar); padding:0; cursor:pointer; display:flex; }
        .fav-btn.on{ color:var(--benzin); }
        .fav-btn.big{ padding:6px; }

        .detail-card{ display:flex; align-items:flex-start; justify-content:space-between; padding:14px; }
        .detail-card-actions{ display:flex; align-items:center; gap:10px; }
        .district-sheet{ max-height:88%; }
        .district-sheet .sheet-list{ padding-top:2px; }
        .detail-title{ font-size:21px; font-weight:800; color:var(--metin); font-family:var(--font-poster); }
        .detail-sub{ font-size:13px; color:var(--metin-soluk); margin-top:2px; }

        .fuel-detail-row{ cursor:default; }
        .fuel-detail-name{ font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; font-family:var(--font-body); }
        .fuel-detail-price{ font-size:21px; font-weight:800; margin-top:4px; font-variant-numeric:tabular-nums; font-family:var(--font-mono); }
        .fuel-detail-yest{ font-size:11.5px; color:var(--metin-silik); margin-top:3px; font-family:var(--font-mono); }
        .fuel-detail-right{ text-align:right; }

        .leader-row{ align-items:center; }
        .leader-right{ text-align:right; }
        .leader-price{ font-size:14px; font-weight:700; font-variant-numeric:tabular-nums; display:block; color:var(--metin); font-family:var(--font-mono); }

        .ios-btn-wrap{ margin:4px 0 22px; }
        .ios-btn{ width:100%; background:var(--aksan); color:#fff; border:none; border-radius:14px; padding:14px; font-size:16px; font-weight:700; font-family:var(--font-body); cursor:pointer; }
        .ios-btn:active{ background:#000; }

        .takip-row{ flex-direction:column; align-items:flex-start; gap:6px; }
        .takip-prices{ display:flex; gap:12px; font-size:13px; font-weight:700; font-variant-numeric:tabular-nums; font-family:var(--font-mono); }
        .dim{ color:var(--metin-soluk); font-weight:400; }
        .dim.small{ font-size:12px; margin-top:2px; }

        .form-line label{ font-size:15px; color:var(--metin); font-weight:500; }
        .form-line select{ border:none; background:none; color:var(--metin-soluk); font-size:15px; font-family:var(--font-body); text-align:right; direction:rtl; }
        .form-input{ border:none; background:none; color:var(--metin); font-size:15px; font-family:var(--font-mono); text-align:right; width:110px; outline:none; }
        .form-input::placeholder{ color:var(--kenar); }

        .alert-row{ align-items:flex-start; }
        .del-btn{ background:none; border:none; color:var(--zam); font-size:14px; font-weight:600; cursor:pointer; font-family:var(--font-body); padding:2px; }

        .app-header-card{ text-align:center; padding:22px 0 6px; }
        .app-icon{ width:64px; height:64px; border-radius:16px; background:linear-gradient(135deg,var(--motorin) 0%,var(--lpg) 50%,var(--benzin) 100%); color:#fff; display:flex; align-items:center; justify-content:center; margin:0 auto 10px; box-shadow:0 8px 20px rgba(0,0,0,0.28); }
        .app-name{ font-size:17px; font-weight:800; color:var(--metin); font-family:var(--font-poster); line-height:1.25; }
        .app-tag{ font-size:12.5px; color:var(--metin-soluk); margin-top:3px; padding:0 24px; line-height:1.4; }
        .app-version{ font-size:11.5px; color:var(--metin-silik); margin-top:6px; font-family:var(--font-mono); }
        .about-footer{ text-align:center; font-size:11.5px; color:#9AA0A6; padding:4px 20px 20px; line-height:1.5; }

        .push-in{ animation: pushin .28s ease; }
        @keyframes pushin{ from{ opacity:0; transform:translateX(24px);} to{ opacity:1; transform:translateX(0);} }

        .tab-bar{ background:var(--tabbar-bg); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px); border-top:0.5px solid var(--kenar); display:flex; flex-shrink:0; padding-top:6px; position:relative; }
        .tab-btn{ flex:1; background:none; border:none; display:flex; flex-direction:column; align-items:center; gap:2px; color:var(--metin-soluk); font-size:10px; font-weight:500; padding-bottom:18px; cursor:pointer; font-family:var(--font-body); transition:color .22s ease, transform .12s ease; -webkit-tap-highlight-color:transparent; touch-action:manipulation; }
        .tab-btn:active{ transform:scale(0.88); opacity:0.75; }
        .tab-btn svg{ width:24px; height:24px; transition:transform .32s cubic-bezier(.34,1.56,.64,1), color .22s ease; }
        .tab-btn.active{ color:var(--aksan); font-weight:700; }
        .tab-btn.active svg{ transform:scale(1.1); }
        .tab-btn span{ transition:transform .22s cubic-bezier(.34,1.56,.64,1); }
        .tab-btn.active span{ transform:scale(1.03); }
        .home-indicator{ position:absolute; bottom:7px; left:50%; transform:translateX(-50%); width:134px; height:5px; background:var(--metin); border-radius:3px; opacity:0.9; pointer-events:none; }

        .sheet-overlay{ position:absolute; inset:0; background:rgba(0,0,0,0); pointer-events:none; transition:background .25s ease; display:flex; align-items:flex-end; z-index:10; }
        .sheet-overlay.open{ background:rgba(0,0,0,0.36); pointer-events:auto; }
        .sheet{ width:100%; max-height:82%; background:var(--sayfa); border-radius:20px 20px 0 0; display:flex; flex-direction:column; transform:translateY(100%); transition:transform .3s cubic-bezier(.2,.8,.2,1); }
        .sheet-overlay.open .sheet{ transform:translateY(0); }
        .sheet-grabber{ width:36px; height:5px; background:var(--panel-3); border-radius:3px; margin:9px auto 4px; }
        .sheet-header{ font-size:17px; font-weight:800; text-align:center; padding:6px 0 10px; color:var(--aksan); font-family:var(--font-poster); }
        .ios-search{ display:flex; align-items:center; gap:6px; background:var(--panel-2); border-radius:11px; padding:8px 10px; margin:0 16px 10px; color:var(--metin-soluk); }
        .ios-search input{ border:none; background:none; outline:none; font-size:15px; width:100%; color:var(--metin); font-family:var(--font-body); }
        .ios-search.district-search{ margin:0 0 12px; }
        .search-hint{ font-size:12.5px; color:var(--metin-soluk); padding:0 4px 8px; }
        .sheet-list{ overflow-y:auto; padding:0 16px 26px; }
        .check-icon{ color:var(--aksan); }
        .theme-row-left{ display:flex; align-items:center; gap:11px; }
        .theme-swatch{ display:flex; width:26px; height:26px; border-radius:8px; overflow:hidden; flex-shrink:0; border:1px solid rgba(0,0,0,0.08); }
        .accent-dot{ width:22px; height:22px; border-radius:50%; flex-shrink:0; border:1px solid rgba(0,0,0,0.08); }
        .theme-swatch span{ flex:1; }
        .empty{ text-align:center; color:var(--metin-soluk); font-size:13px; padding:24px 0; }
        .fiyat-durum{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:80px 24px; text-align:center; }
        .fiyat-durum-text{ color:var(--metin-soluk); font-size:14px; }
        .fiyat-durum-spinner{ width:28px; height:28px; border-radius:50%; border:3px solid var(--kenar); border-top-color:var(--aksan); animation:fiyat-spin 0.8s linear infinite; }
        @keyframes fiyat-spin{ to{ transform:rotate(360deg); } }

        .rating-sheet{ max-height:92%; padding-bottom:20px; }
        .rating-top{ display:flex; align-items:center; justify-content:space-between; padding:10px 14px 4px; }
        .rating-close{ background:var(--panel-2); border:none; border-radius:50%; width:30px; height:30px; display:flex; align-items:center; justify-content:center; color:var(--metin); cursor:pointer; }
        .rating-top-title{ font-size:16px; font-weight:800; color:var(--aksan); font-family:var(--font-poster); }
        .rating-send{ background:var(--aksan); border:none; border-radius:50%; width:34px; height:34px; display:flex; align-items:center; justify-content:center; color:#fff; cursor:pointer; }
        .rating-app-row{ display:flex; align-items:center; gap:12px; padding:16px; }
        .rating-app-icon{ width:52px; height:52px; border-radius:13px; background:linear-gradient(135deg,var(--motorin) 0%,var(--lpg) 50%,var(--benzin) 100%); color:#fff; display:flex; align-items:center; justify-content:center; }
        .rating-app-name{ font-size:14.5px; font-weight:800; color:var(--metin); font-family:var(--font-poster); line-height:1.25; }
        .rating-app-tag{ font-size:12px; color:var(--metin-soluk); margin-top:2px; }
        .rating-stars-label{ font-size:13px; color:var(--metin-soluk); padding:6px 16px 0; }
        .rating-stars{ display:flex; gap:10px; padding:10px 16px 16px; }
        .star-btn{ background:none; border:none; color:var(--kenar); padding:0; cursor:pointer; }
        .star-btn.on{ color:var(--benzin); }
        .rating-fields{ margin:0 16px; }
        .rating-input{ width:100%; border:none; outline:none; background:none; color:var(--metin); font-size:15px; font-family:var(--font-body); padding:2px 0; }

        .toast{ position:absolute; bottom:96px; left:50%; transform:translateX(-50%); background:var(--vurgu-panel); color:var(--vurgu-panel-metin); font-size:13px; font-weight:500; padding:10px 16px; border-radius:12px; z-index:20; white-space:nowrap; box-shadow:0 8px 20px rgba(0,0,0,0.25); }
      `}</style>

      <div className="phone">
        <div className="nav-bar">
          {showBack ? (
            <div className="nav-bar-row">
              <button className="nav-back" onClick={backAction}><Icon.back /> {backLabel}</button>
            </div>
          ) : (
            <div className="large-title">{titleText}</div>
          )}
        </div>

        <div className="content-scroll" ref={scrollRef}>
          {ready && body}
        </div>

        <TabBar tab={tab} setTab={(t) => { setTab(t); setSelectedDistrict(null); setAboutSub(null); }} />

        <CityPicker open={pickerOpen} current={selectedIl} onClose={() => setPickerOpen(false)} onSelect={setSelectedIl} />
        <DistrictSheet open={!!selectedDistrict} d={selectedDistrict} favorites={favorites} toggleFav={toggleFav} goCreateAlert={goCreateAlert} onClose={() => setSelectedDistrict(null)} />
        <RatingSheet open={ratingOpen} onClose={() => setRatingOpen(false)} onSubmitted={() => {}} showToast={showToast} />
        <ThemePicker open={themePickerOpen} current={theme} onClose={() => setThemePickerOpen(false)} onSelect={changeTheme} accent={accent} onSelectAccent={changeAccent} />
        <Toast message={toast} />
      </div>
    </div>
  );
}

class HataSiniri extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hataVar: false };
  }
  static getDerivedStateFromError() {
    return { hataVar: true };
  }
  componentDidCatch(hata, bilgi) {
    var mesaj = (hata && hata.message) || String(hata);
    var yigin = (hata && hata.stack) || "";
    var bilesenYigin = (bilgi && bilgi.componentStack) || "";
    if (window.hataGoster) {
      window.hataGoster(
        "UYGULAMA ÇÖKTÜ (render sırasında):",
        mesaj + "\n\n" + yigin + "\n\n--- Bileşen yığını ---\n" + bilesenYigin
      );
    }
  }
  render() {
    if (this.state.hataVar) return null;
    return this.props.children;
  }
}

const kokEleman = document.getElementById("root");
ReactDOM.createRoot(kokEleman).render(
  <HataSiniri>
    <App />
  </HataSiniri>
);
