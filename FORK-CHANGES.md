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

---

## Notlar
- `pull-upstream.sh` çalıştırırken bu commit'lerin üstüne merge/rebase geleceğine dikkat et; conflict çıkarsa `tmplSendDM` bizim sürümde kalsın.
- Rollback image (eski sendDM modu öncesi build): `yagpdb_docker-app:backup`.
- Rebuild ~5 dk, ~3GB geçici disk (sonra `docker builder prune -f`).
