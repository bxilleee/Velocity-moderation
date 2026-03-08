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

// --- PERMANENT STORAGE ---
const FILES_DB = './files.json';
const TICKETS_DB = './tickets.json';

let uploadedFiles = [];
let ticketConfig = { channelId: null, staffRoleId: null, activeTickets: [], transcripts: [] };

if (fs.existsSync(FILES_DB)) uploadedFiles = JSON.parse(fs.readFileSync(FILES_DB, 'utf8'));
if (fs.existsSync(TICKETS_DB)) {
    const loaded = JSON.parse(fs.readFileSync(TICKETS_DB, 'utf8'));
    ticketConfig = { ...ticketConfig, ...loaded };
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
    console.log(`Velocity AI-Support Online | User: ${client.user.tag}`);
});

// --- INTERACTION HANDLING (TICKETS & UPLOADS) ---
client.on('interactionCreate', async (int) => {
    if (int.isChatInputCommand() && int.commandName === 'upload') {
        const file = int.options.getAttachment('file');
        const data = { id: Date.now(), name: file.name, url: file.url, uploader: int.user.tag, status: 'pending', time: new Date().toLocaleTimeString() };
        uploadedFiles.unshift(data);
        saveData();
        io.emit('updateFiles', uploadedFiles);
        await int.reply({ content: '✅ File sent to Dashboard!', ephemeral: true });
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
                .setDescription(`Hello <@${int.user.id}>! I am the Velocity AI. **Why has this ticket been created today?**\n\nI can check permissions or answer questions. If you need a human, click below.`)
                .setColor("#6366f1")
                .setFooter({ text: "Velocity Intelligent Analysis" });

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
                await int.channel.send(`🚨 <@&${ticketConfig.staffRoleId}> **A user has requested human intervention.**`);
                await int.reply({ content: "Staff notified.", ephemeral: true });
            }
        }

        if (int.customId === 'close_ticket') {
            const ticketIndex = ticketConfig.activeTickets.findIndex(t => t.channelId === int.channelId);
            if (ticketIndex !== -1) {
                const ticket = ticketConfig.activeTickets[ticketIndex];
                const msgs = await int.channel.messages.fetch({ limit: 100 });
                const transcriptText = msgs.reverse().map(m => `[${m.createdAt.toLocaleTimeString()}] ${m.author.tag}: ${m.content}`).join('\n');
                
                ticketConfig.transcripts.unshift({ id: Date.now(), user: ticket.username, text: transcriptText, date: new Date().toLocaleDateString() });
                ticketConfig.activeTickets.splice(ticketIndex, 1);
                saveData();
                io.emit('ticketUpdate', { active: ticketConfig.activeTickets, transcripts: ticketConfig.transcripts });
                
                await int.reply("Closing ticket and saving transcript...");
                setTimeout(() => int.channel.delete().catch(() => {}), 3000);
            }
        }
    }
});

// --- AI ANALYTICS ENGINE & LIVE LOGS ---
client.on('messageCreate', async (m) => {
    if (m.author.bot) return;

    const ticket = ticketConfig.activeTickets.find(t => t.channelId === m.channelId);
    if (ticket && !ticket.needsHuman) {
        m.channel.sendTyping();
        
        setTimeout(async () => {
            const input = m.content.toLowerCase();
            const member = await m.guild.members.fetch(m.author.id);
            let aiResponse = "I'm processing that. Could you describe the issue in more detail? I can check your permissions for specific channels if you mention them.";

            // ANALYSIS: View Permissions
            if (input.includes("see") || input.includes("view") || input.includes("hidden") || input.includes("access")) {
                let target = m.mentions.channels.first();
                if (!target) {
                    const words = input.split(' ');
                    for(const w of words) {
                        const clean = w.replace('#','').replace(/[.,!?]/g, '');
                        const found = m.guild.channels.cache.find(c => c.name.toLowerCase() === clean);
                        if(found) { target = found; break; }
                    }
                }

                if (target) {
                    const perms = target.permissionsFor(member);
                    if (!perms.has('ViewChannel')) {
                        aiResponse = `[Analysis]: You cannot see <#${target.id}> because you lack the **View Channel** permission. You likely need a specific role. I have flagged this for staff review.`;
                    } else {
                        aiResponse = `[Analysis]: You **do** have permission to see <#${target.id}>. If it's missing, try refreshing Discord (CTRL+R) or checking if the channel is muted/collapsed.`;
                    }
                } else {
                    aiResponse = "It sounds like you can't see a channel. Please **#mention** the channel or type its exact name so I can check your permissions.";
                }
            }

            // ANALYSIS: Chat/Message Permissions
            else if (input.includes("chat") || input.includes("send") || input.includes("talk") || input.includes("message") || input.includes("mute")) {
                const perms = m.channel.permissionsFor(member);
                if (member.communicationDisabledUntilTimestamp > Date.now()) {
                    const timeRemaining = Math.round((member.communicationDisabledUntilTimestamp - Date.now()) / 60000);
                    aiResponse = `[Analysis]: You are currently **Timed Out**. You will be able to speak again in approximately **${timeRemaining} minutes**.`;
                } else if (!perms.has('SendMessages')) {
                    aiResponse = `[Analysis]: You are unable to send messages here because you lack the **Send Messages** permission in this channel. This is likely due to a server-wide mute role or specific channel lock.`;
                } else {
                    aiResponse = `[Analysis]: Your permissions for this channel are active. You should be able to chat. If you can't, check if you're in a specific "Muted" role.`;
                }
            }

            await m.reply(`**Velocity AI Analyst**\n${aiResponse}`);
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
        } catch (e) { console.error("Mod Action Error:", e); }
    });

    socket.on('setupTickets', async (d) => {
        ticketConfig.channelId = d.channelId;
        ticketConfig.staffRoleId = d.roleId;
        saveData();
        const channel = await client.channels.fetch(d.channelId);
        const embed = new EmbedBuilder().setTitle("Support Center").setDescription("Need assistance? Click the button below to start a conversation with our AI Analyst.").setColor("#6366f1");
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
