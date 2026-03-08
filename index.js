const { Client, GatewayIntentBits, Partials, Collection, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

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

const DATA_FILE = './files.json';
const TICKET_FILE = './tickets.json';
let uploadedFiles = [];
let ticketConfig = { channelId: null, staffRoleId: null, activeTickets: [] };

// Load Data
if (fs.existsSync(DATA_FILE)) uploadedFiles = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
if (fs.existsSync(TICKET_FILE)) ticketConfig = JSON.parse(fs.readFileSync(TICKET_FILE, 'utf8'));

function saveFiles() { fs.writeFileSync(DATA_FILE, JSON.stringify(uploadedFiles, null, 2)); }
function saveTickets() { fs.writeFileSync(TICKET_FILE, JSON.stringify(ticketConfig, null, 2)); }

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

client.on('ready', async () => {
    console.log('Velocity AI-Support Online');
});

// --- TICKET & BUTTON HANDLING ---
client.on('interactionCreate', async (int) => {
    if (int.isButton()) {
        if (int.customId === 'create_ticket') {
            const ticketId = `ticket-${int.user.id}-${Date.now()}`;
            const channel = await int.guild.channels.create({
                name: `ticket-${int.user.username}`,
                type: 0,
                permissionOverwrites: [
                    { id: int.guild.id, deny: ['ViewChannel'] },
                    { id: int.user.id, allow: ['ViewChannel', 'SendMessages'] },
                    { id: ticketConfig.staffRoleId || int.guild.id, allow: ['ViewChannel'] }
                ]
            });

            const embed = new EmbedBuilder()
                .setTitle("Velocity AI Support")
                .setDescription(`Hello <@${int.user.id}>! I am the Velocity AI. **Why has this ticket been created today?**\n\nI will try to assist you, but you can request a human at any time.`)
                .setColor("#6366f1");

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('request_human').setLabel('Request Human Support').setButtonStyle(ButtonStyle.Danger)
            );

            await channel.send({ embeds: [embed], components: [row] });
            
            ticketConfig.activeTickets.push({ 
                channelId: channel.id, 
                userId: int.user.id, 
                username: int.user.username,
                needsHuman: false 
            });
            saveTickets();
            io.emit('ticketUpdate', ticketConfig.activeTickets);
            await int.reply({ content: `Ticket created: <#${channel.id}>`, ephemeral: true });
        }

        if (int.customId === 'request_human') {
            const ticket = ticketConfig.activeTickets.find(t => t.channelId === int.channelId);
            if (ticket) {
                ticket.needsHuman = true;
                saveTickets();
                io.emit('ticketUpdate', ticketConfig.activeTickets);
                await int.channel.send(`🚨 <@&${ticketConfig.staffRoleId}> **Human support has been requested!**`);
                await int.reply({ content: "Staff have been notified via the dashboard.", ephemeral: true });
            }
        }
    }
});

// AI Simulation/Response Logic
client.on('messageCreate', async (m) => {
    if (m.author.bot) return;
    
    // Check if message is in an active ticket
    const ticket = ticketConfig.activeTickets.find(t => t.channelId === m.channelId);
    if (ticket && !ticket.needsHuman) {
        m.channel.sendTyping();
        // This is a placeholder for your AI API (OpenAI/Gemini). 
        // For now, it provides an "intelligent" helper response.
        setTimeout(() => {
            m.reply(`[Velocity AI]: I've noted that: "${m.content}". I am analyzing this for you. If my answer isn't sufficient, please click the Human Support button above.`);
        }, 1500);
    }

    // Existing Live Logs Logic
    io.emit('discordMessage', { 
        author: m.author.username, content: m.content, channel: m.channel.name, channelId: m.channel.id, 
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
    });
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
            files: uploadedFiles,
            tickets: ticketConfig.activeTickets,
            config: { ticketChannel: ticketConfig.channelId, staffRole: ticketConfig.staffRoleId }
        });
    });

    socket.on('setupTickets', async (d) => {
        ticketConfig.channelId = d.channelId;
        ticketConfig.staffRoleId = d.roleId;
        saveTickets();
        
        const channel = await client.channels.fetch(d.channelId);
        const embed = new EmbedBuilder()
            .setTitle("Support Center")
            .setDescription("Need assistance? Click the button below to open an AI-powered support ticket.")
            .setColor("#6366f1")
            .setFooter({ text: "Velocity Intelligent Support" });
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('create_ticket').setLabel('Create Ticket').setStyle(ButtonStyle.Primary)
        );
        
        await channel.send({ embeds: [embed], components: [row] });
    });

    // ... All previous moderation and history sockets remain below ...
    socket.on('fetchHistory', async (id) => { /* logic stays same */ });
    socket.on('fileAction', (d) => {
        const file = uploadedFiles.find(f => f.id === d.id);
        if (file) { file.status = d.status; saveFiles(); io.emit('updateFiles', uploadedFiles); }
    });
    socket.on('moderation', async (d) => { /* logic stays same */ });
    socket.on('sendMessage', async (d) => { /* logic stays same */ });
});

client.login(process.env.TOKEN);
server.listen(process.env.PORT || 3000, '0.0.0.0');
