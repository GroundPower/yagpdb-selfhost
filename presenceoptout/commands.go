package presenceoptout

import (
	"strings"

	"github.com/botlabs-gg/yagpdb/v2/bot"
	"github.com/botlabs-gg/yagpdb/v2/commands"
	"github.com/botlabs-gg/yagpdb/v2/lib/dcmd"
	"github.com/botlabs-gg/yagpdb/v2/lib/discordgo"
)

var _ bot.BotInitHandler = (*Plugin)(nil)
var _ commands.CommandProvider = (*Plugin)(nil)

func (p *Plugin) BotInit() {
	if err := LoadCache(); err != nil {
		// IsOptedOut true dönmeye devam eder, yani presence özellikleri kapalı kalır
		logger.WithError(err).Error("presence opt-out cache yüklenemedi")
	}
}

func (p *Plugin) AddCommands() {
	commands.AddRootCommands(p, cmdPresence)
}

var cmdPresence = &commands.YAGCommand{
	CmdCategory:         commands.CategoryTool,
	Name:                "Presence",
	Description:         "Opt out of (or back into) presence processing. Actions: optout, optin, status",
	RunInDM:             true,
	SlashCommandEnabled: true,
	DefaultEnabled:      true,
	IsResponseEphemeral: true,
	RequiredArgs:        1,
	Arguments: []*dcmd.ArgDef{
		{Name: "Action", Help: "optout, optin or status", Type: dcmd.String},
	},
	RunFunc: func(data *dcmd.Data) (interface{}, error) {
		userID := data.Author.ID

		switch strings.ToLower(data.Args[0].Str()) {
		case "optout", "kapat":
			if err := OptOut(userID); err != nil {
				return nil, err
			}
			return optOutEmbed(), nil

		case "optin", "ac", "aç":
			if err := OptIn(userID); err != nil {
				return nil, err
			}
			return optInEmbed(), nil

		case "status", "durum":
			out, err := IsOptedOutDB(userID)
			if err != nil {
				return nil, err
			}
			return statusEmbed(out), nil
		}

		return "Valid actions / Geçerli seçenekler: `optout`, `optin`, `status`", nil
	},
}

func optOutEmbed() *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title: "Presence processing disabled",
		Description: "BetterYAG will no longer use your online status or activity in any server: " +
			"no streaming role or announcement, not counted in `topgames`, hidden in `whois`, " +
			"and presence updates are not used for username history.\n" +
			"Turn it back on with `presence optin`.\n\n" +
			"Presence işleme kapatıldı: çevrimiçi durumun ve aktiviten hiçbir sunucuda kullanılmayacak. " +
			"Geri açmak için `presence optin`.",
		Color: 0x43b581,
	}
}

func optInEmbed() *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title: "Presence processing enabled",
		Description: "Streaming roles, `topgames` and `whois` will use your presence again.\n" +
			"Turn it off with `presence optout`.\n\n" +
			"Presence işleme tekrar açıldı. Kapatmak için `presence optout`.",
		Color: 0x43b581,
	}
}

func statusEmbed(optedOut bool) *discordgo.MessageEmbed {
	state := "**On**: your presence is used for streaming roles, `topgames` and `whois`.\n" +
		"**Açık**: presence verin işleniyor."
	if optedOut {
		state = "**Off**: your presence is not processed.\n**Kapalı**: presence verin işlenmiyor."
	}
	return &discordgo.MessageEmbed{
		Title:       "Presence processing",
		Description: state,
		Color:       0x7289da,
	}
}
