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

const sessions = {};

// =========================
// FUNZIONI BASE
// =========================
function cleanText(text) {
  return (text || '').trim();
}

function normalize(text) {
  return cleanText(text).toLowerCase();
}

function formatCustomerName(profileName) {
  const name = cleanText(profileName);
  return name || 'Cliente';
}

function detectIntent(text) {
  const msg = normalize(text);

  if (
    msg.includes('officina') ||
    msg.includes('tagliando') ||
    msg.includes('riparazione') ||
    msg.includes('guasto') ||
    msg.includes('meccanico') ||
    msg.includes('diagnosi') ||
    msg.includes('revisione') ||
    msg.includes('problema auto')
  ) {
    return 'officina';
  }

  if (
    msg.includes('noleggio') ||
    msg.includes('noleggiare') ||
    msg.includes('furgone') ||
    msg.includes('furgoni') ||
    msg.includes('auto a noleggio') ||
    msg.includes('rent')
  ) {
    return 'noleggio';
  }

  if (
    msg.includes('vendita') ||
    msg.includes('auto usata') ||
    msg.includes('comprare auto') ||
    msg.includes('acquisto') ||
    msg.includes('cerco auto') ||
    msg.includes('vorrei comprare')
  ) {
    return 'vendita';
  }

  if (
    msg.includes('trasporto') ||
    msg.includes('bisarca') ||
    msg.includes('ritiro veicolo') ||
    msg.includes('consegna veicolo') ||
    msg.includes('spostare auto') ||
    msg.includes('trasportare auto')
  ) {
    return 'trasporto';
  }

  return 'generico';
}

function intentFromMenuChoice(text) {
  const msg = normalize(text);

  if (msg === '1') return 'officina';
  if (msg === '2') return 'noleggio';
  if (msg === '3') return 'vendita';
  if (msg === '4') return 'trasporto';

  return detectIntent(msg) !== 'generico' ? detectIntent(msg) : null;
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

// =========================
// TESTI PROFESSIONALI
// =========================
function buildWelcomeMenu(profileName) {
  const customerName = formatCustomerName(profileName);

  return (
    `Salve ${customerName} 👋\n` +
    'Benvenuto in *Trasporti DP*.\n\n' +
    'Per poterla assistere al meglio, selezioni il servizio di suo interesse rispondendo con il numero corrispondente:\n\n' +
    '1️⃣ *Officina* 🔧\n' +
    '2️⃣ *Noleggio* 🚐\n' +
    '3️⃣ *Vendita auto* 🚗\n' +
    '4️⃣ *Trasporto veicoli* 🚛\n\n' +
    'In alternativa, può anche scrivere direttamente la sua richiesta.'
  );
}

function buildStartMessageByIntent(intent, profileName) {
  const customerName = formatCustomerName(profileName);

  if (intent === 'officina') {
    return (
      `Salve ${customerName} 👋\n\n` +
      'La sua richiesta è stata indirizzata al reparto *Officina* 🔧\n\n' +
      'Le chiediamo gentilmente alcune informazioni per gestirla al meglio.'
    );
  }

  if (intent === 'noleggio') {
    return (
      `Salve ${customerName} 👋\n\n` +
      'La sua richiesta è stata indirizzata al reparto *Noleggio* 🚐\n\n' +
      'Le chiediamo gentilmente alcune informazioni per procedere.'
    );
  }

  if (intent === 'vendita') {
    return (
      `Salve ${customerName} 👋\n\n` +
      'La sua richiesta è stata indirizzata al reparto *Vendita auto* 🚗\n\n' +
      'Le chiediamo gentilmente alcune informazioni per aiutarla al meglio.'
    );
  }

  if (intent === 'trasporto') {
    return (
      `Salve ${customerName} 👋\n\n` +
      'La sua richiesta è stata indirizzata al reparto *Trasporto veicoli* 🚛\n\n' +
      'Le chiediamo gentilmente alcune informazioni per organizzarla.'
    );
  }

  return `Salve ${customerName} 👋`;
}

function buildQuestions(intent) {
  if (intent === 'officina') {
    return [
      'Qual è il *modello del veicolo*?',
      'Può indicarci la *targa*?',
      'Qual è il *problema* oppure quale *intervento* desidera effettuare?',
      'Ha un *giorno preferito* per l’appuntamento?',
      'Può lasciarci un *numero di telefono* per il ricontatto?'
    ];
  }

  if (intent === 'noleggio') {
    return [
      'Che *mezzo* le occorre?',
      'Qual è la *data di inizio* del noleggio?',
      'Qual è la *data di fine* del noleggio?',
      'Può lasciarci un *numero di telefono* per il ricontatto?'
    ];
  }

  if (intent === 'vendita') {
    return [
      'Che tipo di *auto* sta cercando?',
      'Qual è il suo *budget indicativo*?',
      'Ha una *permuta*? Se sì, ci indichi modello e anno.',
      'Può lasciarci un *numero di telefono* per il ricontatto?'
    ];
  }

  if (intent === 'trasporto') {
    return [
      'Qual è il *veicolo da trasportare*?',
      'Qual è il *luogo di ritiro*?',
      'Qual è il *luogo di consegna*?',
      'Entro quando sarebbe necessario il *trasporto*?',
      'Può lasciarci un *numero di telefono* per il ricontatto?'
    ];
  }

  return [];
}

function buildCustomerConfirmation(intent, profileName) {
  const customerName = formatCustomerName(profileName);

  if (intent === 'officina') {
    return (
      `La ringraziamo ${customerName} ✅\n\n` +
      'La sua richiesta per il reparto *Officina* è stata registrata correttamente e inoltrata al nostro staff.\n' +
      'Sarà ricontattato il prima possibile.\n\n' +
      `Per prenotare direttamente può usare anche questo link:\n${LINK_OFFICINA}`
    );
  }

  if (intent === 'noleggio') {
    return (
      `La ringraziamo ${customerName} ✅\n\n` +
      'La sua richiesta per il reparto *Noleggio* è stata registrata correttamente e inoltrata al nostro staff.\n' +
      'Sarà ricontattato il prima possibile.\n\n' +
      `Per prenotare direttamente può usare anche questo link:\n${LINK_NOLEGGIO}`
    );
  }

  if (intent === 'vendita') {
    return (
      `La ringraziamo ${customerName} ✅\n\n` +
      'La sua richiesta per il reparto *Vendita auto* è stata registrata correttamente e inoltrata al nostro staff.\n' +
      'Sarà ricontattato il prima possibile.'
    );
  }

  if (intent === 'trasporto') {
    return (
      `La ringraziamo ${customerName} ✅\n\n` +
      'La sua richiesta per il reparto *Trasporto veicoli* è stata registrata correttamente e inoltrata al nostro staff.\n' +
      'Sarà ricontattato il prima possibile.'
    );
  }

  return (
    `La ringraziamo ${customerName} ✅\n\n` +
    'La sua richiesta è stata ricevuta correttamente.\n' +
    'Sarà ricontattato dal nostro staff il prima possibile.'
  );
}

function buildInvalidChoiceMessage() {
  return (
    'Scelta non riconosciuta.\n\n' +
    'Per favore risponda con:\n' +
    '1️⃣ per *Officina* 🔧\n' +
    '2️⃣ per *Noleggio* 🚐\n' +
    '3️⃣ per *Vendita auto* 🚗\n' +
    '4️⃣ per *Trasporto veicoli* 🚛'
  );
}

// =========================
// MESSAGGIO INTERNO
// =========================
function buildInternalMessage(session, incomingFrom, profileName) {
  const intent = session.intent;
  const reparto = getReparto(intent);
  const a = session.answers;
  const customerName = formatCustomerName(profileName);

  if (intent === 'officina') {
    return (
      `🔔 NUOVA RICHIESTA ${reparto}\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero WhatsApp: ${incomingFrom}\n\n` +
      `Modello veicolo: ${a[0] || '-'}\n` +
      `Targa: ${a[1] || '-'}\n` +
      `Problema / intervento: ${a[2] || '-'}\n` +
      `Giorno preferito: ${a[3] || '-'}\n` +
      `Telefono ricontatto: ${a[4] || '-'}`
    );
  }

  if (intent === 'noleggio') {
    return (
      `🔔 NUOVA RICHIESTA ${reparto}\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero WhatsApp: ${incomingFrom}\n\n` +
      `Mezzo richiesto: ${a[0] || '-'}\n` +
      `Data inizio: ${a[1] || '-'}\n` +
      `Data fine: ${a[2] || '-'}\n` +
      `Telefono ricontatto: ${a[3] || '-'}`
    );
  }

  if (intent === 'vendita') {
    return (
      `🔔 NUOVA RICHIESTA ${reparto}\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero WhatsApp: ${incomingFrom}\n\n` +
      `Auto cercata: ${a[0] || '-'}\n` +
      `Budget indicativo: ${a[1] || '-'}\n` +
      `Permuta: ${a[2] || '-'}\n` +
      `Telefono ricontatto: ${a[3] || '-'}`
    );
  }

  if (intent === 'trasporto') {
    return (
      `🔔 NUOVA RICHIESTA ${reparto}\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero WhatsApp: ${incomingFrom}\n\n` +
      `Veicolo da trasportare: ${a[0] || '-'}\n` +
      `Luogo ritiro: ${a[1] || '-'}\n` +
      `Luogo consegna: ${a[2] || '-'}\n` +
      `Quando serve: ${a[3] || '-'}\n` +
      `Telefono ricontatto: ${a[4] || '-'}`
    );
  }

  return (
    `🔔 NUOVA RICHIESTA GENERICA\n\n` +
    `👤 Nome WhatsApp: ${customerName}\n` +
    `📞 Numero WhatsApp: ${incomingFrom}`
  );
}

// =========================
// INVIO
// =========================
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

// =========================
// SESSIONI
// =========================
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
      twiml.message('Si è verificato un errore nella ricezione del messaggio.');
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    let session = sessions[incomingFrom];

    if (session && isExpired(session)) {
      resetSession(incomingFrom);
      session = null;
    }

    if (normalize(incomingText) === 'reset' || normalize(incomingText) === 'menu') {
      resetSession(incomingFrom);
      twiml.message(buildWelcomeMenu(profileName));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (!session) {
      session = createSession(incomingFrom, profileName);

      const detectedIntent = detectIntent(incomingText);

      if (detectedIntent !== 'generico') {
        session.intent = detectedIntent;
        session.questions = buildQuestions(detectedIntent);
        session.state = 'questions';
        session.questionIndex = 0;

        const firstMessage =
          buildStartMessageByIntent(detectedIntent, profileName) +
          '\n\n' +
          session.questions[0];

        twiml.message(firstMessage);
      } else {
        twiml.message(buildWelcomeMenu(profileName));
      }

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'menu') {
      const chosenIntent = intentFromMenuChoice(incomingText);

      if (!chosenIntent) {
        twiml.message(buildInvalidChoiceMessage());
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      session.intent = chosenIntent;
      session.questions = buildQuestions(chosenIntent);
      session.state = 'questions';
      session.questionIndex = 0;

      const message =
        buildStartMessageByIntent(chosenIntent, profileName) +
        '\n\n' +
        session.questions[0];

      twiml.message(message);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'questions') {
      session.answers.push(incomingText);
      session.questionIndex += 1;

      if (session.questionIndex < session.questions.length) {
        twiml.message(session.questions[session.questionIndex]);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      const internalMessage = buildInternalMessage(
        session,
        incomingFrom,
        profileName
      );

      const recipients = getRecipients(session.intent);
      await sendInternalNotification(recipients, internalMessage);

      twiml.message(buildCustomerConfirmation(session.intent, profileName));
      resetSession(incomingFrom);

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    resetSession(incomingFrom);
    twiml.message(buildWelcomeMenu(profileName));
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  } catch (error) {
    console.error('Errore generale:', error);
    twiml.message(
      'La ringraziamo per il messaggio. Al momento si è verificato un problema tecnico. La invitiamo a riprovare tra poco.'
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
