require('dotenv').config();
const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const Airtable = require('airtable');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const table = base(process.env.AIRTABLE_TABLE_NAME);

const coaches = ['Jeika', 'Tugce'];
const mentionHours = { start: 3, end: 22 }; // 3 AM to 10 PM
const repliedMentions = new Set();

function isOutOfHours() {
  const now = new Date();
  const hour = now.getHours();
  return hour < mentionHours.start || hour >= mentionHours.end;
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const mentionedCoach = coaches.find((coach) => message.content.toLowerCase().includes(coach.toLowerCase()));
  if (!mentionedCoach || !isOutOfHours()) return;

  const messageId = message.id;
  const today = new Date().toISOString().slice(0, 10);

  // Check for duplicate reply
  if (repliedMentions.has(messageId)) return;

  // Save to Airtable (or update if same user already exists today for the same coach)
  const user = message.author.username;
  const timestamp = new Date().toISOString();

  const formula = `AND({Mentioned} = "${mentionedCoach}", {user} = "${user}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`;

  try {
    const records = await table.select({ filterByFormula: formula }).firstPage();
    if (records.length === 0) {
      await table.create({
        user: user,
        Mentioned: mentionedCoach,
        Message: message.content,
        Timestamp: timestamp
      });
    }

    await message.reply(`⏰ ${mentionedCoach} is currently offline. Your message has been queued. We'll get back to you during support hours.`);
    repliedMentions.add(messageId);
  } catch (err) {
    console.error('Error saving to Airtable:', err);
  }
});

// Slash command setup (/queue)
const commands = [
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription("See who's currently in the support queue for each coach")
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    console.log('🔁 Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(client.user?.id || 'client_id', '1211718104703311902'), { body: commands });
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
})();

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'queue') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const records = await table.select({
        filterByFormula: `IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}")`
      }).all();

      if (records.length === 0) {
        return interaction.reply('✅ No students are currently in the queue.');
      }

      const queueByCoach = {};
      for (const record of records) {
        const coach = record.get('Mentioned') || 'Unknown';
        const user = record.get('user') || 'Unknown';

        if (!queueByCoach[coach]) queueByCoach[coach] = new Set();
        queueByCoach[coach].add(user);
      }

      const formatted = Object.entries(queueByCoach)
        .map(([coach, users]) => `**${coach}**: ${Array.from(users).join(', ')}`)
        .join('\n');

      interaction.reply(`📋 **Current Queue:**\n${formatted}`);
    } catch (err) {
      console.error('❌ Error fetching queue:', err);
      interaction.reply('❌ Failed to fetch queue.');
    }
  }
});

// Keep the bot alive (required for Render)
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => {
  res.send('Bot is running!');
});

app.listen(PORT, () => {
  console.log(`🌐 Server listening on port ${PORT}`);
});


// UptimeRobot ping every 4 minutes
setInterval(() => {
  const url = process.env.SELF_PING_URL || `https://${process.env.RENDER_EXTERNAL_URL}`;
  if (url) {
    axios.get(url)
      .then(() => console.log('🔁 Self-ping successful'))
      .catch((err) => console.error('❌ Self-ping failed:', err.message));
  } else {
    console.warn('⚠️ SELF_PING_URL not set in .env');
  }
}, 240000);

client.login(process.env.DISCORD_TOKEN);
