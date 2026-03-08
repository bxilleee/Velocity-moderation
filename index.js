const { Client, GatewayIntentBits, Partials, Collection, PermissionFlagsBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, 
        GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildInvites
    ],
    partials: [Partials.Channel, Partials.GuildMember]
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const invites = new Collection();
let recentJoins = [];
let uploadedFiles = []; // Store file metadata
let allLogs = []; // Store all logs for filtering

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- SLASH COMMAND REGISTRATION ---
const commands = [
    new SlashCommandBuilder()
        .setName('upload')
        .setDescription('Upload a file to the Velocity Dashboard')
        .addAttachmentOption(opt => opt.setName('file').setDescription('The file to upload').setRequired(true))
].map(c => c.toJSON());

client.on('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Velocity Engine Online | Slash Commands Ready');
    } catch (e) { console.error(e); }
    
    const guild = client.guilds.cache.first();
    if (guild) {
        const firstInvites = await guild.invites.fetch();
        invites.set(guild.id, new Collection(firstInvites.map((inv) => [inv.code, inv.uses])));
    }
});

// --- COMMAND INTERACTION ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'upload') {
        const file = interaction.options.getAttachment('file');
        const fileData = {
            name: file.name,
            url: file.url,
            uploader: interaction.user.tag,
            time: new Date().toLocaleTimeString()
        };
        uploadedFiles.unshift(fileData);
        io.emit('newFile', fileData);
        await interaction.reply({ content: `✅ File "${file.name}" uploaded to Velocity Dashboard!`, ephemeral: true });
    }
});

async function getServerData() {
    const guild = client.guilds.cache.first();
    if (!guild) return null;
    const members = await guild.members.fetch();
    const currentInvites = await guild.invites.fetch();
    return {
        channels: guild.channels.cache.filter(c => c.type === 0).map(c => ({id: c.id, name: c.name})),
        vcs: guild.channels.cache.filter(c => c.type === 2).map(c => ({id: c.id, name: c.name})),
        members: members.map(m => ({id: m.id, tag: m.user.tag})),
        recentJoins: recentJoins,
        invites: currentInvites.map(i => ({code: i.code, uses: i.uses, inviter: i.inviter?.tag || 'System'})),
        files: uploadedFiles,
        logs: allLogs
    };
}

io.on('connection', (socket) => {
    socket.on('getInitData', async () => {
        const data = await getServerData();
        if (data) socket.emit('initData', data);
    });

    socket.on('heartbeat', async () => {
        const data = await getServerData();
        if (data) socket.emit('initData', data);
    });

    socket.on('sendMessage', async (d) => {
        const ch = await client.channels.fetch(d.channelId);
        if (ch) ch.send(d.content);
    });

    socket.on('moderation', async (d) => {
        const guild = client.guilds.cache.first();
        try {
            const member = await guild.members.fetch(d.userId);
            const channel = await guild.channels.fetch(d.channelId);
            
            // For DM Warning
            if(d.type === 'warn') {
                await member.send(`⚠️ **Velocity Alert:** You have been warned in **${guild.name}**\n**Reason:** ${d.reason || "No reason specified."}`).catch(() => {});
                await channel.send(`⚠️ **WARN:** <@${d.userId}> | ${d.reason}`);
            }

            // For Lock/Unlock logging
            if(d.type === 'lock' || d.type === 'unlock') {
                const state = d.type === 'lock' ? 'LOCKED' : 'UNLOCKED';
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: d.type === 'unlock' });
                await channel.send(`🛡️ **Channel ${state}** by Velocity Admin.`);
            }

            // Standards
            switch(d.type) {
                case 'timeout': await member.timeout(d.time * 60000, d.reason); break;
                case 'kick': await member.kick(d.reason); break;
                case 'ban': await member.ban({ reason: d.reason }); break;
                case 'slowmode': await channel.setRateLimitPerUser(parseInt(d.slow)); break;
                case 'move': await member.voice.setChannel(d.vcId); break;
                case 'disconnect': await member.voice.disconnect(); break;
                case 'mute': await member.voice.setMute(!member.voice.mute); break;
            }
        } catch (e) { console.error("Mod Error:", e); }
    });
});

client.on('messageCreate', (m) => {
    if (m.author.bot) return;
    const log = { author: m.author.username, content: m.content, channel: m.channel.name, channelId: m.channel.id, time: new Date().toLocaleTimeString() };
    allLogs.unshift(log);
    if(allLogs.length > 100) allLogs.pop();
    io.emit('discordMessage', log);
});

client.login(process.env.TOKEN);
server.listen(process.env.PORT || 3000, '0.0.0.0');
