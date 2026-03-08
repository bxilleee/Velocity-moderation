const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers]
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// DATABASE
const DB_PATH = './velocity_db.json';
let db = { files: [], tickets: [], transcripts: [], knowledge: "", joins: [] };
if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
function saveDB() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ANALYTICS: Track new members
client.on('guildMemberAdd', (m) => {
    db.joins.push(new Date().toLocaleDateString());
    saveDB();
});

function getJoinStats() {
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
    console.log("Dashboard backend active.");
    // Update dashboard stats every 5s
    setInterval(() => {
        const g = client.guilds.cache.first();
        if(!g) return;
        io.emit('statsUpdate', { members: g.memberCount, ping: client.ws.ping, tickets: db.tickets.length, files: db.files.length });
    }, 5000);
});

client.on('messageCreate', (m) => {
    if (m.author.bot) return;
    // Push message to the Dashboard Log
    io.emit('discordMessage', { 
        author: m.author.username, 
        content: m.content, 
        channel: m.channel.name, 
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
    });
});

io.on('connection', (socket) => {
    socket.on('getInitData', async () => {
        const g = client.guilds.cache.first();
        if(!g) return;
        socket.emit('initData', {
            channels: g.channels.cache.filter(c => c.type === 0).map(c => ({id: c.id, name: c.name})),
            members: (await g.members.fetch()).map(m => ({id: m.id, tag: m.user.tag})),
            files: db.files,
            knowledge: db.knowledge,
            tickets: { active: db.tickets, transcripts: db.transcripts },
            joinData: getJoinStats(),
            stats: { members: g.memberCount, ping: client.ws.ping, tickets: db.tickets.length, files: db.files.length }
        });
    });

    socket.on('saveKnowledge', (t) => { db.knowledge = t; saveDB(); });
    socket.on('sendMessage', async (d) => { 
        const ch = await client.channels.fetch(d.channelId);
        if(ch) ch.send(d.content);
    });
    
    socket.on('moderation', async (d) => {
        const g = client.guilds.cache.first();
        const mem = await g.members.fetch(d.userId);
        if(d.type === 'ban') await mem.ban({reason: d.reason});
        if(d.type === 'kick') await mem.kick(d.reason);
    });
});

client.login(process.env.TOKEN);
server.listen(process.env.PORT || 3000);
