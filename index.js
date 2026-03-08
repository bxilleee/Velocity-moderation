const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- UNIFIED DATABASE MANAGEMENT ---
const DB_PATH = './velocity_db.json';
let db = { 
    files: [], 
    tickets: [], 
    transcripts: [], 
    knowledge: "", 
    joins: [], 
    config: { staffRoleId: null, ticketChannelId: null } 
};

// Load database on start
if (fs.existsSync(DB_PATH)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) { console.error("DB Load Error:", e); }
}

function saveDB() { 
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); 
}

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// --- ANALYTICS: JOIN TRACKER ---
client.on('guildMemberAdd', (member) => {
    const today = new Date().toLocaleDateString();
    db.joins.push(today);
    saveDB();
});

function getJoinStats() {
    const labels = [];
    const values = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const ds = d.toLocaleDateString();
        labels.push(ds.split('/')[0] + '/' + ds.split('/')[1]); // Format MM/DD
        values.push(db.joins.filter(date => date === ds).length);
    }
    return { labels, values };
}

client.on('ready', () => {
    console.log(`Velocity System Online: ${client.user.tag}`);
    
    // Pulse system stats to dashboard every 5 seconds
    setInterval(() => {
        const guild = client.guilds.cache.first();
        if (!guild) return;
        io.emit('statsUpdate', {
            members: guild.memberCount,
            ping: client.ws.ping,
            tickets: db.tickets.length,
            files: db.files.length
        });
    }, 5000);
});

// --- ENHANCED AI ANALYST ---
client.on('messageCreate', async (m) => {
    if (m.author.bot) return;
    
    // Emit live logs to dashboard
    io.emit('discordMessage', { 
        author: m.author.username, 
        content: m.content, 
        channel: m.channel.name, 
        time: new Date().toLocaleTimeString() 
    });

    const ticket = db.tickets.find(t => t.channelId === m.channelId);
    if (ticket && !ticket.needsHuman) {
        m.channel.sendTyping();
        
        setTimeout(async () => {
            const input = m.content.toLowerCase();
            const member = await m.guild.members.fetch(m.author.id);
            let aiAnswer = null;

            // 1. Check Knowledge Brain (Rules/FAQ)
            if (db.knowledge) {
                const lines = db.knowledge.split('\n');
                for (const line of lines) {
                    if (line.includes(':')) {
                        const [key, val] = line.split(':');
                        if (input.includes(key.trim().toLowerCase())) {
                            aiAnswer = val.trim();
                            break;
                        }
                    }
                }
            }

            // 2. Permission Analysis (If no FAQ found)
            if (!aiAnswer) {
                if (input.includes("see") || input.includes("view") || input.includes("access")) {
                    let target = m.mentions.channels.first();
                    if (!target) {
                        const words = input.split(' ');
                        target = m.guild.channels.cache.find(c => words.some(w => w.replace('#', '') === c.name));
                    }

                    if (target) {
                        const perms = target.permissionsFor(member);
                        aiAnswer = perms.has('ViewChannel') 
                            ? `Analysis: You **do** have permission to see <#${target.id}>. If it's hidden, try restarting Discord.` 
                            : `Analysis: You are missing the **View Channel** permission for <#${target.id}>. Staff intervention may be required.`;
                    } else {
                        aiAnswer = "I can check channel permissions! Just mention the channel (e.g., #general) in your message.";
                    }
                }
            }

            if (aiAnswer) {
                await m.reply(`**Velocity AI Analyst**\n${aiAnswer}`);
            }
        }, 1500);
    }
});

// --- DASHBOARD SOCKET LOGIC ---
io.on('connection', (socket) => {
    socket.on('getInitData', async () => {
        const guild = client.guilds.cache.first();
        if (!guild) return;
        
        socket.emit('initData', {
            channels: guild.channels.cache.filter(c => c.type === 0).map(c => ({id: c.id, name: c.name})),
            vcs: guild.channels.cache.filter(c => c.type === 2).map(c => ({id: c.id, name: c.name})),
            members: (await guild.members.fetch()).map(m => ({id: m.id, tag: m.user.tag})),
            files: db.files,
            knowledge: db.knowledge,
            tickets: { active: db.tickets, transcripts: db.transcripts },
            joinData: getJoinStats(),
            stats: { 
                members: guild.memberCount, 
                ping: client.ws.ping, 
                tickets: db.tickets.length, 
                files: db.files.length 
            }
        });
    });

    socket.on('saveKnowledge', (text) => { db.knowledge = text; saveDB(); });
    
    socket.on('moderation', async (d) => {
        try {
            const guild = client.guilds.cache.first();
            const mem = await guild.members.fetch(d.userId);
            if (d.type === 'timeout') await mem.timeout(d.time * 60000, d.reason);
            if (d.type === 'ban') await mem.ban({ reason: d.reason });
            if (d.type === 'kick') await mem.kick(d.reason);
        } catch (e) { console.error("Mod Error:", e); }
    });

    socket.on('fileAction', (d) => {
        const f = db.files.find(file => file.id === d.id);
        if (f) { f.status = d.status; saveDB(); io.emit('updateFiles', db.files); }
    });

    socket.on('sendMessage', async (d) => {
        const ch = await client.channels.fetch(d.channelId);
        if (ch) ch.send(d.content);
    });
});

// --- BUTTON INTERACTION HANDLING ---
client.on('interactionCreate', async (int) => {
    if (!int.isButton()) return;

    if (int.customId === 'create_ticket') {
        const ch = await int.guild.channels.create({ 
            name: `ticket-${int.user.username}`,
            permissionOverwrites: [
                { id: int.guild.id, deny: ['ViewChannel'] },
                { id: int.user.id, allow: ['ViewChannel', 'SendMessages'] }
            ]
        });
        
        db.tickets.push({ channelId: ch.id, userId: int.user.id, username: int.user.username, needsHuman: false });
        saveDB();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('request_human').setLabel('Call Staff').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('close_ticket').setLabel('Close').setStyle(ButtonStyle.Secondary)
        );

        await ch.send({ content: `Hello <@${int.user.id}>, describe your issue. My AI is analyzing this chat.`, components: [row] });
        await int.reply({ content: `Ticket created: <#${ch.id}>`, ephemeral: true });
        io.emit('ticketUpdate', { active: db.tickets, transcripts: db.transcripts });
    }

    if (int.customId === 'request_human') {
        const ticket = db.tickets.find(t => t.channelId === int.channelId);
        if (ticket) {
            ticket.needsHuman = true;
            saveDB();
            await int.channel.send("🚨 **Staff have been notified.** A human will be with you shortly.");
            await int.reply({ content: "Escalated.", ephemeral: true });
            io.emit('ticketUpdate', { active: db.tickets, transcripts: db.transcripts });
        }
    }

    if (int.customId === 'close_ticket') {
        const idx = db.tickets.findIndex(t => t.channelId === int.channelId);
        if (idx !== -1) {
            const msgs = await int.channel.messages.fetch({ limit: 100 });
            const log = msgs.reverse().map(m => `[${m.createdAt.toLocaleTimeString()}] ${m.author.tag}: ${m.content}`).join('\n');
            db.transcripts.unshift({ user: db.tickets[idx].username, text: log, date: new Date().toLocaleDateString() });
            db.tickets.splice(idx, 1);
            saveDB();
            await int.reply("Ticket closed. Saving transcript...");
            setTimeout(() => int.channel.delete(), 3000);
            io.emit('ticketUpdate', { active: db.tickets, transcripts: db.transcripts });
        }
    }
});

client.login(process.env.TOKEN);
server.listen(process.env.PORT || 3000);
