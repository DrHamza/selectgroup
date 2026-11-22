const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

// Load students data into memory
const studentsList = require('../data/students.json');
const initialAppData = require('../data/app_data.json');

// Fast lookup maps
const studentsById = new Map();
studentsList.forEach(s => studentsById.set(String(s.studentId).trim(), s));

// Helper: check if student belongs to the electronic distance track/section
function isElectronicSection(student) {
  if (!student) return false;
  const s = String(student.section || '').trim();
  const t = String(student.track || '');
  const h = String(student.hall || '');
  return s === '110' || s === '97' || t.includes('إلكتروني') || h.includes('افتراضية');
}

// Rule check: can candidate join leader's group?
function canTeamUp(leader, candidate, courseId) {
  if (courseId !== 'elearning') return true;
  const isLeaderElec = isElectronicSection(leader);
  const isCandidateElec = isElectronicSection(candidate);
  
  if (isLeaderElec) {
    // Both electronic sections (110 and 97) can partner with each other freely
    return isCandidateElec;
  } else {
    // Regular in-person students can mix freely, but cannot choose electronic section students (110 or 97)
    return !isCandidateElec;
  }
}

// Global cached state (for serverless reuse)
let memoryAppData = JSON.parse(JSON.stringify(initialAppData));

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function getAppData() {
  if (KV_URL && KV_TOKEN) {
    try {
      const res = await fetch(`${KV_URL}/get/app_data`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` }
      });
      const data = await res.json();
      if (data && data.result) {
        return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
      }
    } catch (e) {
      console.error('KV get error:', e);
    }
  }

  // Local file / /tmp fallback
  try {
    const tmpPath = '/tmp/app_data.json';
    if (fs.existsSync(tmpPath)) {
      return JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
    }
    const localPath = path.join(__dirname, '../data/app_data.json');
    if (fs.existsSync(localPath)) {
      return JSON.parse(fs.readFileSync(localPath, 'utf8'));
    }
  } catch (e) {}

  return memoryAppData;
}

async function saveAppData(data) {
  memoryAppData = data;

  if (KV_URL && KV_TOKEN) {
    try {
      await fetch(`${KV_URL}/set/app_data`, {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${KV_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
      });
    } catch (e) {
      console.error('KV set error:', e);
    }
  }

  try {
    const localPath = path.join(__dirname, '../data/app_data.json');
    fs.writeFileSync(localPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    try {
      fs.writeFileSync('/tmp/app_data.json', JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {}
  }
}

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body) {
      return resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Robust Pathname Extractor (Works with Vercel rewrites, headers, query and direct server)
function extractPathname(req) {
  const parsedUrl = url.parse(req.url, true);

  // 1. Check if rewrite passed __route in query (e.g. from vercel.json)
  if (parsedUrl.query && parsedUrl.query.__route) {
    let r = parsedUrl.query.__route;
    if (!r.startsWith('/')) r = '/' + r;
    if (!r.startsWith('/api')) r = '/api' + r;
    return r.replace(/\/+$/, '');
  }

  // 2. Check x-vercel-original-url header
  if (req.headers && req.headers['x-vercel-original-url']) {
    const orig = url.parse(req.headers['x-vercel-original-url']).pathname;
    if (orig && orig !== '/api/index.js' && orig !== '/api') return orig.replace(/\/+$/, '');
  }

  // 3. Check x-matched-path header
  if (req.headers && req.headers['x-matched-path']) {
    const matched = req.headers['x-matched-path'];
    if (matched && matched !== '/api/index.js' && matched !== '/api') return matched.replace(/\/+$/, '');
  }

  // 4. Check x-forwarded-uri header
  if (req.headers && req.headers['x-forwarded-uri']) {
    const fwd = url.parse(req.headers['x-forwarded-uri']).pathname;
    if (fwd && fwd !== '/api/index.js' && fwd !== '/api') return fwd.replace(/\/+$/, '');
  }

  // 5. Check [...slug] query from Vercel native catch-all
  if (parsedUrl.query && parsedUrl.query.slug) {
    const slugArr = Array.isArray(parsedUrl.query.slug) ? parsedUrl.query.slug : [parsedUrl.query.slug];
    return ('/api/' + slugArr.join('/')).replace(/\/+$/, '');
  }

  // 6. Direct req.url
  return (parsedUrl.pathname || '/').replace(/\/+$/, '');
}

// Master Request Handler
async function handleApi(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = extractPathname(req);
  const method = req.method;
  const appData = await getAppData();

  try {
    // 1. Health check
    if (pathname === '/api/health') {
      return sendJson(res, 200, { status: 'ok', serverTime: new Date().toISOString() });
    }

    // 2. Student Login (returns ONLY current student record, never the full list)
    if (pathname === '/api/student/login' && method === 'POST') {
      const body = await parseBody(req);
      const studentId = String(body.studentId || '').trim();
      const phone = String(body.phone || '').trim();
      const job = String(body.job || '').trim();
      const courseId = body.courseId || 'elearning';

      if (!studentId) {
        return sendJson(res, 400, { error: 'يرجى إدخال رقم الطالب' });
      }

      const student = studentsById.get(studentId);
      if (!student) {
        return sendJson(res, 404, { error: 'رقم الطالب غير مسجل في قاعدة البيانات' });
      }

      const expectedCourseName = courseId === 'elearning' ? 'التعليم الإلكترونى' : 'التفكير النقدي';
      if (student.courseName !== expectedCourseName) {
        return sendJson(res, 403, { 
          error: `هذا الطالب غير مسجل في مقرر ${expectedCourseName}، بل مسجل في ${student.courseName}` 
        });
      }

      // Check course registration open/closed status
      const courseConfig = appData.settings?.courses?.[courseId] || { isOpen: true };
      if (!courseConfig.isOpen) {
        return sendJson(res, 403, { error: 'عذراً، التسجيل في هذا المقرر مغلق حالياً بقرار من أستاذ المقرر' });
      }

      let dataChanged = false;
      if (phone) {
        if (!appData.studentPhones) appData.studentPhones = {};
        appData.studentPhones[studentId] = phone;
        dataChanged = true;
      }

      if (job) {
        if (!appData.studentJobs) appData.studentJobs = {};
        appData.studentJobs[studentId] = job;
        dataChanged = true;
      }

      if (dataChanged) {
        await saveAppData(appData);
      }

      const isElec = isElectronicSection(student);

      return sendJson(res, 200, {
        success: true,
        student: {
          studentId: student.studentId,
          name: student.name,
          courseName: student.courseName,
          courseCode: student.courseCode,
          section: student.section,
          track: student.track,
          hall: student.hall,
          day: student.day,
          time: student.time,
          isElecSection: isElec
        }
      });
    }

    // 3. Course Workspace Data (returns student's group, course status, and topic status)
    if (pathname === '/api/course-data' && method === 'GET') {
      const courseId = parsedUrl.query.courseId || 'elearning';
      const studentId = String(parsedUrl.query.studentId || '').trim();
      const student = studentsById.get(studentId);

      if (!student) {
        return sendJson(res, 404, { error: 'الطالب غير موجود' });
      }

      const courseConfig = appData.settings?.courses?.[courseId] || {
        id: courseId,
        name: courseId === 'elearning' ? 'التعليم الإلكتروني' : 'التفكير النقدي',
        isOpen: true
      };

      const activities = (appData.activities || []).filter(a => a.courseId === courseId);
      const presentationSlots = (appData.presentationSlots || []).filter(s => s.courseId === courseId);

      // Find my group
      const myGroup = (appData.groups || []).find(g => 
        g.courseId === courseId && g.members.some(m => m.studentId === studentId)
      );

      let groupSummary = null;
      if (myGroup) {
        const myMember = myGroup.members.find(m => m.studentId === studentId);
        groupSummary = {
          id: myGroup.id,
          groupNumber: myGroup.groupNumber,
          courseId: myGroup.courseId,
          leaderId: myGroup.leaderId,
          leaderName: myGroup.leaderName,
          topicId: myGroup.topicId,
          topicTitle: myGroup.topicTitle,
          presentationSlotId: myGroup.presentationSlotId,
          presentationSlotTitle: myGroup.presentationSlotTitle,
          teacherNotes: myGroup.teacherNotes,
          isApprovedByTeacher: !!myGroup.isApprovedByTeacher,
          isLocked: !!myGroup.isLocked,
          myStatus: myMember?.status || 'confirmed',
          members: myGroup.members.map(m => ({
            studentId: m.studentId,
            name: m.name,
            role: m.role,
            status: m.status,
            section: m.section
          }))
        };
      }

      const isElec = isElectronicSection(student);
      let sectionNotice = '';
      if (courseId === 'elearning') {
        if (isElec) {
          sectionNotice = 'تنبيه: أنت مقيد حصرياً باختيار زملاء من شعبتي التعليم الإلكتروني (شعبة 110 أو شعبة 97).';
        } else {
          sectionNotice = 'تنبيه: يمكنك تشكيل المجموعة من أي شعبة حضورية، مع منع اختيار طلاب شعبتي التعليم الإلكتروني (110 و 97).';
        }
      } else {
        sectionNotice = 'يمكنك اختيار زملائك وتشكيل مجموعتك بحرية من أي شعبة.';
      }

      return sendJson(res, 200, {
        course: courseConfig,
        activities,
        presentationSlots,
        maxGroupSize: appData.settings?.maxGroupSize || 10,
        myGroup: groupSummary,
        isElecSection: isElec,
        sectionNotice
      });
    }

    // 4. Search Colleagues On-Demand (Strictly Privacy-Preserving)
    if (pathname === '/api/student/search-peers' && method === 'GET') {
      const q = String(parsedUrl.query.q || '').trim();
      const studentId = String(parsedUrl.query.studentId || '').trim();
      const courseId = parsedUrl.query.courseId || 'elearning';

      if (!q || q.length < 2) {
        return sendJson(res, 200, { results: [] });
      }

      const student = studentsById.get(studentId);
      if (!student) {
        return sendJson(res, 404, { error: 'الطالب غير موجود' });
      }

      // Collect IDs of students already in confirmed groups in this course
      const busyStudentIds = new Set();
      (appData.groups || [])
        .filter(g => g.courseId === courseId)
        .forEach(g => {
          g.members.forEach(m => {
            if (m.status === 'confirmed') busyStudentIds.add(m.studentId);
          });
        });

      const expectedCourseName = courseId === 'elearning' ? 'التعليم الإلكترونى' : 'التفكير النقدي';
      const qLower = q.toLowerCase();

      const matched = [];
      for (const cand of studentsList) {
        if (cand.studentId === studentId) continue;
        if (cand.courseName !== expectedCourseName) continue;
        if (busyStudentIds.has(cand.studentId)) continue;

        // Check search query in Name or Student ID
        const matchName = cand.name.toLowerCase().includes(qLower);
        const matchId = cand.studentId.includes(q);
        if (!matchName && !matchId) continue;

        // Check Section rules requested by Dr. Hamza
        if (!canTeamUp(student, cand, courseId)) continue;

        matched.push({
          studentId: cand.studentId,
          name: cand.name,
          section: cand.section || 'عامة',
          track: cand.track || ''
        });

        if (matched.length >= 10) break; // Limit search results to 10
      }

      return sendJson(res, 200, { results: matched });
    }

    // 5. Create Group (Phase 1: Formation only, max 10)
    if (pathname === '/api/groups/create' && method === 'POST') {
      const body = await parseBody(req);
      const { courseId, leaderId, memberIds } = body;

      const courseConfig = appData.settings?.courses?.[courseId] || { isOpen: true };
      if (!courseConfig.isOpen) {
        return sendJson(res, 403, { error: 'التسجيل في هذا المقرر مغلق حالياً' });
      }

      const leader = studentsById.get(String(leaderId).trim());
      if (!leader) {
        return sendJson(res, 404, { error: 'بيانات قائد المجموعة غير صحيحة' });
      }

      if (!Array.isArray(memberIds) || memberIds.length === 0) {
        return sendJson(res, 400, { error: 'يرجى تحديد أعضاء المجموعة' });
      }

      const totalMembers = Array.from(new Set([leaderId, ...memberIds]));
      if (totalMembers.length > 10) {
        return sendJson(res, 400, { error: 'الحد الأقصى للمجموعة هو 10 طلاب ولا يمكن تجاوزه بأي حال' });
      }

      // Check if any member is already in a group
      const existing = (appData.groups || []).find(g => 
        g.courseId === courseId && g.members.some(m => totalMembers.includes(m.studentId) && m.status === 'confirmed')
      );
      if (existing) {
        return sendJson(res, 400, { error: 'أحد الطلاب المحددين مسجل بالفعل في مجموعة أخرى' });
      }

      // Validate Section rules for all selected members
      for (const mId of totalMembers) {
        const cand = studentsById.get(mId);
        if (!cand) continue;
        if (!canTeamUp(leader, cand, courseId)) {
          return sendJson(res, 400, { 
            error: `الطالب (${cand.name}) لا يتوافق مع شرط الشعبة المقرر لهذه المجموعة.` 
          });
        }
      }

      const courseGroups = (appData.groups || []).filter(g => g.courseId === courseId);
      const groupNumber = courseGroups.length + 1;

      const newGroup = {
        id: `grp_${courseId}_${Date.now()}`,
        groupNumber,
        courseId,
        leaderId: leader.studentId,
        leaderName: leader.name,
        members: totalMembers.map(mId => {
          const st = studentsById.get(mId);
          return {
            studentId: mId,
            name: st ? st.name : 'طالب',
            role: mId === leader.studentId ? 'leader' : 'member',
            status: mId === leader.studentId ? 'confirmed' : 'pending',
            section: st ? (st.section || 'عامة') : ''
          };
        }),
        topicId: null,
        topicTitle: null,
        presentationSlotId: null,
        presentationSlotTitle: null,
        isApprovedByTeacher: false,
        teacherNotes: '',
        isLocked: false,
        createdAt: new Date().toISOString()
      };

      if (!appData.groups) appData.groups = [];
      appData.groups.push(newGroup);
      await saveAppData(appData);

      return sendJson(res, 201, { success: true, group: newGroup });
    }

    // 6. Respond to Invitation (Accept / Decline)
    if (pathname === '/api/groups/respond-invitation' && method === 'POST') {
      const { courseId, studentId, accept } = await parseBody(req);
      const group = (appData.groups || []).find(g => 
        g.courseId === courseId && g.members.some(m => m.studentId === studentId)
      );

      if (!group) {
        return sendJson(res, 404, { error: 'المجموعة غير موجودة' });
      }

      const member = group.members.find(m => m.studentId === studentId);
      if (!member) {
        return sendJson(res, 404, { error: 'العضو غير موجود بالمجموعة' });
      }

      if (accept) {
        member.status = 'confirmed';
      } else {
        group.members = group.members.filter(m => m.studentId !== studentId);
      }

      await saveAppData(appData);
      return sendJson(res, 200, { success: true, group });
    }

    // 7. Leave / Disband Group
    if (pathname === '/api/groups/leave' && method === 'POST') {
      const { courseId, studentId } = await parseBody(req);
      const groupIndex = (appData.groups || []).findIndex(g => 
        g.courseId === courseId && g.members.some(m => m.studentId === studentId)
      );

      if (groupIndex === -1) {
        return sendJson(res, 404, { error: 'لم يتم العثور على المجموعة' });
      }

      const group = appData.groups[groupIndex];
      if (group.isApprovedByTeacher) {
        return sendJson(res, 403, { error: 'لا يمكن مغادرة المجموعة بعد اعتمادها نهائياً من أستاذ المقرر' });
      }

      if (group.leaderId === studentId) {
        // Leader disbanding group
        appData.groups.splice(groupIndex, 1);
      } else {
        group.members = group.members.filter(m => m.studentId !== studentId);
      }

      await saveAppData(appData);
      return sendJson(res, 200, { success: true, message: 'تم الخروج من المجموعة' });
    }

    // 8. Select Topic & Presentation Slot (Phase 2: Post-Approval only)
    if (pathname === '/api/groups/select-topic-and-slot' && method === 'POST') {
      const { courseId, studentId, topicId, slotId } = await parseBody(req);
      const group = (appData.groups || []).find(g => 
        g.courseId === courseId && g.members.some(m => m.studentId === studentId)
      );

      if (!group) {
        return sendJson(res, 404, { error: 'المجموعة غير موجودة' });
      }

      if (!group.isApprovedByTeacher) {
        return sendJson(res, 403, { 
          error: 'عذراً! لا يمكن اختيار الموضوع أو موعد العرض إلا بعد اعتماد تشكيل المجموعة نهائياً من أستاذ المقرر.' 
        });
      }

      const activity = (appData.activities || []).find(a => a.courseId === courseId);
      if (!activity) return sendJson(res, 404, { error: 'النشاط غير موجود' });

      // Topic validation
      const topic = activity.topics.find(t => t.id === topicId);
      if (!topic) return sendJson(res, 404, { error: 'الموضوع غير موجود' });

      if (topic.reservedByGroupId && topic.reservedByGroupId !== group.id) {
        return sendJson(res, 400, { error: 'هذا الموضوع تم حجزه مسبقاً من قبل مجموعة أخرى' });
      }

      // Slot validation
      const slot = (appData.presentationSlots || []).find(s => s.id === slotId);
      if (!slot) return sendJson(res, 404, { error: 'موعد العرض غير موجود' });

      if (slot.reservedByGroupId && slot.reservedByGroupId !== group.id) {
        return sendJson(res, 400, { error: 'هذا الموعد محجوز لمجموعة أخرى' });
      }

      // Free previous reservations
      activity.topics.forEach(t => { if (t.reservedByGroupId === group.id) t.reservedByGroupId = null; });
      (appData.presentationSlots || []).forEach(s => { if (s.reservedByGroupId === group.id) s.reservedByGroupId = null; });

      // Set new reservations
      topic.reservedByGroupId = group.id;
      slot.reservedByGroupId = group.id;

      group.topicId = topic.id;
      group.topicTitle = topic.title;
      group.presentationSlotId = slot.id;
      group.presentationSlotTitle = slot.title;

      await saveAppData(appData);
      return sendJson(res, 200, { success: true, group });
    }

    // 9. Admin Login
    if (pathname === '/api/admin/login' && method === 'POST') {
      const { username, password } = await parseBody(req);
      const u = String(username || '').trim().toLowerCase();
      const p = String(password || '').trim();

      const validUsernames = ['drhamza', 'admin'];
      const currentAdminPassword = appData.settings?.adminPassword || 'HSam@2027';

      if (!validUsernames.includes(u) || p !== currentAdminPassword) {
        return sendJson(res, 401, { error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      }

      const token = `admin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      return sendJson(res, 200, {
        success: true,
        token,
        adminName: 'د. حمزة محمد القصبي'
      });
    }

    // 10. Admin Change Password
    if (pathname === '/api/admin/change-password' && method === 'POST') {
      const { token, currentPassword, newPassword } = await parseBody(req);
      if (!token || !token.startsWith('admin_')) {
        return sendJson(res, 403, { error: 'غير مصرح' });
      }

      const currentAdminPassword = appData.settings?.adminPassword || 'HSam@2027';
      if (currentPassword !== currentAdminPassword) {
        return sendJson(res, 400, { error: 'كلمة المرور الحالية غير صحيحة' });
      }

      if (!newPassword || newPassword.length < 4) {
        return sendJson(res, 400, { error: 'كلمة المرور الجديدة يجب أن تكون 4 أحرف على الأقل' });
      }

      if (!appData.settings) appData.settings = {};
      appData.settings.adminPassword = newPassword;
      await saveAppData(appData);

      return sendJson(res, 200, { success: true, message: 'تم تغيير كلمة المرور بنجاح' });
    }

    // 11. Admin Data
    if (pathname === '/api/admin/data' && method === 'GET') {
      const token = parsedUrl.query.token;
      if (!token || !token.startsWith('admin_')) {
        return sendJson(res, 403, { error: 'غير مصرح' });
      }

      return sendJson(res, 200, {
        settings: appData.settings,
        activities: appData.activities || [],
        presentationSlots: appData.presentationSlots || [],
        groups: appData.groups || [],
        studentPhones: appData.studentPhones || {},
        studentJobs: appData.studentJobs || {}
      });
    }

    // 12. Admin Group Approvals
    if (pathname === '/api/admin/approve-group' && method === 'POST') {
      const { token, groupId } = await parseBody(req);
      if (!token || !token.startsWith('admin_')) return sendJson(res, 403, { error: 'غير مصرح' });

      const group = (appData.groups || []).find(g => g.id === groupId);
      if (!group) return sendJson(res, 404, { error: 'المجموعة غير موجودة' });

      group.isApprovedByTeacher = true;
      await saveAppData(appData);
      return sendJson(res, 200, { success: true, group });
    }

    if (pathname === '/api/admin/approve-all-groups' && method === 'POST') {
      const { token, courseId } = await parseBody(req);
      if (!token || !token.startsWith('admin_')) return sendJson(res, 403, { error: 'غير مصرح' });

      (appData.groups || []).forEach(g => {
        if (!courseId || g.courseId === courseId) g.isApprovedByTeacher = true;
      });

      await saveAppData(appData);
      return sendJson(res, 200, { success: true, message: 'تم اعتماد جميع المجموعات بنجاح' });
    }

    // 13. Admin Toggle Course Open/Close
    if (pathname === '/api/admin/toggle-course' && method === 'POST') {
      const { token, courseId, isOpen } = await parseBody(req);
      if (!token || !token.startsWith('admin_')) return sendJson(res, 403, { error: 'غير مصرح' });

      if (!appData.settings) appData.settings = {};
      if (!appData.settings.courses) appData.settings.courses = {};
      if (!appData.settings.courses[courseId]) {
        appData.settings.courses[courseId] = {
          id: courseId,
          name: courseId === 'elearning' ? 'التعليم الإلكتروني' : 'التفكير النقدي',
          isOpen: true
        };
      }
      appData.settings.courses[courseId].isOpen = isOpen;
      await saveAppData(appData);

      return sendJson(res, 200, { success: true, course: appData.settings.courses[courseId] });
    }

    // 14. Admin Update Group Notes
    if (pathname === '/api/admin/update-group-notes' && method === 'POST') {
      const { token, groupId, notes } = await parseBody(req);
      if (!token || !token.startsWith('admin_')) return sendJson(res, 403, { error: 'غير مصرح' });

      const group = (appData.groups || []).find(g => g.id === groupId);
      if (!group) return sendJson(res, 404, { error: 'المجموعة غير موجودة' });

      group.teacherNotes = notes;
      await saveAppData(appData);
      return sendJson(res, 200, { success: true, group });
    }

    // 15. Admin Delete Group
    if (pathname === '/api/admin/delete-group' && method === 'POST') {
      const { token, groupId } = await parseBody(req);
      if (!token || !token.startsWith('admin_')) return sendJson(res, 403, { error: 'غير مصرح' });

      const idx = (appData.groups || []).findIndex(g => g.id === groupId);
      if (idx === -1) return sendJson(res, 404, { error: 'المجموعة غير موجودة' });

      const group = appData.groups[idx];
      (appData.activities || []).forEach(a => {
        a.topics.forEach(t => { if (t.reservedByGroupId === group.id) t.reservedByGroupId = null; });
      });
      (appData.presentationSlots || []).forEach(s => {
        if (s.reservedByGroupId === group.id) s.reservedByGroupId = null;
      });

      appData.groups.splice(idx, 1);
      await saveAppData(appData);
      return sendJson(res, 200, { success: true, message: 'تم حذف المجموعة' });
    }

    // 16. Admin Import Excel Data
    if (pathname === '/api/admin/import-excel-data' && method === 'POST') {
      const { token, courseId, topics, slots } = await parseBody(req);
      if (!token || !token.startsWith('admin_')) return sendJson(res, 403, { error: 'غير مصرح' });

      const act = (appData.activities || []).find(a => a.courseId === courseId);
      if (act && Array.isArray(topics) && topics.length > 0) {
        topics.forEach((t, i) => {
          act.topics.push({
            id: `top_${courseId}_imported_${Date.now()}_${i}`,
            title: t.title,
            description: t.description || '',
            reservedByGroupId: null
          });
        });
      }

      if (Array.isArray(slots) && slots.length > 0) {
        if (!appData.presentationSlots) appData.presentationSlots = [];
        slots.forEach((s, i) => {
          appData.presentationSlots.push({
            id: `slot_${courseId}_imported_${Date.now()}_${i}`,
            courseId,
            title: s.title,
            date: s.date || '',
            time: s.time || '',
            hall: s.hall || '',
            reservedByGroupId: null
          });
        });
      }

      await saveAppData(appData);
      return sendJson(res, 200, { success: true, message: 'تم استيراد البيانات بنجاح' });
    }

    // 17. Admin Export CSV
    if (pathname === '/api/admin/export-csv' && method === 'GET') {
      const courseId = parsedUrl.query.courseId || 'elearning';

      let csv = '\uFEFF';
      csv += 'رقم المجموعة,حالة الاعتماد,الموضوع المسند,موعد العرض في المحاضرة,اسم القائد,رقم الطالب,اسم الطالب,الوظيفة (لأستاذ المقرر فقط),الصفة,الحالة,رقم الواتساب (لأستاذ المقرر فقط),الشعبة,المسار / الدبلوم,توجيهات أستاذ المقرر\n';

      const cGroups = (appData.groups || []).filter(g => g.courseId === courseId);
      for (const g of cGroups) {
        for (const m of g.members) {
          const s = studentsById.get(m.studentId);
          const phone = (appData.studentPhones || {})[m.studentId] || 'غير مسجل';
          const job = (appData.studentJobs || {})[m.studentId] || 'غير مسجل';
          const track = s ? `"${(s.track || '').replace(/"/g, '""')}"` : '""';
          const notes = `"${(g.teacherNotes || '').replace(/"/g, '""')}"`;
          const topic = `"${(g.topicTitle || '').replace(/"/g, '""')}"`;
          const slot = `"${(g.presentationSlotTitle || '').replace(/"/g, '""')}"`;
          const role = m.role === 'leader' ? 'قائد المجموعة' : 'عضو';
          const status = m.status === 'confirmed' ? 'مؤكد' : 'في انتظار الموافقة';
          const approval = g.isApprovedByTeacher ? 'معتمدة نهائياً' : 'قيد المراجعة';

          csv += `${g.groupNumber},"${approval}",${topic},${slot},"${g.leaderName}",${m.studentId},"${m.name}","${job}",${role},${status},"${phone}","${m.section}",${track},${notes}\n`;
        }
      }

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename=groups_${courseId}_${Date.now()}.csv`
      });
      res.end(csv);
      return;
    }

    // 404 for unknown API
    sendJson(res, 404, { error: 'المسار البرمجي غير موجود', requestedPath: pathname });
  } catch (err) {
    console.error('API Error:', err);
    sendJson(res, 500, { error: 'حدث خطأ في معالجة الطلب' });
  }
}

module.exports = { handleApi, extractPathname };
