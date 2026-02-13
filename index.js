/**
 * index.js — Discord Bot
 *
 * Updates requested:
 * ✅ Only ADMIN command messages get deleted (e.g. !setcooldown). Normal user commands like !balance stay.
 * ✅ Bot replies do NOT auto-delete (no disappearing bot messages).
 * ✅ Mafia lobby panel auto-updates player count when people join/leave.
 * ✅ Pickpocket has a chance to be caught; caught attempts go on record.
 * ✅ If a user reaches N caught pickpockets (default 5), they get a configurable role.
 * ✅ Admin can edit pickpocket caught chance / limit / punish role via an Economy Panel (UI).
 *
 * Commands support:
 * ✅ Prefix "!" and Slash "/"
 * ✅ Admin-only commands require Administrator (both ! and /)
 *
 * Notes:
 * - Slash commands register instantly to one guild if DISCORD_GUILD_ID is set.
 * - Data stored in data.json; cooldown rules in cooldowns.json.
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  ChannelType,
  Events,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const fs = require("fs");
const path = require("path");

/* ================= CONFIG ================= */
const PREFIX = "!";
const LOG_CHANNEL_ID = "1458550892889510151";

// Level-up messages ALWAYS go here (forced)
const LEVEL_UP_CHANNEL_ID = "1458565543572537446";

// Slash commands registration (recommended: set your guild id for instant updates)
const GUILD_ID_FOR_SLASH = process.env.DISCORD_GUILD_ID || "";

/* ADMIN prefix commands that should have their COMMAND MESSAGE deleted */
const ADMIN_PREFIX_COMMANDS = new Set([
  "setcooldown",
  "clearcooldown",
  "ignorecooldown",
  "unignorecooldown",
  "rolepanel",
  "economypanel",
  "setbirthdaymsg",
  "setbirthdaychannel"
]);
/* ========================================= */

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN env var.");
  process.exit(1);
}

const cooldownFile = path.join(__dirname, "cooldowns.json");
const dataFile = path.join(__dirname, "data.json");

/* ================= FILE IO ================= */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8") || "{}");
  } catch {
    return {};
  }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

const rules = readJson(cooldownFile);
let data = readJson(dataFile);

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeJson(dataFile, data);
  }, 600);
}

/* ================= HELPERS ================= */
async function tryDelete(msg, delayMs = 0) {
  try {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    await msg.delete();
  } catch {}
}

async function adminLog(guild, content) {
  const ch = guild.channels.cache.get(LOG_CHANNEL_ID);
  if (!ch) return;
  ch.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
}

/** Bot replies should NOT disappear — default deleteAfterMs=0 */
async function userNotice(message, content, deleteAfterMs = 0) {
  const sent = await message.channel
    .send({ content, allowedMentions: { parse: [] } })
    .catch(() => null);

  if (sent && deleteAfterMs > 0) {
    setTimeout(() => sent.delete().catch(() => {}), deleteAfterMs);
  }
}

async function iNotice(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      return interaction.followUp({ content, ephemeral: true, allowedMentions: { parse: [] } });
    }
    return interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
  } catch {}
}

function isAdminMember(memberOrPermissions) {
  try {
    if (!memberOrPermissions) return false;
    if (typeof memberOrPermissions.has === "function") {
      return memberOrPermissions.has(PermissionsBitField.Flags.Administrator);
    }
    if (memberOrPermissions.permissions?.has) {
      return memberOrPermissions.permissions.has(PermissionsBitField.Flags.Administrator);
    }
  } catch {}
  return false;
}

function ensureGuild(guildId) {
  if (!data[guildId]) data[guildId] = {};

  // Economy / leveling
  if (!data[guildId].eco) data[guildId].eco = {};
  const eco = data[guildId].eco;

  // message rewards
  if (typeof eco.msgRewardCooldownSec !== "number") eco.msgRewardCooldownSec = 20;
  if (typeof eco.msgCoinsMin !== "number") eco.msgCoinsMin = 1;
  if (typeof eco.msgCoinsMax !== "number") eco.msgCoinsMax = 3;
  if (typeof eco.msgXpMin !== "number") eco.msgXpMin = 5;
  if (typeof eco.msgXpMax !== "number") eco.msgXpMax = 10;

  // reaction rewards
  if (typeof eco.reactRewardCooldownSec !== "number") eco.reactRewardCooldownSec = 10;
  if (typeof eco.reactCoins !== "number") eco.reactCoins = 1;
  if (typeof eco.reactXp !== "number") eco.reactXp = 2;

  // voice rewards
  if (typeof eco.vcCoinsPerMin !== "number") eco.vcCoinsPerMin = 1;
  if (typeof eco.vcXpPerMin !== "number") eco.vcXpPerMin = 2;

  // leveling curve
  if (typeof eco.baseXp !== "number") eco.baseXp = 100;

  // pickpocket punish system (editable via Economy Panel)
  if (typeof eco.pickpocketCaughtChance !== "number") eco.pickpocketCaughtChance = 0.35; // 35%
  if (typeof eco.pickpocketCaughtLimit !== "number") eco.pickpocketCaughtLimit = 5;
  if (typeof eco.pickpocketPunishRoleId !== "string") eco.pickpocketPunishRoleId = ""; // role id to give at limit

  // Auto-roles / role rules
  if (!data[guildId].roles) data[guildId].roles = {};
  if (typeof data[guildId].roles.joinRoleId !== "string") data[guildId].roles.joinRoleId = "";
  if (!data[guildId].roles.roleRules) data[guildId].roles.roleRules = {};

  // Medieval custom commands
  if (!data[guildId].custom) data[guildId].custom = {};
  if (!data[guildId].custom.commands) {
    data[guildId].custom.commands = {
      beg:        { enabled: true, allowedRoleIds: [], coinsMin: 1, coinsMax: 6,  cooldownSec: 60 },
      pickpocket: { enabled: true, allowedRoleIds: [], coinsMin: 0, coinsMax: 10, cooldownSec: 90 },
      slap:       { enabled: true, allowedRoleIds: [], coinsMin: 0, coinsMax: 0,  cooldownSec: 20 },
      punch:      { enabled: true, allowedRoleIds: [], coinsMin: 0, coinsMax: 0,  cooldownSec: 25 },
      duel:       { enabled: true, allowedRoleIds: [], coinsMin: 0, coinsMax: 15, cooldownSec: 120 },
      praise:     { enabled: true, allowedRoleIds: [], coinsMin: 0, coinsMax: 0,  cooldownSec: 15 },
      insult:     { enabled: true, allowedRoleIds: [], coinsMin: 0, coinsMax: 0,  cooldownSec: 15 }
    };
  }

  // Birthdays
  if (!data[guildId].birthdays) data[guildId].birthdays = {};
  if (!data[guildId].birthdays.users) data[guildId].birthdays.users = {};
  if (typeof data[guildId].birthdays.messageTemplate !== "string") {
    data[guildId].birthdays.messageTemplate = "🎂 Happy birthday {user}! Everyone wish them a great day!";
  }
  if (typeof data[guildId].birthdays.channelId !== "string" || !data[guildId].birthdays.channelId) {
    data[guildId].birthdays.channelId = LEVEL_UP_CHANNEL_ID;
  }
  if (typeof data[guildId].birthdays.pingRoleId !== "string") data[guildId].birthdays.pingRoleId = "";
  if (typeof data[guildId].birthdays.lastAnnouncedDate !== "string") data[guildId].birthdays.lastAnnouncedDate = "";

  // Users
  if (!data[guildId].users) data[guildId].users = {};

  scheduleSave();
}

function ensureUser(guildId, userId) {
  ensureGuild(guildId);
  if (!data[guildId].users[userId]) {
    data[guildId].users[userId] = {
      coins: 0,
      xp: 0,
      level: 0,
     
      lastMsgReward: 0,
      lastReactReward: 0,
      vcJoinAt: null,

      customCooldowns: {},
      pickpocketCaught: 0
    };
  } else {
    const u = data[guildId].users[userId];
    if (!u.customCooldowns) u.customCooldowns = {};
    if (typeof u.pickpocketCaught !== "number") u.pickpocketCaught = 0;
  }
  scheduleSave();
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function weightedPick(weightMap) {
  const entries = Object.entries(weightMap)
    .map(([id, w]) => [id, Number(w)])
    .filter(([, w]) => Number.isFinite(w) && w > 0);

  let total = 0;
  for (const [, w] of entries) total += w;
  if (total <= 0) return null;

  let r = Math.random() * total;
  for (const [id, w] of entries) {
    r -= w;
    if (r <= 0) return id;
  }
  return entries[entries.length - 1]?.[0] ?? null;
}

function xpToLevel(guildId, xp) {
  const base = data[guildId].eco.baseXp;
  let lvl = 0;
  let spent = 0;
  while (true) {
    const next = base * (lvl + 1) * (lvl + 1);
    if (spent + next > xp) break;
    spent += next;
    lvl++;
    if (lvl > 5000) break;
  }
  return lvl;
}

function addRewards(guildId, userId, coins, xp) {
  ensureUser(guildId, userId);
  const u = data[guildId].users[userId];
  u.coins += coins;
  u.xp += xp;

  const newLevel = xpToLevel(guildId, u.xp);
  const leveledUp = newLevel > u.level;
  u.level = newLevel;

  scheduleSave();
  return { leveledUp, level: u.level };
}

/* ================= COOLDOWN ENFORCEMENT ================= */
for (const guildId of Object.keys(rules)) {
  if (!Array.isArray(rules[guildId]._ignoredChannels)) rules[guildId]._ignoredChannels = [];
}
const lastSent = new Map();
function getUserBucket(guildId, userId) {
  if (!lastSent.has(guildId)) lastSent.set(guildId, new Map());
  const g = lastSent.get(guildId);
  if (!g.has(userId)) g.set(userId, new Map());
  return g.get(userId);
}
function isChannelIgnoredCooldown(guildId, channelId) {
  return (
    rules[guildId] &&
    Array.isArray(rules[guildId]._ignoredChannels) &&
    rules[guildId]._ignoredChannels.includes(channelId)
  );
}
function getCooldownForMember(member, channelId) {
  const guildId = member.guild.id;
  const guildRules = rules[guildId] || {};
  let best = { seconds: 0, key: null };

  for (const [roleId] of member.roles.cache) {
    const r = guildRules[roleId];
    if (!r) continue;

    if (r.channels && r.channels[channelId]) {
      const sec = Number(r.channels[channelId]);
      if (sec > best.seconds) best = { seconds: sec, key: `ch:${channelId}` };
    }
    if (r.global) {
      const sec = Number(r.global);
      if (sec > best.seconds) best = { seconds: sec, key: "global" };
    }
  }
  return best;
}

/* ================= BIRTHDAY SYSTEM ================= */
function londonTodayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}
function londonMonthDay() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return { month: Number(m), day: Number(d) };
}
async function ensureBirthdayPingRole(guild) {
  const guildId = guild.id;
  ensureGuild(guildId);

  const existingId = data[guildId].birthdays.pingRoleId;
  if (existingId && guild.roles.cache.get(existingId)) return existingId;

  const found = guild.roles.cache.find((r) => r.name.toLowerCase() === "birthday pings");
  if (found) {
    data[guildId].birthdays.pingRoleId = found.id;
    scheduleSave();
    return found.id;
  }

  if (!guild.members.me?.permissions?.has(PermissionsBitField.Flags.ManageRoles)) return "";

  try {
    const role = await guild.roles.create({ name: "birthday pings", mentionable: true });
    data[guildId].birthdays.pingRoleId = role.id;
    scheduleSave();
    return role.id;
  } catch {
    return "";
  }
}
async function runBirthdayCheck(client) {
  const todayKey = londonTodayKey();
  const { month, day } = londonMonthDay();

  for (const guild of client.guilds.cache.values()) {
    const guildId = guild.id;
    ensureGuild(guildId);

    if (data[guildId].birthdays.lastAnnouncedDate === todayKey) continue;

    const users = data[guildId].birthdays.users || {};
    const birthdayUserIds = Object.entries(users)
      .filter(([, b]) => b && Number(b.month) === month && Number(b.day) === day)
      .map(([uid]) => uid);

    if (birthdayUserIds.length === 0) {
      data[guildId].birthdays.lastAnnouncedDate = todayKey;
      scheduleSave();
      continue;
    }

    const pingRoleId = await ensureBirthdayPingRole(guild);
    const pingText = pingRoleId ? `<@&${pingRoleId}>` : "";

    const channelId = data[guildId].birthdays.channelId || LEVEL_UP_CHANNEL_ID;
    const ch = guild.channels.cache.get(channelId) || guild.channels.cache.get(LEVEL_UP_CHANNEL_ID);
    if (!ch) {
      data[guildId].birthdays.lastAnnouncedDate = todayKey;
      scheduleSave();
      continue;
    }

    const template = data[guildId].birthdays.messageTemplate || "🎂 Happy birthday {user}!";

    for (const uid of birthdayUserIds.slice(0, 20)) {
      const b = users[uid];
      const display = `<@${uid}>`;

      let ageText = "";
      if (b?.year && Number.isFinite(Number(b.year))) {
        const y = Number(b.year);
        const nowYear = Number(todayKey.slice(0, 4));
        const age = nowYear - y;
        if (age > 0 && age < 130) ageText = String(age);
      }

      const msg = template.replaceAll("{user}", display).replaceAll("{age}", ageText);
      const finalMsg = pingText ? `${pingText} ${msg}` : msg;

      await ch.send({ content: finalMsg, allowedMentions: { parse: ["roles", "users"] } }).catch(() => {});
    }

    data[guildId].birthdays.lastAnnouncedDate = todayKey;
    scheduleSave();
  }
}

/* ================= MAFIA ================= */
const mafiaGames = new Map(); // guildId -> state

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function mafiaRoleCounts(n) {
  const mafia = Math.max(1, Math.floor(n / 4));
  const medic = n >= 5 ? 1 : 0;
  const detective = n >= 6 ? 1 : 0;
  const villager = Math.max(0, n - mafia - medic - detective);
  return { mafia, medic, detective, villager };
}
function mafiaWinCheck(game) {
  const living = [...game.living];
  const mafiaLiving = living.filter((id) => game.roles.get(id) === "mafia");
  const townLiving = living.filter((id) => game.roles.get(id) !== "mafia");
  if (mafiaLiving.length === 0) return "town";
  if (mafiaLiving.length >= townLiving.length) return "mafia";
  return null;
}

/* ================= CLIENT ================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,

    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,

    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
});

/* ================= UI BUILDERS ================= */

function rolesPanelButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("roles:setJoinRole").setLabel("Set join role").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("roles:addRule").setLabel("Add/Update role rule").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("roles:viewRules").setLabel("View rules").setStyle(ButtonStyle.Secondary)
    )
  ];
}

// Economy panel UI (for pickpocket punish settings)
function economyPanelButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("eco:view").setLabel("View economy settings").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("eco:setCaughtChance").setLabel("Set pickpocket caught chance").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("eco:setCaughtLimit").setLabel("Set caught limit").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("eco:setPunishRole").setLabel("Set punish role").setStyle(ButtonStyle.Danger)
    )
  ];
}

function mafiaLobbyButtons(hostId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mafia:join:${hostId}`).setLabel("Join").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`mafia:leave:${hostId}`).setLabel("Leave").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`mafia:startnow:${hostId}`).setLabel("Start now").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`mafia:cancel:${hostId}`).setLabel("Cancel").setStyle(ButtonStyle.Danger)
    )
  ];
}
function mafiaMainButtons(guildId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mafia:reveal:${guildId}`).setLabel("Reveal Role (secret)").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`mafia:action:${guildId}`).setLabel("Night Action / Vote (secret)").setStyle(ButtonStyle.Primary)
    )
  ];
}
function mafiaSelectMenu(customId, label, options) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(label)
    .addOptions(options.slice(0, 25));
  return [new ActionRowBuilder().addComponents(menu)];
}

/* ================= SLASH COMMANDS ================= */
function buildSlashCommands() {
  const rarityChoices = TOKEN_RARITIES.map((r) => ({ name: r, value: r }));
  const cmds = [];

  cmds.push(new SlashCommandBuilder().setName("commands").setDescription("Show all commands"));

  cmds.push(new SlashCommandBuilder().setName("balance").setDescription("Show your balance"));

  // Birthdays
  cmds.push(
    new SlashCommandBuilder()
      .setName("birthday")
      .setDescription("Set or view your birthday")
      .addSubcommand((s) =>
        s
          .setName("set")
          .setDescription("Set your birthday")
          .addIntegerOption((o) => o.setName("day").setDescription("Day (1-31)").setRequired(true).setMinValue(1).setMaxValue(31))
          .addIntegerOption((o) => o.setName("month").setDescription("Month (1-12)").setRequired(true).setMinValue(1).setMaxValue(12))
          .addIntegerOption((o) => o.setName("year").setDescription("Year (optional)").setRequired(false).setMinValue(1900).setMaxValue(2100))
      )
      .addSubcommand((s) => s.setName("view").setDescription("View your saved birthday"))
      .addSubcommand((s) => s.setName("clear").setDescription("Clear your saved birthday"))
  );

  // Admin birthdays
  cmds.push(
    new SlashCommandBuilder()
      .setName("setbirthdaymsg")
      .setDescription("ADMIN: set birthday message template (use {user} and optional {age})")
      .addStringOption((o) => o.setName("text").setDescription("Template").setRequired(true))
  );
  cmds.push(
    new SlashCommandBuilder()
      .setName("setbirthdaychannel")
      .setDescription("ADMIN: set birthday announcements channel")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Channel")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
  );

  // Admin cooldowns
  cmds.push(
    new SlashCommandBuilder()
      .setName("setcooldown")
      .setDescription("ADMIN: set cooldown for a role (global or per-channel)")
      .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true))
      .addNumberOption((o) => o.setName("seconds").setDescription("Seconds").setRequired(true).setMinValue(0.1))
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Optional channel (omitted = global)")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false)
      )
  );
  cmds.push(
    new SlashCommandBuilder()
      .setName("clearcooldown")
      .setDescription("ADMIN: clear cooldown rules for a role")
      .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true))
  );
  cmds.push(
    new SlashCommandBuilder()
      .setName("ignorecooldown")
      .setDescription("ADMIN: ignore cooldown enforcement in a channel")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Channel")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
  );
  cmds.push(
    new SlashCommandBuilder()
      .setName("unignorecooldown")
      .setDescription("ADMIN: re-enable cooldown enforcement in a channel")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Channel")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
  );
  cmds.push(new SlashCommandBuilder().setName("ignoredchannels").setDescription("Show ignored cooldown channels"));

  // Admin panels
   cmds.push(new SlashCommandBuilder().setName("rolepanel").setDescription("ADMIN: post Role panel in log channel"));
  cmds.push(new SlashCommandBuilder().setName("economypanel").setDescription("ADMIN: post Economy panel in log channel"));

  // Mafia
  cmds.push(
    new SlashCommandBuilder()
      .setName("mafia")
      .setDescription("Mafia game")
      .addSubcommand((s) => s.setName("start").setDescription("Start a Mafia lobby"))
      .addSubcommand((s) => s.setName("stop").setDescription("Stop current Mafia lobby/game (host/admin)"))
  );

  // Fun
  const fun = new SlashCommandBuilder().setName("fun").setDescription("Medieval street actions");
  const withUser = (s, name, desc) =>
    s
      .setName(name)
      .setDescription(desc)
      .addUserOption((o) => o.setName("target").setDescription("Target").setRequired(true));

  fun.addSubcommand((s) => s.setName("beg").setDescription("Beg for coins"));
  fun.addSubcommand((s) => withUser(s, "pickpocket", "Attempt to pickpocket someone"));
  fun.addSubcommand((s) => withUser(s, "slap", "Slap someone in the square"));
  fun.addSubcommand((s) => withUser(s, "punch", "Punch someone in the square"));
  fun.addSubcommand((s) => withUser(s, "duel", "Challenge someone to a duel"));
  fun.addSubcommand((s) => withUser(s, "praise", "Praise someone nobly"));
  fun.addSubcommand((s) => withUser(s, "insult", "Insult someone publicly"));
  cmds.push(fun);

  return cmds.map((c) => c.toJSON());
}

async function registerSlashCommands(applicationId) {
  if (!GUILD_ID_FOR_SLASH) {
    console.log("ℹ️ DISCORD_GUILD_ID not set. Slash command registration skipped (prefix still works).");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const body = buildSlashCommands();
  await rest.put(Routes.applicationGuildCommands(applicationId, GUILD_ID_FOR_SLASH), { body });
  console.log(`✅ Slash commands registered to guild ${GUILD_ID_FOR_SLASH}`);
}

/* ================= READY ================= */
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    await registerSlashCommands(client.user.id);
  } catch (e) {
    console.log("⚠️ Slash command registration failed:", e?.message || e);
  }

  setInterval(() => runBirthdayCheck(client).catch(() => {}), 10 * 60 * 1000);
  runBirthdayCheck(client).catch(() => {});
});

/* ================= JOIN: JOIN ROLE + FREE TOKEN ================= */
client.on("guildMemberAdd", async (member) => {
  const guildId = member.guild.id;
  ensureUser(guildId, member.id);
  const u = data[guildId].users[member.id];

  const joinRoleId = data[guildId].roles.joinRoleId;
  if (joinRoleId && member.guild.roles.cache.get(joinRoleId)) {
    if (member.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      try { await member.roles.add(joinRoleId); } catch {}
    }
  }

  scheduleSave();
});

/* ================= ROLE RULES: ENFORCE WHEN TRIGGER ROLE GAINED ================= */
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const guild = newMember.guild;
  if (!guild) return;
  const guildId = guild.id;
  ensureGuild(guildId);

  const rulesMap = data[guildId].roles.roleRules || {};
  const oldRoles = new Set(oldMember.roles.cache.keys());
  const newRoles = new Set(newMember.roles.cache.keys());

  const added = [];
  for (const rid of newRoles) if (!oldRoles.has(rid)) added.push(rid);
  if (!added.length) return;

  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;

  for (const triggerRoleId of added) {
    const rule = rulesMap[triggerRoleId];
    if (!rule) continue;

    const requireRoleId = rule.requireRoleId || "";
    const removeRoleIds = Array.isArray(rule.removeRoleIds) ? rule.removeRoleIds : [];

    if (requireRoleId && !newMember.roles.cache.has(requireRoleId)) {
      try { await newMember.roles.add(requireRoleId); } catch {}
    }
    for (const rr of removeRoleIds) {
      if (rr && newMember.roles.cache.has(rr)) {
        try { await newMember.roles.remove(rr); } catch {}
      }
    }
  }
});

/* ================= VOICE REWARDS ================= */
client.on("voiceStateUpdate", (oldState, newState) => {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  const guildId = member.guild.id;
  ensureUser(guildId, member.id);
  const u = data[guildId].users[member.id];

  const wasInVc = !!oldState.channelId;
  const nowInVc = !!newState.channelId;

  if (!wasInVc && nowInVc) {
    u.vcJoinAt = Date.now();
    scheduleSave();
    return;
  }

  if (wasInVc && !nowInVc && u.vcJoinAt) {
    const ms = Date.now() - u.vcJoinAt;
    u.vcJoinAt = null;

    const mins = Math.floor(ms / 60000);
    if (mins > 0) {
      const eco = data[guildId].eco;
      addRewards(guildId, member.id, mins * eco.vcCoinsPerMin, mins * eco.vcXpPerMin);
    }
    scheduleSave();
  }
});

/* ================= REACTION REWARDS ================= */
client.on("messageReactionAdd", async (reaction, user) => {
  try { if (reaction.partial) await reaction.fetch(); } catch {}
  const msg = reaction.message;
  if (!msg?.guild || !user || user.bot) return;

  const guildId = msg.guild.id;
  ensureUser(guildId, user.id);

  const u = data[guildId].users[user.id];
  const eco = data[guildId].eco;
  const now = Date.now();

  if ((now - u.lastReactReward) / 1000 < eco.reactRewardCooldownSec) return;
  u.lastReactReward = now;

  addRewards(guildId, user.id, eco.reactCoins, eco.reactXp);
});

/* ================= Mafia lobby helpers ================= */
function mafiaLobbyContent(game, guild) {
  const count = game.players.size;
  return `🕯️ **Mafia lobby started**
Host: <@${game.hostId}>
Players joined: **${count}**
Press **Join** to play. Host presses **Start now**.`;
}
async function updateMafiaLobbyPanel(interactionOrGuild, guildId) {
  const game = mafiaGames.get(guildId);
  if (!game || game.phase !== "lobby") return;

  const guild = interactionOrGuild.guild || interactionOrGuild;
  if (!guild) return;

  // If interaction came from the lobby message, update that exact message.
  const msg = interactionOrGuild.message;
  if (msg && msg.edit) {
    await msg.edit({
      content: mafiaLobbyContent(game, guild),
      components: mafiaLobbyButtons(game.hostId),
      allowedMentions: { parse: [] }
    }).catch(() => {});
    return;
  }

  // fallback: fetch stored lobby message id if present
  if (game.lobbyMessageId && game.channelId) {
    const ch = guild.channels.cache.get(game.channelId);
    if (!ch) return;
    const m = await ch.messages.fetch(game.lobbyMessageId).catch(() => null);
    if (!m) return;
    await m.edit({
      content: mafiaLobbyContent(game, guild),
      components: mafiaLobbyButtons(game.hostId),
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }
}

/* ================= Mafia game flow ================= */
async function startMafiaGame(guild, channelId) {
  const guildId = guild.id;
  const game = mafiaGames.get(guildId);
  if (!game) return;

  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;

  const players = [...game.players];
  if (players.length < 5) {
    await channel.send({ content: "Not enough players (need 5+). Game ended.", allowedMentions: { parse: [] } });
    mafiaGames.delete(guildId);
    return;
  }

  game.phase = "setup";
  game.roles = new Map();
  game.living = new Set(players);

  const counts = mafiaRoleCounts(players.length);
  const pool = [];
  for (let i = 0; i < counts.mafia; i++) pool.push("mafia");
  for (let i = 0; i < counts.medic; i++) pool.push("medic");
  for (let i = 0; i < counts.detective; i++) pool.push("detective");
  for (let i = 0; i < counts.villager; i++) pool.push("villager");

  shuffle(pool);
  shuffle(players);

  for (let i = 0; i < players.length; i++) {
    game.roles.set(players[i], pool[i] || "villager");
  }

  await channel.send({
    content:
      `🕯️ **Mafia has begun** with **${players.length}** players.\n` +
      `Roles: Mafia ${counts.mafia}, Medic ${counts.medic}, Detective ${counts.detective}, Villagers ${counts.villager}.\n` +
      `Click **Reveal Role (secret)** to see your role (only you can see it).`,
    components: mafiaMainButtons(guildId),
    allowedMentions: { parse: [] }
  });

  game.round = 0;
  await mafiaNight(guild);
}

async function mafiaNight(guild) {
  const guildId = guild.id;
  const game = mafiaGames.get(guildId);
  if (!game) return;

  game.round += 1;
  game.phase = "night";
  game.nightKills = new Map();
  game.nightSave = null;
  game.nightInvestigations = new Map();
  game.dayVotes = new Map();

  const channel = guild.channels.cache.get(game.channelId);
  if (channel) {
    await channel.send({
      content: `🌙 **Night ${game.round}** has fallen. Use **Night Action / Vote (secret)** to act (only you can see your menu).`,
      components: mafiaMainButtons(guildId),
      allowedMentions: { parse: [] }
    });
  }

  setTimeout(() => resolveNight(guild).catch(() => {}), 60000);
}

async function resolveNight(guild) {
  const guildId = guild.id;
  const game = mafiaGames.get(guildId);
  if (!game || game.phase !== "night") return;

  const tally = new Map();
  for (const target of game.nightKills.values()) tally.set(target, (tally.get(target) || 0) + 1);

  let killTarget = null;
  let best = 0;
  for (const [t, c] of tally.entries()) {
    if (c > best) { best = c; killTarget = t; }
  }

  let eliminated = null;
  if (killTarget && game.living.has(killTarget) && game.nightSave !== killTarget) {
    game.living.delete(killTarget);
    eliminated = killTarget;
  }

  const channel = guild.channels.cache.get(game.channelId);
  if (channel) {
    await channel.send({
      content: eliminated
        ? `🌅 Dawn breaks. Someone has been eliminated: **${eliminated}**`
        : `🌅 Dawn breaks. Nobody was eliminated last night.`,
      allowedMentions: { parse: [] }
    });
  }

  const win = mafiaWinCheck(game);
  if (win) return endMafiaGame(guild, win);

  await mafiaDay(guild);
}

async function mafiaDay(guild) {
  const guildId = guild.id;
  const game = mafiaGames.get(guildId);
  if (!game) return;

  game.phase = "day";
  game.dayVotes = new Map();

  const channel = guild.channels.cache.get(game.channelId);
  if (channel) {
    await channel.send({
      content: `☀️ **Day ${game.round}** — discuss, then use **Night Action / Vote (secret)** to cast your vote (secret).`,
      components: mafiaMainButtons(guildId),
      allowedMentions: { parse: [] }
    });
  }

  setTimeout(() => resolveDayVote(guild).catch(() => {}), 60000);
}

async function resolveDayVote(guild) {
  const guildId = guild.id;
  const game = mafiaGames.get(guildId);
  if (!game || game.phase !== "day") return;

  const tally = new Map();
  for (const target of game.dayVotes.values()) tally.set(target, (tally.get(target) || 0) + 1);

  let votedOut = null;
  let best = 0;
  for (const [t, c] of tally.entries()) {
    if (c > best) { best = c; votedOut = t; }
  }

  const channel = guild.channels.cache.get(game.channelId);
  if (votedOut && game.living.has(votedOut)) {
    game.living.delete(votedOut);
    if (channel) await channel.send({ content: `🗳️ The town voted out: **${votedOut}**`, allowedMentions: { parse: [] } });
  } else {
    if (channel) await channel.send({ content: `🗳️ No clear vote — nobody was voted out.`, allowedMentions: { parse: [] } });
  }

  const win = mafiaWinCheck(game);
  if (win) return endMafiaGame(guild, win);

  await mafiaNight(guild);
}

async function endMafiaGame(guild, winner) {
  const guildId = guild.id;
  const game = mafiaGames.get(guildId);
  if (!game) return;

  const channel = guild.channels.cache.get(game.channelId);
  if (channel) {
    await channel.send({
      content: winner === "mafia" ? `🏴 Mafia wins!` : `🏳️ Town wins!`,
      allowedMentions: { parse: [] }
    });
  }

  for (const [pid, role] of game.roles.entries()) {
    const isMafia = role === "mafia";
    const won = (winner === "mafia" && isMafia) || (winner === "town" && !isMafia);
    addRewards(guildId, pid, won ? 30 : 10, won ? 60 : 20);
  }

  mafiaGames.delete(guildId);
}

/* ================= INTERACTIONS ================= */
client.on("interactionCreate", async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const guildId = interaction.guildId;
      if (!guildId) return iNotice(interaction, "Use commands inside a server.");
      ensureGuild(guildId);

      const cmd = interaction.commandName;

      if (cmd === "commands") {
        const text =
`📜 **Commands**
**Admin (message disappears only for prefix, not slash)**
- /setcooldown, /clearcooldown, /ignorecooldown, /unignorecooldown, /rolepanel, /economypanel
- /setbirthdaymsg, /setbirthdaychannel

**Cooldowns**
- !setcooldown /setcooldown
- !clearcooldown /clearcooldown
- !ignorecooldown /ignorecooldown
- !unignorecooldown /unignorecooldown
- !ignoredchannels /ignoredchannels

**Economy**
- !balance /balance

**Panels**
- !rolepanel /rolepanel (Admin)
- !economypanel /economypanel (Admin)

**Birthdays**
- !birthday /birthday
- !setbirthdaymsg /setbirthdaymsg (Admin)
- !setbirthdaychannel /setbirthdaychannel (Admin)

**Mafia**
- !mafia start /mafia start
- !mafia stop /mafia stop

**Fun**
- !beg /fun beg
- !pickpocket @user /fun pickpocket
- !slap @user /fun slap
- !punch @user /fun punch
- !duel @user /fun duel
- !praise @user /fun praise
- !insult @user /fun insult`;
        return iNotice(interaction, text);
      }

      if (cmd === "balance") {
        ensureUser(guildId, interaction.user.id);
        const u = data[guildId].users[interaction.user.id];
        return inotice(interaction, `👛 Coins: **${u.coins}** | XP: **${u.xp}** | Level: **${u.level}** | nPickpocket caught: **${u.pickpocketCaught}**`);
      }

      if (cmd === "birthday") {
        const sub = interaction.options.getSubcommand(true);
        ensureGuild(guildId);

        if (sub === "view") {
          const b = data[guildId].birthdays.users[interaction.user.id];
          if (!b) return iNotice(interaction, "No birthday set. Use `/birthday set`.");
          const shown = b.year ? `${b.day}/${b.month}/${b.year}` : `${b.day}/${b.month}`;
          return iNotice(interaction, `🎂 Your saved birthday: **${shown}**`);
        }

        if (sub === "clear") {
          delete data[guildId].birthdays.users[interaction.user.id];
          scheduleSave();
          return iNotice(interaction, "✅ Birthday cleared.");
        }

        if (sub === "set") {
          const day = interaction.options.getInteger("day", true);
          const month = interaction.options.getInteger("month", true);
          const year = interaction.options.getInteger("year", false);

          data[guildId].birthdays.users[interaction.user.id] = { day, month, year: year ?? "" };
          scheduleSave();
          const shown = year ? `${day}/${month}/${year}` : `${day}/${month}`;
          return iNotice(interaction, `✅ Birthday saved as **${shown}**.`);
        }
      }

      if (cmd === "setbirthdaymsg") {
        if (!isAdminMember(interaction.memberPermissions)) return iNotice(interaction, "Admins only.");
        ensureGuild(guildId);
        data[guildId].birthdays.messageTemplate = interaction.options.getString("text", true).trim();
        scheduleSave();
        await adminLog(interaction.guild, `🎂 Birthday message template updated.`);
        return iNotice(interaction, "✅ Birthday message updated.");
      }

      if (cmd === "setbirthdaychannel") {
        if (!isAdminMember(interaction.memberPermissions)) return iNotice(interaction, "Admins only.");
        ensureGuild(guildId);
        const ch = interaction.options.getChannel("channel", true);
        data[guildId].birthdays.channelId = ch.id;
        scheduleSave();
        await adminLog(interaction.guild, `🎂 Birthday channel set to ${ch.id}.`);
        return iNotice(interaction, `✅ Birthday channel set to ${ch}.`);
      }

      if (cmd === "economypanel") {
        if (!isAdminMember(interaction.memberPermissions)) return iNotice(interaction, "Admins only.");
        const logCh = interaction.guild.channels.cache.get(LOG_CHANNEL_ID);
        if (!logCh) return iNotice(interaction, "Log channel not found.");

        await logCh.send({
          content: `💰 Economy Panel (Pickpocket punish settings)`,
          components: economyPanelButtons(),
          allowedMentions: { parse: [] }
        });
        await adminLog(interaction.guild, `💰 Economy panel opened.`);
        return iNotice(interaction, "✅ Panel posted in log channel.");
      }

      if (cmd === "setcooldown") {
        if (!isAdminMember(interaction.memberPermissions)) return iNotice(interaction, "Admins only.");
        const role = interaction.options.getRole("role", true);
        const seconds = Number(interaction.options.getNumber("seconds", true));
        const channel = interaction.options.getChannel("channel", false);

        if (!rules[guildId]) rules[guildId] = { _ignoredChannels: [] };
        if (!rules[guildId][role.id]) rules[guildId][role.id] = { global: 0, channels: {} };

        if (channel) {
          rules[guildId][role.id].channels[channel.id] = seconds;
          writeJson(cooldownFile, rules);
          await adminLog(interaction.guild, `✅ Set cooldown for role ${role.id} in channel ${channel.id} to ${seconds}s.`);
        } else {
          rules[guildId][role.id].global = seconds;
          writeJson(cooldownFile, rules);
          await adminLog(interaction.guild, `✅ Set global cooldown for role ${role.id} to ${seconds}s.`);
        }
        return iNotice(interaction, "✅ Saved.");
      }

      if (cmd === "clearcooldown") {
        if (!isAdminMember(interaction.memberPermissions)) return iNotice(interaction, "Admins only.");
        const role = interaction.options.getRole("role", true);
        if (!rules[guildId] || !rules[guildId][role.id]) return iNotice(interaction, "No cooldown rules set for that role.");
        delete rules[guildId][role.id];
        writeJson(cooldownFile, rules);
        await adminLog(interaction.guild, `✅ Cleared ALL cooldown rules for role ${role.id}.`);
        return iNotice(interaction, "✅ Cleared.");
      }

      if (cmd === "ignorecooldown") {
        if (!isAdminMember(interaction.memberPermissions)) return iNotice(interaction, "Admins only.");
        const ch = interaction.options.getChannel("channel", true);
        if (!rules[guildId]) rules[guildId] = { _ignoredChannels: [] };
        if (!Array.isArray(rules[guildId]._ignoredChannels)) rules[guildId]._ignoredChannels = [];
        if (!rules[guildId]._ignoredChannels.includes(ch.id)) rules[guildId]._ignoredChannels.push(ch.id);
        writeJson(cooldownFile, rules);
        await adminLog(interaction.guild, `✅ Cooldowns ignored in channel ${ch.id}.`);
        return iNotice(interaction, "✅ Saved.");
      }

      if (cmd === "unignorecooldown") {
        if (!isAdminMember(interaction.memberPermissions)) return iNotice(interaction, "Admins only.");
        const ch = interaction.options.getChannel("channel", true);
        if (!rules[guildId]) rules[guildId] = { _ignoredChannels: [] };
        if (!Array.isArray(rules[guildId]._ignoredChannels)) rules[guildId]._ignoredChannels = [];
        rules[guildId]._ignoredChannels = rules[guildId]._ignoredChannels.filter((id) => id !== ch.id);
        writeJson(cooldownFile, rules);
        await adminLog(interaction.guild, `✅ Cooldowns re-enabled in channel ${ch.id}.`);
        return iNotice(interaction, "✅ Saved.");
      }

      if (cmd === "ignoredchannels") {
        const list = rules[guildId]?._ignoredChannels || [];
        if (!list.length) return iNotice(interaction, "No ignored channels set.");
        const names = list.map((id) => interaction.guild.channels.cache.get(id)?.toString() || `Unknown(${id})`).join(", ");
        return iNotice(interaction, `🚫 Cooldowns ignored in: ${names}`);
      }

      if (cmd === "rolepanel") {
        if (!isAdminMember(interaction.memberPermissions)) return iNotice(interaction, "Admins only.");
        const logCh = interaction.guild.channels.cache.get(LOG_CHANNEL_ID);
        if (!logCh) return iNotice(interaction, "Log channel not found.");

        await logCh.send({
          content: "🛡️ Roles Panel (join role + role rules)",
          components: rolesPanelButtons(),
          allowedMentions: { parse: [] }
        });
        await adminLog(interaction.guild, `🛡️ Role panel opened.`);
        return iNotice(interaction, "✅ Panel posted.");
      }

      if (cmd === "mafia") {
        const sub = interaction.options.getSubcommand(true);

        if (sub === "start") {
          const existing = mafiaGames.get(guildId);
          if (existing) return iNotice(interaction, "A Mafia lobby/game is already running.");

          const hostId = interaction.user.id;
          mafiaGames.set(guildId, {
            hostId,
            channelId: interaction.channelId,
            phase: "lobby",
            players: new Set([hostId]),
            lobbyMessageId: ""
          });

          const sent = await interaction.reply({
            content: mafiaLobbyContent(mafiaGames.get(guildId), interaction.guild),
            components: mafiaLobbyButtons(hostId),
            allowedMentions: { parse: [] },
            fetchReply: true
          }).catch(() => null);

          if (sent) {
            mafiaGames.get(guildId).lobbyMessageId = sent.id;
          }
          return;
        }

        if (sub === "stop") {
          const game = mafiaGames.get(guildId);
          if (!game) return iNotice(interaction, "No Mafia lobby/game running.");

          const isHost = interaction.user.id === game.hostId;
          const isAdmin = isAdminMember(interaction.memberPermissions);
          if (!isHost && !isAdmin) return iNotice(interaction, "Only host or admin can stop.");

          mafiaGames.delete(guildId);
          await adminLog(interaction.guild, `🕯️ Mafia stopped by ${interaction.user.id}.`);
          return iNotice(interaction, "✅ Mafia stopped.");
        }
      }

      if (cmd === "fun") {
        const sub = interaction.options.getSubcommand(true);
        ensureGuild(guildId);
        ensureUser(guildId, interaction.user.id);

        const cfg = data[guildId].custom.commands[sub];
        if (!cfg || !cfg.enabled) return iNotice(interaction, "That action is disabled.");

        const member = interaction.member;
        if (Array.isArray(cfg.allowedRoleIds) && cfg.allowedRoleIds.length > 0) {
          const ok = cfg.allowedRoleIds.some((rid) => member.roles.cache.has(rid));
          if (!ok) return iNotice(interaction, "You can’t use that action.");
        }

        const u = data[guildId].users[interaction.user.id];
        const nowTs = Date.now();
        const last = u.customCooldowns[sub] || 0;
        if (cfg.cooldownSec && (nowTs - last) / 1000 < cfg.cooldownSec) return iNotice(interaction, "That action is on cooldown.");
        u.customCooldowns[sub] = nowTs;

        const target = interaction.options.getUser("target", false);

        let text = "";
        let coinsDelta = 0;

        if (sub === "beg") {
          coinsDelta = randInt(cfg.coinsMin, cfg.coinsMax);
          text = `🪙 ${interaction.user.username} kneels by the market gate and begs... A passer-by tosses **${coinsDelta} coin(s)**.`;
        } else if (sub === "pickpocket") {
          if (!target || target.bot) return iNotice(interaction, "Pick a real user.");

          const eco = data[guildId].eco;
          const caught = Math.random() < eco.pickpocketCaughtChance;

          if (caught) {
            u.pickpocketCaught += 1;
            scheduleSave();

            text = `🚨 ${interaction.user.username} tries to pickpocket ${target.username}... and gets **caught**! (Caught record: **${u.pickpocketCaught}**)`;

            // punish role if limit reached
            await maybeApplyPickpocketPunishRole(interaction.guild, interaction.user.id).catch(() => {});
          } else {
            coinsDelta = randInt(cfg.coinsMin, cfg.coinsMax);
            text = `🧤 ${interaction.user.username} pickpockets ${target.username} and nicks **${coinsDelta} coin(s)**.`;
            if (coinsDelta) addRewards(guildId, interaction.user.id, coinsDelta, 0);
          }
        } else if (sub === "slap") {
          if (!target || target.bot) return iNotice(interaction, "Pick a real user.");
          text = `🖐️ ${interaction.user.username} slaps ${target.username} in the town square. Scandalous.`;
        } else if (sub === "punch") {
          if (!target || target.bot) return iNotice(interaction, "Pick a real user.");
          text = `🥊 ${interaction.user.username} throws a punch at ${target.username}. The crowd gasps.`;
        } else if (sub === "duel") {
          if (!target || target.bot) return iNotice(interaction, "Pick a real user.");
          const win = Math.random() < 0.5;
          coinsDelta = win ? randInt(cfg.coinsMin, cfg.coinsMax) : 0;
          text = win
            ? `⚔️ ${interaction.user.username} duels ${target.username} and wins! The onlookers award **${coinsDelta} coin(s)**.`
            : `⚔️ ${interaction.user.username} duels ${target.username} but loses... No coins today.`;
          if (coinsDelta) addRewards(guildId, interaction.user.id, coinsDelta, 0);
        } else if (sub === "praise") {
          if (!target || target.bot) return iNotice(interaction, "Pick a real user.");
          text = `🎩 ${interaction.user.username} offers noble praise to ${target.username}. Truly magnanimous.`;
        } else if (sub === "insult") {
          if (!target || target.bot) return iNotice(interaction, "Pick a real user.");
          text = `🍅 ${interaction.user.username} hurls a scathing insult at ${target.username}. The crowd murmurs.`;
        }

        scheduleSave();
        await interaction.reply({ content: text, allowedMentions: { parse: [] } });
        return;
      }

      return;
    }

    // Select menus
    if (interaction.isStringSelectMenu()) {
      const parts = interaction.customId.split(":");

      if (parts[0] === "mafiaact") {
        const guildId = parts[1];
        const phase = parts[2];
        const actorId = parts[3];

        if (interaction.user.id !== actorId) return iNotice(interaction, "Not your menu.");

        const game = mafiaGames.get(guildId);
        if (!game) return iNotice(interaction, "No active game.");
        if (!game.living.has(actorId)) return iNotice(interaction, "You are not alive.");

        const targetId = interaction.values[0];
        if (!game.living.has(targetId)) return iNotice(interaction, "Target is not alive.");

        if (game.phase === "night" && phase === "kill") game.nightKills.set(actorId, targetId);
        else if (game.phase === "night" && phase === "save") game.nightSave = targetId;
        else if (game.phase === "night" && phase === "invest") {
          game.nightInvestigations.set(actorId, targetId);
          const role = game.roles.get(targetId);
          const result = role === "mafia" ? "MAFIA" : "NOT MAFIA";
          return interaction.reply({ content: `🕵️ Investigation: **${result}**`, ephemeral: true });
        } else if (game.phase === "day" && phase === "vote") game.dayVotes.set(actorId, targetId);
        else return iNotice(interaction, "That phase is not active.");

        return interaction.reply({ content: "✅ Selected.", ephemeral: true });
      }
    }

    // Buttons
    if (interaction.isButton()) {
      const parts = interaction.customId.split(":");

      // Economy panel buttons
      if (parts[0] === "eco") {
        if (!isAdminMember(interaction.memberPermissions)) return iNotice(interaction, "Admins only.");
        const guildId = interaction.guildId;
        ensureGuild(guildId);

        if (parts[1] === "view") {
          const eco = data[guildId].eco;
          const roleId = eco.pickpocketPunishRoleId || "(none)";
          return interaction.reply({
            content:
              `💰 **Economy settings**\n` +
              `Pickpocket caught chance: **${Math.round(eco.pickpocketCaughtChance * 100)}%**\n` +
              `Caught limit: **${eco.pickpocketCaughtLimit}**\n` +
              `Punish role ID: **${roleId}**`,
            ephemeral: true
          });
        }

        if (parts[1] === "setCaughtChance") {
          const modal = new ModalBuilder().setCustomId("ecomod:setCaughtChance").setTitle("Set pickpocket caught chance");
          const input = new TextInputBuilder()
            .setCustomId("chance")
            .setLabel("Chance as percent (e.g. 35)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

        if (parts[1] === "setCaughtLimit") {
          const modal = new ModalBuilder().setCustomId("ecomod:setCaughtLimit").setTitle("Set caught limit");
          const input = new TextInputBuilder()
            .setCustomId("limit")
            .setLabel("How many caught pickpockets before role (e.g. 5)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

        if (parts[1] === "setPunishRole") {
          const modal = new ModalBuilder().setCustomId("ecomod:setPunishRole").setTitle("Set punish role ID");
          const input = new TextInputBuilder()
            .setCustomId("roleId")
            .setLabel("Role ID to give at limit (blank = none)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }
      }

      // Mafia lobby/game buttons
      if (parts[0] === "mafia") {
        const action = parts[1];

        if (action === "join" || action === "leave" || action === "startnow" || action === "cancel") {
          const hostId = parts[2];
          const guildId = interaction.guildId;
          const game = mafiaGames.get(guildId);
          if (!game) return iNotice(interaction, "No active lobby/game.");

          if (action === "join") {
            if (game.phase !== "lobby") return iNotice(interaction, "Game already started.");
            game.players.add(interaction.user.id);
            await iNotice(interaction, "✅ Joined.");
            await updateMafiaLobbyPanel(interaction, guildId);
            return;
          }

          if (action === "leave") {
            if (game.phase !== "lobby") return iNotice(interaction, "Game already started.");
            game.players.delete(interaction.user.id);
            await iNotice(interaction, "✅ Left.");
            await updateMafiaLobbyPanel(interaction, guildId);
            return;
          }

          if (action === "cancel") {
            if (interaction.user.id !== hostId) return iNotice(interaction, "Only the host can cancel.");
            mafiaGames.delete(guildId);
            await interaction.update({ content: "❌ Mafia game cancelled.", components: [] });
            return;
          }

          if (action === "startnow") {
            if (interaction.user.id !== hostId) return iNotice(interaction, "Only the host can start.");
            if (game.phase !== "lobby") return iNotice(interaction, "Already started.");
            await interaction.update({ content: "⏳ Starting Mafia…", components: [] });
            await startMafiaGame(interaction.guild, game.channelId);
            return;
          }
        }

        if (action === "reveal") {
          const guildId = parts[2];
          const game = mafiaGames.get(guildId);
          if (!game) return iNotice(interaction, "No active game.");
          if (!game.players.has(interaction.user.id)) return iNotice(interaction, "You are not in this game.");
          const role = game.roles.get(interaction.user.id);
          if (!role) return iNotice(interaction, "Role not found.");

          return interaction.reply({
            content:
              `🕯️ Your secret role: **${role.toUpperCase()}**\n` +
              (role === "mafia" ? "At night, choose someone to eliminate." :
               role === "medic" ? "At night, choose someone to protect." :
               role === "detective" ? "At night, investigate someone." :
               "During the day, vote wisely."),
            ephemeral: true
          });
        }

        if (action === "action") {
          const guildId = parts[2];
          const game = mafiaGames.get(guildId);
          if (!game) return iNotice(interaction, "No active game.");

          const uid = interaction.user.id;
          if (!game.players.has(uid)) return iNotice(interaction, "You are not in this game.");
          if (!game.living.has(uid)) return iNotice(interaction, "You are not alive.");

          const living = [...game.living];
          const livingMembers = await interaction.guild.members.fetch({ user: living }).catch(() => null);
          const labelFor = (id) => livingMembers?.get(id)?.user?.username || id;

          if (game.phase === "night") {
            const role = game.roles.get(uid);

            if (role === "mafia") {
              const targets = living
                .filter((id) => game.roles.get(id) !== "mafia")
                .map((id) => ({ label: labelFor(id), value: id }));
              if (!targets.length) return iNotice(interaction, "No valid targets.");
              return interaction.reply({
                content: "🌙 Night action (secret): choose who to eliminate.",
                components: mafiaSelectMenu(`mafiaact:${guildId}:kill:${uid}`, "Choose target…", targets),
                ephemeral: true
              });
            }

            if (role === "medic") {
              const targets = living.map((id) => ({ label: labelFor(id), value: id }));
              return interaction.reply({
                content: "🌙 Night action (secret): choose who to protect.",
                components: mafiaSelectMenu(`mafiaact:${guildId}:save:${uid}`, "Protect…", targets),
                ephemeral: true
              });
            }

            if (role === "detective") {
              const targets = living.filter((id) => id !== uid).map((id) => ({ label: labelFor(id), value: id }));
              return interaction.reply({
                content: "🌙 Night action (secret): choose who to investigate.",
                components: mafiaSelectMenu(`mafiaact:${guildId}:invest:${uid}`, "Investigate…", targets),
                ephemeral: true
              });
            }

            return iNotice(interaction, "You have no night action.");
          }

          if (game.phase === "day") {
            const targets = living.filter((id) => id !== uid).map((id) => ({ label: labelFor(id), value: id }));
            return interaction.reply({
              content: "☀️ Vote (secret): choose who to vote out.",
              components: mafiaSelectMenu(`mafiaact:${guildId}:vote:${uid}`, "Vote…", targets),
              ephemeral: true
            });
          }

          return iNotice(interaction, "Not in an action phase right now.");
        }
      }
    }

    // Modals
    if (interaction.type === InteractionType.ModalSubmit) {
      const guildId = interaction.guildId;
      if (!guildId) return;

      // Economy modals
      if (interaction.customId.startsWith("ecomod:")) {
        if (!isAdminMember(interaction.memberPermissions)) return iNotice(interaction, "Admins only.");
        ensureGuild(guildId);
        const eco = data[guildId].eco;

        if (interaction.customId === "ecomod:setCaughtChance") {
          const raw = interaction.fields.getTextInputValue("chance").trim();
          const pct = Number(raw);
          if (!Number.isFinite(pct) || pct < 0 || pct > 100) return iNotice(interaction, "Enter a percent from 0 to 100.");
          eco.pickpocketCaughtChance = pct / 100;
          scheduleSave();
          await adminLog(interaction.guild, `💰 Set pickpocket caught chance to ${pct}%.`);
          return interaction.reply({ content: "✅ Updated.", ephemeral: true });
        }

        if (interaction.customId === "ecomod:setCaughtLimit") {
          const raw = interaction.fields.getTextInputValue("limit").trim();
          const limit = Number(raw);
          if (!Number.isFinite(limit) || limit < 1 || limit > 1000) return iNotice(interaction, "Enter a number between 1 and 1000.");
          eco.pickpocketCaughtLimit = Math.floor(limit);
          scheduleSave();
          await adminLog(interaction.guild, `💰 Set pickpocket caught limit to ${eco.pickpocketCaughtLimit}.`);
          return interaction.reply({ content: "✅ Updated.", ephemeral: true });
        }

        if (interaction.customId === "ecomod:setPunishRole") {
          const raw = (interaction.fields.getTextInputValue("roleId") || "").trim();
          if (raw && !/^\d{17,20}$/.test(raw)) return iNotice(interaction, "Role ID looks invalid (or leave blank).");
          eco.pickpocketPunishRoleId = raw || "";
          scheduleSave();
          await adminLog(interaction.guild, `💰 Set pickpocket punish role to ${eco.pickpocketPunishRoleId || "(none)"}.`);
          return interaction.reply({ content: "✅ Updated.", ephemeral: true });
        }
      }

      // Role modals
      if (interaction.customId === "rolesmodal:setJoinRole") {
        if (!isAdminMember(interaction.memberPermissions)) return iNotice(interaction, "Admins only.");
        ensureGuild(guildId);

        const roleId = interaction.fields.getTextInputValue("roleId").trim();
        if (!/^\d{17,20}$/.test(roleId)) return iNotice(interaction, "Role ID invalid.");

        data[guildId].roles.joinRoleId = roleId;
        scheduleSave();
        await adminLog(interaction.guild, `🛡️ Join role set to ${roleId}.`);
        return interaction.reply({ content: "✅ Updated.", ephemeral: true });
      }

      if (interaction.customId === "rolesmodal:addRule") {
        if (!isAdminMember(interaction.memberPermissions)) return iNotice(interaction, "Admins only.");
        ensureGuild(guildId);

        const triggerRoleId = interaction.fields.getTextInputValue("triggerRoleId").trim();
        const requireRoleId = interaction.fields.getTextInputValue("requireRoleId").trim();
        const removeRaw = interaction.fields.getTextInputValue("removeRoleIds").trim();

        if (!/^\d{17,20}$/.test(triggerRoleId)) return iNotice(interaction, "Trigger role ID invalid.");

        const removeRoleIds = removeRaw
          ? removeRaw.split(",").map((s) => s.trim()).filter((s) => /^\d{17,20}$/.test(s))
          : [];

        data[guildId].roles.roleRules[triggerRoleId] = {
          requireRoleId: /^\d{17,20}$/.test(requireRoleId) ? requireRoleId : "",
          removeRoleIds
        };

        scheduleSave();
        await adminLog(interaction.guild, `🛡️ Role rule saved (trigger ${triggerRoleId}).`);
        return interaction.reply({ content: "✅ Updated.", ephemeral: true });
      }
    }
  } catch {
    try {
      if (interaction.isRepliable()) await interaction.reply({ content: "Something went wrong.", ephemeral: true });
    } catch {}
  }
});

/* ================= Pickpocket punish role applier ================= */
async function maybeApplyPickpocketPunishRole(guild, userId) {
  const guildId = guild.id;
  ensureUser(guildId, userId);

  const eco = data[guildId].eco;
  const limit = eco.pickpocketCaughtLimit;
  const roleId = eco.pickpocketPunishRoleId;
  if (!roleId) return;

  const u = data[guildId].users[userId];
  if (u.pickpocketCaught < limit) return;

  if (!guild.members.me?.permissions?.has(PermissionsBitField.Flags.ManageRoles)) return;

  const role = guild.roles.cache.get(roleId);
  if (!role) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  if (member.roles.cache.has(roleId)) return;

  await member.roles.add(roleId).catch(() => {});
}

/* ================= PREFIX COMMANDS: recognized list ================= */
function getPrefixCommandList(guildId) {
  ensureGuild(guildId);
  const base = new Set([
    "commands",

    "setcooldown",
    "clearcooldown",
    "ignorecooldown",
    "unignorecooldown",
    "ignoredchannels",

    "balance",
  
    "rolepanel",
    "economypanel",

    "birthday",
    "setbirthdaymsg",
    "setbirthdaychannel",

    "mafia",

    "beg",
    "pickpocket",
    "slap",
    "punch",
    "duel",
    "praise",
    "insult"
  ]);
  for (const k of Object.keys(data[guildId].custom?.commands || {})) base.add(k);
  return base;
}

/* ================= MESSAGE HANDLER ================= */
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  const guildId = message.guild.id;
  ensureGuild(guildId);

  // Prefix commands
  if (message.content.startsWith(PREFIX)) {
    const [cmdRaw, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (cmdRaw || "").toLowerCase();

    const known = getPrefixCommandList(guildId);
    const isRecognized = known.has(cmd);

    // If not recognized, do nothing (leave message)
    if (!isRecognized) return;

    const isAdmin = isAdminMember(message.member);

    // Delete ONLY admin commands (and only if sender is admin)
    if (
      isAdmin &&
      ADMIN_PREFIX_COMMANDS.has(cmd) &&
      message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)
    ) {
      tryDelete(message, 0);
    }

    const parseRoleFromArgs = () => {
      let role = message.mentions.roles.first();
      if (!role && args[0] && /^\d{17,20}$/.test(args[0])) role = message.guild.roles.cache.get(args[0]);
      return role;
    };

    // !commands
    if (cmd === "commands") {
      const text =
`📜 **Commands**
**Admin**
- !setcooldown, !clearcooldown, !ignorecooldown, !unignorecooldown
- !economypanel
- !setbirthdaymsg, !setbirthdaychannel

**Cooldowns**
- !setcooldown <roleId|@role> <seconds> [#channel]
- !clearcooldown <roleId|@role>
- !ignorecooldown <#channel|id>
- !unignorecooldown <#channel|id>
- !ignoredchannels

**Economy**
- !balance

**Birthdays**
- !birthday set DD/MM/YYYY (year optional)
- !birthday view
- !birthday clear

**Mafia**
- !mafia start
- !mafia stop

**Fun**
- !beg
- !pickpocket @user
- !slap @user
- !punch @user
- !duel @user
- !praise @user
- !insult @user`;
      return userNotice(message, text);
    }

    // Admin cooldowns
    if (cmd === "setcooldown") {
      if (!isAdmin) return userNotice(message, "Admins only.");
      const role = parseRoleFromArgs();
      if (!role) return userNotice(message, "Provide a role mention or role ID. Example: `!setcooldown 123... 5`");
      const seconds = Number(args[1]);
      if (!Number.isFinite(seconds) || seconds <= 0) return userNotice(message, "Provide valid cooldown seconds.");
      const channel = message.mentions.channels.first() || (args[2] && message.guild.channels.cache.get(args[2]));

      if (!rules[guildId]) rules[guildId] = { _ignoredChannels: [] };
      if (!rules[guildId][role.id]) rules[guildId][role.id] = { global: 0, channels: {} };

      if (channel) {
        rules[guildId][role.id].channels[channel.id] = seconds;
        writeJson(cooldownFile, rules);
        await adminLog(message.guild, `✅ Set cooldown for role ${role.id} in channel ${channel.id} to ${seconds}s.`);
      } else {
        rules[guildId][role.id].global = seconds;
        writeJson(cooldownFile, rules);
        await adminLog(message.guild, `✅ Set global cooldown for role ${role.id} to ${seconds}s.`);
      }
      return;
    }

    if (cmd === "clearcooldown") {
      if (!isAdmin) return userNotice(message, "Admins only.");
      const role = parseRoleFromArgs();
      if (!role) return userNotice(message, "Provide a role mention or role ID. Example: `!clearcooldown 123...`");
      if (!rules[guildId] || !rules[guildId][role.id]) return userNotice(message, "No cooldown rules set for that role.");
      delete rules[guildId][role.id];
      writeJson(cooldownFile, rules);
      await adminLog(message.guild, `✅ Cleared ALL cooldown rules for role ${role.id}.`);
      return;
    }

    if (cmd === "ignorecooldown") {
      if (!isAdmin) return userNotice(message, "Admins only.");
      const ch = message.mentions.channels.first() || (args[0] && message.guild.channels.cache.get(args[0]));
      if (!ch) return userNotice(message, "Usage: `!ignorecooldown #channel`");

      if (!rules[guildId]) rules[guildId] = { _ignoredChannels: [] };
      if (!Array.isArray(rules[guildId]._ignoredChannels)) rules[guildId]._ignoredChannels = [];
      if (!rules[guildId]._ignoredChannels.includes(ch.id)) rules[guildId]._ignoredChannels.push(ch.id);

      writeJson(cooldownFile, rules);
      await adminLog(message.guild, `✅ Cooldowns ignored in channel ${ch.id}.`);
      return;
    }

    if (cmd === "unignorecooldown") {
      if (!isAdmin) return userNotice(message, "Admins only.");
      const ch = message.mentions.channels.first() || (args[0] && message.guild.channels.cache.get(args[0]));
      if (!ch) return userNotice(message, "Usage: `!unignorecooldown #channel`");

      if (!rules[guildId]) rules[guildId] = { _ignoredChannels: [] };
      if (!Array.isArray(rules[guildId]._ignoredChannels)) rules[guildId]._ignoredChannels = [];
      rules[guildId]._ignoredChannels = rules[guildId]._ignoredChannels.filter((id) => id !== ch.id);

      writeJson(cooldownFile, rules);
      await adminLog(message.guild, `✅ Cooldowns re-enabled in channel ${ch.id}.`);
      return;
    }

    if (cmd === "ignoredchannels") {
      const list = rules[guildId]?._ignoredChannels || [];
      if (!list.length) return userNotice(message, "No ignored channels set.");
      const names = list
        .map((id) => message.guild.channels.cache.get(id)?.toString() || `Unknown(${id})`)
        .join(", ");
      return userNotice(message, `🚫 Cooldowns ignored in: ${names}`);
    }

    // Economy
   
    if (cmd === "balance") {
      ensureUser(guildId, message.author.id);
      const u = data[guildId].users[message.author.id];
      return userNotice(message, `👛 ${message.author.username} — Coins: ${u.coins} | XP: ${u.xp} | Level: ${u.level} | \nPickpocket caught: **${u.pickpocketCaught}**`);
    }

    // Admin panels
   
    if (cmd === "rolepanel") {
      if (!isAdmin) return userNotice(message, "Admins only.");
      const logCh = message.guild.channels.cache.get(LOG_CHANNEL_ID);
      if (!logCh) return userNotice(message, "Log channel not found.");
      await logCh.send({
        content: "🛡️ Roles Panel (join role + role rules)",
        components: rolesPanelButtons(),
        allowedMentions: { parse: [] }
      });
      await adminLog(message.guild, `🛡️ Role panel opened.`);
      return;
    }

    if (cmd === "economypanel") {
      if (!isAdmin) return userNotice(message, "Admins only.");
      const logCh = message.guild.channels.cache.get(LOG_CHANNEL_ID);
      if (!logCh) return userNotice(message, "Log channel not found.");
      await logCh.send({
        content: `💰 Economy Panel (Pickpocket punish settings)`,
        components: economyPanelButtons(),
        allowedMentions: { parse: [] }
      });
      await adminLog(message.guild, `💰 Economy panel opened.`);
      return;
    }

    // Birthdays
    if (cmd === "birthday") {
      ensureGuild(guildId);
      const sub = (args[0] || "").toLowerCase();

      if (sub === "view") {
        const b = data[guildId].birthdays.users[message.author.id];
        if (!b) return userNotice(message, "You haven’t set a birthday yet. Use `!birthday set DD/MM/YYYY` (year optional).");
        const shown = b.year ? `${b.day}/${b.month}/${b.year}` : `${b.day}/${b.month}`;
        return userNotice(message, `🎂 Your saved birthday: **${shown}**`);
      }

      if (sub === "clear") {
        delete data[guildId].birthdays.users[message.author.id];
        scheduleSave();
        return userNotice(message, "✅ Birthday cleared.");
      }

      if (sub === "set") {
        const raw = (args[1] || "").trim();
        const m = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
        if (!m) return userNotice(message, "Use: `!birthday set DD/MM/YYYY` (year optional). Example: `!birthday set 25/01/2010`");

        const day = Number(m[1]);
        const month = Number(m[2]);
        const year = m[3] ? Number(m[3]) : null;

        if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return userNotice(message, "That date doesn’t look valid.");
        if (year !== null && !(year >= 1900 && year <= 2100)) return userNotice(message, "Year must be 1900–2100 (or omit).");

        data[guildId].birthdays.users[message.author.id] = { day, month, year: year ?? "" };
        scheduleSave();
        const shown = year ? `${day}/${month}/${year}` : `${day}/${month}`;
        return userNotice(message, `✅ Birthday saved as **${shown}**.`);
      }

      return userNotice(message, "Usage:\n- `!birthday set DD/MM/YYYY` (year optional)\n- `!birthday view`\n- `!birthday clear`");
    }

    if (cmd === "setbirthdaymsg") {
      if (!isAdmin) return userNotice(message, "Admins only.");
      const text = args.join(" ").trim();
      if (!text) return userNotice(message, "Usage: `!setbirthdaymsg <message>` (use {user} and optional {age})");
      data[guildId].birthdays.messageTemplate = text;
      scheduleSave();
      await adminLog(message.guild, `🎂 Birthday message template updated.`);
      return userNotice(message, "✅ Birthday message updated.");
    }

    if (cmd === "setbirthdaychannel") {
      if (!isAdmin) return userNotice(message, "Admins only.");
      const ch = message.mentions.channels.first() || (args[0] && message.guild.channels.cache.get(args[0]));
      if (!ch) return userNotice(message, "Usage: `!setbirthdaychannel #channel`");
      data[guildId].birthdays.channelId = ch.id;
      scheduleSave();
      await adminLog(message.guild, `🎂 Birthday channel set to ${ch.id}.`);
      return userNotice(message, `✅ Birthday announcements channel set to ${ch}.`);
    }

    // Mafia
    if (cmd === "mafia" && (args[0] || "").toLowerCase() === "start") {
      const existing = mafiaGames.get(guildId);
      if (existing) return userNotice(message, "A Mafia lobby/game is already running.");

      const hostId = message.author.id;
      mafiaGames.set(guildId, {
        hostId,
        channelId: message.channel.id,
        phase: "lobby",
        players: new Set([hostId]),
        lobbyMessageId: ""
      });

      const sent = await message.channel.send({
        content: mafiaLobbyContent(mafiaGames.get(guildId), message.guild),
        components: mafiaLobbyButtons(hostId),
        allowedMentions: { parse: [] }
      });

      mafiaGames.get(guildId).lobbyMessageId = sent.id;
      return;
    }

    if (cmd === "mafia" && (args[0] || "").toLowerCase() === "stop") {
      const game = mafiaGames.get(guildId);
      if (!game) return userNotice(message, "No Mafia lobby/game running.");

      const isHost = message.author.id === game.hostId;
      if (!isHost && !isAdmin) return userNotice(message, "Only the host or an admin can stop the game.");

      mafiaGames.delete(guildId);
      await adminLog(message.guild, `🕯️ Mafia stopped by ${message.author.id}.`);
      return;
    }

    // Medieval fun commands
    if (data[guildId].custom?.commands?.[cmd]) {
      ensureUser(guildId, message.author.id);
      const cfg = data[guildId].custom.commands[cmd];
      if (!cfg.enabled) return;

      if (Array.isArray(cfg.allowedRoleIds) && cfg.allowedRoleIds.length > 0) {
        const ok = cfg.allowedRoleIds.some((rid) => message.member.roles.cache.has(rid));
        if (!ok) return;
      }

      const u = data[guildId].users[message.author.id];
      const nowTs = Date.now();
      const last = u.customCooldowns[cmd] || 0;
      if (cfg.cooldownSec && (nowTs - last) / 1000 < cfg.cooldownSec) return;
      u.customCooldowns[cmd] = nowTs;

      const target = message.mentions.users.first();
      let text = "";
      let coinsDelta = 0;

      if (cmd === "beg") {
        coinsDelta = randInt(cfg.coinsMin, cfg.coinsMax);
        text = `🪙 ${message.author.username} kneels by the market gate and begs... A passer-by tosses **${coinsDelta} coin(s)**.`;
        addRewards(guildId, message.author.id, coinsDelta, 0);
      } else if (cmd === "pickpocket") {
        if (!target || target.bot) return userNotice(message, "Mention someone to pickpocket.");

        const eco = data[guildId].eco;
        const caught = Math.random() < eco.pickpocketCaughtChance;

        if (caught) {
          u.pickpocketCaught += 1;
          text = `🚨 ${message.author.username} tries to pickpocket ${target.username}... and gets **caught**! (Caught record: **${u.pickpocketCaught}**)`;
          await maybeApplyPickpocketPunishRole(message.guild, message.author.id).catch(() => {});
        } else {
          coinsDelta = randInt(cfg.coinsMin, cfg.coinsMax);
          text = `🧤 ${message.author.username} pickpockets ${target.username} and nicks **${coinsDelta} coin(s)**.`;
          if (coinsDelta) addRewards(guildId, message.author.id, coinsDelta, 0);
        }
      } else if (cmd === "slap") {
        if (!target || target.bot) return userNotice(message, "Mention someone to slap.");
        text = `🖐️ ${message.author.username} slaps ${target.username} in the town square. Scandalous.`;
      } else if (cmd === "punch") {
        if (!target || target.bot) return userNotice(message, "Mention someone to punch.");
        text = `🥊 ${message.author.username} throws a punch at ${target.username}. The crowd gasps.`;
      } else if (cmd === "duel") {
        if (!target || target.bot) return userNotice(message, "Mention someone to duel.");
        const win = Math.random() < 0.5;
        coinsDelta = win ? randInt(cfg.coinsMin, cfg.coinsMax) : 0;
        text = win
          ? `⚔️ ${message.author.username} duels ${target.username} and wins! The onlookers award **${coinsDelta} coin(s)**.`
          : `⚔️ ${message.author.username} duels ${target.username} but loses... No coins today.`;
        if (coinsDelta) addRewards(guildId, message.author.id, coinsDelta, 0);
      } else if (cmd === "praise") {
        if (!target || target.bot) return userNotice(message, "Mention someone to praise.");
        text = `🎩 ${message.author.username} offers noble praise to ${target.username}. Truly magnanimous.`;
      } else if (cmd === "insult") {
        if (!target || target.bot) return userNotice(message, "Mention someone to insult.");
        text = `🍅 ${message.author.username} hurls a scathing insult at ${target.username}. The crowd murmurs.`;
      }

      scheduleSave();
      await message.channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
      return;
    }

    return;
  }

  // Cooldown enforcement (non-command messages)
  if (!isChannelIgnoredCooldown(guildId, message.channel.id)) {
    const { seconds, key } = getCooldownForMember(message.member, message.channel.id);
    if (seconds && key) {
      const bucket = getUserBucket(guildId, message.author.id);
      const now = Date.now();
      const last = bucket.get(key) || 0;

      if ((now - last) / 1000 < seconds) {
        if (message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
          tryDelete(message);
        }
        return;
      }
      bucket.set(key, now);
    }
  }

  // Message rewards
  ensureUser(guildId, message.author.id);
  const u = data[guildId].users[message.author.id];
  const eco = data[guildId].eco;
  const now = Date.now();

  if ((now - u.lastMsgReward) / 1000 >= eco.msgRewardCooldownSec) {
    u.lastMsgReward = now;
    const coins = randInt(eco.msgCoinsMin, eco.msgCoinsMax);
    const xp = randInt(eco.msgXpMin, eco.msgXpMax);

    const { leveledUp, level } = addRewards(guildId, message.author.id, coins, xp);

    if (leveledUp) {
      const levelCh = message.guild.channels.cache.get(LEVEL_UP_CHANNEL_ID);
      if (levelCh) {
        levelCh.send({
          content: `⬆️ ${message.author.username} reached **Level ${level}**!`,
          allowedMentions: { parse: [] }
        }).catch(() => {});
      }
    }
  } else {
    scheduleSave();
  }
});

/* =============== START =============== */
client.login(TOKEN);
