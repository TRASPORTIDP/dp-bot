require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

// CONTENT SID DEL CAROUSEL TWILIO
const MENU_CONTENT_SID = 'HX55fb733b15d424ddcdffe2f21d682c09';

// DESTINATARI INTERNI
const OFFICINA_NUMBERS = ['whatsapp:+393287377675'];

const GENERAL_NUMBERS = [
  'whatsapp:+393472733226',
  'whatsapp:+393494040073'
];

// MEMORIA TEMPORANEA CHAT
const sessions = new Map();

// SCADENZA SESSIONE: 1 ora
const SESSION_TIMEOUT_MS = 60 * 60 * 1000;

// PULIZIA SESSIONI VECCHIE
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessions.entries()) {
    if (now - value.updatedAt > SESSION_TIMEOUT_MS) {
      sessions.delete(key);
    }
  }
}, 10 * 60 * 1000);

// ----------------------
// UTIL
// ----------------------
function normalizeText(text) {
  return (text || '').trim().toLowerCase();
}

function getSession(from, profileName = 'Cliente') {
  if (!sessions.has(from)) {
    sessions.set(from, {
      from,
      profileName,
      flow: null,
      step: null,
      data: {},
      updatedAt: Date.now()
    });
  }

  const session = sessions.get(from);
  session.profileName = profileName || session.profileName || 'Cliente';
  session.updatedAt = Date.now();
  return session;
}

function resetSession(from) {
  sessions.delete(from);
}

function setFlow(session, flow, firstStep) {
  session.flow = flow;
  session.step = firstStep;
  session.data = {};
  session.updatedAt = Date.now();
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
    msg.includes('auto usata') ||
    msg.includes('comprare auto') ||
    msg.includes('acquistare auto')
  ) {
    return 'vendita';
  }

  if (
    msg.includes('trasporto') ||
    msg.includes('bisarca') ||
    msg.includes('trasportare') ||
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
// INVIO MENU CAROUSEL
// ----------------------
async function sendCarousel(to) {
  await twilioClient.messages.create({
    from: TWILIO_WHATSAPP_NUMBER,
    to,
    contentSid: MENU_CONTENT_SID
  });
}

// ----------------------
// NOTIFICHE INTERNE
// ----------------------
async function sendInternalNotification(numbers, text, incomingFrom) {
  for (const to of numbers) {
    if (to === incomingFrom) {
      console.log(`Salto invio verso stesso numero mittente: ${to}`);
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
      `📅 Preferenza: ${d.preferenza || '-'}\n`
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
      `📦 Utilizzo: ${d.utilizzo || '-'}\n`
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
      `📝 Note: ${d.note || '-'}\n`
    );
  }

  if (session.flow === 'trasporto') {
    return (
      "🔔 NUOVA RICHIESTA TRASPORTO AUTO\n\n" +
      `👤 Cliente: ${name}\n` +
      `📞 Numero: ${from}\n` +
      `🚗 Veicolo da trasportare: ${d.veicolo || '-'}\n` +
      `📍 Ritiro: ${d.ritiro || '-'}\n` +
      `📍 Consegna: ${d.consegna || '-'}\n` +
      `📅 Quando: ${d.data || '-'}\n` +
      `📝 Note: ${d.note || '-'}\n`
    );
  }

  return (
    "🔔 NUOVA RICHIESTA GENERICA\n\n" +
    `👤 Cliente: ${name}\n` +
    `📞 Numero: ${from}\n`
  );
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
      "🔧 OFFICINA DP\n\n" +
      "Perfetto, ti faccio alcune domande veloci per organizzare al meglio l’intervento.\n\n" +
      "1️⃣ Che veicolo è? (marca e modello)\n\n" +
      "Per ricominciare in qualsiasi momento scrivi: MENU"
    );
  }

  if (flow === 'noleggio') {
    setFlow(session, 'noleggio', 'mezzo');
    return (
      "🚐 NOLEGGIO DP\n\n" +
      "Perfetto, ti faccio alcune domande veloci per trovare il mezzo più adatto.\n\n" +
      "1️⃣ Che mezzo ti serve? (auto, furgone, altro)\n\n" +
      "Per ricominciare in qualsiasi momento scrivi: MENU"
    );
  }

  if (flow === 'vendita') {
    setFlow(session, 'vendita', 'tipoAuto');
    return (
      "🚗 VENDITA AUTO DP\n\n" +
      "Perfetto, ti faccio alcune domande veloci per proporti il veicolo giusto.\n\n" +
      "1️⃣ Che tipo di auto stai cercando?\n\n" +
      "Per ricominciare in qualsiasi momento scrivi: MENU"
    );
  }

  if (flow === 'trasporto') {
    setFlow(session, 'trasporto', 'veicolo');
    return (
      "🚛 TRASPORTO AUTO DP\n\n" +
      "Perfetto, ti faccio alcune domande veloci per preparare la richiesta di trasporto.\n\n" +
      "1️⃣ Che veicolo dobbiamo trasportare? (marca e modello)\n\n" +
      "Per ricominciare in qualsiasi momento scrivi: MENU"
    );
  }

  return "Per iniziare scrivi MENU.";
}

// ----------------------
// FLOW OFFICINA
// ----------------------
async function handleOfficina(session, message) {
  const d = session.data;

  if (session.step === 'veicolo') {
    d.veicolo = message;
    session.step = 'targa';
    return "2️⃣ Targa del veicolo?";
  }

  if (session.step === 'targa') {
    d.targa = message;
    session.step = 'km';
    return "3️⃣ Km attuali del veicolo?";
  }

  if (session.step === 'km') {
    d.km = message;
    session.step = 'intervento';
    return "4️⃣ Che intervento devi fare? (tagliando, freni, diagnosi, rumore, altro)";
  }

  if (session.step === 'intervento') {
    d.intervento = message;
    session.step = 'preferenza';
    return "5️⃣ Quando preferisci? (giorno / mattina / pomeriggio)";
  }

  if (session.step === 'preferenza') {
    d.preferenza = message;
    await finalizeFlow(session);
    resetSession(session.from);
    return (
      "✅ Perfetto, richiesta officina registrata.\n\n" +
      "Un nostro operatore ti ricontatterà a breve per conferma e organizzazione dell’intervento."
    );
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
    return "2️⃣ Da quando ti serve? (data inizio)";
  }

  if (session.step === 'dataInizio') {
    d.dataInizio = message;
    session.step = 'giorni';
    return "3️⃣ Per quanti giorni ti serve?";
  }

  if (session.step === 'giorni') {
    d.giorni = message;
    session.step = 'km';
    return "4️⃣ Quanti km pensi di fare circa?";
  }

  if (session.step === 'km') {
    d.km = message;
    session.step = 'utilizzo';
    return "5️⃣ Per che utilizzo ti serve? (lavoro, trasloco, viaggio, altro)";
  }

  if (session.step === 'utilizzo') {
    d.utilizzo = message;
    await finalizeFlow(session);
    resetSession(session.from);
    return (
      "✅ Perfetto, richiesta noleggio registrata.\n\n" +
      "Ti ricontatteremo a breve con disponibilità e informazioni utili."
    );
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
    return "2️⃣ Qual è il budget indicativo?";
  }

  if (session.step === 'budget') {
    d.budget = message;
    session.step = 'preferenze';
    return "3️⃣ Hai preferenze particolari? (diesel, benzina, ibrida, automatico, altro)";
  }

  if (session.step === 'preferenze') {
    d.preferenze = message;
    session.step = 'permuta';
    return "4️⃣ Hai un usato da dare in permuta? (sì / no)";
  }

  if (session.step === 'permuta') {
    d.permuta = message;
    session.step = 'note';
    return "5️⃣ Altre richieste o note utili?";
  }

  if (session.step === 'note') {
    d.note = message;
    await finalizeFlow(session);
    resetSession(session.from);
    return (
      "✅ Perfetto, richiesta vendita registrata.\n\n" +
      "Ti ricontatteremo a breve con le proposte più adatte."
    );
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
    return "2️⃣ Luogo di ritiro del veicolo?";
  }

  if (session.step === 'ritiro') {
    d.ritiro = message;
    session.step = 'consegna';
    return "3️⃣ Luogo di consegna del veicolo?";
  }

  if (session.step === 'consegna') {
    d.consegna = message;
    session.step = 'data';
    return "4️⃣ Quando ti serve il trasporto?";
  }

  if (session.step === 'data') {
    d.data = message;
    session.step = 'note';
    return "5️⃣ Note utili? (veicolo marciante / non marciante, urgenza, altro)";
  }

  if (session.step === 'note') {
    d.note = message;
    await finalizeFlow(session);
    resetSession(session.from);
    return (
      "✅ Perfetto, richiesta trasporto registrata.\n\n" +
      "Ti ricontatteremo a breve per conferma e organizzazione del servizio."
    );
  }

  return "Scrivi MENU per ricominciare.";
}

// ----------------------
// WEBHOOK WHATSAPP
// ----------------------
app.post('/whatsapp', async (req, res) => {
  const incomingText = (req.body.Body || '').trim();
  const incomingFrom = req.body.From || '';
  const profileName = req.body.ProfileName || 'Cliente';
  const normalized = normalizeText(incomingText);
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    if (!process.env.TWILIO_ACCOUNT_SID) {
      throw new Error('TWILIO_ACCOUNT_SID mancante');
    }
    if (!process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('TWILIO_AUTH_TOKEN mancante');
    }
    if (!TWILIO_WHATSAPP_NUMBER) {
      throw new Error('TWILIO_WHATSAPP_NUMBER mancante');
    }

    const session = getSession(incomingFrom, profileName);

    // COMANDI MENU
    if (
      normalized === 'menu' ||
      normalized === 'start' ||
      normalized === 'inizio' ||
      normalized === 'ciao' ||
      normalized === 'salve'
    ) {
      resetSession(incomingFrom);
      await sendCarousel(incomingFrom);
      return res.status(200).send('');
    }

    // FLOW GIÀ ATTIVO
    if (session.flow === 'officina') {
      const reply = await handleOfficina(session, incomingText);
      twiml.message(reply);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.flow === 'noleggio') {
      const reply = await handleNoleggio(session, incomingText);
      twiml.message(reply);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.flow === 'vendita') {
      const reply = await handleVendita(session, incomingText);
      twiml.message(reply);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.flow === 'trasporto') {
      const reply = await handleTrasporto(session, incomingText);
      twiml.message(reply);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    // NUOVA SCELTA SERVIZIO
    const intent = detectIntent(incomingText);

    if (intent === 'officina') {
      twiml.message(startFlow(session, 'officina'));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (intent === 'noleggio') {
      twiml.message(startFlow(session, 'noleggio'));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (intent === 'vendita') {
      twiml.message(startFlow(session, 'vendita'));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (intent === 'trasporto') {
      twiml.message(startFlow(session, 'trasporto'));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    // MESSAGGIO GENERICO: MANDA IL CAROUSEL
    resetSession(incomingFrom);
    await sendCarousel(incomingFrom);
    return res.status(200).send('');
  } catch (error) {
    console.error('Errore generale:', error.message);
    twiml.message(
      "Ciao 👋 abbiamo ricevuto il tuo messaggio, ma al momento c’è un problema tecnico temporaneo. Ti ricontatteremo al più presto."
    );
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
