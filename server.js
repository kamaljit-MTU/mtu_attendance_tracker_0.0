const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
if (!fs.existsSync('./uploads/selfies')) fs.mkdirSync('./uploads/selfies');
if (!fs.existsSync('./uploads/temp')) fs.mkdirSync('./uploads/temp');

const DB_FILE = './database.json';

function convertScheduleToSlots(schedule) {
  if (schedule.slots) return schedule;
  if (schedule.days && schedule.startTime && schedule.endTime) {
    const slots = schedule.days.map(day => ({
      day,
      startTime: schedule.startTime,
      endTime: schedule.endTime
    }));
    return { slots };
  }
  return schedule;
}

function normaliseDateString(dateStr) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(d.getTime() + istOffset);
  return istDate.toISOString().split('T')[0];
}

function ensureDatabaseFields(db) {
  if (!db.timeEntries) db.timeEntries = [];
  if (!db.locations) db.locations = ['Office', 'Home', 'Client Site', 'Remote'];
  if (!db.activities) db.activities = ['Development', 'Meeting', 'Design', 'Testing', 'Documentation'];
  if (!db.projects) db.projects = ['Project Alpha', 'Project Beta', 'Internal', 'Client Work'];
  if (!db.nextId) db.nextId = { users: 1, classes: 1, attendance: 1, timeEntries: 1 };
  if (!db.nextId.timeEntries) db.nextId.timeEntries = 1;
  
  for (const cls of db.classes) {
    if (cls.schedule && !cls.schedule.slots) {
      cls.schedule = convertScheduleToSlots(cls.schedule);
    }
  }
  
  for (const att of db.attendance) {
    if (att.date) {
      const normalised = normaliseDateString(att.date);
      if (att.date !== normalised) att.date = normalised;
    }
  }
  
  return db;
}

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      users: [],
      classes: [],
      attendance: [],
      timeEntries: [],
      locations: ['Office', 'Home', 'Client Site', 'Remote'],
      activities: ['Development', 'Meeting', 'Design', 'Testing', 'Documentation'],
      projects: ['Project Alpha', 'Project Beta', 'Internal', 'Client Work'],
      nextId: { users: 1, classes: 1, attendance: 1, timeEntries: 1 }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return ensureDatabaseFields(data);
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const JWT_SECRET = 'mysecretkey123';

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2 - lat1) * Math.PI/180;
  const Δλ = (lon2 - lon1) * Math.PI/180;
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function getISTDate() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  return istDate.toISOString().split('T')[0];
}

function getDayNameFromDateString(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, month-1, day));
  const dayIndex = utcDate.getUTCDay();
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return days[dayIndex];
}

// ---------- Profile Settings API ----------
app.put('/api/profile', auth, async (req, res) => {
  const { name, email, currentPassword, newPassword } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  if (name) user.name = name;
  if (email && email !== user.email) {
    const existing = db.users.find(u => u.email === email);
    if (existing) return res.status(400).json({ error: 'Email already in use' });
    user.email = email;
  }
  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) return res.status(401).json({ error: 'Current password is incorrect' });
    user.password = await bcrypt.hash(newPassword, 10);
  }
  writeDB(db);
  res.json({ 
    message: 'Profile updated successfully',
    user: { id: user.id, name: user.name, email: user.email, role: user.role, studentId: user.studentId }
  });
});

// ---------- Manual Attendance ----------
app.post('/api/manual-attendance', auth, async (req, res) => {
  if (req.user.role !== 'instructor') return res.status(403).json({ error: 'Only instructors' });
  const { classId, date, attendance } = req.body;
  if (!classId || !date || !Array.isArray(attendance)) return res.status(400).json({ error: 'Invalid data' });
  const db = readDB();
  const classData = db.classes.find(c => c.id === parseInt(classId));
  if (!classData) return res.status(404).json({ error: 'Class not found' });
  if (classData.instructor !== req.user.userId) return res.status(403).json({ error: 'Not your class' });
  
  for (const entry of attendance) {
    const existingIndex = db.attendance.findIndex(a => a.student === entry.studentId && a.class === parseInt(classId) && a.date === date);
    const record = {
      id: existingIndex !== -1 ? db.attendance[existingIndex].id : db.nextId.attendance++,
      student: entry.studentId,
      class: parseInt(classId),
      date: date,
      status: entry.status,
      checkInTime: entry.status === 'present' ? new Date().toISOString() : null,
      selfieUrl: null,
      location: null,
    };
    if (existingIndex !== -1) {
      db.attendance[existingIndex] = record;
    } else {
      db.attendance.push(record);
    }
  }
  writeDB(db);
  res.json({ message: 'Manual attendance saved' });
});

app.get('/api/class-students/:classId', auth, async (req, res) => {
  const { classId } = req.params;
  const db = readDB();
  const classData = db.classes.find(c => c.id === parseInt(classId));
  if (!classData) return res.status(404).json({ error: 'Class not found' });
  if (req.user.role === 'instructor' && classData.instructor !== req.user.userId) return res.status(403).json({ error: 'Not your class' });
  if (req.user.role === 'student' && !classData.students.includes(req.user.userId)) return res.status(403).json({ error: 'Not enrolled' });
  const students = db.users.filter(u => classData.students.includes(u.id)).map(s => ({ id: s.id, name: s.name, studentId: s.studentId }));
  res.json(students);
});

app.get('/api/attendance-status/:classId/:date', auth, async (req, res) => {
  if (req.user.role !== 'instructor') return res.status(403).json({ error: 'Only instructors' });
  const { classId, date } = req.params;
  const db = readDB();
  const records = db.attendance.filter(a => a.class === parseInt(classId) && a.date === date);
  res.json(records);
});

// ---------- Existing APIs ----------
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, role, studentId } = req.body;
    if (role !== 'student') return res.status(403).json({ error: 'Only student accounts can be created via registration' });
    if (!studentId) return res.status(400).json({ error: 'Student Registration Number is required' });
    const db = readDB();
    if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'Email exists' });
    if (db.users.find(u => u.studentId === studentId && u.role === 'student')) return res.status(400).json({ error: 'Registration number already used' });
    const hashed = await bcrypt.hash(password, 10);
    const newUser = {
      id: db.nextId.users++,
      name,
      email,
      password: hashed,
      role: 'student',
      studentId: studentId,
    };
    db.users.push(newUser);
    writeDB(db);
    res.json({ message: 'Student account created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function ensureInstructorAccount() {
  const db = readDB();
  const instructorExists = db.users.some(u => u.role === 'instructor');
  if (!instructorExists) {
    const hashed = bcrypt.hashSync('admin123', 10);
    db.users.push({
      id: db.nextId.users++,
      name: 'Instructor',
      email: 'instructor@mtu.ac.in',
      password: hashed,
      role: 'instructor',
      studentId: null,
    });
    writeDB(db);
    console.log('✅ Default instructor account created: instructor@mtu.ac.in / admin123');
  }
}
ensureInstructorAccount();

app.post('/api/create-student', auth, async (req, res) => {
  if (req.user.role !== 'instructor') return res.status(403).json({ error: 'Only instructors' });
  const { name, studentId, email } = req.body;
  const db = readDB();
  if (!name || !studentId) return res.status(400).json({ error: 'Name and Registration Number required' });
  let existing = db.users.find(u => u.studentId === studentId && u.role === 'student');
  if (!existing && email) existing = db.users.find(u => u.email === email);
  if (existing) {
    return res.json({ user: existing, message: 'Student already exists' });
  }
  const randomPassword = Math.random().toString(36).slice(-8);
  const hashed = await bcrypt.hash(randomPassword, 10);
  const newUser = {
    id: db.nextId.users++,
    name,
    email: email || `${studentId}@temp.com`,
    password: hashed,
    role: 'student',
    studentId: studentId,
  };
  db.users.push(newUser);
  writeDB(db);
  res.json({ user: newUser, password: randomPassword, message: 'Student created' });
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(400).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: 'Wrong password' });
    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, studentId: user.studentId } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/classes', auth, async (req, res) => {
  if (req.user.role !== 'instructor') return res.status(403).json({ error: 'Only instructors' });
  const { className, courseCode, scheduleSlots, locationName, geofence } = req.body;
  if (!className || !courseCode || !scheduleSlots || scheduleSlots.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const db = readDB();
  if (db.classes.find(c => c.courseCode === courseCode)) return res.status(400).json({ error: 'Course code exists' });
  const newClass = {
    id: db.nextId.classes++,
    className,
    courseCode,
    instructor: req.user.userId,
    students: [],
    schedule: { slots: scheduleSlots },
    locationName: locationName || 'Not specified',
    geofence: geofence || null,
  };
  db.classes.push(newClass);
  writeDB(db);
  res.json(newClass);
});

app.get('/api/my-classes', auth, async (req, res) => {
  const db = readDB();
  let classes = db.classes.filter(c => 
    req.user.role === 'instructor' ? c.instructor === req.user.userId : c.students.includes(req.user.userId)
  );
  const today = getISTDate();
  classes = classes.map(c => {
    const students = db.users.filter(u => c.students.includes(u.id));
    const todayAttendance = db.attendance.filter(a => a.class === c.id && a.date === today);
    return { ...c, studentCount: students.length, todayAttendanceCount: todayAttendance.length };
  });
  res.json(classes);
});

app.get('/api/all-classes', auth, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Only students' });
  const db = readDB();
  const classes = db.classes.map(c => ({ id: c.id, className: c.className, courseCode: c.courseCode }));
  res.json(classes);
});

app.post('/api/self-enroll', auth, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Only students' });
  const { courseCode } = req.body;
  const db = readDB();
  const classData = db.classes.find(c => c.courseCode === courseCode);
  if (!classData) return res.status(404).json({ error: 'Class not found' });
  if (classData.students.includes(req.user.userId)) return res.status(400).json({ error: 'Already enrolled' });
  classData.students.push(req.user.userId);
  writeDB(db);
  res.json({ message: 'Enrolled successfully' });
});

app.get('/api/students', auth, async (req, res) => {
  if (req.user.role !== 'instructor') return res.status(403).json({ error: 'Only instructors' });
  const db = readDB();
  const students = db.users.filter(u => u.role === 'student').map(s => ({ id: s.id, name: s.name, email: s.email, studentId: s.studentId }));
  res.json(students);
});

app.post('/api/enroll', auth, async (req, res) => {
  if (req.user.role !== 'instructor') return res.status(403).json({ error: 'Only instructors' });
  const { classId, studentId } = req.body;
  const db = readDB();
  const classData = db.classes.find(c => c.id === classId);
  if (!classData) return res.status(404).json({ error: 'Class not found' });
  if (!classData.students.includes(studentId)) {
    classData.students.push(studentId);
    writeDB(db);
  }
  res.json({ message: 'Enrolled' });
});

const uploadFile = multer({ dest: 'uploads/temp/' });
app.post('/api/bulk-enroll', auth, uploadFile.single('file'), async (req, res) => {
  if (req.user.role !== 'instructor') return res.status(403).json({ error: 'Only instructors' });
  const { classId } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  const db = readDB();
  const classData = db.classes.find(c => c.id === parseInt(classId));
  if (!classData) return res.status(404).json({ error: 'Class not found' });

  const results = [];

  const processRow = (row) => {
    const name = row.Name || row.name;
    const studentId = row.RegistrationNumber || row.registrationNumber || row.StudentID;
    const email = row.Email || row.email || null;
    if (!name || !studentId) return;
    let user = db.users.find(u => u.studentId === studentId && u.role === 'student');
    if (!user && email) user = db.users.find(u => u.email === email);
    if (!user) {
      results.push({ name, studentId, email, status: 'new' });
    } else {
      if (!classData.students.includes(user.id)) {
        classData.students.push(user.id);
        results.push({ name, studentId, email, status: 'enrolled_existing' });
      } else {
        results.push({ name, studentId, email, status: 'already_enrolled' });
      }
    }
  };

  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.csv') {
    const rows = [];
    fs.createReadStream(file.path)
      .pipe(csv())
      .on('data', (row) => rows.push(row))
      .on('end', async () => {
        for (const row of rows) processRow(row);
        for (const r of results) {
          if (r.status === 'new') {
            const randomPassword = Math.random().toString(36).slice(-8);
            const hashed = await bcrypt.hash(randomPassword, 10);
            const newUser = {
              id: db.nextId.users++,
              name: r.name,
              email: r.email || `${r.studentId}@temp.com`,
              password: hashed,
              role: 'student',
              studentId: r.studentId,
            };
            db.users.push(newUser);
            if (!classData.students.includes(newUser.id)) {
              classData.students.push(newUser.id);
              r.status = 'created_and_enrolled';
              r.password = randomPassword;
            }
          }
        }
        writeDB(db);
        fs.unlinkSync(file.path);
        res.json({ results });
      });
  } else if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file.path);
    const worksheet = workbook.worksheets[0];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const name = row.getCell(1).value;
      const studentId = row.getCell(2).value?.toString();
      const email = row.getCell(3)?.value?.toString();
      if (name && studentId) processRow({ Name: name, RegistrationNumber: studentId, Email: email });
    });
    for (const r of results) {
      if (r.status === 'new') {
        const randomPassword = Math.random().toString(36).slice(-8);
        const hashed = await bcrypt.hash(randomPassword, 10);
        const newUser = {
          id: db.nextId.users++,
          name: r.name,
          email: r.email || `${r.studentId}@temp.com`,
          password: hashed,
          role: 'student',
          studentId: r.studentId,
        };
        db.users.push(newUser);
        if (!classData.students.includes(newUser.id)) {
          classData.students.push(newUser.id);
          r.status = 'created_and_enrolled';
          r.password = randomPassword;
        }
      }
    }
    writeDB(db);
    fs.unlinkSync(file.path);
    res.json({ results });
  } else {
    fs.unlinkSync(file.path);
    res.status(400).json({ error: 'Unsupported file type' });
  }
});

app.put('/api/classes/:classId/geofence', auth, async (req, res) => {
  if (req.user.role !== 'instructor') return res.status(403).json({ error: 'Only instructors' });
  const { classId } = req.params;
  const { geofence } = req.body;
  const db = readDB();
  const classData = db.classes.find(c => c.id === parseInt(classId));
  if (!classData) return res.status(404).json({ error: 'Class not found' });
  if (classData.instructor !== req.user.userId) return res.status(403).json({ error: 'Not your class' });
  classData.geofence = geofence;
  writeDB(db);
  res.json({ message: geofence ? 'Geofence updated' : 'Geofence removed' });
});

app.put('/api/classes/:classId', auth, async (req, res) => {
  if (req.user.role !== 'instructor') return res.status(403).json({ error: 'Only instructors' });
  const { classId } = req.params;
  const { className, courseCode, scheduleSlots, locationName, geofence } = req.body;
  const db = readDB();
  const classData = db.classes.find(c => c.id === parseInt(classId));
  if (!classData) return res.status(404).json({ error: 'Class not found' });
  if (classData.instructor !== req.user.userId) return res.status(403).json({ error: 'Not your class' });
  
  if (className) classData.className = className;
  if (courseCode) classData.courseCode = courseCode;
  if (scheduleSlots && scheduleSlots.length > 0) classData.schedule.slots = scheduleSlots;
  if (locationName) classData.locationName = locationName;
  if (geofence !== undefined) classData.geofence = geofence;
  
  writeDB(db);
  res.json({ message: 'Class updated', class: classData });
});

const uploadSelfie = multer({ dest: 'uploads/selfies/' });
app.post('/api/attendance', auth, uploadSelfie.single('selfie'), async (req, res) => {
  try {
    const { classId, latitude, longitude } = req.body;
    const db = readDB();
    const classData = db.classes.find(c => c.id === parseInt(classId));
    if (!classData) return res.status(404).json({ error: 'Class not found' });
    const user = db.users.find(u => u.id === req.user.userId);
    if (user.role === 'student' && !classData.students.includes(user.id)) return res.status(403).json({ error: 'Not enrolled' });
    if (user.role === 'instructor' && classData.instructor !== user.id) return res.status(403).json({ error: 'Not your class' });

    const now = new Date();
    const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const istDate = istNow.toISOString().split('T')[0];
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const istDayName = dayNames[istNow.getDay()];
    const slot = classData.schedule.slots.find(s => s.day === istDayName);
    if (user.role === 'student' && !slot)
      return res.status(400).json({ error: `No class on ${istDayName}` });

    let status = 'present';
    if (user.role === 'student') {
      const [startHour, startMin] = slot.startTime.split(':').map(Number);
      const [endHour, endMin] = slot.endTime.split(':').map(Number);
      const startMins = startHour*60+startMin;
      const endMins = endHour*60+endMin;
      const nowMins = istNow.getHours()*60+istNow.getMinutes();
      if (nowMins < startMins) return res.status(400).json({ error: `Class starts at ${slot.startTime} IST` });
      if (nowMins > endMins + 15) return res.status(400).json({ error: `Class ended at ${slot.endTime} IST` });
      if (nowMins > endMins) status = 'late';
    }

    if (classData.geofence) {
      if (!latitude || !longitude) return res.status(400).json({ error: 'Location required' });
      const dist = haversineDistance(parseFloat(latitude), parseFloat(longitude), classData.geofence.latitude, classData.geofence.longitude);
      if (dist > classData.geofence.radius) return res.status(400).json({ error: `Outside geofence (${Math.round(dist)}m > ${classData.geofence.radius}m)` });
    }

    if (user.role === 'student' && !req.file) return res.status(400).json({ error: 'Selfie required' });

    const already = db.attendance.find(a => a.student === user.id && a.class === classData.id && a.date === istDate);
    if (already) return res.status(400).json({ error: 'Already marked today' });

    const record = {
      id: db.nextId.attendance++,
      student: user.id,
      class: classData.id,
      date: istDate,
      status,
      checkInTime: new Date().toISOString(),
      selfieUrl: req.file ? `/uploads/selfies/${req.file.filename}` : null,
      location: latitude && longitude ? { lat: parseFloat(latitude), lng: parseFloat(longitude) } : null,
    };
    db.attendance.push(record);
    writeDB(db);
    res.json({ message: `Attendance marked (${status})` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Calendar with overall percentage ----------
app.get('/api/calendar/:classId/:year/:month', auth, async (req, res) => {
  const { classId, year, month } = req.params;
  const db = readDB();
  const classData = db.classes.find(c => c.id === parseInt(classId));
  if (!classData) return res.status(404).json({ error: 'Class not found' });
  
  const startDate = new Date(year, month-1, 1);
  const endDate = new Date(year, month, 0);
  const students = db.users.filter(u => classData.students.includes(u.id));
  const allAttendance = db.attendance.filter(a => a.class === classData.id);
  
  const presentLateRecords = allAttendance.filter(a => a.status === 'present' || a.status === 'late');
  let globalMinDate = null;
  let globalMaxDate = null;
  for (const rec of presentLateRecords) {
    const d = new Date(rec.date);
    if (!globalMinDate || d < globalMinDate) globalMinDate = d;
    if (!globalMaxDate || d > globalMaxDate) globalMaxDate = d;
  }
  if (!globalMinDate || !globalMaxDate) {
    for (const rec of allAttendance) {
      const d = new Date(rec.date);
      if (!globalMinDate || d < globalMinDate) globalMinDate = d;
      if (!globalMaxDate || d > globalMaxDate) globalMaxDate = d;
    }
  }
  if (!globalMinDate) globalMinDate = startDate;
  if (!globalMaxDate) globalMaxDate = endDate;
  
  const minDateStr = globalMinDate.toISOString().split('T')[0];
  const maxDateStr = globalMaxDate.toISOString().split('T')[0];
  
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  let totalClassDays = 0;
  const current = new Date(globalMinDate);
  while (current <= globalMaxDate) {
    const dateStr = current.toISOString().split('T')[0];
    const dayName = getDayNameFromDateString(dateStr);
    const slot = classData.schedule.slots.find(s => s.day === dayName);
    if (slot) totalClassDays++;
    current.setDate(current.getDate() + 1);
  }
  
  const studentOverallCounts = {};
  for (const student of students) {
    let count = 0;
    for (const rec of allAttendance) {
      if (rec.student === student.id && (rec.status === 'present' || rec.status === 'late')) {
        const recDate = new Date(rec.date);
        if (recDate >= globalMinDate && recDate <= globalMaxDate) {
          count++;
        }
      }
    }
    studentOverallCounts[student.id] = count;
  }
  
  const monthDatesSet = new Set();
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const year = d.getFullYear();
    const monthNum = d.getMonth() + 1;
    const day = d.getDate();
    const dateStr = `${year}-${String(monthNum).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dayName = getDayNameFromDateString(dateStr);
    const slot = classData.schedule.slots.find(s => s.day === dayName);
    if (slot) monthDatesSet.add(dateStr);
  }
  for (const att of allAttendance) {
    if (att.date >= `${year}-${String(month).padStart(2,'0')}-01` && att.date <= `${year}-${String(month).padStart(2,'0')}-${endDate.getDate()}`) {
      monthDatesSet.add(att.date);
    }
  }
  const classDates = Array.from(monthDatesSet).sort();
  const classDateObjects = classDates.map(date => {
    const dayName = getDayNameFromDateString(date);
    const slot = classData.schedule.slots.find(s => s.day === dayName);
    return {
      date,
      dayName,
      startTime: slot ? slot.startTime : '—',
      endTime: slot ? slot.endTime : '—',
      isScheduled: !!slot
    };
  });
  
  const matrix = [];
  for (const student of students) {
    const row = { studentName: student.name, studentId: student.studentId };
    for (const cd of classDateObjects) {
      const rec = allAttendance.find(a => a.student === student.id && a.date === cd.date);
      const status = rec ? rec.status : 'absent';
      row[cd.date] = status;
    }
    const overallCount = studentOverallCounts[student.id] || 0;
    const overallPercentage = totalClassDays > 0 ? ((overallCount / totalClassDays) * 100).toFixed(2) : '0';
    row.overallPercentage = overallPercentage;
    matrix.push(row);
  }
  
  res.json({
    className: classData.className,
    classDates: classDateObjects,
    matrix,
    totalClassDays,
    periodStart: minDateStr,
    periodEnd: maxDateStr
  });
});

// ---------- Excel export ----------
app.get('/api/export/:classId/:year/:month', auth, async (req, res) => {
  const { classId, year, month } = req.params;
  const db = readDB();
  const classData = db.classes.find(c => c.id === parseInt(classId));
  if (!classData) return res.status(404).json({ error: 'Class not found' });
  
  const startDate = new Date(year, month-1, 1);
  const endDate = new Date(year, month, 0);
  const students = db.users.filter(u => classData.students.includes(u.id));
  const allAttendance = db.attendance.filter(a => a.class === classData.id);
  
  const presentLateRecords = allAttendance.filter(a => a.status === 'present' || a.status === 'late');
  let globalMinDate = null, globalMaxDate = null;
  for (const rec of presentLateRecords) {
    const d = new Date(rec.date);
    if (!globalMinDate || d < globalMinDate) globalMinDate = d;
    if (!globalMaxDate || d > globalMaxDate) globalMaxDate = d;
  }
  if (!globalMinDate || !globalMaxDate) {
    for (const rec of allAttendance) {
      const d = new Date(rec.date);
      if (!globalMinDate || d < globalMinDate) globalMinDate = d;
      if (!globalMaxDate || d > globalMaxDate) globalMaxDate = d;
    }
  }
  if (!globalMinDate) globalMinDate = startDate;
  if (!globalMaxDate) globalMaxDate = endDate;
  
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  let totalClassDays = 0;
  const current = new Date(globalMinDate);
  while (current <= globalMaxDate) {
    const dateStr = current.toISOString().split('T')[0];
    const dayName = getDayNameFromDateString(dateStr);
    const slot = classData.schedule.slots.find(s => s.day === dayName);
    if (slot) totalClassDays++;
    current.setDate(current.getDate() + 1);
  }
  
  const studentOverallCounts = {};
  for (const student of students) {
    let count = 0;
    for (const rec of allAttendance) {
      if (rec.student === student.id && (rec.status === 'present' || rec.status === 'late')) {
        const recDate = new Date(rec.date);
        if (recDate >= globalMinDate && recDate <= globalMaxDate) {
          count++;
        }
      }
    }
    studentOverallCounts[student.id] = count;
  }
  
  const monthDatesSet = new Set();
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const year = d.getFullYear();
    const monthNum = d.getMonth() + 1;
    const day = d.getDate();
    const dateStr = `${year}-${String(monthNum).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dayName = getDayNameFromDateString(dateStr);
    const slot = classData.schedule.slots.find(s => s.day === dayName);
    if (slot) monthDatesSet.add(dateStr);
  }
  for (const att of allAttendance) {
    if (att.date >= `${year}-${String(month).padStart(2,'0')}-01` && att.date <= `${year}-${String(month).padStart(2,'0')}-${endDate.getDate()}`) {
      monthDatesSet.add(att.date);
    }
  }
  const classDates = Array.from(monthDatesSet).sort();
  
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Attendance');
  const header = ['Student Name', 'Student ID', ...classDates, 'Present (overall)', 'Late (overall)', 'Absent (overall)', '% (overall)'];
  sheet.addRow(header);
  for (const s of students) {
    let overallPresent = 0, overallLate = 0;
    const row = [s.name, s.studentId || 'N/A'];
    for (const date of classDates) {
      const rec = allAttendance.find(a => a.student === s.id && a.date === date);
      let cell = 'A';
      if (rec) {
        if (rec.status === 'present') { cell = 'P'; overallPresent++; }
        else if (rec.status === 'late') { cell = 'L'; overallLate++; }
      }
      row.push(cell);
    }
    const overallAttended = studentOverallCounts[s.id] || 0;
    const percent = totalClassDays > 0 ? ((overallAttended / totalClassDays) * 100).toFixed(2) : '0';
    row.push(overallPresent, overallLate, totalClassDays - overallAttended, `${percent}%`);
    sheet.addRow(row);
  }
  sheet.eachRow((row, rowNumber) => {
    row.eachCell(cell => {
      if (rowNumber === 1) {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
        cell.font.color = { argb: 'FFFFFFFF' };
      } else {
        const val = cell.value;
        if (val === 'P') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
        else if (val === 'L') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC000' } };
        else if (val === 'A') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
      }
    });
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=attendance_${classData.courseCode}_${month}_${year}.xlsx`);
  await workbook.xlsx.write(res);
  res.end();
});

// ---------- Frontend with OpenStreetMap Leaflet integration ----------
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MTU Attendance Tracker</title>
  <!-- Leaflet CSS -->
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      background: #0a0f1e;
      color: #eef2ff;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    .card {
      background: rgba(18, 25, 45, 0.8);
      backdrop-filter: blur(10px);
      border-radius: 24px;
      padding: 24px;
      margin-bottom: 24px;
      border: 1px solid rgba(72, 187, 255, 0.2);
      box-shadow: 0 8px 20px rgba(0,0,0,0.3);
    }
    .hidden { display: none !important; }
    button, .button {
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: white;
      border: none;
      padding: 8px 20px;
      border-radius: 40px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
    }
    button:hover {
      transform: translateY(-1px);
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
    }
    input, select {
      background: #1e293b;
      border: 1px solid #334155;
      color: #f1f5f9;
      padding: 10px 14px;
      border-radius: 12px;
      width: 100%;
      margin: 8px 0;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #3b82f6;
    }
    .flex { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 24px; margin-top: 20px; }
    .class-card {
      background: #111827;
      border-radius: 20px;
      padding: 20px;
      border: 1px solid #1f2a40;
      transition: all 0.2s;
    }
    .class-card:hover { border-color: #3b82f6; transform: translateY(-2px); }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 30px;
      font-size: 11px;
      font-weight: 600;
      margin-left: 8px;
    }
    .badge-geo { background: #1e3a8a; color: #93c5fd; }
    .toggle {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #1e293b;
      padding: 12px;
      border-radius: 16px;
      margin: 12px 0;
      cursor: pointer;
    }
    .toggle.active { background: #1e3a8a; border: 1px solid #3b82f6; }
    .geo-settings { background: #0f172a; padding: 16px; border-radius: 16px; margin-top: 12px; }
    .preset-buttons { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
    .preset {
      background: #334155;
      color: #e2e8f0;
      padding: 4px 12px;
      border-radius: 30px;
      font-size: 12px;
      cursor: pointer;
    }
    .modal {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.8);
      backdrop-filter: blur(5px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal-content {
      background: #0f172a;
      border-radius: 28px;
      max-width: 700px;
      width: 90%;
      padding: 28px;
      max-height: 90vh;
      overflow-y: auto;
      border: 1px solid #334155;
    }
    video { width: 100%; border-radius: 16px; margin: 16px 0; }
    .info { padding: 12px; border-radius: 12px; margin: 12px 0; }
    .info-success { background: #064e3b; color: #a7f3d0; }
    .info-error { background: #7f1d1d; color: #fecaca; }
    .attendance-table {
      width: 100%;
      border-collapse: collapse;
      background: #0f172a;
      border-radius: 16px;
      overflow: hidden;
    }
    .attendance-table th, .attendance-table td {
      border: 1px solid #1e293b;
      padding: 10px;
      text-align: left;
    }
    .attendance-table th { background: #1e293b; color: #94a3b8; }
    .week-nav { display: flex; justify-content: space-between; margin-bottom: 20px; align-items: center; }
    .logo {
      display: flex;
      align-items: center;
      gap: 20px;
    }
    .logo img {
      height: 60px;
      width: auto;
      background: white;
      padding: 4px 8px;
      border-radius: 12px;
    }
    .logo h1 {
      font-size: 1.5rem;
      font-weight: 700;
      background: linear-gradient(135deg, #60a5fa, #a78bfa);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    hr { border-color: #1e293b; margin: 16px 0; }
    .slot-row { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; }
    .slot-row select { width: 120px; }
    .slot-row input { width: 100px; }
    .dropdown { position: relative; display: inline-block; }
    .dropdown-content {
      display: none;
      position: absolute;
      right: 0;
      background: #1e293b;
      min-width: 200px;
      box-shadow: 0px 8px 16px 0px rgba(0,0,0,0.2);
      z-index: 1;
      border-radius: 12px;
      border: 1px solid #334155;
    }
    .dropdown-content a {
      color: #eef2ff;
      padding: 12px 16px;
      text-decoration: none;
      display: block;
      cursor: pointer;
    }
    .dropdown-content a:hover { background: #334155; border-radius: 12px; }
    .show { display: block; }
    .user-name { cursor: pointer; padding: 8px 16px; background: #1e293b; border-radius: 40px; display: inline-block; }
    #geofenceMap, .class-geofence-map { height: 300px; width: 100%; border-radius: 12px; overflow: hidden; margin-top: 10px; }
    .map-container { position: relative; }
  </style>
</head>
<body>
<div class="container" id="app">

  <!-- Login Section -->
  <div id="loginSection" class="card">
    <div class="logo">
      <img src="https://mtu.ac.in/wp-content/uploads/2023/07/MTU-logo.png" alt="MTU Logo" onerror="this.src='data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 60'%3E%3Crect width='200' height='60' fill='%231e293b' rx='12'/%3E%3Ctext x='20' y='38' font-family='Arial' font-size='20' fill='%2360a5fa' font-weight='bold'%3EMTU%3C/text%3E%3Ctext x='60' y='38' font-family='Arial' font-size='14' fill='%2394a3b8'%3EMANIPUR TECHNICAL UNIVERSITY%3C/text%3E%3C/svg%3E'">
      <h1>Attendance Tracker</h1>
    </div>
    <div id="loginError" class="info info-error hidden"></div>
    <input type="email" id="loginEmail" placeholder="Email">
    <input type="password" id="loginPassword" placeholder="Password">
    <button onclick="doLogin()">Login</button>
    <button onclick="showRegister()" style="background:#334155;">Create Account</button>
  </div>

  <!-- Register Section (Student only) -->
  <div id="registerSection" class="card hidden">
    <h2>Create Student Account</h2>
    <div id="registerError" class="info info-error hidden"></div>
    <input type="text" id="regName" placeholder="Full Name">
    <input type="email" id="regEmail" placeholder="Email">
    <input type="password" id="regPassword" placeholder="Password">
    <input type="text" id="regStudentId" placeholder="Student Registration Number (required)">
    <button onclick="doRegister()">Register</button>
    <button onclick="showLogin()">Back to Login</button>
  </div>

  <!-- Main App -->
  <div id="appSection" class="hidden">
    <div class="card" style="display: flex; justify-content: space-between; align-items: center;">
      <div class="logo">
        <img src="https://mtu.ac.in/wp-content/uploads/2023/07/MTU-logo.png" alt="MTU Logo" onerror="this.src='data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 60'%3E%3Crect width='200' height='60' fill='%231e293b' rx='12'/%3E%3Ctext x='20' y='38' font-family='Arial' font-size='20' fill='%2360a5fa' font-weight='bold'%3EMTU%3C/text%3E%3Ctext x='60' y='38' font-family='Arial' font-size='14' fill='%2394a3b8'%3EMANIPUR TECHNICAL UNIVERSITY%3C/text%3E%3C/svg%3E'">
        <div class="dropdown">
          <span id="userGreeting" class="user-name"></span>
          <div id="userDropdown" class="dropdown-content">
            <a onclick="openProfileModal()">⚙️ Profile Settings</a>
            <a onclick="logout()">🚪 Logout</a>
          </div>
        </div>
      </div>
    </div>

    <div id="dashboardPanel">
      <!-- Instructor Panel -->
      <div id="instructorPanel" class="hidden">
        <div class="card">
          <h3>➕ Create New Class</h3>
          <input type="text" id="className" placeholder="Class Name">
          <input type="text" id="courseCode" placeholder="Course Code">
          <input type="text" id="locationName" placeholder="Building / Room">
          <div><label>Class Schedule (Add time slots per day):</label>
            <div id="scheduleSlotsContainer"></div>
            <button type="button" onclick="addScheduleSlot()" style="margin-top:8px;">+ Add Slot</button>
          </div>
          <h4>📍 Geofence (Optional)</h4>
          <div class="toggle" id="geoEnableToggle" onclick="toggleGeoEnable()">
            <span>🔒 Enable Geofencing</span><span id="geoIndicator">❌</span>
          </div>
          <div id="geofenceSettings" style="display:none;">
            <button onclick="getCurrentLocationForCreate()">📍 Use my location</button>
            <input type="text" id="geoLat" placeholder="Latitude">
            <input type="text" id="geoLng" placeholder="Longitude">
            <label>Radius: <span id="radiusValue">100</span> m</label>
            <input type="range" id="geoRadius" min="10" max="500" step="10" value="100">
            <div class="preset-buttons">
              <span class="preset" onclick="setRadius(20)">20m</span>
              <span class="preset" onclick="setRadius(50)">50m</span>
              <span class="preset" onclick="setRadius(100)">100m</span>
              <span class="preset" onclick="setRadius(200)">200m</span>
              <span class="preset" onclick="setRadius(500)">500m</span>
            </div>
            <!-- Map container -->
            <div id="geofenceMap" class="map-container"></div>
          </div>
          <button onclick="createClass()">✅ Create Class</button>
        </div>
        <div class="card"><h3>📚 Your Classes</h3><div id="instructorClasses"></div></div>
      </div>

      <!-- Student Panel -->
      <div id="studentPanel" class="hidden">
        <div class="card">
          <h3>📚 My Classes</h3>
          <div id="studentClasses"></div>
          <hr>
          <h3>🔍 Enroll in a Class</h3>
          <input type="text" id="selfCourseCode" placeholder="Enter Course Code">
          <button onclick="selfEnroll()">Enroll Me</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Edit Class Modal -->
  <div id="editClassModal" class="modal hidden">
    <div class="modal-content">
      <h3>✏️ Edit Class</h3>
      <input type="text" id="editClassName" placeholder="Class Name">
      <input type="text" id="editCourseCode" placeholder="Course Code">
      <input type="text" id="editLocationName" placeholder="Building / Room">
      <div><label>Class Schedule:</label><div id="editScheduleSlotsContainer"></div>
        <button type="button" onclick="addEditScheduleSlot()" style="margin-top:8px;">+ Add Slot</button>
      </div>
      <h4>📍 Geofence (Optional)</h4>
      <div class="toggle" id="editGeoEnableToggle" onclick="toggleEditGeoEnable()">
        <span>🔒 Enable Geofencing</span><span id="editGeoIndicator">❌</span>
      </div>
      <div id="editGeofenceSettings" style="display:none;">
        <button onclick="getCurrentLocationForEdit()">📍 Use my location</button>
        <input type="text" id="editGeoLat" placeholder="Latitude">
        <input type="text" id="editGeoLng" placeholder="Longitude">
        <label>Radius: <span id="editRadiusValue">100</span> m</label>
        <input type="range" id="editGeoRadius" min="10" max="500" step="10" value="100">
        <div class="preset-buttons">
          <span class="preset" onclick="setEditRadius(20)">20m</span>
          <span class="preset" onclick="setEditRadius(50)">50m</span>
          <span class="preset" onclick="setEditRadius(100)">100m</span>
          <span class="preset" onclick="setEditRadius(200)">200m</span>
          <span class="preset" onclick="setEditRadius(500)">500m</span>
        </div>
        <!-- Edit map container -->
        <div id="editGeofenceMap" class="map-container"></div>
      </div>
      <button onclick="updateClass()" style="margin-top:16px;">💾 Save Changes</button>
      <button onclick="closeEditModal()" style="background:#334155;">Cancel</button>
    </div>
  </div>

  <!-- Profile Settings Modal -->
  <div id="profileModal" class="modal hidden">
    <div class="modal-content">
      <h3>⚙️ Profile Settings</h3>
      <div id="profileMessage" class="info info-error hidden"></div>
      <input type="text" id="profileName" placeholder="Full Name">
      <input type="email" id="profileEmail" placeholder="Email">
      <input type="password" id="profileCurrentPassword" placeholder="Current Password (required to change password)">
      <input type="password" id="profileNewPassword" placeholder="New Password (leave blank to keep current)">
      <input type="password" id="profileConfirmPassword" placeholder="Confirm New Password">
      <button onclick="updateProfile()">💾 Save Changes</button>
      <button onclick="closeProfileModal()" style="background:#334155;">Cancel</button>
    </div>
  </div>

  <!-- Manual Attendance Modal (Instructor only) -->
  <div id="manualAttendanceModal" class="modal hidden">
    <div class="modal-content">
      <h3 id="manualAttendanceTitle">Manual Attendance</h3>
      <div class="week-nav">
        <input type="date" id="manualDate" style="width: auto;">
        <span id="classTimeDisplay"></span>
      </div>
      <div style="overflow-x: auto;">
        <table class="attendance-table">
          <thead><tr><th>Student Name</th><th>Registration Number</th><th>Attendance</th></tr></thead>
          <tbody id="manualAttendanceBody"></tbody>
        </table>
      </div>
      <button onclick="saveManualAttendance()" style="margin-top:16px;">💾 Save Attendance</button>
      <button onclick="closeManualAttendanceModal()" style="background:#334155; margin-top:8px;">Cancel</button>
    </div>
  </div>

  <!-- Enrollment Modal -->
  <div id="enrollModal" class="modal hidden">
    <div class="modal-content">
      <h3>Enroll Students</h3>
      <div class="tab" style="display:flex; gap:12px; margin-bottom:20px;">
        <button id="tabManual" class="active" onclick="switchEnrollTab('manual')">Manual</button>
        <button id="tabFile" onclick="switchEnrollTab('file')">Upload File</button>
      </div>
      <div id="manualEnrollPanel">
        <input type="text" id="studentName" placeholder="Name">
        <input type="text" id="studentRegNo" placeholder="Registration Number">
        <input type="email" id="studentEmail" placeholder="Email (optional)">
        <button onclick="enrollManual()">Enroll</button>
      </div>
      <div id="fileEnrollPanel" style="display:none;">
        <input type="file" id="enrollFile" accept=".csv,.xlsx">
        <button onclick="uploadEnrollFile()">Upload & Enroll</button>
        <div id="uploadResult"></div>
      </div>
      <button onclick="closeEnrollModal()" style="background:#334155;">Close</button>
    </div>
  </div>

  <!-- Attendance Modal (Student) -->
  <div id="attendanceModal" class="modal hidden">
    <div class="modal-content">
      <h3>📸 Mark Attendance</h3>
      <div id="modalMessage"></div>
      <div id="modalLocation" class="info"></div>
      <div id="modalGeoStatus" class="info"></div>
      <div id="selfieSection">
        <video id="webcam" autoplay playsinline style="width:100%; border-radius:12px;"></video>
        <canvas id="canvas" style="display:none;"></canvas>
        <img id="selfiePreview" style="display:none; width:100%; border-radius:12px;">
        <div class="flex"><button onclick="captureSelfie()">📸 Take Selfie</button><button onclick="retakeSelfie()" style="display:none;">🔄 Retake</button></div>
      </div>
      <button onclick="submitAttendance()" style="width:100%; margin-top:12px;">✅ Submit</button>
      <button onclick="closeModal()" style="background:#334155;">Cancel</button>
    </div>
  </div>
</div>

<!-- Leaflet JS -->
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

<script>
  let token = localStorage.getItem('token');
  let currentUser = null;
  let currentClassId = null;
  let currentLocation = null;
  let currentSelfieBlob = null;
  let stream = null;
  let scheduleSlots = [];
  let editScheduleSlots = [];
  let currentEnrollClassId = null;
  let editingClassId = null;
  let currentManualClassId = null;
  let currentManualStudents = [];
  let currentManualAttendance = {};

  // Map variables
  let createMap = null;
  let createMarker = null;
  let createCircle = null;
  let editMap = null;
  let editMarker = null;
  let editCircle = null;
  let classMaps = {};

  // ----- Map functions -----
  function initCreateMap(lat = 28.6139, lng = 77.2090) {
    const container = document.getElementById('geofenceMap');
    if (!container) return;
    if (createMap) {
      createMap.remove();
      createMap = null;
    }
    createMap = L.map('geofenceMap', { zoomControl: true }).setView([lat, lng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(createMap);

    const icon = L.icon({
      iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      iconSize: [25, 41],
      iconAnchor: [12, 41]
    });
    createMarker = L.marker([lat, lng], { draggable: true, icon }).addTo(createMap);
    createMarker.on('dragend', function() {
      const pos = createMarker.getLatLng();
      document.getElementById('geoLat').value = pos.lat.toFixed(6);
      document.getElementById('geoLng').value = pos.lng.toFixed(6);
      updateCreateCircle(pos.lat, pos.lng);
    });
    createMap.on('click', function(e) {
      createMarker.setLatLng(e.latlng);
      document.getElementById('geoLat').value = e.latlng.lat.toFixed(6);
      document.getElementById('geoLng').value = e.latlng.lng.toFixed(6);
      updateCreateCircle(e.latlng.lat, e.latlng.lng);
    });
    // Draw radius circle
    const radius = parseInt(document.getElementById('geoRadius').value) || 100;
    createCircle = L.circle([lat, lng], {
      color: '#3b82f6',
      fillColor: '#3b82f6',
      fillOpacity: 0.15,
      radius: radius
    }).addTo(createMap);
    // Update circle on radius slider change
    document.getElementById('geoRadius').addEventListener('input', function() {
      const r = parseInt(this.value);
      document.getElementById('radiusValue').innerText = r;
      if (createCircle && createMarker) {
        const pos = createMarker.getLatLng();
        createCircle.setLatLng(pos);
        createCircle.setRadius(r);
      }
    });
    setTimeout(() => createMap.invalidateSize(), 200);
  }

  function updateCreateCircle(lat, lng) {
    if (createCircle) {
      createCircle.setLatLng([lat, lng]);
    }
  }

  function initEditMap(lat = 28.6139, lng = 77.2090) {
    const container = document.getElementById('editGeofenceMap');
    if (!container) return;
    if (editMap) {
      editMap.remove();
      editMap = null;
    }
    editMap = L.map('editGeofenceMap', { zoomControl: true }).setView([lat, lng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(editMap);

    const icon = L.icon({
      iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      iconSize: [25, 41],
      iconAnchor: [12, 41]
    });
    editMarker = L.marker([lat, lng], { draggable: true, icon }).addTo(editMap);
    editMarker.on('dragend', function() {
      const pos = editMarker.getLatLng();
      document.getElementById('editGeoLat').value = pos.lat.toFixed(6);
      document.getElementById('editGeoLng').value = pos.lng.toFixed(6);
      updateEditCircle(pos.lat, pos.lng);
    });
    editMap.on('click', function(e) {
      editMarker.setLatLng(e.latlng);
      document.getElementById('editGeoLat').value = e.latlng.lat.toFixed(6);
      document.getElementById('editGeoLng').value = e.latlng.lng.toFixed(6);
      updateEditCircle(e.latlng.lat, e.latlng.lng);
    });
    const radius = parseInt(document.getElementById('editGeoRadius').value) || 100;
    editCircle = L.circle([lat, lng], {
      color: '#3b82f6',
      fillColor: '#3b82f6',
      fillOpacity: 0.15,
      radius: radius
    }).addTo(editMap);
    document.getElementById('editGeoRadius').addEventListener('input', function() {
      const r = parseInt(this.value);
      document.getElementById('editRadiusValue').innerText = r;
      if (editCircle && editMarker) {
        const pos = editMarker.getLatLng();
        editCircle.setLatLng(pos);
        editCircle.setRadius(r);
      }
    });
    setTimeout(() => editMap.invalidateSize(), 200);
  }

  function updateEditCircle(lat, lng) {
    if (editCircle) {
      editCircle.setLatLng([lat, lng]);
    }
  }

  // For inline class maps (each class card gets its own map)
  function initClassMap(classId, lat, lng) {
    const mapId = `map_${classId}`;
    const container = document.getElementById(mapId);
    if (!container) return;
    if (classMaps[classId]) {
      classMaps[classId].remove();
      delete classMaps[classId];
    }
    const map = L.map(mapId, { zoomControl: true }).setView([lat, lng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    const icon = L.icon({
      iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      iconSize: [25, 41],
      iconAnchor: [12, 41]
    });
    const marker = L.marker([lat, lng], { draggable: true, icon }).addTo(map);
    marker.on('dragend', function() {
      const pos = marker.getLatLng();
      document.getElementById(`geoLat_${classId}`).value = pos.lat.toFixed(6);
      document.getElementById(`geoLng_${classId}`).value = pos.lng.toFixed(6);
      updateClassCircle(classId, pos.lat, pos.lng);
    });
    map.on('click', function(e) {
      marker.setLatLng(e.latlng);
      document.getElementById(`geoLat_${classId}`).value = e.latlng.lat.toFixed(6);
      document.getElementById(`geoLng_${classId}`).value = e.latlng.lng.toFixed(6);
      updateClassCircle(classId, e.latlng.lat, e.latlng.lng);
    });
    const radius = parseInt(document.getElementById(`geoRadius_${classId}`).value) || 100;
    const circle = L.circle([lat, lng], {
      color: '#3b82f6',
      fillColor: '#3b82f6',
      fillOpacity: 0.15,
      radius: radius
    }).addTo(map);
    document.getElementById(`geoRadius_${classId}`).addEventListener('input', function() {
      const r = parseInt(this.value);
      document.getElementById(`radiusValue_${classId}`).innerText = r;
      if (circle && marker) {
        const pos = marker.getLatLng();
        circle.setLatLng(pos);
        circle.setRadius(r);
      }
    });
    classMaps[classId] = map;
    setTimeout(() => map.invalidateSize(), 200);
  }

  function updateClassCircle(classId, lat, lng) {
    // Circle is updated via the event listener on marker drag/click
  }

  // ----- Dropdown and Profile functions -----
  function toggleDropdown() {
    document.getElementById('userDropdown').classList.toggle('show');
  }
  window.onclick = function(event) {
    if (!event.target.matches('.user-name')) {
      var dropdowns = document.getElementsByClassName('dropdown-content');
      for (var i = 0; i < dropdowns.length; i++) {
        var openDropdown = dropdowns[i];
        if (openDropdown.classList.contains('show')) {
          openDropdown.classList.remove('show');
        }
      }
    }
  }

  function openProfileModal() {
    document.getElementById('profileName').value = currentUser.name || '';
    document.getElementById('profileEmail').value = currentUser.email || '';
    document.getElementById('profileCurrentPassword').value = '';
    document.getElementById('profileNewPassword').value = '';
    document.getElementById('profileConfirmPassword').value = '';
    document.getElementById('profileMessage').innerHTML = '';
    document.getElementById('profileMessage').classList.add('hidden');
    document.getElementById('profileModal').classList.remove('hidden');
    document.getElementById('userDropdown').classList.remove('show');
  }

  function closeProfileModal() {
    document.getElementById('profileModal').classList.add('hidden');
  }

  async function updateProfile() {
    const name = document.getElementById('profileName').value;
    const email = document.getElementById('profileEmail').value;
    const currentPassword = document.getElementById('profileCurrentPassword').value;
    const newPassword = document.getElementById('profileNewPassword').value;
    const confirmPassword = document.getElementById('profileConfirmPassword').value;
    if (newPassword && newPassword !== confirmPassword) {
      document.getElementById('profileMessage').innerText = 'New passwords do not match';
      document.getElementById('profileMessage').classList.remove('hidden');
      return;
    }
    const payload = { name, email };
    if (currentPassword) payload.currentPassword = currentPassword;
    if (newPassword) payload.newPassword = newPassword;
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      alert('Profile updated successfully');
      currentUser = data.user;
      localStorage.setItem('user', JSON.stringify(currentUser));
      document.getElementById('userGreeting').innerHTML = `👋 ${currentUser.name}`;
      closeProfileModal();
    } catch (err) {
      document.getElementById('profileMessage').innerText = err.message;
      document.getElementById('profileMessage').classList.remove('hidden');
    }
  }

  // Schedule slot helpers
  function addScheduleSlot() {
    scheduleSlots.push({ day: 'Monday', startTime: '09:00', endTime: '10:00' });
    renderScheduleSlots();
  }
  function removeScheduleSlot(index) {
    scheduleSlots.splice(index, 1);
    renderScheduleSlots();
  }
  function renderScheduleSlots() {
    const container = document.getElementById('scheduleSlotsContainer');
    if (!container) return;
    container.innerHTML = '';
    scheduleSlots.forEach((slot, idx) => {
      const div = document.createElement('div');
      div.className = 'slot-row';
      div.innerHTML = `
        <select onchange="scheduleSlots[${idx}].day = this.value">
          <option value="Monday" ${slot.day === 'Monday' ? 'selected' : ''}>Monday</option>
          <option value="Tuesday" ${slot.day === 'Tuesday' ? 'selected' : ''}>Tuesday</option>
          <option value="Wednesday" ${slot.day === 'Wednesday' ? 'selected' : ''}>Wednesday</option>
          <option value="Thursday" ${slot.day === 'Thursday' ? 'selected' : ''}>Thursday</option>
          <option value="Friday" ${slot.day === 'Friday' ? 'selected' : ''}>Friday</option>
          <option value="Saturday" ${slot.day === 'Saturday' ? 'selected' : ''}>Saturday</option>
          <option value="Sunday" ${slot.day === 'Sunday' ? 'selected' : ''}>Sunday</option>
        </select>
        <input type="time" value="${slot.startTime}" onchange="scheduleSlots[${idx}].startTime = this.value">
        <input type="time" value="${slot.endTime}" onchange="scheduleSlots[${idx}].endTime = this.value">
        <button onclick="removeScheduleSlot(${idx})" style="background:#dc2626; padding:4px 8px;">✖</button>
      `;
      container.appendChild(div);
    });
  }

  function addEditScheduleSlot() {
    editScheduleSlots.push({ day: 'Monday', startTime: '09:00', endTime: '10:00' });
    renderEditScheduleSlots();
  }
  function removeEditScheduleSlot(index) {
    editScheduleSlots.splice(index, 1);
    renderEditScheduleSlots();
  }
  function renderEditScheduleSlots() {
    const container = document.getElementById('editScheduleSlotsContainer');
    if (!container) return;
    container.innerHTML = '';
    editScheduleSlots.forEach((slot, idx) => {
      const div = document.createElement('div');
      div.className = 'slot-row';
      div.innerHTML = `
        <select onchange="editScheduleSlots[${idx}].day = this.value">
          <option value="Monday" ${slot.day === 'Monday' ? 'selected' : ''}>Monday</option>
          <option value="Tuesday" ${slot.day === 'Tuesday' ? 'selected' : ''}>Tuesday</option>
          <option value="Wednesday" ${slot.day === 'Wednesday' ? 'selected' : ''}>Wednesday</option>
          <option value="Thursday" ${slot.day === 'Thursday' ? 'selected' : ''}>Thursday</option>
          <option value="Friday" ${slot.day === 'Friday' ? 'selected' : ''}>Friday</option>
          <option value="Saturday" ${slot.day === 'Saturday' ? 'selected' : ''}>Saturday</option>
          <option value="Sunday" ${slot.day === 'Sunday' ? 'selected' : ''}>Sunday</option>
        </select>
        <input type="time" value="${slot.startTime}" onchange="editScheduleSlots[${idx}].startTime = this.value">
        <input type="time" value="${slot.endTime}" onchange="editScheduleSlots[${idx}].endTime = this.value">
        <button onclick="removeEditScheduleSlot(${idx})" style="background:#dc2626; padding:4px 8px;">✖</button>
      `;
      container.appendChild(div);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    scheduleSlots = [];
    renderScheduleSlots();
    const radiusSlider = document.getElementById('geoRadius');
    if(radiusSlider) radiusSlider.addEventListener('input', (e) => document.getElementById('radiusValue').innerText = e.target.value);
    document.getElementById('userGreeting')?.addEventListener('click', toggleDropdown);
  });

  // ----- Auth functions -----
  async function doLogin() {
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const res = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email,password}) });
    const data = await res.json();
    if(!res.ok) { showError('loginError', data.error); return; }
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    token = data.token;
    currentUser = data.user;
    showApp();
  }

  async function doRegister() {
    const name = document.getElementById('regName').value;
    const email = document.getElementById('regEmail').value;
    const password = document.getElementById('regPassword').value;
    const studentId = document.getElementById('regStudentId').value;
    if (!studentId) { showError('registerError', 'Student Registration Number is required'); return; }
    const res = await fetch('/api/register', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, email, password, role: 'student', studentId })
    });
    const data = await res.json();
    if(!res.ok) { showError('registerError', data.error); return; }
    alert('Account created! Please login.');
    showLogin();
  }

  function showError(elId, msg) {
    const el = document.getElementById(elId);
    el.innerText = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
  }

  function showLogin() {
    document.getElementById('loginSection').classList.remove('hidden');
    document.getElementById('registerSection').classList.add('hidden');
    document.getElementById('appSection').classList.add('hidden');
  }

  function showRegister() {
    document.getElementById('loginSection').classList.add('hidden');
    document.getElementById('registerSection').classList.remove('hidden');
    document.getElementById('appSection').classList.add('hidden');
  }

  function showDashboard() {
    document.getElementById('dashboardPanel').classList.remove('hidden');
  }

  async function showApp() {
    currentUser = JSON.parse(localStorage.getItem('user'));
    document.getElementById('userGreeting').innerHTML = `👋 ${currentUser.name}`;
    document.getElementById('loginSection').classList.add('hidden');
    document.getElementById('registerSection').classList.add('hidden');
    document.getElementById('appSection').classList.remove('hidden');
    showDashboard();
    if(currentUser.role === 'instructor') {
      document.getElementById('instructorPanel').classList.remove('hidden');
      document.getElementById('studentPanel').classList.add('hidden');
      await loadInstructorData();
    } else {
      document.getElementById('instructorPanel').classList.add('hidden');
      document.getElementById('studentPanel').classList.remove('hidden');
      await loadStudentData();
    }
  }

  async function loadInstructorData() {
    await loadClasses();
  }

  async function loadClasses() {
    const res = await fetch('/api/my-classes', { headers: { 'Authorization': `Bearer ${token}` } });
    const classes = await res.json();
    const container = document.getElementById('instructorClasses');
    if(classes.length === 0) { container.innerHTML = '<p>No classes yet.</p>'; return; }
    container.innerHTML = '<div class="grid"></div>';
    const grid = container.querySelector('.grid');
    for(const cls of classes) {
      const hasGeo = !!cls.geofence;
      const scheduleText = cls.schedule.slots.map(s => `${s.day.substring(0,3)} ${s.startTime}-${s.endTime}`).join(', ');
      const card = document.createElement('div');
      card.className = 'class-card';
      card.innerHTML = `
        <h4>${cls.className} <span class="badge badge-geo">${hasGeo ? 'Geofenced' : 'No geofence'}</span></h4>
        <p><strong>${cls.courseCode}</strong> | 👥 ${cls.studentCount} students</p>
        <p>📅 ${scheduleText}</p>
        <p>📍 ${cls.locationName}</p>
        <div class="toggle" id="toggleGeo_${cls.id}" onclick="toggleGeoEnabled(${cls.id})">
          <span>🔒 Geofencing</span><span id="geoIndicator_${cls.id}">${hasGeo ? '✅' : '❌'}</span>
        </div>
        <div id="geoSettings_${cls.id}" style="display:${hasGeo ? 'block' : 'none'};" class="geo-settings">
          <button onclick="getLocationForClass(${cls.id})">📍 Use current</button>
          <input type="text" id="geoLat_${cls.id}" placeholder="Latitude" value="${cls.geofence?.latitude || ''}">
          <input type="text" id="geoLng_${cls.id}" placeholder="Longitude" value="${cls.geofence?.longitude || ''}">
          <label>Radius: <span id="radiusValue_${cls.id}">${cls.geofence?.radius || 100}</span> m</label>
          <input type="range" id="geoRadius_${cls.id}" min="10" max="500" step="10" value="${cls.geofence?.radius || 100}" oninput="document.getElementById('radiusValue_${cls.id}').innerText=this.value">
          <div class="preset-buttons">
            <span class="preset" onclick="setClassRadius(${cls.id},20)">20m</span>
            <span class="preset" onclick="setClassRadius(${cls.id},50)">50m</span>
            <span class="preset" onclick="setClassRadius(${cls.id},100)">100m</span>
            <span class="preset" onclick="setClassRadius(${cls.id},200)">200m</span>
            <span class="preset" onclick="setClassRadius(${cls.id},500)">500m</span>
          </div>
          <!-- Map for this class -->
          <div id="map_${cls.id}" class="class-geofence-map"></div>
        </div>
        <div class="flex" style="margin-top:16px;">
          <button onclick="saveGeofence(${cls.id})">💾 Save Geofence</button>
          <button onclick="removeGeofence(${cls.id})" style="background:#dc2626;">🗑️ Remove</button>
          <button onclick="editClass(${cls.id})">✏️ Edit</button>
          <button onclick="openManualAttendance(${cls.id})">📝 Manual Attendance</button>
          <button onclick="viewCalendar(${cls.id})">📅 Calendar</button>
          <button onclick="exportExcel(${cls.id})">📊 Export Excel</button>
          <button onclick="openEnrollModal(${cls.id})">➕ Enroll</button>
        </div>
      `;
      grid.appendChild(card);
      // If geofence exists, init the map
      if (hasGeo) {
        setTimeout(() => {
          initClassMap(cls.id, cls.geofence.latitude, cls.geofence.longitude);
        }, 100);
      }
    }
  }

  async function loadStudentData() {
    const res = await fetch('/api/my-classes', { headers: { 'Authorization': `Bearer ${token}` } });
    const classes = await res.json();
    const container = document.getElementById('studentClasses');
    if(classes.length === 0) { container.innerHTML = '<p>No enrolled classes.</p>'; return; }
    container.innerHTML = '<div class="grid"></div>';
    const grid = container.querySelector('.grid');
    for(const cls of classes) {
      const hasGeo = !!cls.geofence;
      const geoText = hasGeo ? `📍 Within ${cls.geofence.radius}m` : '🌍 Any location';
      const scheduleText = cls.schedule.slots.map(s => `${s.day.substring(0,3)} ${s.startTime}-${s.endTime}`).join(', ');
      const card = document.createElement('div');
      card.className = 'class-card';
      card.innerHTML = `
        <h4>${cls.className}</h4>
        <p><strong>${cls.courseCode}</strong></p>
        <p>📅 ${scheduleText}</p>
        <p>📍 ${cls.locationName}</p>
        <p><small>${geoText}</small></p>
        <div class="flex">
          <button onclick="openAttendance(${cls.id})">✅ Mark Attendance</button>
          <button onclick="viewMyCalendar(${cls.id})">📊 My Attendance</button>
        </div>
      `;
      grid.appendChild(card);
    }
  }

  // ----- Geofence helpers (updated to init map on toggle) -----
  window.toggleGeoEnabled = function(classId) {
    const toggle = document.getElementById(`toggleGeo_${classId}`);
    const settings = document.getElementById(`geoSettings_${classId}`);
    const indicator = document.getElementById(`geoIndicator_${classId}`);
    const active = toggle.classList.contains('active');
    if(active) {
      toggle.classList.remove('active');
      indicator.innerText = '❌';
      settings.style.display = 'none';
      // Remove map if exists
      if (classMaps[classId]) {
        classMaps[classId].remove();
        delete classMaps[classId];
      }
    } else {
      toggle.classList.add('active');
      indicator.innerText = '✅';
      settings.style.display = 'block';
      // Init map with current lat/lng
      const lat = parseFloat(document.getElementById(`geoLat_${classId}`).value) || 28.6139;
      const lng = parseFloat(document.getElementById(`geoLng_${classId}`).value) || 77.2090;
      setTimeout(() => initClassMap(classId, lat, lng), 100);
    }
  };
  window.getLocationForClass = function(classId) {
    if(navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        document.getElementById(`geoLat_${classId}`).value = pos.coords.latitude;
        document.getElementById(`geoLng_${classId}`).value = pos.coords.longitude;
        // Update map
        if (classMaps[classId]) {
          classMaps[classId].remove();
          delete classMaps[classId];
        }
        setTimeout(() => initClassMap(classId, pos.coords.latitude, pos.coords.longitude), 100);
        alert('Location captured');
      });
    }
  };
  window.setClassRadius = function(classId, radius) {
    const slider = document.getElementById(`geoRadius_${classId}`);
    const display = document.getElementById(`radiusValue_${classId}`);
    if(slider) { slider.value = radius; display.innerText = radius; }
  };
  window.saveGeofence = async function(classId) {
    const isEnabled = document.getElementById(`toggleGeo_${classId}`).classList.contains('active');
    let geofence = null;
    if(isEnabled) {
      const lat = document.getElementById(`geoLat_${classId}`).value;
      const lng = document.getElementById(`geoLng_${classId}`).value;
      const radius = parseInt(document.getElementById(`geoRadius_${classId}`).value);
      if(!lat || !lng) { alert('Enter latitude/longitude'); return; }
      geofence = { latitude: parseFloat(lat), longitude: parseFloat(lng), radius };
    }
    const res = await fetch(`/api/classes/${classId}/geofence`, {
      method: 'PUT',
      headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ geofence })
    });
    const data = await res.json();
    alert(data.message);
    loadClasses();
  };
  window.removeGeofence = async function(classId) {
    if(confirm('Remove geofence?')) await saveGeofence(classId);
  };

  // ----- Toggle geofence in create form -----
  function toggleGeoEnable() {
    const toggle = document.getElementById('geoEnableToggle');
    const settings = document.getElementById('geofenceSettings');
    const indicator = document.getElementById('geoIndicator');
    if(toggle.classList.contains('active')) {
      toggle.classList.remove('active');
      indicator.innerText = '❌';
      settings.style.display = 'none';
      if (createMap) {
        createMap.remove();
        createMap = null;
      }
    } else {
      toggle.classList.add('active');
      indicator.innerText = '✅';
      settings.style.display = 'block';
      const lat = parseFloat(document.getElementById('geoLat').value) || 28.6139;
      const lng = parseFloat(document.getElementById('geoLng').value) || 77.2090;
      setTimeout(() => initCreateMap(lat, lng), 100);
    }
  }

  function getCurrentLocationForCreate() {
    if(navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        document.getElementById('geoLat').value = pos.coords.latitude;
        document.getElementById('geoLng').value = pos.coords.longitude;
        if (createMap) {
          createMap.remove();
          createMap = null;
        }
        setTimeout(() => initCreateMap(pos.coords.latitude, pos.coords.longitude), 100);
        alert('Location set');
      });
    }
  }

  function setRadius(radius) {
    const slider = document.getElementById('geoRadius');
    const span = document.getElementById('radiusValue');
    slider.value = radius;
    span.innerText = radius;
  }

  // ----- Manual Attendance -----
  async function openManualAttendance(classId) {
    currentManualClassId = classId;
    const classRes = await fetch('/api/my-classes', { headers: { 'Authorization': `Bearer ${token}` } });
    const classes = await classRes.json();
    const cls = classes.find(c => c.id === classId);
    document.getElementById('manualAttendanceTitle').innerHTML = `Manual Attendance - ${cls.className}`;
    const slots = cls.schedule.slots;
    const today = new Date();
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    let validDate = new Date(today);
    while (!slots.some(s => s.day === dayNames[validDate.getDay()])) {
      validDate.setDate(validDate.getDate() + 1);
    }
    const year = validDate.getFullYear();
    const month = String(validDate.getMonth() + 1).padStart(2, '0');
    const day = String(validDate.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    document.getElementById('manualDate').value = dateStr;
    const slot = slots.find(s => s.day === dayNames[validDate.getDay()]);
    document.getElementById('classTimeDisplay').innerHTML = slot ? `Class time: ${slot.startTime} - ${slot.endTime}` : '';
    document.getElementById('manualDate').addEventListener('change', () => loadManualAttendanceData(classId));
    await loadManualAttendanceData(classId);
    document.getElementById('manualAttendanceModal').classList.remove('hidden');
  }

  async function loadManualAttendanceData(classId) {
    const date = document.getElementById('manualDate').value;
    if (!date) return;
    const studentsRes = await fetch(`/api/class-students/${classId}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const students = await studentsRes.json();
    currentManualStudents = students;
    const attRes = await fetch(`/api/attendance-status/${classId}/${date}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const existing = await attRes.json();
    const statusMap = {};
    existing.forEach(a => { statusMap[a.student] = a.status; });
    currentManualAttendance = statusMap;
    renderManualAttendanceTable();
  }

  function renderManualAttendanceTable() {
    const tbody = document.getElementById('manualAttendanceBody');
    tbody.innerHTML = '';
    for (const student of currentManualStudents) {
      const status = currentManualAttendance[student.id] || 'absent';
      const row = tbody.insertRow();
      row.insertCell(0).innerText = student.name;
      row.insertCell(1).innerText = student.studentId || 'N/A';
      const cell = row.insertCell(2);
      const presentRadio = document.createElement('input');
      presentRadio.type = 'radio';
      presentRadio.name = `att_${student.id}`;
      presentRadio.value = 'present';
      presentRadio.checked = (status === 'present');
      presentRadio.onchange = () => { currentManualAttendance[student.id] = 'present'; };
      const absentRadio = document.createElement('input');
      absentRadio.type = 'radio';
      absentRadio.name = `att_${student.id}`;
      absentRadio.value = 'absent';
      absentRadio.checked = (status === 'absent');
      absentRadio.onchange = () => { currentManualAttendance[student.id] = 'absent'; };
      cell.appendChild(document.createTextNode(' Present '));
      cell.appendChild(presentRadio);
      cell.appendChild(document.createTextNode(' Absent '));
      cell.appendChild(absentRadio);
    }
  }

  async function saveManualAttendance() {
    const date = document.getElementById('manualDate').value;
    const attendanceList = [];
    for (const student of currentManualStudents) {
      const status = currentManualAttendance[student.id] || 'absent';
      attendanceList.push({ studentId: student.id, status });
    }
    const res = await fetch('/api/manual-attendance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ classId: currentManualClassId, date, attendance: attendanceList })
    });
    const data = await res.json();
    if (res.ok) alert('Manual attendance saved');
    else alert(data.error);
  }

  function closeManualAttendanceModal() {
    document.getElementById('manualAttendanceModal').classList.add('hidden');
    currentManualClassId = null;
  }

  // ----- Edit Class (with map) -----
  async function editClass(classId) {
    editingClassId = classId;
    const res = await fetch('/api/my-classes', { headers: { 'Authorization': `Bearer ${token}` } });
    const classes = await res.json();
    const cls = classes.find(c => c.id === classId);
    if(!cls) return;
    document.getElementById('editClassName').value = cls.className;
    document.getElementById('editCourseCode').value = cls.courseCode;
    document.getElementById('editLocationName').value = cls.locationName;
    editScheduleSlots = JSON.parse(JSON.stringify(cls.schedule.slots));
    renderEditScheduleSlots();
    const hasGeo = !!cls.geofence;
    const geoEnabledToggle = document.getElementById('editGeoEnableToggle');
    const geoSettings = document.getElementById('editGeofenceSettings');
    const geoIndicator = document.getElementById('editGeoIndicator');
    if(hasGeo) {
      geoEnabledToggle.classList.add('active');
      geoIndicator.innerText = '✅';
      geoSettings.style.display = 'block';
      document.getElementById('editGeoLat').value = cls.geofence.latitude;
      document.getElementById('editGeoLng').value = cls.geofence.longitude;
      document.getElementById('editGeoRadius').value = cls.geofence.radius;
      document.getElementById('editRadiusValue').innerText = cls.geofence.radius;
      setTimeout(() => initEditMap(cls.geofence.latitude, cls.geofence.longitude), 100);
    } else {
      geoEnabledToggle.classList.remove('active');
      geoIndicator.innerText = '❌';
      geoSettings.style.display = 'none';
      document.getElementById('editGeoLat').value = '';
      document.getElementById('editGeoLng').value = '';
      document.getElementById('editGeoRadius').value = 100;
      document.getElementById('editRadiusValue').innerText = '100';
      if (editMap) { editMap.remove(); editMap = null; }
    }
    document.getElementById('editClassModal').classList.remove('hidden');
  }

  function closeEditModal() {
    document.getElementById('editClassModal').classList.add('hidden');
    editingClassId = null;
    if (editMap) { editMap.remove(); editMap = null; }
  }

  function toggleEditGeoEnable() {
    const toggle = document.getElementById('editGeoEnableToggle');
    const settings = document.getElementById('editGeofenceSettings');
    const indicator = document.getElementById('editGeoIndicator');
    if(toggle.classList.contains('active')) {
      toggle.classList.remove('active');
      indicator.innerText = '❌';
      settings.style.display = 'none';
      if (editMap) { editMap.remove(); editMap = null; }
    } else {
      toggle.classList.add('active');
      indicator.innerText = '✅';
      settings.style.display = 'block';
      const lat = parseFloat(document.getElementById('editGeoLat').value) || 28.6139;
      const lng = parseFloat(document.getElementById('editGeoLng').value) || 77.2090;
      setTimeout(() => initEditMap(lat, lng), 100);
    }
  }

  function getCurrentLocationForEdit() {
    if(navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        document.getElementById('editGeoLat').value = pos.coords.latitude;
        document.getElementById('editGeoLng').value = pos.coords.longitude;
        if (editMap) {
          editMap.remove();
          editMap = null;
        }
        setTimeout(() => initEditMap(pos.coords.latitude, pos.coords.longitude), 100);
        alert('Location set');
      });
    }
  }

  function setEditRadius(radius) {
    const slider = document.getElementById('editGeoRadius');
    const span = document.getElementById('editRadiusValue');
    slider.value = radius;
    span.innerText = radius;
  }

  async function updateClass() {
    if(!editingClassId) return;
    const className = document.getElementById('editClassName').value;
    const courseCode = document.getElementById('editCourseCode').value;
    const locationName = document.getElementById('editLocationName').value;
    if(!className || !courseCode || editScheduleSlots.length===0) {
      alert('Please fill all required fields and add at least one time slot');
      return;
    }
    let geofence = null;
    const isGeoEnabled = document.getElementById('editGeoEnableToggle').classList.contains('active');
    if(isGeoEnabled) {
      const lat = document.getElementById('editGeoLat').value;
      const lng = document.getElementById('editGeoLng').value;
      const radius = parseInt(document.getElementById('editGeoRadius').value);
      if(lat && lng) geofence = { latitude: parseFloat(lat), longitude: parseFloat(lng), radius };
    }
    const payload = { className, courseCode, scheduleSlots: editScheduleSlots, locationName, geofence };
    const res = await fetch(`/api/classes/${editingClassId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if(res.ok) {
      alert('Class updated');
      closeEditModal();
      loadClasses();
    } else alert(data.error);
  }

  // ----- Create class (with map) -----
  async function createClass() {
    const className = document.getElementById('className').value;
    const courseCode = document.getElementById('courseCode').value;
    const locationName = document.getElementById('locationName').value;
    if(!className || !courseCode || scheduleSlots.length===0) {
      alert('Please fill all fields and add at least one time slot');
      return;
    }
    let geofence = null;
    const geoEnabled = document.getElementById('geoEnableToggle').classList.contains('active');
    if(geoEnabled) {
      const lat = document.getElementById('geoLat').value;
      const lng = document.getElementById('geoLng').value;
      const radius = parseInt(document.getElementById('geoRadius').value);
      if(lat && lng) geofence = { latitude: parseFloat(lat), longitude: parseFloat(lng), radius };
    }
    const res = await fetch('/api/classes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ className, courseCode, scheduleSlots, locationName, geofence })
    });
    if(res.ok) { alert('Class created'); location.reload(); }
    else { const err = await res.json(); alert(err.error); }
  }

  // ----- Calendar view -----
  async function viewCalendar(classId) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth()+1;
    const res = await fetch(`/api/calendar/${classId}/${year}/${month}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    let html = `<h3>${data.className} - ${month}/${year} (IST)</h3><p>Overall period: ${data.periodStart} to ${data.periodEnd} (Total class days: ${data.totalClassDays})</p><div style="overflow-x:auto"><table border="1" style="border-collapse:collapse; width:100%"><thead><tr><th>Student Name</th><th>Reg No</th>`;
    for (const cd of data.classDates) {
      const timeDisplay = (cd.startTime !== '—') ? `<br>${cd.startTime}-${cd.endTime}` : '';
      html += `<th>${cd.date}<br>${cd.dayName}${timeDisplay}</th>`;
    }
    html += `<th>Attendance % (overall)</th></tr></thead><tbody>`;
    for (const row of data.matrix) {
      html += `<tr><td>${row.studentName}</td><td>${row.studentId || 'N/A'}</td>`;
      for (const cd of data.classDates) {
        const status = row[cd.date];
        let cell = '';
        if (status === 'present') cell = '✅ P';
        else if (status === 'late') cell = '⏰ L';
        else cell = '❌ A';
        html += `<td style="text-align:center">${cell}</td>`;
      }
      html += `<td style="text-align:center; font-weight:bold">${row.overallPercentage}%</td></tr>`;
    }
    html += `</tbody></table></div>`;
    const win = window.open();
    win.document.write(html);
  }

  async function viewMyCalendar(classId) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth()+1;
    const res = await fetch(`/api/calendar/${classId}/${year}/${month}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    const myRow = data.matrix.find(r => r.studentName === currentUser.name);
    if (!myRow) { alert('No attendance data'); return; }
    let html = `<h3>My Attendance - ${data.className} (${month}/${year}) IST</h3><p>Overall period: ${data.periodStart} to ${data.periodEnd} (Total class days: ${data.totalClassDays})</p><div style="overflow-x:auto"><table border="1"><thead><tr><th>Date</th><th>Day</th><th>Status</th></tr></thead><tbody>`;
    for (const cd of data.classDates) {
      const status = myRow[cd.date];
      let statusText = '';
      if (status === 'present') statusText = '✅ Present';
      else if (status === 'late') statusText = '⏰ Late';
      else statusText = '❌ Absent';
      html += `<tr><td>${cd.date}</td><td>${cd.dayName}</td><td>${statusText}</td></tr>`;
    }
    html += `</tbody></table><p><strong>Overall Attendance: ${myRow.overallPercentage}%</strong></p></div>`;
    const win = window.open();
    win.document.write(html);
  }

  async function exportExcel(classId) {
    const now = new Date();
    const url = `/api/export/${classId}/${now.getFullYear()}/${now.getMonth()+1}?token=${token}`;
    window.open(url, '_blank');
  }

  // ----- Enrollment functions -----
  function openEnrollModal(classId) {
    currentEnrollClassId = classId;
    document.getElementById('enrollModal').classList.remove('hidden');
    switchEnrollTab('manual');
  }
  function closeEnrollModal() { document.getElementById('enrollModal').classList.add('hidden'); }
  function switchEnrollTab(tab) {
    const manual = document.getElementById('manualEnrollPanel');
    const file = document.getElementById('fileEnrollPanel');
    const tabManual = document.getElementById('tabManual');
    const tabFile = document.getElementById('tabFile');
    if(tab === 'manual') {
      manual.style.display = 'block';
      file.style.display = 'none';
      tabManual.classList.add('active');
      tabFile.classList.remove('active');
    } else {
      manual.style.display = 'none';
      file.style.display = 'block';
      tabManual.classList.remove('active');
      tabFile.classList.add('active');
    }
  }
  async function enrollManual() {
    const name = document.getElementById('studentName').value;
    const studentId = document.getElementById('studentRegNo').value;
    const email = document.getElementById('studentEmail').value;
    if(!name || !studentId) { alert('Name and Registration Number required'); return; }
    const createRes = await fetch('/api/create-student', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ name, studentId, email })
    });
    const createData = await createRes.json();
    if(!createRes.ok) { alert(createData.error); return; }
    const student = createData.user;
    if(createData.password) alert(`Student created. Temporary password: ${createData.password}`);
    const enrollRes = await fetch('/api/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ classId: currentEnrollClassId, studentId: student.id })
    });
    const enrollData = await enrollRes.json();
    if(enrollRes.ok) { alert('Enrolled successfully'); closeEnrollModal(); loadClasses(); }
    else alert(enrollData.error);
  }
  async function uploadEnrollFile() {
    const fileInput = document.getElementById('enrollFile');
    if(!fileInput.files.length) { alert('Select a file'); return; }
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    formData.append('classId', currentEnrollClassId);
    const res = await fetch('/api/bulk-enroll', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });
    const data = await res.json();
    if(!res.ok) { alert(data.error); return; }
    let msg = 'Bulk enrollment:\n';
    data.results.forEach(r => {
      msg += `${r.name} (${r.studentId}) - ${r.status}`;
      if(r.password) msg += ` (pw: ${r.password})`;
      msg += '\n';
    });
    alert(msg);
    closeEnrollModal();
    loadClasses();
  }
  async function selfEnroll() {
    const courseCode = document.getElementById('selfCourseCode').value.trim();
    if(!courseCode) { alert('Enter course code'); return; }
    const res = await fetch('/api/self-enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ courseCode })
    });
    const data = await res.json();
    if(!res.ok) alert(data.error);
    else { alert(data.message); loadStudentData(); }
    document.getElementById('selfCourseCode').value = '';
  }

  // ----- Attendance modal (student) -----
  async function openAttendance(classId) {
    if(currentUser.role !== 'student') return;
    currentClassId = classId;
    const modal = document.getElementById('attendanceModal');
    modal.classList.remove('hidden');
    document.getElementById('modalMessage').innerHTML = '';
    document.getElementById('modalLocation').innerHTML = '';
    document.getElementById('modalGeoStatus').innerHTML = '';
    if(navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        currentLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        document.getElementById('modalLocation').innerHTML = `📍 Location: ${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
        document.getElementById('modalLocation').className = 'info info-success';
      }, () => {
        document.getElementById('modalLocation').innerHTML = '❌ Location denied';
        document.getElementById('modalLocation').className = 'info info-error';
      });
    }
    document.getElementById('selfieSection').style.display = 'block';
    if(stream) stream.getTracks().forEach(t=>t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video: true });
    document.getElementById('webcam').srcObject = stream;
    document.getElementById('webcam').style.display = 'block';
    document.getElementById('selfiePreview').style.display = 'none';
    document.getElementById('takeSelfieBtn').style.display = 'inline-block';
    document.getElementById('retakeBtn').style.display = 'none';
  }
  function captureSelfie() {
    const video = document.getElementById('webcam');
    const canvas = document.getElementById('canvas');
    const preview = document.getElementById('selfiePreview');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob(blob => { currentSelfieBlob = blob; }, 'image/jpeg');
    preview.src = canvas.toDataURL('image/jpeg');
    video.style.display = 'none';
    preview.style.display = 'block';
    document.getElementById('takeSelfieBtn').style.display = 'none';
    document.getElementById('retakeBtn').style.display = 'inline-block';
  }
  function retakeSelfie() {
    const video = document.getElementById('webcam');
    const preview = document.getElementById('selfiePreview');
    video.style.display = 'block';
    preview.style.display = 'none';
    document.getElementById('takeSelfieBtn').style.display = 'inline-block';
    document.getElementById('retakeBtn').style.display = 'none';
    currentSelfieBlob = null;
  }
  async function submitAttendance() {
    if(!currentLocation) { alert('Location not available'); return; }
    if(!currentSelfieBlob) { alert('Please take a selfie'); return; }
    const formData = new FormData();
    formData.append('classId', currentClassId);
    formData.append('latitude', currentLocation.lat);
    formData.append('longitude', currentLocation.lng);
    formData.append('selfie', currentSelfieBlob, 'selfie.jpg');
    const res = await fetch('/api/attendance', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });
    const data = await res.json();
    if(!res.ok) alert(data.error);
    else { alert(data.message); closeModal(); loadStudentData(); }
  }
  function closeModal() {
    document.getElementById('attendanceModal').classList.add('hidden');
    if(stream) { stream.getTracks().forEach(t=>t.stop()); stream = null; }
    currentSelfieBlob = null;
  }

  function logout() { localStorage.clear(); window.location.reload(); }

  if(token) showApp(); else showLogin();
</script>
</body>
</html>
  `);
});

const PORT = 3000;
app.listen(PORT, () => console.log(`\n✅ Server running at http://localhost:${PORT}\n`));
