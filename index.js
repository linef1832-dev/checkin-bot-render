const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { Client, GatewayIntentBits, ChannelType, EmbedBuilder } = require('discord.js');
const express = require('express');
const fs = require('fs');
// --- ตั้งค่าเชื่อมต่อ Supabase ---
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
// ------------------------------

const app = express();

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1442466109503569992'; 

const PORT = 3000;
const DATA_FILE = 'bot_timer_data.json';
const LEAVE_FILE = 'leaves.json'; 

let dataStore = {
    checkinChannels: [],
    lastCheckinDates: {} 
};

let activeSessions = new Map(); 

if (fs.existsSync(DATA_FILE)) {
    try { 
        const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        dataStore.checkinChannels = loaded.checkinChannels || [];
        dataStore.lastCheckinDates = loaded.lastCheckinDates || {};
    } catch (e) { console.error("Load Data Error:", e); }
}

function saveData() { 
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataStore, null, 2), 'utf8'); 
    } catch (e) { console.error("Save Data Error:", e); }
}

// 🆕 ฟังก์ชันดึงวันที่แบบไทย (GMT+7) เพื่อป้องกันเซิร์ฟเวอร์เวลาเพี้ยน
function getThaiDate() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const localTime = new Date(utc + (3600000 * 7)); 
    return `${localTime.getDate()}/${localTime.getMonth() + 1}/${localTime.getFullYear() + 543}`;
}

function getLeavesToday(dateStr, department = 'ALL') {
    let targetFile = LEAVE_FILE;
    const possibleNames = [LEAVE_FILE, 'Leaves.json', 'leaves.json.txt', 'Leaves.json.txt'];
    for (const name of possibleNames) {
        if (fs.existsSync(name)) { targetFile = name; break; }
    }
    if (!fs.existsSync(targetFile)) return [];
    try {
        const rawData = fs.readFileSync(targetFile, 'utf8');
        if (!rawData.trim()) return [];
        const allLeaves = JSON.parse(rawData);
        const todayData = allLeaves[dateStr];

        if (!todayData) return [];

        let leaves = [];
        const shifts = ['morning', 'night'];

        shifts.forEach(shift => {
            if (todayData[shift]) {
                if ((department === 'AMOL' || department === 'ALL') && Array.isArray(todayData[shift].AMOL)) {
                    leaves.push(...todayData[shift].AMOL);
                }
                if ((department === 'ODOL' || department === 'ALL') && Array.isArray(todayData[shift].ODOL)) {
                    leaves.push(...todayData[shift].ODOL);
                }
            }
        });
        return leaves.map(n => n.toString().trim());
    } catch (e) { 
        console.error("Parse JSON Error:", e);
        return []; 
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildVoiceStates, 
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ]
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const channelId = message.channel.id;

    if (message.content === '!resettest') {
        delete dataStore.lastCheckinDates[channelId];
        activeSessions.delete(channelId);
        saveData();
        return message.reply(`🔄 **รีเซ็ตระบบสำหรับห้องนี้เรียบร้อย!** เริ่มทดสอบใหม่ได้เลยค่ะ`);
    }

    if (message.content === '!checkleave') {
        const todayStr = getThaiDate(); // ใช้เวลาไทย

        let department = "ALL";
        if (message.channel.name.toUpperCase().includes('ODOL')) department = "ODOL";
        else if (message.channel.name.toUpperCase().includes('AMOL') || message.channel.name.includes('เช็คชื่อก่อนเข้างาน')) department = "AMOL";

        const leaves = getLeavesToday(todayStr, department);
        let msg = `🔎 **ผลการตรวจสอบไฟล์คนลา (วันที่ ${todayStr})**\n`;
        msg += `🏢 **แผนกที่ตรวจจับได้จากห้องนี้:** ${department === 'ALL' ? 'ทั้งหมด' : department}\n`;

        if (leaves.length > 0) {
            msg += `✅ พบรายชื่อคนหยุด ${leaves.length} ท่าน:\n` + leaves.map((n, i) => `${i + 1}. ${n}`).join('\n');
        } else {
            msg += `⚠️ ไม่พบรายชื่อพนักงานหยุดของแผนกนี้ในวันนี้ค่ะ`;
        }
        return message.reply(msg);
    }

    if (message.content === '!addchannel') {
        if (dataStore.checkinChannels.includes(channelId)) {
            return message.reply('⚠️ ห้องนี้ตั้งค่าเป็นจุดเช็คชื่อไว้แล้วค่ะ');
        }
        dataStore.checkinChannels.push(channelId);
        saveData();
        return message.reply(`✅ ตั้งค่าห้อง <#${channelId}> เป็นจุดเช็คชื่อเรียบร้อยแล้วค่ะ`);
    }

    if (message.content === '!startcheckin') {
        if (!dataStore.checkinChannels.includes(channelId)) {
            return message.reply('❌ ห้องนี้ยังไม่ได้เป็นห้องเช็คชื่อ (พิมพ์ `!addchannel` ในห้องนี้ก่อนค่ะ)');
        }

        const now = new Date();
        const todayStr = getThaiDate(); // ใช้เวลาไทย

        if (activeSessions.has(channelId)) {
            return message.reply('⚠️ ระบบเช็คชื่อของห้องนี้กำลังทำงานอยู่แล้วค่ะ');
        }

        if (dataStore.lastCheckinDates[channelId] === todayStr) {
            return message.reply(`❌ ห้องนี้สรุปยอดของวันนี้ (${todayStr}) ไปเรียบร้อยแล้วค่ะ`);
        }

        let sessionDept = "ALL";
        const chName = message.channel.name.toUpperCase();
        if (chName.includes('ODOL')) {
            sessionDept = "ODOL";
        } else if (chName.includes('AMOL') || chName.includes('เช็คชื่อก่อนเข้างาน')) {
            sessionDept = "AMOL";
        }

        activeSessions.set(channelId, {
            members: [],
            startTime: now,
            adminChannel: message.channel,
            department: sessionDept, 
            jsonError: null
        });

        dataStore.lastCheckinDates[channelId] = todayStr;
        saveData();

        const startEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle(`🔔 เริ่มเช็คชื่อพนักงาน แผนก: ${sessionDept === 'ALL' ? message.channel.name : sessionDept}`)
            .setDescription(`📅 **ประจำวันที่:** ${todayStr}\n\n📢 **กติกา:**\n1. ต้องอยู่ในห้องเสียง\n2. ต้องแชร์หน้าจอ\n3. พิมพ์ \`!checkin\` ในห้องนี้\n\n⏱️ **ระบบจะเปิดเพียง 10 นาทีเท่านั้น!**`)
            .setTimestamp();

        message.channel.send({ embeds: [startEmbed] });
        startSummaryTimer(channelId);
        return;
    }

    if (message.content === '!checkin') {
        if (!dataStore.checkinChannels.includes(channelId)) return;

        const session = activeSessions.get(channelId);
        if (!session) {
            return message.reply('❌ **ขณะนี้ระบบปิดรับเช็คชื่อสำหรับห้องนี้แล้วค่ะ** (หรือยังไม่ได้เริ่มเปิดระบบของวันนี้)');
        }

        const member = message.member;
        if (!member.voice.channelId || !member.voice.streaming) {
            return message.reply('❌ คุณต้องเข้าห้องเสียงและแชร์หน้าจอด้วยค่ะ');
        }

        if (session.members.some(m => m.id === member.id)) return message.reply('✅ คุณได้เช็คชื่อไปแล้วค่ะ');

        const statusMsg = await message.reply('⏳ กำลังตรวจสอบ 10 วินาที...');
        setTimeout(async () => {
            try {
                if (member.voice.streaming) {
                    const now = new Date();
                    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
                    const localTime = new Date(utc + (3600000 * 7)); 
                    const currentHour = localTime.getHours();

                    let shiftName = (currentHour >= 8 && currentHour < 20) ? "กะเช้า ☀️" : "กะดึก 🌙";

                    session.members.push({ 
                        id: member.id, 
                        name: member.displayName, 
                        time: localTime,
                        shift: shiftName 
                    });

                    try {
                        const { error } = await supabase
                            .from('checkins') 
                            .insert([{ discord_id: member.id, name: member.displayName, checkin_time: localTime, shift: shiftName }]);
                        if (error) console.error("❌ Supabase Error:", error);
                    } catch (err) { console.error("❌ Database Connection Failed:", err); }

                    statusMsg.edit(`✅ **เช็คชื่อสำเร็จ!** คุณอยู่ **${shiftName}** (ลำดับที่ ${session.members.length})`);
                } else {
                    statusMsg.edit('❌ เช็คชื่อล้มเหลว: ปิดแชร์หน้าจอก่อนเวลาค่ะ');
                }
            } catch (err) { console.error(err); }
        }, 10000);
    }
});

async function sendLongMessage(channel, content) {
    if (!content) return;
    if (content.length <= 2000) return await channel.send(content).catch(e => console.error(e));

    const lines = content.split('\n');
    let currentMessage = '';

    for (const line of lines) {
        if (currentMessage.length + line.length + 1 > 1900) {
            await channel.send(currentMessage).catch(e => console.error(e));
            currentMessage = ''; 
        }
        currentMessage += line + '\n'; 
    }
    if (currentMessage.trim().length > 0) await channel.send(currentMessage).catch(e => console.error(e));
}

function startSummaryTimer(channelId) {
    // 600000 = 10 นาที
    setTimeout(async () => {
        const session = activeSessions.get(channelId);
        if (!session) return;

        try {
            const dateTh = getThaiDate(); // ใช้เวลาไทย
            const checkedIds = new Set(session.members.map(m => m.id));

            const leaveNames = getLeavesToday(dateTh, session.department); 

            const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
            const tChannel = await client.channels.fetch(channelId).catch(() => null);

            if (guild && tChannel) {
                let summary = `📊 **สรุปรายชื่อพนักงาน แผนก: ${session.department === 'ALL' ? tChannel.name : session.department}**\n📅 วันที่: ${dateTh}\n──────────────────────────\n`;

                summary += `✅ **เช็คชื่อสำเร็จ:**\n`;
                if (session.members.length > 0) {
                    const morningShift = session.members.filter(m => m.shift.includes("กะเช้า"));
                    const nightShift = session.members.filter(m => m.shift.includes("กะดึก"));

                    if (morningShift.length > 0) {
                        summary += `\n☀️ **กะเช้า:**\n`;
                        morningShift.forEach((m, i) => {
                            const HH = m.time.getHours().toString().padStart(2, '0');
                            const MM = m.time.getMinutes().toString().padStart(2, '0');
                            summary += `   ${i + 1}. **${m.name}** (เวลา ${HH}:${MM} น.)\n`;
                        });
                    }

                    if (nightShift.length > 0) {
                        summary += `\n🌙 **กะดึก:**\n`;
                        nightShift.forEach((m, i) => {
                            const HH = m.time.getHours().toString().padStart(2, '0');
                            const MM = m.time.getMinutes().toString().padStart(2, '0');
                            summary += `   ${i + 1}. **${m.name}** (เวลา ${HH}:${MM} น.)\n`;
                        });
                    }
                } else { summary += `- ไม่มี -\n`; }

                summary += `\n😴 **รายชื่อที่หยุดงาน:**\n`;
                if (leaveNames.length > 0) {
                    leaveNames.forEach((name, i) => summary += `${i + 1}. **${name}**\n`);
                } else { summary += `- ไม่มี -\n`; }

                let missingMembers = [];
                const departmentVoiceRooms = new Set();
                session.members.forEach(m => {
                    const vs = guild.voiceStates.cache.get(m.id);
                    if (vs?.channelId) departmentVoiceRooms.add(vs.channelId);
                });

                departmentVoiceRooms.forEach(vId => {
                    const vRoom = guild.channels.cache.get(vId);
                    if (vRoom) {
                        vRoom.members.forEach(member => {
                            const cleanName = member.displayName.trim().toUpperCase();

                            // 🧠 อัปเกรด: เช็คว่าชื่อใน Discord มีคำที่ตรงกับชื่อในไฟล์ JSON ไหม
                            let isLeave = false;
                            for (const lName of leaveNames) {
                                if (cleanName.includes(lName.toUpperCase())) {
                                    isLeave = true;
                                    break;
                                }
                            }

                            let isSameDepartment = true;
                            if (session.department !== "ALL") {
                                isSameDepartment = member.roles.cache.some(r => r.name.includes(session.department));
                            }

                            // ถ้าไม่ได้เป็นบอท + ไม่ได้เช็คชื่อ + ไม่ใช่วันหยุด + อยู่แผนกเดียวกัน = ถือว่าลืมเช็คชื่อ!
                            if (!member.user.bot && !checkedIds.has(member.id) && !isLeave && isSameDepartment) {
                                missingMembers.push({ name: member.displayName, vName: vRoom.name });
                            }
                        });
                    }
                });

                if (missingMembers.length > 0) {
                    summary += `\n🔴 **ลืมเช็คชื่อ (พบในกลุ่มห้องเสียงเดียวกัน):**\n`;
                    missingMembers.forEach((m, i) => {
                        summary += `${i + 1}. **${m.name}** (อยู่ในห้อง: ${m.vName})\n`;
                    });
                }

                summary += `──────────────────────────\n`;
                summary += `**รวมทั้งสิ้น: ${session.members.length} ท่าน**\n`;

                await sendLongMessage(tChannel, summary);
            }
        } catch (err) { console.error(err); } finally {
            activeSessions.delete(channelId); 
            const tChannel = await client.channels.fetch(channelId).catch(() => null);
            if (tChannel) tChannel.send(`🏁 **จบการสรุปผล แผนก: ${session.department} เรียบร้อยแล้วค่ะ**`);
        }
    }, 60000); 
}

app.listen(process.env.PORT || 3000, () => { console.log(`🌐 Server web port is open and listening for Render!`); });

client.once('ready', () => { console.log(`🚀 บอทพร้อม! ล็อกอินในชื่อ ${client.user.tag}`); });

client.login(TOKEN).catch(error => { console.error("❌ ล็อกอินล้มเหลว โปรดตรวจสอบ TOKEN อีกครั้ง:", error); });