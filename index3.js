// index.js
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const puppeteer = require('puppeteer');

// ===== ENV =====
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

// ===== GROUP CONFIG =====
// Multiple groups live here:
const GROUPS_CONFIG_PATH = path.join(__dirname, 'groups.json');
if (!fs.existsSync(GROUPS_CONFIG_PATH)) {
  console.error('❌ Missing groups.json. Create it with an array of { group_id, allowed_users?, cases_dir? }');
  process.exit(1);
}
const GROUPS = JSON.parse(fs.readFileSync(GROUPS_CONFIG_PATH, 'utf8'));
// Useful map for quick lookup
const GROUP_MAP = new Map(GROUPS.map(g => [g.group_id, g]));

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

// ===== PERSISTED STORES (shared) =====
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
  if (!userId) return;
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
  return `${yyyy}-${mm}-${dd}`; // UTC day bucket
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

// ===== PER-GROUP STATE =====
/**
 * groupState[groupId] = {
 *   accepting: boolean,
 *   currentCase: {
 *     id, qPdfPath, aPdfPath, questions: [{number, stem, options: [{label,text}]}], answersMap, qPdfUrl, aPdfUrl
 *   },
 *   currentQuestionIndex: number,
 *   lastResponderId: string | null
 * }
 */
const groupState = new Map();

// ===== CASE DISCOVERY (per-group cases_dir) =====
function listAvailableCaseIds(casesDir) {
  if (!fs.existsSync(casesDir)) return [];
  const files = fs.readdirSync(casesDir);
  const ids = files
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/,''))
    .filter(id =>
      fs.existsSync(path.join(casesDir, `${id}_questions.pdf`)) &&
      fs.existsSync(path.join(casesDir, `${id}_answers.pdf`))
    );
  return ids;
}

function pickCaseForGroup(groupId) {
  const cfg = GROUP_MAP.get(groupId);
  if (!cfg) return null;
  const casesDir = cfg.cases_dir ? path.resolve(__dirname, cfg.cases_dir) : path.join(__dirname, 'cases');

  const used = getUsedSet(groupId);
  const pool = listAvailableCaseIds(casesDir).filter(id => !used.has(id));
  if (pool.length === 0) return null;
  const id = pool[Math.floor(Math.random() * pool.length)];

  return {
    id,
    casesDir,
    jsonPath: path.join(casesDir, `${id}.json`),
    qPdfPath: path.join(casesDir, `${id}_questions.pdf`),
    aPdfPath: path.join(casesDir, `${id}_answers.pdf`),
  };
}

// ===== QUIZ FLOW =====
async function startNextCase(client, groupId) {
  const picked = pickCaseForGroup(groupId);
  if (!picked) {
    await client.sendMessage(groupId, '🎉 All cases exhausted for this group. Use *!resetcases* to start over.');
    return;
  }

  // Load JSON
  let caseJson;
  try {
    caseJson = JSON.parse(fs.readFileSync(picked.jsonPath, 'utf8'));
  } catch (e) {
    console.error(`[${groupId}] Failed to read case JSON:`, e);
    await client.sendMessage(groupId, '⚠️ Could not read the case JSON.');
    return;
  }

  // Build questions & answers
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

  // Upload questions PDF
  let qPdfUrl = null;
  try {
    const key = `cases/${picked.id}_questions.pdf`;
    qPdfUrl = await uploadToS3(picked.qPdfPath, key, 'application/pdf');
  } catch (e) {
    console.error(`[${groupId}] S3 upload (questions) error:`, e);
  }

  // Init group state
  groupState.set(groupId, {
    accepting: false,
    currentCase: {
      id: picked.id,
      qPdfPath: picked.qPdfPath,
      aPdfPath: picked.aPdfPath,
      questions,
      answersMap,
      qPdfUrl,
      aPdfUrl: null,
    },
    currentQuestionIndex: 0,
    lastResponderId: null,
  });

  await client.sendMessage(
    groupId,
    `📄 *New Case:* ${picked.id}\n` +
    (qPdfUrl ? `Read here: ${qPdfUrl}` : `Questions PDF is ready (local).`)
  );

  markUsed(groupId, picked.id);
  await sendCurrentQuestion(client, groupId);
}

function promptSuffixFromOptions(options) {
  if (!options || options.length === 0) return '';
  const letters = options.map(o => o.label.toUpperCase());
  if (letters.length === 1) return `_Reply with ${letters[0]}_`;
  return `_Reply with ${letters.slice(0, -1).join(', ')}, or ${letters[letters.length - 1]}_`;
}

async function sendCurrentQuestion(client, groupId) {
  const st = groupState.get(groupId);
  if (!st) return;

  const q = st.currentCase.questions[st.currentQuestionIndex];
  const optionsText = q.options.map(o => `${o.label.toUpperCase()}) ${o.text}`).join('\n');

  const msg =
    `*Q${st.currentQuestionIndex + 1}:* (Question ${q.number})\n` +
    `${q.stem}\n\n${optionsText}\n\n${promptSuffixFromOptions(q.options)}`;

  await client.sendMessage(groupId, msg);
  st.accepting = true;
}

async function endOfCase(client, groupId) {
  const st = groupState.get(groupId);
  if (!st) return;

  // bump daily + last responder's case count
  incrementDailyCases(groupId);
  if (st.lastResponderId) bumpUserCaseCount(groupId, st.lastResponderId);

  // upload answers PDF (once)
  if (!st.currentCase.aPdfUrl) {
    try {
      const key = `cases/${st.currentCase.id}_answers.pdf`;
      st.currentCase.aPdfUrl = await uploadToS3(st.currentCase.aPdfPath, key, 'application/pdf');
    } catch (e) {
      console.error(`[${groupId}] S3 upload (answers) error:`, e);
    }
  }

  const stats = getDailyStats(groupId);
  await client.sendMessage(
    groupId,
    `📦 *Case complete!*\n` +
    `• Cases done *today*: ${stats.today}\n` +
    `• Cases done *lifetime*: ${stats.lifetime}\n\n` +
    (st.currentCase.aPdfUrl ? `🧠 *Explanations*: ${st.currentCase.aPdfUrl}` : `🧠 Answers PDF is ready (local).`)
  );

  // next case
  setTimeout(() => startNextCase(client, groupId), 2500);
}

// ===== WHATSAPP BOT =====
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: { executablePath: puppeteer.executablePath(), args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', async () => {
  console.log('✅ Bot is ready!');
  // Kick off one case in every configured group
  for (const g of GROUPS) {
    await startNextCase(client, g.group_id);
  }
});

client.on('message', async msg => {
  const groupId = msg.from;
  const senderId = (msg.author || '').toLowerCase();

  // Only handle groups present in groups.json
  if (!GROUP_MAP.has(groupId)) return;

  const cfg = GROUP_MAP.get(groupId);
  const st = groupState.get(groupId);
  const body = (msg.body || '').trim();

  // Commands (group-scoped)
  if (body.toLowerCase() === '!resetcases') {
    clearUsed(groupId);
    await msg.reply('🔁 Case history cleared for this group. Starting fresh…');
    return startNextCase(client, groupId);
  }
  if (body.toLowerCase() === '!nextcase') {
    await msg.reply('⏭️ Skipping to next case…');
    return startNextCase(client, groupId);
  }
  if (body.toLowerCase() === '!score') {
    const sc = getUserScore(groupId, senderId);
    const stats = getDailyStats(groupId);
    return msg.reply(
      `📊 *Your Score*: ${sc.correct}/${sc.total} (${sc.total ? Math.round((sc.correct/sc.total)*100) : 0}%)\n` +
      `📦 *Cases today*: ${stats.today} | *Lifetime*: ${stats.lifetime}\n` +
      `🗂 *Your lifetime cases*: ${sc.lifetimeCases || 0}`
    );
  }

  // Ignore if not taking answers now
  if (!st || !st.accepting) return;

  // If allow-list exists, enforce it
  const allow = Array.isArray(cfg.allowed_users) ? cfg.allowed_users.map(u => u.toLowerCase()) : null;
  if (allow && allow.length > 0 && !allow.includes(senderId)) {
    return; // not an allowed answerer for this group
  }

  // Validate answer
  const q = st.currentCase.questions[st.currentQuestionIndex];
  const allowedLetters = new Set(q.options.map(o => o.label)); // labels are lowercase
  let chosenLetter = null;
  let chosenText = body.toLowerCase();

  if (/^[a-z]{1,2}$/.test(chosenText) && allowedLetters.has(chosenText)) {
    chosenLetter = chosenText;
    const opt = q.options.find(o => o.label === chosenLetter);
    if (opt) chosenText = (opt.text || '').toLowerCase();
  }

  const answerInfo = st.currentCase.answersMap[q.number];
  const correctLetter = answerInfo?.letter;
  const correctOpt = correctLetter ? q.options.find(o => o.label === correctLetter) : null;

  let isCorrect = false;
  if (correctLetter && chosenLetter) {
    isCorrect = (chosenLetter === correctLetter);
  } else if (correctOpt) {
    isCorrect = (chosenText.trim() === (correctOpt.text || '').toLowerCase().trim());
  }

  // Update per-user score (in this group)
  const sc = getUserScore(groupId, senderId);
  sc.total = (sc.total || 0) + 1;
  if (isCorrect) sc.correct = (sc.correct || 0) + 1;
  setUserScore(groupId, senderId, sc);

  st.lastResponderId = senderId; // credit this user as last responder for the case

  // Reply
  if (isCorrect) {
    await msg.reply(`✅ Correct!`);
  } else {
    await msg.reply(`❌ Incorrect. Correct answer: ${correctLetter ? correctLetter.toUpperCase() : '?'}.`);
  }

  // Advance
  st.accepting = false;
  if (st.currentQuestionIndex < st.currentCase.questions.length - 1) {
    st.currentQuestionIndex++;
    setTimeout(() => sendCurrentQuestion(client, groupId), 2000);
  } else {
    await endOfCase(client, groupId);
  }
});

client.initialize();