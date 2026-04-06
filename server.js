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

// NUMERI INTERNI
const OFFICINA_NUMBERS = ['whatsapp:+393287377675'];
const GENERAL_NUMBERS = [
  'whatsapp:+393472733226',
  'whatsapp:+393494040073'
];

// SESSIONI SU FILE, UNA PER NUMERO
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const SESSION_TIMEOUT_MS = 1000 * 60 * 60 * 6; // 6 ore

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ----------------------
// UTIL
// ----------------------
function normalizeText(text) {
  return (text || '').trim().toLowerCase();
}

function mainMenu() {
  return (
    "Ciao 👋 Benvenuto in DP.\n\n" +
    "Per aiutarti più velocemente, scegli il servizio che ti interessa:\n\n" +
    "🔧 Officina\n" +
    "🚐 Noleggio\n" +
    "🚗 Vendita Auto\n" +
    "🚛 Trasporto Auto\n\n" +
    "Scrivi pure il servizio che ti serve."
  );
}

function restartHint() {
  return "\n\nPer ricominciare in qualsiasi momento scrivi MENU.";
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
  ) return 'officina';

  if (
    msg.includes('noleggio') ||
    msg.includes('affitto') ||
    msg.includes('furgone') ||
    msg.includes('auto a noleggio')
  ) return 'noleggio';

  if (
    msg.includes('vendita') ||
    msg.includes('comprare') ||
    msg.includes('acquistare') ||
    msg.includes('auto usata')
  ) return 'vendita';

  if (
    msg.includes('trasporto') ||
    msg.includes('bisarca') ||
    msg.includes('ritiro auto') ||
    msg.includes('consegna auto')
  ) return 'trasporto';

  return 'generico';
}

function getRecipientsByFlow(flow) {
  if (flow === 'officina') return OFFICINA_NUMBERS;
  return GENERAL_NUMBERS;
}

function sanitizeKey(from) {
  return String(from || '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_');
}

function getSessionFile(from) {
  return path.join(SESSIONS_DIR, `${sanitizeKey(from)}.json`);
}

// ----------------------
// SESSIONI
// ----------------------
function loadSession(from) {
  try {
    const file = getSessionFile(from);
    if (!fs.existsSync(file)) return null;

    const raw = fs.readFileSync(file, 'utf8');
    if (!raw) return null;

    const session = JSON.parse(raw);

    if (!session.updatedAt || Date.now() - session.updatedAt > SESSION_TIMEOUT_MS) {
      fs.unlinkSync(file);
      return null;
    }

    return session;
  } catch (error) {
    console.error('Errore loadSession:', error.message);
    return null;
  }
}

function saveSession(session) {
  try {
    const file = getSessionFile(session.from);
    session.updatedAt = Date.now();
    fs.writeFileSync(file, JSON.stringify(session, null, 2), 'utf8');
  } catch (error) {
    console.error('Errore saveSession:', error.message);
  }
}

function createSession(from, profileName = 'Cliente') {
  const session = {
    from,
    profileName,
    flow: null,
    step: null,
    data: {},
    updatedAt: Date.now()
  };
  saveSession(session);
  return session;
}

function getSession(from, profileName = 'Cliente') {
  let session = loadSession(from);

  if (!session) {
    session = createSession(from, profileName);
  } else {
    session.profileName = profileName || session.profileName || 'Cliente';
    saveSession(session);
  }

  return session;
}

function resetSession(from) {
  try {
    const file = getSessionFile(from);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (error) {
    console.error('Errore resetSession:', error.message);
  }
}

function setFlow(session, flow, firstStep) {
  session.flow = flow;
  session.step = firstStep;
  session.data = {};
  saveSession(session);
}

function updateSession(session) {
  saveSession(session);
}

// ----------------------
// NOTIFICHE
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
      `⏱ Durata: ${d.giorni || '-'}\n` +
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
      `📅 Data richiesta: ${d.data || '-'}\n` +
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
      "Perfetto, ti faccio qualche domanda veloce così possiamo organizzare al meglio la tua richiesta.\n\n" +
      "1️⃣ Che veicolo è? (marca e modello)" +
      restartHint()
    );
  }

  if (flow === 'noleggio') {
    setFlow(session, 'noleggio', 'mezzo');
    return (
      "🚐 Noleggio DP\n\n" +
      "Perfetto, ti faccio qualche domanda veloce per trovare il mezzo più adatto alle tue esigenze.\n\n" +
      "1️⃣ Che mezzo ti serve? (auto, furgone, altro)" +
      restartHint()
    );
  }

  if (flow === 'vendita') {
    setFlow(session, 'vendita', 'tipoAuto');
    return (
      "🚗 Vendita Auto DP\n\n" +
      "Perfetto, ti faccio qualche domanda veloce così possiamo proporti la soluzione più adatta.\n\n" +
      "1️⃣ Che tipo di auto stai cercando?" +
      restartHint()
    );
  }

  if (flow === 'trasporto') {
    setFlow(session, 'trasporto', 'veicolo');
    return (
      "🚛 Trasporto Auto DP\n\n" +
      "Perfetto, ti faccio qualche domanda veloce per preparare correttamente la richiesta di trasporto.\n\n" +
      "1️⃣ Che veicolo dobbiamo trasportare?" +
      restartHint()
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
    return "2️⃣ Perfetto. Mi indichi la targa del veicolo?";
  }

  if (session.step === 'targa') {
    d.targa = message;
    session.step = 'km';
    updateSession(session);
    return "3️⃣ Grazie. Quanti km ha attualmente il veicolo?";
  }

  if (session.step === 'km') {
    d.km = message;
    session.step = 'intervento';
    updateSession(session);
    return "4️⃣ Che intervento desideri effettuare? (tagliando, diagnosi, freni, riparazione, altro)";
  }

  if (session.step === 'intervento') {
    d.intervento = message;
    session.step = 'preferenza';
    updateSession(session);
    return "5️⃣ Quando preferisci essere contattato o fissare l’appuntamento? (giorno / mattina / pomeriggio)";
  }

  if (session.step === 'preferenza') {
    d.preferenza = message;
    updateSession(session);
    await finalizeFlow(session);
    resetSession(session.from);

    return (
      "✅ Perfetto, abbiamo registrato la tua richiesta per l’officina.\n\n" +
      "Un nostro operatore ti ricontatterà al più presto per conferma e organizzazione dell’intervento."
    );
  }

  return "Per favore scrivi MENU per ricominciare.";
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
    return "2️⃣ Da quando ti serve il mezzo?";
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
    return "4️⃣ Quanti km pensi di fare indicativamente?";
  }

  if (session.step === 'km') {
    d.km = message;
    session.step = 'utilizzo';
    updateSession(session);
    return "5️⃣ Per quale utilizzo ti serve? (lavoro, trasloco, viaggio, altro)";
  }

  if (session.step === 'utilizzo') {
    d.utilizzo = message;
    updateSession(session);
    await finalizeFlow(session);
    resetSession(session.from);

    return (
      "✅ Perfetto, abbiamo registrato la tua richiesta di noleggio.\n\n" +
      "Ti ricontatteremo al più presto con disponibilità e informazioni utili."
    );
  }

  return "Per favore scrivi MENU per ricominciare.";
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
    return "2️⃣ Qual è il budget indicativo che hai in mente?";
  }

  if (session.step === 'budget') {
    d.budget = message;
    session.step = 'preferenze';
    updateSession(session);
    return "3️⃣ Hai preferenze particolari? (diesel, benzina, ibrida, automatico, SUV, utilitaria, altro)";
  }

  if (session.step === 'preferenze') {
    d.preferenze = message;
    session.step = 'permuta';
    updateSession(session);
    return "4️⃣ Hai un veicolo da dare eventualmente in permuta? (sì / no)";
  }

  if (session.step === 'permuta') {
    d.permuta = message;
    session.step = 'note';
    updateSession(session);
    return "5️⃣ Hai altre richieste o note utili da segnalarci?";
  }

  if (session.step === 'note') {
    d.note = message;
    updateSession(session);
    await finalizeFlow(session);
    resetSession(session.from);

    return (
      "✅ Perfetto, abbiamo registrato la tua richiesta per la vendita auto.\n\n" +
      "Ti ricontatteremo al più presto con le proposte più adatte."
    );
  }

  return "Per favore scrivi MENU per ricominciare.";
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
    return "2️⃣ Da dove deve essere ritirato il veicolo?";
  }

  if (session.step === 'ritiro') {
    d.ritiro = message;
    session.step = 'consegna';
    updateSession(session);
    return "3️⃣ Dove deve essere consegnato il veicolo?";
  }

  if (session.step === 'consegna') {
    d.consegna = message;
    session.step = 'data';
    updateSession(session);
    return "4️⃣ Quando ti servirebbe il trasporto?";
  }

  if (session.step === 'data') {
    d.data = message;
    session.step = 'note';
    updateSession(session);
    return "5️⃣ Hai note utili da indicarci? (marciante / non marciante / urgenza / altro)";
  }

  if (session.step === 'note') {
    d.note = message;
    updateSession(session);
    await finalizeFlow(session);
    resetSession(session.from);

    return (
      "✅ Perfetto, abbiamo registrato la tua richiesta di trasporto.\n\n" +
      "Ti ricontatteremo al più presto per conferma e organizzazione del servizio."
    );
  }

  return "Per favore scrivi MENU per ricominciare.";
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

    console.log('--- NUOVO MESSAGGIO ---');
    console.log('From:', incomingFrom);
    console.log('Body:', incomingText);
    console.log('Flow:', session.flow);
    console.log('Step:', session.step);

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

    // SE C'È UN FLOW ATTIVO, GESTISCO SOLO QUELLO
    if (session.flow) {
      if (session.flow === 'officina') {
        twiml.message(await handleOfficina(session, incomingText));
      } else if (session.flow === 'noleggio') {
        twiml.message(await handleNoleggio(session, incomingText));
      } else if (session.flow === 'vendita') {
        twiml.message(await handleVendita(session, incomingText));
      } else if (session.flow === 'trasporto') {
        twiml.message(await handleTrasporto(session, incomingText));
      } else {
        resetSession(incomingFrom);
        twiml.message(mainMenu());
      }

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    // SOLO SE NON C'È FLOW ATTIVO
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
        "Grazie per averci scritto 😊\n\n" +
        "Per aiutarti nel modo più rapido possibile, scegli uno dei nostri servizi:\n\n" +
        "🔧 Officina\n" +
        "🚐 Noleggio\n" +
        "🚗 Vendita Auto\n" +
        "🚛 Trasporto Auto\n\n" +
        "Scrivi pure il servizio che ti interessa."
      );
    }

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  } catch (error) {
    console.error('Errore generale:', error.message);
    twiml.message(
      "Ciao 👋 abbiamo ricevuto il tuo messaggio.\n\n" +
      "Al momento c’è un piccolo problema tecnico temporaneo, ma ti ricontatteremo al più presto."
    );
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
