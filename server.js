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

const OFFICINA_NUMBERS = ['whatsapp:+393287377675'];
const GENERAL_NUMBERS = [
  'whatsapp:+393472733226',
  'whatsapp:+393494040073'
];

const sessions = new Map();
const SESSION_TIMEOUT_MS = 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessions.entries()) {
    if (now - value.updatedAt > SESSION_TIMEOUT_MS) {
      sessions.delete(key);
    }
  }
}, 10 * 60 * 1000);

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
  ) return 'officina';

  if (
    msg.includes('noleggio') ||
    msg.includes('affitto') ||
    msg.includes('furgone') ||
    msg.includes('auto a noleggio')
  ) return 'noleggio';

  if (
    msg.includes('vendita') ||
    msg.includes('auto usata') ||
    msg.includes('comprare auto') ||
    msg.includes('acquistare auto')
  ) return 'vendita';

  if (
    msg.includes('trasporto') ||
    msg.includes('bisarca') ||
    msg.includes('trasportare') ||
    msg.includes('ritiro auto') ||
    msg.includes('consegna auto')
  ) return 'trasporto';

  return 'generico';
}

function getRecipientsByFlow(flow) {
  if (flow === 'officina') return OFFICINA_NUMBERS;
  return GENERAL_NUMBERS;
}

async function sendInternalNotification(numbers, text, incomingFrom) {
  for (const to of numbers) {
    if (to === incomingFrom) continue;

    try {
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to,
        body: text
      });
    } catch (error) {
      console.error(`Errore invio notifica a ${to}:`, error.message);
    }
  }
}

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
    return "4️⃣ Che intervento devi fare?";
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
    return "✅ Perfetto, richiesta officina registrata. Ti ricontatteremo a breve.";
  }

  return "Scrivi MENU per ricominciare.";
}

async function handleNoleggio(session, message) {
  const d = session.data;

  if (session.step === 'mezzo') {
    d.mezzo = message;
    session.step = 'dataInizio';
    return "2️⃣ Da quando ti serve?";
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
    return "5️⃣ Per che utilizzo ti serve?";
  }
  if (session.step === 'utilizzo') {
    d.utilizzo = message;
    await finalizeFlow(session);
    resetSession(session.from);
    return "✅ Perfetto, richiesta noleggio registrata. Ti ricontatteremo a breve.";
  }

  return "Scrivi MENU per ricominciare.";
}

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
    return "3️⃣ Hai preferenze particolari? (diesel, benzina, ibrida, automatico...)";
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
    return "✅ Perfetto, richiesta vendita registrata. Ti ricontatteremo a breve.";
  }

  return "Scrivi MENU per ricominciare.";
}

async function handleTrasporto(session, message) {
  const d = session.data;

  if (session.step === 'veicolo') {
    d.veicolo = message;
    session.step = 'ritiro';
    return "2️⃣ Luogo di ritiro?";
  }
  if (session.step === 'ritiro') {
    d.ritiro = message;
    session.step = 'consegna';
    return "3️⃣ Luogo di consegna?";
  }
  if (session.step === 'consegna') {
    d.consegna = message;
    session.step = 'data';
    return "4️⃣ Quando ti serve il trasporto?";
  }
  if (session.step === 'data') {
    d.data = message;
    session.step = 'note';
    return "5️⃣ Note utili? (marciante / non marciante / urgenza)";
  }
  if (session.step === 'note') {
    d.note = message;
    await finalizeFlow(session);
    resetSession(session.from);
    return "✅ Perfetto, richiesta trasporto registrata. Ti ricontatteremo a breve.";
  }

  return "Scrivi MENU per ricominciare.";
}

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
      resetSession(incomingFrom);
      twiml.message(mainMenu());
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
