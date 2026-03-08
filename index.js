const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates]
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DB_PATH = './velocity_db.json';
let db = { files: [], tickets: [], transcripts: [], knowledge: "", joins: [] };

if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
function saveDB() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

client.on('guildMemberAdd', (m) => { db.joins.push(new Date().toLocaleDateString()); saveDB(); });

function getJoinData() {
    const labels = []; const values = [];
    for(let i=6; i>=0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = d.toLocaleDateString();
        labels.push(ds.split('/')[0] + '/' + ds.split('/')[1]);
        values.push(db.joins.filter(date => date === ds).length);
    }
    return { labels, values };
}

client.on('ready', () => {
    console.log("Velocity Online");
    setInterval(() => {
        const g = client.guilds.cache.first();
        if(!g) return;
        io.emit('statsUpdate', { members: g.memberCount, ping: client.ws.ping, tickets: db.tickets.length, files: db.files.length });
    }, 5000);
});

client.on('messageCreate', async (m) => {
    if (m.author.bot) return;
    io.emit('discordMessage', { author: m.author.username, content: m.content, channel: m.channel.name, time: new Date().toLocaleTimeString() });

    const ticket = db.tickets.find(t => t.channelId === m.channelId);
    if (ticket && !ticket.needsHuman) {
        const lines = db.knowledge.split('\n');
        for (const line of lines) {
            if(line.includes(':')) {
                const [q, a] = line.split(':');
                if(m.content.toLowerCase().includes(q.trim().toLowerCase())) {
                    return m.reply(`**AI Analyst:** ${a.trim()}`);
                }
            }
        }
    }
});

io.on('connection', (socket) => {
    socket.on('getInitData', async () => {
        const g = client.guilds.cache.first();
        if(!g) return;
        socket.emit('initData', {
            channels: g.channels.cache.filter(c => c.type === 0).map(c => ({id: c.id, name: c.name})),
            members: (await g.members.fetch()).map(m => ({id: m.id, tag: m.user.tag})),
            files: db.files, knowledge: db.knowledge,
            tickets: { active: db.tickets, transcripts: db.transcripts },
            joinData: getJoinData(), stats: { members: g.memberCount, ping: client.ws.ping, tickets: db.tickets.length, files: db.files.length }
        });
    });

    socket.on('saveKnowledge', (t) => { db.knowledge = t; saveDB(); });
    socket.on('sendMessage', async (d) => { (await client.channels.fetch(d.channelId)).send(d.content); });
    socket.on('moderation', async (d) => {
        const g = client.guilds.cache.first();
        const mem = await g.members.fetch(d.userId);
        if(d.type === 'timeout') await mem.timeout(d.time * 60000, d.reason);
        if(d.type === 'ban') await mem.ban({reason: d.reason});
    });
});

client.login(process.env.TOKEN);
server.listen(process.env.PORT || 3000);
