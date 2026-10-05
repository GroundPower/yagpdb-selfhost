package presenceoptout

// Presence opt-out (fork eklentisi, 2026-09).
//
// Kullanıcı "presence optout" ile botun presence işlemesinin tamamen dışında kalır:
// yayın rolü/duyurusu, topgames, whois durum satırı ve presence üzerinden kullanıcı
// adı takibi onu atlar. Postgres kaynak doğruluk, bellek içi set sıcak yol: presence
// event'leri saniyede yüzlerce gelebilir, her biri için DB'ye gidilmez.
//
// Tek process varsayar (compose "-all" ile çalışıyor). Bot ayrı shard process'lerine
// bölünürse cache yerine Redis set'e geçilmeli.

import (
	"database/sql"
	"sync"

	"github.com/botlabs-gg/yagpdb/v2/common"
)

var DBSchemas = []string{`
CREATE TABLE IF NOT EXISTS presence_optouts (
	user_id     BIGINT PRIMARY KEY,
	created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
`}

type Plugin struct{}

func (p *Plugin) PluginInfo() *common.PluginInfo {
	return &common.PluginInfo{
		Name:     "Presence Opt-Out",
		SysName:  "presence_optout",
		Category: common.PluginCategoryMisc,
	}
}

func RegisterPlugin() {
	common.InitSchemas("presence_optout", DBSchemas...)
	common.RegisterPlugin(&Plugin{})
}

var (
	cacheMu sync.RWMutex
	cache   = make(map[int64]struct{})
	loaded  bool
)

// LoadCache bot açılırken BotInit içinden bir kez çağrılır.
func LoadCache() error {
	rows, err := common.PQ.Query("SELECT user_id FROM presence_optouts")
	if err != nil {
		return err
	}
	defer rows.Close()

	fresh := make(map[int64]struct{})
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return err
		}
		fresh[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	cacheMu.Lock()
	cache = fresh
	loaded = true
	cacheMu.Unlock()
	return nil
}

// IsOptedOut sıcak yolda çağrılır. Cache yüklenemediyse herkes için true döner:
// emin olamadığımız sürece kimsenin presence verisini işlemeyiz.
func IsOptedOut(userID int64) bool {
	cacheMu.RLock()
	defer cacheMu.RUnlock()
	if !loaded {
		return true
	}
	_, ok := cache[userID]
	return ok
}

func OptOut(userID int64) error {
	_, err := common.PQ.Exec("INSERT INTO presence_optouts (user_id) VALUES ($1) ON CONFLICT DO NOTHING", userID)
	if err != nil {
		return err
	}

	cacheMu.Lock()
	cache[userID] = struct{}{}
	cacheMu.Unlock()
	return nil
}

func OptIn(userID int64) error {
	_, err := common.PQ.Exec("DELETE FROM presence_optouts WHERE user_id = $1", userID)
	if err != nil {
		return err
	}

	cacheMu.Lock()
	delete(cache, userID)
	cacheMu.Unlock()
	return nil
}

// IsOptedOutDB cache'i atlayıp doğrudan DB'ye sorar. Sadece komut cevaplarında kullan.
func IsOptedOutDB(userID int64) (bool, error) {
	var exists bool
	err := common.PQ.QueryRow("SELECT EXISTS(SELECT 1 FROM presence_optouts WHERE user_id = $1)", userID).Scan(&exists)
	if err != nil && err != sql.ErrNoRows {
		return false, err
	}
	return exists, nil
}
