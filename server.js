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
const loginTokens = new Map();

const FACTIONS = ['light', 'dark', 'immortals'];
const QUESTION_BY_ID = new Map(QUESTIONS.map(q => [q.id, q]));

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

function requirePlayer(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const userId = loginTokens.get(token);

  if (!token || !userId) {
    return res.status(401).json({
      error: 'انتهت جلسة الدخول. سجّل دخولك مجددًا.'
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  if (!user) {
    loginTokens.delete(token);
    return res.status(401).json({ error: 'المستخدم غير موجود.' });
  }

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const password = req.headers['x-admin-password'];

  if (!cfg.adminPassword || !password ||
      !safeEqual(password, cfg.adminPassword)) {
    return res.status(401).json({
      error: 'كلمة مرور الإدارة غير صحيحة.'
    });
  }

  next();
}

function getPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    faction: user.faction,
    points: user.points,
    quizScore: user.quiz_score
  };
}

function recordTimeout(userId, questionId) {
  db.prepare(`
    INSERT OR IGNORE INTO quiz_answers
      (user_id, question_id, answer_index, correct)
    VALUES (?, ?, -1, 0)
  `).run(userId, questionId);
}

function getCurrentQuestion(session) {
  return QUESTION_BY_ID.get(session.questionIds[session.current]);
}

function finishExpiredQuestion(userId, session) {
  const question = getCurrentQuestion(session);
  if (!question) return false;

  if (Date.now() - session.startedAt < cfg.quizSeconds * 1000) {
    return false;
  }

  recordTimeout(userId, question.id);
  session.current++;
  session.startedAt = Date.now();

  return true;
}

app.get('/api/status', (req, res) => {
  res.json({
    online: true,
    questions: QUESTIONS.length,
    quizSeconds: cfg.quizSeconds
  });
});

// تسجيل الدخول وإنشاء حساب جديد.
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

  try {
    let user = db.prepare(
      'SELECT * FROM users WHERE username = ?'
    ).get(username);

    if (!user) {
      const existingDevice = db.prepare(
        'SELECT id FROM users WHERE device_id = ?'
      ).get(deviceId);

      if (existingDevice) {
        return res.status(409).json({
          error: 'هذا الجهاز مسجل بالفعل باسم آخر.'
        });
      }

      const result = db.prepare(
        'INSERT INTO users (username, device_id) VALUES (?, ?)'
      ).run(username, deviceId);

      user = db.prepare(
        'SELECT * FROM users WHERE id = ?'
      ).get(result.lastInsertRowid);
    } else if (user.device_id !== deviceId) {
      return res.status(409).json({
        error: 'اسم المستخدم مسجل على جهاز آخر.'
      });
    }

    const token = createToken();
    loginTokens.set(token, user.id);

    res.json({
      ok: true,
      token,
      user: getPublicUser(user)
    });
  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(500).json({ error: 'تعذر تسجيل الحساب.' });
  }
});

// بدء الاختبار.
app.post('/api/quiz/start', requirePlayer, (req, res) => {
  const user = req.user;

  const answered = new Set(
    db.prepare(
      'SELECT question_id FROM quiz_answers WHERE user_id = ?'
    ).all(user.id).map(row => row.question_id)
  );

  const remaining = QUESTIONS.filter(q => !answered.has(q.id));

  if (!remaining.length) {
    sessions.delete(user.id);
    return res.json({ finished: true, questions: [] });
  }

  const existing = sessions.get(user.id);

  // لا تعِد ضبط المؤقت إذا كان الاختبار قائمًا بالفعل.
  if (existing && existing.current < existing.questionIds.length) {
    const currentQuestion = getCurrentQuestion(existing);

    if (currentQuestion &&
        !answered.has(currentQuestion.id)) {
      return res.json({
        finished: false,
        duration: cfg.quizSeconds,
        questions: [{
          id: currentQuestion.id,
          question: currentQuestion.question,
          options: currentQuestion.options
        }]
      });
    }
  }

  const session = {
    questionIds: remaining.map(q => q.id),
    current: 0,
    startedAt: Date.now()
  };

  sessions.set(user.id, session);

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

// تسجيل إجابة اللاعب.
app.post('/api/quiz/answer', requirePlayer, (req, res) => {
  const user = req.user;
  const questionId = Number(req.body.questionId);
  const answerIndex = Number(req.body.answerIndex);
  const session = sessions.get(user.id);

  if (!session) {
    return res.status(400).json({ error: 'ابدأ الاختبار أولًا.' });
  }

  const question = getCurrentQuestion(session);

  if (!question || question.id !== questionId) {
    return res.status(400).json({ error: 'السؤال غير متوقع.' });
  }

  // السؤال انتهى وقته: سجله خطأ وانتقل للسؤال التالي.
  if (Date.now() - session.startedAt >= cfg.quizSeconds * 1000) {
    recordTimeout(user.id, questionId);
    session.current++;
    session.startedAt = Date.now();

    return res.json({
      ok: true,
      next: true,
      timedOut: true,
      finished: session.current >= session.questionIds.length
    });
  }

  if (!Number.isInteger(answerIndex) ||
      answerIndex < 0 ||
      answerIndex >= question.options.length) {
    return res.status(400).json({ error: 'الإجابة غير صالحة.' });
  }

  const correct = answerIndex === question.answer ? 1 : 0;

  const transaction = db.transaction(() => {
    const result = db.prepare(`
      INSERT OR IGNORE INTO quiz_answers
        (user_id, question_id, answer_index, correct)
      VALUES (?, ?, ?, ?)
    `).run(user.id, questionId, answerIndex, correct);

    if (result.changes && correct) {
      addPoints(user.id, 1, 'إجابة صحيحة في اختبار الأنمي');

      db.prepare(
        'UPDATE users SET quiz_score = quiz_score + 1 WHERE id = ?'
      ).run(user.id);
    }

    return result.changes;
  });

  try {
    transaction();
  } catch (error) {
    console.error('Answer error:', error.message);
    return res.status(500).json({ error: 'تعذر تسجيل الإجابة.' });
  }

  session.current++;
  session.startedAt = Date.now();

  res.json({
    ok: true,
    next: true,
    finished: session.current >= session.questionIds.length
  });
});

// اختيار الفصيل.
app.post('/api/faction', requirePlayer, (req, res) => {
  const user = req.user;
  const faction = String(req.body.faction || '');

  if (!FACTIONS.includes(faction)) {
    return res.status(400).json({ error: 'الفصيل غير صالح.' });
  }

  const result = db.prepare(`
    UPDATE users SET faction = ?
    WHERE id = ? AND faction = ''
  `).run(faction, user.id);

  if (!result.changes) {
    return res.status(400).json({
      error: 'لقد اخترت فصيلك بالفعل.'
    });
  }

  res.json({ ok: true, faction });
});

// إرسال تحليل القضية.
app.post('/api/case/submit', requirePlayer, (req, res) => {
  const conclusion = String(req.body.conclusion || '').trim();

  if (conclusion.length < 20 || conclusion.length > 5000) {
    return res.status(400).json({
      error: 'اكتب تحليلًا من 20 إلى 5000 حرف.'
    });
  }

  const existing = db.prepare(
    'SELECT id FROM case_submissions WHERE user_id = ? LIMIT 1'
  ).get(req.user.id);

  if (existing) {
    return res.status(409).json({
      error: 'لقد أرسلت تحليلك بالفعل.'
    });
  }

  const result = db.prepare(
    'INSERT INTO case_submissions (user_id, conclusion) VALUES (?, ?)'
  ).run(req.user.id, conclusion);

  res.json({ ok: true, submissionId: result.lastInsertRowid });
});

// لوحة المتصدرين.
app.get('/api/leaderboard', (req, res) => {
  res.json({
    players: getLeaderboard(50),
    factions: getFactionScores()
  });
});

// ملخص الإدارة.
app.get('/api/admin/summary', requireAdmin, (req, res) => {
  const users = db.prepare(
    'SELECT COUNT(*) AS count FROM users'
  ).get().count;

  const submissions = db.prepare(
    'SELECT COUNT(*) AS count FROM case_submissions WHERE reviewed = 0'
  ).get().count;

  res.json({ users, submissions, factions: getFactionScores() });
});

// قائمة اللاعبين.
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, username, faction, points, quiz_score, created_at
    FROM users ORDER BY points DESC LIMIT 500
  `).all();

  res.json({ users });
});

// إرسال تقرير اللاعب إلى تيليجرام.
app.post('/api/admin/user-report', requireAdmin, async (req, res) => {
  const username = String(req.body.username || '').trim();

  if (!username) {
    return res.status(400).json({ error: 'اكتب اسم اللاعب.' });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE username = ?'
  ).get(username);

  if (!user) {
    return res.status(404).json({ error: 'اللاعب غير موجود.' });
  }

  const answers = db.prepare(`
    SELECT question_id, answer_index, correct, created_at
    FROM quiz_answers WHERE user_id = ? ORDER BY question_id
  `).all(user.id);

  const cases = db.prepare(`
    SELECT conclusion, score, reviewed, created_at
    FROM case_submissions WHERE user_id = ? ORDER BY id
  `).all(user.id);

  const logs = db.prepare(`
    SELECT amount, reason, created_at
    FROM point_logs WHERE user_id = ? ORDER BY id
  `).all(user.id);

  const answerMap = new Map(answers.map(a => [a.question_id, a]));
  const lines = [
    '📋 تقرير اللاعب - HUNTER SYSTEM',
    `الاسم: ${user.username}`,
    `رقم اللاعب: ${user.id}`,
    `الفصيل: ${user.faction || 'لم يختر بعد'}`,
    `النقاط: ${user.points}`,
    `الإجابات الصحيحة: ${user.quiz_score}`,
    `تاريخ التسجيل: ${user.created_at}`,
    '',
    '📝 إجابات الاختبار:'
  ];

  for (const q of QUESTIONS) {
    const a = answerMap.get(q.id);

    lines.push(
      `${q.id}. ${q.question}`,
      `الإجابة: ${a ? (a.answer_index === -1 ? 'انتهى الوقت' : q.options[a.answer_index] || 'غير معروفة') : 'لم يجب'}`,
      `النتيجة: ${a ? (a.correct ? 'صحيحة' : 'خطأ') : 'غير مسجلة'}`
    );
  }

  lines.push('', '🕵️ تحليلات القضية:');

  if (!cases.length) {
    lines.push('لا توجد تحليلات.');
  } else {
    cases.forEach((item, index) => {
      lines.push(
        `تحليل ${index + 1}:`,
        item.conclusion,
        `التقييم: ${item.reviewed ? item.score : 'لم تتم المراجعة'}`,
        `التاريخ: ${item.created_at}`,
        ''
      );
    });
  }

  lines.push('📊 سجل النقاط:');

  if (!logs.length) {
    lines.push('لا توجد حركة نقاط.');
  } else {
    logs.forEach(item => {
      lines.push(
        `+${item.amount} - ${item.reason} - ${item.created_at}`
      );
    });
  }

  const report = lines.join('\n');

  // تيليجرام يحد الرسائل النصية بطول 4096 حرفًا.
  // إذا كان التقرير طويلًا، أرسل أجزاء متتابعة.
  const sent = await sendTelegram(report);

  if (!sent) {
    return res.status(502).json({
      error: 'تعذر إرسال التقرير. راجع إعدادات تيليجرام.'
    });
  }

  res.json({
    ok: true,
    message: 'تم إرسال التقرير إلى تيليجرام.'
  });
});

// تقييم تحليل القضية وإضافة النقاط.
app.post('/api/admin/case-review', requireAdmin, (req, res) => {
  const submissionId = Number(req.body.submissionId);
  const score = Number(req.body.score);

  if (!Number.isInteger(submissionId) ||
      !Number.isInteger(score) || score < 0 || score > 100) {
    return res.status(400).json({ error: 'بيانات التقييم غير صحيحة.' });
  }

  const submission = db.prepare(`
    SELECT * FROM case_submissions
    WHERE id = ? AND reviewed = 0
  `).get(submissionId);

  if (!submission) {
    return res.status(404).json({
      error: 'التحليل غير موجود أو تمت مراجعته.'
    });
  }

  const transaction = db.transaction(() => {
    const result = db.prepare(`
      UPDATE case_submissions
      SET score = ?, reviewed = 1
      WHERE id = ? AND reviewed = 0
    `).run(score, submissionId);

    if (!result.changes) {
      throw new Error('تمت مراجعة هذا التحليل بالفعل.');
    }

    if (score > 0) {
      addPoints(submission.user_id, score, 'تقييم تحليل القضية');
    }
  });

  try {
    transaction();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// إضافة نقاط يدويًا.
app.post('/api/admin/add-points', requireAdmin, (req, res) => {
  const userId = Number(req.body.userId);
  const amount = Number(req.body.amount);
  const reason = String(req.body.reason || 'نقاط من الإدارة').slice(0, 200);

  if (!Number.isInteger(userId) ||
      !Number.isInteger(amount) ||
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
  console.log(`HUNTER SYSTEM running on port ${cfg.port}`);
});
