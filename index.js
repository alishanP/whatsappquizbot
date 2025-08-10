require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// If you deploy on Linux (VPS/Docker), make sure Chromium path is set:
// process.env.PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

// ===== S3 CONFIG (from .env) =====
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function uploadToS3(filePath, keyName) {
  const fileContent = fs.readFileSync(filePath);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: keyName,
    Body: fileContent,
    ContentType: 'application/pdf',
    // If using CloudFront or public bucket policy, no ACL needed.
    // If you want aggressive caching for static PDFs, uncomment:
    // CacheControl: 'public, max-age=31536000, immutable',
  }));
  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${keyName}`;
}

// ===== CONFIG =====
const groupId = process.env.WHATSAPP_GROUP_ID || '120363404016981513@g.us';
let restrictToUser = true;
let targetUser = process.env.WHATSAPP_TARGET_USER || '221487537590429@lid';

// Load cases JSON (case_data + questions)
const casesData = require('./cases_big.json'); // <- using big dataset
let unusedCases = [...casesData];
let usedCases = [];
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
    'python3',
    [path.join(__dirname, 'case_pdf_generator.py'), tempJsonPath, '--out', outDir],
    (err, stdout, stderr) => {
      if (err) {
        console.error('PDF generation error:', stderr);
        return callback(err);
      }
      const generatedPath = (stdout || '').trim().split('\n').pop();
      if (!generatedPath || !fs.existsSync(generatedPath)) {
        return callback(new Error('PDF not generated'));
      }
      // Optional: fs.unlinkSync(tempJsonPath);
      callback(null, generatedPath);
    }
  );
}

// ===== QUIZ FLOW =====
async function startNextCase(client, forUserId = null) {
  if (unusedCases.length === 0) {
    return endQuiz(client);
  }

  // Pick random case
  const randomIndex = Math.floor(Math.random() * unusedCases.length);
  currentCase = unusedCases.splice(randomIndex, 1)[0];
  usedCases.push(currentCase);
  currentQuestionIndex = 0;

  // Restrict answers if needed
  if (forUserId) {
    targetUser = forUserId;
    restrictToUser = true;
  } else {
    restrictToUser = false;
  }

  // Generate PDF
  generateCasePDF(currentCase, async (err, pdfPath) => {
    if (err) {
      await client.sendMessage(groupId, `⚠️ Could not generate case PDF.`);
      return sendCurrentQuestion(client);
    }

    try {
      const pdfKey = `cases/${currentCase.case_id}.pdf`;
      const pdfUrl = await uploadToS3(pdfPath, pdfKey);
      await client.sendMessage(groupId, `📄 *New Case:* ${currentCase.case_id}\nRead here: ${pdfUrl}`);
    } catch (e) {
      console.error('S3 upload error:', e);
      await client.sendMessage(groupId, `⚠️ Could not upload PDF to S3.`);
    }

    sendCurrentQuestion(client);
  });
}

async function sendCurrentQuestion(client) {
  const q = currentCase.questions[currentQuestionIndex];
  const message = `*Q${currentQuestionIndex + 1}:*\n${q.q}\n\n` +
    q.options.map((c, i) => `${String.fromCharCode(65 + i)}) ${c}`).join('\n');

  await client.sendMessage(groupId, message);
  acceptingAnswers = true;
}

async function endQuiz(client) {
  let leaderboard = "🏆 *Final Scores:*\n";
  Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, score], i) => {
      leaderboard += `${i + 1}. ${name} - ${score} points\n`;
    });
  await client.sendMessage(groupId, leaderboard || "No scores to show.");
}

// ===== WHATSAPP BOT =====
const client = new Client({
  authStrategy: new LocalAuth({
    // Persist session locally; mount this folder as a volume if using Docker
    dataPath: path.join(__dirname, '.wwebjs_auth'),
  }),
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', async () => {
  console.log('✅ Bot is ready!');
  await startNextCase(client, targetUser);
});

client.on('message', async msg => {
  if (msg.from !== groupId) return;
  if (!acceptingAnswers) return;

  // Restriction check
  if (restrictToUser) {
    const senderId = (msg.author || '').toLowerCase();
    if (senderId !== targetUser.toLowerCase()) {
      return;
    }
  }

  const q = currentCase.questions[currentQuestionIndex];
  const userAnswer = msg.body.trim().toLowerCase();
  const normalizedCorrect = q.answer.trim().toLowerCase();

  let chosenText = '';
  if (/^[a-d]$/.test(userAnswer)) {
    const idx = userAnswer.charCodeAt(0) - 97;
    chosenText = (q.options[idx] || '').trim().toLowerCase();
  } else {
    chosenText = userAnswer;
  }

  const sender = msg._data?.notifyName || msg.author || 'User';

  if (chosenText === normalizedCorrect) {
    scores[sender] = (scores[sender] || 0) + 1;
    await msg.reply(`✅ Correct, ${sender}!\n\n💡 ${q.explanation}`);
  } else {
    await msg.reply(`❌ Incorrect ${sender}, Correct Answer: ${q.answer}.\n\n💡 ${q.explanation}`);
  }

  acceptingAnswers = false;

  // Next question or next case
  if (currentQuestionIndex < currentCase.questions.length - 1) {
    currentQuestionIndex++;
    setTimeout(() => sendCurrentQuestion(client), 3000);
  } else {
    setTimeout(() => startNextCase(client, targetUser), 3000);
  }
});

client.initialize();