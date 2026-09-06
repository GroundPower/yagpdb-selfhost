# Fork Changes — GroundPower/yagpdb-selfhost (VPS build tree)

Upstream'den (botlabs-gg/yagpdb) ayrılan tüm değişikliklerin kaydı.
Bu ağaç: `/opt/yagpdb-build`. Deploy:
`cd /opt/yagpdb-build/yagpdb_docker && docker compose build app`
sonra `cd /opt/yagpdb && docker compose up -d app`.

Hepsi artık `master`'da commit'li. Parantez içindeki tarih = değişikliğin yapıldığı gün.

---

## Template fonksiyonları

### Özel fonksiyonlar
`httpGet`, `httpGetJSON` (HTTP istekleri) ve 5 ses-moderasyon fonksiyonu:
`moveMember`, `muteMember`, `unmuteMember`, `deafenMember`, `undeafenMember`,
ayrıca `getGuildMembers`. (`getMemberVoiceState` upstream'de zaten var.)

### sendDM — keyfi kullanıcıya DM  (2026-06-28)
`common/templates/context_funcs.go` -> `tmplSendDM`.
2+ argümanla çağrılınca ilk argümanı `TargetUserID(s[0])` ile hedef kullanıcı sayar:
- `{{ sendDM <userID> <mesaj> }}`  -> o kullanıcıya DM
- `{{ sendDM <mesaj> }}`           -> komutu tetikleyene DM (eski davranış)

### sendDM — "Show Server Info" butonu artık OPSİYONEL  (2026-08-04)
Stok YAGPDB her DM'e `bot.GenerateServerInfoButton` (bot/util.go:220 — 📬 "Show Server
Info", CustomID `DM_<guildID>`) butonunu ZORLA ekliyordu. Artık varsayılan KAPALI.
`tmplSendDM` içine `addServerInfo` bayrağı eklendi; butonu istersen ilk argüman olarak
`"serverinfo"` geç:
- `{{ sendDM <userID> <mesaj> }}`               -> butonsuz (yeni varsayılan)
- `{{ sendDM "serverinfo" <userID> <mesaj> }}`  -> butonlu

Bayrak, hedef/userID tespitinden ÖNCE tüketilir. Edge case: tek başına
`{{ sendDM "serverinfo" }}` -> no-op (mesaj kalmaz).

### sendDM - member'siz baglamlarda da calisiyor  (2026-09-06)
v2.84.0 merge'i ile gelen context menu CC'leri `templates.NewContext(gs, cs, nil)`
kullaniyor, yani `c.MS == nil`. Upstream'in `tmplSendDM`'i daha ilk satirda
`c.MS == nil` ise bosa donuyordu, dolayisiyla bizim acik hedefli surumumuz de
oralarda sessizce hicbir sey yapmiyordu.

Kisit kaldirildi. Sozlesme her baglamda ayni:

- `{{ sendDM <mesaj> }}`          -> komutu CALISTIRAN kisiye DM
- `{{ sendDM <userID> <mesaj> }}` -> o userID'ye DM

Ortuk form artik `c.MS` yoksa pes etmiyor; `implicitDMTarget()` helper'i sirayla
`c.MS` -> `Interaction.Member.User` -> `Interaction.User` bakiyor. Context menu CC'sinde
invoker zaten interaction'da duruyor (handler onu `.Author` olarak da veriyor), o yuzden
ortuk form orada da dogru kisiye gidiyor.

Gercekten kimsenin olmadigi baglamlarda (interval/scheduled CC, youtube/twitch feed)
helper 0 donuyor ve ortuk form no-op kaliyor - orada "tetikleyen" diye biri yok.
Acik hedefli form o baglamlarda da calisiyor.

Etkilenen (member'siz) baglamlar:
`handle_contextmenu.go`, `handle_role.go` (role trigger), `handle_timed.go`
(interval + scheduled CC), `youtube/bot.go`, `twitch/bot.go`.

Ayrica `addServerInfo` dali `c.GS != nil` ile korundu - `web/validation.go` nil GS ile
context kurdugu icin panic ihtimaline karsi.

**Upstream'den bilincli ayrilma:** upstream nil member'i context menu CC'lerinin
rastgele birine DM atmasini ENGELLEMEK icin kullaniyordu (`handle_contextmenu.go`
yorumuna bak). Biz bu yetkiyi bilerek geri aciyoruz. `pull-upstream.sh` sonrasi
conflict cikarsa bizimki kalsin.

---

## Upstream merge'leri

### v2.76.4 -> v2.84.0  (2026-09-06)
69 upstream commit merge edildi (`git merge upstream/master`). Tek conflict:
`customcommands/customcommands.go` limit sabitleri.

Cozum: bizim yukseltilmis limitlerimiz korundu, upstream'in yeni ekledigi 4 sabit
Discord tavanina gore maksimuma alindi:

| Sabit | Upstream | Bizde |
|---|---|---|
| `MaxSlashCommandCCs` | 3 | **100** |
| `MaxSlashCommandCCsPremium` | 10 | **100** |
| `MaxContextMenuCCs` | 1 | **5** |
| `MaxContextMenuCCsPremium` | 5 | **5** |

Discord'un sert tavani: guild basina 100 application command, tip basina 5 context
menu komutu. Context menu'yu 5'in ustune cikarma - Discord kaydi reddeder.

Gelen basliklar: custom slash command CC'leri, context menu CC'leri, message creator,
tum template alanlarinda CodeMirror, CSRF middleware + messagecreator.js XSS fix,
host-level ratelimit lockdown, bagimlilik bump'lari.

DB: tek additive migration (`custom_commands.slash_command_options JSONB`) - otomatik
uygulandi, geriye donuk uyumlu (eski image ile rollback guvenli).

**Varsayilan kapali gelen upstream ozellikleri** (self-host'u etkilemez):
- `yagpdb.disable_prefix_commands` (false) - prefix komutlar calismaya devam ediyor
- `yagpdb.enable_prefix_commands_warning` (false) - "10. komutta bildirim" nag'i kapali

Acmak istersen `app.env`'e ekle.

### pull-upstream.sh duzeltildi  (2026-09-06)
Script bozuktu: `upstream/master` yerine `origin/master` (yani kendi fork'umuz) ile
karsilastirip merge ediyordu, bu yuzden upstream'de 69 commit birikmisken hep
"Upstream zaten guncel" diyordu. Artik:
- `upstream` remote'u yoksa otomatik ekliyor (botlabs-gg/yagpdb)
- shallow clone'u otomatik aciyor (merge-base icin sart)
- hem `origin` hem `upstream` fetch ediyor, `upstream/master` ile merge ediyor
- push hedefi `personal` degil `origin`

---

## Notlar
- `pull-upstream.sh` çalıştırırken bu commit'lerin üstüne merge/rebase geleceğine dikkat et; conflict çıkarsa `tmplSendDM` bizim sürümde kalsın.
- Rollback image: `yagpdb_docker-app:backup` (2026-09-06 itibariyla = v2.76.4 build,
  upstream merge oncesi). Geri donmek icin `/opt/yagpdb/docker-compose.yml` icinde
  image tag'ini `:backup` yapip `docker compose up -d app`.
- Rebuild ~5 dk, ~3GB geçici disk (sonra `docker builder prune -f`).
