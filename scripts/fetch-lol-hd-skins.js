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
const OUT = path.join(__dirname, "..", "data", "lolHdSkins.json");

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
    const champions = {};   // champKey → { name, skins: [{k, n, f}] }
    let collisions = 0;
    let skipped = 0;

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
    if (collisions > 0) {
        console.log(`[skins] ⚠ ${collisions} key collision (rare)`);
    }

    // Hızlı sanity check
    console.log(`\n[skins] Örnek lookup'lar:`);
    for (const k of ["ahrioriginal", "ahrikdaallout", "ksanteoriginal", "missfortunearcade", "leesinacolyte"]) {
        console.log(`  ${k.padEnd(28)} → ${files[k] || "✗ yok"}`);
    }
})().catch((err) => {
    console.error("[skins] HATA:", err);
    process.exit(1);
});
