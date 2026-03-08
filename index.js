const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
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
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildInvites
    ],
    partials: [Partials.Channel, Partials.GuildMember]
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const invites = new Collection();
let recentJoins = [];

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

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
        invites: currentInvites.map(i => ({code: i.code, uses: i.uses, inviter: i.inviter?.tag || 'System'}))
    };
}

client.on('ready', async () => {
    console.log(`Velocity Engine Online | Logged in as ${client.user.tag}`);
    const guild = client.guilds.cache.first();
    if (guild) {
        const firstInvites = await guild.invites.fetch();
        invites.set(guild.id, new Collection(firstInvites.map((inv) => [inv.code, inv.uses])));
    }
});

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
        } catch (e) { console.error("Mod Error:", e); }
    });
});

client.on('guildMemberAdd', async (member) => {
    const newInvites = await member.guild.invites.fetch();
    const oldInvites = invites.get(member.guild.id);
    const invite = newInvites.find(i => i.uses > (oldInvites?.get(i.code) || 0));
    invites.set(member.guild.id, new Collection(newInvites.map((inv) => [inv.code, inv.uses])));

    const joinData = {
        tag: member.user.tag,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        inviteCode: invite ? invite.code : 'URL/Unknown',
        inviter: invite ? invite.inviter.tag : 'System'
    };
    recentJoins.unshift(joinData);
    if (recentJoins.length > 15) recentJoins.pop();
    io.emit('newJoiner', joinData);
});

client.on('messageCreate', (m) => {
    if (!m.author.bot) io.emit('discordMessage', { author: m.author.username, content: m.content, channel: m.channel.name });
});

client.login(process.env.TOKEN);
server.listen(process.env.PORT || 3000, '0.0.0.0');
