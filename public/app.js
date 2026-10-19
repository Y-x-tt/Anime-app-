const $ = (selector) => document.querySelector(selector);

let player = null;
let quizQuestions = [];
let quizIndex = 0;
let timerInterval = null;
let questionLocked = false;
let quizStarted = false;

function getDeviceId() {
let id = localStorage.getItem('hunterDeviceId');

if (!id) {
id = crypto.randomUUID();
localStorage.setItem('hunterDeviceId', id);
}

return id;
}

async function api(url, options = {}) {
const response = await fetch(url, {
...options,
headers: {
'Content-Type': 'application/json',
...(options.headers || {})
}
});

const data = await response.json().catch(() => ({}));

if (!response.ok) {
throw new Error(data.error || 'حدث خطأ. حاول مرة أخرى.');
}

return data;
}

function setStatus(selector, message) {
const element = $(selector);
if (element) element.textContent = message;
}

function factionName(faction) {
return ({
light: 'النور',
dark: 'الظلام',
immortals: 'الخالدون'
})[faction] || 'لم تختر';
}

function showPlayer() {
$('#loginScreen').classList.add('hidden');
$('#appScreen').classList.remove('hidden');
$('#playerBadge').classList.remove('hidden');
$('#playerBadge').textContent = "الصياد: ${player.username}";
updateStats();
loadLeaderboard();
}

async function updateStats() {
if (!player) return;

try {
const data = await api('/api/leaderboard');
const mine = data.players.find(p => p.username === player.username);

if (mine) {
  $('#playerPoints').textContent = mine.points;
  $('#playerFaction').textContent = factionName(mine.faction);
  player.faction = mine.faction;
  player.points = mine.points;
}

} catch (error) {
console.error(error);
}
}

$('#loginForm').addEventListener('submit', async (event) => {
event.preventDefault();

const username = $('#username').value.trim();
setStatus('#loginStatus', 'جاري الدخول...');

try {
const data = await api('/api/register', {
method: 'POST',
body: JSON.stringify({
username,
deviceId: getDeviceId()
})
});

player = data.user;
localStorage.setItem('hunterUsername', player.username);

showPlayer();

} catch (error) {
setStatus('#loginStatus', error.message);
}
});

document.querySelectorAll('[data-faction]').forEach(button => {
button.addEventListener('click', async () => {
if (!player) return;

try {
  const data = await api('/api/faction', {
    method: 'POST',
    body: JSON.stringify({
      username: player.username,
      faction: button.dataset.faction
    })
  });

  player.faction = data.faction;

  document.querySelectorAll('[data-faction]').forEach(item => {
    item.classList.toggle('selected', item === button);
    item.disabled = true;
  });

  setStatus('#factionStatus', `تم اختيار فصيل ${factionName(data.faction)}.`);
  updateStats();
  loadLeaderboard();
} catch (error) {
  setStatus('#factionStatus', error.message);
}

});
});

function showQuestion() {
clearInterval(timerInterval);
questionLocked = false;

if (quizIndex >= quizQuestions.length) {
$('#quizBox').classList.add('hidden');
$('#quizFinished').classList.remove('hidden');
$('#quizIntro').classList.add('hidden');
updateStats();
loadLeaderboard();
return;
}

const question = quizQuestions[quizIndex];

$('#quizBox').classList.remove('hidden');
$('#quizIntro').classList.add('hidden');
$('#quizFinished').classList.add('hidden');

$('#questionProgress').textContent =
"السؤال ${quizIndex + 1} من ${quizQuestions.length}";

$('#questionText').textContent = question.question;
$('#quizStatus').textContent = '';

const options = $('#answerOptions');
options.replaceChildren();

question.options.forEach((option, index) => {
const button = document.createElement('button');
button.className = 'answer-btn';
button.textContent = option;

button.addEventListener('click', () => submitAnswer(index));

options.appendChild(button);

});

let seconds = 15;
$('#timer').textContent = seconds;
$('#timerBar').style.width = '100%';

timerInterval = setInterval(() => {
seconds--;
$('#timer').textContent = Math.max(0, seconds);
$('#timerBar').style.width = "${Math.max(0, seconds) / 15 * 100}%";

if (seconds <= 0) {
  clearInterval(timerInterval);
  submitAnswer(-1);
}

}, 1000);
}

async function submitAnswer(answerIndex) {
if (questionLocked || !quizStarted) return;

questionLocked = true;
clearInterval(timerInterval);

document.querySelectorAll('.answer-btn').forEach(button => {
button.disabled = true;
});

const question = quizQuestions[quizIndex];

try {
await api('/api/quiz/answer', {
method: 'POST',
body: JSON.stringify({
username: player.username,
questionId: question.id,
answerIndex
})
});

// لا نعرض للاعب إن كانت الإجابة صحيحة أو خاطئة.
quizIndex++;

setTimeout(showQuestion, 350);

} catch (error) {
setStatus('#quizStatus', error.message);
questionLocked = false;
}
}

$('#startQuiz').addEventListener('click', async () => {
if (!player || quizStarted) return;

try {
const data = await api('/api/quiz/start', {
method: 'POST',
body: JSON.stringify({ username: player.username })
});

if (data.finished || !data.questions.length) {
  $('#quizIntro').classList.add('hidden');
  $('#quizFinished').classList.remove('hidden');
  return;
}

quizQuestions = data.questions;
quizIndex = 0;
quizStarted = true;

showQuestion();

} catch (error) {
setStatus('#quizStatus', error.message);
}
});

$('#caseForm').addEventListener('submit', async (event) => {
event.preventDefault();

const conclusion = $('#caseConclusion').value.trim();

setStatus('#caseStatus', 'جاري إرسال التحليل...');

try {
await api('/api/case/submit', {
method: 'POST',
body: JSON.stringify({
username: player.username,
conclusion
})
});

$('#caseConclusion').disabled = true;
$('#caseForm button').disabled = true;
setStatus('#caseStatus', 'تم إرسال تحليلك للمراجعة بنجاح.');

} catch (error) {
setStatus('#caseStatus', error.message);
}
});

async function loadLeaderboard() {
try {
const data = await api('/api/leaderboard');

const leaderboard = $('#leaderboard');
leaderboard.replaceChildren();

data.players.forEach((item, index) => {
  const row = document.createElement('div');
  row.className = 'rank-row';

  const name = document.createElement('strong');
  name.textContent = `${index + 1}. ${item.username}`;

  const points = document.createElement('span');
  points.className = 'rank-points';
  points.textContent = `${item.points} نقطة`;

  row.append(name, points);
  leaderboard.appendChild(row);
});

const factions = $('#factionScores');
factions.replaceChildren();

data.factions.forEach(item => {
  const row = document.createElement('div');
  row.className = 'rank-row';

  const name = document.createElement('strong');
  name.textContent = factionName(item.faction);

  const points = document.createElement('span');
  points.className = 'rank-points';
  points.textContent = `${item.points} نقطة`;

  row.append(name, points);
  factions.appendChild(row);
});

updateStats();

} catch (error) {
console.error(error);
}
}

$('#refreshLeaderboard').addEventListener('click', loadLeaderboard);

// استعادة تسجيل الدخول على نفس المتصفح.
async function restoreSession() {
const username = localStorage.getItem('hunterUsername');
if (!username) return;

try {
const data = await api('/api/register', {
method: 'POST',
body: JSON.stringify({
username,
deviceId: getDeviceId()
})
});

player = data.user;
showPlayer();

if (player.faction) {
  document.querySelectorAll('[data-faction]').forEach(button => {
    button.disabled = true;
    button.classList.toggle(
      'selected',
      button.dataset.faction === player.faction
    );
  });
}

} catch (error) {
console.error(error);
}
}

restoreSession();
