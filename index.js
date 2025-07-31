import express from 'express';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from 'discord.js';
import dotenv from 'dotenv';
import Airtable from 'airtable';
import cron from 'node-cron';
import fetch from 'node-fetch';

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const SUMMARY_CHANNEL_ID = process.env.SUMMARY_CHANNEL_ID;
const PORT = process.env.PORT || 3000;

// Airtable base setup
const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const queueTable = base(AIRTABLE_TABLE_NAME);

// 🟢 Coach working hours (24-hour format)
const coachHours = {
  'Jeika': { start: 3, end: 22 },
  'Tugce': { start: 3, end: 22 }
};

// 🟢 Coach Discord IDs (used for tagging)
const coachDiscordIds = {
  'Jeika': '1211621957270894602',
  'Tugce': '1225908721785026580'
};

// Express server for Render
const app = express();
app.get('/', (_, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

// Keep alive ping every 5 minutes
setInterval(() => {
  fetch(`http://localhost:${PORT}`).catch(() => {});
}, 5 * 60 * 1000);

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

// Slash command: /queue
const queueCommand = new SlashCommandBuilder()
  .setName('queue')
  .setDescription("View who's in the queue for a coach")
  .addStringOption(option =>
    option.setName('coach')
      .setDescription('Coach name (Jeika or Tugce)')
      .setRequired(true)
  );

// Register slash command
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
async function registerSlashCommands() {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: [queueCommand.toJSON()],
    });
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('❌ Failed to register slash commands:', err);
  }
}

// Handle /queue command
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'queue') {
    const coach = interaction.options.getString('coach');
    const today = new Date().toISOString().split('T')[0];

    try {
      const records = await queueTable.select({
        filterByFormula: `AND({Mentioned} = "${coach}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`
      }).all();

      if (records.length === 0) {
        await interaction.reply(`No one is currently in the queue for **${coach}**.`);
      } else {
        const names = records.map(r => r.get('user')).join('\n');
        await interaction.reply(`Current queue for **${coach}**:\n${names}`);
      }
    } catch (err) {
      console.error(err);
      await interaction.reply('There was an error fetching the queue.');
    }
  }
});

// Handle mention outside of working hours
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const mentionedCoach = Object.keys(coachDiscordIds).find(coach =>
    message.mentions.users.has(coachDiscordIds[coach])
  );

  if (!mentionedCoach) return;

  const now = new Date();
  const hour = now.getHours();
  const { start, end } = coachHours[mentionedCoach];

  if (hour >= start && hour < end) return; // inside working hours

  const today = now.toISOString().split('T')[0];

  // Check if already queued
  const existing = await queueTable.select({
    filterByFormula: `AND({Mentioned} = "${mentionedCoach}", {user} = "${message.author.username}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`
  }).firstPage();

  if (existing.length === 0) {
    await queueTable.create({
      user: message.author.username,
      Mentioned: mentionedCoach,
      Timestamp: now.toISOString()
    });
  }

  // Calculate position
  const records = await queueTable.select({
    filterByFormula: `AND({Mentioned} = "${mentionedCoach}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
    sort: [{ field: 'Timestamp', direction: 'asc' }]
  }).all();

  const position = records.findIndex(r => r.get('user') === message.author.username) + 1;

  message.reply(`Thanks for your message! ${mentionedCoach} is currently unavailable. You’ve been added to their queue. You’re #${position} today.`);

  console.log(`Queued: ${message.author.username} for ${mentionedCoach} (#${position})`);
});

// Daily summary at 10 PM
cron.schedule('0 22 * * *', async () => {
  const today = new Date().toISOString().split('T')[0];
  const channel = await client.channels.fetch(SUMMARY_CHANNEL_ID);

  if (!channel || !channel.isTextBased()) return;

  for (const coach of Object.keys(coachDiscordIds)) {
    const records = await queueTable.select({
      filterByFormula: `AND({Mentioned} = "${coach}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
      sort: [{ field: 'Timestamp', direction: 'asc' }]
    }).all();

    if (records.length === 0) continue;

    const list = records.map((r, i) => `${i + 1}. ${r.get('user')}`).join('\n');
    const mention = `<@${coachDiscordIds[coach]}>`;

    await channel.send(`📋 Queue for ${coach} today (${today}):\n${mention}\n${list}`);
  }
});

// Ready
client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

registerSlashCommands();
client.login(DISCORD_TOKEN);
