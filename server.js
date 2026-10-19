const express = require('express');
const crypto = require('crypto');
const path = require('path');

const cfg = require('./config');
const {
db,
addPoints,
getLeaderboard,
getFactionScores
} = require('./db');

const { sendTelegram } = require('./telegram');
const QUESTIONS = require('./questions');

const app = express();

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

const hashPassword = (password) =>
crypto.createHash('sha256').update(String(password)).digest('hex');

function requireAdmin(req, res, next) {
const password = req.headers['x-admin-password'];

if (!cfg.adminPassword || !password ||
hashPassword(password) !== hashPassword(cfg.adminPassword)) {
return res.status(401).json({ error: 'كلمة مرور الإدارة غير صحيحة.' });
}

next();
}

function getUserFromRequest(req) {
const username = String(req.body.username || '').trim();

if (!username) return null;

return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

app.get('/api/status', (req, res) => {
res.json({
online: true,
questions: QUESTIONS.length,
quizSeconds: cfg.quizSeconds
});
});

// Register a player
app.post('/api/register', (req, res) => {
const username = String(req.body.username || '').trim();
const deviceId = String(req.body.deviceId || '').trim();

if (!/^[a-zA-Z0-9_\u0600-\u06FF ]{2,24}$/.test(username)) {
return res.status(400).json({
error: 'اسم المستخدم يجب أن يكون من 2 إلى 24 حرفًا أو رقمًا.'
});
}

if (deviceId.length < 8 || deviceId.length > 128) {
return res.status(400).json({ error: 'معرّف الجهاز غير صالح.' });
}

let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

if (!user) {
const result = db.prepare("INSERT INTO users (username, device_id) VALUES (?, ?)").run(username, deviceId);

user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);

}

res.json({
ok: true,
user: {
id: user.id,
username: user.username,
faction: user.faction,
points: user.points,
quizScore: user.quiz_score
}
});
});

// Get quiz questions without exposing answers
app.post('/api/quiz/start', (req, res) => {
const user = getUserFromRequest(req);

if (!user) {
return res.status(404).json({ error: 'سجّل دخولك أولًا.' });
}

const answered = db.prepare(
'SELECT question_id FROM quiz_answers WHERE user_id = ?'
).all(user.id).map(row => row.question_id);

const remaining = QUESTIONS.filter(q => !answered.includes(q.id));

if (!remaining.length) {
return res.json({ finished: true, questions: [] });
}

sessions.set(user.id, {
questionIds: remaining.map(q => q.id),
startedAt: Date.now(),
current: 0
});

res.json({
finished: false,
duration: cfg.quizSeconds,
questions: remaining.map(q => ({
id: q.id,
question: q.question,
options: q.options
}))
});
});

// Submit an answer without revealing correctness
app.post('/api/quiz/answer', (req, res) => {
const user = getUserFromRequest(req);

if (!user) {
return res.status(404).json({ error: 'المستخدم غير موجود.' });
}

const questionId = Number(req.body.questionId);
const answerIndex = Number(req.body.answerIndex);
const session = sessions.get(user.id);

if (!session) {
return res.status(400).json({ error: 'ابدأ الاختبار أولًا.' });
}

const expectedId = session.questionIds[session.current];

if (questionId !== expectedId) {
return res.status(400).json({ error: 'السؤال غير متوقع.' });
}

if (Date.now() - session.startedAt > (session.current + 1) * cfg.quizSeconds * 1000) {
// Timeout: store an unanswered question as incorrect.
db.prepare("INSERT OR IGNORE INTO quiz_answers (user_id, question_id, answer_index, correct) VALUES (?, ?, -1, 0)").run(user.id, questionId);

session.current++;
return res.json({ ok: true, next: true, timedOut: true });

}

const question = QUESTIONS.find(q => q.id === questionId);

if (!question || !Number.isInteger(answerIndex) ||
answerIndex < 0 || answerIndex >= question.options.length) {
return res.status(400).json({ error: 'الإجابة غير صالحة.' });
}

const correct = answerIndex === question.answer ? 1 : 0;

const result = db.prepare("INSERT OR IGNORE INTO quiz_answers (user_id, question_id, answer_index, correct) VALUES (?, ?, ?, ?)").run(user.id, questionId, answerIndex, correct);

if (result.changes) {
if (correct) {
addPoints(user.id, 1, 'إجابة صحيحة في اختبار الأنمي');
db.prepare('UPDATE users SET quiz_score = quiz_score + 1 WHERE id = ?')
.run(user.id);
}
}

session.current++;
session.startedAt = Date.now();

res.json({
ok: true,
next: true,
finished: session.current >= session.questionIds.length
});
});

// Choose a faction
app.post('/api/faction', (req, res) => {
const user = getUserFromRequest(req);
const faction = String(req.body.faction || '');

const allowed = ['light', 'dark', 'immortals'];

if (!user) return res.status(404).json({ error: 'المستخدم غير موجود.' });
if (!allowed.includes(faction)) {
return res.status(400).json({ error: 'الفصيل غير صالح.' });
}
if (user.faction) {
return res.status(400).json({ error: 'لقد اخترت فصيلك بالفعل.' });
}

db.prepare('UPDATE users SET faction = ? WHERE id = ?')
.run(faction, user.id);

res.json({ ok: true, faction });
});

// Submit a mystery-case conclusion for admin review
app.post('/api/case/submit', (req, res) => {
const user = getUserFromRequest(req);
const conclusion = String(req.body.conclusion || '').trim();

if (!user) return res.status(404).json({ error: 'المستخدم غير موجود.' });
if (conclusion.length < 20 || conclusion.length > 5000) {
return res.status(400).json({
error: 'اكتب تحليلًا من 20 إلى 5000 حرف.'
});
}

const result = db.prepare("INSERT INTO case_submissions (user_id, conclusion) VALUES (?, ?)").run(user.id, conclusion);

res.json({ ok: true, submissionId: result.lastInsertRowid });
});

// Public leaderboard
app.get('/api/leaderboard', (req, res) => {
res.json({
players: getLeaderboard(50),
factions: getFactionScores()
});
});

// Admin: summary
app.get('/api/admin/summary', requireAdmin, (req, res) => {
const users = db.prepare('SELECT COUNT() AS count FROM users').get().count;
const submissions = db.prepare(
'SELECT COUNT() AS count FROM case_submissions WHERE reviewed = 0'
).get().count;

res.json({ users, submissions, factions: getFactionScores() });
});

// Admin: list players
app.get('/api/admin/users', requireAdmin, (req, res) => {
const users = db.prepare("SELECT id, username, faction, points, quiz_score, created_at FROM users ORDER BY points DESC LIMIT 500").all();

res.json({ users });
});

// Admin: send complete player report to Telegram
app.post('/api/admin/user-report', requireAdmin, async (req, res) => {
const username = String(req.body.username || '').trim();

if (!username) {
return res.status(400).json({ error: 'اكتب اسم اللاعب.' });
}

const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

if (!user) {
return res.status(404).json({ error: 'اللاعب غير موجود.' });
}

const answers = db.prepare("SELECT qa.question_id, qa.answer_index, qa.correct, qa.created_at FROM quiz_answers qa WHERE qa.user_id = ? ORDER BY qa.question_id").all(user.id);

const caseSubmissions = db.prepare("SELECT conclusion, score, reviewed, created_at FROM case_submissions WHERE user_id = ? ORDER BY id").all(user.id);

const logs = db.prepare("SELECT amount, reason, created_at FROM point_logs WHERE user_id = ? ORDER BY id").all(user.id);

const lines = [
'📋 تقرير اللاعب — HUNTER SYSTEM',
"الاسم: ${user.username}",
"رقم اللاعب: ${user.id}",
"الفصيل: ${user.faction || 'لم يختر بعد'}",
"النقاط: ${user.points}",
"إجابات صحيحة: ${user.quiz_score}",
"تاريخ التسجيل: ${user.created_at}",
'',
'📝 إجابات اختبار الأنمي:'
];

for (const q of QUESTIONS) {
const a = answers.find(item => item.question_id === q.id);

lines.push(
  `${q.id}. ${q.question}`,
  `إجابة اللاعب: ${a ? (a.answer_index === -1 ? 'لم يجب' : q.options[a.answer_index] || 'إجابة غير معروفة') : 'لم يجاوب'}`,
  `صحيحة: ${a ? (a.correct ? 'نعم' : 'لا') : 'لم يُسجل'}`,
  ''
);

}

lines.push('🕵️ تحليلات القضية:');

if (!caseSubmissions.length) {
lines.push('لا توجد تحليلات مسجلة.');
} else {
caseSubmissions.forEach((item, index) => {
lines.push(
"تحليل ${index + 1}:",
item.conclusion,
"التقييم: ${item.reviewed ? item.score : 'لم تتم المراجعة'}",
"التاريخ: ${item.created_at}",
''
);
});
}

lines.push('📊 سجل النقاط:');

if (!logs.length) {
lines.push('لا توجد حركة نقاط مسجلة.');
} else {
logs.forEach(item => {
lines.push("+${item.amount} — ${item.reason} — ${item.created_at}");
});
}

const sent = await sendTelegram(lines.join('\n'));

if (!sent) {
return res.status(502).json({
error: 'تعذر إرسال التقرير إلى تيليجرام. راجع إعدادات البوت.'
});
}

res.json({ ok: true, message: 'تم إرسال تقرير اللاعب إلى تيليجرام.' });
});

// Admin: review a case submission and award points
app.post('/api/admin/case-review', requireAdmin, (req, res) => {
const submissionId = Number(req.body.submissionId);
const score = Number(req.body.score);

if (!Number.isInteger(submissionId) ||
!Number.isInteger(score) || score < 0 || score > 100) {
return res.status(400).json({ error: 'بيانات التقييم غير صحيحة.' });
}

const submission = db.prepare("SELECT * FROM case_submissions WHERE id = ? AND reviewed = 0").get(submissionId);

if (!submission) {
return res.status(404).json({ error: 'التحليل غير موجود أو تمت مراجعته.' });
}

const transaction = db.transaction(() => {
db.prepare("UPDATE case_submissions SET score = ?, reviewed = 1 WHERE id = ?").run(score, submissionId);

if (score > 0) {
  addPoints(submission.user_id, score, 'تقييم تحليل القضية');
}

});

transaction();

res.json({ ok: true });
});

// Admin: manually award points
app.post('/api/admin/add-points', requireAdmin, (req, res) => {
const userId = Number(req.body.userId);
const amount = Number(req.body.amount);
const reason = String(req.body.reason || 'نقاط من الإدارة').slice(0, 200);

if (!Number.isInteger(userId) || !Number.isInteger(amount) ||
amount < 1 || amount > 10000) {
return res.status(400).json({ error: 'بيانات النقاط غير صحيحة.' });
}

try {
addPoints(userId, amount, reason);
res.json({ ok: true });
} catch (error) {
res.status(400).json({ error: error.message });
}
});

app.use((req, res) => {
res.status(404).json({ error: 'المسار غير موجود.' });
});

app.listen(cfg.port, () => {
console.log("HUNTER SYSTEM running on port ${cfg.port}");
});
