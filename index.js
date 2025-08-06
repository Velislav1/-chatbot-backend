require('dotenv').config();
const mongoose = require('mongoose');
const Lead = require('./Lead');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const upload = multer({ storage: multer.memoryStorage() });
const sessionStore = {};
const axios = require('axios');
const express = require('express');
const { OpenAI } = require('openai');
const cors = require('cors');
const fs = require('fs');

const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/ctytwgql3xuidx21h1d2tz8uy49gvvd6';
const CALENDLY_LINK = 'https://calendly.com/viliokaized';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let uploadedPdfText = '';
let knowledgeBase = '';

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

console.log('MONGODB_URI:', process.env.MONGODB_URI);

// Upload PDF and parse text
app.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const data = await pdfParse(req.file.buffer);
    uploadedPdfText = data.text;
    res.json({ message: '✅ PDF uploaded and processed successfully.' });
  } catch (err) {
    console.error('❌ Error parsing PDF:', err);
    res.status(500).json({ error: 'Failed to process PDF' });
  }
});

function extractLeadData(message, leads) {
  const emailMatch = message.match(/\b[\w.-]+@[\w.-]+\.\w+\b/);
  const phoneMatch = message.match(/\+?\d[\d\s\-().]{7,}/);
  const nameMatch = message.match(/(?:my name is|it's|i am|i'm)\s+([a-zA-Z\s]+)/i);

  if (emailMatch && !leads.email) leads.email = emailMatch[0];
  if (phoneMatch && !leads.phone) leads.phone = phoneMatch[0];
  if (nameMatch && !leads.name) leads.name = nameMatch[1].trim();

  const insuranceTypes = ['auto', 'health', 'life', 'home', 'commercial'];
  for (let type of insuranceTypes) {
    if (message.toLowerCase().includes(type) && !leads.type) {
      leads.type = type;
    }
  }
}

function needsMoreInfo(leads) {
  return !leads.name || !leads.email || !leads.phone || !leads.type;
}

function getNextMissingField(leads) {
  if (!leads.name) return 'name';
  if (!leads.email) return 'email';
  if (!leads.phone) return 'phone';
  if (!leads.type) return 'type';
  return null;
}

function getFieldQuestion(field) {
  const questions = {
    name: 'May I have your full name?',
    email: 'Could you share your email address?',
    phone: "What's the best phone number to reach you?",
    type: 'What type of insurance do you need? (auto, health, life, home)'
  };
  return questions[field];
}

async function sendLeadsToMake(leads) {
  try {
    await axios.post(MAKE_WEBHOOK_URL, leads);
    console.log('✅ Lead sent to Make.com');
  } catch (error) {
    console.error('❌ Failed to send lead:', error.message);
  }
}

async function loadKnowledgeBase() {
  try {
    const file1 = fs.readFileSync('./documents for base/first.pdf');
    const file2 = fs.readFileSync('./documents for base/second.pdf');
    const data1 = await pdfParse(file1);
    const data2 = await pdfParse(file2);
    knowledgeBase = data1.text + '\n\n' + data2.text;
    console.log('✅ Knowledge base loaded');
  } catch (err) {
    console.error('❌ Error loading PDFs:', err);
  }
}

loadKnowledgeBase();

async function answerFromKnowledgeBase(question, fullName, email, phone) {
  // 🔒 Ако вече имаме всичко – не викай GPT, върни завършен отговор
  if (fullName && email && phone) {
    return "✅ Thank you! You're all set. A licensed agent will contact you soon. You can also book a meeting or ask more questions here.";
  }

  // 🧠 Стандартна GPT логика, ако липсват данни
  const prompt = `You are a helpful assistant. Answer the user's question based only on the following insurance knowledge base.
If the answer is not found in the text, say "I'm not sure about that – you may want to ask an agent."

Knowledge Base:
""" 
${knowledgeBase}
"""
Question: ${question}
Answer:`.trim();

  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'system', content: prompt }]
  });

  return response.choices[0].message.content.trim();
}
app.post('/chat', async (req, res) => {
 const { question, sessionId } = req.body;
if (!question || !sessionId) return res.status(400).json({ message: "Missing question or sessionId" });

if (!sessionStore[sessionId]) sessionStore[sessionId] = {};
let leads = sessionStore[sessionId];
const { fullName, email, phone } = leads;

  if (leads.booked) {
    delete leads.booked;
    return res.json({ message: "✅ Your meeting has been booked! What else would you like to ask?" });
  }

  extractLeadData(question, leads);
  if (leads.lastAsked && leads[leads.lastAsked]) delete leads.lastAsked;

  if (/book|meeting|schedule|appointment/i.test(question.toLowerCase())) {
    return res.json({
      message: `📅 Schedule a meeting with a Prime Insurance Agent: <a href="${CALENDLY_LINK}" target="_blank">Book now</a>`
    });
  }

  let justSent = false;
  if (!leads.sent && !needsMoreInfo(leads)) {
    try {
      await sendLeadsToMake(leads);
      leads.sent = true;
      justSent = true;
      await Lead.create(leads);
      console.log('✅ Lead saved to MongoDB');
    } catch (err) {
      return res.json({ message: '❌ Error sending to Make: ' + err.message });
    }
  }

  let gptResponse = '';
  if (leads.sent && !needsMoreInfo(leads)) {
    const kbAnswer = await answerFromKnowledgeBase(question);
    gptResponse = kbAnswer || "✅ You're all set! Feel free to ask more questions.";
  } else if (!leads.sent && needsMoreInfo(leads)) {
    const missingField = getNextMissingField(leads);
    leads.lastAsked = missingField;
    gptResponse = getFieldQuestion(missingField);
  } else if (justSent) {
    gptResponse = `✅ Thank you! Your information has been received.\n\nWould you like to:\n1️⃣ Continue with more questions\n2️⃣ <a href="${CALENDLY_LINK}" target="_blank">📅 Book a meeting with an agent</a>`;
  } else {
    const gptPrompt = 'You are an insurance assistant. Be friendly. Collect: full name, email, phone, and insurance type (auto, health, life, home). Ask one question at a time. Use short, polite answers. And answer user questions.';

    const chat = await openai.chat.completions.create({
      model: 'gpt-4',
      max_tokens: 150,
      temperature: 0.7,
      messages: [
        { role: 'system', content: gptPrompt },
        { role: 'user', content: question }
      ]
    });

    gptResponse = chat.choices[0].message.content;

    if (gptResponse.toLowerCase().includes("i'm not sure") || gptResponse.length < 20) {
      const kbAnswer = await answerFromKnowledgeBase(question);
      if (kbAnswer && !kbAnswer.includes("you may want to ask an agent")) {
        gptResponse = kbAnswer;
      }
    }
  }

  return res.json({ message: gptResponse });
});

app.post('/calendly-booked', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && sessionStore[sessionId]) {
    sessionStore[sessionId].booked = true;
    console.log(`✅ Booking confirmed for session: ${sessionId}`);
    return res.status(200).json({ message: 'Booking saved in session.' });
  }
  res.status(400).json({ message: 'Missing or invalid sessionId.' });
});

app.listen(3000, () => {
  console.log('🚀 GPT bot is listening on http://localhost:3000');
});

