require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

// DESTINATARI INTERNI
const OFFICINA_NUMBERS = ['whatsapp:+393287377675'];
const GENERAL_NUMBERS = [
  'whatsapp:+393472733226',
  'whatsapp:+393494040073'
];

// FILE SESSIONI
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const SESSION_TIMEOUT_MS = 1000 * 60 * 60 * 6; // 6 ore

// ----------------------
// GESTIONE SESSIONI
// ----------------------
function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return {};
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.error('Errore caricamento sessioni:', error.message);
    return {};
  }
}

function saveSessions(sessions) {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (error) {
    console.error('Errore salvataggio sessioni:', error.message);
  }
}

let sessions = loadSessions();

function cleanupSessions() {
  const now = Date.now();
  let changed = false;

  for (const key of Object.keys(sessions)) {
    if (!sessions[key]?.updatedAt || now - sessions[key].updatedAt > SESSION_TIMEOUT_MS) {
      delete sessions[key];
      changed = true;
    }
  }

  if (changed) saveSessions(sessions);
}

setInterval(cleanupSessions, 10 * 60 * 1000);

function getSession(from, profileName = 'Cliente') {
  cleanupSessions();

  if (!sessions[from]) {
    sessions[from] = {
      from,
      profileName,
      flow: null,
      step: null,
      data: {},
      updatedAt: Date.now()
    };
    saveSessions(sessions);
  }

  sessions[from].profileName = profileName || sessions[from].profileName || 'Cliente';
  sessions[from].updatedAt = Date.now();
  saveSessions(sessions);

  return sessions[from];
}

function resetSession(from) {
  delete sessions[from];
  saveSessions(sessions);
}

function setFlow(session, flow, firstStep) {
  session.flow = flow;
  session.step = firstStep;
  session.data = {};
  session.updatedAt = Date.now();
  sessions[session.from] = session;
  saveSessions(sessions);
}

function updateSession(session) {
  session.updatedAt = Date.now();
  sessions[session.from] = session;
  saveSessions(sessions);
}

// ----------------------
// UTIL
// ----------------------
function normalizeText(text) {
  return (text || '').trim().toLowerCase();
}

function mainMenu() {
  return (
    "Ciao 👋 benvenuto in DP\n\n" +
    "Seleziona il servizio:\n" +
    "🔧 Officina\n" +
    "🚐 Noleggio\n" +
    "🚗 Vendita\n" +
    "🚛 Trasporto\n\n" +
    "Scrivi il servizio che ti interessa."
  );
}

function detectIntent(text) {
  const msg = normalizeText(text);

  if (
    msg.includes('officina') ||
    msg.includes('tagliando') ||
    msg.includes('freni') ||
    msg.includes('diagnosi') ||
    msg.includes('riparazione') ||
    msg.includes('meccanico')
  ) {
    return 'officina';
  }

  if (
    msg.includes('noleggio') ||
    msg.includes('affitto') ||
    msg.includes('furgone') ||
    msg.includes('auto a noleggio')
  ) {
    return 'noleggio';
  }

  if (
    msg.includes('vendita') ||
    msg.includes('comprare') ||
    msg.includes('acquistare') ||
    msg.includes('auto usata')
  ) {
    return 'vendita';
  }

  if (
    msg.includes('trasporto') ||
    msg.includes('bisarca') ||
    msg.includes('ritiro auto') ||
    msg.includes('consegna auto')
  ) {
    return 'trasporto';
  }

  return 'generico';
}

function getRecipientsByFlow(flow) {
  if (flow === 'officina') return OFFICINA_NUMBERS;
  return GENERAL_NUMBERS;
}

// ----------------------
// NOTIFICHE INTERNE
// ----------------------
async function sendInternalNotification(numbers, text, incomingFrom) {
  for (const to of numbers) {
    if (to === incomingFrom) {
      console.log(`Salto invio verso stesso numero: ${to}`);
      continue;
    }

    try {
      const result = await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to,
        body: text
      });
      console.log(`Notifica inviata a ${to}: ${result.sid}`);
    } catch (error) {
      console.error(`Errore invio notifica a ${to}:`, error.message);
    }
  }
}

// ----------------------
// RIEPILOGO INTERNO
// ----------------------
function buildInternalSummary(session) {
  const name = session.profileName || 'Cliente';
  const from = session.from || '';
  const d = session.data || {};

  if (session.flow === 'officina') {
    return (
      "🔔 NUOVA RICHIESTA OFFICINA\n\n" +
      `👤 Cliente: ${name}\n` +
      `📞 Numero: ${from}\n` +
      `🚗 Veicolo: ${d.veicolo || '-'}\n` +
      `🔢 Targa: ${d.targa || '-'}\n` +
      `📊 Km: ${d.km || '-'}\n` +
      `🔧 Intervento: ${d.intervento || '-'}\n` +
      `📅 Preferenza: ${d.preferenza || '-'}`
    );
  }

  if (session.flow === 'noleggio') {
    return (
      "🔔 NUOVA RICHIESTA NOLEGGIO\n\n" +
      `👤 Cliente: ${name}\n` +
      `📞 Numero: ${from}\n` +
      `🚐 Mezzo richiesto: ${d.mezzo || '-'}\n` +
      `📅 Data inizio: ${d.dataInizio || '-'}\n` +
      `⏱ Giorni: ${d.giorni || '-'}\n` +
      `📏 Km previsti: ${d.km || '-'}\n` +
      `📦 Utilizzo: ${d.utilizzo || '-'}`
    );
  }

  if (session.flow === 'vendita') {
    return (
      "🔔 NUOVA RICHIESTA VENDITA AUTO\n\n" +
      `👤 Cliente: ${name}\n` +
      `📞 Numero: ${from}\n` +
      `🚗 Tipo auto: ${d.tipoAuto || '-'}\n` +
      `💰 Budget: ${d.budget || '-'}\n` +
      `⚙️ Preferenze: ${d.preferenze || '-'}\n` +
      `🔁 Permuta: ${d.permuta || '-'}\n` +
      `📝 Note: ${d.note || '-'}`
    );
  }

  if (session.flow === 'trasporto') {
    return (
      "🔔 NUOVA RICHIESTA TRASPORTO AUTO\n\n" +
      `👤 Cliente: ${name}\n` +
      `📞 Numero: ${from}\n` +
      `🚗 Veicolo: ${d.veicolo || '-'}\n` +
      `📍 Ritiro: ${d.ritiro || '-'}\n` +
      `📍 Consegna: ${d.consegna || '-'}\n` +
      `📅 Quando: ${d.data || '-'}\n` +
      `📝 Note: ${d.note || '-'}`
    );
  }

  return `👤 Cliente: ${name}\n📞 Numero: ${from}`;
}

async function finalizeFlow(session) {
  const summary = buildInternalSummary(session);
  const recipients = getRecipientsByFlow(session.flow);
  await sendInternalNotification(recipients, summary, session.from);
}

// ----------------------
// AVVIO FLOW
// ----------------------
function startFlow(session, flow) {
  if (flow === 'officina') {
    setFlow(session, 'officina', 'veicolo');
    return (
      "🔧 Officina DP\n\n" +
      "Perfetto, ti faccio alcune domande veloci.\n\n" +
      "1️⃣ Che veicolo è? (marca e modello)\n\n" +
      "Per ricominciare scrivi MENU."
    );
  }

  if (flow === 'noleggio') {
    setFlow(session, 'noleggio', 'mezzo');
    return (
      "🚐 Noleggio DP\n\n" +
      "Perfetto, ti faccio alcune domande veloci.\n\n" +
      "1️⃣ Che mezzo ti serve? (auto, furgone, altro)\n\n" +
      "Per ricominciare scrivi MENU."
    );
  }

  if (flow === 'vendita') {
    setFlow(session, 'vendita', 'tipoAuto');
    return (
      "🚗 Vendita Auto DP\n\n" +
      "Perfetto, ti faccio alcune domande veloci.\n\n" +
      "1️⃣ Che tipo di auto stai cercando?\n\n" +
      "Per ricominciare scrivi MENU."
    );
  }

  if (flow === 'trasporto') {
    setFlow(session, 'trasporto', 'veicolo');
    return (
      "🚛 Trasporto Auto DP\n\n" +
      "Perfetto, ti faccio alcune domande veloci.\n\n" +
      "1️⃣ Che veicolo dobbiamo trasportare?\n\n" +
      "Per ricominciare scrivi MENU."
    );
  }

  return mainMenu();
}

// ----------------------
// FLOW OFFICINA
// ----------------------
async function handleOfficina(session, message) {
  const d = session.data;

  if (session.step === 'veicolo') {
    d.veicolo = message;
    session.step = 'targa';
    updateSession(session);
    return "2️⃣ Targa del veicolo?";
  }

  if (session.step === 'targa') {
    d.targa = message;
    session.step = 'km';
    updateSession(session);
    return "3️⃣ Km attuali del veicolo?";
  }

  if (session.step === 'km') {
    d.km = message;
    session.step = 'intervento';
    updateSession(session);
    return "4️⃣ Che intervento devi fare?";
  }

  if (session.step === 'intervento') {
    d.intervento = message;
    session.step = 'preferenza';
    updateSession(session);
    return "5️⃣ Quando preferisci? (giorno / mattina / pomeriggio)";
  }

  if (session.step === 'preferenza') {
    d.preferenza = message;
    updateSession(session);
    await finalizeFlow(session);
    resetSession(session.from);
    return "✅ Perfetto, richiesta officina registrata. Ti ricontatteremo a breve.";
  }

  return "Scrivi MENU per ricominciare.";
}

// ----------------------
// FLOW NOLEGGIO
// ----------------------
async function handleNoleggio(session, message) {
  const d = session.data;

  if (session.step === 'mezzo') {
    d.mezzo = message;
    session.step = 'dataInizio';
    updateSession(session);
    return "2️⃣ Da quando ti serve?";
  }

  if (session.step === 'dataInizio') {
    d.dataInizio = message;
    session.step = 'giorni';
    updateSession(session);
    return "3️⃣ Per quanti giorni ti serve?";
  }

  if (session.step === 'giorni') {
    d.giorni = message;
    session.step = 'km';
    updateSession(session);
    return "4️⃣ Quanti km pensi di fare circa?";
  }

  if (session.step === 'km') {
    d.km = message;
    session.step = 'utilizzo';
    updateSession(session);
    return "5️⃣ Per che utilizzo ti serve?";
  }

  if (session.step === 'utilizzo') {
    d.utilizzo = message;
    updateSession(session);
    await finalizeFlow(session);
    resetSession(session.from);
    return "✅ Perfetto, richiesta noleggio registrata. Ti ricontatteremo a breve.";
  }

  return "Scrivi MENU per ricominciare.";
}

// ----------------------
// FLOW VENDITA
// ----------------------
async function handleVendita(session, message) {
  const d = session.data;

  if (session.step === 'tipoAuto') {
    d.tipoAuto = message;
    session.step = 'budget';
    updateSession(session);
    return "2️⃣ Qual è il budget indicativo?";
  }

  if (session.step === 'budget') {
    d.budget = message;
    session.step = 'preferenze';
    updateSession(session);
    return "3️⃣ Hai preferenze particolari? (diesel, benzina, ibrida, automatico...)";
  }

  if (session.step === 'preferenze') {
    d.preferenze = message;
    session.step = 'permuta';
    updateSession(session);
    return "4️⃣ Hai un usato da dare in permuta? (sì / no)";
  }

  if (session.step === 'permuta') {
    d.permuta = message;
    session.step = 'note';
    updateSession(session);
    return "5️⃣ Altre richieste o note utili?";
  }

  if (session.step === 'note') {
    d.note = message;
    updateSession(session);
    await finalizeFlow(session);
    resetSession(session.from);
    return "✅ Perfetto, richiesta vendita registrata. Ti ricontatteremo a breve.";
  }

  return "Scrivi MENU per ricominciare.";
}

// ----------------------
// FLOW TRASPORTO
// ----------------------
async function handleTrasporto(session, message) {
  const d = session.data;

  if (session.step === 'veicolo') {
    d.veicolo = message;
    session.step = 'ritiro';
    updateSession(session);
    return "2️⃣ Luogo di ritiro?";
  }

  if (session.step === 'ritiro') {
    d.ritiro = message;
    session.step = 'consegna';
    updateSession(session);
    return "3️⃣ Luogo di consegna?";
  }

  if (session.step === 'consegna') {
    d.consegna = message;
    session.step = 'data';
    updateSession(session);
    return "4️⃣ Quando ti serve il trasporto?";
  }

  if (session.step === 'data') {
    d.data = message;
    session.step = 'note';
    updateSession(session);
    return "5️⃣ Note utili? (marciante / non marciante / urgenza)";
  }

  if (session.step === 'note') {
    d.note = message;
    updateSession(session);
    await finalizeFlow(session);
    resetSession(session.from);
    return "✅ Perfetto, richiesta trasporto registrata. Ti ricontatteremo a breve.";
  }

  return "Scrivi MENU per ricominciare.";
}

// ----------------------
// WEBHOOK
// ----------------------
app.post('/whatsapp', async (req, res) => {
  const incomingText = (req.body.Body || '').trim();
  const incomingFrom = req.body.From || '';
  const profileName = req.body.ProfileName || 'Cliente';
  const normalized = normalizeText(incomingText);
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    if (!process.env.TWILIO_ACCOUNT_SID) throw new Error('TWILIO_ACCOUNT_SID mancante');
    if (!process.env.TWILIO_AUTH_TOKEN) throw new Error('TWILIO_AUTH_TOKEN mancante');
    if (!TWILIO_WHATSAPP_NUMBER) throw new Error('TWILIO_WHATSAPP_NUMBER mancante');

    const session = getSession(incomingFrom, profileName);

    // MENU / RESET
    if (
      normalized === 'menu' ||
      normalized === 'start' ||
      normalized === 'inizio' ||
      normalized === 'ciao' ||
      normalized === 'salve' ||
      normalized === 'buona sera' ||
      normalized === 'buonasera'
    ) {
      resetSession(incomingFrom);
      twiml.message(mainMenu());
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    // FLOW ATTIVO
    if (session.flow === 'officina') {
      twiml.message(await handleOfficina(session, incomingText));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.flow === 'noleggio') {
      twiml.message(await handleNoleggio(session, incomingText));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.flow === 'vendita') {
      twiml.message(await handleVendita(session, incomingText));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.flow === 'trasporto') {
      twiml.message(await handleTrasporto(session, incomingText));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    // NUOVO INTENTO
    const intent = detectIntent(incomingText);

    if (intent === 'officina') {
      twiml.message(startFlow(session, 'officina'));
    } else if (intent === 'noleggio') {
      twiml.message(startFlow(session, 'noleggio'));
    } else if (intent === 'vendita') {
      twiml.message(startFlow(session, 'vendita'));
    } else if (intent === 'trasporto') {
      twiml.message(startFlow(session, 'trasporto'));
    } else {
      twiml.message(
        "Ciao 👋 benvenuto in DP\n\n" +
        "Seleziona il servizio:\n" +
        "🔧 Officina\n" +
        "🚐 Noleggio\n" +
        "🚗 Vendita\n" +
        "🚛 Trasporto\n\n" +
        "Scrivi il servizio che ti interessa."
      );
    }

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  } catch (error) {
    console.error('Errore generale:', error.message);
    twiml.message("Ciao 👋 abbiamo ricevuto il tuo messaggio. Ti ricontatteremo al più presto.");
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
