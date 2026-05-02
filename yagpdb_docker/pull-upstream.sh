#!/usr/bin/env bash
# Upstream YAGPDB'den son değişiklikleri çek ve senin custom modlarına merge et.
#
# Kullanım:
#   ./yagpdb_docker/pull-upstream.sh
#
# Yaptığı:
#   1. origin'den fetch
#   2. Aradaki yeni commit listesi + etkilenen dosyaları göster
#   3. Sen onaylarsan merge et
#   4. Conflict varsa hangi dosyalarda olduğunu listele, çözmesi sana kalır
#   5. Temiz merge'de build + push komutlarını hatırlat (otomatik yapmaz)

cd "$(dirname "$0")/.."

# Renkler (TTY'de)
if [ -t 1 ]; then
    R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; B=$'\e[36m'; N=$'\e[0m'
else
    R=''; G=''; Y=''; B=''; N=''
fi

step() { echo; echo "${B}[$1]${N} $2"; }
ok()   { echo "${G}✓${N} $1"; }
warn() { echo "${Y}⚠${N} $1"; }
err()  { echo "${R}✗${N} $1"; }

# 0. Tracked dosyalarda uncommitted değişiklik var mı? (untracked dosyalar tolere edilir)
DIRTY=$(git status --porcelain | grep -v '^??' || true)
if [ -n "$DIRTY" ]; then
    err "Tracked dosyalarda uncommitted değişiklik var. Önce commit/stash et."
    echo "$DIRTY"
    exit 1
fi

# 1. Fetch
step "1/4" "origin'den fetch ediliyor..."
git fetch origin || { err "Fetch başarısız."; exit 1; }
ok "Fetch tamam."

# 2. Yeni commit var mı?
NEW=$(git rev-list --count master..origin/master 2>/dev/null || echo 0)
if [ "$NEW" -eq 0 ]; then
    step "2/4" "Yeni commit yok."
    ok "Upstream zaten güncel. İşin bitti."
    exit 0
fi

step "2/4" "$NEW yeni commit bulundu:"
git log --oneline --no-decorate master..origin/master | head -40

step "3/4" "Etkilenen dosyalar:"
git diff --stat master..origin/master | tail -20

# Senin önemli dosyalarına dokunan upstream commit'leri varsa uyarı
DANGER_FILES=(
    "customcommands/customcommands.go"
    "customcommands/bot.go"
    "customcommands/tmplextensions.go"
    "common/templates/context.go"
    "common/templates/context_funcs.go"
    "commands/tmplexec.go"
    "lib/discordgo/restapi.go"
)
WILL_CONFLICT=()
for f in "${DANGER_FILES[@]}"; do
    if git diff --name-only master..origin/master | grep -qx "$f"; then
        WILL_CONFLICT+=("$f")
    fi
done

if [ ${#WILL_CONFLICT[@]} -gt 0 ]; then
    echo
    warn "Senin custom modların olan dosyalara dokunuldu — conflict bekliyebilirsin:"
    for f in "${WILL_CONFLICT[@]}"; do
        echo "    - $f"
    done
fi

# 3. Onay
echo
read -p "$(echo "${B}[?]${N}") Merge edelim mi? (y/N) " -r yn
case "$yn" in
    [Yy]*) ;;
    *) echo "İptal."; exit 0 ;;
esac

# 4. Merge
step "4/4" "Merging origin/master..."
if git merge origin/master --no-edit; then
    echo
    ok "Temiz merge — conflict yok."
    echo
    echo "${B}Sırada:${N}"
    echo "  1. Compile testi:    ${Y}go build ./...${N}"
    echo "  2. Container rebuild:"
    echo "     ${Y}cd yagpdb_docker && docker compose -f docker-compose.dev.yml up -d --build app${N}"
    echo "  3. Discord'da CC'leri test et"
    echo "  4. Her şey iyiyse push: ${Y}git push personal master${N}"
else
    echo
    err "CONFLICT — şu dosyaları manuel çözmen lazım:"
    git diff --name-only --diff-filter=U | sed 's/^/    - /'
    echo
    echo "${B}Çözüm rehberi:${N}"
    echo "  - Limit sabitleri (MaxCommands vs.) → ${G}seninkini tut${N}"
    echo "  - Function register listesi (context.go) → ${G}ikisini de tut${N}"
    echo "  - Voice mod / httpGet fonksiyonları → ${G}seninkini tut${N}"
    echo
    echo "Çözdükten sonra:"
    echo "  ${Y}git add <çözdüğün dosyalar>${N}"
    echo "  ${Y}git commit${N}    (default merge mesajı yeterli)"
    echo
    echo "Pes etmek istersen:"
    echo "  ${Y}git merge --abort${N}    (her şey eski hâline döner)"
    exit 1
fi
