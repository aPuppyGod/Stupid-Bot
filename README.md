# Stupid Bot

A feature-rich Discord bot with economy, leveling, games, and administrative features.

## Features

### Economy & Leveling
- Earn coins and XP from messages, reactions, and voice chat
- Configurable rewards and cooldowns
- Level-up system with automatic notifications

### Medieval-Themed Commands
- `!beg` / `/fun beg` - Beg for coins
- `!pickpocket @user` / `/fun pickpocket` - Attempt to pickpocket (with catch chance)
- `!slap`, `!punch`, `!duel` - Interactive commands
- `!praise`, `!insult` - Roleplay commands

### Mafia Game
- Full lobby system with auto-updating player panels
- Role assignment (mafia, medic, detective, villager)
- Day/night cycle gameplay

### Birthday System
- Users can set birthdays with `!birthday set DD/MM/YYYY`
- Automatic daily announcements
- Timezone-aware (Europe/London)

### Admin Tools
- Role-based cooldown management
- Economy panel for configuration
- Role panel for auto-assignment
- Admin commands auto-delete for cleaner channels

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file with:
   ```
   DISCORD_TOKEN=your_bot_token_here
   DISCORD_GUILD_ID=your_guild_id_here
   ```

3. Configure channels in `index.js`:
   - `LOG_CHANNEL_ID` - Where admin logs appear
   - `LEVEL_UP_CHANNEL_ID` - Where level-up messages are sent

4. Run the bot:
   ```bash
   node index.js
   ```

## Commands

Type `!commands` or `/commands` to see all available commands in Discord.

## Data Storage

- `data.json` - User data, economy settings, birthdays
- `cooldowns.json` - Role-based cooldown rules

## Requirements

- Node.js
- discord.js v14
- A Discord bot token
