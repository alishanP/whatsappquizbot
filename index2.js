// index.js
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const puppeteer = require('puppeteer');
const mammoth = require('mammoth');

// ===== ENV =====
const GROUP_ID = process.env.WHATSAPP_GROUP_ID || '120363404016981513@g.us';
const TARGET_USER = (process.env.WHATSAPP_TARGET_USER || '221487537590429@lid').toLowerCase();

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

// Directory containing your .docx pairs like <id>_questions.docx and <id>_answers.docx
const CASES_DIR = process.env.CASES_DIR || path.join(__dirname, 'cases'); 

// ===== AWS S3 =====
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
});

async function uploadToS3(filePath, keyName, contentType = 'application/pdf') {
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

const USED_PATH = path.join(DATA_DIR, 'used_cases.json');                // { [groupId]: { used: [] } }
const SCORE_PATH = path.join(DATA_DIR, 'scores.json');                   // { [groupId]: { [userId]: { correct, total, lifetimeCases } } }
const DAILY_PATH = path.join(DATA_DIR, 'daily_cases.json');              // { [groupId]: { [YYYY-MM-DD]: number, lifetime: number } }

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
  return {
    today: d[groupId]?.[key] || 0,
    lifetime: d[groupId]?.lifetime || 0,
  };
}

// ===== STATE =====
let restrictToUser = !!TARGET_USER;
let currentCase = null; // { id, qDocPath, aDocPath, questions: [...], answersMap: {number:{letter,explanation?}}, qDocUrl, aDocUrl }
let currentQuestionIndex = 0;
let acceptingAnswers = false;

// ===== CASE DISCOVERY =====
function listAvailableCaseIds() {
  if (!fs.existsSync(CASES_DIR)) return [];
  const files = fs.readdirSync(CASES_DIR);
  const qDocs = files.filter(f => f.endsWith('_questions.docx'));
  // Ensure an answers doc exists too
  const ids = qDocs.map(f => f.replace('_questions.docx', ''))
    .filter(id => fs.existsSync(path.join(CASES_DIR, `${id}_answers.docx`)));
  return ids;
}

function pickCaseForGroup(groupId) {
  const used = getUsedSet(groupId);
  const ids = listAvailableCaseIds().filter(id => !used.has(id));
  if (ids.length === 0) return null;
  const idx = Math.floor(Math.random() * ids.length);
  const id = ids[idx];
  return {
    id,
    qDocPath: path.join(CASES_DIR, `${id}_questions.docx`),
    aDocPath: path.join(CASES_DIR, `${id}_answers.docx`),
  };
}

// ===== DOCX PARSING (exact to your format) =====
function parseQuestionsFromText(fullText) {
  const lines = fullText.replace(/\r/g, '').split('\n').map(s => s.trimEnd());
  const qHeader = /^Question\s+(\d+)\s*\/\s*(\d+)/i;

  // Find first "Question X / Y" (the question block starts there)
  let startIdx = lines.findIndex(l => qHeader.test(l));
  if (startIdx === -1) return [];

  const slice = lines.slice(startIdx);
  const questions = [];
  let i = 0;

  while (i < slice.length) {
    const m = slice[i].match(qHeader);
    if (!m) { i++; continue; }
    const number = parseInt(m[1], 10);
    i++;

    // Stem (until first option like 'a)')
    const stem = [];
    while (i < slice.length && !/^[a-e]\)/i.test(slice[i])) {
      if (slice[i].length) stem.push(slice[i]);
      i++;
    }

    // Options a) ... (up to 5, but accept 4)
    const options = [];
    while (i < slice.length && /^[a-e]\)/i.test(slice[i])) {
      const label = slice[i].slice(0, 2).toLowerCase(); // 'a)'
      const text = slice[i].slice(2).trim();            // keep raw; no “correct” tag here
      options.push({ label: label[0], text });
      i++;
    }

    if (stem.length && options.length >= 4) {
      questions.push({ number, stem: stem.join('\n'), options });
    }
  }

  // Ensure numeric order
  questions.sort((a, b) => a.number - b.number);
  return questions;
}

function parseAnswersFromText(ansText) {
  const lines = ansText.replace(/\r/g, '').split('\n').map(s => s.trimEnd());
  const qHeader = /^Question\s+(\d+)\s*\/\s*(\d+)/i;

  // Split into blocks by Question header
  const blocks = [];
  let cur = [];
  let curQ = null;
  for (const ln of lines) {
    const m = ln.match(qHeader);
    if (m) {
      if (curQ !== null) blocks.push({ q: curQ, lines: cur });
      curQ = parseInt(m[1], 10);
      cur = [ln];
    } else {
      cur.push(ln);
    }
  }
  if (curQ !== null) blocks.push({ q: curQ, lines: cur });

  const answers = {}; // { [qNum]: { letter, explanation } }
  for (const block of blocks) {
    // Find the correct option line: “… - Correct Answer”
    let correctLetter = null;
    let expStartIdx = -1;

    for (let i = 0; i < block.lines.length; i++) {
      const ln = block.lines[i];
      const opt = ln.match(/^([a-e])\)\s*(.+)$/i);
      if (opt && /\b-+\s*Correct\s*Answer\s*$/i.test(ln)) {
        correctLetter = opt[1].toLowerCase();
      }
      if (/^Explanation\s*:?/i.test(ln)) {
        expStartIdx = i + 1;
        // don’t break; we still want to scan all option lines above
      }
    }

    // Gather explanation text (everything after the “Explanation:” line)
    let explanation = '';
    if (expStartIdx >= 0) {
      explanation = block.lines.slice(expStartIdx).join('\n').trim();
    }

    if (block.q != null && correctLetter) {
      answers[block.q] = { letter: correctLetter, explanation };
    }
  }
  return answers;
}

// ===== QUIZ FLOW =====
async function startNextCase(client, groupId, forUserId = null) {
  const picked = pickCaseForGroup(groupId);
  if (!picked) {
    await client.sendMessage(groupId, '🎉 We’ve run through all available cases for this group!\nUse *!resetcases* to start over.');
    return;
  }

  restrictToUser = !!forUserId;

  // Parse docs
  let questionsText, answersText;
  try {
    questionsText = await docxToText(picked.qDocPath);
  } catch (e) {
    console.error('Failed to read questions docx:', e);
    await client.sendMessage(groupId, '⚠️ Could not read the questions document for this case.');
    return;
  }

  try {
    answersText = await docxToText(picked.aDocPath);
  } catch (e) {
    console.error('Failed to read answers docx:', e);
    await client.sendMessage(groupId, '⚠️ Could not read the answers document for this case.');
    return;
  }

  const questions = parseQuestionsFromText(questionsText);
  const answersMap = parseAnswersFromText(answersText);

  if (!questions.length) {
    await client.sendMessage(groupId, '⚠️ No questions were found at the bottom of the questions document.');
    return;
  }

  // Upload the questions docx so participants can read the case (top of doc)
  let qDocUrl = null;
  try {
    const key = `cases/${picked.id}_questions.docx`;
    qDocUrl = await uploadToS3(picked.qDocPath, key, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  } catch (e) {
    console.error('S3 upload (questions) error:', e);
  }

  currentCase = {
    id: picked.id,
    qDocPath: picked.qDocPath,
    aDocPath: picked.aDocPath,
    questions,
    answersMap,
    qDocUrl,
    aDocUrl: null,
  };
  currentQuestionIndex = 0;

  // Announce + link
  const header = `📄 *New Case:* ${currentCase.id}`;
  const readLine = currentCase.qDocUrl ? `Read here: ${currentCase.qDocUrl}` : `Questions document is ready (local).`;
  await client.sendMessage(groupId, `${header}\n${readLine}`);

  markUsed(groupId, currentCase.id);
  sendCurrentQuestion(client, groupId);
}

async function sendCurrentQuestion(client, groupId) {
  const q = currentCase.questions[currentQuestionIndex];

  const optionsText = q.options
    .map(o => `${o.label.toUpperCase()}) ${o.text}`)
    .join('\n');

  const message =
    `*Q${currentQuestionIndex + 1}:* (Question ${q.number})\n` +
    `${q.stem}\n\n${optionsText}\n\n` +
    `_Reply with A, B, C, D${q.options.length >= 5 ? ', or E' : ''}_`;

  await client.sendMessage(groupId, message);
  acceptingAnswers = true;
}

async function endOfCase(client, groupId, userId) {
  // bump daily case counter + user's lifetime case count
  incrementDailyCases(groupId);
  bumpUserCaseCount(groupId, userId);
  const stats = getDailyStats(groupId);

  // Upload and send the answers doc (with all explanations)
  if (!currentCase.aDocUrl) {
    try {
      const key = `cases/${currentCase.id}_answers.docx`;
      currentCase.aDocUrl = await uploadToS3(
        currentCase.aDocPath,
        key,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
    } catch (e) {
      console.error('S3 upload (answers) error:', e);
    }
  }

  const ansLine = currentCase.aDocUrl
    ? `🧠 *Explanations*: ${currentCase.aDocUrl}`
    : `🧠 Explanations document is ready (local).`;

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

  // Restrict to target user if configured
  if (restrictToUser) {
    const senderId = (msg.author || '').toLowerCase();
    if (senderId !== TARGET_USER) return;
  }

  const q = currentCase.questions[currentQuestionIndex];
  const userAnswer = body.toLowerCase();

  // normalize user input -> letter + text
  let chosenLetter = null;
  let chosenText = userAnswer;

  if (/^[a-e]$/.test(userAnswer)) {
    chosenLetter = userAnswer;
    const opt = q.options.find(o => o.label === chosenLetter);
    if (opt) chosenText = opt.text.toLowerCase();
  }

  // Lookup correct letter from answers doc; fall back to matching text if needed
  // In message handler, after we build `chosenLetter`:
const answerInfo = currentCase.answersMap[q.number];
const correctLetter = answerInfo?.letter;

let isCorrect = false;
if (correctLetter && chosenLetter) {
  isCorrect = (chosenLetter === correctLetter);
} else if (correctLetter && !chosenLetter) {
  const correctOpt = q.options.find(o => o.label === correctLetter);
  isCorrect = !!correctOpt && (chosenText.trim().toLowerCase() === correctOpt.text.trim().toLowerCase());
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
