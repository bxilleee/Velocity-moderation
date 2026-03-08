const { Client, GatewayIntentBits, Partials, Collection, REST, Routes, SlashCommandBuilder } = require('discord.js');
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

let recentJoins = [];
let uploadedFiles = [];
const invites = new Collection();

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const commands = [
    new SlashCommandBuilder()
        .setName('upload')
        .setDescription('Upload a file to the Velocity Dashboard')
        .addAttachmentOption(opt => opt.setName('file').setDescription('The file to upload').setRequired(true))
].map(c => c.toJSON());

client.on('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Velocity Engine Online');
    const guild = client.guilds.cache.first();
    if (guild) {
        const invs = await guild.invites.fetch();
        invites.set(guild.id, new Collection(invs.map(i => [i.code, i.uses])));
    }
});

client.on('interactionCreate', async (int) => {
    if (!int.isChatInputCommand() || int.commandName !== 'upload') return;
    const file = int.options.getAttachment('file');
    const data = { name: file.name, url: file.url, uploader: int.user.tag, time: new Date().toLocaleTimeString() };
    uploadedFiles.unshift(data);
    io.emit('newFile', data);
    await int.reply({ content: '✅ Uploaded to Dashboard!', ephemeral: true });
});

io.on('connection', (socket) => {
    socket.on('getInitData', async () => {
        const guild = client.guilds.cache.first();
        if (!guild) return;
        const members = await guild.members.fetch();
        socket.emit('initData', {
            channels: guild.channels.cache.filter(c => c.type === 0).map(c => ({id: c.id, name: c.name})),
            vcs: guild.channels.cache.filter(c => c.type === 2).map(c => ({id: c.id, name: c.name})),
            members: members.map(m => ({id: m.id, tag: m.user.tag})),
            files: uploadedFiles
        });
    });

    socket.on('fetchHistory', async (channelId) => {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased()) return;
            const messages = await channel.messages.fetch({ limit: 50 });
            const history = messages.map(m => ({
                author: m.author.username,
                content: m.content,
                channel: channel.name,
                channelId: channel.id,
                time: m.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            })).reverse();
            socket.emit('historyData', history);
        } catch (e) { console.error(e); }
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
            
            switch(d.type) {
                case 'warn': 
                    await member.send(`⚠️ **Warned in ${guild.name}:** ${d.reason}`).catch(()=>{});
                    await channel.send(`⚠️ **WARN:** <@${d.userId}> | ${d.reason}`); 
                    break;
                case 'kick': await member.kick(d.reason); break;
                case 'ban': await member.ban({ reason: d.reason }); break;
                case 'timeout': await member.timeout(d.time * 60000, d.reason); break;
                case 'lock': await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }); break;
                case 'unlock': await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true }); break;
                case 'slowmode': await channel.setRateLimitPerUser(parseInt(d.slow)); break;
                case 'move': await member.voice.setChannel(d.vcId); break;
                case 'disconnect': await member.voice.disconnect(); break;
                case 'mute': await member.voice.setMute(!member.voice.mute); break;
            }
        } catch (e) { console.error("Moderation Error:", e); }
    });
});

client.on('messageCreate', (m) => {
    if (m.author.bot) return;
    io.emit('discordMessage', { 
        author: m.author.username, 
        content: m.content, 
        channel: m.channel.name, 
        channelId: m.channel.id, 
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
    });
});

client.login(process.env.TOKEN);
server.listen(process.env.PORT || 3000, '0.0.0.0');
