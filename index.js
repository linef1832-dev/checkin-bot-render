const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { Client, GatewayIntentBits, ChannelType, EmbedBuilder } = require('discord.js');
const express = require('express');
const fs = require('fs');

const app = express();

// ==========================================
// 🚨🚨🚨 การตั้งค่า (CONFIG) 🚨🚨🚨
// ==========================================
const TOKEN = process.env.TOKEN;
const GUILD_ID = '1442466109503569992'; 

const PORT = 3000;
const DATA_FILE = 'bot_timer_data.json';
const LEAVE_FILE = 'leaves.json'; 

// ==========================================
// 💾 Data Store
// ==========================================
let dataStore = {
    checkinChannels: [],
    lastCheckinDates: {} // เก็บวันที่เช็คชื่อล่าสุดแยกตาม ID ห้อง { "channelId": "17/3/2569" }
};

// ✅ ระบบจัดการ Session แบบแยกห้องอิสระ (Map)
let activeSessions = new Map(); // Key: channelId, Value: { members: [], startTime: Date, adminChannel: channel }

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

function getLeavesToday(dateStr) {
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
        const leaves = allLeaves[dateStr] || [];
        return Array.isArray(leaves) ? leaves.map(n => n.toString().trim()) : [];
    } catch (e) { return []; }
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

// ---------------------------------------------------------
// 🛠️ 1. ระบบจัดการคำสั่ง
// ---------------------------------------------------------
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const channelId = message.channel.id;

    // --- คำสั่งรีเซ็ตเฉพาะห้องนี้เพื่อทดสอบ ---
    if (message.content === '!resettest') {
        delete dataStore.lastCheckinDates[channelId];
        activeSessions.delete(channelId);
        saveData();
        return message.reply(`🔄 **รีเซ็ตระบบสำหรับห้องนี้เรียบร้อย!** เริ่มทดสอบใหม่ได้เลยค่ะ`);
    }

    // --- คำสั่งตรวจสอบไฟล์คนลา ---
    if (message.content === '!checkleave') {
        const now = new Date();
        const todayStr = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear() + 543}`;
        const leaves = getLeavesToday(todayStr);
        let msg = `🔎 **ผลการตรวจสอบไฟล์คนลา (วันที่ ${todayStr}):**\n`;
        if (leaves.length > 0) {
            msg += `✅ พบรายชื่อคนหยุด ${leaves.length} ท่าน:\n` + leaves.map((n, i) => `${i + 1}. ${n}`).join('\n');
        } else {
            msg += `⚠️ ไม่พบรายชื่อของวันนี้ในไฟล์ (ตรวจสอบว่าวันที่ตรงกับ "${todayStr}")`;
        }
        return message.reply(msg);
    }

    // --- คำสั่งเพิ่มห้องเช็คชื่อ (รายแผนก) ---
    if (message.content === '!addchannel') {
        if (dataStore.checkinChannels.includes(channelId)) {
            return message.reply('⚠️ ห้องนี้ตั้งค่าเป็นจุดเช็คชื่อไว้แล้วค่ะ');
        }
        dataStore.checkinChannels.push(channelId);
        saveData();
        return message.reply(`✅ ตั้งค่าห้อง <#${channelId}> เป็นจุดเช็คชื่อแผนกเรียบร้อยแล้วค่ะ`);
    }

    // --- เริ่มเปิดระบบเช็คชื่อ (แยกอิสระรายแผนก) ---
    if (message.content === '!startcheckin') {
        if (!dataStore.checkinChannels.includes(channelId)) {
            return message.reply('❌ ห้องนี้ยังไม่ได้เป็นห้องเช็คชื่อ (พิมพ์ `!addchannel` ในห้องนี้ก่อนค่ะ)');
        }

        const now = new Date();
        const todayStr = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear() + 543}`;

        // ตรวจสอบเฉพาะ Session ของห้องนี้เท่านั้น
        if (activeSessions.has(channelId)) {
            return message.reply('⚠️ ระบบเช็คชื่อของแผนกนี้กำลังทำงานอยู่แล้วค่ะ');
        }

        if (dataStore.lastCheckinDates[channelId] === todayStr) {
            return message.reply(`❌ แผนกนี้สรุปยอดของวันนี้ (${todayStr}) ไปเรียบร้อยแล้วค่ะ`);
        }

        // สร้าง Session ใหม่เฉพาะห้องนี้
        activeSessions.set(channelId, {
            members: [],
            startTime: now,
            adminChannel: message.channel,
            jsonError: null
        });

        dataStore.lastCheckinDates[channelId] = todayStr;
        saveData();

        const startEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle(`🔔 เริ่มเช็คชื่อพนักงาน แผนก: ${message.channel.name}`)
            .setDescription(`📅 **ประจำวันที่:** ${todayStr}\n\n📢 **กติกา:**\n1. ต้องอยู่ในห้องเสียง\n2. ต้องแชร์หน้าจอ\n3. พิมพ์ \`!checkin\` ในห้องนี้\n\n⏱️ **ระบบจะเปิดเพียง 10 นาทีเท่านั้น!**`)
            .setTimestamp();

        message.channel.send({ embeds: [startEmbed] });
        startSummaryTimer(channelId);
        return;
    }

    // --- คำสั่งเช็คชื่อ ---
    if (message.content === '!checkin') {
        // ✅ ตรวจสอบว่าเป็นห้องที่อนุญาตให้เช็คชื่อหรือไม่
        if (!dataStore.checkinChannels.includes(channelId)) return;

        const session = activeSessions.get(channelId);
        
        // ✅ หากไม่มี Session ที่กำลังทำงาน (หมดเวลาแล้วหรือยังไม่เริ่ม) ให้แจ้งเตือนผู้ใช้
        if (!session) {
            return message.reply('❌ **ขณะนี้ระบบปิดรับเช็คชื่อสำหรับแผนกนี้แล้วค่ะ** (หรือยังไม่ได้เริ่มเปิดระบบของวันนี้)');
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
                    // --- ⏰ เครื่องจับเวลาและแยกกะอัตโนมัติ ---
                    const now = new Date();
                    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
                    const localTime = new Date(utc + (3600000 * 7)); // เวลาไทย
                    const currentHour = localTime.getHours();
                    let shiftName = "";

                    // เงื่อนไข: กะเช้า 06:00 - 16:59 | กะดึก 17:00 - 05:59
                    if (currentHour >= 6 && currentHour < 17) {
                        shiftName = "กะเช้า ☀️";
                    } else {
                        shiftName = "กะดึก 🌙";
                    }
                    // ----------------------------------------

                    session.members.push({ 
                        id: member.id, 
                        name: member.displayName, 
                        localTime: localTime(),
                        shift: shiftName // <--- บันทึกกะลงในความจำบอท
                    });

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
    
    // ถ้ายาวไม่เกิน 2000 ส่งได้เลยรวดเดียวจบ
    if (content.length <= 2000) {
        return await channel.send(content).catch(e => console.error(e));
    }

    // ถ้ายาวเกิน ให้หั่นข้อความทีละบรรทัด (จะได้ไม่ตัดกลางชื่อคน)
    const lines = content.split('\n');
    let currentMessage = '';

    for (const line of lines) {
        // ถ้าเอาบรรทัดใหม่รวมกับก้อนปัจจุบัน แล้วยาวเกิน 1900 ตัวอักษร
        // ให้ส่งข้อความก้อนปัจจุบันออกไปก่อน แล้วค่อยเริ่มก้อนใหม่
        if (currentMessage.length + line.length + 1 > 1900) {
            await channel.send(currentMessage).catch(e => console.error(e));
            currentMessage = ''; // ล้างกล่องเพื่อเริ่มก้อนใหม่
        }
        currentMessage += line + '\n'; // เติมข้อความทีละบรรทัด
    }

    // ถ้ามีข้อความก้อนสุดท้ายเหลืออยู่ ให้ส่งออกไป
    if (currentMessage.trim().length > 0) {
        await channel.send(currentMessage).catch(e => console.error(e));
    }
}

function startSummaryTimer(channelId) {
    // ✅ เปลี่ยนเวลาเป็น 10 นาที (600,000 มิลลิวินาที)
    setTimeout(async () => {
        const session = activeSessions.get(channelId);
        if (!session) return;

        try {
            const now = new Date();
            const dateTh = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear() + 543}`;
            const checkedIds = new Set(session.members.map(m => m.id));
            const leaveNames = getLeavesToday(dateTh); 
            const leaveNamesSet = new Set(leaveNames.map(n => n.trim()));

            const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
            const tChannel = await client.channels.fetch(channelId).catch(() => null);
            
            if (guild && tChannel) {
                let summary = `📊 **สรุปรายชื่อพนักงาน แผนก: ${tChannel.name}**\n📅 วันที่: ${dateTh}\n──────────────────────────\n`;
                
                // 1. เช็คชื่อสำเร็จ (แยกตามกะ)
                summary += `✅ **เช็คชื่อสำเร็จ:**\n`;
                if (session.members.length > 0) {
                    // แยกกลุ่มคน
                    const morningShift = session.members.filter(m => m.shift.includes("กะเช้า"));
                    const nightShift = session.members.filter(m => m.shift.includes("กะดึก"));

                    // แสดงผลกะเช้า
                    if (morningShift.length > 0) {
                        summary += `\n☀️ **กะเช้า:**\n`;
                        morningShift.forEach((m, i) => {
                            const HH = m.time.getHours().toString().padStart(2, '0');
                            const MM = m.time.getMinutes().toString().padStart(2, '0');
                            summary += `   ${i + 1}. **${m.name}** (เวลา ${HH}:${MM} น.)\n`;
                        });
                    }

                    // แสดงผลกะดึก
                    if (nightShift.length > 0) {
                        summary += `\n🌙 **กะดึก:**\n`;
                        nightShift.forEach((m, i) => {
                            const HH = m.time.getHours().toString().padStart(2, '0');
                            const MM = m.time.getMinutes().toString().padStart(2, '0');
                            summary += `   ${i + 1}. **${m.name}** (เวลา ${HH}:${MM} น.)\n`;
                        });
                    }
                } else { 
                    summary += `- ไม่มี -\n`; 
                }

                // 2. คนหยุดงาน
                summary += `\n😴 **รายชื่อที่หยุดงาน:**\n`;
                if (leaveNames.length > 0) {
                    leaveNames.forEach((name, i) => summary += `${i + 1}. **${name}**\n`);
                } else { summary += `- ไม่มี -\n`; }

                // 3. คนออนไลน์แต่ลืมเช็คชื่อ
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
                            const cleanName = member.displayName.trim();
                            if (!member.user.bot && !checkedIds.has(member.id) && !leaveNamesSet.has(cleanName)) {
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
                
                // ✅ เพิ่มส่วนรวมยอดพนักงานที่เช็คชื่อสำเร็จทั้งหมด
                summary += `──────────────────────────\n`;
                summary += `**รวมทั้งสิ้น: ${session.members.length} ท่าน**\n`;
                
                await sendLongMessage(tChannel, summary);
            }
        } catch (err) { console.error(err); } finally {
            activeSessions.delete(channelId); 
            const tChannel = await client.channels.fetch(channelId).catch(() => null);
            if (tChannel) tChannel.send(`🏁 **จบการสรุปผลแผนก ${tChannel.name} เรียบร้อยแล้วค่ะ**`);
        }
    }, 60000); 
}

app.listen(process.env.PORT || 3000, () => {
    console.log(`🌐 Server web port is open and listening for Render!`);
});

// 🕵️‍♂️ เปิดโหมดนักสืบ: ให้บอทรายงานทุกการกระทำเบื้องหลัง
client.on('debug', console.log);

console.log("🕵️‍♂️ เช็คตู้เซฟ: ค่า TOKEN ตอนนี้ " + (TOKEN ? "✅ มีข้อมูลอยู่ในเซฟ" : "❌ ว่างเปล่า (หาไม่เจอ!)"));

client.once('ready', () => { 
    console.log(`🚀 บอทพร้อม! ล็อกอินในชื่อ ${client.user.tag}`); 
});

client.login(TOKEN).catch(error => {
    console.error("❌ ล็อกอินล้มเหลว โปรดตรวจสอบ TOKEN อีกครั้ง:", error);
});
