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
const PORT = 3000;
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
    const { pin, action, dept, shift, discordId, staffName, newName } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });

    try {
        // อัปเดตให้ตรงกับ Table staff_list และคอลัมน์ staff_name
        if (action === 'add') {
            await supabase.from('staff_list').upsert({ discord_id: discordId, staff_name: staffName, department: dept, shift: shift });
        } else if (action === 'edit_name') {
            await supabase.from('staff_list').update({ staff_name: newName }).eq('discord_id', discordId);
        } else if (action === 'remove') {
            await supabase.from('staff_list').delete().eq('discord_id', discordId);
        }

        let msg = action === 'add' ? `✅ บันทึกพนักงาน ${staffName} สำเร็จ!` : (action === 'edit_name' ? '✅ เปลี่ยนชื่อพนักงานแล้ว!' : '🗑️ ลบพนักงานออกจากระบบแล้ว!');
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
            // ใช้ row.staff_name ตามรูป
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

async function processAutoShiftSwaps() {
    try {
        console.log("🔄 [AutoSwap] กำลังตรวจสอบตารางย้ายกะ...");

        if (!supabaseLeave) return;

        const now = new Date();
        const pastDays = new Date(now.getTime() - (3 * 24 * 60 * 60 * 1000)).toISOString(); 

        const { data: tasks, error } = await supabaseLeave
            .from('scheduled_tasks')
            .select('*')
            .eq('status', 'completed')
            .gte('scheduled_for', pastDays);

        if (error || !tasks || tasks.length === 0) return;

        for (const task of tasks) {
            if (processedTasks.has(task.id)) continue;

            let p = task.payload;
            if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e){ p = {}; } }

            if (task.task_type === 'individual_shift_update') {
                const targetName = (p.user_name || p.name || p.staff_name || '').trim();
                const targetShiftTh = (p.target_shift || p.shift || p.new_shift || '').trim();

                if (targetName && targetShiftTh && targetShiftTh !== 'คงเดิม') {
                    let newShiftKey = 'night';
                    const checkShift = targetShiftTh.toLowerCase();
                    if (checkShift.includes('เช้า') || checkShift.includes('morning')) newShiftKey = 'morning';
                    else if (checkShift.includes('เที่ยง') || checkShift.includes('noon')) newShiftKey = 'noon';

                    // Update directly in Supabase using staff_name search
                    const { data: matchingStaff } = await supabase.from('staff_list').select('discord_id').ilike('staff_name', `%${targetName}%`);
                    if (matchingStaff && matchingStaff.length > 0) {
                        for (const staff of matchingStaff) {
                            await supabase.from('staff_list').update({ shift: newShiftKey }).eq('discord_id', staff.discord_id);
                        }
                    }
                }
            }
            processedTasks.add(task.id);
        }
        console.log("💾 [AutoSwap] ตรวจสอบและอัปเดตกะสำเร็จ!");
    } catch (err) { 
        console.error("❌ [AutoSwap] Error:", err); 
    }
}

async function getLeavesFromSupabase(department = 'ALL') {
    const targetDate = getSupabaseDateStr();
    let result = { morning: [], noon: [], night: [] };
    if (!supabaseLeave) return result; 

    try {
        const { data, error } = await supabaseLeave.from('leave_logs').select('id, action_type, username, department').eq('leave_date', targetDate).order('id', { ascending: true });
        if (error) return result;

        let activeLeaves = {};
        if (data) {
            for (const row of data) {
                if (row.username) {
                    const leaveName = row.username.trim(); 
                    const action = row.action_type ? row.action_type.trim() : '';
                    if (action.startsWith('จอง')) activeLeaves[leaveName] = action; 
                    else if (action === 'ยกเลิก') delete activeLeaves[leaveName];
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

            let leaveType = "วันหยุด";
            const rawAction = activeLeaves[leaveName].toUpperCase();
            if (rawAction.includes('[KL]')) leaveType = "ลากิจ";

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
                
                // 🛠️ หาห้องเสียงหลักที่มีคนเช็คชื่ออยู่เยอะที่สุด (ป้องกันการดึงห้องอื่นที่คนเช็คชื่อแล้วย้ายไป)
                const voiceRoomCounts = {};
                let mainVoiceRoomId = null;
                let maxMembers = 0;

                session.members.forEach(m => {
                    const vs = guild.voiceStates.cache.get(m.id);
                    if (vs?.channelId) {
                        voiceRoomCounts[vs.channelId] = (voiceRoomCounts[vs.channelId] || 0) + 1;
                        if (voiceRoomCounts[vs.channelId] > maxMembers) {
                            maxMembers = voiceRoomCounts[vs.channelId];
                            mainVoiceRoomId = vs.channelId;
                        }
                    }
                });

                // 🎯 ตรวจสอบคนที่ลืมเช็คชื่อเฉพาะในห้องหลักเท่านั้น
                if (mainVoiceRoomId) {
                    const vRoom = guild.channels.cache.get(mainVoiceRoomId);
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

                            // เช็คว่าเป็นบอทไหม, เช็คชื่อไปหรือยัง, วันนี้ลาไหม, อยู่แผนกเดียวกันไหม
                            if (!member.user.bot && !checkedIds.has(member.id) && !isLeave && isSameDepartment) {
                                missingMembers.push({ name: staffName, vName: vRoom.name }); 
                            }
                        });
                    }
                }

                if (missingMembers.length > 0) {
                    summary += `\n🔴 **ลืมเช็คชื่อ (พบในกลุ่มห้องเสียงเดียวกัน):**\n`;
                    missingMembers.forEach((m, i) => {
                        summary += `   ${i + 1}. **${m.name}** (อยู่ในห้อง: ${m.vName})\n`;
                    });
                }

                let absentMembers = [];
                try {
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
            if (leavesObj.morning && leavesObj.morning.length > 0) {
                msg += `☀️ **กะเช้า (${leavesObj.morning.length} ท่าน):**\n` + leavesObj.morning.map((l, i) => `${i + 1}. ${l.name} ${l.type === 'ลากิจ' ? '(ลากิจ 📝)' : '(วันหยุด 😴)'}`).join('\n') + `\n\n`;
            }
            if (leavesObj.noon && leavesObj.noon.length > 0) {
                msg += `🕛 **กะเที่ยง (${leavesObj.noon.length} ท่าน):**\n` + leavesObj.noon.map((l, i) => `${i + 1}. ${l.name} ${l.type === 'ลากิจ' ? '(ลากิจ 📝)' : '(วันหยุด 😴)'}`).join('\n') + `\n\n`;
            }
            if (leavesObj.night && leavesObj.night.length > 0) {
                msg += `🌙 **กะดึก (${leavesObj.night.length} ท่าน):**\n` + leavesObj.night.map((l, i) => `${i + 1}. ${l.name} ${l.type === 'ลากิจ' ? '(ลากิจ 📝)' : '(วันหยุด 😴)'}`).join('\n') + `\n\n`;
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

        const session = activeSessions.get(channelId);
        if (!session) return message.reply('❌ **ขณะนี้ระบบปิดรับเช็คชื่อสำหรับห้องนี้แล้วค่ะ**');

        const member = message.member;
        if (!member.voice.channelId || !member.voice.streaming) return message.reply('❌ คุณต้องเข้าห้องเสียงและแชร์หน้าจอด้วยค่ะ');
        if (session.members.some(m => m.id === member.id)) return message.reply('✅ คุณได้เช็คชื่อไปแล้วค่ะ');

        const statusMsg = await message.reply('⏳ กำลังตรวจสอบ 10 วินาที...');
        setTimeout(async () => {
            try {
                if (member.voice.streaming) {
                    const localTime = getThaiTime(); 
const sType = session.shiftType ? session.shiftType.toLowerCase() : 'morning';

let shiftName = "กะเช้า ☀️";
if (sType.includes('night') || sType.includes('ดึก')) {
    shiftName = "กะดึก 🌙";
} else if (sType.includes('noon') || sType.includes('afternoon') || sType.includes('เที่ยง') || sType.includes('บ่าย')) {
    shiftName = "กะเที่ยง 🕛";
}

                    const staffDataObj = await fetchStaffData(); // ดึงข้อมูลใหม่
                    const staffName = getStaffName(member.id, member.displayName, staffDataObj);

                    session.members.push({ id: member.id, name: staffName, time: localTime, shift: shiftName });

                    try {
                        const { error } = await supabase.from('checkins').insert([{ discord_id: member.id, name: staffName, checkin_time: localTime, shift: shiftName }]); 
                        if (error) console.error("❌ Supabase Error:", error);
                    } catch (err) { }

                    statusMsg.edit(`✅ **เช็คชื่อสำเร็จ!** คุณอยู่ **${shiftName}** (ลำดับที่ ${session.members.length})`);
                } else { statusMsg.edit('❌ เช็คชื่อล้มเหลว: ปิดแชร์หน้าจอก่อนเวลาค่ะ'); }
            } catch (err) { }
        }, 10000);
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

                let checkinDuration = 10; 
                if (currentSlot.endTime && currentSlot.time) {
                    const start = new Date(`1970/01/01 ${currentSlot.time}`);
                    const end = new Date(`1970/01/01 ${currentSlot.endTime}`);
                    let diffMs = end - start;
                    if (diffMs < 0) diffMs += (24 * 60 * 60 * 1000); 
                    checkinDuration = Math.round(diffMs / 60000); 
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
                    .setDescription(`📅 **ประจำวันที่:** ${todayStr}\n⏰ **รอบเวลา:** ${currentTimeStr} น. (${shiftLabel})\n\n📢 **กติกา:**\n1. ต้องอยู่ในห้องเสียง\n2. ต้องแชร์หน้าจอ\n3. พิมพ์ \`!checkin\` ในห้องนี้\n\n⏱️ **เปิดรับเช็คชื่อถึงเวลา: ${currentSlot.endTime || "ไม่ได้ระบุ"} น.** (${checkinDuration} นาที)`)
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

// --- สั่งเริ่มเซิร์ฟเวอร์ (ห้ามลบ 2 บรรทัดนี้นะครับบอส!) ---
app.listen(process.env.PORT || 3000, () => { console.log(`🌐 Server web port is open and listening for Render!`); });
client.login(process.env.TOKEN).catch(error => { console.error("❌ ล็อกอินล้มเหลว โปรดตรวจสอบ TOKEN อีกครั้ง:", error); });
