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

loadKnowledgeBase();

async function loadKnowledgeBase() {
  try {
  if (!fs.existsSync('./documents_for_base')) {
  console.error('❌ Folder documents_for_base does not exist!');
  return;
}

    const file1 = fs.readFileSync('./documents_for_base/first.pdf');
    const file2 = fs.readFileSync('./documents_for_base/second.pdf');
    const data1 = await pdfParse(file1);
    const data2 = await pdfParse(file2);
    knowledgeBase = data1.text + '\n\n' + data2.text;
    console.log('✅ Knowledge base loaded');
  } catch (err) {
    console.error('❌ Error loading PDFs:', err);
  }
}



async function answerFromKnowledgeBase(question, fullName, email, phone) {
  // 🔒 Ако вече имаме всичко – не викай GPT, върни завършен отговор
  if (fullName && email && phone) {
    return "✅ Thank you! You're all set. A licensed agent will contact you soon. You can also book a meeting or ask more questions here.\n\n💬 How else can I help you today?";
  }

  // 🧠 Стандартна GPT логика, ако липсват данни
  const gptPrompt = `
You are Prime, a smart and friendly virtual insurance agent.
Your job is to help users, collect their contact info (full name, email, phone, type of insurance), and answer questions clearly.

Speak like a real human: short sentences, warm tone, not robotic.
Always thank the user after each message.
Only ask one question at a time.
If the user already gave some info, don’t ask again.

If you don’t know something, politely say so.
When answering, be kind and professional – like a real insurance expert.

Always end your response with:
💬 How else can I help you today?

Keep responses under 2–3 sentences.

Knowledge Base:
${knowledgeBase}

Question: ${question}
Answer:`;


  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'system', content: prompt }]
  });

  // ✅ Добавяме благодарност + follow-up
  return `${response.choices[0].message.content.trim()}\n\n🙏 Thank you for your question! 💬 How else can I help you today?`;
}
app.post('/chat', async (req, res) => {
  const { q: question, sessionId } = req.body;

  if (!question || !sessionId)
    return res.status(400).json({ messages: [{ type: 'bot', content: "❌ Missing question or sessionId" }] });

  if (!sessionStore[sessionId]) {
    sessionStore[sessionId] = {
      step: 'collect_name',
      booked: false,
      messages: [],
      data: {
        name: '',
        email: '',
        phone: '',
        type: ''
      }
    };
  }

  const leads = sessionStore[sessionId];

  // ✅ Booking confirmed
  if (leads.booked) {
    delete leads.booked;
    return res.json({
      messages: [
        { type: 'bot', content: "✅ Your meeting has been booked!" },
        { type: 'bot', content: "💬 What else would you like to ask?" }
      ]
    });
  }

  extractLeadData(question, leads.data);
  leads.messages.push({ role: 'user', content: question });

  if (leads.lastAsked && leads.data[leads.lastAsked]) delete leads.lastAsked;

  const missingField = getNextMissingField(leads.data);

  if (!missingField) {
    const answer = await answerFromKnowledgeBase(
      question,
      leads.data.name,
      leads.data.email,
      leads.data.phone
    );

    return res.json({
      messages: [
        { type: 'bot', content: answer }
      ]
    });
  }

  // 📅 Booking intent
  if (/book|meeting|schedule|appointment/i.test(question.toLowerCase())) {
    return res.json({
      messages: [
        {
          type: 'bot',
          content: `📅 Schedule a meeting with a Prime Insurance Agent: <a href="${CALENDLY_LINK}" target="_blank">Book now</a>`
        },
        { type: 'bot', content: "💬 Would you like help with anything else?" }
      ]
    });
  }

  let justSent = false;

  if (!leads.sent && !needsMoreInfo(leads.data)) {
    try {
      await sendLeadsToMake(leads.data);
      leads.sent = true;
      justSent = true;
      await Lead.create(leads.data);
      console.log('✅ Lead saved to MongoDB');
    } catch (err) {
      return res.json({
        messages: [
          { type: 'bot', content: '❌ Error sending to Make: ' + err.message }
        ]
      });
    }
  }

  let gptResponse = '';

  if (leads.sent && !needsMoreInfo(leads.data)) {
    const kbAnswer = await answerFromKnowledgeBase(question);
    gptResponse = kbAnswer || "✅ You're all set! Feel free to ask more questions.";
  } else if (!leads.sent && needsMoreInfo(leads.data)) {
    const missingField = getNextMissingField(leads.data);
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

    gptResponse = chat.choices[0].message.content.trim();

    const endings = [
      "💬 How else can I assist you today?",
      "🙏 Feel free to ask anything else!",
      "🎀 Would you like to know something more?",
      "🤖 I'm here to help. What's next?"
    ];

    if (
      !gptResponse.toLowerCase().includes("how else can i help") &&
      !gptResponse.toLowerCase().includes("what else can i do for you")
    ) {
      const randomEnding = endings[Math.floor(Math.random() * endings.length)];
      gptResponse += `\n\n${randomEnding}`;
    }
  }

  leads.messages.push({ role: 'assistant', content: gptResponse });

  return res.json({
    messages: [
      { type: 'bot', content: gptResponse }
    ]
  });
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
