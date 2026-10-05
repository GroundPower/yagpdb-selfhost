package web

// Fork: the bot owner also sees every server the bot is in in the server dropdown, including
// servers they aren't a member of. IsAdminRequest already gives the owner full access to those
// control panels; this only lists them.

import (
	"context"
	"slices"

	"github.com/botlabs-gg/yagpdb/v2/bot/models"
	"github.com/botlabs-gg/yagpdb/v2/common"
	"github.com/volatiletech/sqlboiler/v4/queries/qm"
)

type ownerExtraGuild struct {
	ID   int64
	Name string
	Icon string
}

// ownerExtraGuilds returns the servers the bot is in that aren't already in the owner's own list
func ownerExtraGuilds(ctx context.Context, managed []*common.GuildWithConnected) []*ownerExtraGuild {
	joined, err := models.JoinedGuilds(qm.Where("left_at IS NULL"), qm.OrderBy("name")).All(ctx, common.PQ)
	if err != nil {
		CtxLogger(ctx).WithError(err).Error("failed fetching joined guilds for the bot owner")
		return nil
	}

	out := make([]*ownerExtraGuild, 0, len(joined))
	for _, g := range joined {
		inList := slices.ContainsFunc(managed, func(m *common.GuildWithConnected) bool {
			return m.Connected && m.ID == g.ID
		})
		if !inList {
			out = append(out, &ownerExtraGuild{ID: g.ID, Name: g.Name, Icon: g.Avatar})
		}
	}
	return out
}
