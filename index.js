require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, Collection, REST, Routes } = require('discord.js');
const Airtable = require('airtable');
const express = require('express');
const axios = require('axios');

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.commands = new Collection();

// Airtable config
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// Users to monitor
const monitoredUsers = [
  {
    id: '852485920023117854', // Jeika
    name: 'Jeika',
    startHour: 3,
    endHour: 4
  },
  {
    id: '454775533671284746', // Tugce
    name: 'Tugce',
    startHour: 3,
    endHour: 4
  }
];

// On bot ready
client.once('ready', async () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);

  // Register slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('See the current student queue for a specific coach')
      .addStringOption(option =>
        option.setName('coach')
          .setDescription('Coach name (e.g., Jeika, Tugce)')
          .setRequired(true)
      )
      .toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('✅ Slash command /queue registered');
  } catch (err) {
    console.error('❌ Failed to register slash commands:', err);
  }
});

// Error handling
client.on('error', (error) => console.error('❌ Discord client error:', error));
client.on('shardError', (error) => console.error('❌ Shard error:', error));

// Helper: today's date
function getToday() {
  return new Date().toISOString().split('T')[0];
}

// Handle /queue slash command
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'queue') {
    const coach = interaction.options.getString('coach');
    const today = getToday();

    try {
      const records = await base(process.env.AIRTABLE_TABLE_NAME).select({
        filterByFormula: `AND({Mentioned} = "${coach}", IS_SAME(DATETIME_FORMAT({Timestamp}, 'YYYY-MM-DD'), '${today}'))`,
        sort: [{ field: 'Timestamp', direction: 'asc' }]
      }).firstPage();

      const usersInQueue = [...new Set(records.map(r => r.fields.User))];

      if (usersInQueue.length === 0) {
        await interaction.reply({ content: `📭 There are no students currently in the queue for ${coach}.`, ephemeral: true });
      } else {
        const list = usersInQueue.map((u, i) => `${i + 1}. ${u}`).join('\n');
        await interaction.reply({ content: `📋 **Current queue for ${coach}:**\n${list}`, ephemeral: true });
      }
    } catch (err) {
      console.error('❌ Error fetching queue:', err);
      await interaction.reply({ content: `⚠️ There was an error retrieving the queue for ${coach}.`, ephemeral: true });
    }
  }
});

// On message received
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const now = new Date();
  const currentHour = now.getHours();
  const today = getToday();

  monitoredUsers.forEach(async (user) => {
    const isMentioned = message.mentions.users.has(user.id);
    const isWithinHours = currentHour >= user.startHour && currentHour < user.endHour;

    if (isMentioned && !isWithinHours) {
      const filter = `AND({Mentioned} = "${user.name}", {User} = "${message.author.username}", IS_SAME(DATETIME_FORMAT({Timestamp}, 'YYYY-MM-DD'), '${today}'))`;

      try {
        const records = await base(process.env.AIRTABLE_TABLE_NAME).select({
          filterByFormula: filter,
          sort: [{ field: 'Timestamp', direction: 'asc' }]
        }).firstPage();

        if (records.length > 0) {
          const existing = records[0];
          const currentMessage = existing.fields.Message || '';
          const updatedMessage = `${currentMessage}\n- ${message.content}`;

          await base(process.env.AIRTABLE_TABLE_NAME).update(existing.id, {
            Message: updatedMessage
          });

          console.log(`📝 Appended message for ${user.name} from ${message.author.username}`);
        } else {
          await base(process.env.AIRTABLE_TABLE_NAME).create({
            Mentioned: user.name,
            User: message.author.username,
            Message: message.content,
            Timestamp: new Date().toISOString(),
            Channel: message.channel.name || "DM or Unknown"
          });

          console.log(`📥 New queue entry for ${user.name} from ${message.author.username}`);
        }

        const queueRecords = await base(process.env.AIRTABLE_TABLE_NAME).select({
          filterByFormula: `AND({Mentioned} = "${user.name}", IS_SAME(DATETIME_FORMAT({Timestamp}, 'YYYY-MM-DD'), '${today}'))`
        }).firstPage();

        const studentUsernames = [...new Set(queueRecords.map(r => r.fields.User))];
        const position = studentUsernames.indexOf(message.author.username) + 1;

        await message.reply({
          content: `Hey ${message.author.username}, your message has been added to your coach’s queue. You’re number #${position} in line. They’ll get back to you during office hours.`
        });

        console.log(`💬 Replied with position #${position} for ${message.author.username}`);

      } catch (err) {
        console.error('❌ Airtable error:', err);
      }
    }
  });
});

console.log(`Using DISCORD_TOKEN: ${process.env.DISCORD_TOKEN ? '✅ Set' : '❌ Not Set'}`);
// Login AFTER events are registered
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Discord login failed:', err);
});

// Express server for UptimeRobot
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('✅ Bot is running!');
});

app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
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
