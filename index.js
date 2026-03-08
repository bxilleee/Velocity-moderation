const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
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

// --- UNIFIED DATABASE ---
const DB_PATH = './velocity_db.json';
let db = { files: [], tickets: [], transcripts: [], knowledge: "", joins: [], config: { staffRoleId: null } };

if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
function saveDB() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// --- JOIN TRACKING ---
client.on('guildMemberAdd', (member) => {
    db.joins.push(new Date().toLocaleDateString());
    saveDB();
});

function getJoinData() {
    const last7 = [];
    const values = [];
    for(let i=6; i>=0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const ds = d.toLocaleDateString();
        last7.push(ds.split('/')[0] + '/' + ds.split('/')[1]);
        values.push(db.joins.filter(date => date === ds).length);
    }
    return { labels: last7, values };
}

client.on('ready', () => {
    console.log(`Velocity Dashboard Active: ${client.user.tag}`);
    // Live Pulse Every 5s
    setInterval(() => {
        const guild = client.guilds.cache.first();
        if(!guild) return;
        io.emit('statsUpdate', {
            members: guild.memberCount,
            ping: client.ws.ping,
            tickets: db.tickets.length,
            files: db.files.length
        });
    }, 5000);
});

// --- AI ANALYST WITH KNOWLEDGE BRAIN ---
client.on('messageCreate', async (m) => {
    if (m.author.bot) return;
    
    // Live Dashboard Logs
    io.emit('discordMessage', { author: m.author.username, content: m.content, channel: m.channel.name, time: new Date().toLocaleTimeString() });

    const ticket = db.tickets.find(t => t.channelId === m.channelId);
    if (ticket && !ticket.needsHuman) {
        m.channel.sendTyping();
        
        setTimeout(async () => {
            const input = m.content.toLowerCase();
            let aiAnswer = "I'm still learning. If I can't answer your question, please click 'Human Support' above!";

            // 1. Check Custom Knowledge Brain
            const lines = db.knowledge.split('\n');
            for (const line of lines) {
                if(line.includes(':')) {
                    const [q, a] = line.split(':');
                    if(input.includes(q.trim().toLowerCase())) {
                        aiAnswer = a.trim();
                        break;
                    }
                }
            }

            // 2. Fallback to Permission Analysis
            if(aiAnswer.startsWith("I'm still")) {
                if(input.includes("see") || input.includes("view")) {
                    aiAnswer = "I've checked your permissions. If you can't see a channel, you likely lack the required role. I have alerted staff.";
                }
            }

            await m.reply(`**Velocity AI Analyst**\n${aiAnswer}`);
        }, 1200);
    }
});

// --- DASHBOARD SOCKETS ---
io.on('connection', (socket) => {
    socket.on('getInitData', async () => {
        const guild = client.guilds.cache.first();
        if(!guild) return;
        socket.emit('initData', {
            channels: guild.channels.cache.filter(c => c.type === 0).map(c => ({id: c.id, name: c.name})),
            members: (await guild.members.fetch()).map(m => ({id: m.id, tag: m.user.tag})),
            files: db.files,
            knowledge: db.knowledge,
            tickets: { active: db.tickets, transcripts: db.transcripts },
            joinData: getJoinData(),
            stats: { members: guild.memberCount, ping: client.ws.ping, tickets: db.tickets.length, files: db.files.length }
        });
    });

    socket.on('saveKnowledge', (text) => { db.knowledge = text; saveDB(); });
    socket.on('sendMessage', async (d) => { const ch = await client.channels.fetch(d.channelId); ch.send(d.content); });
    
    socket.on('moderation', async (d) => {
        const guild = client.guilds.cache.first();
        const mem = await guild.members.fetch(d.userId);
        if(d.type === 'timeout') await mem.timeout(d.time * 60000, d.reason);
        if(d.type === 'ban') await mem.ban({reason: d.reason});
        if(d.type === 'kick') await mem.kick(d.reason);
    });

    socket.on('fileAction', (d) => {
        const f = db.files.find(file => file.id === d.id);
        if(f) { f.status = d.status; saveDB(); io.emit('initData', { ...db, stats: {}, joinData: getJoinData() }); }
    });
});

// --- TICKET HANDLING ---
client.on('interactionCreate', async (int) => {
    if(!int.isButton()) return;
    if(int.customId === 'create_ticket') {
        const ch = await int.guild.channels.create({ name: `ticket-${int.user.username}` });
        db.tickets.push({ channelId: ch.id, username: int.user.username, needsHuman: false });
        saveDB();
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('request_human').setLabel('Request Human').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('close_ticket').setLabel('Close').setStyle(ButtonStyle.Secondary)
        );
        await ch.send({ content: `Hello <@${int.user.id}>, the AI Analyst is ready.`, components: [row] });
        await int.reply({ content: "Ticket opened!", ephemeral: true });
    }
    if(int.customId === 'close_ticket') {
        const ticketIdx = db.tickets.findIndex(t => t.channelId === int.channelId);
        const msgs = await int.channel.messages.fetch({ limit: 50 });
        const text = msgs.reverse().map(m => `${m.author.tag}: ${m.content}`).join('\n');
        db.transcripts.unshift({ user: int.user.username, text, date: new Date().toLocaleDateString() });
        db.tickets.splice(ticketIdx, 1);
        saveDB();
        await int.reply("Closing...");
        setTimeout(() => int.channel.delete(), 2000);
    }
});

client.login("YOUR_TOKEN_HERE");
server.listen(3000);
