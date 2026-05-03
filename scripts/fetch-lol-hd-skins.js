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

// kEpic, kLegendary, kMythic vs. → kullanıcı dostu format + tahmini RP
// (RP'ler tier'ın tipik fiyatı; legacy/event skin'lerde farklılık olabilir)
const TIER_DISPLAY = {
    kEpic:         { emoji: "🟣", name: "Epic",         rp: "~1350" },
    kLegendary:    { emoji: "🟡", name: "Legendary",    rp: "~1820" },
    kMythic:       { emoji: "🌸", name: "Mythic",       rp: "ME"     }, // Mythic Essence
    kUltimate:     { emoji: "🔴", name: "Ultimate",     rp: "~3250" },
    kRare:         { emoji: "🔵", name: "Rare",         rp: "limited" },
    kExalted:      { emoji: "💎", name: "Exalted",      rp: "~5400" },
    kTranscendent: { emoji: "✨", name: "Transcendent", rp: "—"      },
    kNoRarity:     { emoji: "⚪", name: "Standard",     rp: "~975"  },
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
        const champKey = normalize(champMatch[1]);

        const wikiChamp = wikiChampions[champKey];
        if (!wikiChamp) continue; // wiki'de bu champion yoksa atla

        const cdNameKey = normalize(cdSkin.name);
        const rarity = cdSkin.rarity || "kNoRarity";

        // Base skin → wiki "original"
        if (cdSkin.isBase) {
            tiers[champKey + "original"] = rarity;
            continue;
        }

        // Non-base: CD name'i normalize ettikten sonra wiki skin'lerinden hangisi
        // içinde tam olarak geçiyor? En uzun key'i seç (kdaallout > kda gibi).
        const candidates = wikiChamp.skins
            .filter(s => s.k !== "original" && s.k.length >= 3 && cdNameKey.includes(s.k))
            .sort((a, b) => b.k.length - a.k.length);

        if (candidates.length > 0) {
            tiers[champKey + candidates[0].k] = rarity;
        }
    }

    return tiers;
}

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

    // Her şampiyonun skin'lerini isim sırala, Classic en başa
    for (const c of Object.values(champions)) {
        c.skins.sort((a, b) => {
            if (a.n === "Classic") return -1;
            if (b.n === "Classic") return 1;
            return a.n.localeCompare(b.n);
        });
    }

    // Tier bilgisini CD'den çek ve eşleştir
    const cdTiers = await fetchCDAndMatchTiers(champions);
    for (const [champKey, champ] of Object.entries(champions)) {
        for (const skin of champ.skins) {
            const tierCode = cdTiers[champKey + skin.k];
            const tierInfo = tierCode && TIER_DISPLAY[tierCode];
            if (tierInfo) {
                skin.t = `${tierInfo.emoji} ${tierInfo.name} · ${tierInfo.rp} RP`;
                tierMatched++;
            } else {
                tierMissing++;
            }
        }
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
