const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { Client, GatewayIntentBits, ChannelType, EmbedBuilder } = require('discord.js');
const express = require('express');
const fs = require('fs');
const cron = require('node-cron'); 

// --- ตั้งค่าเชื่อมต่อ Supabase ---
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const supabaseLeaveUrl = process.env.SUPABASE_LEAVE_URL;
const supabaseLeaveKey = process.env.SUPABASE_LEAVE_KEY;
const supabaseLeave = (supabaseLeaveUrl && supabaseLeaveKey) ? createClient(supabaseLeaveUrl, supabaseLeaveKey) : null;

const app = express();
const path = require('path');
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); 
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- ตัวแปรระบบ ---
const WEB_ADMIN_PIN = "123456"; 
const TOKEN = process.env.TOKEN;
const GUILD_ID = '1442466109503569992'; 
const PORT = process.env.PORT || 5000;
const DATA_FILE = 'bot_timer_data.json';
const LEAVE_FILE = 'leaves.json'; 

let dataStore = {
    checkinChannels: [],
    lastCheckinDates: {},
    autoCheckinEnabled: true,
    autoCheckinTimes: []
};

let activeSessions = new Map(); 
let processedTasks = new Set();
const userCooldowns = {};

// --- โหลดข้อมูลตอนเริ่มระบบ ---
if (fs.existsSync(DATA_FILE)) {
    try { 
        const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        dataStore.checkinChannels = loaded.checkinChannels || [];
        dataStore.lastCheckinDates = loaded.lastCheckinDates || {};
        dataStore.autoCheckinEnabled = loaded.autoCheckinEnabled !== undefined ? loaded.autoCheckinEnabled : true;
        dataStore.autoCheckinTimes = loaded.autoCheckinTimes || []; 
    } catch (e) { console.error("Load Data Error:", e); }
}

// ==========================================
// 🚀 เริ่มโซนสร้าง API ทั้งหมด
// ==========================================

app.post('/api/autocheckin', (req, res) => {
    const { status, pin } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });
    dataStore.autoCheckinEnabled = (status === 'on');
    saveData();
    res.json({ success: true, message: `✅ ระบบเปิดเช็คชื่ออัตโนมัติ: ${status === 'on' ? 'เปิด' : 'ปิด'} เรียบร้อยแล้ว` });
});

app.post('/api/startcheckin', async (req, res) => {
    const { channelId, pin, duration } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });
    if (!dataStore.checkinChannels.includes(channelId)) return res.status(400).json({ success: false, message: '❌ ห้องนี้ยังไม่ได้เป็นห้องเช็คชื่อ (!addchannel ก่อน)' });

    const localTime = getThaiTime(); 
    const todayStr = getThaiDateStr(); 
    const currentHour = localTime.getHours();
    const shiftType = (currentHour >= 6 && currentHour < 18) ? "Morning" : "Night";
    const checkinKey = `${todayStr}-${shiftType}`;
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
            members: [], startTime: localTime, adminChannel: channel,
            department: sessionDept, jsonError: null, shiftType: shiftType,
            duration: checkinDuration 
        });

        dataStore.lastCheckinDates[channelId] = checkinKey;
        saveData();

        const startEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle(`🔔 เริ่มเช็คชื่อพนักงาน แผนก: ${sessionDept === 'ALL' ? channel.name : sessionDept} (สั่งจาก Web)`)
            .setDescription(`📅 **ประจำวันที่:** ${todayStr}\n\n📢 **กติกา:**\n1. ต้องอยู่ในห้องเสียง\n2. ต้องแชร์หน้าจอ\n3. พิมพ์ \`!checkin\` ในห้องนี้\n\n⏱️ **เปิดรับเช็คชื่อเป็นเวลา ${checkinDuration} นาที**`)
            .setTimestamp();

        await channel.send({ embeds: [startEmbed] });
        startSummaryTimer(channelId);
        res.json({ success: true, message: `✅ สั่งเปิดระบบห้อง ${channel.name} เป็นเวลา ${checkinDuration} นาที สำเร็จ!` });
    } catch (error) { res.status(500).json({ success: false, message: '❌ Error' }); }
});

app.get('/api/getstaff', async (req, res) => {
    try {
        const staffData = await fetchStaffData();
        res.json({ success: true, data: staffData });
    } catch (error) {
        res.status(500).json({ success: false, message: '❌ ไม่สามารถโหลดข้อมูลพนักงานจาก Supabase ได้' });
    }
});

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

app.get('/api/getconfig', (req, res) => {
    res.json({ 
        success: true, 
        autoCheckinEnabled: dataStore.autoCheckinEnabled, 
        autoCheckinTimes: dataStore.autoCheckinTimes
    });
});

app.post('/api/ping-active', async (req, res) => {
    const { sessionProfile, msgCount } = req.body;
    if (!sessionProfile) return res.status(400).json({ success: false });

    const chats = msgCount || 0;
    const now = Date.now();

    if (userCooldowns[sessionProfile] && (now - userCooldowns[sessionProfile] < 2000)) {
        return res.status(200).json({ success: true, status: 'ignored_race_condition' });
    }

    if (chats === 0 && userCooldowns[sessionProfile] && (now - userCooldowns[sessionProfile] < 45000)) {
        return res.status(200).json({ success: true, status: 'ignored_spam' });
    }

    userCooldowns[sessionProfile] = now;

    try {
        const localTime = new Date().toISOString(); 
        console.log(`[Tracker] ได้รับสัญญาณ: ${sessionProfile} กำลังทำงาน! (ตอบแชท: ${chats} ข้อความ 💬)`);

        const nowThai = new Date(new Date().getTime() + (7 * 60 * 60 * 1000));
        const todayYYYYMMDD = nowThai.toISOString().split('T')[0]; 
        const startOfDayThai = `${todayYYYYMMDD}T00:00:00+07:00`; 

        const { data: existingDataArray } = await supabase
            .from('line_activity')
            .select('*')
            .eq('staff_name', sessionProfile)
            .gte('created_at', startOfDayThai)
            .order('created_at', { ascending: false })
            .limit(1);

        let error; 

        if (existingDataArray && existingDataArray.length > 0) {
            const existingData = existingDataArray[0];

            const lastPing = new Date(existingData.last_active).getTime();
            const currentPing = new Date(localTime).getTime();
            const diffFromLastPing = (currentPing - lastPing) / 60000;

            const bucketStart = new Date(existingData.created_at).getTime();
            const diffFromBucketStart = (currentPing - bucketStart) / 60000;

            const newTotalChats = existingData.message_count + chats;
            let newAfkCount = existingData.afk_count || 0;

            if (diffFromLastPing >= 10) {
                newAfkCount += 1;
                await supabase.from('tracker_remarks').insert([{
                    staff_name: sessionProfile,
                    afk_date: todayYYYYMMDD,
                    start_time: new Date(lastPing).toISOString(),
                    end_time: new Date(currentPing).toISOString(),
                    remark: ''
                }]);
            }

            if (diffFromBucketStart >= 10 || diffFromLastPing >= 10) {
                const { error: insertError } = await supabase.from('line_activity').insert([{
                    staff_name: sessionProfile,
                    status: 'Online',
                    last_active: localTime,
                    message_count: newTotalChats,
                    afk_count: newAfkCount
                }]);
                error = insertError;
            } else {
                const { error: updateError } = await supabase.from('line_activity')
                    .update({
                        status: 'Online',
                        last_active: localTime,
                        message_count: newTotalChats,
                        afk_count: newAfkCount
                    })
                    .eq('id', existingData.id);
                error = updateError;
            }
        } else {
            const { error: insertError } = await supabase
                .from('line_activity')
                .insert([{
                    staff_name: sessionProfile, 
                    status: 'Online',
                    last_active: localTime, 
                    message_count: chats,
                    afk_count: 0 
                }]);
            error = insertError;
        }

        if (error) {
            console.error('[Tracker] Error:', error);
            return res.status(500).json({ success: false });
        }
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('[Tracker] Server error:', err);
        return res.status(500).json({ success: false });
    }
});

// =========================================================
// 1. API ดึงประวัติตารางแชทรายวัน (ตัวที่เผลอลบไป)
// =========================================================
app.post('/api/tracker-history', async (req, res) => {
    const { date } = req.body;
    try {
        const startOfDay = new Date(`${date}T00:00:00+07:00`).toISOString();
        const endOfDay = new Date(`${date}T23:59:59+07:00`).toISOString();

        const { data: pings } = await supabase.from('line_activity').select('*').gte('last_active', startOfDay).lte('last_active', endOfDay).order('last_active', { ascending: true }).limit(10000);
        const { data: remarks } = await supabase.from('tracker_remarks').select('*').eq('afk_date', date).limit(10000);

        res.json({ success: true, pings: pings || [], remarks: remarks || [] });
    } catch (err) { res.status(500).json({ success: false }); }
});

// =========================================================
// 2. API สำหรับดึงข้อมูลกราฟ รายสัปดาห์ / รายเดือน (ตัวใหม่)
// =========================================================
app.post('/api/personal-stats', async (req, res) => {
    const { staff_name, mode } = req.body;
    try {
        const daysToFetch = mode === 'week' ? 7 : 30;
        const now = new Date();
        const pastDate = new Date(now.getTime() - ((daysToFetch - 1) * 24 * 60 * 60 * 1000));

        // ตั้งเวลาเริ่มต้นของวันแรกที่จะดึง (โซนเวลาไทย)
        const startOfDayThai = `${pastDate.toISOString().split('T')[0]}T00:00:00+07:00`; 

        const { data, error } = await supabase
            .from('line_activity')
            .select('last_active, message_count')
            .eq('staff_name', staff_name)
            .gte('last_active', startOfDayThai)
            .order('last_active', { ascending: true });

        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (err) {
        console.error('[Stats API] Error:', err);
        res.status(500).json({ success: false });
    }
});

app.post('/api/save-remark', async (req, res) => {
    const { staff_name, afk_date, start_time, end_time, remark, pin } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });

    try {
        await supabase.from('tracker_remarks').delete().match({ staff_name, start_time });
        if (remark && remark.trim() !== '') {
            await supabase.from('tracker_remarks').insert([{ staff_name, afk_date, start_time, end_time, remark }]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/updatestaff', async (req, res) => {
    const { pin, action, dept, shift, discordId, staffName, newName, newShift } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });

    try {
        // อัปเดตให้ตรงกับ Table staff_list และคอลัมน์ staff_name
        if (action === 'add') {
            await supabase.from('staff_list').upsert({ discord_id: discordId, staff_name: staffName, department: dept, shift: shift });
        } else if (action === 'edit_name') {
            await supabase.from('staff_list').update({ staff_name: newName }).eq('discord_id', discordId);
        } else if (action === 'remove') {
            await supabase.from('staff_list').delete().eq('discord_id', discordId);
        } else if (action === 'change_shift') {
            // 🌟 [ใหม่] ย้ายกะพนักงาน — ไม่ต้องลบแล้วสร้างใหม่
            if (!['morning', 'noon', 'night'].includes(newShift)) {
                return res.status(400).json({ success: false, message: '❌ กะที่ระบุไม่ถูกต้อง' });
            }
            await supabase.from('staff_list').update({ shift: newShift }).eq('discord_id', discordId);
        }

        let msg;
        if (action === 'add') msg = `✅ บันทึกพนักงาน ${staffName} สำเร็จ!`;
        else if (action === 'edit_name') msg = '✅ เปลี่ยนชื่อพนักงานแล้ว!';
        else if (action === 'remove') msg = '🗑️ ลบพนักงานออกจากระบบแล้ว!';
        else if (action === 'change_shift') {
            const shiftLabel = newShift === 'morning' ? '☀️ กะเช้า' : (newShift === 'noon' ? '🕛 กะเที่ยง' : '🌙 กะดึก');
            msg = `🔄 ย้ายไป${shiftLabel}เรียบร้อย!`;
        }
        res.json({ success: true, message: msg });
    } catch (error) { res.status(500).json({ success: false, message: '❌ เกิดข้อผิดพลาดในการบันทึกข้อมูลไปที่ Supabase' }); }
});


// ==========================================
// 🛠️ โซน Functions ต่างๆ
// ==========================================

// ฟังก์ชันจำลองโครงสร้าง Object ให้เหมือน staff.json เดิม เพื่อไม่ให้ระบบอื่นๆ พัง
async function fetchStaffData() {
    try {
        // ดึงจาก Table staff_list
        const { data, error } = await supabase.from('staff_list').select('*');
        let staffObj = { AMOL: { morning: {}, noon: {}, night: {} }, ODOL: { morning: {}, noon: {}, night: {} } };
        if (error || !data) return staffObj;

        data.forEach(row => {
            const dept = (row.department || 'ALL').toUpperCase();
            const shift = (row.shift || 'morning').toLowerCase();
            if (!staffObj[dept]) staffObj[dept] = { morning: {}, noon: {}, night: {} };
            if (!staffObj[dept][shift]) staffObj[dept][shift] = {};
            staffObj[dept][shift][row.discord_id] = row.staff_name;
        });
        return staffObj;
    } catch (e) {
        console.error("Fetch Staff Error:", e);
        return { AMOL: { morning: {}, noon: {}, night: {} }, ODOL: { morning: {}, noon: {}, night: {} } };
    }
}

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
            try {
                const decodedContent = Buffer.from(fileData.content, 'base64').toString('utf8');
                const githubData = JSON.parse(decodedContent);
                const isSameTimes = JSON.stringify(githubData.autoCheckinTimes) === JSON.stringify(dataStore.autoCheckinTimes);
                const isSameStatus = githubData.autoCheckinEnabled === dataStore.autoCheckinEnabled;
                const isSameChannels = JSON.stringify(githubData.checkinChannels) === JSON.stringify(dataStore.checkinChannels);
                if (isSameTimes && isSameStatus && isSameChannels) return;
            } catch (err) {}
        }

        const contentBase64 = Buffer.from(JSON.stringify(dataStore, null, 2)).toString('base64');
        const bodyObj = { message: "🤖 บอทอัปเดตการตั้งค่าระบบ", content: contentBase64 };
        if (sha) bodyObj.sha = sha;

        await fetch(url, {
            method: 'PUT',
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' },
            body: JSON.stringify(bodyObj)
        });
        console.log("✅ อัปเดตไฟล์เวลาสำเร็จ!");
    } catch (e) { }
}

function saveData() { 
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataStore, null, 2), 'utf8'); 
        syncConfigToGitHub(); 
    } catch (e) {}
}

function getStaffName(userId, fallbackName, staffDataObj) {
    if (!staffDataObj) return fallbackName;
    for (const dept in staffDataObj) {
        for (const shift in staffDataObj[dept]) {
            if (staffDataObj[dept][shift] && staffDataObj[dept][shift][userId]) {
                return staffDataObj[dept][shift][userId];
            }
        }
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
    return `${localTime.getFullYear()}-${String(localTime.getMonth() + 1).padStart(2, '0')}-${String(localTime.getDate()).padStart(2, '0')}`;
}

// แปลงข้อความกะ (ไทย/อังกฤษ/ตัวย่อ) → คีย์มาตรฐานที่ staff_list ใช้: morning | noon | night
// คืน null ถ้าระบุไม่ได้ (กันการเขียนค่ามั่ว)
function resolveShiftKey(raw) {
    const s = (raw || '').toString().trim().toLowerCase();
    if (!s || s === 'คงเดิม' || s === 'same' || s === 'keep') return null;
    if (s.includes('เช้า') || s.includes('morning') || s === 'm' || s === 'am') return 'morning';
    if (s.includes('เที่ยง') || s.includes('บ่าย') || s.includes('noon') || s.includes('afternoon') || s === 'n') return 'noon';
    if (s.includes('ดึก') || s.includes('กลางคืน') || s.includes('night') || s.includes('evening') || s === 'pm') return 'night';
    return null; // ระบุกะไม่ได้ → ไม่อัปเดต
}

// เทียบว่า "ชื่อคนลา" กับ "ชื่อพนักงาน" เป็นคนเดียวกันไหม — ใช้ token match (คำเต็ม) ไม่ใช่ substring หลวมๆ
// กันเคส เช่น "MIKA" ไปโดน "AMOL-MIKAEL" หรือชื่อแอดมินไปโดนพนักงานคนอื่น
function isSamePerson(staffNameUpper, leaveNameUpper) {
    const s = (staffNameUpper || '').trim();
    const l = (leaveNameUpper || '').trim();
    if (!s || !l) return false;
    if (s === l) return true;
    const sTokens = s.split(/[-_/\s]+/).filter(Boolean);
    const lTokens = l.split(/[-_/\s]+/).filter(Boolean);
    // ชื่อลาเป็นคำเดียว → ต้องตรงกับ token ใด token หนึ่งของชื่อพนักงาน เช่น "MIKA" ∈ {ODOL, MIKA}
    if (lTokens.length === 1 && sTokens.includes(lTokens[0])) return true;
    // กรณีกลับกัน: ชื่อพนักงานเป็นคำเดียว → ตรงกับ token ของชื่อลา
    if (sTokens.length === 1 && lTokens.includes(sTokens[0])) return true;
    return false;
}


// ==========================================
// 🕐 Helper: ช่วงเวลาเช็คอินแต่ละกะ
// เช้า: 07:49-19:49 | เที่ยง: 10:49-23:49 | ดึก: 19:49-07:49
// ==========================================
function getActiveShifts(thaiTime) {
    const totalMin = thaiTime.getHours() * 60 + thaiTime.getMinutes();
    const active = [];
    if (totalMin >= 7*60+49 && totalMin < 19*60+49) active.push('morning');
    if (totalMin >= 10*60+49) active.push('noon');
    if (totalMin >= 19*60+49 || totalMin < 7*60+49) active.push('night');
    return active;
}

async function processAutoShiftSwaps() {
    try {
        console.log("🔄 [AutoSwap] กำลังตรวจสอบตารางย้ายกะ...");

        if (!supabaseLeave) {
            console.warn("⚠️ [AutoSwap] supabaseLeave = null → ไม่ได้ตั้ง SUPABASE_LEAVE_URL / SUPABASE_LEAVE_KEY (หรือค่าว่าง)");
            return;
        }

        const now = new Date();
        const leaveHost = (supabaseLeaveUrl || '').replace(/^https?:\/\//, '').split('.')[0];

        // ดึงงาน "ล่าสุด" สูงสุด 500 แถว (ทุก status) โดยไม่จำกัดช่วงวัน
        // เหตุผล: ถ้าบอทดับนาน (เป็นเดือน) งานย้ายกะล่าสุดจะเก่ากว่า 7 วัน ต้องดึงมากู้ให้ได้
        // เรียงใหม่→เก่า เอา 500 แถวล่าสุด แล้วค่อย reverse เป็นเก่า→ใหม่ตอนประมวลผล (คำสั่งล่าสุดของแต่ละคนชนะ)
        const { data: recent, error } = await supabaseLeave
            .from('scheduled_tasks')
            .select('*')
            .order('scheduled_for', { ascending: false })
            .limit(500);

        if (error) {
            console.error(`❌ [AutoSwap] อ่านตาราง scheduled_tasks ไม่ได้ (project=${leaveHost} | RLS บล็อก / ชี้ผิดโปรเจกต์?):`, error.message || error);
            return;
        }
        if (!recent || recent.length === 0) {
            console.warn(`⚠️ [AutoSwap] project=${leaveHost} | ตาราง scheduled_tasks ว่าง (0 แถว) → ระบบภายนอกไม่ได้เขียนที่นี่ / ชี้ผิดโปรเจกต์ / RLS บล็อก`);
            return;
        }
        const tasks = recent.slice().reverse(); // เก่า→ใหม่
        console.log(`🩺 [AutoSwap] project=${leaveHost} | ดึงงานล่าสุดได้ ${tasks.length} แถว (ทุก status, ไม่จำกัดช่วงวัน)`);

        // สรุปให้เห็นว่าจริงๆ มี task_type/status อะไรบ้าง (ช่วย debug)
        const summary = {};
        for (const t of tasks) { const k = `${t.task_type}|${t.status}`; summary[k] = (summary[k] || 0) + 1; }
        console.log("🩺 [AutoSwap] task_type|status ที่เจอ:", JSON.stringify(summary));

        const SKIP_STATUS = ['cancelled', 'canceled', 'failed', 'rejected', 'deleted', 'error'];
        let applied = 0;

        for (const task of tasks) {
            if (processedTasks.has(task.id)) continue; // apply ครั้งเดียวต่อ task (กันการทับการแก้มือซ้ำๆ)

            const ttype = (task.task_type || '').toLowerCase();
            const tstatus = (task.status || '').toLowerCase();

            // รับเฉพาะงานที่เกี่ยวกับ "ย้ายกะ" (ครอบคลุมชื่อ type ที่อาจต่างกัน) และข้ามงานที่ยกเลิก/ล้มเหลว
            const isShiftTask = ttype.includes('shift') || ttype.includes('กะ');
            if (!isShiftTask || SKIP_STATUS.includes(tstatus)) { processedTasks.add(task.id); continue; }

            // เฉพาะงานที่ถึงเวลาแล้ว (กันการ apply งานอนาคตก่อนกำหนด) — ไม่มี scheduled_for ถือว่าถึงเวลา
            if (task.scheduled_for && new Date(task.scheduled_for).getTime() > now.getTime()) continue; // ยังไม่ถึงเวลา อย่าเพิ่ง mark ว่าทำแล้ว

            let p = task.payload;
            if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
            p = p || {};

            const targetName = (p.user_name || p.name || p.staff_name || p.employee || p.username || '').toString().trim();
            const targetDiscordId = (p.discord_id || p.discordId || p.user_id || p.userId || '').toString().trim();
            const newShiftKey = resolveShiftKey(p.target_shift || p.shift || p.new_shift || p.to_shift || p.shift_name);

            if ((!targetName && !targetDiscordId) || !newShiftKey) {
                console.log(`   ⏭️ ข้าม task ${task.id} (type=${task.task_type}): payload ไม่ครบ name="${targetName}" id="${targetDiscordId}" shift="${p.target_shift || p.shift || p.new_shift || p.to_shift || p.shift_name || ''}"`);
                processedTasks.add(task.id);
                continue;
            }

            // หาพนักงาน — ลำดับความแม่น: discord_id > ชื่อตรงเป๊ะ > ชื่อบางส่วน
            // ถ้าชื่อบางส่วนเจอหลายคน = กำกวม → ข้าม (กันอัปเดตผิดคน เช่น "ต้น" ไปโดน "ต้นน้ำ")
            let matched = [];
            let matchMode = '';
            if (targetDiscordId) {
                const { data } = await supabase.from('staff_list').select('discord_id, staff_name').eq('discord_id', targetDiscordId);
                if (data && data.length) { matched = data; matchMode = 'discord_id'; }
            }
            if (matched.length === 0 && targetName) {
                const { data: exact } = await supabase.from('staff_list').select('discord_id, staff_name').ilike('staff_name', targetName);
                if (exact && exact.length) { matched = exact; matchMode = 'ชื่อตรงเป๊ะ'; }
                else {
                    const { data: partial } = await supabase.from('staff_list').select('discord_id, staff_name').ilike('staff_name', `%${targetName}%`);
                    if (partial && partial.length === 1) { matched = partial; matchMode = 'ชื่อบางส่วน'; }
                    else if (partial && partial.length > 1) {
                        // กำกวม → คัดด้วย "token": แยก staff_name ด้วย - / _ เว้นวรรค แล้วหาคนที่มีชื่อเป้าหมายเป็น "คำเต็ม" พอดี
                        // เช่น "MIKA" → "ODOL-MIKA" (มี token MIKA = ใช่) / "AMOL-MIKAEL" (token MIKAEL ≠ MIKA = ไม่ใช่)
                        const tnUpper = targetName.toUpperCase();
                        const tokenHits = partial.filter(x =>
                            (x.staff_name || '').toUpperCase().split(/[-_/\s]+/).includes(tnUpper)
                        );
                        if (tokenHits.length === 1) { matched = tokenHits; matchMode = 'token'; }
                        else {
                            console.warn(`   ⚠️ task ${task.id}: ชื่อ "${targetName}" กำกวม เจอ ${partial.length} คน (${partial.map(x => x.staff_name).join(', ')})${tokenHits.length > 1 ? ` | token ยังซ้ำ ${tokenHits.length} คน` : ''} → ข้าม กันอัปเดตผิดคน`);
                            processedTasks.add(task.id);
                            continue;
                        }
                    }
                }
            }

            if (matched.length === 0) {
                console.warn(`   ⚠️ task ${task.id}: หาพนักงานไม่เจอใน staff_list (name="${targetName}", id="${targetDiscordId}") → ไม่อัปเดต`);
                processedTasks.add(task.id);
                continue;
            }

            for (const staff of matched) {
                await supabase.from('staff_list').update({ shift: newShiftKey }).eq('discord_id', staff.discord_id);
            }
            applied++;
            console.log(`   ↪️ [${task.scheduled_for}] "${targetName || targetDiscordId}" → ${newShiftKey} (match=${matchMode}, ${matched.length} คน)`);
            processedTasks.add(task.id);
        }

        console.log(`💾 [AutoSwap] ตรวจสอบเสร็จ — อัปเดตกะไป ${applied} รายการ`);
    } catch (err) {
        console.error("❌ [AutoSwap] Error:", err);
    }
}

async function getLeavesFromSupabase(department = 'ALL') {
    const targetDate = getSupabaseDateStr();
    let result = { morning: [], noon: [], night: [] };
    if (!supabaseLeave) return result; 

    try {
        // 🛑 แก้ไข 1: เปลี่ยนมาดึงจากตาราง leave_requests และกรองเฉพาะคนที่ status เป็น 'approved'
        const { data, error } = await supabaseLeave
            .from('leave_requests') 
            .select('id, user_name, reason, status') 
            .eq('leave_date', targetDate)
            .eq('status', 'approved')
            .order('id', { ascending: true });
            
        if (error) return result;

        let activeLeaves = {};
        if (data) {
            for (const row of data) {
                if (row.user_name) {
                    const leaveName = row.user_name.trim(); 
                    // 🛑 แก้ไข 2: ใช้ reason แทน action_type เพื่อเช็คสาเหตุการลา
                    activeLeaves[leaveName] = row.reason ? row.reason.trim() : 'XX'; 
                }
            }
        }

        const onLeaveUsers = Object.keys(activeLeaves);
        const staffData = await fetchStaffData();

        onLeaveUsers.forEach(leaveName => {
            let shiftFound = null; let userDeptFound = null; 
            const cleanLeaveName = leaveName.toUpperCase();

            for (const dept in staffData) {
                if (staffData[dept].morning) {
                    for (const id in staffData[dept].morning) {
                        const staffName = staffData[dept].morning[id].trim().toUpperCase();
                        if (isSamePerson(staffName, cleanLeaveName)) { shiftFound = 'morning'; userDeptFound = dept; break; }
                    }
                }
                if (!shiftFound && staffData[dept].noon) {
                    for (const id in staffData[dept].noon) {
                        const staffName = staffData[dept].noon[id].trim().toUpperCase();
                        if (isSamePerson(staffName, cleanLeaveName)) { shiftFound = 'noon'; userDeptFound = dept; break; }
                    }
                }
                if (!shiftFound && staffData[dept].night) {
                    for (const id in staffData[dept].night) {
                        const staffName = staffData[dept].night[id].trim().toUpperCase();
                        if (isSamePerson(staffName, cleanLeaveName)) { shiftFound = 'night'; userDeptFound = dept; break; }
                    }
                }
                if (shiftFound) break;
            }

            if (department !== 'ALL' && userDeptFound && userDeptFound.toUpperCase() !== department.toUpperCase()) return; 

            // 🌟 [แก้บั๊ก] รองรับ 4 ประเภทการลาตามที่กำหนดในระบบ
            // X = หยุดปกติ, XX = สับกะ, KL = ลากิจ, PN = พักร้อน
            const rawAction = activeLeaves[leaveName].toUpperCase().trim();
            let leaveType = "วันหยุด"; // default fallback
            if (rawAction === 'KL' || rawAction.includes('KL')) leaveType = "ลากิจ";
            else if (rawAction === 'PN' || rawAction.includes('PN')) leaveType = "พักร้อน";
            else if (rawAction === 'XX' || rawAction.includes('XX')) leaveType = "สับกะ";
            else if (rawAction === 'X') leaveType = "วันหยุด";

            const leaveData = { name: leaveName, type: leaveType };
            if (shiftFound === 'morning') result.morning.push(leaveData);
            else if (shiftFound === 'noon') result.noon.push(leaveData);
            else if (shiftFound === 'night') result.night.push(leaveData);
        });

        return result;
    } catch (e) { return result; }
}

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
            const dateTh = getThaiDateStr(); 
            const checkedIds = new Set(session.members.map(m => m.id));

            const shiftTypeLower = session.shiftType ? session.shiftType.toLowerCase() : '';
            const leavesObj = await getLeavesFromSupabase(session.department);

            // ดึงข้อมูลพนักงานจาก Supabase ล่าสุด
            const staffDataObj = await fetchStaffData();

            let shiftIcon = "☀️ กะเช้า";
            let currentShiftLeaves = leavesObj.morning || [];

            if (shiftTypeLower.includes('night') || shiftTypeLower.includes('ดึก')) {
                shiftIcon = "🌙 กะดึก";
                currentShiftLeaves = leavesObj.night || [];
            } 
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
                    const noonShift = session.members.filter(m => m.shift.includes("กะเที่ยง")); // 🌟 เพิ่มกะเที่ยง
                    const nightShift = session.members.filter(m => m.shift.includes("กะดึก"));

                    if (morningShift.length > 0) {
                        summary += `\n☀️ **กะเช้า:**\n`;
                        morningShift.forEach((m, i) => {
                            const HH = m.time.getHours().toString().padStart(2, '0');
                            const MM = m.time.getMinutes().toString().padStart(2, '0');
                            summary += `   ${i + 1}. **${m.name}** (เวลา ${HH}:${MM} น.)\n`;
                        });
                    }
                    // 🌟 เพิ่มบล็อกสำหรับแสดงผลกะเที่ยง
                    if (noonShift.length > 0) {
                        summary += `\n🕛 **กะเที่ยง:**\n`;
                        noonShift.forEach((m, i) => {
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

                // 🌟 [ใหม่] แยกรายชื่อเป็น 4 หมวดตามประเภทการลา
                const dayOffs = currentShiftLeaves.filter(l => l.type === "วันหยุด");
                const swapShift = currentShiftLeaves.filter(l => l.type === "สับกะ");
                const klLeaves = currentShiftLeaves.filter(l => l.type === "ลากิจ");
                const vacations = currentShiftLeaves.filter(l => l.type === "พักร้อน");

                summary += `\n😴 **รายชื่อหยุดปกติ (${shiftIcon}):**\n`;
                if (dayOffs.length > 0) {
                    dayOffs.forEach((l, i) => summary += `   ${i + 1}. **${l.name}**\n`);
                } else { summary += `- ไม่มี -\n`; }

                summary += `\n🔄 **รายชื่อสับกะ (${shiftIcon}):**\n`;
                if (swapShift.length > 0) {
                    swapShift.forEach((l, i) => summary += `   ${i + 1}. **${l.name}**\n`);
                } else { summary += `- ไม่มี -\n`; }

                summary += `\n📝 **รายชื่อลากิจ (${shiftIcon}):**\n`;
                if (klLeaves.length > 0) {
                    klLeaves.forEach((l, i) => summary += `   ${i + 1}. **${l.name}**\n`);
                } else { summary += `- ไม่มี -\n`; }

                summary += `\n🏖️ **รายชื่อพักร้อน (${shiftIcon}):**\n`;
                if (vacations.length > 0) {
                    vacations.forEach((l, i) => summary += `   ${i + 1}. **${l.name}**\n`);
                } else { summary += `- ไม่มี -\n`; }

                let missingMembers = [];
                const departmentVoiceRooms = new Set();
                // 🌟 [แก้บั๊ก] ใช้ voice channel ที่บันทึกตอน !checkin (ไม่ใช่ปัจจุบัน)
                // เพราะหลังเช็คชื่อแล้ว พนักงานอาจย้ายไปห้องเสียงอื่น (เช่น ไปช่วยงานห้องอื่น)
                // ถ้าใช้ voiceStates.cache ตอนสรุป → จะไปสแกนห้องอื่นที่ไม่เกี่ยวกับ session นี้
                session.members.forEach(m => {
                    if (m.voiceChannelId) {
                        departmentVoiceRooms.add(m.voiceChannelId);
                    } else {
                        // fallback สำหรับ session เก่าที่ยังไม่มี voiceChannelId
                        const vs = guild.voiceStates.cache.get(m.id);
                        if (vs?.channelId) departmentVoiceRooms.add(vs.channelId);
                    }
                });

                departmentVoiceRooms.forEach(vId => {
                    const vRoom = guild.channels.cache.get(vId);
                    if (vRoom) {
                        vRoom.members.forEach(member => {
                            const staffName = getStaffName(member.id, member.displayName, staffDataObj);
                            const cleanName = staffName.trim().toUpperCase();

                            let isLeave = false;
                            for (const lData of currentShiftLeaves) { 
                                if (cleanName.includes(lData.name.toUpperCase())) { isLeave = true; break; }
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
                    // --- ส่วนที่แก้ไข: ดึงข้อมูลสดใหม่ทุกครั้งก่อนสรุปยอด ---
                    const currentStaffData = await fetchStaffData(); 
                    // ----------------------------------------------
                    let shiftKey = 'morning';
                    const sType = session.shiftType ? session.shiftType.toLowerCase() : '';
                    if (sType.includes('ดึก') || sType.includes('night')) shiftKey = 'night';
                    else if (sType.includes('เที่ยง') || sType.includes('noon')) shiftKey = 'noon';

                    let shiftStaff = {};
                    const targetDept = session.department.toUpperCase(); 

                    if (targetDept === 'ALL') {
                        for (const dept in staffDataObj) {
                            if (staffDataObj[dept] && staffDataObj[dept][shiftKey]) Object.assign(shiftStaff, staffDataObj[dept][shiftKey]);
                        }
                    } else {
                        if (staffDataObj[targetDept] && staffDataObj[targetDept][shiftKey]) shiftStaff = staffDataObj[targetDept][shiftKey];
                    }

                    let safeLeaves = [];
                    if (Array.isArray(leavesObj)) safeLeaves = leavesObj;
                    else if (leavesObj && Array.isArray(leavesObj[shiftKey])) safeLeaves = leavesObj[shiftKey];
                    else if (leavesObj && Array.isArray(leavesObj.night)) safeLeaves = leavesObj.night;

                    for (const [staffId, staffName] of Object.entries(shiftStaff)) {
                        let isLeave = false;
                        for (const lData of safeLeaves) {
                            if (lData && lData.name && staffName.toUpperCase().includes(lData.name.toUpperCase())) {
                                isLeave = true; break;
                            }
                        }
                        if (!checkedIds.has(staffId) && !isLeave) absentMembers.push(staffName);
                    }
                } catch (error) {}

                if (absentMembers.length > 0) {
                    summary += `\n❓ **พนักงานที่หายตัวไป (ไม่มีชื่อลา & ไม่ได้เช็คชื่อ):**\n`;
                    absentMembers.forEach((name, i) => { summary += `   ${i + 1}. **${name}**\n`; });
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

// ==========================================
// 🤖 โซน Discord Bot ทำงาน
// ==========================================

const client = new Client({
    intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent ]
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const channelId = message.channel.id;

    if (message.content === '!autoon') {
        const hasPermission = message.member.roles.cache.some(role => ['PTT', 'TT HAED', 'TT HEAD'].includes(role.name.toUpperCase()));
        if (!hasPermission) return message.reply('❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้ค่ะ');
        dataStore.autoCheckinEnabled = true; saveData();
        return message.reply('✅ **เปิด** ระบบแจ้งเตือนเช็คชื่ออัตโนมัติ เรียบร้อยแล้วค่ะ'); 
    }

    if (message.content === '!autooff') {
        const hasPermission = message.member.roles.cache.some(role => ['PTT', 'TT HAED', 'TT HEAD'].includes(role.name.toUpperCase()));
        if (!hasPermission) return message.reply('❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้ค่ะ');
        dataStore.autoCheckinEnabled = false; saveData();
        return message.reply('🛑 **ปิด** ระบบแจ้งเตือนเช็คชื่ออัตโนมัติแล้วค่ะ');
    }

    if (message.content.startsWith('!removestaff')) {
        const hasPermission = message.member.roles.cache.some(role => ['PTT', 'TT HAED', 'TT HEAD'].includes(role.name.toUpperCase()));
        if (!hasPermission) return message.reply('❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้ค่ะ');

        const argsText = message.content.replace('!removestaff', '').trim();
        if (!argsText) return message.reply('⚠️ **วิธีใช้:** `!removestaff @แท็กพนักงาน` หรือ `!removestaff ชื่อพนักงาน`');

        const targetUser = message.mentions.users.first();
        let removedName = null;

        if (targetUser) {
            // ค้นหาด้วยคอลัมน์ staff_name
            const { data } = await supabase.from('staff_list').select('staff_name').eq('discord_id', targetUser.id).single();
            if (data) removedName = data.staff_name;
            await supabase.from('staff_list').delete().eq('discord_id', targetUser.id);
        } else {
            const searchName = argsText.replace('@', '').trim(); 
            // ค้นหาด้วยคอลัมน์ staff_name
            const { data } = await supabase.from('staff_list').select('*').ilike('staff_name', `%${searchName}%`);
            if (data && data.length > 0) {
                removedName = data[0].staff_name;
                await supabase.from('staff_list').delete().eq('discord_id', data[0].discord_id);
            }
        }

        if (removedName) {
            return message.reply(`🗑️ **ลบพนักงานสำเร็จ!**\nถอดรายชื่อ **${removedName}** ออกจากระบบเรียบร้อยแล้วค่ะ`);
        } else { return message.reply('⚠️ ไม่พบรายชื่อพนักงานคนนี้ในระบบค่ะ'); }
    }

    if (message.content.startsWith('!addstaff')) {
        const hasPermission = message.member.roles.cache.some(role => ['PTT', 'TT HAED', 'TT HEAD'].includes(role.name.toUpperCase()));
        if (!hasPermission) return message.reply('❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้ค่ะ');

        const args = message.content.split(/\s+/);
        if (args.length < 5) return message.reply('⚠️ **วิธีใช้:** `!addstaff @แท็กพนักงาน <AMOL/ODOL> <เช้า/เที่ยง/ดึก> <ชื่อพนักงาน>`');

        const targetUser = message.mentions.users.first();
        if (!targetUser) return message.reply('❌ กรุณาแท็ก (@) พนักงานที่ต้องการเพิ่มด้วยค่ะ');

        const dept = args[2].toUpperCase();
        if (dept !== 'AMOL' && dept !== 'ODOL') return message.reply('❌ แผนกต้องเป็น `AMOL` หรือ `ODOL` เท่านั้นค่ะ');

        const shiftInput = args[3];
        let shift = '';
        if (shiftInput === 'เช้า' || shiftInput.toLowerCase() === 'morning') shift = 'morning';
        else if (shiftInput === 'ดึก' || shiftInput.toLowerCase() === 'night') shift = 'night';
        else if (shiftInput === 'เที่ยง' || shiftInput.toLowerCase() === 'noon') shift = 'noon';
        else return message.reply('❌ กะต้องระบุเป็น `เช้า`, `เที่ยง` หรือ `ดึก` เท่านั้นค่ะ');

        const staffName = args.slice(4).join(' '); 
        const staffId = targetUser.id;

        // บันทึกลง staff_list และใช้คอลัมน์ staff_name
        const { error } = await supabase.from('staff_list').upsert({
            discord_id: staffId,
            staff_name: staffName,
            department: dept,
            shift: shift
        });

        if (error) return message.reply('❌ เกิดข้อผิดพลาดในการบันทึกข้อมูลพนักงานลง Supabase');
        return message.reply(`✅ **บันทึกข้อมูลพนักงานสำเร็จ!**\n👤 ชื่อ: **${staffName}**\n🏢 แผนก: **${dept}**\n⏱️ กะ: **${shift === 'morning' ? 'เช้า ☀️' : (shift === 'noon' ? 'เที่ยง 🕛' : 'ดึก 🌙')}**`);
    }

    if (message.content === '!exportstaff') {
        const statusMsg = await message.reply('⏳ กำลังรวบรวมข้อมูล ID พนักงานทั้งหมด...');
        await message.guild.members.fetch();
        let staffShifts = { AMOL: { morning: {}, night: {} }, ODOL: { morning: {}, night: {} } };
        message.guild.members.cache.forEach(member => {
            if (member.user.bot) return; 
            const name = member.displayName; const id = member.id;
            let isAMOL = member.roles.cache.some(r => r.name.toUpperCase().includes('AMOL'));
            let isODOL = member.roles.cache.some(r => r.name.toUpperCase().includes('ODOL'));
            if (isAMOL) staffShifts.AMOL.morning[id] = name;
            if (isODOL) staffShifts.ODOL.morning[id] = name;
        });
        fs.writeFileSync('staff_template.json', JSON.stringify(staffShifts, null, 2));
        const { AttachmentBuilder } = require('discord.js');
        const file = new AttachmentBuilder('staff_template.json');
        await statusMsg.edit('✅ **ดูดข้อมูลพนักงานทั้งหมดเรียบร้อยแล้ว!** \nไฟล์นี้มี **ID คู่กับชื่อ** ให้แล้วครับ 👇');
        return message.channel.send({ files: [file] });
    }

    if (message.content === '!resettest') {
        const hasPermission = message.member.roles.cache.some(role => ['PTT', 'TT HAED', 'TT HEAD'].includes(role.name.toUpperCase()));
        if (!hasPermission) return message.reply('❌ อย่ากดมั่ว');
        delete dataStore.lastCheckinDates[channelId];
        activeSessions.delete(channelId);
        saveData();
        return message.reply(`🔄 **รีเซ็ตระบบสำหรับห้องนี้เรียบร้อย!** เริ่มทดสอบใหม่ได้เลยค่ะ`);
    }

    if (message.content === '!testswap') {
        const hasPermission = message.member.roles.cache.some(role => ['PTT', 'TT HAED', 'TT HEAD'].includes(role.name.toUpperCase()));
        if (!hasPermission) return message.reply('❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้ค่ะ');
        const statusMsg = await message.reply('⏳ กำลังทดสอบซิงค์กะตามหน้าเว็บ...');
        try {
            await processAutoShiftSwaps(); 
            statusMsg.edit('✅ **ซิงค์กะตามเว็บเสร็จสิ้น!**');
        } catch (e) { statusMsg.edit(`❌ เกิดข้อผิดพลาด: ${e.message}`); }
        return;
    }

    if (message.content === '!checkleave') {
        const todayStr = getThaiDateStr(); 
        let department = "ALL";
        if (message.channel.name.toUpperCase().includes('ODOL')) department = "ODOL";
        else if (message.channel.name.toUpperCase().includes('AMOL') || message.channel.name.includes('เช็คชื่อ')) department = "AMOL";

        const leavesObj = await getLeavesFromSupabase(department); 
        let msg = `🔎 **ผลการตรวจสอบวันหยุดจากระบบ (วันที่ ${todayStr})**\n`;
        msg += `🏢 **แผนกที่ตรวจจับได้จากห้องนี้:** ${department === 'ALL' ? 'ทั้งหมด' : department}\n\n`;

        if (leavesObj.morning.length > 0 || leavesObj.noon.length > 0 || leavesObj.night.length > 0) {
            // 🌟 helper สร้าง label icon ตามประเภทการลา
            const formatLeaveItem = (l, i) => {
                let typeIcon = '(วันหยุด 😴)';
                if (l.type === 'ลากิจ') typeIcon = '(ลากิจ 📝)';
                else if (l.type === 'พักร้อน') typeIcon = '(พักร้อน 🏖️)';
                else if (l.type === 'สับกะ') typeIcon = '(สับกะ 🔄)';
                return `${i + 1}. ${l.name} ${typeIcon}`;
            };

            if (leavesObj.morning && leavesObj.morning.length > 0) {
                msg += `☀️ **กะเช้า (${leavesObj.morning.length} ท่าน):**\n` + leavesObj.morning.map(formatLeaveItem).join('\n') + `\n\n`;
            }
            if (leavesObj.noon && leavesObj.noon.length > 0) {
                msg += `🕛 **กะเที่ยง (${leavesObj.noon.length} ท่าน):**\n` + leavesObj.noon.map(formatLeaveItem).join('\n') + `\n\n`;
            }
            if (leavesObj.night && leavesObj.night.length > 0) {
                msg += `🌙 **กะดึก (${leavesObj.night.length} ท่าน):**\n` + leavesObj.night.map(formatLeaveItem).join('\n') + `\n\n`;
            }
        } else { msg += `⚠️ ไม่พบรายชื่อพนักงานหยุดของแผนกนี้ในวันนี้ค่ะ`; }
        return message.reply(msg);
    }

    if (message.content === '!addchannel') {
        if (dataStore.checkinChannels.includes(channelId)) return message.reply('⚠️ ห้องนี้ตั้งค่าเป็นจุดเช็คชื่อไว้แล้วค่ะ');
        dataStore.checkinChannels.push(channelId); saveData();
        return message.reply(`✅ ตั้งค่าห้อง <#${channelId}> เป็นจุดเช็คชื่อเรียบร้อยแล้วค่ะ`);
    }

    if (message.content === '!removechannel') {
        const index = dataStore.checkinChannels.indexOf(channelId);
        if (index > -1) {
            dataStore.checkinChannels.splice(index, 1); saveData();
            return message.reply(`🗑️ **ยกเลิก**การตั้งค่าห้อง <#${channelId}> เป็นจุดเช็คชื่อเรียบร้อยแล้วค่ะ`);
        } else { return message.reply('⚠️ ห้องนี้ไม่ได้ตั้งเป็นจุดเช็คชื่ออยู่แล้วค่ะ'); }
    }

    if (message.content.startsWith('!startcheckin')) {
        if (!dataStore.checkinChannels.includes(channelId)) return message.reply('❌ ห้องนี้ยังไม่ได้เป็นห้องเช็คชื่อ (พิมพ์ `!addchannel`ในห้องนี้ก่อนค่ะ)');

        const localTime = getThaiTime(); 
        const todayStr = getThaiDateStr(); 
        const currentHour = localTime.getHours();

        let shiftType = "Night";
        if (currentHour >= 6 && currentHour < 10) shiftType = "Morning";
        else if (currentHour >= 10 && currentHour < 14) shiftType = "Noon";
        else if (currentHour >= 14 && currentHour < 18) shiftType = "Afternoon";

        if (activeSessions.has(channelId)) return message.reply('⚠️ ระบบเช็คชื่อของห้องนี้กำลังทำงานอยู่แล้วค่ะ');

        let sessionDept = "ALL";
        const chName = message.channel.name.toUpperCase();
        if (chName.includes('ODOL')) sessionDept = "ODOL";
        else if (chName.includes('AMOL') || chName.includes('เช็คชื่อ')) sessionDept = "AMOL";

        const args = message.content.split(' ');
        const checkinDuration = parseInt(args[1]) || 10;

        activeSessions.set(channelId, {
            members: [], startTime: localTime, adminChannel: message.channel,
            department: sessionDept, jsonError: null, shiftType: shiftType,
            duration: checkinDuration 
        });

        const checkinKey = `${todayStr}-${shiftType}`;
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

        const member    = message.member;
        const localTime = getThaiTime();

        if (!member.voice.channelId || !member.voice.streaming)
            return message.reply('❌ คุณต้องเข้าห้องเสียงและแชร์หน้าจอด้วยค่ะ');

        const activeShifts = getActiveShifts(localTime);
        if (activeShifts.length === 0)
            return message.reply('❌ ขณะนี้ยังไม่เข้าช่วงเวลาของกะใดเลยค่ะ');

        const staffDataObj  = await fetchStaffData();
        const staffName     = getStaffName(member.id, member.displayName, staffDataObj);
        let   memberShiftKey = null;
        outer: for (const dept in staffDataObj) {
            for (const sk of ['morning', 'noon', 'night']) {
                if (staffDataObj[dept][sk]?.[member.id]) { memberShiftKey = sk; break outer; }
            }
        }

        if (memberShiftKey) {
            if (!activeShifts.includes(memberShiftKey)) {
                const shiftTH = memberShiftKey === 'morning' ? 'กะเช้า' : memberShiftKey === 'noon' ? 'กะเที่ยง' : 'กะดึก';
                return message.reply('❌ ยังไม่ถึงเวลาเข้างาน' + shiftTH + 'ค่ะ');
            }
            const today = getSupabaseDateStr();
            let startISO, endISO;
            const h = localTime.getHours(), m = localTime.getMinutes();
            if (memberShiftKey === 'morning') {
                startISO = new Date(today + 'T07:49:00+07:00').toISOString();
                endISO   = new Date(today + 'T19:49:00+07:00').toISOString();
            } else if (memberShiftKey === 'noon') {
                startISO = new Date(today + 'T10:49:00+07:00').toISOString();
                endISO   = new Date(today + 'T23:59:59+07:00').toISOString();
            } else {
                const base = new Date(localTime);
                if (h < 7 || (h === 7 && m < 49)) base.setDate(base.getDate() - 1);
                const bs = base.getFullYear() + '-' + String(base.getMonth()+1).padStart(2,'0') + '-' + String(base.getDate()).padStart(2,'0');
                const nx = new Date(base); nx.setDate(nx.getDate()+1);
                const ns = nx.getFullYear() + '-' + String(nx.getMonth()+1).padStart(2,'0') + '-' + String(nx.getDate()).padStart(2,'0');
                startISO = new Date(bs + 'T19:49:00+07:00').toISOString();
                endISO   = new Date(ns + 'T07:49:00+07:00').toISOString();
            }
            const { data: already } = await supabase.from('checkins').select('checkin_time')
                .eq('discord_id', member.id).gte('checkin_time', startISO).lte('checkin_time', endISO).limit(1);
            if (already && already.length > 0) {
                const prev = new Date(already[0].checkin_time);
                const HH = String(prev.getHours()).padStart(2,'0'), MM = String(prev.getMinutes()).padStart(2,'0');
                const shiftTH = memberShiftKey === 'morning' ? 'กะเช้า' : memberShiftKey === 'noon' ? 'กะเที่ยง' : 'กะดึก';
                return message.reply('✅ คุณเช็คอิน' + shiftTH + 'ไปแล้วเวลา **' + HH + ':' + MM + ' น.** ค่ะ ไม่สามารถเช็คซ้ำได้');
            }
        }

        const session   = activeSessions.get(channelId);
        const statusMsg = await message.reply('⏳ กำลังตรวจสอบ 10 วินาที...');
        setTimeout(async () => {
            try {
                // refetch member เพื่อให้ได้ค่า voice state ล่าสุด
                const freshMember = await message.guild.members.fetch(member.id).catch(() => null);
                if (!freshMember || !freshMember.voice.streaming) {
                    return statusMsg.edit('❌ เช็คชื่อล้มเหลว: ปิดแชร์หน้าจอก่อนเวลาค่ะ');
                }
                const checkinTime = getThaiTime();
                const sType = session?.shiftType?.toLowerCase() || memberShiftKey || 'morning';
                let shiftName = 'กะเช้า ☀️';
                if (sType.includes('night') || sType.includes('ดึก') || memberShiftKey === 'night') shiftName = 'กะดึก 🌙';
                else if (sType.includes('noon') || sType.includes('เที่ยง') || memberShiftKey === 'noon') shiftName = 'กะเที่ยง 🕛';
                const totalMin = checkinTime.getHours()*60 + checkinTime.getMinutes();
                let lateMin = 0;
                if (memberShiftKey === 'morning' && totalMin > 8*60) lateMin = totalMin - 8*60;
                else if (memberShiftKey === 'noon' && totalMin > 11*60) lateMin = totalMin - 11*60;
                else if (memberShiftKey === 'night' && totalMin > 20*60) lateMin = totalMin - 20*60;
                const lateText = lateMin > 0 ? ' ⏰ **สาย ' + lateMin + ' นาที**' : ' ✅ ตรงเวลา';
                const voiceChId = freshMember.voice.channelId || member.voice.channelId;
                if (session && !session.members.some(m => m.id === member.id))
                    session.members.push({ id: member.id, name: staffName, time: checkinTime, shift: shiftName, voiceChannelId: voiceChId, lateMin });
                await supabase.from('checkins').insert([{
                    discord_id: member.id, name: staffName, checkin_time: checkinTime, shift: shiftName, late_minutes: lateMin
                }]).catch(e => console.error('❌ Supabase checkin Error:', e));
                const orderText = session ? ' (ลำดับที่ ' + session.members.length + ')' : ' (มาสาย)';
                statusMsg.edit('✅ **เช็คชื่อสำเร็จ!** คุณอยู่ **' + shiftName + '**' + lateText + orderText);
            } catch (err) { console.error(err); }
        }, 10000);
    }

    // ── !kpi ──────────────────────────────────────────────────────────────
    if (message.content.startsWith('!kpi') && !message.content.startsWith('!kpiteam')) {
        const args   = message.content.split(/\s+/);
        const mode   = args[1]?.toLowerCase() === 'month' ? 'month' : 'week';
        const target = message.mentions.users.first();
        const isHead = message.member.roles.cache.some(r => ['PTT', 'TT HAED', 'TT HEAD'].includes(r.name.toUpperCase()));
        if (target && !isHead) return message.reply('❌ ไม่มีสิทธิ์ดู KPI คนอื่นค่ะ');
        const now = new Date();
        let startDate, endDate, label;
        if (mode === 'month') {
            startDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
            endDate   = now.toISOString().split('T')[0];
            label     = `รายเดือน (${now.toLocaleString('th-TH', { month: 'long', year: 'numeric' })})`;
        } else {
            const past = new Date(now.getTime() - 6*24*60*60*1000);
            startDate  = past.toISOString().split('T')[0];
            endDate    = now.toISOString().split('T')[0];
            label      = 'รายสัปดาห์';
        }
        const staffData = await fetchStaffData();
        let kpiStaffName;
        if (target) {
            outer2: for (const dept in staffData) {
                for (const shift of ['morning','noon','night']) {
                    if (staffData[dept][shift]?.[target.id]) { kpiStaffName = staffData[dept][shift][target.id]; break outer2; }
                }
            }
            if (!kpiStaffName) return message.reply('❌ ไม่พบพนักงานคนนี้ในระบบค่ะ');
        } else {
            outer3: for (const dept in staffData) {
                for (const shift of ['morning','noon','night']) {
                    if (staffData[dept][shift]?.[message.author.id]) { kpiStaffName = staffData[dept][shift][message.author.id]; break outer3; }
                }
            }
            if (!kpiStaffName) return message.reply('❌ ไม่พบชื่อคุณในระบบค่ะ กรุณาติดต่อหัวหน้า');
        }
        const waiting   = await message.reply('⏳ กำลังคำนวณ KPI...');
        const shortName = kpiStaffName.replace(/^(AMOL|ODOL)[-\s]/i, '').trim();
        const kpiResult = await calcKPI(shortName, startDate, endDate);
        await waiting.edit(buildKPIMessage(kpiStaffName, kpiResult, label));
        return;
    }

    // ── !kpiteam ──────────────────────────────────────────────────────────
    if (message.content.startsWith('!kpiteam')) {
        const isHead = message.member.roles.cache.some(r => ['PTT', 'TT HAED', 'TT HEAD'].includes(r.name.toUpperCase()));
        if (!isHead) return message.reply('❌ ไม่มีสิทธิ์ใช้คำสั่งนี้ค่ะ');
        const args = message.content.split(/\s+/);
        const dept = args[1]?.toUpperCase() || 'AMOL';
        const mode = args[2]?.toLowerCase() === 'month' ? 'month' : 'week';
        const now  = new Date();
        let startDate, endDate, label;
        if (mode === 'month') {
            startDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
            endDate   = now.toISOString().split('T')[0];
            label     = 'รายเดือน';
        } else {
            const past = new Date(now.getTime() - 6*24*60*60*1000);
            startDate  = past.toISOString().split('T')[0];
            endDate    = now.toISOString().split('T')[0];
            label      = 'รายสัปดาห์';
        }
        const waiting = await message.reply(`⏳ กำลังสร้างรายงาน KPI แผนก ${dept}...`);
        const text    = await buildTeamKPIMessage(dept, startDate, endDate, label);
        await waiting.edit(text.slice(0, 2000));
        return;
    }
});

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

        let currentSlot = null;
        for (let i = 0; i < scheduleTimes.length; i++) {
            if (typeof scheduleTimes[i] === 'string') {
                if (scheduleTimes[i] === currentTimeStr) {
                    let autoShift = "night";
                    if (currentHour >= 6 && currentHour < 10) autoShift = "morning";
                    else if (currentHour >= 10 && currentHour < 14) autoShift = "noon";
                    else if (currentHour >= 14 && currentHour < 18) autoShift = "afternoon";

                    currentSlot = { time: currentTimeStr, shift: autoShift }; break;
                }
            } else if (scheduleTimes[i].time === currentTimeStr) {
                currentSlot = scheduleTimes[i]; break;
            }
        }

        if (!currentSlot) return; 

        console.log(`⏰ ถึงเวลา ${currentTimeStr} เปิดระบบเช็คชื่ออัตโนมัติ กะ: ${currentSlot.shift}`);
        const todayStr = getThaiDateStr();
        const shiftTypeLower = currentSlot.shift ? currentSlot.shift.toLowerCase() : 'morning';
        let shiftType = shiftTypeLower === 'morning' ? "Morning" : "Night";
        let shiftLabel = "☀️ กะเช้า";

        if (shiftTypeLower === 'night' || shiftTypeLower === 'ดึก') { shiftType = "Night"; shiftLabel = "🌙 กะดึก"; } 
        else if (shiftTypeLower === 'noon' || shiftTypeLower === 'afternoon' || shiftTypeLower === 'เที่ยง') { shiftType = "Noon"; shiftLabel = "🕛 กะเที่ยง"; }

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

                // 🌟 คำนวณระยะเวลาเช็คชื่อจาก endTime ที่ผู้ดูแลตั้งไว้ในแดชบอร์ด
                //    ถ้าไม่ได้ตั้ง endTime จะ fallback เป็น 10 นาทีตามค่าเดิม
                let checkinDuration = 10;
                let displayEndTime = "ไม่ได้ระบุ";

                if (currentSlot.endTime && /^\d{1,2}:\d{2}$/.test(currentSlot.endTime) && currentSlot.time) {
                    const [sh, sm] = currentSlot.time.split(':').map(Number);
                    const [eh, em] = currentSlot.endTime.split(':').map(Number);
                    const startMin = sh * 60 + sm;
                    let endMin = eh * 60 + em;
                    if (endMin <= startMin) endMin += 24 * 60; // กรณีข้ามเที่ยงคืน
                    const diff = endMin - startMin;
                    if (diff >= 1 && diff <= 24 * 60) checkinDuration = diff;
                    displayEndTime = currentSlot.endTime;
                } else if (currentSlot.time) {
                    // ไม่มี endTime → fallback คำนวณจาก start + 10 นาที
                    const startObj = new Date(`1970/01/01 ${currentSlot.time}`);
                    startObj.setMinutes(startObj.getMinutes() + checkinDuration);
                    const endHH = String(startObj.getHours()).padStart(2, '0');
                    const endMM = String(startObj.getMinutes()).padStart(2, '0');
                    displayEndTime = `${endHH}:${endMM}`;
                }

                activeSessions.set(channelId, { 
                    members: [], startTime: localTime, adminChannel: channel, 
                    department: sessionDept, jsonError: null, shiftType: currentSlot.shift, 
                    duration: checkinDuration 
                });

                dataStore.lastCheckinDates[channelId] = checkinKey;
                saveData();

                const startEmbed = new EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle(`🔔 เริ่มเช็คชื่อพนักงาน แผนก: ${sessionDept === 'ALL' ? channel.name : sessionDept} (อัตโนมัติ)`)
                    .setDescription(`📅 **ประจำวันที่:** ${todayStr}\n⏰ **รอบเวลา:** ${currentTimeStr} น. (${shiftLabel})\n\n📢 **กติกา:**\n1. ต้องอยู่ในห้องเสียง\n2. ต้องแชร์หน้าจอ\n3. พิมพ์ \`!checkin\` ในห้องนี้\n\n⏱️ **เปิดรับเช็คชื่อถึงเวลา: ${displayEndTime} น.** (${checkinDuration} นาที)`)
                    .setTimestamp();

                await channel.send({ embeds: [startEmbed] });
                startSummaryTimer(channelId);
            } catch (error) { console.error(`❌ เกิดข้อผิดพลาดในการเปิดเช็คชื่อห้อง ${channelId}:`, error); }
        }
    }, { scheduled: true, timezone: "Asia/Bangkok" });
});

// ==========================================
// 🧹 ระบบแม่บ้าน: ยุบรวมยอดแชท (1 วัน/แถว) และลบขยะ
// ==========================================
setInterval(async () => {
    try {
        console.log('🧹 [Housekeeper] Compressing old chats and clearing database...');

        const { error } = await supabase.rpc('compress_old_activity');

        if (error) {
            console.error("❌ [Housekeeper] Compression failed:", error);
        } else {
            console.log('✅ [Housekeeper] Chat history compressed to 1 row/day. Database cleaned!');
        }
    } catch (e) {
        console.error("❌ [Housekeeper] System error:", e);
    }
}, 24 * 60 * 60 * 1000); 

// ==========================================
// 📊 ระบบปิดยอดรายสัปดาห์: ทำงานทุกวันจันทร์เวลา 00:01 น.
// ==========================================
cron.schedule('1 0 * * 1', async () => {
    try {
        console.log('📊 [Weekly Report] Starting weekly data aggregation...');

        const { error } = await supabase.rpc('generate_weekly_report');

        if (error) {
            console.error("❌ [Weekly Report] Aggregation failed:", error);
        } else {
            console.log('✅ [Weekly Report] Weekly stats saved successfully!');

            const adminChannel = await client.channels.fetch('1442466109503569992').catch(() => null);
            if (adminChannel) {
                adminChannel.send("📅 **[ระบบสรุปผลรายสัปดาห์]** บันทึกยอดรวมพนักงานทุกคนในสัปดาห์ที่ผ่านมาลงฐานข้อมูลเรียบร้อยแล้วค่ะ!");
            }
        }
    } catch (e) {
        console.error("❌ [Weekly Report] System error:", e);
    }
}, {
    scheduled: true,
    timezone: "Asia/Bangkok"
});



// ==========================================
// 📊 API สำหรับ KPI Dashboard (Web)
// ==========================================
app.post('/api/kpi-team', async (req, res) => {
    try {
        const { dept, mode } = req.body;
        const now = new Date();

        // วันเริ่มนับข้อมูล KPI (เริ่มนับจากวันนี้เป็นต้นไป)
        const KPI_START_DATE = '2026-06-28';

        let startDate, endDate;
        if (mode === 'month') {
            // ใช้วันที่ใหญ่กว่าระหว่าง KPI_START_DATE กับวันแรกของเดือน
            const monthStart = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-01';
            startDate = monthStart > KPI_START_DATE ? monthStart : KPI_START_DATE;
            endDate   = now.toISOString().split('T')[0];
        } else {
            const past = new Date(now.getTime() - 6*24*60*60*1000);
            const weekStart = past.toISOString().split('T')[0];
            startDate = weekStart > KPI_START_DATE ? weekStart : KPI_START_DATE;
            endDate   = now.toISOString().split('T')[0];
        }

        // ถ้าช่วงเวลาทั้งหมดอยู่ก่อน KPI_START_DATE ให้ return ข้อมูลว่าง
        if (startDate > endDate) {
            return res.json({ success: true, data: [], startDate, endDate, note: 'ยังไม่มีข้อมูล KPI' });
        }

        const start = new Date(startDate + 'T00:00:00+07:00').toISOString();
        const end   = new Date(endDate   + 'T23:59:59+07:00').toISOString();

        // ── ดึงข้อมูลทั้งหมดในครั้งเดียว ──
        const [staffDataObj, allCheckins, allAfk, allLeaves] = await Promise.all([
            fetchStaffData(),
            supabase.from('checkins')
                .select('discord_id, name, checkin_time, shift, late_minutes')
                .gte('checkin_time', start).lte('checkin_time', end),
            supabase.from('tracker_remarks').select('staff_name, afk_date')
                .gte('afk_date', startDate).lte('afk_date', endDate),
            supabase.from('leave_requests').select('user_name, leave_date')
                .eq('status', 'approved').gte('leave_date', startDate).lte('leave_date', endDate)
        ]);

        // ── สร้าง lookup maps ──
        const checkinMap = {}; // discord_id -> [{checkin_time, shift, late_minutes}]
        (allCheckins.data || []).forEach(c => {
            if (!checkinMap[c.discord_id]) checkinMap[c.discord_id] = [];
            checkinMap[c.discord_id].push(c);
        });

        const afkMap = {};
        (allAfk.data || []).forEach(r => {
            const key = (r.staff_name || '').toUpperCase().replace(/\s*\d+$/, '').trim();
            if (!afkMap[key]) afkMap[key] = new Set();
            afkMap[key].add(r.afk_date);
        });

        const leaveMap = {};
        (allLeaves.data || []).forEach(r => {
            const key = (r.user_name || '').toUpperCase().trim();
            leaveMap[key] = (leaveMap[key] || 0) + 1;
        });

        // workDays = จำนวนวันที่มีการเปิด session เช็คอินจริง (นับจาก KPI_START_DATE)
        const uniqueCheckinDates = new Set(
            (allCheckins.data || []).map(c => {
                const thai = new Date(new Date(c.checkin_time).getTime() + 7*60*60*1000);
                return thai.toISOString().split('T')[0];
            })
        );
        const workDays = uniqueCheckinDates.size || 1;

        // ── คำนวณ KPI แต่ละคน ──
        const results = [];
        const depts = dept === 'ALL' ? ['AMOL','ODOL'] : [dept.toUpperCase()];

        for (const d of depts) {
            const deptData = staffDataObj[d];
            if (!deptData) continue;
            for (const shift of ['morning','noon','night']) {
                if (!deptData[shift]) continue;
                for (const [discordId, name] of Object.entries(deptData[shift])) {
                    const shortName = name.replace(/^(AMOL|ODOL)[-\s]/i,'').trim().toUpperCase();

                    // เช็คอิน + ตรงเวลา + สาย
                    const myCheckins = checkinMap[discordId] || [];
                    const totalCheckins = myCheckins.length;
                    let onTime = 0, lateDays = 0;
                    myCheckins.forEach(c => {
                        const lateMin = parseInt(c.late_minutes || 0);
                        if (lateMin > 0) {
                            lateDays++;
                        } else {
                            const t = new Date(c.checkin_time);
                            const totalMin = t.getHours()*60 + t.getMinutes();
                            const s = (c.shift||'').toLowerCase();
                            if (s.includes('เช้า') && totalMin <= 8*60) onTime++;
                            else if (s.includes('เที่ยง') && totalMin <= 11*60) onTime++;
                            else if (s.includes('ดึก') && totalMin <= 20*60) onTime++;
                            else onTime++; // มาแต่ไม่ได้บันทึก late_minutes = ถือว่าตรงเวลา
                        }
                    });
                    const onTimePct = totalCheckins > 0 ? Math.round((onTime/totalCheckins)*100) : 0;

                    // AFK
                    let afkDays = 0;
                    for (const [key, dates] of Object.entries(afkMap)) {
                        const sTokens = shortName.split(/[-_\s]+/).filter(Boolean);
                        const kTokens = key.split(/[-_\s]+/).filter(Boolean);
                        if (sTokens.some(t => kTokens.includes(t)) || kTokens.some(t => sTokens.includes(t))) {
                            afkDays = dates.size; break;
                        }
                    }

                    // ลา
                    let leaveDays = 0;
                    for (const [key, count] of Object.entries(leaveMap)) {
                        const sTokens = shortName.split(/[-_\s]+/).filter(Boolean);
                        const kTokens = key.split(/[-_\s]+/).filter(Boolean);
                        if (sTokens.some(t => kTokens.includes(t)) || kTokens.some(t => sTokens.includes(t))) {
                            leaveDays = count; break;
                        }
                    }

                    // วันขาด = วันทำงาน - เช็คอิน - ลา (นับเฉพาะตั้งแต่ KPI_START_DATE)
                    const absentDays = Math.max(0, workDays - totalCheckins - leaveDays);

                    results.push({ name, dept: d, shift, totalCheckins, onTimePct, lateDays, afkDays, leaveDays, absentDays, workDays });
                }
            }
        }

        res.json({ success: true, data: results, startDate, endDate, kpiStartDate: KPI_START_DATE });
    } catch(e) {
        console.error('[KPI API]', e);
        res.status(500).json({ success: false, message: e.message });
    }
});


async function calcKPI(staffName, startDate, endDate) {
    const start = new Date(startDate + 'T00:00:00+07:00').toISOString();
    const end   = new Date(endDate   + 'T23:59:59+07:00').toISOString();
    const { data: checkins } = await supabase.from('checkins').select('checkin_time, shift')
        .ilike('name', `%${staffName}%`).gte('checkin_time', start).lte('checkin_time', end);
    const totalCheckins = checkins ? checkins.length : 0;
    let onTime = 0;
    if (checkins) {
        for (const c of checkins) {
            const t = new Date(c.checkin_time);
            const totalMin = t.getHours()*60 + t.getMinutes();
            const shift = (c.shift||'').toLowerCase();
            if (shift.includes('เช้า') && totalMin <= 8*60) onTime++;
            else if (shift.includes('เที่ยง') && totalMin <= 11*60) onTime++;
            else if (shift.includes('ดึก') && totalMin <= 20*60) onTime++;
        }
    }
    const onTimePct = totalCheckins > 0 ? Math.round((onTime/totalCheckins)*100) : 0;
    const { data: afkRows } = await supabase.from('tracker_remarks').select('afk_date')
        .ilike('staff_name', `%${staffName}%`).gte('afk_date', startDate).lte('afk_date', endDate);
    const afkDays = afkRows ? new Set(afkRows.map(r => r.afk_date)).size : 0;
    const { data: leaveRows } = await supabase.from('leave_requests').select('leave_date')
        .ilike('user_name', `%${staffName}%`).eq('status','approved')
        .gte('leave_date', startDate).lte('leave_date', endDate);
    const leaveDays = leaveRows ? leaveRows.length : 0;
    let workDays = 0;
    const cur = new Date(startDate+'T00:00:00+07:00'), last = new Date(endDate+'T00:00:00+07:00');
    while (cur <= last) { if (cur.getDay()!==0) workDays++; cur.setDate(cur.getDate()+1); }
    const absentDays = Math.max(0, workDays - totalCheckins - leaveDays);
    return { totalCheckins, onTimePct, afkDays, leaveDays, absentDays, workDays };
}


cron.schedule('0 8 * * 1', async () => {
    try {
        const now  = new Date();
        const past = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const start = past.toISOString().split('T')[0];
        const end   = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const ch = await client.channels.fetch(KPI_REPORT_CHANNEL).catch(() => null);
        if (!ch) return;
        for (const dept of ['AMOL', 'ODOL']) {
            const text = await buildTeamKPIMessage(dept, start, end, 'รายสัปดาห์');
            await sendLongMessage(ch, text);
        }
    } catch (e) { console.error('❌ [KPI Weekly]', e); }
}, { scheduled: true, timezone: 'Asia/Bangkok' });

// วันที่ 1 ของทุกเดือน 08:00 — รายงานรายเดือน
cron.schedule('0 8 1 * *', async () => {
    try {
        const now  = new Date();
        const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const startDate = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-01`;
        const lastDay   = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
        const endDate   = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${lastDay}`;
        const ch = await client.channels.fetch(KPI_REPORT_CHANNEL).catch(() => null);
        if (!ch) return;
        for (const dept of ['AMOL', 'ODOL']) {
            const text = await buildTeamKPIMessage(dept, startDate, endDate, 'รายเดือน');
            await sendLongMessage(ch, text);
        }
    } catch (e) { console.error('❌ [KPI Monthly]', e); }
}, { scheduled: true, timezone: 'Asia/Bangkok' });

// --- สั่งเริ่มเซิร์ฟเวอร์ (ห้ามลบ 2 บรรทัดนี้นะครับบอส!) ---
app.listen(PORT, '0.0.0.0', () => { console.log(`🌐 Server web port is open and listening on port ${PORT}!`); });
client.login(process.env.TOKEN).catch(error => { console.error("❌ ล็อกอินล้มเหลว โปรดตรวจสอบ TOKEN อีกครั้ง:", error); });
