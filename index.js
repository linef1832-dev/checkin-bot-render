const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { Client, GatewayIntentBits, ChannelType, EmbedBuilder } = require('discord.js');
const express = require('express');
const fs = require('fs');
const cron = require('node-cron'); 

// --- ตั้งค่าเชื่อมต่อ Supabase (ตัวที่ 1: บันทึกเช็คชื่อ) ---
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
// ------------------------------

// --- ตั้งค่าเชื่อมต่อ Supabase (ตัวที่ 2: วันหยุด) ---
const supabaseLeaveUrl = process.env.SUPABASE_LEAVE_URL;
const supabaseLeaveKey = process.env.SUPABASE_LEAVE_KEY;
const supabaseLeave = (supabaseLeaveUrl && supabaseLeaveKey) ? createClient(supabaseLeaveUrl, supabaseLeaveKey) : null;
// ------------------------------

const app = express();
const path = require('path');
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); // อนุญาตให้ทุกเว็บส่งข้อมูลมาได้
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// รหัสผ่านสำหรับสั่งงานผ่านเว็บ (เปลี่ยนได้ตามต้องการ)
const WEB_ADMIN_PIN = "123456"; 

// --- 3. สร้าง API สำหรับคำสั่ง !autoon / !autooff ---
app.post('/api/autocheckin', (req, res) => {
    const { status, pin } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });

    dataStore.autoCheckinEnabled = (status === 'on');
    saveData();
    res.json({ success: true, message: `✅ ระบบเปิดเช็คชื่ออัตโนมัติ: ${status === 'on' ? 'เปิด' : 'ปิด'} เรียบร้อยแล้ว` });
});
// --- 4. สร้าง API สำหรับคำสั่ง !startcheckin ---
app.post('/api/startcheckin', async (req, res) => {
    const { channelId, pin, duration } = req.body;

    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });
    if (!dataStore.checkinChannels.includes(channelId)) return res.status(400).json({ success: false, message: '❌ ห้องนี้ยังไม่ได้เป็นห้องเช็คชื่อ (!addchannel ก่อน)' });

    const localTime = getThaiTime(); 
    const todayStr = getThaiDateStr(); 
    const currentHour = localTime.getHours();
    const shiftType = (currentHour >= 6 && currentHour < 18) ? "Morning" : "Night";
    const checkinKey = `${todayStr}-${shiftType}`;
    // กำหนดเวลาที่ใช้เช็คชื่อ
    const checkinDuration = parseInt(duration) || 10;

    if (activeSessions.has(channelId)) return res.status(400).json({ success: false, message: '⚠️ ระบบเช็คชื่อของห้องนี้กำลังทำงานอยู่แล้ว' });
    if (dataStore.lastCheckinDates[channelId] === checkinKey) return res.status(400).json({ success: false, message: '❌ ห้องนี้สรุปยอดของกะนี้ไปเรียบร้อยแล้ว' });

    try {
        const channel = await client.channels.fetch(channelId);
        let sessionDept = "ALL";
        const chName = channel.name.toUpperCase();
        if (chName.includes('ODOL')) sessionDept = "ODOL";
        else if (chName.includes('AMOL') || chName.includes('เช็คชื่อ')) sessionDept = "AMOL";

        activeSessions.set(channelId, {
            members: [],
            startTime: localTime,
            adminChannel: channel,
            department: sessionDept, 
            jsonError: null,
            shiftType: shiftType,
            duration: checkinDuration // 👈 เซฟระยะเวลาลงใน Session
        });

        dataStore.lastCheckinDates[channelId] = checkinKey;
        saveData();

        const startEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle(`🔔 เริ่มเช็คชื่อพนักงาน แผนก: ${sessionDept === 'ALL' ? channel.name : sessionDept} (สั่งจาก Web)`)
            .setDescription(`📅 **ประจำวันที่:** ${todayStr}\n⏰ **รอบเวลา:** ${currentTimeStr} น. (${shiftLabel})\n\n📢 **กติกา:**\n1. ต้องอยู่ในห้องเสียง\n2. ต้องแชร์หน้าจอ\n3. พิมพ์ \`!checkin\` ในห้องนี้\n\n⏱️ **เปิดรับเช็คชื่อถึงเวลา: ${currentSlot.endTime || "ไม่ได้ระบุ"} น.** (${checkinDuration} นาที)`)
            .setTimestamp();

        await channel.send({ embeds: [startEmbed] });
        startSummaryTimer(channelId);

        res.json({ success: true, message: `✅ สั่งเปิดระบบห้อง ${channel.name} เป็นเวลา ${checkinDuration} นาที สำเร็จ!` });
    } catch (error) { res.status(500).json({ success: false, message: '❌ Error' }); }
});
    // --- 5. API สำหรับดึงรายชื่อพนักงานมาแสดง ---
    app.get('/api/getstaff', (req, res) => {
        try {
            if (fs.existsSync('./staff.json')) {
                const staffData = JSON.parse(fs.readFileSync('./staff.json', 'utf8'));
                res.json({ success: true, data: staffData });
            } else {
                res.json({ success: true, data: {} });
            }
        } catch (error) {
            res.status(500).json({ success: false, message: '❌ ไม่สามารถอ่านไฟล์ staff.json ได้' });
        }
        // --- 7. API สำหรับตั้งเวลา Auto Checkin (แบบกำหนดเวลาแต่ละรอบได้) ---
        app.post('/api/setautotime', (req, res) => {
            const { pin, times } = req.body;
            if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });

            if (times) {
                dataStore.autoCheckinTimes = times; 
                saveData();
                return res.json({ success: true, message: `✅ บันทึกตั้งค่าสำเร็จ! (บอทจะทำงานทั้งหมด ${times.length} รอบ)` });
            }
            res.status(400).json({ success: false, message: '❌ ข้อมูลไม่ครบถ้วน' });
        });

        // --- 8. API สำหรับให้เว็บดึงการตั้งค่าปัจจุบันไปแสดง ---
        app.get('/api/getconfig', (req, res) => {
            res.json({ 
                success: true, 
                autoCheckinEnabled: dataStore.autoCheckinEnabled, 
                autoCheckinTimes: dataStore.autoCheckinTimes
            });
        });
    });

// --- 9. API รับข้อมูลจับคนอู้จาก Chrome Extension (LINE OA Tracker) ---
app.post('/api/ping-active', async (req, res) => {
    const { sessionProfile, msgCount } = req.body;

    if (!sessionProfile) {
        return res.status(400).json({ success: false, message: 'ไม่พบชื่อพนักงาน' });
    }

    const chats = msgCount || 0;

    try {
        // 🟢 แก้บัคไทม์แมชชีน: ใช้เวลาสากล (UTC) แท้ๆ ส่งให้ฐานข้อมูล
        const localTime = new Date().toISOString(); 

        console.log(`[Tracker] ได้รับสัญญาณ: ${sessionProfile} กำลังทำงาน! (ตอบแชท: ${chats} ข้อความ 💬)`);

        const { error } = await supabase
            .from('line_activity')
            .insert([
                {
                    staff_name: sessionProfile,
                    status: 'Online',
                    last_active: localTime,
                    message_count: chats 
                }
            ]);

        if (error) {
            console.error('[Tracker] Error inserting data:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('[Tracker] Server error:', err);
        return res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

// --- 10. API ดึงข้อมูลสายลับ LINE OA มาโชว์ที่หน้าแผงควบคุม ---
app.get('/api/get-tracker', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('line_activity')
            .select('*')
            .order('last_active', { ascending: false }); // เรียงจากคลิกล่าสุดขึ้นก่อน

        if (error) throw error;
        res.json({ success: true, data: data });
    } catch (err) {
        console.error("❌ ดึงข้อมูล Tracker พลาด:", err);
        res.status(500).json({ success: false });
    }
});

// --- 11. API ดูประวัติการอู้และดึงหมายเหตุ ---
app.post('/api/tracker-history', async (req, res) => {
    const { date } = req.body;
    try {
        const startOfDay = new Date(`${date}T00:00:00+07:00`).toISOString();
        const endOfDay = new Date(`${date}T23:59:59+07:00`).toISOString();

        const { data: pings } = await supabase
            .from('line_activity')
            .select('*')
            .gte('last_active', startOfDay)
            .lte('last_active', endOfDay)
            .order('last_active', { ascending: true });

        const { data: remarks } = await supabase
            .from('tracker_remarks')
            .select('*')
            .eq('afk_date', date);

        res.json({ success: true, pings: pings || [], remarks: remarks || [] });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// --- 12. API บันทึกหมายเหตุการอู้ ---
app.post('/api/save-remark', async (req, res) => {
    const { staff_name, afk_date, start_time, end_time, remark, pin } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });

    try {
        await supabase.from('tracker_remarks').delete().match({ staff_name, start_time });
        if (remark && remark.trim() !== '') {
            await supabase.from('tracker_remarks').insert([{ staff_name, afk_date, start_time, end_time, remark }]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// --- 6. API สำหรับ เพิ่ม/ลบ/แก้ไขพนักงาน ---
app.post('/api/updatestaff', async (req, res) => {
    // เพิ่ม newName มาจาก body ด้วย
    const { pin, action, dept, shift, discordId, staffName, newName } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });

    try {
        let staffData = {};
        if (fs.existsSync('./staff.json')) {
            staffData = JSON.parse(fs.readFileSync('./staff.json', 'utf8'));
        }

        if (action === 'add') {
            if (!staffData[dept]) staffData[dept] = { morning: {}, night: {} };
            if (!staffData[dept][shift]) staffData[dept][shift] = {};

            // ลบชื่อเก่าออกก่อน (กันกรณีคนนี้เคยอยู่กะอื่น จะได้ไม่ซ้ำ)
            for (const d in staffData) {
                for (const s in staffData[d]) {
                    if (staffData[d][s] && staffData[d][s][discordId]) {
                        delete staffData[d][s][discordId];
                    }
                }
            }
            // เพิ่มชื่อใหม่เข้าไป
            staffData[dept][shift][discordId] = staffName;

        } else if (action === 'edit_name') {
            // ค้นหาพนักงานตาม Discord ID และแก้ชื่อ
            let found = false;
            for (const d in staffData) {
                for (const s in staffData[d]) {
                    if (staffData[d][s] && staffData[d][s][discordId]) {
                        staffData[d][s][discordId] = newName;
                        found = true;
                        break;
                    }
                }
                if (found) break;
            }
            if (!found) {
                return res.status(404).json({ success: false, message: '❌ ไม่พบรายชื่อพนักงาน' });
            }
        } else if (action === 'remove') {
            // ค้นหาและลบพนักงานตาม Discord ID
            for (const d in staffData) {
                for (const s in staffData[d]) {
                    if (staffData[d][s] && staffData[d][s][discordId]) {
                        delete staffData[d][s][discordId];
                    }
                }
            }
        }

        // เซฟลงไฟล์ และสั่งซิงค์ขึ้น GitHub
        fs.writeFileSync('./staff.json', JSON.stringify(staffData, null, 2), 'utf8');
        syncToGitHub(staffData); // เรียกใช้ฟังก์ชันที่คุณเขียนไว้แล้ว

        // แก้ไขข้อความตอบกลับตามการกระทำต่างๆ
        let msg = action === 'add' ? `✅ บันทึกพนักงาน ${staffName} สำเร็จ!` : (action === 'edit_name' ? '✅ เปลี่ยนชื่อพนักงานแล้ว!' : '🗑️ ลบพนักงานออกจากระบบแล้ว!');
        res.json({ success: true, message: msg });
    } catch (error) {
        console.error("Update Staff Error:", error);
        res.status(500).json({ success: false, message: '❌ เกิดข้อผิดพลาดในการบันทึกข้อมูล' });
    }
});
const TOKEN = process.env.TOKEN;
const GUILD_ID = '1442466109503569992'; 

const PORT = 3000;
const DATA_FILE = 'bot_timer_data.json';
const LEAVE_FILE = 'leaves.json'; 

let dataStore = {
    checkinChannels: [],
    lastCheckinDates: {},
    autoCheckinEnabled: true // ค่าเริ่มต้นคือเปิดใช้งาน
};

let activeSessions = new Map(); 

// ตัวแปรความจำของบอท เพื่อจำว่างานไหนอัปเดตลงไฟล์ไปแล้วบ้าง
let processedTasks = new Set();

// 🆕 ฟังก์ชันให้บอทวิ่งไปแก้ไฟล์ใน GitHub อัตโนมัติ
async function syncToGitHub(newStaffData) {
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;

    if (!token || !owner || !repo) return console.log("⚠️ ข้ามการอัปเดต GitHub (ไม่ได้ตั้งค่า Variables)");

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/staff.json`;

    try {
        const getRes = await fetch(url, { headers: { 'Authorization': `token ${token}` } });
        const fileData = await getRes.json();

        const contentBase64 = Buffer.from(JSON.stringify(newStaffData, null, 2)).toString('base64');

        await fetch(url, {
            method: 'PUT',
            headers: { 
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            },
            body: JSON.stringify({
                message: "🤖 บอทอัปเดตรายชื่อพนักงานอัตโนมัติ [skip ci]",
                content: contentBase64,
                sha: fileData.sha 
            })
        });
        console.log("✅ อัปเดตไฟล์ staff.json ทับลง GitHub สำเร็จ!");
    } catch (e) {
        console.error("❌ อัปเดต GitHub พลาด:", e);
    }
}

if (fs.existsSync(DATA_FILE)) {
    try { 
        const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        dataStore.checkinChannels = loaded.checkinChannels || [];
        dataStore.lastCheckinDates = loaded.lastCheckinDates || {};
        dataStore.autoCheckinEnabled = loaded.autoCheckinEnabled !== undefined ? loaded.autoCheckinEnabled : true;

        // 👈 บรรทัดฮีโร่! สั่งให้บอทโหลดเวลาที่เคยเซฟไว้ออกมาใช้
        dataStore.autoCheckinTimes = loaded.autoCheckinTimes || []; 
    } catch (e) { console.error("Load Data Error:", e); }
}

// 🆕 ฟังก์ชันให้บอทเซฟการตั้งค่าเวลาขึ้น GitHub อัตโนมัติ (ฉลาดขึ้น ป้องกันการรีสตาร์ทมั่ว)
async function syncConfigToGitHub() {
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    if (!token || !owner || !repo) return;

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${DATA_FILE}`;
    try {
        let sha;
        const getRes = await fetch(url, { headers: { 'Authorization': `token ${token}` } });

        if (getRes.ok) {
            const fileData = await getRes.json();
            sha = fileData.sha;

            // 🧠 อัปเกรดความฉลาด: ให้บอทอ่านไฟล์เดิมใน GitHub มาเช็คก่อน
            try {
                const decodedContent = Buffer.from(fileData.content, 'base64').toString('utf8');
                const githubData = JSON.parse(decodedContent);

                // เช็คว่าการตั้งค่าหน้าเว็บ (เวลา/สถานะ/ช่อง) มีการเปลี่ยนแปลงจริงๆ หรือไม่
                const isSameTimes = JSON.stringify(githubData.autoCheckinTimes) === JSON.stringify(dataStore.autoCheckinTimes);
                const isSameStatus = githubData.autoCheckinEnabled === dataStore.autoCheckinEnabled;
                const isSameChannels = JSON.stringify(githubData.checkinChannels) === JSON.stringify(dataStore.checkinChannels);

                // 🛑 ถ้าไม่มีอะไรเปลี่ยน (แค่บอทเซฟประวัติเช็คชื่อลงไฟล์) ให้หยุดทำงาน! ไม่ต้องอัปโหลด! (ป้องกัน Railway รีสตาร์ท)
                if (isSameTimes && isSameStatus && isSameChannels) {
                    return console.log("🛑 ข้ามการอัปโหลดไป GitHub เพราะการตั้งค่าเว็บไม่ได้เปลี่ยน (กันบอทรีสตาร์ท)");
                }
            } catch (err) { console.error("Parse GitHub Data Error", err); }
        }

        const contentBase64 = Buffer.from(JSON.stringify(dataStore, null, 2)).toString('base64');
        const bodyObj = {
            message: "🤖 บอทอัปเดตการตั้งค่าระบบเช็คชื่อ",
            content: contentBase64
        };
        if (sha) bodyObj.sha = sha;

        await fetch(url, {
            method: 'PUT',
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' },
            body: JSON.stringify(bodyObj)
        });
        console.log("✅ อัปเดตไฟล์เวลา (bot_timer_data.json) ขึ้น GitHub สำเร็จ!");
    } catch (e) { console.error("❌ ซิงค์เวลาพลาด:", e); }
}

function saveData() { 
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataStore, null, 2), 'utf8'); 
        syncConfigToGitHub(); // 👈 สั่งให้ดึงไฟล์ไปเก็บใน GitHub ถาวรด้วย
    } catch (e) { console.error("Save Data Error:", e); }
}

function getStaffName(userId, fallbackName) {
    try {
        if (!fs.existsSync('./staff.json')) return fallbackName;
        const staffData = JSON.parse(fs.readFileSync('./staff.json', 'utf8'));
        for (const dept in staffData) {
            for (const shift in staffData[dept]) {
                if (staffData[dept][shift] && staffData[dept][shift][userId]) {
                    return staffData[dept][shift][userId];
                }
            }
        }
    } catch (e) {
        console.error("❌ Error reading staff.json for name:", e);
    }
    return fallbackName;
}

function getThaiTime() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utc + (3600000 * 7));
}

function getThaiDateStr() {
    const localTime = getThaiTime();
    return `${localTime.getDate()}/${localTime.getMonth() + 1}/${localTime.getFullYear() + 543}`;
}

function getSupabaseDateStr() {
    const localTime = getThaiTime();
    const yyyy = localTime.getFullYear();
    const mm = String(localTime.getMonth() + 1).padStart(2, '0');
    const dd = String(localTime.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

async function processAutoShiftSwaps() {
    try {
        const now = new Date();
        const yesterday = new Date(now.getTime() - (24 * 60 * 60 * 1000)).toISOString();

        const { data: tasks, error } = await supabase
            .from('scheduled_tasks')
            .select('*')
            .eq('status', 'completed')
            .gte('scheduled_for', yesterday); 

        if (error || !tasks || tasks.length === 0) return;

        let staffData = {};
        if (fs.existsSync('./staff.json')) {
            staffData = JSON.parse(fs.readFileSync('./staff.json', 'utf8'));
        }
        let isUpdated = false;

        for (const task of tasks) {
            if (processedTasks.has(task.id)) continue;

            let p = task.payload;
            if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e){ p = {}; } }

            if (task.task_type === 'individual_shift_update') {
                const targetName = p.user_name;
                const targetShiftTh = p.target_shift; 

                if (targetName && targetShiftTh && targetShiftTh !== 'คงเดิม') {
                    const newShiftKey = targetShiftTh.includes('เช้า') ? 'morning' : 'night';
                    let foundUserId = null;
                    let foundDept = null;
                    let foundName = null;

                    for (const dept in staffData) {
                        for (const shift in staffData[dept]) {
                            for (const uid in staffData[dept][shift]) {
                                if (staffData[dept][shift][uid].toUpperCase().includes(targetName.toUpperCase())) {
                                    foundUserId = uid;
                                    foundDept = dept;
                                    foundName = staffData[dept][shift][uid];
                                    delete staffData[dept][shift][uid]; 
                                }
                            }
                        }
                    }

                    if (foundUserId && foundDept) {
                        if (!staffData[foundDept][newShiftKey]) staffData[foundDept][newShiftKey] = {};
                        staffData[foundDept][newShiftKey][foundUserId] = foundName;
                        isUpdated = true;
                        console.log(`🔄 [Bot Sync] ซิงค์กะตามหน้าเว็บ: ${foundName} -> ${targetShiftTh}`);
                    }
                }
            }

            processedTasks.add(task.id);
        }

        if (isUpdated) {
            fs.writeFileSync('./staff.json', JSON.stringify(staffData, null, 2), 'utf8');
            await syncToGitHub(staffData); // 🆕 สั่งอัปเดตไป GitHub ด้วย
            console.log('✅ อัปเดตไฟล์ staff.json ตามเว็บเรียบร้อยแล้ว!');
        }

    } catch (err) {
        console.error("❌ Auto Shift Sync Error:", err);
    }
}

function getLeavesToday(dateStr, department = 'ALL') {
    let targetFile = LEAVE_FILE;
    const possibleNames = [LEAVE_FILE, 'Leaves.json', 'leaves.json.txt', 'Leaves.json.txt'];
    for (const name of possibleNames) {
        if (fs.existsSync(name)) { targetFile = name; break; }
    }
    if (!fs.existsSync(targetFile)) return { morning: [], night: [] };

    try {
        const rawData = fs.readFileSync(targetFile, 'utf8');
        if (!rawData.trim()) return { morning: [], night: [] };
        const allLeaves = JSON.parse(rawData);
        const todayData = allLeaves[dateStr];

        if (!todayData) return { morning: [], night: [] };

        let result = { morning: [], night: [] };

        ['morning', 'night'].forEach(shift => {
            if (todayData[shift]) {
                if ((department === 'AMOL' || department === 'ALL') && Array.isArray(todayData[shift].AMOL)) {
                    result[shift].push(...todayData[shift].AMOL);
                }
                if ((department === 'ODOL' || department === 'ALL') && Array.isArray(todayData[shift].ODOL)) {
                    result[shift].push(...todayData[shift].ODOL);
                }
            }
        });

        result.morning = result.morning.map(n => n.toString().trim());
        result.night = result.night.map(n => n.toString().trim());
        return result;
    } catch (e) { 
        console.error("Parse JSON Error:", e);
        return { morning: [], night: [] }; 
    }
}

async function getLeavesFromSupabase(department = 'ALL') {
    const targetDate = getSupabaseDateStr();
    let result = { morning: [], noon: [], night: [] };

    if (!supabaseLeave) return result; 

    try {
        const { data, error } = await supabaseLeave
            .from('leave_logs')
            .select('id, action_type, username, department')
            .eq('leave_date', targetDate)
            .order('id', { ascending: true });

        if (error) return result;

        let activeLeaves = {};
        if (data) {
            for (const row of data) {
                if (row.username) {
                    const leaveName = row.username.trim(); 
                    const action = row.action_type ? row.action_type.trim() : '';
                    if (action.startsWith('จอง')) {
                        activeLeaves[leaveName] = action; // เก็บข้อความเต็มๆ เช่น "จอง [KL]"
                    } else if (action === 'ยกเลิก') {
                        delete activeLeaves[leaveName];
                    }
                }
            }
        }

        const onLeaveUsers = Object.keys(activeLeaves);

        let staffData = {};
        try { if (fs.existsSync('./staff.json')) staffData = JSON.parse(fs.readFileSync('./staff.json', 'utf8')); } 
        catch (err) { }

        onLeaveUsers.forEach(leaveName => {
            let shiftFound = null;
            let userDeptFound = null; 
            const cleanLeaveName = leaveName.toUpperCase();

            for (const dept in staffData) {
                if (staffData[dept].morning) {
                    for (const id in staffData[dept].morning) {
                        const staffName = staffData[dept].morning[id].trim().toUpperCase();
                        if (staffName.includes(cleanLeaveName) || cleanLeaveName.includes(staffName)) { shiftFound = 'morning'; userDeptFound = dept; break; }
                    }
                }
                if (!shiftFound && staffData[dept].noon) {
                    for (const id in staffData[dept].noon) {
                        const staffName = staffData[dept].noon[id].trim().toUpperCase();
                        if (staffName.includes(cleanLeaveName) || cleanLeaveName.includes(staffName)) { shiftFound = 'noon'; userDeptFound = dept; break; }
                    }
                }
                if (!shiftFound && staffData[dept].night) {
                    for (const id in staffData[dept].night) {
                        const staffName = staffData[dept].night[id].trim().toUpperCase();
                        if (staffName.includes(cleanLeaveName) || cleanLeaveName.includes(staffName)) { shiftFound = 'night'; userDeptFound = dept; break; }
                    }
                }
                if (shiftFound) break;
            }

            if (department !== 'ALL' && userDeptFound && userDeptFound.toUpperCase() !== department.toUpperCase()) return; 

            // ตรวจสอบว่าเป็น ลากิจ [KL] หรือ วันหยุดธรรมดา
            let leaveType = "วันหยุด";
            const rawAction = activeLeaves[leaveName].toUpperCase();
            if (rawAction.includes('[KL]')) leaveType = "ลากิจ";

            // เก็บเป็น Object { ชื่อ, ประเภทการลา }
            const leaveData = { name: leaveName, type: leaveType };

            if (shiftFound === 'morning') result.morning.push(leaveData);
            else if (shiftFound === 'noon') result.noon.push(leaveData);
            else if (shiftFound === 'night') result.night.push(leaveData);
        });

        return result;
    } catch (e) { return result; }
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

    if (message.content === '!autoon') {
        const hasPermission = message.member.roles.cache.some(role => 
            ['PTT', 'TT HAED', 'TT HEAD'].includes(role.name.toUpperCase())
        );
        if (!hasPermission) return message.reply('❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้ค่ะ');

        dataStore.autoCheckinEnabled = true;
        saveData();
        return message.reply('✅ **เปิด** ระบบแจ้งเตือนเช็คชื่ออัตโนมัติ (07:50 และ 19:50) เรียบร้อยแล้วค่ะ'); // 👈 แก้ไขเวลาแจ้งเตือน
    }

    if (message.content === '!autooff') {
        const hasPermission = message.member.roles.cache.some(role => 
            ['PTT', 'TT HAED', 'TT HEAD'].includes(role.name.toUpperCase())
        );
        if (!hasPermission) return message.reply('❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้ค่ะ');

        dataStore.autoCheckinEnabled = false;
        saveData();
        return message.reply('🛑 **ปิด** ระบบแจ้งเตือนเช็คชื่ออัตโนมัติแล้วค่ะ แอดมินต้องพิมพ์ `!startcheckin` เพื่อเริ่มเองนะคะ');
    }

    if (message.content.startsWith('!removestaff')) {
        const hasPermission = message.member.roles.cache.some(role => 
            ['PTT', 'TT HAED', 'TT HEAD'].includes(role.name.toUpperCase())
        );
        if (!hasPermission) return message.reply('❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้ค่ะ');

        let staffData = {};
        if (fs.existsSync('./staff.json')) {
            try { staffData = JSON.parse(fs.readFileSync('./staff.json', 'utf8')); }
            catch (e) { return message.reply('❌ เกิดข้อผิดพลาดในการอ่านไฟล์ staff.json'); }
        } else {
            return message.reply('❌ ยังไม่มีฐานข้อมูลพนักงาน (staff.json) ค่ะ');
        }

        const argsText = message.content.replace('!removestaff', '').trim();
        if (!argsText) {
            return message.reply('⚠️ **วิธีใช้:** `!removestaff @แท็กพนักงาน` หรือ `!removestaff ชื่อพนักงาน`');
        }

        const targetUser = message.mentions.users.first();
        let removedName = null;

        if (targetUser) {
            const staffId = targetUser.id;
            for (const dept in staffData) {
                for (const shift in staffData[dept]) {
                    if (staffData[dept][shift] && staffData[dept][shift][staffId]) {
                        removedName = staffData[dept][shift][staffId];
                        delete staffData[dept][shift][staffId];
                    }
                }
            }
        } else {
            const searchName = argsText.replace('@', '').toUpperCase(); 

            for (const dept in staffData) {
                for (const shift in staffData[dept]) {
                    for (const uid in staffData[dept][shift]) {
                        const nameInDb = staffData[dept][shift][uid].toUpperCase();
                        if (nameInDb.includes(searchName) || searchName.includes(nameInDb)) {
                            removedName = staffData[dept][shift][uid];
                            delete staffData[dept][shift][uid];
                        }
                    }
                }
            }
        }

        if (removedName) {
            fs.writeFileSync('./staff.json', JSON.stringify(staffData, null, 2), 'utf8');
            await syncToGitHub(staffData); // 🆕 สั่งอัปเดตไป GitHub ด้วย
            return message.reply(`🗑️ **ลบพนักงานสำเร็จ!**\nถอดรายชื่อ **${removedName}** ออกจากระบบเรียบร้อยแล้วค่ะ`);
        } else {
            return message.reply('⚠️ ไม่พบรายชื่อพนักงานคนนี้ในระบบค่ะ (ลองเช็คตัวสะกดดูอีกครั้งนะครับ)');
        }
    }

    if (message.content.startsWith('!addstaff')) {
        const hasPermission = message.member.roles.cache.some(role => 
            ['PTT', 'TT HAED', 'TT HEAD'].includes(role.name.toUpperCase())
        );
        if (!hasPermission) return message.reply('❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้ค่ะ');

        const args = message.content.split(/\s+/);
        if (args.length < 5) {
            return message.reply('⚠️ **วิธีใช้:** `!addstaff @แท็กพนักงาน <AMOL/ODOL> <เช้า/ดึก> <ชื่อพนักงาน>`\n*(เช่น: `!addstaff @สมชาย AMOL เช้า AMOL-SOMCHAI`)*');
        }

        const targetUser = message.mentions.users.first();
        if (!targetUser) return message.reply('❌ กรุณาแท็ก (@) พนักงานที่ต้องการเพิ่มด้วยค่ะ');

        const dept = args[2].toUpperCase();
        if (dept !== 'AMOL' && dept !== 'ODOL') return message.reply('❌ แผนกต้องเป็น `AMOL` หรือ `ODOL` เท่านั้นค่ะ');

        const shiftInput = args[3];
        let shift = '';
        if (shiftInput === 'เช้า' || shiftInput.toLowerCase() === 'morning') shift = 'morning';
        else if (shiftInput === 'ดึก' || shiftInput.toLowerCase() === 'night') shift = 'night';
        else return message.reply('❌ กะต้องระบุเป็น `เช้า` หรือ `ดึก` เท่านั้นค่ะ');

        const staffName = args.slice(4).join(' '); 
        const staffId = targetUser.id;

        let staffData = {};
        if (fs.existsSync('./staff.json')) {
            try { staffData = JSON.parse(fs.readFileSync('./staff.json', 'utf8')); }
            catch (e) { console.error(e); }
        }

        if (!staffData[dept]) staffData[dept] = { morning: {}, night: {} };
        if (!staffData[dept][shift]) staffData[dept][shift] = {};

        for (const d in staffData) {
            for (const s in staffData[d]) {
                if (staffData[d][s] && staffData[d][s][staffId]) {
                    delete staffData[d][s][staffId];
                }
            }
        }

        staffData[dept][shift][staffId] = staffName;

        fs.writeFileSync('./staff.json', JSON.stringify(staffData, null, 2), 'utf8');
        await syncToGitHub(staffData); // 🆕 สั่งอัปเดตไป GitHub ด้วย
        return message.reply(`✅ **บันทึกข้อมูลพนักงานสำเร็จ!**\n👤 ชื่อ: **${staffName}**\n🏢 แผนก: **${dept}**\n⏱️ กะ: **${shift === 'morning' ? 'เช้า ☀️' : 'ดึก 🌙'}**`);
    }

    if (message.content === '!exportstaff') {
        const statusMsg = await message.reply('⏳ กำลังรวบรวมข้อมูล ID พนักงานทั้งหมด พร้อมระบุชื่อ... กรุณารอซักครู่');
        await message.guild.members.fetch();
        let staffShifts = {
            AMOL: { morning: {}, night: {} },
            ODOL: { morning: {}, night: {} }
        };
        message.guild.members.cache.forEach(member => {
            if (member.user.bot) return; 
            const name = member.displayName;
            const id = member.id;
            let isAMOL = member.roles.cache.some(r => r.name.toUpperCase().includes('AMOL'));
            let isODOL = member.roles.cache.some(r => r.name.toUpperCase().includes('ODOL'));
            if (isAMOL) staffShifts.AMOL.morning[id] = name;
            if (isODOL) staffShifts.ODOL.morning[id] = name;
        });
        const fs = require('fs');
        fs.writeFileSync('staff_template.json', JSON.stringify(staffShifts, null, 2));
        const { AttachmentBuilder } = require('discord.js');
        const file = new AttachmentBuilder('staff_template.json');
        await statusMsg.edit('✅ **ดูดข้อมูลพนักงานทั้งหมดเรียบร้อยแล้ว!** \nไฟล์นี้มี **ID คู่กับชื่อ** ให้แล้ว โหลดไปจัดกะเช้า-ดึก ได้ง่ายๆ เลยครับ 👇');
        return message.channel.send({ files: [file] });
    }

    if (message.content === '!resettest') {
        const hasPermission = message.member.roles.cache.some(role => 
            role.name.toUpperCase() === 'PTT' || 
            role.name.toUpperCase() === 'TT HAED' || 
            role.name.toUpperCase() === 'TT HEAD'
        );

        if (!hasPermission) {
            return message.reply('❌ อย่ากดมั่ว');
        }

        delete dataStore.lastCheckinDates[channelId];
        activeSessions.delete(channelId);
        saveData();
        return message.reply(`🔄 **รีเซ็ตระบบสำหรับห้องนี้เรียบร้อย!** เริ่มทดสอบใหม่ได้เลยค่ะ`);
    }

    if (message.content === '!testswap') {
        const hasPermission = message.member.roles.cache.some(role => 
            ['PTT', 'TT HAED', 'TT HEAD'].includes(role.name.toUpperCase())
        );
        if (!hasPermission) return message.reply('❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้ค่ะ');

        const statusMsg = await message.reply('⏳ กำลังทดสอบซิงค์กะตามหน้าเว็บ (ดึงเฉพาะคนที่ completed)...');
        try {
            await processAutoShiftSwaps(); 
            statusMsg.edit('✅ **ซิงค์กะตามเว็บเสร็จสิ้น!**\nลองไปเช็คในไฟล์ `staff.json` ว่าชื่อย้ายกะไหมนะครับ 🚀');
        } catch (e) {
            statusMsg.edit(`❌ เกิดข้อผิดพลาด: ${e.message}`);
        }
        return;
    }

    if (message.content === '!checkleave') {
        const todayStr = getThaiDateStr(); 
        let department = "ALL";
        if (message.channel.name.toUpperCase().includes('ODOL')) department = "ODOL";
        else if (message.channel.name.toUpperCase().includes('AMOL') || message.channel.name.includes('เช็คชื่อก่อนเข้างาน') || message.channel.name.includes('เช็คชื่อเข้างาน')) department = "AMOL";

        const leavesObj = await getLeavesFromSupabase(department); 

        let msg = `🔎 **ผลการตรวจสอบวันหยุดจากระบบ (วันที่ ${todayStr})**\n`;
        msg += `🏢 **แผนกที่ตรวจจับได้จากห้องนี้:** ${department === 'ALL' ? 'ทั้งหมด' : department}\n\n`;

        if (leavesObj.morning.length > 0 || leavesObj.noon.length > 0 || leavesObj.night.length > 0) {
            if (leavesObj.morning && leavesObj.morning.length > 0) {
                msg += `☀️ **กะเช้า (${leavesObj.morning.length} ท่าน):**\n` + leavesObj.morning.map((l, i) => `${i + 1}. ${l.name} ${l.type === 'ลากิจ' ? '(ลากิจ 📝)' : '(วันหยุด 😴)'}`).join('\n') + `\n\n`;
            }
            if (leavesObj.noon && leavesObj.noon.length > 0) {
                msg += `🕛 **กะเที่ยง (${leavesObj.noon.length} ท่าน):**\n` + leavesObj.noon.map((l, i) => `${i + 1}. ${l.name} ${l.type === 'ลากิจ' ? '(ลากิจ 📝)' : '(วันหยุด 😴)'}`).join('\n') + `\n\n`;
            }
            if (leavesObj.night && leavesObj.night.length > 0) {
                msg += `🌙 **กะดึก (${leavesObj.night.length} ท่าน):**\n` + leavesObj.night.map((l, i) => `${i + 1}. ${l.name} ${l.type === 'ลากิจ' ? '(ลากิจ 📝)' : '(วันหยุด 😴)'}`).join('\n') + `\n\n`;
            }
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

    if (message.content === '!removechannel') {
        const index = dataStore.checkinChannels.indexOf(channelId);
        if (index > -1) {
            dataStore.checkinChannels.splice(index, 1);
            saveData();
            return message.reply(`🗑️ **ยกเลิก**การตั้งค่าห้อง <#${channelId}> เป็นจุดเช็คชื่อเรียบร้อยแล้วค่ะ`);
        } else {
            return message.reply('⚠️ ห้องนี้ไม่ได้ตั้งเป็นจุดเช็คชื่ออยู่แล้วค่ะ');
        }
    }

    if (message.content.startsWith('!startcheckin')) {
        if (!dataStore.checkinChannels.includes(channelId)) {
            return message.reply('❌ ห้องนี้ยังไม่ได้เป็นห้องเช็คชื่อ (พิมพ์ `!addchannel`ในห้องนี้ก่อนค่ะ)');
        }

        const localTime = getThaiTime(); 
        const todayStr = getThaiDateStr(); 
        const currentHour = localTime.getHours();

        // 👈 แยกช่วงเวลาให้ชัดเจน (เช้า, เที่ยง, ดึก)
        let shiftType = "Night";
        if (currentHour >= 6 && currentHour < 11) {
            shiftType = "Morning"; // 06:00 - 10:59 กะเช้า
        } else if (currentHour >= 11 && currentHour <= 13) {
            shiftType = "Noon";    // 11:00 - 13:59 กะเที่ยง
        } else if (currentHour > 13 && currentHour < 18) {
            shiftType = "Afternoon"; // 14:00 - 17:59 กะบ่าย (กันเหนียว)
        }

        if (activeSessions.has(channelId)) {
            return message.reply('⚠️ ระบบเช็คชื่อของห้องนี้กำลังทำงานอยู่แล้วค่ะ');
        }

        if (dataStore.lastCheckinDates[channelId] === checkinKey) {
            return message.reply(`❌ ห้องนี้สรุปยอดของกะนี้ไปเรียบร้อยแล้วค่ะ`);
        }

        let sessionDept = "ALL";
        const chName = message.channel.name.toUpperCase();
        if (chName.includes('ODOL')) {
            sessionDept = "ODOL";
        } else if (chName.includes('AMOL') || chName.includes('เช็คชื่อก่อนเข้างาน') || chName.includes('เช็คชื่อเข้างาน')) {
            sessionDept = "AMOL";
        }

        const args = message.content.split(' ');
        const checkinDuration = parseInt(args[1]) || 10;

        activeSessions.set(channelId, {
            members: [],
            startTime: localTime,
            adminChannel: message.channel,
            department: sessionDept, 
            jsonError: null,
            shiftType: shiftType,
            duration: checkinDuration // 👈 เซฟลง session
        });

        dataStore.lastCheckinDates[channelId] = checkinKey;
        saveData();

        const startEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle(`🔔 เริ่มเช็คชื่อพนักงาน แผนก: ${sessionDept === 'ALL' ? message.channel.name : sessionDept}`)
            .setDescription(`📅 **ประจำวันที่:** ${todayStr}\n\n📢 **กติกา:**\n1. ต้องอยู่ในห้องเสียง\n2. ต้องแชร์หน้าจอ\n3. พิมพ์ \`!checkin\` ในห้องนี้\n\n⏱️ **ระบบจะเปิดรับเช็คชื่อเป็นเวลา ${checkinDuration} นาที**`)
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
                    const localTime = getThaiTime(); 
                    const currentHour = localTime.getHours();

                    // 👈 แก้ไขเงื่อนไขกะเช้าตอนพิมพ์เช็คชื่อ
                    let shiftName = (session.shiftType === 'morning') ? "กะเช้า ☀️" : "กะดึก 🌙";

                    const staffName = getStaffName(member.id, member.displayName);

                    session.members.push({ 
                        id: member.id, 
                        name: staffName, 
                        time: localTime,
                        shift: shiftName 
                    });

                    try {
                        const { error } = await supabase
                            .from('checkins') 
                            .insert([{ discord_id: member.id, name: staffName, checkin_time: localTime, shift: shiftName }]); 
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
    setTimeout(async () => {
        const session = activeSessions.get(channelId);
        if (!session) return;

        try {
            const localTime = getThaiTime();
            const currentHour = localTime.getHours();
            const dateTh = getThaiDateStr(); 
            const checkedIds = new Set(session.members.map(m => m.id));

            // 👈 แก้ไขเงื่อนไขกะตอนสรุปผลให้รองรับตัวพิมพ์เล็ก-ใหญ่ และกะเที่ยง
            const shiftTypeLower = session.shiftType ? session.shiftType.toLowerCase() : '';
            const leavesObj = await getLeavesFromSupabase(session.department);

            let shiftIcon = "☀️ กะเช้า";
            let currentShiftLeaves = leavesObj.morning || [];

            // ตรวจสอบว่าเป็นกะดึกหรือไม่
            if (shiftTypeLower.includes('night') || shiftTypeLower.includes('ดึก')) {
                shiftIcon = "🌙 กะดึก";
                currentShiftLeaves = leavesObj.night || [];
            } 
            // ตรวจสอบว่าเป็นกะเที่ยง/บ่ายหรือไม่
            else if (shiftTypeLower.includes('noon') || shiftTypeLower.includes('afternoon') || shiftTypeLower.includes('เที่ยง') || shiftTypeLower.includes('บ่าย')) {
                shiftIcon = "🕛 กะเที่ยง";
                currentShiftLeaves = leavesObj.noon || [];
            }

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

                    // แยกหมวดหมู่
                    const dayOffs = currentShiftLeaves.filter(l => l.type === "วันหยุด");
                    const klLeaves = currentShiftLeaves.filter(l => l.type === "ลากิจ");

                    summary += `\n😴 **รายชื่อวันหยุด (${shiftIcon}):**\n`;
                    if (dayOffs.length > 0) {
                        dayOffs.forEach((l, i) => summary += `   ${i + 1}. **${l.name}**\n`);
                    } else { summary += `- ไม่มี -\n`; }

                    summary += `\n📝 **รายชื่อลากิจ (${shiftIcon}):**\n`;
                    if (klLeaves.length > 0) {
                        klLeaves.forEach((l, i) => summary += `   ${i + 1}. **${l.name}**\n`);
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
                            const staffName = getStaffName(member.id, member.displayName);
                            const cleanName = staffName.trim().toUpperCase();

                            let isLeave = false;
                            for (const lData of currentShiftLeaves) { 
                                if (cleanName.includes(lData.name.toUpperCase())) { 
                                    isLeave = true;
                                    break;
                                }
                            }

                            let isSameDepartment = true;
                            if (session.department !== "ALL") {
                                isSameDepartment = member.roles.cache.some(r => r.name.includes(session.department));
                            }

                            if (!member.user.bot && !checkedIds.has(member.id) && !isLeave && isSameDepartment) {
                                missingMembers.push({ name: staffName, vName: vRoom.name }); 
                            }
                        });
                    }
                });

                if (missingMembers.length > 0) {
                    summary += `\n🔴 **ลืมเช็คชื่อ (พบในกลุ่มห้องเสียงเดียวกัน):**\n`;
                    missingMembers.forEach((m, i) => {
                        summary += `   ${i + 1}. **${m.name}** (อยู่ในห้อง: ${m.vName})\n`;
                    });
                }

                let absentMembers = [];
                try {
                    const staffData = JSON.parse(fs.readFileSync('./staff.json', 'utf8'));

                    // 1. เช็คว่าเป็นกะไหน
                    let shiftKey = 'morning';
                    const sType = session.shiftType ? session.shiftType.toLowerCase() : '';
                    if (sType.includes('ดึก') || sType.includes('night') || sType.includes('กะดึก')) shiftKey = 'night';
                    else if (sType.includes('เที่ยง') || sType.includes('บ่าย') || sType.includes('กะเที่ยง')) shiftKey = 'afternoon';

                    // 2. ดึงรายชื่อพนักงาน (แก้ใหม่ให้บอทเจาะเข้าไปหาในหมวด AMOL/ODOL ก่อน)
                    let shiftStaff = {};
                    const targetDept = session.department.toUpperCase(); // เช่น 'AMOL', 'ODOL' หรือ 'ALL'

                    if (targetDept === 'ALL') {
                        // ถ้ารวมทุกแผนก ก็ดึงกะดึกของทุกแผนกมารวมกัน
                        for (const dept in staffData) {
                            if (staffData[dept] && staffData[dept][shiftKey]) {
                                Object.assign(shiftStaff, staffData[dept][shiftKey]);
                            }
                        }
                    } else {
                        // ดึงเฉพาะแผนกที่กำลังเช็คชื่อ
                        if (staffData[targetDept] && staffData[targetDept][shiftKey]) {
                            shiftStaff = staffData[targetDept][shiftKey];
                        }
                    }

                    // 3. ป้องกันบั๊กเรื่องรายชื่อคนลา
                    let safeLeaves = [];
                    if (Array.isArray(leavesObj)) safeLeaves = leavesObj;
                    else if (leavesObj && Array.isArray(leavesObj[shiftKey])) safeLeaves = leavesObj[shiftKey];
                    else if (leavesObj && Array.isArray(leavesObj.night)) safeLeaves = leavesObj.night;

                    // 4. วนเช็คพนักงานทีละคน
                    for (const [staffId, staffName] of Object.entries(shiftStaff)) {
                        // เช็คว่าพนักงานคนนี้ "ลา" หรือไม่
                        let isLeave = false;
                        for (const lData of safeLeaves) {
                            if (lData && lData.name && staffName.toUpperCase().includes(lData.name.toUpperCase())) {
                                isLeave = true;
                                break;
                            }
                        }

                        // ถ้าไม่มีชื่อใน List เช็คชื่อ (ไม่ได้เข้างาน) และ ไม่ได้ลา = ขาดงาน!
                        if (!checkedIds.has(staffId) && !isLeave) {
                            absentMembers.push(staffName);
                        }
                    }
                } catch (error) {
                    console.error("❌ เกิดข้อผิดพลาดในการคำนวณคนขาด:", error);
                }

                if (absentMembers.length > 0) {
                    summary += `\n❓ **พนักงานที่หายตัวไป (ไม่มีชื่อลา & ไม่ได้เช็คชื่อ):**\n`;
                    absentMembers.forEach((name, i) => {
                        summary += `   ${i + 1}. **${name}**\n`;
                    });
                } else {
                    summary += `\n✅ **เข้างานครบทุกคน (ไม่มีคนขาด)**\n`;
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
    }, (activeSessions.get(channelId)?.duration || 10) * 60000);
}

// ====== วางทับส่วนนี้ไว้ด้านล่างสุดของไฟล์ index.js ======
client.once('ready', () => { 
    console.log(`🚀 บอทพร้อม! ล็อกอินในชื่อ ${client.user.tag}`); 

    cron.schedule('* * * * *', async () => {
        await processAutoShiftSwaps();
        if (!dataStore.autoCheckinEnabled) return;

        const localTime = getThaiTime();
        const currentHour = localTime.getHours();
        const HH = String(currentHour).padStart(2, '0');
        const MM = String(localTime.getMinutes()).padStart(2, '0');
        const currentTimeStr = `${HH}:${MM}`;

        let scheduleTimes = dataStore.autoCheckinTimes;
        if (!Array.isArray(scheduleTimes) || scheduleTimes.length === 0) return;

        // ค้นหาว่าเวลาปัจจุบัน ตรงกับรอบที่ตั้งไว้ในเว็บไหม
        let currentSlot = null;
        for (let i = 0; i < scheduleTimes.length; i++) {
            if (typeof scheduleTimes[i] === 'string') {
                if (scheduleTimes[i] === currentTimeStr) {
                    let autoShift = "night";
                    if (currentHour >= 6 && currentHour < 11) autoShift = "morning";
                    else if (currentHour >= 11 && currentHour <= 13) autoShift = "noon";
                    else if (currentHour > 13 && currentHour < 18) autoShift = "afternoon";

                    currentSlot = { time: currentTimeStr, shift: autoShift };
                    break;
                }
            } else if (scheduleTimes[i].time === currentTimeStr) {
                currentSlot = scheduleTimes[i]; // ดึงข้อมูลกะมาจากเว็บโดยตรง
                break;
            }
        }

        if (!currentSlot) return; // ถ้าไม่ตรงเวลาที่ตั้งไว้ ให้ข้ามไป

        console.log(`⏰ ถึงเวลา ${currentTimeStr} เปิดระบบเช็คชื่ออัตโนมัติ กะ: ${currentSlot.shift}`);

        const todayStr = getThaiDateStr();
        // เอาค่ากะที่ตั้งในเว็บไปใช้เช็คชื่อเลย (ไม่ต้องใช้เวลามาคำนวณแล้ว)
        // ดึงค่ากะจากที่ตั้งค่ามาใช้ได้เลยตรงๆ (รองรับ noon)
        const shiftTypeLower = currentSlot.shift ? currentSlot.shift.toLowerCase() : 'morning';
        let shiftType = shiftTypeLower === 'morning' ? "Morning" : "Night";
        let shiftLabel = "☀️ กะเช้า";

        if (shiftTypeLower === 'night' || shiftTypeLower === 'ดึก') {
            shiftType = "Night";
            shiftLabel = "🌙 กะดึก";
        } else if (shiftTypeLower === 'noon' || shiftTypeLower === 'afternoon' || shiftTypeLower === 'เที่ยง') {
            shiftType = "Noon";
            shiftLabel = "🕛 กะเที่ยง";
        }
        const checkinKey = `${todayStr}-${shiftType}-${currentTimeStr}`;

        for (const channelId of dataStore.checkinChannels) {
            if (activeSessions.has(channelId)) continue; 
            if (dataStore.lastCheckinDates[channelId] === checkinKey) continue; 

            try {
                const channel = await client.channels.fetch(channelId);
                if (!channel) continue;

                let sessionDept = "ALL";
                const chName = channel.name.toUpperCase();
                if (chName.includes('ODOL')) sessionDept = "ODOL";
                else if (chName.includes('AMOL') || chName.includes('เช็คชื่อ')) sessionDept = "AMOL";

                // เซฟข้อมูลกะลงใน Session เพื่อให้คำสั่ง !checkin ดึงไปใช้ต่อได้ถูกต้อง
                // คำนวณระยะเวลา (นาที) จากเวลาเริ่มและเวลาสิ้นสุดที่ตั้งไว้ในเว็บ
                let checkinDuration = 10; // ค่าเริ่มต้นเผื่อเหนียว
                if (currentSlot.endTime && currentSlot.time) {
                    const start = new Date(`1970/01/01 ${currentSlot.time}`);
                    const end = new Date(`1970/01/01 ${currentSlot.endTime}`);
                    let diffMs = end - start;
                    if (diffMs < 0) diffMs += (24 * 60 * 60 * 1000); // จัดการกรณีตั้งเวลาข้ามคืน (เช่น 23:50 ถึง 00:10)
                    checkinDuration = Math.round(diffMs / 60000); // แปลงเป็นนาที
                }

                activeSessions.set(channelId, { 
                    members: [], 
                    startTime: localTime, 
                    adminChannel: channel, 
                    department: sessionDept, 
                    jsonError: null,
                    shiftType: currentSlot.shift,
                    duration: checkinDuration 
                });

                dataStore.lastCheckinDates[channelId] = checkinKey;
                saveData();

                const startEmbed = new EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle(`🔔 เริ่มเช็คชื่อพนักงาน แผนก: ${sessionDept === 'ALL' ? channel.name : sessionDept} (อัตโนมัติ)`)
                    .setDescription(`📅 **ประจำวันที่:** ${todayStr}\n⏰ **รอบเวลา:** ${currentTimeStr} น. (${shiftLabel})\n\n📢 **กติกา:**\n1. ต้องอยู่ในห้องเสียง\n2. ต้องแชร์หน้าจอ\n3. พิมพ์ \`!checkin\` ในห้องนี้\n\n⏱️ **เปิดรับเช็คชื่อถึงเวลา: ${currentSlot.endTime || "ไม่ได้ระบุ"} น.** (${checkinDuration} นาที)`)
                    .setTimestamp();

                await channel.send({ embeds: [startEmbed] });
                startSummaryTimer(channelId);
            } catch (error) { console.error(`❌ เกิดข้อผิดพลาดในการเปิดเช็คชื่อห้อง ${channelId}:`, error); }
        }
    }, { scheduled: true, timezone: "Asia/Bangkok" });
});
// --- 7. API สำหรับตั้งเวลา Auto Checkin (อัปเดตรองรับระบบเลือกเวลา) ---
app.post('/api/setautotime', (req, res) => {
    const { pin, times } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });

    if (times) {
        dataStore.autoCheckinTimes = times; 
        saveData();
        return res.json({ success: true, message: `✅ บันทึกตั้งค่าสำเร็จ! (อัปเดตระบบเวลาเรียบร้อย)` });
    }
    res.status(400).json({ success: false, message: '❌ ข้อมูลไม่ครบถ้วน' });
});

// --- 8. API สำหรับให้เว็บดึงการตั้งค่าปัจจุบันไปแสดง ---
app.get('/api/getconfig', (req, res) => {
    res.json({ 
        success: true, 
        autoCheckinEnabled: dataStore.autoCheckinEnabled, 
        autoCheckinTimes: dataStore.autoCheckinTimes
    });
    // ==========================================
    // 🧹 ระบบแม่บ้าน: เคลียร์ขยะ (ข้อมูลขยับเมาส์) ที่เก่าเกิน 7 วัน
    // ==========================================
    setInterval(async () => {
        try {
            console.log('🧹 [ระบบแม่บ้าน] เริ่มตรวจสอบและกวาดขยะในฐานข้อมูล...');

            // คำนวณหาวันที่ย้อนหลังไป 7 วัน
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            // สั่งลบข้อมูลเฉพาะในตาราง line_activity ที่เก่ากว่า 7 วัน
            const { error } = await supabase
                .from('line_activity')
                .delete()
                .lt('last_active', sevenDaysAgo.toISOString());

            if (error) {
                console.error("❌ [ระบบแม่บ้าน] กวาดขยะพลาด:", error);
            } else {
                console.log('✅ [ระบบแม่บ้าน] เคลียร์ข้อมูลขยับเมาส์ที่เก่ากว่า 7 วันเรียบร้อยแล้ว! คืนพื้นที่ให้เซิร์ฟเวอร์แล้วครับ');
            }
        } catch (e) {
            console.error("❌ [ระบบแม่บ้าน] ระบบขัดข้อง:", e);
        }
    }, 24 * 60 * 60 * 1000); // ⏰ ตั้งเวลาให้ตื่นมาทำความสะอาด วันละ 1 ครั้ง (24 ชั่วโมง)
});
app.listen(process.env.PORT || 3000, () => { console.log(`🌐 Server web port is open and listening for Render!`); });
client.login(TOKEN).catch(error => { console.error("❌ ล็อกอินล้มเหลว โปรดตรวจสอบ TOKEN อีกครั้ง:", error); });