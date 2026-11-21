const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const STUDENTS_FILE = path.join(DATA_DIR, 'students.json');
const APP_DATA_FILE = path.join(DATA_DIR, 'app_data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Helper Functions for Data Persistence ---
function loadJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error loading ${filePath}:`, err);
    return fallback;
  }
}

function saveAppData(data) {
  try {
    fs.writeFileSync(APP_DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving app data:', err);
  }
}

// Load static student records
const rawStudents = loadJson(STUDENTS_FILE, []);
console.log(`Loaded ${rawStudents.length} student records from students.json`);

// In-memory data store with file sync
let appData = loadJson(APP_DATA_FILE, {
  settings: {
    adminPassword: 'admin',
    courses: {
      elearning: { id: 'elearning', name: 'التعليم الإلكتروني', isOpen: true },
      critical_thinking: { id: 'critical_thinking', name: 'التفكير النقدي', isOpen: true }
    },
    maxGroupSize: 10,
    allowMixedSections: true
  },
  studentPhones: {},
  activities: [],
  presentationSlots: [],
  groups: []
});

// Normalize course identifiers
function normalizeCourseId(courseNameOrCode) {
  if (!courseNameOrCode) return null;
  const s = String(courseNameOrCode).trim();
  if (s.includes('إلكترون') || s.includes('الكترون') || s.includes('EDTC') || s.includes('ت.ت')) {
    return 'elearning';
  }
  if (s.includes('تفكير') || s.includes('UCRT')) {
    return 'critical_thinking';
  }
  return null;
}

// Prepare index of students for rapid lookups
const studentsById = new Map();
for (const s of rawStudents) {
  const cId = normalizeCourseId(s.courseName);
  if (!studentsById.has(s.studentId)) {
    studentsById.set(s.studentId, {
      studentId: s.studentId,
      name: s.name,
      courses: []
    });
  }
  const rec = studentsById.get(s.studentId);
  rec.courses.push({
    courseId: cId || 'other',
    courseName: s.courseName,
    courseCode: s.courseCode,
    section: s.section || 'عام',
    day: s.day,
    time: s.time,
    hall: s.hall,
    track: s.track,
    dept: s.dept
  });
}

// Helper: send JSON response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

// Helper: parse POST JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Request entity too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Helper: sync topic & presentation slots reservations
function syncReservations() {
  // Clear all reservations first
  for (const act of (appData.activities || [])) {
    for (const top of act.topics) {
      top.reservedByGroupId = null;
    }
  }
  for (const slot of (appData.presentationSlots || [])) {
    slot.reservedByGroupId = null;
  }

  // Re-apply reservations based on existing groups
  for (const grp of appData.groups) {
    if (grp.topicId) {
      for (const act of (appData.activities || [])) {
        const top = act.topics.find(t => t.id === grp.topicId);
        if (top) top.reservedByGroupId = grp.id;
      }
    }
    if (grp.presentationSlotId) {
      const slot = (appData.presentationSlots || []).find(s => s.id === grp.presentationSlotId);
      if (slot) slot.reservedByGroupId = grp.id;
    }
  }
}
syncReservations();

// MIME Types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Create Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  try {
    // 1. Health check
    if (pathname === '/api/health') {
      return sendJson(res, 200, { status: 'ok', studentsCount: studentsById.size });
    }

    // 2. Student Login
    if (pathname === '/api/student/login' && method === 'POST') {
      const body = await parseBody(req);
      const studentId = String(body.studentId || '').trim();

      if (!studentId) {
        return sendJson(res, 400, { error: 'يرجى إدخال رقم الطالب' });
      }

      const student = studentsById.get(studentId);
      if (!student) {
        return sendJson(res, 404, { error: 'رقم الطالب غير موجود في كشوف الطلاب المسجلين' });
      }

      const coursesWithStatus = student.courses.map(c => {
        const setting = appData.settings.courses[c.courseId] || { isOpen: true, name: c.courseName };
        return {
          ...c,
          isOpen: setting.isOpen,
          normalizedCourseId: c.courseId
        };
      });

      const phone = appData.studentPhones[studentId] || '';

      return sendJson(res, 200, {
        success: true,
        student: {
          studentId: student.studentId,
          name: student.name,
          phone: phone,
          courses: coursesWithStatus
        }
      });
    }

    // 3. Update Student WhatsApp Phone
    if (pathname === '/api/student/update-phone' && method === 'POST') {
      const body = await parseBody(req);
      const studentId = String(body.studentId || '').trim();
      const phone = String(body.phone || '').trim();

      if (!studentId || !studentsById.has(studentId)) {
        return sendJson(res, 404, { error: 'طالب غير صالح' });
      }

      if (!phone || phone.length < 10) {
        return sendJson(res, 400, { error: 'يرجى إدخال رقم محمول صحيح لا يقل عن 10 أرقام' });
      }

      appData.studentPhones[studentId] = phone;
      saveAppData(appData);

      return sendJson(res, 200, { success: true, phone });
    }

    // 4. Get Course Workspace & Group Data
    if (pathname === '/api/course-data' && method === 'GET') {
      const courseId = parsedUrl.query.courseId;
      const studentId = String(parsedUrl.query.studentId || '').trim();

      if (!courseId) {
        return sendJson(res, 400, { error: 'كود المقرر مطلوب' });
      }

      const courseSetting = appData.settings.courses[courseId] || {
        id: courseId,
        name: courseId === 'elearning' ? 'التعليم الإلكتروني' : 'التفكير النقدي',
        isOpen: true
      };

      const activities = (appData.activities || []).filter(a => a.courseId === courseId);
      const slots = (appData.presentationSlots || []).filter(s => s.courseId === courseId);

      // Find student group
      let myGroup = null;
      for (const grp of appData.groups) {
        if (grp.courseId === courseId) {
          const m = grp.members.find(mem => mem.studentId === studentId);
          if (m) {
            myGroup = {
              ...grp,
              myRole: m.role,
              myStatus: m.status
            };
            break;
          }
        }
      }

      // Map topics
      const mappedActivities = activities.map(act => ({
        ...act,
        topics: act.topics.map(t => ({
          ...t,
          isReserved: !!t.reservedByGroupId && (!myGroup || myGroup.topicId !== t.id),
          isReservedByMe: myGroup && myGroup.topicId === t.id
        }))
      }));

      // Map presentation slots
      const mappedSlots = slots.map(s => ({
        ...s,
        isReserved: !!s.reservedByGroupId && (!myGroup || myGroup.presentationSlotId !== s.id),
        isReservedByMe: myGroup && myGroup.presentationSlotId === s.id
      }));

      // Classmates (without phone numbers for privacy)
      const classmates = [];
      for (const [sId, s] of studentsById.entries()) {
        const regCourse = s.courses.find(c => c.courseId === courseId);
        if (regCourse) {
          let inGroupObj = null;
          for (const g of appData.groups) {
            if (g.courseId === courseId) {
              const mem = g.members.find(m => m.studentId === sId);
              if (mem) {
                inGroupObj = { groupId: g.id, groupNumber: g.groupNumber, status: mem.status };
                break;
              }
            }
          }

          classmates.push({
            studentId: sId,
            name: s.name,
            section: regCourse.section || 'عام',
            track: regCourse.track || '',
            hall: regCourse.hall || '',
            isInGroup: !!inGroupObj,
            groupInfo: inGroupObj,
            isAvailable: !inGroupObj || inGroupObj.status === 'pending'
          });
        }
      }

      return sendJson(res, 200, {
        success: true,
        course: courseSetting,
        maxGroupSize: appData.settings.maxGroupSize || 10,
        activities: mappedActivities,
        presentationSlots: mappedSlots,
        myGroup: myGroup ? {
          ...myGroup,
          members: myGroup.members.map(m => ({
            studentId: m.studentId,
            name: m.name,
            section: m.section,
            role: m.role,
            status: m.status,
            joinedAt: m.joinedAt
          }))
        } : null,
        classmates
      });
    }

    // 5. Create Group (Initial group formation without topic - topic chosen after teacher approval)
    if (pathname === '/api/groups/create' && method === 'POST') {
      const body = await parseBody(req);
      const { courseId, activityId, leaderId, memberIds } = body;

      const courseSetting = appData.settings.courses[courseId];
      if (courseSetting && !courseSetting.isOpen) {
        return sendJson(res, 403, { error: 'عذراً، التسجيل في هذا المقرر مغلق حالياً' });
      }

      if (!leaderId || !studentsById.has(leaderId)) {
        return sendJson(res, 400, { error: 'بيانات قائد المجموعة غير صالحة' });
      }

      const existingGrp = appData.groups.find(g =>
        g.courseId === courseId && g.members.some(m => m.studentId === leaderId)
      );
      if (existingGrp) {
        return sendJson(res, 400, { error: 'أنت منضم بالفعل إلى مجموعة في هذا المقرر. يجب مغادرتها أولاً لتكوين مجموعة جديدة.' });
      }

      const maxGroupSize = appData.settings.maxGroupSize || 10;
      const cleanMemberIds = Array.isArray(memberIds) ? memberIds.filter(id => id && id !== leaderId) : [];

      if (cleanMemberIds.length + 1 > maxGroupSize) {
        return sendJson(res, 400, { error: `المجموعة لا تتعدى ${maxGroupSize} طلاب بأي حال من الأحوال (شامل القائد)` });
      }

      const courseGroups = appData.groups.filter(g => g.courseId === courseId);
      const nextGroupNum = courseGroups.length + 1;

      const leaderData = studentsById.get(leaderId);
      const leaderCourse = leaderData.courses.find(c => c.courseId === courseId);

      const groupId = `grp_${courseId}_${Date.now()}`;
      const newGroup = {
        id: groupId,
        courseId,
        activityId: activityId || (appData.activities[0]?.id),
        topicId: null,
        topicTitle: '',
        presentationSlotId: null,
        presentationSlotTitle: '',
        groupNumber: nextGroupNum,
        leaderId,
        leaderName: leaderData.name,
        createdAt: new Date().toISOString(),
        isApprovedByTeacher: false, // Must be approved by instructor before topic & date selection!
        isLocked: false,
        teacherNotes: '',
        members: [
          {
            studentId: leaderId,
            name: leaderData.name,
            section: leaderCourse ? leaderCourse.section : 'عام',
            role: 'leader',
            status: 'confirmed',
            joinedAt: new Date().toISOString()
          }
        ]
      };

      for (const mId of cleanMemberIds) {
        const memData = studentsById.get(mId);
        if (memData) {
          const memCourse = memData.courses.find(c => c.courseId === courseId);
          newGroup.members.push({
            studentId: mId,
            name: memData.name,
            section: memCourse ? memCourse.section : 'عام',
            role: 'member',
            status: 'pending',
            joinedAt: new Date().toISOString()
          });
        }
      }

      appData.groups.push(newGroup);
      saveAppData(appData);

      return sendJson(res, 201, { success: true, group: newGroup });
    }

    // 6. Respond to Group Invitation (Accept or Decline)
    if (pathname === '/api/groups/respond-invitation' && method === 'POST') {
      const body = await parseBody(req);
      const { groupId, studentId, action } = body;

      const group = appData.groups.find(g => g.id === groupId);
      if (!group) return sendJson(res, 404, { error: 'المجموعة غير موجودة' });

      const memIndex = group.members.findIndex(m => m.studentId === studentId);
      if (memIndex === -1) return sendJson(res, 404, { error: 'الطالب غير مدرج في هذه المجموعة' });

      if (action === 'accept') {
        group.members[memIndex].status = 'confirmed';
        saveAppData(appData);
        return sendJson(res, 200, { success: true, message: 'تم تأكيد انضمامك للمجموعة بنجاح' });
      } else if (action === 'decline') {
        group.members.splice(memIndex, 1);
        saveAppData(appData);
        return sendJson(res, 200, { success: true, message: 'تم الاعتذار ومغادرة المجموعة بنجاح' });
      }
      return sendJson(res, 400, { error: 'إجراء غير صالح' });
    }

    // 7. Leave Group
    if (pathname === '/api/groups/leave' && method === 'POST') {
      const body = await parseBody(req);
      const { groupId, studentId } = body;

      const grpIndex = appData.groups.findIndex(g => g.id === groupId);
      if (grpIndex === -1) return sendJson(res, 404, { error: 'المجموعة غير موجودة' });
      const group = appData.groups[grpIndex];

      if (group.isLocked) {
        return sendJson(res, 403, { error: 'تم قفل المجموعة بواسطة أستاذ المقرر، لا يمكن المغادرة' });
      }

      const isLeader = group.leaderId === studentId;
      group.members = group.members.filter(m => m.studentId !== studentId);

      if (isLeader) {
        if (group.members.length === 0) {
          appData.groups.splice(grpIndex, 1);
        } else {
          const nextLeader = group.members.find(m => m.status === 'confirmed') || group.members[0];
          nextLeader.role = 'leader';
          nextLeader.status = 'confirmed';
          group.leaderId = nextLeader.studentId;
          group.leaderName = nextLeader.name;
        }
      }

      syncReservations();
      saveAppData(appData);
      return sendJson(res, 200, { success: true, message: 'تمت المغادرة بنجاح' });
    }

    // 8. Select Topic and Presentation Slot (By ANY confirmed group member after teacher approval)
    if (pathname === '/api/groups/select-topic-and-slot' && method === 'POST') {
      const body = await parseBody(req);
      const { groupId, studentId, topicId, presentationSlotId } = body;

      const group = appData.groups.find(g => g.id === groupId);
      if (!group) return sendJson(res, 404, { error: 'المجموعة غير موجودة' });

      // Verification: Has the teacher approved the group formation?
      if (!group.isApprovedByTeacher) {
        return sendJson(res, 403, {
          error: 'عذراً، يجب موافقة واعتماد أستاذ المقرر على تشكيل المجموعة أولاً قبل اختيار الموضوع وموعد العرض.'
        });
      }

      // Verification: Is this student a confirmed member of the group?
      const member = group.members.find(m => m.studentId === studentId && m.status === 'confirmed');
      if (!member) {
        return sendJson(res, 403, { error: 'الاختيار متاح لأي عضو مؤكد في المجموعة فقط.' });
      }

      if (group.isLocked) {
        return sendJson(res, 403, { error: 'المجموعة مقفلة ولا يمكن تعديل الاختيارات.' });
      }

      // 1. Topic validation
      let topicTitle = group.topicTitle || '';
      if (topicId) {
        const act = (appData.activities || []).find(a => a.id === group.activityId);
        const top = act ? act.topics.find(t => t.id === topicId) : null;
        if (!top) return sendJson(res, 404, { error: 'الموضوع غير موجود' });

        if (top.reservedByGroupId && top.reservedByGroupId !== group.id) {
          return sendJson(res, 400, { error: 'عذراً، هذا الموضوع محجوز بالفعل لمجموعة أخرى.' });
        }
        topicTitle = top.title;
        group.topicId = topicId;
        group.topicTitle = topicTitle;
      }

      // 2. Presentation Slot validation
      let slotTitle = group.presentationSlotTitle || '';
      if (presentationSlotId) {
        const slot = (appData.presentationSlots || []).find(s => s.id === presentationSlotId && s.courseId === group.courseId);
        if (!slot) return sendJson(res, 404, { error: 'موعد العرض غير موجود' });

        if (slot.reservedByGroupId && slot.reservedByGroupId !== group.id) {
          return sendJson(res, 400, { error: 'عذراً، موعد العرض هذا محجوز بالفعل لمجموعة أخرى.' });
        }
        slotTitle = slot.title;
        group.presentationSlotId = presentationSlotId;
        group.presentationSlotTitle = slotTitle;
      }

      syncReservations();
      saveAppData(appData);

      return sendJson(res, 200, {
        success: true,
        message: 'تم حفظ اختيار الموضوع وموعد العرض للمجموعة بنجاح',
        topicTitle,
        presentationSlotTitle: slotTitle
      });
    }

    // --- Teacher / Admin Endpoints ---

    // Change Admin Password
    if (pathname === '/api/admin/change-password' && method === 'POST') {
      const body = await parseBody(req);
      const { newPassword } = body;
      if (!newPassword || String(newPassword).trim().length < 3) {
        return sendJson(res, 400, { error: 'يرجى إدخال كلمة مرور جديدة لا تقل عن 3 أحرف' });
      }
      appData.settings.adminPassword = String(newPassword).trim();
      saveAppData(appData);
      return sendJson(res, 200, { success: true, message: 'تم تحديث كلمة المرور بنجاح' });
    }

    // Import Excel Topics and Slots
    if (pathname === '/api/admin/import-excel-data' && method === 'POST') {
      const body = await parseBody(req);
      const { courseId, topics, slots } = body;
      
      const act = (appData.activities || []).find(a => a.courseId === courseId);
      let addedTopics = 0;
      let addedSlots = 0;

      if (act && Array.isArray(topics) && topics.length > 0) {
        for (const t of topics) {
          if (t.title && String(t.title).trim()) {
            act.topics.push({
              id: 'top_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
              title: String(t.title).trim(),
              description: String(t.description || '').trim(),
              reservedByGroupId: null
            });
            addedTopics++;
          }
        }
      }

      if (Array.isArray(slots) && slots.length > 0) {
        if (!appData.presentationSlots) appData.presentationSlots = [];
        for (const s of slots) {
          if (s.title && String(s.title).trim()) {
            appData.presentationSlots.push({
              id: 'slot_' + courseId + '_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
              courseId,
              title: String(s.title).trim(),
              reservedByGroupId: null
            });
            addedSlots++;
          }
        }
      }

      saveAppData(appData);
      return sendJson(res, 200, {
        success: true,
        message: `تم استيراد ${addedTopics} موضوعاً و ${addedSlots} موعد عرض بنجاح`,
        topicsCount: addedTopics,
        slotsCount: addedSlots
      });
    }

    // 9. Admin Login
    if (pathname === '/api/admin/login' && method === 'POST') {
      const body = await parseBody(req);
      const password = String(body.password || '').trim();

      const correctPassword = appData.settings.adminPassword || 'admin';
      if (password === correctPassword) {
        return sendJson(res, 200, {
          success: true,
          token: 'teacher_session_auth_key_verified',
          teacherName: 'أستاذ المقرر'
        });
      } else {
        return sendJson(res, 401, { error: 'كلمة المرور غير صحيحة' });
      }
    }

    // 10. Admin Full Data
    if (pathname === '/api/admin/data' && method === 'GET') {
      const courseId = parsedUrl.query.courseId || 'elearning';

      const groupsWithPhones = appData.groups
        .filter(g => g.courseId === courseId)
        .map(g => ({
          ...g,
          members: g.members.map(m => ({
            ...m,
            phone: appData.studentPhones[m.studentId] || 'غير مسجل'
          }))
        }));

      const allStudentsInCourse = [];
      let assignedCount = 0;
      let unassignedCount = 0;

      for (const [sId, s] of studentsById.entries()) {
        const c = s.courses.find(cr => cr.courseId === courseId);
        if (c) {
          const inGroup = appData.groups.find(g =>
            g.courseId === courseId && g.members.some(m => m.studentId === sId)
          );
          if (inGroup) {
            assignedCount++;
          } else {
            unassignedCount++;
          }
          allStudentsInCourse.push({
            studentId: sId,
            name: s.name,
            section: c.section || 'عام',
            track: c.track || '',
            phone: appData.studentPhones[sId] || 'غير مسجل',
            group: inGroup ? { id: inGroup.id, groupNumber: inGroup.groupNumber, isLeader: inGroup.leaderId === sId } : null
          });
        }
      }

      return sendJson(res, 200, {
        success: true,
        settings: appData.settings,
        stats: {
          totalStudents: allStudentsInCourse.length,
          groupsCount: groupsWithPhones.length,
          assignedCount,
          unassignedCount,
          approvedGroupsCount: groupsWithPhones.filter(g => g.isApprovedByTeacher).length,
          fullGroupsCount: groupsWithPhones.filter(g => g.members.length >= (appData.settings.maxGroupSize || 10)).length
        },
        groups: groupsWithPhones,
        activities: (appData.activities || []).filter(a => a.courseId === courseId),
        presentationSlots: (appData.presentationSlots || []).filter(s => s.courseId === courseId),
        students: allStudentsInCourse
      });
    }

    // 11. Admin Approve / Finalize Group Formation
    if (pathname === '/api/admin/approve-group' && method === 'POST') {
      const body = await parseBody(req);
      const { groupId, isApproved } = body;

      const group = appData.groups.find(g => g.id === groupId);
      if (!group) return sendJson(res, 404, { error: 'المجموعة غير موجودة' });

      group.isApprovedByTeacher = !!isApproved;
      saveAppData(appData);

      return sendJson(res, 200, {
        success: true,
        isApprovedByTeacher: group.isApprovedByTeacher,
        message: isApproved
          ? 'تم اعتماد تشكيل المجموعة وتفعيل اختيار الموضوع وموعد العرض لأعضائها'
          : 'تم إلغاء اعتماد المجموعة'
      });
    }

    // 12. Admin Approve All Groups at Once
    if (pathname === '/api/admin/approve-all-groups' && method === 'POST') {
      const body = await parseBody(req);
      const { courseId, isApproved } = body;

      const cGroups = appData.groups.filter(g => g.courseId === courseId);
      for (const g of cGroups) {
        g.isApprovedByTeacher = !!isApproved;
      }
      saveAppData(appData);

      return sendJson(res, 200, {
        success: true,
        count: cGroups.length,
        message: `تم ${isApproved ? 'اعتماد' : 'إلغاء اعتماد'} جميع المجموعات المشكلة بالمقرر (${cGroups.length} مجموعة)`
      });
    }

    // 13. Admin Toggle Course Availability
    if (pathname === '/api/admin/toggle-course' && method === 'POST') {
      const body = await parseBody(req);
      const { courseId, isOpen } = body;

      if (!courseId || !appData.settings.courses[courseId]) {
        return sendJson(res, 400, { error: 'مقرر غير صالح' });
      }

      appData.settings.courses[courseId].isOpen = !!isOpen;
      saveAppData(appData);

      return sendJson(res, 200, {
        success: true,
        courseId,
        isOpen: appData.settings.courses[courseId].isOpen,
        message: `تم ${isOpen ? 'إتاحة' : 'إغلاق'} المقرر بنجاح`
      });
    }

    // 14. Admin Update Group Instructions / Topic Notes
    if (pathname === '/api/admin/update-group-notes' && method === 'POST') {
      const body = await parseBody(req);
      const { groupId, teacherNotes } = body;

      const group = appData.groups.find(g => g.id === groupId);
      if (!group) return sendJson(res, 404, { error: 'المجموعة غير موجودة' });

      group.teacherNotes = teacherNotes || '';
      saveAppData(appData);

      return sendJson(res, 200, { success: true, message: 'تم حفظ توجيهات وتكليف أستاذ المقرر بنجاح' });
    }

    // 15. Admin Lock / Unlock Group
    if (pathname === '/api/admin/update-group-lock' && method === 'POST') {
      const body = await parseBody(req);
      const { groupId, isLocked } = body;

      const group = appData.groups.find(g => g.id === groupId);
      if (!group) return sendJson(res, 404, { error: 'المجموعة غير موجودة' });

      group.isLocked = !!isLocked;
      saveAppData(appData);

      return sendJson(res, 200, { success: true, isLocked: group.isLocked });
    }

    // 16. Admin Delete Group
    if (pathname === '/api/admin/delete-group' && method === 'POST') {
      const body = await parseBody(req);
      const { groupId } = body;

      const idx = appData.groups.findIndex(g => g.id === groupId);
      if (idx === -1) return sendJson(res, 404, { error: 'المجموعة غير موجودة' });

      appData.groups.splice(idx, 1);
      syncReservations();
      saveAppData(appData);

      return sendJson(res, 200, { success: true, message: 'تم حذف المجموعة بنجاح' });
    }

    // 17. Admin Topics Management
    if (pathname === '/api/admin/topics' && method === 'POST') {
      const body = await parseBody(req);
      const { action, courseId, activityId, topic } = body;

      const act = (appData.activities || []).find(a => a.id === activityId);
      if (!act) return sendJson(res, 404, { error: 'النشاط غير موجود' });

      if (action === 'add') {
        const newTopic = {
          id: `top_${Date.now()}`,
          title: topic.title,
          description: topic.description || '',
          reservedByGroupId: null
        };
        act.topics.push(newTopic);
        saveAppData(appData);
        return sendJson(res, 201, { success: true, topic: newTopic });
      }
    }

    // 18. Admin Export CSV
    if (pathname === '/api/admin/export-csv' && method === 'GET') {
      const courseId = parsedUrl.query.courseId || 'elearning';

      let csv = '\uFEFF';
      csv += 'رقم المجموعة,حالة الاعتماد,الموضوع المسند,موعد العرض في المحاضرة,اسم القائد,رقم الطالب,اسم الطالب,الصفة,الحالة,رقم الواتساب (لأستاذ المقرر فقط),الشعبة,المسار / الدبلوم,توجيهات أستاذ المقرر\n';

      const cGroups = appData.groups.filter(g => g.courseId === courseId);
      for (const g of cGroups) {
        for (const m of g.members) {
          const s = studentsById.get(m.studentId);
          const c = s ? s.courses.find(cr => cr.courseId === courseId) : null;
          const phone = appData.studentPhones[m.studentId] || 'غير مسجل';
          const track = c ? `"${(c.track || '').replace(/"/g, '""')}"` : '""';
          const notes = `"${(g.teacherNotes || '').replace(/"/g, '""')}"`;
          const topic = `"${(g.topicTitle || '').replace(/"/g, '""')}"`;
          const slot = `"${(g.presentationSlotTitle || '').replace(/"/g, '""')}"`;
          const role = m.role === 'leader' ? 'قائد المجموعة' : 'عضو';
          const status = m.status === 'confirmed' ? 'مؤكد' : 'في انتظار الموافقة';
          const approval = g.isApprovedByTeacher ? 'معتمدة نهائياً' : 'قيد المراجعة';

          csv += `${g.groupNumber},"${approval}",${topic},${slot},"${g.leaderName}",${m.studentId},"${m.name}",${role},${status},"${phone}","${m.section}",${track},${notes}\n`;
        }
      }

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename=groups_${courseId}_${Date.now()}.csv`
      });
      res.end(csv);
      return;
    }

    // --- Serve Static Frontend Files ---
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    const ext = path.extname(filePath).toLowerCase();

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const fallbackIndex = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(fallbackIndex)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(fallbackIndex).pipe(res);
      return;
    }

    sendJson(res, 404, { error: 'الصفحة غير موجودة' });
  } catch (err) {
    console.error('Unhandled server error:', err);
    sendJson(res, 500, { error: 'حدث خطأ في الخادم' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 خادم منصة مجموعات الطلاب يعمل بنجاح على http://localhost:${PORT}`);
});
