const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates]
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- DB SETUP ---
const DB_PATH = './velocity_db.json';
let db = { files: [], tickets: [], transcripts: [], knowledge: "", config: { channelId: null, staffRoleId: null } };

if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
function saveDB() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

client.on('ready', () => {
    console.log(`Velocity Online: ${client.user.tag}`);
    // Live Stats Broadcaster
    setInterval(async () => {
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

// --- AI ANALYST (Enhanced with Knowledge Brain) ---
client.on('messageCreate', async (m) => {
    if (m.author.bot) return;

    const ticket = db.tickets.find(t => t.channelId === m.channelId);
    if (ticket && !ticket.needsHuman) {
        m.channel.sendTyping();
        
        setTimeout(async () => {
            const input = m.content.toLowerCase();
            const member = await m.guild.members.fetch(m.author.id);
            let response = null;

            // 1. Check Knowledge Brain First
            if (db.knowledge && db.knowledge.length > 10) {
                const lines = db.knowledge.split('\n');
                for (const line of lines) {
                    const parts = line.split(':');
                    if (parts.length > 1 && input.includes(parts[0].toLowerCase().trim())) {
                        response = `[Knowledge Brain Match]: ${parts[1].trim()}`;
                        break;
                    }
                }
            }

            // 2. Permission Analysis (If no knowledge match)
            if (!response) {
                if (input.includes("see") || input.includes("view") || input.includes("access")) {
                    let target = m.mentions.channels.first();
                    if(target) {
                        const perms = target.permissionsFor(member);
                        response = perms.has('ViewChannel') ? `You have permission to see <#${target.id}>. Try restarting Discord.` : `You lack the **View Channel** permission for <#${target.id}>.`;
                    }
                }
            }

            await m.reply(`**Velocity AI Analyst**\n${response || "I'm not sure about that. Try asking staff by clicking 'Request Human Support' above!"}`);
        }, 1000);
    }
    
    io.emit('discordMessage', { author: m.author.username, content: m.content, channel: m.channel.name, channelId: m.channel.id, time: new Date().toLocaleTimeString() });
});

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('getInitData', async () => {
        const guild = client.guilds.cache.first();
        if(!guild) return;
        socket.emit('initData', {
            channels: guild.channels.cache.filter(c => c.type === 0).map(c => ({id: c.id, name: c.name})),
            vcs: guild.channels.cache.filter(c => c.type === 2).map(c => ({id: c.id, name: c.name})),
            members: (await guild.members.fetch()).map(m => ({id: m.id, tag: m.user.tag})),
            files: db.files,
            knowledge: db.knowledge,
            tickets: { active: db.tickets, transcripts: db.transcripts },
            stats: { members: guild.memberCount, ping: client.ws.ping, tickets: db.tickets.length, files: db.files.length }
        });
    });

    socket.on('saveKnowledge', (text) => { db.knowledge = text; saveDB(); });

    socket.on('moderation', async (d) => {
        const guild = client.guilds.cache.first();
        const member = await guild.members.fetch(d.userId);
        const channel = await guild.channels.fetch(d.channelId);
        if(d.type === 'timeout') await member.timeout(d.time * 60000, d.reason);
        if(d.type === 'ban') await member.ban({reason: d.reason});
        if(d.type === 'lock') await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
        if(d.type === 'unlock') await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true });
    });

    socket.on('fileAction', (d) => {
        const file = db.files.find(f => f.id === d.id);
        if(file) { file.status = d.status; saveDB(); io.emit('updateFiles', db.files); }
    });

    socket.on('setupTickets', async (d) => {
        const channel = await client.channels.fetch(d.channelId);
        db.config = { channelId: d.channelId, staffRoleId: d.roleId }; saveDB();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('create_ticket').setLabel('Open Ticket').setStyle(ButtonStyle.Primary));
        await channel.send({ content: "Need help? Click below!", components: [row] });
    });
});

client.on('interactionCreate', async (int) => {
    if (int.isButton() && int.customId === 'create_ticket') {
        const channel = await int.guild.channels.create({ name: `ticket-${int.user.username}` });
        db.tickets.push({ channelId: channel.id, username: int.user.username, needsHuman: false }); saveDB();
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('request_human').setLabel('Human Support').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('close_ticket').setLabel('Close').setStyle(ButtonStyle.Secondary)
        );
        await channel.send({ content: `Welcome <@${int.user.id}>!`, components: [row] });
        await int.reply({ content: "Ticket Open!", ephemeral: true });
        io.emit('ticketUpdate', { active: db.tickets, transcripts: db.transcripts });
    }
});

client.login(process.env.TOKEN);
server.listen(3000);
