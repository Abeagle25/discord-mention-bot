import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } from 'discord.js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import Airtable from 'airtable';

dotenv.config();

// Airtable config
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;

// Coaches
const JEIKA_ID = '1176627262885072986';
const TUGCE_ID = '1147977042387992705';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const WORK_HOURS = { start: 3, end: 22 }; // 3 AM to 10 PM (in UTC-4)

const commands = [
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription("See who's in the queue for a coach.")
    .addStringOption(option =>
      option
        .setName('coach')
        .setDescription('Coach name (jeika or tugce)')
        .setRequired(true)
        .addChoices(
          { name: 'Jeika', value: 'Jeika' },
          { name: 'Tugce', value: 'Tugce' }
        )
    )
    .toJSON(),
];

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🔐 Using DISCORD_TOKEN: ${process.env.DISCORD_TOKEN ? '✅ Set' : '❌ Not Set'}`);

  // Register slash command
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('🔁 Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, '1211718104703311902'), // your server ID
      { body: commands }
    );
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
});

// Slash command interaction
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'queue') {
    const coach = interaction.options.getString('coach');

    try {
      const records = await base(TABLE_NAME)
        .select({
          filterByFormula: `{Mentioned} = "${coach}"`,
          sort: [{ field: 'Created', direction: 'asc' }],
        })
        .firstPage();

      if (records.length === 0) {
        await interaction.reply(`📭 No students currently in the queue for ${coach}.`);
      } else {
        const studentList = records.map((record, i) => `${i + 1}. ${record.fields.user}`).join('\n');
        await interaction.reply(`📋 Queue for ${coach}:\n${studentList}`);
      }
    } catch (err) {
      console.error('❌ Error fetching from Airtable:', err);
      await interaction.reply('⚠️ Failed to fetch queue.');
    }
  }
});

// Message monitoring
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const hour = new Date().getUTCHours() - 4; // Convert to UTC-4
  const isInHours = hour >= WORK_HOURS.start && hour < WORK_HOURS.end;

  const mentions = message.mentions.users;
  const mentionedJeika = mentions.has(JEIKA_ID);
  const mentionedTugce = mentions.has(TUGCE_ID);

  if ((mentionedJeika || mentionedTugce) && !isInHours) {
    const coach = mentionedJeika ? 'Jeika' : 'Tugce';
    const existingRecords = await base(TABLE_NAME)
      .select({
        filterByFormula: `AND({user} = "${message.author.username}", {Mentioned} = "${coach}", IS_SAME(DATETIME_FORMAT({Created}, 'YYYY-MM-DD'), "${new Date().toISOString().split('T')[0]}"))`,
        maxRecords: 1
      })
      .firstPage();

    if (existingRecords.length === 0) {
      console.log(`[CHECK] Mentioned: true, Within Hours: false (${coach})`);
      console.log(`📥 Queued mention for ${coach} from ${message.author.username}`);

      await base(TABLE_NAME).create([
        {
          fields: {
            user: message.author.username,
            message: message.content,
            Mentioned: coach,
          }
        }
      ]);

      const records = await base(TABLE_NAME)
        .select({
          filterByFormula: `{Mentioned} = "${coach}"`,
          sort: [{ field: 'Created', direction: 'asc' }],
        })
        .firstPage();

      const position = records.findIndex(r => r.fields.user === message.author.username) + 1;

      await message.reply(
        `🕰️ ${coach} is currently offline.\nI've added you to the queue ✅\nYou're #${position} in line!`
      );
    }
  }
});

// Self-ping (every 4 minutes)
const SELF_PING_URL = process.env.SELF_PING_URL || `https://${process.env.RENDER_EXTERNAL_URL}`;
setInterval(() => {
  if (SELF_PING_URL) {
    fetch(SELF_PING_URL)
      .then(() => console.log('🔁 Self-ping successful'))
      .catch(err => console.error('❌ Self-ping failed', err));
  }
}, 240000); // 4 minutes

client.login(process.env.DISCORD_TOKEN);
