/**
 * LoL Wiki "High definition champion skins" kategorisinden tüm dosyaları çeker,
 * YAGPDB CC'sinin hızlı lookup yapabileceği flat bir JSON üretir.
 *
 * Kullanım:
 *   node scripts/fetch-lol-hd-skins.js
 *
 * Çıktı: data/lolHdSkins.json
 *
 * Yapı:
 *   {
 *     "generatedAt": "...",
 *     "total": 2011,
 *     "files": {
 *       "ahrioriginal": "Ahri_OriginalSkin_HD.jpg",
 *       "ahrikda": "Ahri_KDASkin_HD.jpg",
 *       "ahrikdaallout": "Ahri_KDAALLOUTSkin_HD.jpg",
 *       "ksanteoriginal": "K'Sante_OriginalSkin_HD.jpg",
 *       "missfortunearcade": "Miss_Fortune_ArcadeSkin_HD.jpg",
 *       ...
 *     }
 *   }
 *
 * Anahtar üretim kuralı:
 *   filename → champion + skin → birleştir → lowercase → non-alphanumeric strip
 *   "Miss_Fortune_ArcadeSkin_HD.jpg" → "Miss Fortune" + "Arcade" → "missfortunearcade"
 *   "K'Sante_OriginalSkin_HD.jpg"   → "K'Sante" + "Original" → "ksanteoriginal"
 *
 * CC tarafında aynı normalize uygulanır (kullanıcı `K'sante` da, `ksante` da,
 * `K Sante` de yazsa hepsi "ksante" olur), böylece input formatı esnek olur.
 */

const fs = require("fs");
const path = require("path");

const API = "https://wiki.leagueoflegends.com/api.php";
const CATEGORY = "Category:High_definition_champion_skins";
const CD_SKINS = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/skins.json";
const OUT = path.join(__dirname, "..", "data", "lolHdSkins.json");

// kEpic, kLegendary, kMythic vs. → kullanıcı dostu format + tahmini RP + sort priority
// (RP'ler tier'ın tipik fiyatı; legacy/event skin'lerde farklılık olabilir → "*"
// sembolüyle disclaimer'a referans, embed footer'da açıklanır)
const TIER_DISPLAY = {
    kTranscendent: { emoji: "✨", name: "Transcendent", rp: "—",     order: 1 },
    kExalted:      { emoji: "💎", name: "Exalted",      rp: "~5400", order: 2 },
    kMythic:       { emoji: "🌸", name: "Mythic",       rp: "ME",    order: 3 },
    kUltimate:     { emoji: "🔴", name: "Ultimate",     rp: "~3250", order: 4 },
    kLegendary:    { emoji: "🟡", name: "Legendary",    rp: "~1820", order: 5 },
    kEpic:         { emoji: "🟣", name: "Epic",         rp: "~1350", order: 6 },
    kRare:         { emoji: "🔵", name: "Rare",         rp: "limited", order: 7 },
    kNoRarity:     { emoji: "⚪", name: "Standard",     rp: "~975",  order: 8 },
};

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// camelCase / PascalCase'i boşlukla ayır, akronimleri koru:
//   "BloodMoon"     → "Blood Moon"
//   "PrestigeKDA"   → "Prestige KDA"
//   "KDAALLOUT"     → "KDAALLOUT"           (tüm büyük harf, ayrılmaz)
//   "Original"      → "Classic"             (özel durum)
function prettifySkinName(raw) {
    if (raw === "Original") return "Classic";
    return raw
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .trim();
}

// "Aatrox_BloodMoonSkin_HD.jpg" → { champ: "Aatrox", skin: "BloodMoon" }
// "Miss_Fortune_AdmiralBattleBunnySkin_HD.jpg" → { champ: "Miss Fortune", skin: "AdmiralBattleBunny" }
function parseFilename(filename) {
    // Greedy: en sondaki "_<SkinKey>Skin_HD.<ext>" eşleşmesi
    const m = filename.match(/^(.+)_([^_]+)Skin_HD\.(?:jpg|png|jpeg)$/i);
    if (!m) return null;
    return {
        champ: m[1].replace(/_/g, " "),
        skin: m[2],
    };
}

// CD'nin internal champion ID'leri ile wiki champion key'leri arasında alias.
// CD splashPath /Characters/MonkeyKing/... → wiki "Wukong"
const CHAMP_ALIAS = {
    monkeyking: "wukong",
    renata:     "renataglasc",
};

// Communitydragon'dan tüm skin'leri çek. wiki champions verisini referans alarak
// her CD skin'i en iyi wiki skin'iyle eşleştir, tier'ı döndür.
async function fetchCDAndMatchTiers(wikiChampions) {
    process.stdout.write("[CD] skin metadata çekiliyor... ");
    const res = await fetch(CD_SKINS, {
        headers: { "User-Agent": "YAGPDB-selfhost-skin-lookup/1.0" },
    });
    if (!res.ok) throw new Error(`CD HTTP ${res.status}`);
    const cdData = await res.json();
    process.stdout.write(`${Object.keys(cdData).length} skin alındı\n`);

    const tiers = {}; // fullKey → tier code

    for (const cdSkin of Object.values(cdData)) {
        // Champion: splashPath'ten al (örn /Characters/MasterYi/...)
        const champMatch = cdSkin.splashPath?.match(/\/Characters\/([^/]+)\//);
        if (!champMatch) continue;
        let champKey = normalize(champMatch[1]);
        champKey = CHAMP_ALIAS[champKey] || champKey;

        const wikiChamp = wikiChampions[champKey];
        if (!wikiChamp) continue; // wiki'de bu champion yoksa atla

        const cdNameKey = normalize(cdSkin.name);
        const rarity = cdSkin.rarity || "kNoRarity";

        // Base skin → wiki "original"
        if (cdSkin.isBase) {
            tiers[champKey + "original"] = rarity;
            continue;
        }

        // Non-base: CD name'i normalize ettikten sonra wiki skin key'lerinden
        // hangisi BAŞINDA geçiyor? (includes değil — yoksa "Prestige PROJECT" CD'si
        // wiki'deki "project" key'ini overwrite eder.) En uzun key kazanır.
        // Threshold 2: "t1", "ig", "dj" gibi kısa esports/internal skin key'leri için.
        // startsWith zaten restrictive, false positive riski düşük.
        const candidates = wikiChamp.skins
            .filter(s => s.k !== "original" && s.k.length >= 2 && cdNameKey.startsWith(s.k))
            .sort((a, b) => b.k.length - a.k.length);

        if (candidates.length > 0) {
            tiers[champKey + candidates[0].k] = rarity;
        }
    }

    return tiers;
}

// Wiki bazı skin'leri grup splash'ı ile bireysel splash arasında karıştırıyor.
// Kategoride listelenen `<Champion>_<Skin>Skin_HD.jpg` storage'da olmayabilir,
// asıl HD dosya `<Event><Year>Skin_HD.jpg` formatında. Bu mapping override eder.
//
// Key: champKey+skinKey (ikisi de lowercase + non-alphanumeric strip).
// Value: wiki HD images dizinindeki gerçek dosya adı.
const FILE_EXCEPTIONS = {
    // === Pool Party 2018 — Caitlyn, Gangplank, Zoe ===
    "caitlynpoolparty":   "PoolParty2018Skin_HD.jpg",
    "gangplankpoolparty": "PoolParty2018Skin_HD.jpg",
    "zoepoolparty":       "PoolParty2018Skin_HD.jpg",

    // === Pool Party 2021 — Braum, Heimerdinger, Sett ===
    "braumpoolparty":        "PoolParty2021Skin_HD.jpg",
    "heimerdingerpoolparty": "PoolParty2021Skin_HD.jpg",
    "settpoolparty":         "PoolParty2021Skin_HD.jpg",

    // === Bewitching 2021 — Fiora, Nami, Syndra, Yuumi (Poppy belirsiz) ===
    "fiorabewitching":  "Bewitching2021Skin_HD.jpg",
    "namibewitching":   "Bewitching2021Skin_HD.jpg",
    "syndrabewitching": "Bewitching2021Skin_HD.jpg",
    "yuumibewitching":  "Bewitching2021Skin_HD.jpg",

    // === Astronaut 2023 — Fizz, Ivern, Kennen, Singed, Xerath ===
    "fizzastronaut":   "Astronaut2023Skin_HD.jpg",
    "ivernastronaut":  "Astronaut2023Skin_HD.jpg",
    "kennenastronaut": "Astronaut2023Skin_HD.jpg",
    "singedastronaut": "Astronaut2023Skin_HD.jpg",
    "xerathastronaut": "Astronaut2023Skin_HD.jpg",

    // === Bee 2021 — Yuumi (Yuubee), Malzahar (Beezahar), Kog'Maw (Bee'Maw) ===
    "yuumiyuubee":      "Bee2021Skin_HD.jpg",
    "malzaharbeezahar": "Bee2021Skin_HD.jpg",
    "kogmawbeemaw":     "Bee2021Skin_HD.jpg",

    // === Bee 2022 — Ziggs (BZZ), Heimerdinger (Heimerstinger), Nunu (&Beelump), Orianna (Orbeeanna) ===
    "ziggsbzzziggs":             "Bee2022Skin_HD.jpg",
    "heimerdingerheimerstinger": "Bee2022Skin_HD.jpg",
    "nunununubeelump":           "Bee2022Skin_HD.jpg",
    "oriannaorbeeanna":          "Bee2022Skin_HD.jpg",

    // === Dragonslayer 2021 — Galio (Dragon Guardian), Kayle, Twitch ===
    "galiodragonguardian": "Dragonslayer2021Skin_HD.jpg",
    "kayledragonslayer":   "Dragonslayer2021Skin_HD.jpg",
    "twitchdragonslayer":  "Dragonslayer2021Skin_HD.jpg",

    // === Infernal 2019 — Akali, Galio ===
    "akaliinfernal": "Infernal2019Skin_HD.jpg",
    "galioinfernal": "Infernal2019Skin_HD.jpg",

    // === Infernal 2020 — Karthus, Kennen, Vel'Koz ===
    "karthusinfernal": "Infernal2020Skin_HD.jpg",
    "kenneninfernal":  "Infernal2020Skin_HD.jpg",
    "velkozinfernal":  "Infernal2020Skin_HD.jpg",

    // === Arcade 2015 — Corki, Hecarim, Miss Fortune ===
    "corkiarcade":       "Arcade2015Skin_HD.jpg",
    "hecarimarcade":     "Arcade2015Skin_HD.jpg",
    "missfortunearcade": "Arcade2015Skin_HD.jpg",

    // === FIFA World Cup 2014 — soccer pozisyon temalı skinler ===
    "alistarsweeper":     "FIFAWorldCup2014Skin_HD.jpg",  // defender
    "gragassuperfan":     "FIFAWorldCup2014Skin_HD.jpg",  // fan
    "lucianstriker":      "FIFAWorldCup2014Skin_HD.jpg",  // forward
    "maokaigoalkeeper":   "FIFAWorldCup2014Skin_HD.jpg",  // goalkeeper
    "twistedfateredcard": "FIFAWorldCup2014Skin_HD.jpg",  // referee

    // === FIFA World Cup 2018 — Lee Sin Playmaker, Rammus King ===
    "leesinplaymaker": "FIFAWorldCup2018Skin_HD.jpg",
    "rammusking":      "FIFAWorldCup2018Skin_HD.jpg",

    // === SKT T1 2013 (1st Worlds) — Jax (Impact), Lee Sin (Bengi), Vayne (Piglet), Zed (Faker), Zyra (PoohManDu) ===
    "jaxsktt1":    "SKTT12013Skin_HD.jpg",
    "leesinsktt1": "SKTT12013Skin_HD.jpg",
    "vaynesktt1":  "SKTT12013Skin_HD.jpg",
    "zedsktt1":    "SKTT12013Skin_HD.jpg",
    "zyrasktt1":   "SKTT12013Skin_HD.jpg",

    // === SKT T1 2015 (2nd Worlds) — Alistar (Wolf), Azir (Easyhoon), Elise (Bengi), Kalista (Bang), Renekton (Marin), Ryze (Faker) ===
    "alistarsktt1":  "SKTT12015Skin_HD.jpg",
    "azirsktt1":     "SKTT12015Skin_HD.jpg",
    "elisesktt1":    "SKTT12015Skin_HD.jpg",
    "kalistasktt1":  "SKTT12015Skin_HD.jpg",
    "renektonsktt1": "SKTT12015Skin_HD.jpg",
    "ryzesktt1":     "SKTT12015Skin_HD.jpg",

    // === SKT T1 2016 (3rd Worlds) — Ekko (Duke), Jhin (Bang), Nami (Wolf), Olaf (Bengi), Syndra (Faker), Zac (Blank) ===
    "ekkosktt1":   "SKTT12016Skin_HD.jpg",
    "jhinsktt1":   "SKTT12016Skin_HD.jpg",
    "namisktt1":   "SKTT12016Skin_HD.jpg",
    "olafsktt1":   "SKTT12016Skin_HD.jpg",
    "syndrasktt1": "SKTT12016Skin_HD.jpg",
    "zacsktt1":    "SKTT12016Skin_HD.jpg",

    // === Cats vs Dogs 2023 ===
    // Cats: Nidalee (Kittalee)
    "nidaleekittalee": "Cats2023Skin_HD.jpg",
    // Dogs: Yuumi (Shiba), Kindred (Woof and Lamb), Kled (Kibble-Head)
    "yuumishiba":         "Dogs2023Skin_HD.jpg",
    "kindredwoofandlamb": "Dogs2023Skin_HD.jpg",
    "kledkibblehead":     "Dogs2023Skin_HD.jpg",

    // === RPG 2015 — Braum (Lionheart), Gragas (Caskbreaker), Ryze (Whitebeard), Varus (Swiftbolt) ===
    "braumbraumlionheart":     "RPG2015Skin_HD.jpg",
    "gragasgragascaskbreaker": "RPG2015Skin_HD.jpg",
    "ryzeryzewhitebeard":      "RPG2015Skin_HD.jpg",
    "varusvarusswiftbolt":     "RPG2015Skin_HD.jpg",

    // === RPG 2016 — Bard (Bard Bard), Jayce (Brighthammer), Karthus (Lightsbane), Sejuani (Dawnchaser) ===
    "bardbardbard":             "RPG2016Skin_HD.jpg",
    "jaycejaycebrighthammer":   "RPG2016Skin_HD.jpg",
    "karthuskarthuslightsbane": "RPG2016Skin_HD.jpg",
    "sejuanisejuanidawnchaser": "RPG2016Skin_HD.jpg",

    // === RPG 2020 — Talon (Blackwood), Taric (Luminshield), Twitch (Shadowfoot) ===
    "talontalonblackwood":    "RPG2020Skin_HD.jpg",
    "tarictaricluminshield":  "RPG2020Skin_HD.jpg",
    "twitchtwitchshadowfoot": "RPG2020Skin_HD.jpg",

    // NOT EKLENMEMİŞ:
    // - April Fools 2015/2016/2017: skin key'lerini doğrulamadık (joke skinler)
    // - Guardian of the Sands 2015/2019: champion listesi belirsiz
    // - T1 2025: bireysel champion skinleri henüz wiki'de yok (Summer 2026 release)
};

async function fetchAll() {
    const members = [];
    let cmcontinue = null;
    let page = 0;
    while (true) {
        page++;
        const params = new URLSearchParams({
            action: "query",
            list: "categorymembers",
            cmtitle: CATEGORY,
            cmtype: "file",
            cmlimit: "500",
            format: "json",
            formatversion: "2",
        });
        if (cmcontinue) params.set("cmcontinue", cmcontinue);

        process.stdout.write(`  sayfa ${page}... `);
        const res = await fetch(`${API}?${params}`, {
            headers: { "User-Agent": "YAGPDB-selfhost-skin-lookup/1.0" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
        const data = await res.json();

        const batch = data.query?.categorymembers || [];
        members.push(...batch);
        process.stdout.write(`+${batch.length} (toplam ${members.length})\n`);

        cmcontinue = data.continue?.cmcontinue;
        if (!cmcontinue) break;
    }
    return members;
}

(async () => {
    console.log(`[skins] ${CATEGORY} taranıyor...`);
    const members = await fetchAll();

    const files = {};
    const champions = {};   // champKey → { name, skins: [{k, n, f, t}] }
    let collisions = 0;
    let skipped = 0;
    let tierMatched = 0;
    let tierMissing = 0;

    for (const m of members) {
        const filename = m.title.replace(/^File:/, "").replace(/ /g, "_");
        const info = parseFilename(filename);
        if (!info) {
            skipped++;
            continue;
        }
        const champKey = normalize(info.champ);
        const skinKey  = normalize(info.skin);
        const fullKey  = champKey + skinKey;

        if (files[fullKey] && files[fullKey] !== filename) {
            collisions++;
        }
        files[fullKey] = filename;

        if (!champions[champKey]) {
            champions[champKey] = { name: info.champ, skins: [] };
        }

        champions[champKey].skins.push({
            k: skinKey,
            n: prettifySkinName(info.skin),
            f: filename,
            t: "", // tier sonra set edilecek
        });
    }

    // Tier bilgisini CD'den çek ve eşleştir
    const cdTiers = await fetchCDAndMatchTiers(champions);
    for (const [champKey, champ] of Object.entries(champions)) {
        for (const skin of champ.skins) {
            const tierCode = cdTiers[champKey + skin.k];
            const tierInfo = tierCode && TIER_DISPLAY[tierCode];
            if (tierInfo) {
                skin.t = `${tierInfo.emoji} ${tierInfo.name} · ${tierInfo.rp} RP*`;
                skin.o = tierInfo.order;
                tierMatched++;
            } else {
                skin.o = 99;
                tierMissing++;
            }
        }
    }

    // Sort: Classic en başta, sonra rarity (yüksekten düşüğe), sonra alfabetik
    for (const c of Object.values(champions)) {
        c.skins.sort((a, b) => {
            if (a.n === "Classic") return -1;
            if (b.n === "Classic") return 1;
            if (a.o !== b.o) return a.o - b.o;
            return a.n.localeCompare(b.n);
        });
    }

    // Wiki tutarsızlığı override: bilinen grup splash'lar için file değiştir
    let exceptionsApplied = 0;
    for (const [champKey, champ] of Object.entries(champions)) {
        for (const skin of champ.skins) {
            const fullKey = champKey + skin.k;
            if (FILE_EXCEPTIONS[fullKey]) {
                skin.f = FILE_EXCEPTIONS[fullKey];
                files[fullKey] = FILE_EXCEPTIONS[fullKey];
                exceptionsApplied++;
            }
        }
    }
    if (exceptionsApplied > 0) {
        console.log(`[skins] ${exceptionsApplied} grup splash override uygulandı`);
    }

    const out = {
        generatedAt: new Date().toISOString(),
        category: CATEGORY,
        total: Object.keys(files).length,
        championCount: Object.keys(champions).length,
        skippedVariants: skipped,
        collisions,
        files,
        champions,
    };

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out));

    const sizeKB = (fs.statSync(OUT).size / 1024).toFixed(1);
    console.log(`\n[skins] ${out.total} skin → ${OUT}`);
    console.log(`[skins] Dosya boyutu: ${sizeKB} KB`);
    console.log(`[skins] Atlanan varyantlar: ${skipped}`);
    console.log(`[skins] Tier eşleşme: ${tierMatched}/${tierMatched + tierMissing} (${(100*tierMatched/(tierMatched+tierMissing)).toFixed(1)}%)`);
    if (collisions > 0) {
        console.log(`[skins] ⚠ ${collisions} key collision (rare)`);
    }

    // Hızlı sanity check
    console.log(`\n[skins] Örnek lookup'lar (tier dahil):`);
    for (const champKey of ["ahri", "ksante", "missfortune"]) {
        const c = champions[champKey];
        if (c) {
            console.log(`  ${c.name}:`);
            c.skins.slice(0, 3).forEach(s => console.log(`    ${s.n.padEnd(25)} ${s.t || "(tier yok)"}`));
        }
    }
})().catch((err) => {
    console.error("[skins] HATA:", err);
    process.exit(1);
});
