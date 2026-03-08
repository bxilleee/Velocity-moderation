const { Client, GatewayIntentBits, Partials, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Channel]
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serves the HTML file directly from the root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
    socket.on('getInitData', async () => {
        const guild = client.guilds.cache.first();
        if (!guild) return;
        
        const members = await guild.members.fetch();
        socket.emit('initData', {
            channels: guild.channels.cache.filter(c => c.type === 0).map(c => ({id: c.id, name: c.name})),
            vcs: guild.channels.cache.filter(c => c.type === 2).map(c => ({id: c.id, name: c.name})),
            members: members.map(m => ({id: m.id, tag: m.user.tag}))
        });
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
                case 'timeout': await member.timeout(d.time * 60000, d.reason); break;
                case 'kick': await member.kick(d.reason); break;
                case 'ban': await member.ban({ reason: d.reason }); break;
                case 'warn': await channel.send(`⚠️ **WARN:** <@${d.userId}> | ${d.reason}`); break;
                case 'lock': await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }); break;
                case 'unlock': await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true }); break;
                case 'slowmode': await channel.setRateLimitPerUser(parseInt(d.slow)); break;
                case 'move': await member.voice.setChannel(d.vcId); break;
                case 'disconnect': await member.voice.disconnect(); break;
                case 'mute': await member.voice.setMute(!member.voice.mute); break;
            }
        } catch (e) { console.error("Velocity Mod Error:", e); }
    });
});

client.on('messageCreate', (m) => {
    if (!m.author.bot) io.emit('discordMessage', { author: m.author.username, content: m.content, channel: m.channel.name });
});

// IMPORTANT: This pulls from Railway/VPS Variables, NOT GitHub code
client.login(process.env.TOKEN);

server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Velocity Engine Online'));
