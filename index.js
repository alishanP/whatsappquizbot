// index.js
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { execFile } = require('child_process');
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

// Optional: force a specific Python in Docker
const PYTHON_BIN = process.env.PYTHON_BIN || '/opt/py/bin/python';

// ===== AWS S3 =====
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
});

async function uploadToS3(filePath, keyName) {
  const fileContent = fs.readFileSync(filePath);
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: keyName,
    Body: fileContent,
    ContentType: 'application/pdf',
  }));
  return `https://${S3_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${keyName}`;
}

// ===== CASE DATA =====
const ALL_CASES = require('./cases_big.json');

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
let currentCase = null;
let currentQuestionIndex = 0;
let acceptingAnswers = false;

// ===== PDF GENERATION =====
function generateCasePDF(caseObj, callback) {
  const tempJsonPath = path.join(__dirname, 'temp_case.json');
  fs.writeFileSync(tempJsonPath, JSON.stringify(caseObj, null, 2));

  const outDir = path.join(__dirname, 'pdfs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  execFile(
    PYTHON_BIN,
    [path.join(__dirname, 'case_pdf_generator.py'), tempJsonPath, '--out', outDir],
    (err, stdout, stderr) => {
      if (err) {
        console.error('PDF generation error:', stderr || err.message);
        return callback(err);
      }
      const generatedPath = (stdout || '').trim().split('\n').pop();
      if (!generatedPath || !fs.existsSync(generatedPath)) {
        return callback(new Error('PDF not generated'));
      }
      callback(null, generatedPath);
    }
  );
}

// ===== PICK NEXT CASE (filters out persisted used IDs) =====
function pickCaseForGroup(groupId) {
  const used = getUsedSet(groupId);
  const pool = ALL_CASES.filter(c => !used.has(c.case_id));
  if (pool.length === 0) return null;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

// ===== QUIZ FLOW =====
async function startNextCase(client, groupId, forUserId = null) {
  const next = pickCaseForGroup(groupId);
  if (!next) {
    await client.sendMessage(groupId, '🎉 We’ve run through all available cases for this group!\nUse *!resetcases* to start over.');
    return;
  }

  currentCase = next;
  currentQuestionIndex = 0;

  restrictToUser = !!forUserId;

  generateCasePDF(currentCase, async (err, pdfPath) => {
    if (err) {
      await client.sendMessage(groupId, `⚠️ Could not generate case PDF. Proceeding with questions.`);
      return sendCurrentQuestion(client, groupId);
    }

    try {
      const pdfKey = `cases/${currentCase.case_id}.pdf`;
      const pdfUrl = await uploadToS3(pdfPath, pdfKey);
      await client.sendMessage(groupId, `📄 *New Case:* ${currentCase.case_id}\nRead here: ${pdfUrl}`);
      markUsed(groupId, currentCase.case_id);
    } catch (e) {
      console.error('S3 upload error:', e);
      await client.sendMessage(groupId, `⚠️ Could not upload PDF to S3.`);
    }

    sendCurrentQuestion(client, groupId);
  });
}

async function sendCurrentQuestion(client, groupId) {
  const q = currentCase.questions[currentQuestionIndex];
  const message =
    `*Q${currentQuestionIndex + 1}:*\n${q.q}\n\n` +
    q.options.map((c, i) => `${String.fromCharCode(65 + i)}) ${c}`).join('\n');
  await client.sendMessage(groupId, message);
  acceptingAnswers = true;
}

async function endOfCase(client, groupId, userId) {
  // bump daily case counter + user's lifetime case count
  incrementDailyCases(groupId);
  bumpUserCaseCount(groupId, userId);
  // const stats = getDailyStats(groupId);
  // const sc = getUserScore(groupId, userId);
  // await client.sendMessage(
  //   groupId,
  //   `📦 *Case complete!*\n` +
  //   `• Cases done *today*: ${stats.today}\n` +
  //   `• Cases done *lifetime*: ${stats.lifetime}\n` +
  //   `• Your running score: *${sc.correct}/${sc.total}* (${sc.total ? Math.round((sc.correct/sc.total)*100) : 0}%)`
  // );
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
  if (!acceptingAnswers) return;

  // Restrict to target user if configured
  if (restrictToUser) {
    const senderId = (msg.author || '').toLowerCase();
    if (senderId !== TARGET_USER) return;
  }

  const q = currentCase.questions[currentQuestionIndex];
  const userAnswer = body.toLowerCase();
  const normalizedCorrect = q.answer.trim().toLowerCase();

  let chosenText = '';
  if (/^[a-d]$/.test(userAnswer)) {
    const idx = userAnswer.charCodeAt(0) - 97;
    chosenText = (q.options[idx] || '').trim().toLowerCase();
  } else {
    chosenText = userAnswer;
  }

  const userId = TARGET_USER; // single-user mode
  const sc = getUserScore(GROUP_ID, userId);

  // bump total answered
  sc.total = (sc.total || 0) + 1;

  if (chosenText === normalizedCorrect) {
    sc.correct = (sc.correct || 0) + 1;
    await msg.reply(`✅ Correct!\n\n💡 ${q.explanation}`);
  } else {
    await msg.reply(`❌ Incorrect. Correct answer: ${q.answer}.\n\n💡 ${q.explanation}`);
  }
  setUserScore(GROUP_ID, userId, sc);

  acceptingAnswers = false;

  // Move to next question / end of case
  if (currentQuestionIndex < currentCase.questions.length - 1) {
    currentQuestionIndex++;
    setTimeout(() => sendCurrentQuestion(client, GROUP_ID), 2500);
  } else {
    // finished a case
    await endOfCase(client, GROUP_ID, userId);
  }
});

client.initialize();