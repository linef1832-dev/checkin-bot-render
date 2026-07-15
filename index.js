const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { Client, GatewayIntentBits, ChannelType, EmbedBuilder } = require('discord.js');
const express = require('express');
const fs = require('fs');
const cron = require('node-cron'); 

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
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE, PATCH");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const WEB_ADMIN_PIN = "123456"; 
const TOKEN = process.env.TOKEN;
const GUILD_ID = '1442466109503569992'; 
const PORT = process.env.PORT || 5000;
const DATA_FILE = 'bot_timer_data.json';
const LEAVE_FILE = 'leaves.json'; 
const KPI_REPORT_CHANNEL = process.env.KPI_REPORT_CHANNEL || '1442466109503569992';

let dataStore = {
    checkinChannels: [],
    breakChannels: [],
    lastCheckinDates: {},
    autoCheckinEnabled: true,
    autoCheckinTimes: []
};

let activeSessions = new Map(); 
let processedTasks = new Set();
const userCooldowns = {};

// โหลดข้อมูลจาก Supabase ตอน startup
async function loadDataFromSupabase() {
    try {
        const { data, error } = await supabase.from('bot_config').select('key, value');
        if (error || !data) {
            console.warn('⚠️ loadDataFromSupabase: ไม่สามารถโหลดได้ ใช้ค่า default');
            // fallback: ลองอ่านจากไฟล์เดิม
            if (fs.existsSync(DATA_FILE)) {
                try {
                    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                    dataStore.checkinChannels = loaded.checkinChannels || [];
                    dataStore.breakChannels = loaded.breakChannels || [];
                    dataStore.lastCheckinDates = loaded.lastCheckinDates || {};
                    dataStore.autoCheckinEnabled = loaded.autoCheckinEnabled !== undefined ? loaded.autoCheckinEnabled : true;
                    dataStore.autoCheckinTimes = loaded.autoCheckinTimes || [];
                } catch(e) {}
            }
            return;
        }
        data.forEach(row => {
            if (row.key === 'checkinChannels') dataStore.checkinChannels = row.value || [];
            if (row.key === 'breakChannels') dataStore.breakChannels = row.value || [];
            if (row.key === 'lastCheckinDates') dataStore.lastCheckinDates = row.value || {};
            if (row.key === 'autoCheckinEnabled') dataStore.autoCheckinEnabled = row.value !== undefined ? row.value : true;
            if (row.key === 'autoCheckinTimes') dataStore.autoCheckinTimes = row.value || [];
        });
        console.log('✅ โหลดข้อมูลจาก Supabase สำเร็จ');
    } catch(e) {
        console.error('loadDataFromSupabase error:', e);
    }
}

// ===== ดึง checkin channels จาก channel_settings (Supabase) =====
async function getCheckinChannels() {
    try {
        const { data, error } = await supabase.from('channel_settings').select('channel_id');
        if (error || !data) return dataStore.checkinChannels || [];
        const ids = data.map(r => r.channel_id);
        return ids.length > 0 ? ids : (dataStore.checkinChannels || []);
    } catch (e) {
        return dataStore.checkinChannels || [];
    }
}

async function isCheckinChannel(channelId) {
    const channels = await getCheckinChannels();
    return channels.includes(channelId);
}
// ===== จบ helper =====


// ==========================================
// 🚀 API
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
    if (!(await isCheckinChannel(channelId))) return res.status(400).json({ success: false, message: '❌ ห้องนี้ยังไม่ได้ตั้งค่าในระบบ กรุณาเพิ่มห้องในหน้าเว็บก่อนค่ะ' });

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
        try {
            const { data: chanSetting } = await supabase
                .from('channel_settings')
                .select('allowed_tags')
                .eq('channel_id', channelId)
                .maybeSingle();
            if (chanSetting && chanSetting.allowed_tags && chanSetting.allowed_tags.length > 0) {
                sessionDept = chanSetting.allowed_tags.length === 1
                    ? chanSetting.allowed_tags[0]
                    : chanSetting.allowed_tags.join(',');
            }
        } catch(e) {
            const chName = channel.name.toUpperCase();
            if (chName.includes('ODOL')) sessionDept = "ODOL";
            else if (chName.includes('AMOL') || chName.includes('เช็คชื่อ')) sessionDept = "AMOL";
        }

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

// /api/staff-list — ดึงรายชื่อพนักงานจาก staff_list
app.get('/api/staff-list', async (req, res) => {
    try {
        const { data, error } = await supabase.from('staff_list').select('*');
        if (error) return res.status(500).json({ success: false, message: error.message });
        let staffObj = {};
        (data || []).forEach(row => {
            const dept = (row.department || 'AMOL').toUpperCase();
            const shift = (row.shift || 'morning').toLowerCase();
            if (!staffObj[dept]) staffObj[dept] = { morning: {}, noon: {}, night: {} };
            if (!staffObj[dept][shift]) staffObj[dept][shift] = {};
            staffObj[dept][shift][row.discord_id] = {
                name: row.staff_name,
                telegram_id: row.telegram_id || null
            };
        });
        res.json({ success: true, data: staffObj });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// /api/getstaff ถูกแทนที่ด้วย /api/syncstaff แล้ว

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

    if (chats === 0 && userCooldowns[sessionProfile] && (now - userCooldowns[sessionProfile] < 25000)) {
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
                // 🌙 หาช่วงพักของคนนี้ — ดึงด้วย created_at (ถูกเสมอ) ครอบ 48 ชม.ล่าสุด
                //    เผื่อ botlink เขียน break_date/break_start เป็นวัน-เดือนสลับ แล้ว normalize ให้ถูกก่อนเทียบ
                const breakWinStart = new Date(currentPing - 48 * 60 * 60 * 1000).toISOString();
                const { data: rawBreakRows } = await supabase
                    .from('break_sessions')
                    .select('break_start, break_end, break_date, created_at')
                    .eq('staff_name', sessionProfile.toUpperCase())
                    .gte('created_at', breakWinStart);
                const breakRows = (rawBreakRows || []).map(normalizeBreakRow);

                // เช็คว่าช่วงที่หายไป (lastPing → currentPing) "ทับ" กับช่วงพักใดๆ ไหม
                // ทับ = พักเริ่มก่อน currentPing  และ  พักจบหลัง lastPing (พักที่ยังไม่จบ = ยังพักอยู่ ถือว่าทับ)
                let isOnBreak = false;
                for (const br of breakRows) {
                    const bStart = new Date(br.break_start).getTime();
                    const bEnd = br.break_end ? new Date(br.break_end).getTime() : currentPing; // ยังไม่จบ = ถือว่าพักถึงตอนนี้
                    if (bStart <= currentPing && bEnd >= lastPing) { isOnBreak = true; break; }
                }

                if (!isOnBreak) {
                    newAfkCount += 1;
                    await supabase.from('tracker_remarks').insert([{
                        staff_name: sessionProfile,
                        afk_date: todayYYYYMMDD,
                        start_time: new Date(lastPing).toISOString(),
                        end_time: new Date(currentPing).toISOString(),
                        remark: ''
                    }]);
                } else {
                    console.log(`[Tracker] ${sessionProfile} ไม่นับ AFK เพราะอยู่ในช่วงพัก`);
                }
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

app.post('/api/personal-stats', async (req, res) => {
    const { staff_name, mode } = req.body;
    try {
        const daysToFetch = mode === 'week' ? 7 : 30;
        const now = new Date();
        const pastDate = new Date(now.getTime() - ((daysToFetch - 1) * 24 * 60 * 60 * 1000));
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

// /api/updatestaff ถูกลบออกแล้ว — ใช้ /api/syncstaff แทน

// ===== Sync พนักงานจาก K36 → staff_list =====
app.post('/api/syncstaff', async (req, res) => {
    const { pin } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });
    if (!supabaseLeave) return res.status(500).json({ success: false, message: '❌ ยังไม่ได้ตั้งค่า SUPABASE_LEAVE_URL / SUPABASE_LEAVE_KEY' });

    try {
        // ดึงข้อมูลจาก users ใน K36
        const { data: users, error: fetchErr } = await supabaseLeave
            .from('users')
            .select('username, discord_id, telegram_id, tag, department, allowed_shift')
            .not('discord_id', 'is', null);

        if (fetchErr || !users) return res.status(500).json({ success: false, message: '❌ ดึงข้อมูลจาก K36 ไม่ได้: ' + (fetchErr?.message || '') });

        const shiftMap = { 'กะเช้า': 'morning', 'กะกลาง': 'noon', 'กะดึก': 'night' };
        const staffRows = users
            .filter(u => u.discord_id && u.username)
            .map(u => ({
                discord_id: u.discord_id,
                staff_name: u.username,
                telegram_id: u.telegram_id || null,
                department: (u.tag || u.department || 'AMOL').toUpperCase(),
                shift: shiftMap[u.allowed_shift] || 'morning'
            }));

        // ดึง staff_list ที่มีอยู่ทั้งหมด
        const { data: existing } = await supabase.from('staff_list').select('discord_id, shift');
        const existingMap = {};
        (existing || []).forEach(e => { existingMap[e.discord_id] = e.shift; });
        const k36Ids = staffRows.map(r => r.discord_id);

        // upsert ทีเดียวทั้งก้อน โดยเอา shift จาก existingMap มาใส่ก่อน
        const upsertRows = staffRows.map(r => ({
            discord_id: r.discord_id,
            staff_name: r.staff_name,
            telegram_id: r.telegram_id,
            department: r.department,
            shift: existingMap[r.discord_id] || r.shift  // ถ้ามีอยู่แล้วใช้ shift เดิม ถ้าใหม่ใช้จาก K36
        }));

        // ลบก่อน แล้ว insert ทีเดียว (เร็วที่สุด)
        await supabase.from('staff_list').delete().neq('discord_id', '0');
        if (upsertRows.length > 0) {
            const { error: insertErr } = await supabase.from('staff_list').insert(upsertRows);
            if (insertErr) return res.status(500).json({ success: false, message: '❌ บันทึกไม่ได้: ' + insertErr.message });
        }

        const newCount = upsertRows.filter(r => !existingMap[r.discord_id]).length;
        res.json({ success: true, message: `✅ Sync สำเร็จ! ${upsertRows.length} คน (ใหม่ ${newCount} คน) — กะไม่เปลี่ยน` });
    } catch (e) {
        res.status(500).json({ success: false, message: '❌ เกิดข้อผิดพลาด: ' + e.message });
    }
});

// ===== Channel Settings API =====
app.get('/api/channel-settings', async (req, res) => {
    try {
        const { data, error } = await supabase.from('channel_settings').select('*').order('created_at');
        if (error) return res.status(500).json({ success: false, message: error.message });
        res.json({ success: true, data: data || [] });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/channel-settings', async (req, res) => {
    const { pin, channel_id, channel_name, allowed_tags } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });
    if (!channel_id) return res.status(400).json({ success: false, message: '❌ กรุณาระบุ Channel ID' });
    try {
        const { error } = await supabase.from('channel_settings').upsert({
            channel_id: channel_id.trim(),
            channel_name: channel_name || '',
            allowed_tags: allowed_tags || []
        }, { onConflict: 'channel_id' });
        if (error) return res.status(500).json({ success: false, message: error.message });
        res.json({ success: true, message: '✅ บันทึกการตั้งค่าห้องสำเร็จ' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.delete('/api/channel-settings/:channelId', async (req, res) => {
    const { pin } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });
    try {
        const { error } = await supabase.from('channel_settings').delete().eq('channel_id', req.params.channelId);
        if (error) return res.status(500).json({ success: false, message: error.message });
        res.json({ success: true, message: '✅ ลบห้องสำเร็จ' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== เปลี่ยนกะพนักงานด้วยมือ =====
app.post('/api/update-shift', async (req, res) => {
    const { pin, discord_id, shift } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });
    if (!discord_id || !shift) return res.status(400).json({ success: false, message: '❌ ข้อมูลไม่ครบ (ต้องมี discord_id และ shift)' });
    const validShifts = ['morning', 'noon', 'night'];
    if (!validShifts.includes(shift)) return res.status(400).json({ success: false, message: `❌ กะไม่ถูกต้อง (ใช้ได้: ${validShifts.join(', ')})` });
    try {
        const { data: existing } = await supabase.from('staff_list').select('discord_id, staff_name, shift').eq('discord_id', discord_id).maybeSingle();
        if (!existing) return res.status(404).json({ success: false, message: '❌ ไม่พบพนักงานคนนี้ในระบบ' });
        const { error } = await supabase.from('staff_list').update({ shift }).eq('discord_id', discord_id);
        if (error) return res.status(500).json({ success: false, message: '❌ บันทึกไม่ได้: ' + error.message });
        const shiftLabel = shift === 'morning' ? 'กะเช้า ☀️' : shift === 'noon' ? 'กะเที่ยง 🕛' : 'กะดึก 🌙';
        console.log(`[UpdateShift] ✅ ${existing.staff_name} (${discord_id}): ${existing.shift} → ${shift}`);
        res.json({ success: true, message: `✅ เปลี่ยนกะ ${existing.staff_name} เป็น ${shiftLabel} สำเร็จ` });
    } catch (e) {
        console.error('[UpdateShift] error:', e);
        res.status(500).json({ success: false, message: '❌ เกิดข้อผิดพลาด: ' + e.message });
    }
});

app.post('/api/kpi-team', async (req, res) => {
    try {
        const { dept, mode } = req.body;
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
        let startDate, endDate;
        if (mode === 'prevmonth') {
            // เดือนที่แล้ว
            const pm = now.getMonth() === 0
                ? new Date(now.getFullYear()-1, 11, 1)
                : new Date(now.getFullYear(), now.getMonth()-1, 1);
            startDate = pm.getFullYear() + '-' + String(pm.getMonth()+1).padStart(2,'0') + '-01';
            const lastDay = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
            endDate = pm.getFullYear() + '-' + String(pm.getMonth()+1).padStart(2,'0') + '-' + String(lastDay).padStart(2,'0');
        } else {
            // เดือนนี้ (default)
            startDate = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-01';
            endDate   = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
        }
        if (startDate > endDate) {
            return res.json({ success: true, data: [], startDate, endDate, note: 'ยังไม่มีข้อมูล KPI' });
        }
        const start = new Date(startDate + 'T00:00:00+07:00').toISOString();
        const end   = new Date(endDate   + 'T23:59:59+07:00').toISOString();
        const [staffDataObj, allCheckins, allAfk, allLeaves] = await Promise.all([
            fetchStaffData(),
            supabase.from('checkins').select('discord_id, name, checkin_time, shift, late_minutes').gte('checkin_time', start).lte('checkin_time', end),
            supabase.from('tracker_remarks').select('staff_name, afk_date').gte('afk_date', startDate).lte('afk_date', endDate),
            supabase.from('leave_requests').select('user_name, leave_date').eq('status', 'approved').gte('leave_date', startDate).lte('leave_date', endDate)
        ]);
        const checkinMap = {};
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
        const uniqueCheckinDates = new Set(
            (allCheckins.data || []).map(c => {
                const thai = new Date(new Date(c.checkin_time).getTime() + 7*60*60*1000);
                return thai.toISOString().split('T')[0];
            })
        );
        const workDays = uniqueCheckinDates.size || 1;
        const results = [];
        const depts = dept === 'ALL' ? ['AMOL','ODOL'] : [dept.toUpperCase()];
        for (const d of depts) {
            const deptData = staffDataObj[d];
            if (!deptData) continue;
            for (const shift of ['morning','noon','night']) {
                if (!deptData[shift]) continue;
                for (const [discordId, _entry] of Object.entries(deptData[shift])) {
                    const name = typeof _entry === 'object' ? _entry.name : _entry;
                    const shortName = name.replace(/^(AMOL|ODOL)[-\s]/i,'').trim().toUpperCase();
                    const myCheckins = checkinMap[discordId] || [];
                    const totalCheckins = myCheckins.length;
                    let onTime = 0, lateDays = 0;
                    myCheckins.forEach(c => {
                        const lateMin = parseInt(c.late_minutes || 0);
                        if (lateMin > 0) { lateDays++; }
                        else {
                            const t = new Date(c.checkin_time);
                            const totalMin = t.getHours()*60 + t.getMinutes();
                            const s = (c.shift||'').toLowerCase();
                            if (s.includes('เช้า') && totalMin <= 8*60) onTime++;
                            else if (s.includes('เที่ยง') && totalMin <= 11*60) onTime++;
                            else if (s.includes('ดึก') && totalMin <= 20*60) onTime++;
                            else onTime++;
                        }
                    });
                    const onTimePct = totalCheckins > 0 ? Math.round((onTime/totalCheckins)*100) : 0;
                    let afkDays = 0;
                    for (const [key, dates] of Object.entries(afkMap)) {
                        const sTokens = shortName.split(/[-_\s]+/).filter(Boolean);
                        const kTokens = key.split(/[-_\s]+/).filter(Boolean);
                        if (sTokens.some(t => kTokens.includes(t)) || kTokens.some(t => sTokens.includes(t))) { afkDays = dates.size; break; }
                    }
                    let leaveDays = 0;
                    for (const [key, count] of Object.entries(leaveMap)) {
                        const sTokens = shortName.split(/[-_\s]+/).filter(Boolean);
                        const kTokens = key.split(/[-_\s]+/).filter(Boolean);
                        if (sTokens.some(t => kTokens.includes(t)) || kTokens.some(t => sTokens.includes(t))) { leaveDays = count; break; }
                    }
                    const absentDays = Math.max(0, workDays - totalCheckins - leaveDays);
                    results.push({ name, dept: d, shift, totalCheckins, onTimePct, lateDays, afkDays, leaveDays, absentDays, workDays });
                }
            }
        }
        res.json({ success: true, data: results, startDate, endDate, kpiStartDate: startDate });
    } catch(e) {
        console.error('[KPI API]', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/break-summary', async (req, res) => {
    const { pin, date, startDate, endDate } = req.body;
    if (pin !== WEB_ADMIN_PIN) return res.status(403).json({ success: false, message: '❌ รหัสผ่านผิด' });
    try {
        // รองรับทั้งแบบวันเดียว (date) และช่วงวัน (startDate-endDate)
        const sDate = startDate || date || getSupabaseDateStr();
        const eDate = endDate || date || getSupabaseDateStr();

        // 🩹 botlink เขียน break_date เป็น YYYY-DD-MM (วัน↔เดือนสลับ) → ดึงด้วย created_at (ถูกเสมอ)
        //    เผื่อ buffer ±1 วัน แล้วค่อย normalize + กรองด้วย break_date ที่ซ่อมแล้วในโค้ด
        const winStart = new Date(sDate + 'T00:00:00+07:00'); winStart.setUTCDate(winStart.getUTCDate() - 1);
        const winEnd   = new Date(eDate + 'T23:59:59+07:00'); winEnd.setUTCDate(winEnd.getUTCDate() + 1);
        const winStartISO = winStart.toISOString();
        const winEndISO   = winEnd.toISOString();

        // ลองดึงพร้อม break_reason ก่อน ถ้าคอลัมน์ยังไม่มีให้ fallback ดึงแบบไม่มี reason
        let rawBreaks = null, error = null, hasReason = true;
        ({ data: rawBreaks, error } = await supabase
            .from('break_sessions')
            .select('staff_name, break_start, break_end, break_date, break_reason, created_at')
            .gte('created_at', winStartISO)
            .lte('created_at', winEndISO)
            .order('break_start', { ascending: true }));
        if (error) {
            // คอลัมน์ break_reason อาจยังไม่มี → ลองใหม่แบบไม่ดึง reason
            hasReason = false;
            ({ data: rawBreaks, error } = await supabase
                .from('break_sessions')
                .select('staff_name, break_start, break_end, break_date, created_at')
                .gte('created_at', winStartISO)
                .lte('created_at', winEndISO)
                .order('break_start', { ascending: true }));
        }
        if (error) {
            console.error('[break-summary] query error:', error.message || error);
            return res.status(500).json({ success: false, message: '❌ ดึงข้อมูลไม่ได้: ' + (error.message || 'unknown') });
        }

        // 🩹 created_at เชื่อถือได้เสมอ → ใช้กำหนด "วันทำงาน" (เวลาไทย) แทน break_date
        //    ที่ botlink อาจเขียนสลับวัน-เดือน (YYYY-DD-MM) ทำให้ string-compare หลุดช่วงในวันที่ > 12
        //    (normalizeBreakRow ยังช่วยซ่อม break_start/break_end ให้ parse ได้ + คำนวณเวลาถูก)
        const breaks = (rawBreaks || [])
            .map(normalizeBreakRow)
            .map(b => {
                const d = breakDateFromCreatedAt(b.created_at);
                return d ? { ...b, break_date: d } : b;
            })
            .filter(b => b.break_date && b.break_date >= sDate && b.break_date <= eDate);

        // 🔎 log วินิจฉัย: ดึงมากี่แถว เหลือกี่แถวหลังกรอง (ถ้ามี raw แต่กรองทิ้งหมด โชว์ตัวอย่างให้ดูวันที่)
        console.log(`[break-summary] ${sDate}..${eDate} raw=${(rawBreaks || []).length} kept=${breaks.length}` +
            ((rawBreaks && rawBreaks.length && !breaks.length)
                ? ` | sample=${JSON.stringify((rawBreaks || []).slice(0, 3).map(r => ({ name: r.staff_name, bs: r.break_start, bd: r.break_date, ca: r.created_at })))}`
                : ''));

        // ดึงรายชื่อพนักงาน + แผนก + กะ มา map เข้ากับชื่อในตารางพัก
        const { data: staffRows } = await supabase
            .from('staff_list')
            .select('staff_name, department, shift');

        // สร้าง index: token ของชื่อ → {dept, shift}
        const staffIndex = [];
        (staffRows || []).forEach(r => {
            const full = (r.staff_name || '').toUpperCase().trim();
            // ตัด prefix แผนกออก (AMOL-/ODOL-) แล้วแตก token
            const short = full.replace(/^(AMOL|ODOL)[-\s]/i, '').trim();
            const tokens = short.split(/[-_/\s]+/).filter(Boolean);
            staffIndex.push({
                full, short, tokens,
                dept: (r.department || '').toUpperCase(),
                shift: (r.shift || '').toLowerCase()
            });
        });

        function matchStaff(breakName) {
            const bn = (breakName || '').toUpperCase().trim();
            const bnTokens = bn.split(/[-_/\s]+/).filter(Boolean);
            // 1) ตรงเป๊ะกับ short หรือ full
            let hit = staffIndex.find(s => s.short === bn || s.full === bn);
            if (hit) return hit;
            // 2) token ตรงกัน
            hit = staffIndex.find(s =>
                s.tokens.some(t => bnTokens.includes(t)) || bnTokens.some(t => s.tokens.includes(t))
            );
            return hit || null;
        }

        // แนบ dept/shift ให้แต่ละ record
        const enriched = (breaks || []).map(b => {
            const m = matchStaff(b.staff_name);
            return {
                staff_name: b.staff_name,
                break_start: b.break_start,
                break_end: b.break_end,
                break_date: b.break_date,
                break_reason: b.break_reason || null,
                department: m ? m.dept : 'UNKNOWN',
                shift: m ? m.shift : 'unknown'
            };
        });

        // 🔎 ถ้าช่วงที่ขอไม่มีแถวเลย → ดึง 10 แถวล่าสุด (ไม่กรองวันที่) มาดูว่า botlink เขียนอะไรลงล่าสุด
        let recentRows = [];
        let totalCount = null;
        if ((rawBreaks || []).length === 0) {
            try {
                const { data: rr } = await supabase
                    .from('break_sessions')
                    .select('staff_name, break_start, break_date, created_at')
                    .order('created_at', { ascending: false })
                    .limit(10);
                recentRows = rr || [];
                const { count } = await supabase
                    .from('break_sessions')
                    .select('*', { count: 'exact', head: true });
                totalCount = (count != null) ? count : null;
            } catch (e) { console.error('[break-summary] recent query error:', e.message || e); }
        }

        res.json({
            success: true, data: enriched, startDate: sDate, endDate: eDate,
            // 🔎 diagnostic ให้ฝั่งเว็บโชว์ได้เวลาไม่มีข้อมูล
            debug: {
                rawInWindow: (rawBreaks || []).length,
                afterDateFilter: enriched.length,
                sample: (rawBreaks || []).slice(0, 5).map(r => ({ name: r.staff_name, bd: r.break_date, ca: r.created_at })),
                totalCount,
                recent: recentRows.map(r => ({ name: r.staff_name, bs: r.break_start, bd: r.break_date, ca: r.created_at }))
            }
        });
    } catch (err) {
        console.error('[break-summary]', err);
        res.status(500).json({ success: false });
    }
});

// ==========================================
// 🛠️ Functions
// ==========================================

async function fetchStaffData() {
    try {
        const { data, error } = await supabase.from('staff_list').select('*');
        let staffObj = { AMOL: { morning: {}, noon: {}, night: {} }, ODOL: { morning: {}, noon: {}, night: {} } };
        if (error || !data) return staffObj;
        data.forEach(row => {
            const dept = (row.department || 'ALL').toUpperCase();
            const shift = (row.shift || 'morning').toLowerCase();
            if (!staffObj[dept]) staffObj[dept] = { morning: {}, noon: {}, night: {} };
            if (!staffObj[dept][shift]) staffObj[dept][shift] = {};
            staffObj[dept][shift][row.discord_id] = {
                name: row.staff_name,
                telegram_id: row.telegram_id || null
            };
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
                const isSameBreak = JSON.stringify(githubData.breakChannels) === JSON.stringify(dataStore.breakChannels);
                if (isSameTimes && isSameStatus && isSameChannels && isSameBreak) return;
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
    // บันทึกลงไฟล์ (backup)
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(dataStore, null, 2), 'utf8'); } catch(e) {}
    // บันทึกลง Supabase
    const keys = ['checkinChannels', 'breakChannels', 'lastCheckinDates', 'autoCheckinEnabled', 'autoCheckinTimes'];
    keys.forEach(async key => {
        try {
            await supabase.from('bot_config').upsert({
                key: key,
                value: dataStore[key],
                updated_at: new Date().toISOString()
            }, { onConflict: 'key' });
        } catch(e) { console.error('saveData supabase error:', key, e); }
    });
}

function getStaffName(userId, fallbackName, staffDataObj) {
    if (!staffDataObj) return fallbackName;
    for (const dept in staffDataObj) {
        for (const shift in staffDataObj[dept]) {
            if (staffDataObj[dept][shift] && staffDataObj[dept][shift][userId]) {
                const _e = staffDataObj[dept][shift][userId];
                return typeof _e === 'object' ? _e.name : _e;
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

// แปลง Date เป็น YYYY-MM-DD
function toDateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 🌙 วันที่สำหรับ "เวลาพัก" — รองรับกะดึกข้ามเที่ยงคืน
// ถ้าตอนนี้เป็นช่วง 00:00-07:59 (ยังอยู่ในกะดึกที่เริ่มเมื่อวาน) → นับเป็นวันเมื่อวาน
// ช่วงอื่น (08:00 เป็นต้นไป) → นับเป็นวันปัจจุบันตามปกติ
function getBreakDateStr() {
    const t = getThaiTime();
    if (t.getHours() < 8) {
        const y = new Date(t.getTime() - 24 * 60 * 60 * 1000);
        return toDateStr(y);
    }
    return toDateStr(t);
}

// ==========================================
// ☕ Break detection helper (รองรับ emoji หลายแบบ + custom emoji <:name:id>)
// ==========================================
const BREAK_START_WORDS = ['ไปปวดหนัก','ปวดหนัก','ไปปวดน้อย','ปวดน้อย','ไปกินข้าว','กินข้าว','ไปเข้าห้องน้ำ','เข้าห้องน้ำ','ไปพัก','พักเบรก','พักสักครู่','ไปทำธุระ','ทำธุระ','ไปสูบบุหรี่','สูบบุหรี่'];
const BREAK_END_WORDS = ['กลับที่นั่งแล้ว','กลับที่นั่ง','กลับมาแล้ว','กลับมา','พร้อมแล้ว','มาแล้ว','เข้างานแล้ว'];

// ลบ emoji / custom emoji / สัญลักษณ์นำหน้า ออกให้เหลือแต่ข้อความ
function stripLeadingSymbols(text) {
    let t = text;
    // ลบ custom discord emoji <:name:123> และ <a:name:123>
    t = t.replace(/<a?:\w+:\d+>/g, ' ');
    // ลบอักขระที่ไม่ใช่ ตัวอักษร/ตัวเลข ที่อยู่หน้าสุด (emoji, เว้นวรรค, สัญลักษณ์)
    t = t.replace(/^[^A-Za-z0-9ก-๙]+/u, '');
    return t.trim();
}

// ดึงชื่อพนักงาน (token ตัวแรก) จากข้อความที่ลบ emoji แล้ว
function extractBreakName(cleanText) {
    const m = cleanText.match(/^([A-Za-z0-9ก-๙]+)/u);
    return m ? m[1].toUpperCase() : null;
}

function matchBreakStart(cleanText) {
    return BREAK_START_WORDS.some(w => cleanText.includes(w));
}
function matchBreakEnd(cleanText) {
    return BREAK_END_WORDS.some(w => cleanText.includes(w));
}

// 📝 ดึง "เหตุผลการพัก" จากข้อความ → คืนค่าเป็นป้ายอ่านง่าย
// ตรงกับปุ่มจริงในระบบ: กินข้าว / ปวดหนัก / ปวดน้อย
// เรียงจากคำเฉพาะเจาะจงไปกว้าง เพื่อให้จับคำที่ตรงที่สุดก่อน
const BREAK_REASON_MAP = [
    { words: ['ไปปวดหนัก','ปวดหนัก'],            label: '🚽 ปวดหนัก' },
    { words: ['ไปปวดน้อย','ปวดน้อย'],            label: '🚾 ปวดน้อย' },
    { words: ['ไปกินข้าว','กินข้าว'],            label: '🍱 กินข้าว' },
    { words: ['ไปเข้าห้องน้ำ','เข้าห้องน้ำ'],     label: '🚻 เข้าห้องน้ำ' },
    { words: ['ไปสูบบุหรี่','สูบบุหรี่'],          label: '🚬 สูบบุหรี่' },
    { words: ['ไปทำธุระ','ทำธุระ'],              label: '📋 ทำธุระ' },
    { words: ['พักเบรก','พักสักครู่','ไปพัก'],     label: '☕ พักเบรก' },
];
function extractBreakReason(cleanText) {
    for (const r of BREAK_REASON_MAP) {
        if (r.words.some(w => cleanText.includes(w))) return r.label;
    }
    return '☕ พัก';
}

// 🩹 botlink (Telegram) บางครั้งเขียน break_start/break_end/break_date เป็น YYYY-DD-MM
//     (สลับตำแหน่ง "วัน" กับ "เดือน") ทำให้หน้าเว็บ/แจ้งเตือนหาไม่เจอ
//     → created_at ของ Supabase ถูกต้องเสมอ ใช้เป็นตัวตัดสิน
// สลับ MM↔DD ในสตริง YYYY-MM-DD (คงส่วนเวลาไว้เหมือนเดิม)
function swapMonthDay(str) {
    if (!str) return str;
    const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
    return m ? `${m[1]}-${m[3]}-${m[2]}${m[4]}` : str;
}
// ซ่อม 1 แถว: ถ้า date ของ break_start ไม่ตรง created_at แต่ "สลับแล้วตรง" → โดนเขียนสลับ ให้ซ่อม
// แถวปกติ (date ตรงอยู่แล้ว) หรือกรณีอื่น ๆ จะคืนค่าเดิมไม่แตะต้อง
function normalizeBreakRow(b) {
    if (!b || !b.created_at || !b.break_start) return b;
    const bsDate = String(b.break_start).slice(0, 10);
    const caDate = String(b.created_at).slice(0, 10);
    if (bsDate === caDate) return b;                 // ตรงอยู่แล้ว = ปกติ
    if (swapMonthDay(bsDate) === caDate) {           // สลับแล้วตรง = โดน botlink เขียนสลับ
        return {
            ...b,
            break_start: swapMonthDay(b.break_start),
            break_end:   b.break_end  ? swapMonthDay(b.break_end)  : b.break_end,
            break_date:  b.break_date ? swapMonthDay(b.break_date) : b.break_date,
        };
    }
    return b;                                        // ต่างวันด้วยเหตุอื่น (เช่น คร่อมเที่ยงคืน UTC) — ไม่แตะ
}

// 🕗 คืน "วันทำงาน" (YYYY-MM-DD เวลาไทย) จาก created_at ซึ่ง Supabase ตั้งเองถูกเสมอ
//    ใช้ธรรมเนียมกะดึกเหมือน getBreakDateStr: ช่วง 00:00-07:59 นับเป็นเมื่อวาน
//    → เลี่ยงปัญหา botlink เขียน break_date/break_start สลับวัน-เดือนทั้งหมด
function breakDateFromCreatedAt(createdAt) {
    if (!createdAt) return null;
    const t = new Date(createdAt);
    if (isNaN(t.getTime())) return null;
    const thai = new Date(t.getTime() + 7 * 3600000);
    if (thai.getUTCHours() < 8) thai.setUTCDate(thai.getUTCDate() - 1);
    return `${thai.getUTCFullYear()}-${String(thai.getUTCMonth() + 1).padStart(2, '0')}-${String(thai.getUTCDate()).padStart(2, '0')}`;
}

async function handleBreakMessage(rawText, message) {
    if (!rawText || rawText.trim() === '') return;

    const cleanText = stripLeadingSymbols(rawText.replace(/\n/g, ' '));
    const isStart = matchBreakStart(cleanText);
    const isEnd   = matchBreakEnd(cleanText);

    if (!isStart && !isEnd) return;

    const breakName = extractBreakName(cleanText);
    if (!breakName) return;

    const breakDate = getBreakDateStr();
    const nowISO    = new Date().toISOString();
    const channelId = message?.channelId || null;
    const messageId = message?.id        || null;

    if (isStart) {
        // ปิด session ที่ค้างอยู่ก่อน (ถ้ามี)
        await supabase
            .from('break_sessions')
            .update({ break_end: nowISO })
            .eq('staff_name', breakName.toUpperCase())
            .is('break_end', null);

        const reason = extractBreakReason(cleanText);
        const { error } = await supabase.from('break_sessions').insert([{
            staff_name:   breakName.toUpperCase(),
            break_start:  nowISO,
            break_end:    null,
            break_date:   breakDate,
            break_reason: reason,
            channel_id:   channelId,
            message_id:   messageId,
        }]);
        if (error) console.error('[Break] insert error:', error.message);
        else console.log(`[Break] ✅ ${breakName} เริ่มพัก (${reason})`);

    } else if (isEnd) {
        const { error } = await supabase
            .from('break_sessions')
            .update({ break_end: nowISO })
            .eq('staff_name', breakName.toUpperCase())
            .is('break_end', null);
        if (error) console.error('[Break] update error:', error.message);
        else console.log(`[Break] ✅ ${breakName} กลับมาแล้ว`);
    }
}

// ⏰ เก็บเวลาแจ้งเตือนล่าสุดของแต่ละ record (id → timestamp ms) เพื่อแจ้งซ้ำทุก 2 นาที
const lastAlertTime = new Map();
const LONG_BREAK_LIMIT_MIN = 30;   // เกินกี่นาทีถึงเริ่มแจ้งเตือน
const ALERT_REPEAT_MIN = 2;        // แจ้งซ้ำทุกกี่นาที

// 📊 แจ้งเตือนยอดพักสะสมต่อวัน
const DAILY_WARN_MIN = 110;        // ยอดสะสมถึงกี่นาทีถึงแจ้งเตือน
const DAILY_LIMIT_MIN = 120;       // เกณฑ์ที่อาจโดนปรับ
const dailyWarnedStaff = new Set(); // กันแจ้งซ้ำ: เก็บ "staffName|breakDate" ที่แจ้งไปแล้ว

// 🌙 ตรวจ record คร่อมเวลา 01:01 (เหมือน Dashboard) — กะดึก บอท Telegram รีเซ็ตตอน 01:01
function crossesOneAMBot(start, end) {
    if (!start || !end) return false;
    const s = new Date(start), e = new Date(end);
    const sMin = s.getUTCHours() * 60 + s.getUTCMinutes();
    const eMin = e.getUTCHours() * 60 + e.getUTCMinutes();
    const RESET = 61; // 01:01
    if (sMin < RESET && eMin >= RESET && eMin >= sMin) return true;
    return false;
}

// แปลงชื่อในตารางพัก → หากะของพนักงานจาก staff_list (คืน 'morning'/'noon'/'night' หรือ null)
// 💬 ส่งข้อความแจ้งเตือนโดย "ตอบกลับ" ข้อความพักของพนักงานคนนั้น
// ถ้าไม่มี channel_id/message_id หรือหาไม่เจอ → fallback ส่งเข้าห้องแจ้งพักห้องแรก
async function sendBreakAlert(channelId, messageId, msg) {
    // มี channel + message id → ลอง reply ที่ข้อความนั้นโดยตรง
    if (channelId && messageId) {
        try {
            const ch = await client.channels.fetch(channelId).catch(() => null);
            if (ch) {
                const targetMsg = await ch.messages.fetch(messageId).catch(() => null);
                if (targetMsg) {
                    await targetMsg.reply(msg);
                    return true;
                }
                // หาข้อความไม่เจอ (อาจถูกลบ) แต่ยังรู้ห้อง → ส่งเข้าห้องนั้น
                await ch.send(msg);
                return true;
            }
        } catch (e) { console.error('[Alert] reply ไม่ได้:', e.message); }
    }
    // fallback: ส่งเข้าห้องแจ้งพักห้องแรกที่ลงทะเบียน
    try {
        const fallbackId = (dataStore.breakChannels && dataStore.breakChannels[0]) || channelId;
        if (fallbackId) {
            const ch = await client.channels.fetch(fallbackId).catch(() => null);
            if (ch) { await ch.send(msg); return true; }
        }
    } catch (e) { console.error('[Alert] fallback ส่งไม่ได้:', e.message); }
    return false;
}

async function getStaffShift(breakName) {
    try {
        const bn = (breakName || '').toUpperCase().trim();
        const bnTokens = bn.split(/[-_/\s]+/).filter(Boolean);
        const { data: staffRows } = await supabase.from('staff_list').select('staff_name, shift');
        if (!staffRows) return null;
        for (const r of staffRows) {
            const full = (r.staff_name || '').toUpperCase().trim();
            const short = full.replace(/^(AMOL|ODOL)[-\s]/i, '').trim();
            const tokens = short.split(/[-_/\s]+/).filter(Boolean);
            if (short === bn || full === bn ||
                tokens.some(t => bnTokens.includes(t)) || bnTokens.some(t => tokens.includes(t))) {
                return (r.shift || '').toLowerCase();
            }
        }
    } catch (e) {}
    return null;
}

// เช็คว่าเวลาไทยปัจจุบันยังอยู่ในเวลาทำงานของกะนั้นไหม
// เช้า 08:00-20:00 | เที่ยง 11:00-23:00 | ดึก 20:00-08:00 (ข้ามคืน)
function isWithinShift(shift, thaiTime) {
    const totalMin = thaiTime.getHours() * 60 + thaiTime.getMinutes();
    if (shift === 'morning') return totalMin >= 8*60 && totalMin < 20*60;
    if (shift === 'noon')    return totalMin >= 11*60 && totalMin < 23*60;
    if (shift === 'night')   return (totalMin >= 20*60) || (totalMin < 8*60); // ข้ามเที่ยงคืน
    return true; // ไม่รู้กะ → แจ้งไปก่อน (ปลอดภัยไว้)
}

// ตรวจว่ามีใครพักเกิน 30 นาทีและยังไม่กลับ → แจ้งเตือนเข้าห้องแจ้งพัก (ซ้ำทุก 2 นาที)
async function checkLongBreaks() {
    try {
        if (!dataStore.breakChannels || dataStore.breakChannels.length === 0) return;
        const nowThai = getThaiTime();
        const realNow = Date.now(); // ⏱️ ใช้เวลาจริง (UTC) เทียบกับ break_start ที่เป็น UTC จริง

        // ดึงพักที่ยังไม่กลับ (break_end null) ด้วย created_at (ถูกเสมอ) ครอบ 48 ชม. — เผื่อ botlink เขียนวันสลับ
        const winStart = new Date(realNow - 48 * 60 * 60 * 1000).toISOString();
        let rawOpen = null;
        ({ data: rawOpen } = await supabase
            .from('break_sessions')
            .select('id, staff_name, break_start, break_reason, break_date, channel_id, message_id, created_at')
            .gte('created_at', winStart)
            .is('break_end', null)
            .order('break_start', { ascending: true }));
        if (rawOpen === null) {
            // คอลัมน์ channel_id/message_id อาจยังไม่มี → ดึงแบบไม่มี
            ({ data: rawOpen } = await supabase
                .from('break_sessions')
                .select('id, staff_name, break_start, break_reason, break_date, created_at')
                .gte('created_at', winStart)
                .is('break_end', null)
                .order('break_start', { ascending: true }));
        }
        const openBreaks = (rawOpen || []).map(normalizeBreakRow);

        if (openBreaks.length === 0) {
            lastAlertTime.clear();
            return;
        }

        // รวม record ของคนเดียวกัน (botlink NULL-id + Discord มี-id อาจซ้ำ) → 1 คน 1 การแจ้ง
        // ยึด created_at เป็นเวลาเริ่มพักจริง และเก็บ record ที่มี message id ไว้ reply ข้อความเดิม
        const byStaff = new Map();
        for (const b of openBreaks) {
            const key = (b.staff_name || '').toUpperCase().trim();
            if (!key) continue;
            const startMs = new Date(b.created_at || b.break_start).getTime();
            const cur = byStaff.get(key);
            if (!cur) {
                byStaff.set(key, {
                    staff_name: b.staff_name, key, startMs,
                    reason: b.break_reason || null,
                    channel_id: b.channel_id || null, message_id: b.message_id || null,
                });
            } else {
                if (startMs < cur.startMs) cur.startMs = startMs;           // พักจริงเริ่มเมื่อไหร่ = เร็วสุด
                if (!cur.reason && b.break_reason) cur.reason = b.break_reason;
                if ((!cur.channel_id || !cur.message_id) && b.channel_id && b.message_id) {
                    cur.channel_id = b.channel_id; cur.message_id = b.message_id; // เก็บ id ไว้ reply
                }
            }
        }

        const activeKeys = new Set();
        for (const p of byStaff.values()) {
            const elapsedMin = Math.floor((realNow - p.startMs) / 60000);
            // ยังไม่ถึง 30 นาที หรือค่าเพี้ยนข้ามวัน → ข้าม
            if (elapsedMin < LONG_BREAK_LIMIT_MIN || elapsedMin >= 24 * 60) continue;

            // เลยเวลาเลิกกะของคนนั้นแล้ว → ไม่แจ้ง
            const shift = await getStaffShift(p.staff_name);
            if (!isWithinShift(shift, nowThai)) { lastAlertTime.delete(p.key); continue; }
            activeKeys.add(p.key);

            // แจ้งซ้ำทุก 2 นาที
            const last = lastAlertTime.get(p.key) || 0;
            if (realNow - last < ALERT_REPEAT_MIN * 60000) continue;

            // เวลาเริ่มพัก แสดงเป็นเวลาไทย (created_at เป็น UTC จริง → +7 ชม.)
            const st = new Date(p.startMs + 7 * 3600000);
            const startStr = `${String(st.getUTCHours()).padStart(2, '0')}:${String(st.getUTCMinutes()).padStart(2, '0')}`;
            const reasonStr = p.reason || '☕ พัก';
            const msg = `⚠️ **แจ้งเตือนพักนาน**\n👤 **${p.staff_name}** พักเกิน ${LONG_BREAK_LIMIT_MIN} นาทีแล้ว!\n${reasonStr} · เริ่มพักเวลา ${startStr} น. (ผ่านมา ${elapsedMin} นาที)\n⏰ ยังไม่กดกลับที่นั่ง`;

            // 💬 ตอบกลับ (reply) ข้อความพักเดิมของคนนั้น ถ้ามี id — ไม่งั้น fallback เข้าห้องแจ้งพัก
            await sendBreakAlert(p.channel_id, p.message_id, msg);
            lastAlertTime.set(p.key, realNow);
            console.log(`[LongBreak] 🔔 แจ้งเตือน ${p.staff_name} พัก ${elapsedMin} นาที (${p.key})`);
        }

        // เคลียร์ key ที่ไม่ได้พักแล้วออกจาก Map (กัน memory โต)
        for (const k of lastAlertTime.keys()) {
            if (!activeKeys.has(k)) lastAlertTime.delete(k);
        }
    } catch (err) {
        console.error('[LongBreak] error:', err);
    }
}

// 📊 ตรวจยอดพักสะสมต่อวัน → ถ้าถึง 110 นาที แจ้งเตือนเตือนใกล้โดนปรับ (แจ้งครั้งเดียวต่อคนต่อวัน)
async function checkDailyTotalBreaks() {
    try {
        if (!dataStore.breakChannels || dataStore.breakChannels.length === 0) return;
        const breakDate = getBreakDateStr();
        const prevDate = toDateStr(new Date(getThaiTime().getTime() - 24 * 60 * 60 * 1000));
        const nowThai = getThaiTime();
        const realNow = Date.now(); // ⏱️ เวลาจริง (UTC) เทียบกับ break_start ที่เป็น UTC จริง

        // ดึงพักด้วย created_at (ถูกเสมอ) ครอบ 48 ชม. เผื่อ botlink เขียนวันสลับ แล้ว normalize + กรอง break_date
        const winStart = new Date(realNow - 48 * 60 * 60 * 1000).toISOString();
        let rawAll = null;
        ({ data: rawAll } = await supabase
            .from('break_sessions')
            .select('id, staff_name, break_start, break_end, break_date, channel_id, message_id, created_at')
            .gte('created_at', winStart)
            .order('break_start', { ascending: true }));
        if (rawAll === null) {
            ({ data: rawAll } = await supabase
                .from('break_sessions')
                .select('id, staff_name, break_start, break_end, break_date, created_at')
                .gte('created_at', winStart)
                .order('break_start', { ascending: true }));
        }
        const allBreaks = (rawAll || []).map(normalizeBreakRow)
            .filter(b => b.break_date === breakDate || b.break_date === prevDate);
        if (allBreaks.length === 0) return;

        // จัดกลุ่มตาม staff_name + break_date (แยกยอดแต่ละวัน)
        const byStaffDay = {};
        for (const b of allBreaks) {
            if (!b.staff_name || !b.staff_name.trim()) continue; // ข้ามชื่อว่าง
            const key = `${b.staff_name}|${b.break_date}`;
            if (!byStaffDay[key]) byStaffDay[key] = [];
            byStaffDay[key].push(b);
        }

        for (const [key, sessions] of Object.entries(byStaffDay)) {
            if (dailyWarnedStaff.has(key)) continue; // แจ้งไปแล้ววันนี้ ข้าม

            const [staffName] = key.split('|');
            const shift = await getStaffShift(staffName);

            // ⏰ ถ้าเลยเวลาเลิกกะของคนนั้นแล้ว → ไม่แจ้ง (กันแจ้งคนที่เลิกงานไปแล้ว)
            if (!isWithinShift(shift, nowThai)) continue;

            // ตัด record คร่อม 01:01 (เฉพาะกะดึก) ให้ตรงกับ Dashboard
            const cleaned = sessions.filter(s => {
                if (shift === 'night' && crossesOneAMBot(s.break_start, s.break_end)) return false;
                return true;
            });
            // เรียง + รวม record ซ้ำ (เริ่มห่าง < 3 นาที = รอบเดียว)
            const sorted = cleaned.slice().sort((a, b) => new Date(a.break_start) - new Date(b.break_start));
            const merged = [];
            for (const s of sorted) {
                const last = merged[merged.length - 1];
                if (last) {
                    const gap = Math.abs(new Date(s.break_start) - new Date(last.break_start)) / 60000;
                    if (gap < 3) { if (!last.break_end && s.break_end) last.break_end = s.break_end; continue; }
                }
                merged.push({ break_start: s.break_start, break_end: s.break_end });
            }
            // รวมเวลา (รอบที่ยังไม่กลับ นับถึงเวลาปัจจุบัน)
            let totalMin = 0;
            for (const s of merged) {
                const startMs = new Date(s.break_start).getTime();
                const endMs = s.break_end ? new Date(s.break_end).getTime() : realNow;
                const dur = Math.floor((endMs - startMs) / 60000);
                if (dur > 0 && dur < 24 * 60) totalMin += dur;
            }

            // ถึงเกณฑ์ 110 นาที → แจ้งเตือน (ตอบกลับข้อความพักล่าสุดของคนนั้น)
            if (totalMin >= DAILY_WARN_MIN) {
                const msg = `📊 **แจ้งเตือนเวลาพักสะสม**\n👤 **${staffName}** วันนี้ใช้เวลาพักไป **${totalMin} นาที** แล้ว\n⚠️ หากเกิน ${DAILY_LIMIT_MIN} นาทีอาจทำให้โดนปรับ\n💚 บริหารเวลากันดีๆ นะจ๊ะ`;
                // หา record ล่าสุดของคนนี้ที่มี message id เพื่อ reply
                const withMsg = sessions.filter(s => s.channel_id && s.message_id)
                    .sort((a, b) => new Date(b.break_start) - new Date(a.break_start))[0];
                await sendBreakAlert(withMsg ? withMsg.channel_id : null, withMsg ? withMsg.message_id : null, msg);
                dailyWarnedStaff.add(key);
                console.log(`[DailyBreak] 📊 แจ้งเตือน ${staffName} ยอดสะสม ${totalMin} นาที (${key})`);
            }
        }

        // เคลียร์ key เก่าที่ไม่ใช่วันนี้/เมื่อวาน ออกจาก Set (กัน memory โต)
        for (const key of dailyWarnedStaff) {
            const d = key.split('|')[1];
            if (d !== breakDate && d !== prevDate) dailyWarnedStaff.delete(key);
        }
    } catch (err) {
        console.error('[DailyBreak] error:', err);
    }
}

function resolveShiftKey(raw) {
    const s = (raw || '').toString().trim().toLowerCase();
    if (!s || s === 'คงเดิม' || s === 'same' || s === 'keep') return null;
    if (s.includes('เช้า') || s.includes('morning') || s === 'm' || s === 'am') return 'morning';
    if (s.includes('เที่ยง') || s.includes('บ่าย') || s.includes('noon') || s.includes('afternoon') || s === 'n') return 'noon';
    if (s.includes('ดึก') || s.includes('กลางคืน') || s.includes('night') || s.includes('evening') || s === 'pm') return 'night';
    return null;
}

function isSamePerson(staffNameUpper, leaveNameUpper) {
    const s = (staffNameUpper || '').trim();
    const l = (leaveNameUpper || '').trim();
    if (!s || !l) return false;
    if (s === l) return true;
    const sTokens = s.split(/[-_/\s]+/).filter(Boolean);
    const lTokens = l.split(/[-_/\s]+/).filter(Boolean);
    if (lTokens.length === 1 && sTokens.includes(lTokens[0])) return true;
    if (sTokens.length === 1 && lTokens.includes(sTokens[0])) return true;
    return false;
}

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
            console.warn(`⚠️ [AutoSwap] project=${leaveHost} | ตาราง scheduled_tasks ว่าง (0 แถว)`);
            return;
        }
        const tasks = recent.slice().reverse();
        console.log(`🩺 [AutoSwap] project=${leaveHost} | ดึงงานล่าสุดได้ ${tasks.length} แถว (ทุก status, ไม่จำกัดช่วงวัน)`);
        const summary = {};
        for (const t of tasks) { const k = `${t.task_type}|${t.status}`; summary[k] = (summary[k] || 0) + 1; }
        console.log("🩺 [AutoSwap] task_type|status ที่เจอ:", JSON.stringify(summary));
        const SKIP_STATUS = ['cancelled', 'canceled', 'failed', 'rejected', 'deleted', 'error'];
        let applied = 0;
        for (const task of tasks) {
            if (processedTasks.has(task.id)) continue;
            const ttype = (task.task_type || '').toLowerCase();
            const tstatus = (task.status || '').toLowerCase();
            const isShiftTask = ttype.includes('shift') || ttype.includes('กะ');
            if (!isShiftTask || SKIP_STATUS.includes(tstatus)) { processedTasks.add(task.id); continue; }
            if (task.scheduled_for && new Date(task.scheduled_for).getTime() > now.getTime()) continue;
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


// ===== ดึงรายชื่อสับกะจาก scheduled_tasks (ใช้ from_shift) =====
async function getSwapListFromScheduledTasks(targetDate, currentShift) {
    if (!supabaseLeave) return [];
    try {
        const startOfDay = new Date(targetDate + 'T00:00:00+07:00').toISOString();
        const endOfDay = new Date(targetDate + 'T23:59:59+07:00').toISOString();
        const { data, error } = await supabaseLeave
            .from('scheduled_tasks')
            .select('payload, scheduled_for')
            .eq('task_type', 'individual_shift_update')
            .neq('status', 'cancelled')
            .neq('status', 'info_only')
            .gte('scheduled_for', startOfDay)
            .lte('scheduled_for', endOfDay);
        if (error || !data) return [];
        const shiftMap = { 'กะเช้า': 'morning', 'เช้า': 'morning', 'กะดึก': 'night', 'ดึก': 'night', 'กะกลาง': 'noon', 'เที่ยง': 'noon' };
        const result = [];
        for (const task of data) {
            let p = task.payload;
            if (typeof p === 'string') { try { p = JSON.parse(p); } catch(e) { continue; } }
            if (!p || !p.user_name) continue;
            const fromShift = shiftMap[p.from_shift] || null;
            if (!fromShift) continue;
            if (fromShift === currentShift) {
                result.push({ name: p.user_name });
            }
        }
        return result;
    } catch(e) { return []; }
}
// ===== จบ getSwapListFromScheduledTasks =====

async function getLeavesFromSupabase(department = 'ALL') {
    const targetDate = getSupabaseDateStr();
    let result = { morning: [], noon: [], night: [] };
    if (!supabaseLeave) return result; 
    try {
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
                        const _e1 = staffData[dept].morning[id]; const staffName = (typeof _e1 === 'object' ? _e1.name : _e1).trim().toUpperCase();
                        if (isSamePerson(staffName, cleanLeaveName)) { shiftFound = 'morning'; userDeptFound = dept; break; }
                    }
                }
                if (!shiftFound && staffData[dept].noon) {
                    for (const id in staffData[dept].noon) {
                        const _e2 = staffData[dept].noon[id]; const staffName = (typeof _e2 === 'object' ? _e2.name : _e2).trim().toUpperCase();
                        if (isSamePerson(staffName, cleanLeaveName)) { shiftFound = 'noon'; userDeptFound = dept; break; }
                    }
                }
                if (!shiftFound && staffData[dept].night) {
                    for (const id in staffData[dept].night) {
                        const _e3 = staffData[dept].night[id]; const staffName = (typeof _e3 === 'object' ? _e3.name : _e3).trim().toUpperCase();
                        if (isSamePerson(staffName, cleanLeaveName)) { shiftFound = 'night'; userDeptFound = dept; break; }
                    }
                }
                if (shiftFound) break;
            }
            if (department !== 'ALL' && userDeptFound && userDeptFound.toUpperCase() !== department.toUpperCase()) return; 
            const rawAction = activeLeaves[leaveName].toUpperCase().trim();
            let leaveType = "วันหยุด";
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
            const staffDataObj = await fetchStaffData();
            let shiftIcon = "☀️ กะเช้า";
            let currentShiftKey = 'morning';
            let currentShiftLeaves = leavesObj.morning || [];
            if (shiftTypeLower.includes('night') || shiftTypeLower.includes('ดึก')) {
                shiftIcon = "🌙 กะดึก";
                currentShiftKey = 'night';
                currentShiftLeaves = leavesObj.night || [];
            } else if (shiftTypeLower.includes('noon') || shiftTypeLower.includes('afternoon') || shiftTypeLower.includes('เที่ยง') || shiftTypeLower.includes('บ่าย')) {
                shiftIcon = "🕛 กะเที่ยง";
                currentShiftKey = 'noon';
                currentShiftLeaves = leavesObj.noon || [];
            }
            const todayDateStr = getSupabaseDateStr();
            const swapFromScheduled = await getSwapListFromScheduledTasks(todayDateStr, currentShiftKey);
            const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
            const tChannel = await client.channels.fetch(channelId).catch(() => null);
            if (guild && tChannel) {
                let summary = `📊 **สรุปรายชื่อพนักงาน แผนก: ${session.department === 'ALL' ? tChannel.name : session.department}**\n📅 วันที่: ${dateTh}\n──────────────────────────\n`;
                const seenIds = new Set();
                const uniqueMembers = session.members.filter(m => {
                    if (seenIds.has(m.id)) return false;
                    seenIds.add(m.id);
                    return true;
                });
                summary += `✅ **เช็คชื่อสำเร็จ:**\n`;
                if (uniqueMembers.length > 0) {
                    const morningShift = uniqueMembers.filter(m => m.shift.includes("กะเช้า"));
                    const noonShift = uniqueMembers.filter(m => m.shift.includes("กะเที่ยง"));
                    const nightShift = uniqueMembers.filter(m => m.shift.includes("กะดึก"));
                    if (morningShift.length > 0) {
                        summary += `\n☀️ **กะเช้า:**\n`;
                        morningShift.forEach((m, i) => {
                            const HH = m.time.getHours().toString().padStart(2, '0');
                            const MM = m.time.getMinutes().toString().padStart(2, '0');
                            summary += `   ${i + 1}. **${m.name}** (เวลา ${HH}:${MM} น.)\n`;
                        });
                    }
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
                const dayOffs = currentShiftLeaves.filter(l => l.type === "วันหยุด");
                const swapShift = swapFromScheduled.length > 0 ? swapFromScheduled : currentShiftLeaves.filter(l => l.type === "สับกะ");
                const klLeaves = currentShiftLeaves.filter(l => l.type === "ลากิจ");
                const vacations = currentShiftLeaves.filter(l => l.type === "พักร้อน");
                summary += `\n😴 **รายชื่อหยุดปกติ (${shiftIcon}):**\n`;
                if (dayOffs.length > 0) { dayOffs.forEach((l, i) => summary += `   ${i + 1}. **${l.name}**\n`); } else { summary += `- ไม่มี -\n`; }
                summary += `\n🔄 **รายชื่อสับกะ (${shiftIcon}):**\n`;
                if (swapShift.length > 0) { swapShift.forEach((l, i) => summary += `   ${i + 1}. **${l.name}**\n`); } else { summary += `- ไม่มี -\n`; }
                summary += `\n📝 **รายชื่อลากิจ (${shiftIcon}):**\n`;
                if (klLeaves.length > 0) { klLeaves.forEach((l, i) => summary += `   ${i + 1}. **${l.name}**\n`); } else { summary += `- ไม่มี -\n`; }
                summary += `\n🏖️ **รายชื่อพักร้อน (${shiftIcon}):**\n`;
                if (vacations.length > 0) { vacations.forEach((l, i) => summary += `   ${i + 1}. **${l.name}**\n`); } else { summary += `- ไม่มี -\n`; }
                let missingMembers = [];
                const departmentVoiceRooms = new Set();
                session.members.forEach(m => {
                    if (m.voiceChannelId) { departmentVoiceRooms.add(m.voiceChannelId); }
                    else {
                        const vs = guild.voiceStates.cache.get(m.id);
                        if (vs?.channelId) departmentVoiceRooms.add(vs.channelId);
                    }
                });
                departmentVoiceRooms.forEach(vId => {
                    const vRoom = guild.channels.cache.get(vId);
                    if (vRoom) {
                        vRoom.members.forEach(member => {
                            if (member.user.bot) return;
                            if (checkedIds.has(member.id)) return;

                            // เช็คว่าคนนี้อยู่ใน staff_list ของกะและ TAG ที่ถูกต้องไหม
                            let inCorrectShiftAndDept = false;
                            const targetDept = session.department.toUpperCase();
                            const depts = targetDept === 'ALL'
                                ? Object.keys(staffDataObj)
                                : targetDept.includes(',')
                                    ? targetDept.split(',').map(d => d.trim())
                                    : [targetDept];

                            for (const dept of depts) {
                                if (staffDataObj[dept] && staffDataObj[dept][currentShiftKey] && staffDataObj[dept][currentShiftKey][member.id]) {
                                    inCorrectShiftAndDept = true;
                                    break;
                                }
                            }
                            if (!inCorrectShiftAndDept) return; // ไม่ใช่ TAG/กะที่ถูกต้อง → ข้ามไป

                            const staffName = getStaffName(member.id, member.displayName, staffDataObj);
                            const cleanName = staffName.trim().toUpperCase();
                            let isLeave = false;
                            for (const lData of currentShiftLeaves) { 
                                if (cleanName.includes(lData.name.toUpperCase())) { isLeave = true; break; }
                            }
                            if (!isLeave) {
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
                    const currentStaffData = await fetchStaffData(); 
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
                    for (const [staffId, _staffEntry] of Object.entries(shiftStaff)) {
                        const staffName = typeof _staffEntry === 'object' ? _staffEntry.name : _staffEntry;
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
                summary += `**รวมทั้งสิ้น: ${uniqueMembers.length} ท่าน**\n`;
                await sendLongMessage(tChannel, summary);
            }
        } catch (err) { console.error(err); } finally {
            const tChannel = await client.channels.fetch(channelId).catch(() => null);
            const sess = activeSessions.get(channelId);
            // ⏰ ไม่ลบ session ทันที — เปลี่ยนเป็นเฟส "รับสาย" ต่ออีก 1 ชั่วโมง
            if (sess && !sess.latePhase) {
                sess.latePhase = true;
                sess.summaryDone = true;
                if (tChannel) {
                    tChannel.send(`🏁 **จบรอบเช็คชื่อปกติ แผนก: ${session.department} แล้วค่ะ**\n⏰ ยังเปิดรับเช็คชื่อต่ออีก **1 ชั่วโมง** สำหรับคนมาสาย (จะติดสถานะ **มาสาย**)`);
                }
                // หลัง 1 ชม. ปิด session เงียบๆ ไม่สรุปซ้ำ
                setTimeout(() => {
                    activeSessions.delete(channelId);
                    console.log(`[Checkin] ปิดเฟสรับสายห้อง ${channelId} แล้ว (ครบ 1 ชม.)`);
                }, 60 * 60000);
            } else {
                // เผื่อกรณีผิดปกติ — ลบทิ้งตามเดิม
                activeSessions.delete(channelId);
                if (tChannel) tChannel.send(`🏁 **จบการสรุปผล แผนก: ${session.department} เรียบร้อยแล้วค่ะ**`);
            }
        }
    }, (activeSessions.get(channelId)?.duration || 10) * 60000);
}

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

function buildKPIMessage(staffName, result, label) {
    const { totalCheckins, onTimePct, afkDays, leaveDays, absentDays, workDays } = result;
    const scoreCheckin  = Math.min(100, Math.round((totalCheckins / Math.max(workDays, 1)) * 100));
    const scoreOnTime   = onTimePct;
    const scoreAfk      = Math.max(0, 100 - (afkDays * 10));
    const scoreAbsent   = Math.max(0, 100 - (absentDays * 20));
    const overall       = Math.round((scoreCheckin + scoreOnTime + scoreAfk + scoreAbsent) / 4);
    const grade = overall >= 90 ? '🏆 S' : overall >= 75 ? '🥇 A' : overall >= 60 ? '🥈 B' : overall >= 45 ? '🥉 C' : '❌ D';
    return `📊 **KPI ของ ${staffName}** (${label})\n` +
        `──────────────────────────\n` +
        `📅 วันทำงานทั้งหมด: **${workDays} วัน**\n\n` +
        `✅ เช็คชื่อ: **${totalCheckins} ครั้ง** (${scoreCheckin}%)\n` +
        `⏰ ตรงเวลา: **${onTimePct}%**\n` +
        `😴 AFK: **${afkDays} วัน** (คะแนน ${scoreAfk}%)\n` +
        `📝 ลา: **${leaveDays} วัน**\n` +
        `❓ ขาด: **${absentDays} วัน** (คะแนน ${scoreAbsent}%)\n` +
        `──────────────────────────\n` +
        `🎯 **ภาพรวม: ${overall}% ${grade}**`;
}

async function buildTeamKPIMessage(dept, startDate, endDate, label) {
    const staffData = await fetchStaffData();
    const deptData  = staffData[dept.toUpperCase()];
    if (!deptData) return `❌ ไม่พบแผนก ${dept}`;
    let msg = `📊 **KPI แผนก ${dept}** (${label})\n──────────────────────────\n`;
    for (const shift of ['morning', 'noon', 'night']) {
        if (!deptData[shift] || Object.keys(deptData[shift]).length === 0) continue;
        const shiftLabel = shift === 'morning' ? '☀️ กะเช้า' : shift === 'noon' ? '🕛 กะเที่ยง' : '🌙 กะดึก';
        msg += `\n${shiftLabel}\n`;
        for (const [, name] of Object.entries(deptData[shift])) {
            const shortName = name.replace(/^(AMOL|ODOL)[-\s]/i, '').trim();
            const result    = await calcKPI(shortName, startDate, endDate);
            const overall   = Math.round((
                Math.min(100, Math.round((result.totalCheckins / Math.max(result.workDays, 1)) * 100)) +
                result.onTimePct +
                Math.max(0, 100 - result.afkDays * 10) +
                Math.max(0, 100 - result.absentDays * 20)
            ) / 4);
            const grade = overall >= 90 ? 'S' : overall >= 75 ? 'A' : overall >= 60 ? 'B' : overall >= 45 ? 'C' : 'D';
            msg += `   • **${name}** — ${overall}% [${grade}] | เช็ค ${result.totalCheckins}ครั้ง ตรงเวลา ${result.onTimePct}% AFK ${result.afkDays}วัน ขาด ${result.absentDays}วัน\n`;
        }
    }
    return msg;
}

// ==========================================
// 🤖 Discord Bot
// ==========================================

const client = new Client({
    intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent ]
});

client.on('messageCreate', async (message) => {
    const channelId = message.channel.id;

    // ── ดักข้อความพักจากบอทอื่น / webhook ──────────────────────────────────
    if (message.author.bot || message.webhookId) {
        if (dataStore.breakChannels.includes(channelId)) {
            // 🔍 DEBUG: log ทุกข้อความที่เข้ามาในห้องแจ้งพัก
            console.log(`[Break-DEBUG] ห้อง=${channelId} | user=${message.author?.username || '?'} | webhookId=${message.webhookId || '-'} | content="${message.content}"`);
            try {
                await handleBreakMessage(message.content || '', message);
            } catch (e) {
                console.error('[Break] handle error:', e);
            }
        }
        return;
    }
    // ── จบส่วนดักบอท ──────────────────────────────────────────────────────

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

    // ── !testbreak : ทดสอบระบบดักพักด้วยตัวเอง ──
    if (message.content.startsWith('!testbreak')) {
        const arg = message.content.replace('!testbreak', '').trim();
        const sample = arg || 'TESTUSER ไปกินข้าว';
        await message.reply(`🧪 ทดสอบดักข้อความพัก: \`${sample}\`\nกำลังประมวลผล... (ดู Log)`);
        const isReg = dataStore.breakChannels.includes(channelId);
        await handleBreakMessage(sample);
        return message.channel.send(`ℹ️ ห้องนี้ ${isReg ? '✅ เป็นห้องแจ้งพัก' : '❌ ยังไม่ได้ลงทะเบียนห้องแจ้งพัก'} | breakChannels = [${dataStore.breakChannels.join(', ') || 'ว่าง'}]`);
    }

    // ── !listbreak : ดูว่าห้องไหนลงทะเบียนแจ้งพักบ้าง ──
    if (message.content === '!listbreak') {
        if (dataStore.breakChannels.length === 0) return message.reply('📭 ยังไม่มีห้องแจ้งพักที่ลงทะเบียนค่ะ');
        const list = dataStore.breakChannels.map((id, i) => `${i+1}. <#${id}> (\`${id}\`)`).join('\n');
        return message.reply(`📋 **ห้องแจ้งพักที่ลงทะเบียน:**\n${list}`);
    }

    // !addstaff และ !removestaff ถูกลบออกแล้ว — ใช้ปุ่ม Sync บนหน้าเว็บแทน

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
            const formatLeaveItem = (l, i) => {
                let typeIcon = '(วันหยุด 😴)';
                if (l.type === 'ลากิจ') typeIcon = '(ลากิจ 📝)';
                else if (l.type === 'พักร้อน') typeIcon = '(พักร้อน 🏖️)';
                else if (l.type === 'สับกะ') typeIcon = '(สับกะ 🔄)';
                return `${i + 1}. ${l.name} ${typeIcon}`;
            };
            if (leavesObj.morning && leavesObj.morning.length > 0) { msg += `☀️ **กะเช้า (${leavesObj.morning.length} ท่าน):**\n` + leavesObj.morning.map(formatLeaveItem).join('\n') + `\n\n`; }
            if (leavesObj.noon && leavesObj.noon.length > 0) { msg += `🕛 **กะเที่ยง (${leavesObj.noon.length} ท่าน):**\n` + leavesObj.noon.map(formatLeaveItem).join('\n') + `\n\n`; }
            if (leavesObj.night && leavesObj.night.length > 0) { msg += `🌙 **กะดึก (${leavesObj.night.length} ท่าน):**\n` + leavesObj.night.map(formatLeaveItem).join('\n') + `\n\n`; }
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

    if (message.content === '!addbreakchannel') {
        const hasPermission = message.member.roles.cache.some(role => ['PTT', 'TT HAED', 'TT HEAD'].includes(role.name.toUpperCase()));
        if (!hasPermission) return message.reply('❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้ค่ะ');
        if (dataStore.breakChannels.includes(channelId)) return message.reply('⚠️ ห้องนี้ลงทะเบียนเป็นห้องแจ้งพักไว้แล้วค่ะ');
        dataStore.breakChannels.push(channelId);
        saveData();
        return message.reply(`✅ ตั้งค่าห้อง <#${channelId}> เป็นห้องแจ้งพักเรียบร้อยแล้วค่ะ`);
    }

    if (message.content === '!removebreakchannel') {
        const index = dataStore.breakChannels.indexOf(channelId);
        if (index > -1) {
            dataStore.breakChannels.splice(index, 1);
            saveData();
            return message.reply(`🗑️ ยกเลิกห้อง <#${channelId}> จากระบบแจ้งพักเรียบร้อยแล้วค่ะ`);
        }
        return message.reply('⚠️ ห้องนี้ไม่ได้ลงทะเบียนเป็นห้องแจ้งพักอยู่ค่ะ');
    }

    if (message.content.startsWith('!startcheckin')) {
        if (!(await isCheckinChannel(channelId))) return message.reply('❌ ห้องนี้ยังไม่ได้ตั้งค่าในระบบค่ะ');
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
        if (!(await isCheckinChannel(channelId))) return;

        const member = message.member; // ← ย้ายขึ้นมาก่อนใช้ (แก้ ReferenceError ใน temporal dead zone)

        // ===== เช็ค TAG ตาม channel_settings =====
        try {
            const { data: chanSetting } = await supabase
                .from('channel_settings')
                .select('allowed_tags')
                .eq('channel_id', channelId)
                .maybeSingle();

            if (chanSetting && chanSetting.allowed_tags && chanSetting.allowed_tags.length > 0) {
                // ดึง TAG ของคนนี้จาก staff_list
                const { data: staffRow } = await supabase
                    .from('staff_list')
                    .select('department, staff_name')
                    .eq('discord_id', member.id)
                    .maybeSingle();

                if (staffRow) {
                    const userTag = (staffRow.department || '').toUpperCase();
                    if (!chanSetting.allowed_tags.includes(userTag)) {
                        return message.reply(
                            `❌ ห้องนี้รับเช็คชื่อเฉพาะ **${chanSetting.allowed_tags.join(', ')}** เท่านั้นค่ะ\n` +
                            `คุณเป็น **${userTag}** กรุณาเช็คชื่อในห้องที่ถูกต้องแทนนะคะ`
                        );
                    }
                }
            }
        } catch (tagErr) {
            console.error('[checkin] channel tag check error:', tagErr);
        }
        // ===== จบเช็ค TAG =====
        // ⛔ ต้องรอบอทเปิดรอบเช็คชื่อก่อน — ถ้ายังไม่มี session เปิด ไม่ให้เช็ค
        if (!activeSessions.has(channelId)) {
            return message.reply('⏳ ยังไม่เปิดรับเช็คชื่อค่ะ กรุณารอบอทประกาศเปิดรอบก่อนนะคะ แล้วค่อยพิมพ์ `!checkin` อีกครั้ง');
        }
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
        const session      = activeSessions.get(channelId);
        const memberId     = member.id;
        const guildRef     = message.guild;
        const checkinTime  = getThaiTime();
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
        const voiceChId = member.voice.channelId;
        const statusMsg = await message.reply('⏳ กำลังตรวจสอบ 10 วินาที...');
        setTimeout(async () => {
            try {
                console.log(`[checkin] ตรวจสอบ ${staffName} หลัง 10 วินาที`);
                let isStreaming = false;
                try {
                    const freshMember = await guildRef.members.fetch(memberId);
                    isStreaming = !!(freshMember?.voice?.streaming);
                    console.log(`[checkin] ${staffName} streaming=${isStreaming}`);
                } catch (fetchErr) {
                    console.error('[checkin] fetch member error:', fetchErr);
                    isStreaming = true;
                }
                if (!isStreaming) { return statusMsg.edit('❌ เช็คชื่อล้มเหลว: ปิดแชร์หน้าจอก่อนเวลาค่ะ'); }
                const isLatePhase = session && session.latePhase;
                // เฟสปกติ: เก็บเข้า members เพื่อสรุปผล | เฟสสาย: ไม่เก็บ (สรุปไปแล้ว)
                let checkinOrder = 0;
                if (session && !isLatePhase && !session.members.some(m => m.id === memberId)) {
                    session.members.push({ id: memberId, name: staffName, time: checkinTime, shift: shiftName, voiceChannelId: voiceChId, lateMin });
                    checkinOrder = session.members.length; // บันทึกลำดับทันทีก่อน await อื่นๆ
                }
                const { data: doubleCheck } = await supabase
                    .from('checkins').select('id')
                    .eq('discord_id', memberId)
                    .gte('checkin_time', new Date(checkinTime.getTime() - 30*60*1000).toISOString())
                    .lte('checkin_time', new Date(checkinTime.getTime() + 1000).toISOString())
                    .limit(1);
                if (doubleCheck && doubleCheck.length > 0) { return statusMsg.edit('✅ คุณเช็คอินกะนี้ไปแล้วค่ะ ไม่สามารถเช็คซ้ำได้'); }
                // เฟสสาย: บังคับให้ติดสถานะสายเสมอ (ถ้ายังไม่มี lateMin ให้คิดจากเวลาจบรอบ)
                let finalLateMin = lateMin;
                if (isLatePhase && finalLateMin === 0) finalLateMin = 1; // อย่างน้อย 1 นาที เพื่อ mark ว่าสาย
                try {
                    await supabase.from('checkins').insert([{
                        discord_id: memberId, name: staffName,
                        checkin_time: checkinTime, shift: shiftName, late_minutes: finalLateMin
                    }]);
                } catch (dbErr) { console.error('❌ Supabase checkin Error:', dbErr); }
                if (isLatePhase) {
                    await statusMsg.edit('⏰ **เช็คชื่อสำเร็จ (มาสาย)** คุณอยู่ **' + shiftName + '** — รอบปกติจบไปแล้ว บันทึกเป็น **มาสาย** ค่ะ');
                } else {
                    const orderText = checkinOrder > 0 ? ' (ลำดับที่ ' + checkinOrder + ')' : '';
                    await statusMsg.edit('✅ **เช็คชื่อสำเร็จ!** คุณอยู่ **' + shiftName + '**' + lateText + orderText);
                }
                console.log(`[checkin] ✅ ${staffName} เช็คชื่อสำเร็จ${isLatePhase ? ' (เฟสสาย)' : ''}`);
            } catch (err) {
                console.error('[checkin] setTimeout error:', err);
                await statusMsg.edit('❌ เกิดข้อผิดพลาด กรุณาลองใหม่ค่ะ').catch(() => {});
            }
        }, 10000);
    }

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

client.once('ready', async () => { 
    console.log(`🚀 บอทพร้อม! ล็อกอินในชื่อ ${client.user.tag}`);
    await loadDataFromSupabase();
    console.log(`📋 [Init] breakChannels ที่โหลดมา: [${dataStore.breakChannels.join(', ') || 'ว่าง'}]`);

    // ลบข้อมูล checkins เก่ากว่า 2 เดือน ทุกวันที่ 1 เวลา 00:05
    cron.schedule('5 0 1 * *', async () => {
        try {
            const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
            const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth()-1, 1);
            const cutoff = twoMonthsAgo.getFullYear() + '-' + String(twoMonthsAgo.getMonth()+1).padStart(2,'0') + '-01';
            const cutoffISO = new Date(cutoff + 'T00:00:00+07:00').toISOString();
            const { error } = await supabase.from('checkins').delete().lt('checkin_time', cutoffISO);
            if (error) console.error('❌ [AutoClean] ลบ checkins เก่าไม่ได้:', error.message);
            else console.log('✅ [AutoClean] ลบ checkins ก่อน', cutoff, 'สำเร็จ');
        } catch(e) { console.error('❌ [AutoClean] error:', e.message); }
    });

    // Auto Sync พนักงานจาก K36 ทุก 1 ชั่วโมง
    cron.schedule('0 * * * *', async () => {
        try {
            if (!supabaseLeave) return;
            console.log('🔄 [AutoSync] กำลัง Sync พนักงานจาก K36...');
            const { data: users, error } = await supabaseLeave
                .from('users')
                .select('username, discord_id, telegram_id, tag, department, allowed_shift')
                .not('discord_id', 'is', null);
            if (error || !users) return console.error('❌ [AutoSync] ดึงข้อมูลไม่ได้:', error?.message);
            const shiftMap = { 'กะเช้า': 'morning', 'กะกลาง': 'noon', 'กะดึก': 'night' };
            for (const u of users.filter(u => u.discord_id && u.username)) {
                const dept = (u.tag || u.department || 'AMOL').toUpperCase();
                const { data: existing } = await supabase.from('staff_list').select('discord_id').eq('discord_id', u.discord_id).maybeSingle();
                if (existing) {
                    await supabase.from('staff_list').update({ staff_name: u.username, telegram_id: u.telegram_id || null, department: dept }).eq('discord_id', u.discord_id);
                } else {
                    const shift = shiftMap[u.allowed_shift] || 'morning';
                    await supabase.from('staff_list').insert({ discord_id: u.discord_id, staff_name: u.username, telegram_id: u.telegram_id || null, department: dept, shift });
                }
            }
            console.log(`✅ [AutoSync] Sync สำเร็จ ${users.length} คน`);
        } catch(e) { console.error('❌ [AutoSync] error:', e.message); }
    });

    cron.schedule('* * * * *', async () => {
        await processAutoShiftSwaps();
        // 🔔 ตรวจแจ้งเตือนพักนาน (เกิน 30 นาที) ทุก 1 นาที — reply ข้อความเดิมของคนที่ยังพักไม่กลับ
        // (ปิดแจ้งเตือนยอดสะสม 120 นาที/วัน ตามที่ผู้ใช้ต้องการ — ฟังก์ชัน checkDailyTotalBreaks ยังอยู่แต่ไม่ถูกเรียก)
        await checkLongBreaks();
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
        console.log(`[Auto] ${currentTimeStr} เปิดระบบเช็คชื่อ กะ: ${currentSlot.shift}`);
        const todayStr = getThaiDateStr();
        const shiftTypeLower = currentSlot.shift ? currentSlot.shift.toLowerCase() : 'morning';
        let shiftType = shiftTypeLower === 'morning' ? "Morning" : "Night";
        let shiftLabel = "☀️ กะเช้า";
        if (shiftTypeLower === 'night' || shiftTypeLower === 'ดึก') { shiftType = "Night"; shiftLabel = "🌙 กะดึก"; } 
        else if (shiftTypeLower === 'noon' || shiftTypeLower === 'afternoon' || shiftTypeLower === 'เที่ยง') { shiftType = "Noon"; shiftLabel = "🕛 กะเที่ยง"; }
        const checkinKey = `${todayStr}-${shiftType}-${currentTimeStr}`;
        const _autoChannels = await getCheckinChannels();
        for (const channelId of _autoChannels) {
            if (activeSessions.has(channelId)) continue; 
            if (dataStore.lastCheckinDates[channelId] === checkinKey) continue; 
            try {
                const channel = await client.channels.fetch(channelId);
                if (!channel) continue;
                let sessionDept = "ALL";
                const chName = channel.name.toUpperCase();
                if (chName.includes('ODOL')) sessionDept = "ODOL";
                else if (chName.includes('AMOL') || chName.includes('เช็คชื่อ')) sessionDept = "AMOL";
                let checkinDuration = 10; // รอบปกติ (auto) — จบแล้วต่อด้วยช่วงรับสาย 1 ชม.
                let displayEndTime = "ไม่ได้ระบุ";
                if (currentSlot.endTime && /^\d{1,2}:\d{2}$/.test(currentSlot.endTime) && currentSlot.time) {
                    const [sh, sm] = currentSlot.time.split(':').map(Number);
                    const [eh, em] = currentSlot.endTime.split(':').map(Number);
                    const startMin = sh * 60 + sm;
                    let endMin = eh * 60 + em;
                    if (endMin <= startMin) endMin += 24 * 60;
                    const diff = endMin - startMin;
                    if (diff >= 1 && diff <= 24 * 60) checkinDuration = diff;
                    displayEndTime = currentSlot.endTime;
                } else if (currentSlot.time) {
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

setInterval(async () => {
    try {
        console.log('🧹 [Housekeeper] Compressing old chats and clearing database...');
        const { error } = await supabase.rpc('compress_old_activity');
        if (error) { console.error("❌ [Housekeeper] Compression failed:", error); }
        else { console.log('✅ [Housekeeper] Chat history compressed to 1 row/day. Database cleaned!'); }
    } catch (e) { console.error("❌ [Housekeeper] System error:", e); }
}, 24 * 60 * 60 * 1000); 

cron.schedule('1 0 * * 1', async () => {
    try {
        console.log('📊 [Weekly Report] Starting weekly data aggregation...');
        const { error } = await supabase.rpc('generate_weekly_report');
        if (error) { console.error("❌ [Weekly Report] Aggregation failed:", error); }
        else {
            console.log('✅ [Weekly Report] Weekly stats saved successfully!');
            const adminChannel = await client.channels.fetch('1442466109503569992').catch(() => null);
            if (adminChannel) {
                adminChannel.send("📅 **[ระบบสรุปผลรายสัปดาห์]** บันทึกยอดรวมพนักงานทุกคนในสัปดาห์ที่ผ่านมาลงฐานข้อมูลเรียบร้อยแล้วค่ะ!");
            }
        }
    } catch (e) { console.error("❌ [Weekly Report] System error:", e); }
}, { scheduled: true, timezone: "Asia/Bangkok" });

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

// ลบข้อมูล break_sessions ที่เก่ากว่า 7 วัน ทุกเที่ยงคืน (เวลาไทย)
cron.schedule('0 0 * * *', async () => {
    try {
        const now = new Date(new Date().getTime() + 7 * 3600000); // Thai time
        const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const cutoffStr = cutoff.toISOString().split('T')[0];
        const { error, count } = await supabase
            .from('break_sessions')
            .delete()
            .lt('break_date', cutoffStr);
        if (error) { console.error('❌ [BreakCleanup] Error:', error); }
        else { console.log(`🧹 [BreakCleanup] ลบข้อมูลพักก่อน ${cutoffStr} เรียบร้อย`); }
    } catch (e) { console.error('❌ [BreakCleanup] System error:', e); }
}, { scheduled: true, timezone: 'Asia/Bangkok' });

app.listen(PORT, '0.0.0.0', () => { console.log(`🌐 Server web port is open and listening on port ${PORT}!`); });

client.login(process.env.TOKEN).catch(error => { console.error("❌ ล็อกอินล้มเหลว โปรดตรวจสอบ TOKEN อีกครั้ง:", error); });
