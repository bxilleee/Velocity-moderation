const { 
    Client, GatewayIntentBits, Partials, Collection, REST, Routes, 
    SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder 
} = require('discord.js');
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

// --- PERMANENT STORAGE SETUP ---
const FILES_DB = './files.json';
const TICKETS_DB = './tickets.json';

let uploadedFiles = [];
let ticketConfig = { channelId: null, staffRoleId: null, activeTickets: [], transcripts: [] };

// Load data from disk
if (fs.existsSync(FILES_DB)) uploadedFiles = JSON.parse(fs.readFileSync(FILES_DB, 'utf8'));
if (fs.existsSync(TICKETS_DB)) {
    const loaded = JSON.parse(fs.readFileSync(TICKETS_DB, 'utf8'));
    ticketConfig = { ...ticketConfig, ...loaded }; // Merge to ensure transcripts array exists
}

function saveData() {
    fs.writeFileSync(FILES_DB, JSON.stringify(uploadedFiles, null, 2));
    fs.writeFileSync(TICKETS_DB, JSON.stringify(ticketConfig, null, 2));
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- SLASH COMMANDS ---
const commands = [
    new SlashCommandBuilder()
        .setName('upload')
        .setDescription('Upload a file to the dashboard for approval')
        .addAttachmentOption(opt => opt.setName('file').setDescription('The file').setRequired(true))
].map(c => c.toJSON());

client.on('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`Velocity Online | Logged in as ${client.user.tag}`);
});

// --- DISCORD INTERACTION LOGIC (Tickets & Uploads) ---
client.on('interactionCreate', async (int) => {
    if (int.isChatInputCommand() && int.commandName === 'upload') {
        const file = int.options.getAttachment('file');
        const data = { id: Date.now(), name: file.name, url: file.url, uploader: int.user.tag, status: 'pending', time: new Date().toLocaleTimeString() };
        uploadedFiles.unshift(data);
        saveData();
        io.emit('updateFiles', uploadedFiles);
        await int.reply({ content: '✅ File sent to Dashboard for approval!', ephemeral: true });
    }

    if (int.isButton()) {
        if (int.customId === 'create_ticket') {
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
                .setDescription(`Hello <@${int.user.id}>! I am the Velocity AI. **Why has this ticket been created today?**\n\nAsk me anything! If you need a human, click the button below.`)
                .setColor("#6366f1");

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('request_human').setLabel('Request Human Support').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Secondary)
            );

            await channel.send({ embeds: [embed], components: [row] });
            ticketConfig.activeTickets.push({ channelId: channel.id, userId: int.user.id, username: int.user.username, needsHuman: false });
            saveData();
            io.emit('ticketUpdate', { active: ticketConfig.activeTickets, transcripts: ticketConfig.transcripts });
            await int.reply({ content: `Ticket created: <#${channel.id}>`, ephemeral: true });
        }

        if (int.customId === 'request_human') {
            const ticket = ticketConfig.activeTickets.find(t => t.channelId === int.channelId);
            if (ticket) {
                ticket.needsHuman = true;
                saveData();
                io.emit('ticketUpdate', { active: ticketConfig.activeTickets, transcripts: ticketConfig.transcripts });
                await int.channel.send(`🚨 <@&${ticketConfig.staffRoleId}> **Human support needed here!**`);
                await int.reply({ content: "Staff notified via Dashboard.", ephemeral: true });
            }
        }

        if (int.customId === 'close_ticket') {
            const ticketIndex = ticketConfig.activeTickets.findIndex(t => t.channelId === int.channelId);
            if (ticketIndex !== -1) {
                const ticket = ticketConfig.activeTickets[ticketIndex];
                
                // Fetch messages for transcript
                const msgs = await int.channel.messages.fetch({ limit: 100 });
                const transcriptText = msgs.reverse().map(m => `[${m.createdAt.toLocaleTimeString()}] ${m.author.tag}: ${m.content || (m.embeds.length ? '[Embed Message]' : '')}`).join('\n');
                
                // Save Transcript
                ticketConfig.transcripts.unshift({ id: Date.now(), user: ticket.username, text: transcriptText, date: new Date().toLocaleDateString() });
                ticketConfig.activeTickets.splice(ticketIndex, 1);
                saveData();
                
                io.emit('ticketUpdate', { active: ticketConfig.activeTickets, transcripts: ticketConfig.transcripts });
                
                await int.reply("Saving transcript and closing ticket...");
                setTimeout(() => int.channel.delete().catch(()=>console.log("Channel already deleted")), 3000);
            }
        }
    }
});

// --- AI TICKET CHAT & LIVE LOGS ---
client.on('messageCreate', async (m) => {
    if (m.author.bot) return;

    const ticket = ticketConfig.activeTickets.find(t => t.channelId === m.channelId);
    if (ticket && !ticket.needsHuman) {
        m.channel.sendTyping();
        setTimeout(() => {
            m.reply(`[Velocity AI]: I've received your message regarding: "${m.content}". I'm looking into that for you. If you still need help from staff, please use the button above.`);
        }, 1500);
    }

    io.emit('discordMessage', { 
        author: m.author.username, content: m.content, channel: m.channel.name, channelId: m.channel.id, 
        time: m.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
    });
});

// --- DASHBOARD SOCKETS ---
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
            tickets: { active: ticketConfig.activeTickets, transcripts: ticketConfig.transcripts },
            config: { staffRole: ticketConfig.staffRoleId }
        });
    });

    socket.on('fileAction', (d) => {
        const file = uploadedFiles.find(f => f.id === d.id);
        if (file) { file.status = d.status; saveData(); io.emit('updateFiles', uploadedFiles); }
    });

    socket.on('moderation', async (d) => {
        const guild = client.guilds.cache.first();
        try {
            const member = await guild.members.fetch(d.userId);
            const channel = await guild.channels.fetch(d.channelId);
            switch(d.type) {
                case 'warn': await member.send(`⚠️ **Warned in ${guild.name}:** ${d.reason}`).catch(()=>{}); await channel.send(`⚠️ **WARN:** <@${d.userId}> | ${d.reason}`); break;
                case 'kick': await member.kick(d.reason); break;
                case 'ban': await member.ban({ reason: d.reason }); break;
                case 'timeout': await member.timeout(d.time * 60000, d.reason); break;
                case 'lock': await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }); break;
                case 'unlock': await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true }); break;
                case 'slowmode': await channel.setRateLimitPerUser(parseInt(d.slow || 0)); break;
                case 'move': if(member.voice.channel) await member.voice.setChannel(d.vcId); break;
                case 'disconnect': if(member.voice.channel) await member.voice.disconnect(); break;
                case 'mute': if(member.voice.channel) await member.voice.setMute(!member.voice.mute); break;
            }
        } catch (e) { console.error("Mod Error:", e); }
    });

    socket.on('setupTickets', async (d) => {
        ticketConfig.channelId = d.channelId;
        ticketConfig.staffRoleId = d.roleId;
        saveData();
        const channel = await client.channels.fetch(d.channelId);
        const embed = new EmbedBuilder().setTitle("Support Center").setDescription("Need assistance? Click the button below to start a conversation with our AI.").setColor("#6366f1");
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('create_ticket').setLabel('Create Ticket').setStyle(ButtonStyle.Primary));
        await channel.send({ embeds: [embed], components: [row] });
    });

    socket.on('sendMessage', async (d) => {
        const ch = await client.channels.fetch(d.channelId);
        if (ch) ch.send(d.content);
    });

    socket.on('fetchHistory', async (id) => {
        const ch = await client.channels.fetch(id);
        if (!ch || !ch.isTextBased()) return;
        const msgs = await ch.messages.fetch({ limit: 50 });
        socket.emit('historyData', msgs.map(m => ({
            author: m.author.username, content: m.content, channel: ch.name, channelId: ch.id, time: m.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        })).reverse());
    });
});

client.login(process.env.TOKEN);
server.listen(process.env.PORT || 3000, '0.0.0.0');
