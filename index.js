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
    // CacheControl: 'public, max-age=31536000, immutable', // optional
  }));
  return `https://${S3_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${keyName}`;
}

// ===== CASE DATA =====
const ALL_CASES = require('./cases_big.json');

// ===== PERSISTED USED-CASE STORE =====
const DATA_DIR = path.join(__dirname, 'data');
const USED_PATH = path.join(DATA_DIR, 'used_cases.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadUsedStore() {
  try {
    return JSON.parse(fs.readFileSync(USED_PATH, 'utf8'));
  } catch {
    return {}; // { [groupId]: { used: ["case_id", ...] } }
  }
}
function saveUsedStore(store) {
  fs.writeFileSync(USED_PATH, JSON.stringify(store, null, 2));
}
function getUsedSet(groupId) {
  const store = loadUsedStore();
  return new Set(store[groupId]?.used || []);
}
function markUsed(groupId, caseId) {
  const store = loadUsedStore();
  store[groupId] = store[groupId] || { used: [] };
  if (!store[groupId].used.includes(caseId)) {
    store[groupId].used.push(caseId);
    saveUsedStore(store);
  }
}
function clearUsed(groupId) {
  const store = loadUsedStore();
  store[groupId] = { used: [] };
  saveUsedStore(store);
}

// ===== STATE =====
let restrictToUser = !!TARGET_USER;
let currentCase = null;
let currentQuestionIndex = 0;
let acceptingAnswers = false;
let scores = {};

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
    return endQuiz(client, groupId);
  }

  currentCase = next;
  currentQuestionIndex = 0;

  restrictToUser = !!forUserId;
  const answeringUser = forUserId ? ` (<@${forUserId}>)` : '';

  generateCasePDF(currentCase, async (err, pdfPath) => {
    if (err) {
      await client.sendMessage(groupId, `⚠️ Could not generate case PDF. Proceeding with questions.`);
      return sendCurrentQuestion(client, groupId);
    }

    try {
      const pdfKey = `cases/${currentCase.case_id}.pdf`;
      const pdfUrl = await uploadToS3(pdfPath, pdfKey);
      await client.sendMessage(groupId, `📄 *New Case:* ${currentCase.case_id}${answeringUser}\nRead here: ${pdfUrl}`);
      // Mark as used after posting
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

async function endQuiz(client, groupId) {
  let leaderboard = "🏆 *Scores so far:*\n";
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) leaderboard += "No scores yet.";
  else entries.forEach(([name, score], i) => (leaderboard += `${i + 1}. ${name} - ${score}\n`));
  await client.sendMessage(groupId, leaderboard);
}

// ===== WHATSAPP BOT =====
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, '.wwebjs_auth'),
  }),
  puppeteer: {
    executablePath: puppeteer.executablePath(), // bundled Chromium
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', async () => {
  console.log('✅ Bot is ready!');
  await startNextCase(client, GROUP_ID, TARGET_USER);
});

client.on('message', async msg => {
  if (msg.from !== GROUP_ID) return;

  const body = (msg.body || '').trim();

  // Admin commands
  if (body.toLowerCase() === '!resetcases') {
    clearUsed(GROUP_ID);
    await msg.reply('🔁 Case history cleared for this group. Starting fresh…');
    return startNextCase(client, GROUP_ID, TARGET_USER);
  }
  if (body.toLowerCase() === '!nextcase') {
    await msg.reply('⏭️ Skipping to next case…');
    return startNextCase(client, GROUP_ID, TARGET_USER);
  }

  // Regular answer handling
  if (!acceptingAnswers) return;

  // Restrict to target user (optional)
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

  const senderName = msg._data?.notifyName || msg.author || 'User';

  if (chosenText === normalizedCorrect) {
    scores[senderName] = (scores[senderName] || 0) + 1;
    await msg.reply(`✅ Correct, ${senderName}!\n\n💡 ${q.explanation}`);
  } else {
    await msg.reply(`❌ Incorrect, ${senderName}. Correct answer: ${q.answer}.\n\n💡 ${q.explanation}`);
  }

  acceptingAnswers = false;

  if (currentQuestionIndex < currentCase.questions.length - 1) {
    currentQuestionIndex++;
    setTimeout(() => sendCurrentQuestion(client, GROUP_ID), 2500);
  } else {
    setTimeout(() => startNextCase(client, GROUP_ID, TARGET_USER), 2500);
  }
});

client.initialize();