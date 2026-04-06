require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const TWILIO_WHATSAPP_NUMBER = 'whatsapp:+390744817108';

const OFFICINA_NUMBERS = ['whatsapp:+393287377675'];

const GENERAL_NUMBERS = [
  'whatsapp:+393472733226',
  'whatsapp:+393494040073'
];

const LINK_OFFICINA =
  'https://calendly.com/contabilita-trasportidp/appuntamenti-officina-dp';

const LINK_NOLEGGIO =
  'https://calendly.com/contabilita-trasportidp/noleggio-dp';

// memoria temporanea sessioni
const sessions = {};

// =========================
// UTIL
// =========================
function cleanText(text) {
  return (text || '').trim();
}

function normalize(text) {
  return cleanText(text).toLowerCase();
}

function detectIntent(text) {
  const msg = normalize(text);

  if (
    msg.includes('officina') ||
    msg.includes('tagliando') ||
    msg.includes('riparazione') ||
    msg.includes('guasto') ||
    msg.includes('meccanico')
  ) {
    return 'officina';
  }

  if (
    msg.includes('noleggio') ||
    msg.includes('furgone') ||
    msg.includes('auto a noleggio') ||
    msg.includes('noleggiare')
  ) {
    return 'noleggio';
  }

  if (
    msg.includes('vendita') ||
    msg.includes('auto usata') ||
    msg.includes('comprare auto') ||
    msg.includes('acquisto')
  ) {
    return 'vendita';
  }

  if (
    msg.includes('trasporto') ||
    msg.includes('bisarca') ||
    msg.includes('ritiro') ||
    msg.includes('consegna veicolo')
  ) {
    return 'trasporto';
  }

  return 'generico';
}

function getRecipients(intent) {
  if (intent === 'officina') {
    return OFFICINA_NUMBERS;
  }
  return GENERAL_NUMBERS;
}

function getReparto(intent) {
  if (intent === 'officina') return 'OFFICINA';
  if (intent === 'noleggio') return 'NOLEGGIO';
  if (intent === 'vendita') return 'VENDITA';
  if (intent === 'trasporto') return 'TRASPORTO';
  return 'GENERICO';
}

function buildQuestions(intent) {
  if (intent === 'officina') {
    return [
      'Perfetto 👨‍🔧\nHai bisogno dell’officina.\n\nCome ti chiami? (nome e cognome)',
      'Indicaci il modello del veicolo.',
      'Indicaci la targa del veicolo.',
      'Che problema ha il veicolo oppure quale intervento ti serve?',
      'Quale giorno preferisci?',
      'Lasciaci un numero di telefono per ricontattarti.'
    ];
  }

  if (intent === 'noleggio') {
    return [
      'Perfetto 🚐\nHai bisogno del noleggio.\n\nCome ti chiami? (nome e cognome)',
      'Che mezzo ti serve?',
      'Data di inizio noleggio?',
      'Data di fine noleggio?',
      'Lasciaci un numero di telefono per ricontattarti.'
    ];
  }

  if (intent === 'vendita') {
    return [
      'Perfetto 🚗\nHai bisogno del reparto vendita.\n\nCome ti chiami? (nome e cognome)',
      'Che tipo di auto stai cercando?',
      'Qual è il tuo budget indicativo?',
      'Hai una permuta? Se sì, indica modello e anno.',
      'Lasciaci un numero di telefono per ricontattarti.'
    ];
  }

  if (intent === 'trasporto') {
    return [
      'Perfetto 🚛\nHai bisogno del trasporto auto.\n\nCome ti chiami? (nome e cognome)',
      'Che veicolo dobbiamo trasportare?',
      'Da dove va ritirato?',
      'Dove va consegnato?',
      'Quando serve il trasporto?',
      'Lasciaci un numero di telefono per ricontattarti.'
    ];
  }

  return [];
}

function buildMenuMessage() {
  return (
    'Ciao 👋 benvenuto in Trasporti DP.\n\n' +
    'Scrivi il numero del servizio che ti interessa:\n\n' +
    '1. Officina\n' +
    '2. Noleggio\n' +
    '3. Vendita auto\n' +
    '4. Trasporto auto'
  );
}

function intentFromMenuChoice(text) {
  const msg = normalize(text);

  if (msg === '1' || msg.includes('officina')) return 'officina';
  if (msg === '2' || msg.includes('noleggio')) return 'noleggio';
  if (msg === '3' || msg.includes('vendita')) return 'vendita';
  if (msg === '4' || msg.includes('trasporto')) return 'trasporto';

  return null;
}

function buildCustomerConfirmation(intent) {
  if (intent === 'officina') {
    return (
      'Grazie 👍\nLa tua richiesta per l’officina è stata registrata e inoltrata.\n' +
      `Se preferisci, puoi prenotare anche qui:\n${LINK_OFFICINA}`
    );
  }

  if (intent === 'noleggio') {
    return (
      'Grazie 👍\nLa tua richiesta per il noleggio è stata registrata e inoltrata.\n' +
      `Se preferisci, puoi prenotare anche qui:\n${LINK_NOLEGGIO}`
    );
  }

  if (intent === 'vendita') {
    return 'Grazie 👍\nLa tua richiesta per la vendita auto è stata registrata e inoltrata. Ti ricontatteremo al più presto.';
  }

  if (intent === 'trasporto') {
    return 'Grazie 👍\nLa tua richiesta per il trasporto auto è stata registrata e inoltrata. Ti ricontatteremo al più presto.';
  }

  return 'Grazie 👍\nAbbiamo ricevuto la tua richiesta e ti ricontatteremo al più presto.';
}

function buildInternalMessage(session, incomingFrom, profileName) {
  const intent = session.intent;
  const reparto = getReparto(intent);
  const a = session.answers;

  if (intent === 'officina') {
    return (
      `🔔 NUOVA RICHIESTA ${reparto}\n\n` +
      `👤 Cliente WhatsApp: ${profileName}\n` +
      `📞 Numero WhatsApp: ${incomingFrom}\n\n` +
      `Nome e cognome: ${a[0] || '-'}\n` +
      `Modello veicolo: ${a[1] || '-'}\n` +
      `Targa: ${a[2] || '-'}\n` +
      `Problema / intervento: ${a[3] || '-'}\n` +
      `Giorno preferito: ${a[4] || '-'}\n` +
      `Telefono ricontatto: ${a[5] || '-'}`
    );
  }

  if (intent === 'noleggio') {
    return (
      `🔔 NUOVA RICHIESTA ${reparto}\n\n` +
      `👤 Cliente WhatsApp: ${profileName}\n` +
      `📞 Numero WhatsApp: ${incomingFrom}\n\n` +
      `Nome e cognome: ${a[0] || '-'}\n` +
      `Mezzo richiesto: ${a[1] || '-'}\n` +
      `Data inizio: ${a[2] || '-'}\n` +
      `Data fine: ${a[3] || '-'}\n` +
      `Telefono ricontatto: ${a[4] || '-'}`
    );
  }

  if (intent === 'vendita') {
    return (
      `🔔 NUOVA RICHIESTA ${reparto}\n\n` +
      `👤 Cliente WhatsApp: ${profileName}\n` +
      `📞 Numero WhatsApp: ${incomingFrom}\n\n` +
      `Nome e cognome: ${a[0] || '-'}\n` +
      `Auto cercata: ${a[1] || '-'}\n` +
      `Budget: ${a[2] || '-'}\n` +
      `Permuta: ${a[3] || '-'}\n` +
      `Telefono ricontatto: ${a[4] || '-'}`
    );
  }

  if (intent === 'trasporto') {
    return (
      `🔔 NUOVA RICHIESTA ${reparto}\n\n` +
      `👤 Cliente WhatsApp: ${profileName}\n` +
      `📞 Numero WhatsApp: ${incomingFrom}\n\n` +
      `Nome e cognome: ${a[0] || '-'}\n` +
      `Veicolo da trasportare: ${a[1] || '-'}\n` +
      `Luogo ritiro: ${a[2] || '-'}\n` +
      `Luogo consegna: ${a[3] || '-'}\n` +
      `Quando serve: ${a[4] || '-'}\n` +
      `Telefono ricontatto: ${a[5] || '-'}`
    );
  }

  return (
    `🔔 NUOVA RICHIESTA GENERICA\n\n` +
    `👤 Cliente WhatsApp: ${profileName}\n` +
    `📞 Numero WhatsApp: ${incomingFrom}`
  );
}

async function sendInternalNotification(numbers, text) {
  for (const to of numbers) {
    if (to === TWILIO_WHATSAPP_NUMBER) {
      console.log('Saltato invio al numero del bot:', to);
      continue;
    }

    try {
      const result = await client.messages.create({
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

function resetSession(phone) {
  delete sessions[phone];
}

function createSession(phone, profileName) {
  sessions[phone] = {
    profileName,
    state: 'menu',
    intent: null,
    questionIndex: 0,
    questions: [],
    answers: [],
    createdAt: Date.now()
  };
  return sessions[phone];
}

function isExpired(session) {
  const THIRTY_MINUTES = 30 * 60 * 1000;
  return Date.now() - session.createdAt > THIRTY_MINUTES;
}

// =========================
// WEBHOOK
// =========================
app.post('/whatsapp', async (req, res) => {
  const incomingText = cleanText(req.body.Body);
  const incomingFrom = req.body.From || '';
  const profileName = req.body.ProfileName || 'Cliente';
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    if (!incomingFrom) {
      twiml.message('Errore nella ricezione del messaggio.');
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    let session = sessions[incomingFrom];

    if (session && isExpired(session)) {
      resetSession(incomingFrom);
      session = null;
    }

    if (!session) {
      session = createSession(incomingFrom, profileName);

      // Se il cliente scrive già il servizio, entriamo subito nel flusso giusto
      const directIntent = detectIntent(incomingText);

      if (directIntent !== 'generico') {
        session.intent = directIntent;
        session.questions = buildQuestions(directIntent);
        session.state = 'questions';
        session.questionIndex = 0;
        twiml.message(session.questions[0]);
      } else {
        twiml.message(buildMenuMessage());
      }

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    // Stato menu
    if (session.state === 'menu') {
      const chosenIntent = intentFromMenuChoice(incomingText);

      if (!chosenIntent) {
        twiml.message(
          'Scelta non valida.\n\n' +
          'Rispondi con:\n' +
          '1 per Officina\n' +
          '2 per Noleggio\n' +
          '3 per Vendita auto\n' +
          '4 per Trasporto auto'
        );
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      session.intent = chosenIntent;
      session.questions = buildQuestions(chosenIntent);
      session.state = 'questions';
      session.questionIndex = 0;

      twiml.message(session.questions[0]);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    // Stato domande
    if (session.state === 'questions') {
      session.answers.push(incomingText);
      session.questionIndex += 1;

      if (session.questionIndex < session.questions.length) {
        twiml.message(session.questions[session.questionIndex]);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      // tutte le risposte raccolte
      const internalMessage = buildInternalMessage(
        session,
        incomingFrom,
        profileName
      );

      const recipients = getRecipients(session.intent);
      await sendInternalNotification(recipients, internalMessage);

      twiml.message(buildCustomerConfirmation(session.intent));
      resetSession(incomingFrom);

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    // fallback
    resetSession(incomingFrom);
    twiml.message(buildMenuMessage());
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  } catch (error) {
    console.error('Errore generale:', error);
    twiml.message(
      'Ciao 👋 si è verificato un problema tecnico. Riprova tra poco.'
    );
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  }
});

app.get('/', (req, res) => {
  res.send('Server WhatsApp DP attivo ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
