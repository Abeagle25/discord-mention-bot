const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const dotenv = require('dotenv');
const Airtable = require('airtable');

dotenv.config();

console.log(`Using DISCORD_TOKEN: ${process.env.DISCORD_TOKEN ? '✅ Set' : '❌ Not Set'}`);

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const PORT = process.env.PORT || 10000;
const COACHES = ['Jeika', 'Tugce'];
const ACTIVE_HOURS = { start: 3, end: 22 }; // 3AM–10PM

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

// Slash Command: /queue
const commands = [
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription("See who's currently in the queue for a coach.")
    .addStringOption(option =>
      option
        .setName('coach')
        .setDescription('Coach name (e.g., Jeika, Tugce)')
        .setRequired(true)
        .addChoices(
          { name: 'Jeika', value: 'Jeika' },
          { name: 'Tugce', value: 'Tugce' }
        )
    )
    .toJSON(),
];

client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    console.log('🔁 Registering slash commands (guild-specific)...');
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, '1211718104703311902'), // Your server ID
      { body: commands }
    );
    console.log('✅ Slash commands registered.');
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
});

// Respond to /queue command
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'queue') {
    const coach = interaction.options.getString('coach');

    try {
      const records = await base(AIRTABLE_TABLE_NAME)
        .select({ filterByFormula: `{Mentioned} = "${coach}"` })
        .firstPage();

      if (records.length === 0) {
        await interaction.reply(`There’s no one in the queue for ${coach} right now.`);
      } else {
        const names = records.map(record => record.get('user') || 'Unknown User');
        await interaction.reply(
          `📝 Queue for ${coach}:\n${names.map((name, i) => `${i + 1}. ${name}`).join('\n')}`
        );
      }
    } catch (err) {
      console.error('Error fetching from Airtable:', err);
      await interaction.reply('⚠️ There was an error fetching the queue. Please try again later.');
    }
  }
});

// Monitor mentions outside active hours
client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.mentions.users.size) return;

  const currentHour = new Date().getHours();

  for (const coach of COACHES) {
    const mentioned = message.mentions.users.find(user =>
      user.username.toLowerCase().includes(coach.toLowerCase())
    );

    const withinHours = currentHour >= ACTIVE_HOURS.start && currentHour < ACTIVE_HOURS.end;

    console.log(`[CHECK] Mentioned: ${!!mentioned}, Within Hours: ${withinHours} (${coach})`);

    if (mentioned && !withinHours) {
      try {
        await base(AIRTABLE_TABLE_NAME).create({
          fields: {
            user: message.author.username,
            message: message.content,
            timestamp: new Date().toISOString(),
            Mentioned: coach,
          },
        });

        await message.reply(
          `Hi ${message.author.username}, ${coach} is currently offline.\nYour message has been queued, and they’ll get back to you during support hours (3AM–10PM EST). ✅`
        );
        console.log(`📥 Queued mention for ${coach} from ${message.author.username}`);
      } catch (error) {
        console.error('Failed to add to Airtable:', error);
      }
    }
  }
});

// Keep-alive server (for UptimeRobot)
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});
client.login(DISCORD_TOKEN);
