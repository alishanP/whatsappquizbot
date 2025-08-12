// index.js
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const puppeteer = require('puppeteer');

// ===== ENV =====
const GROUP_ID = process.env.WHATSAPP_GROUP_ID || '120363404016981513@g.us';
const TARGET_USER = (process.env.WHATSAPP_TARGET_USER || '221487537590429@lid').toLowerCase();

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

// Directory containing your triplets: <id>.json, <id>_questions.pdf, <id>_answers.pdf
const CASES_DIR = process.env.CASES_DIR || path.join(__dirname, 'cases');

// ===== AWS S3 =====
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
});

async function uploadToS3(filePath, keyName, contentType = 'application/octet-stream') {
  const fileContent = fs.readFileSync(filePath);
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: keyName,
    Body: fileContent,
    ContentType: contentType,
  }));
  return `https://${S3_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${keyName}`;
}

// ===== PERSISTED STORES =====
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USED_PATH  = path.join(DATA_DIR, 'used_cases.json');   // { [groupId]: { used: [] } }
const SCORE_PATH = path.join(DATA_DIR, 'scores.json');       // { [groupId]: { [userId]: { correct, total, lifetimeCases } } }
const DAILY_PATH = path.join(DATA_DIR, 'daily_cases.json');  // { [groupId]: { [YYYY-MM-DD]: number, lifetime: number } }

function loadJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } }
function saveJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

// ---- used cases
function getUsedSet(groupId) {
  const store = loadJson(USED_PATH);
  return new Set(store[groupId]?.used || []);
}
function markUsed(groupId, caseId) {
  const store = loadJson(USED_PATH);
  store[groupId] = store[groupId] || { used: [] };
  if (!store[groupId].used.includes(caseId)) {
    store[groupId].used.push(caseId);
    saveJson(USED_PATH, store);
  }
}
function clearUsed(groupId) {
  const store = loadJson(USED_PATH);
  store[groupId] = { used: [] };
  saveJson(USED_PATH, store);
}

// ---- scores per user (persisted)
function getUserScore(groupId, userId) {
  const s = loadJson(SCORE_PATH);
  s[groupId] = s[groupId] || {};
  s[groupId][userId] = s[groupId][userId] || { correct: 0, total: 0, lifetimeCases: 0 };
  return s[groupId][userId];
}
function setUserScore(groupId, userId, val) {
  const s = loadJson(SCORE_PATH);
  s[groupId] = s[groupId] || {};
  s[groupId][userId] = val;
  saveJson(SCORE_PATH, s);
}
function bumpUserCaseCount(groupId, userId) {
  const sc = getUserScore(groupId, userId);
  sc.lifetimeCases = (sc.lifetimeCases || 0) + 1;
  setUserScore(groupId, userId, sc);
}

// ---- cases per day (persisted)
function todayStamp() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`; // UTC date bucket
}
function incrementDailyCases(groupId) {
  const d = loadJson(DAILY_PATH);
  d[groupId] = d[groupId] || { lifetime: 0 };
  const key = todayStamp();
  d[groupId][key] = (d[groupId][key] || 0) + 1;
  d[groupId].lifetime = (d[groupId].lifetime || 0) + 1;
  saveJson(DAILY_PATH, d);
}
function getDailyStats(groupId) {
  const d = loadJson(DAILY_PATH);
  const key = todayStamp();
  return { today: d[groupId]?.[key] || 0, lifetime: d[groupId]?.lifetime || 0 };
}

// ===== STATE =====
let restrictToUser = !!TARGET_USER;
let currentCase = null; // { id, qPdfPath, aPdfPath, questions, answersMap, qPdfUrl, aPdfUrl }
let currentQuestionIndex = 0;
let acceptingAnswers = false;

// ===== CASE DISCOVERY =====
function listAvailableCaseIds() {
  if (!fs.existsSync(CASES_DIR)) return [];
  const files = fs.readdirSync(CASES_DIR);

  // require triplets: <id>.json + <id>_questions.pdf + <id>_answers.pdf
  const ids = files
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/,''))
    .filter(id =>
      fs.existsSync(path.join(CASES_DIR, `${id}_questions.pdf`)) &&
      fs.existsSync(path.join(CASES_DIR, `${id}_answers.pdf`))
    );

  return ids;
}

function pickCaseForGroup(groupId) {
  const used = getUsedSet(groupId);
  const ids = listAvailableCaseIds().filter(id => !used.has(id));
  if (ids.length === 0) return null;
  const id = ids[Math.floor(Math.random() * ids.length)];
  return {
    id,
    jsonPath: path.join(CASES_DIR, `${id}.json`),
    qPdfPath: path.join(CASES_DIR, `${id}_questions.pdf`),
    aPdfPath: path.join(CASES_DIR, `${id}_answers.pdf`),
  };
}

// ===== QUIZ FLOW =====
async function startNextCase(client, groupId, forUserId = null) {
  const picked = pickCaseForGroup(groupId);
  if (!picked) {
    await client.sendMessage(groupId, '🎉 We’ve run through all available cases for this group!\nUse *!resetcases* to start over.');
    return;
  }

  restrictToUser = !!forUserId;

  // Load JSON (source of truth)
  let caseJson;
  try {
    const raw = fs.readFileSync(picked.jsonPath, 'utf8');
    caseJson = JSON.parse(raw);
  } catch (e) {
    console.error('Failed to read case JSON:', e);
    await client.sendMessage(groupId, '⚠️ Could not read the case JSON.');
    return;
  }

  // Build questions & answersMap
  const questions = (caseJson.questions || []).map(q => ({
    number: q.number,
    stem: q.stem,
    options: (q.options || []).map(o => ({ label: (o.label || '').toLowerCase(), text: o.text || '' })),
  }));

  const answersMap = {};
  for (const q of caseJson.questions || []) {
    answersMap[q.number] = { letter: (q.answer || '').toLowerCase(), explanation: q.explanation || '' };
  }

  if (!questions.length) {
    await client.sendMessage(groupId, '⚠️ No questions found in the case JSON.');
    return;
  }

  // Upload the questions PDF so participants can read the case (full details)
  let qPdfUrl = null;
  try {
    const key = `cases/${picked.id}_questions.pdf`;
    qPdfUrl = await uploadToS3(
      picked.qPdfPath,
      key,
      'application/pdf'
    );
  } catch (e) {
    console.error('S3 upload (questions) error:', e);
  }

  currentCase = {
    id: picked.id,
    qPdfPath: picked.qPdfPath,
    aPdfPath: picked.aPdfPath,
    questions,
    answersMap,
    qPdfUrl,
    aPdfUrl: null,
  };
  currentQuestionIndex = 0;

  // Announce + link
  const header = `📄 *New Case:* ${currentCase.id}`;
  const readLine = currentCase.qPdfUrl ? `Read here: ${currentCase.qPdfUrl}` : `Questions PDF is ready (local).`;
  await client.sendMessage(groupId, `${header}\n${readLine}`);

  markUsed(groupId, currentCase.id);
  sendCurrentQuestion(client, groupId);
}

function promptSuffixFromOptions(options) {
  // Build “Reply with A, B, C, …, or F”
  if (!options || options.length === 0) return '';
  const letters = options.map(o => o.label.toUpperCase());
  if (letters.length === 1) return `_Reply with ${letters[0]}_`;
  return `_Reply with ${letters.slice(0, -1).join(', ')}, or ${letters[letters.length - 1]}_`;
}

async function sendCurrentQuestion(client, groupId) {
  const q = currentCase.questions[currentQuestionIndex];

  const optionsText = q.options
    .map(o => `${o.label.toUpperCase()}) ${o.text}`)
    .join('\n');

  const message =
    `*Q${currentQuestionIndex + 1}:* (Question ${q.number})\n` +
    `${q.stem}\n\n${optionsText}\n\n` +
    `${promptSuffixFromOptions(q.options)}`;

  await client.sendMessage(groupId, message);
  acceptingAnswers = true;
}

async function endOfCase(client, groupId, userId) {
  // bump daily case counter + user's lifetime case count
  incrementDailyCases(groupId);
  bumpUserCaseCount(groupId, userId);
  const stats = getDailyStats(groupId);

  // Upload and send the answers PDF (with all explanations)
  if (!currentCase.aPdfUrl) {
    try {
      const key = `cases/${currentCase.id}_answers.pdf`;
      currentCase.aPdfUrl = await uploadToS3(
        currentCase.aPdfPath,
        key,
        'application/pdf'
      );
    } catch (e) {
      console.error('S3 upload (answers) error:', e);
    }
  }

  const ansLine = currentCase.aPdfUrl
    ? `🧠 *Explanations*: ${currentCase.aPdfUrl}`
    : `🧠 Answers PDF is ready (local).`;

  await client.sendMessage(
    groupId,
    `📦 *Case complete!*\n` +
    `• Cases done *today*: ${stats.today}\n` +
    `• Cases done *lifetime*: ${stats.lifetime}\n\n` +
    `${ansLine}`
  );

  // move on
  setTimeout(() => startNextCase(client, groupId, TARGET_USER), 2500);
}

async function endQuiz(client, groupId) {
  const stats = getDailyStats(groupId);
  await client.sendMessage(groupId, `🏁 Quiz ended.\nCases today: ${stats.today} • Lifetime: ${stats.lifetime}`);
}

// ===== WHATSAPP BOT =====
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: { executablePath: puppeteer.executablePath(), args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', async () => {
  console.log('✅ Bot is ready!');
  await startNextCase(client, GROUP_ID, TARGET_USER);
});

client.on('message', async msg => {
  if (msg.from !== GROUP_ID) return;

  const body = (msg.body || '').trim();

  // Admin/utility commands
  if (body.toLowerCase() === '!resetcases') {
    clearUsed(GROUP_ID);
    await msg.reply('🔁 Case history cleared for this group. Starting fresh…');
    return startNextCase(client, GROUP_ID, TARGET_USER);
  }
  if (body.toLowerCase() === '!nextcase') {
    await msg.reply('⏭️ Skipping to next case…');
    return startNextCase(client, GROUP_ID, TARGET_USER);
  }
  if (body.toLowerCase() === '!score') {
    const sc = getUserScore(GROUP_ID, TARGET_USER);
    const stats = getDailyStats(GROUP_ID);
    return msg.reply(
      `📊 *Your Score*: ${sc.correct}/${sc.total} (${sc.total ? Math.round((sc.correct/sc.total)*100) : 0}%)\n` +
      `📦 *Cases today*: ${stats.today} | *Lifetime*: ${stats.lifetime}\n` +
      `🗂 *Your lifetime cases*: ${sc.lifetimeCases || 0}`
    );
  }

  // Answer handling
  if (!acceptingAnswers || !currentCase) return;

  // Restrict to target user if configured (group messages expose msg.author)
  if (restrictToUser) {
    const senderId = (msg.author || '').toLowerCase();
    if (senderId !== TARGET_USER) return;
  }

  const q = currentCase.questions[currentQuestionIndex];
  const userAnswer = body.toLowerCase();

  // Allowed letters are dynamic based on options length
  const allowedLetters = new Set(q.options.map(o => o.label)); // labels already lowercased
  let chosenLetter = null;
  let chosenText = userAnswer;

  // if user sends a single letter that exists in options, accept it
  if (/^[a-z]{1,2}$/.test(userAnswer) && allowedLetters.has(userAnswer)) {
    chosenLetter = userAnswer;
    const opt = q.options.find(o => o.label === chosenLetter);
    if (opt) chosenText = (opt.text || '').toLowerCase();
  }

  const userId = TARGET_USER;                 // single-user mode
  const sc = getUserScore(GROUP_ID, userId);  // fetch persisted score
  sc.total = (sc.total || 0) + 1;

  // Lookup correct letter from answers map
  const answerInfo = currentCase.answersMap[q.number];
  const correctLetter = answerInfo?.letter;

  let isCorrect = false;
  if (correctLetter && chosenLetter) {
    isCorrect = (chosenLetter === correctLetter);
  } else if (correctLetter && !chosenLetter) {
    const correctOpt = q.options.find(o => o.label === correctLetter);
    isCorrect = !!correctOpt && (chosenText.trim() === (correctOpt.text || '').toLowerCase().trim());
  }

  if (isCorrect) {
    sc.correct = (sc.correct || 0) + 1;
    await msg.reply(`✅ Correct!`);
  } else {
    await msg.reply(`❌ Incorrect. Correct answer: ${correctLetter ? correctLetter.toUpperCase() : '?'}.`);
  }

  setUserScore(GROUP_ID, userId, sc);
  acceptingAnswers = false;

  // Move to next question / end of case
  if (currentQuestionIndex < currentCase.questions.length - 1) {
    currentQuestionIndex++;
    setTimeout(() => sendCurrentQuestion(client, GROUP_ID), 2000);
  } else {
    await endOfCase(client, GROUP_ID, userId);
  }
});

client.initialize();