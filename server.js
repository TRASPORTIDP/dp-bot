require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const TWILIO_WHATSAPP_NUMBER = 'whatsapp:+390744817108';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const OFFICINA_NUMBERS = ['whatsapp:+393287377675'];

const GENERAL_NUMBERS = [
  'whatsapp:+393472733226',
  'whatsapp:+393494040073'
];

const LINK_OFFICINA =
  'https://calendly.com/contabilita-trasportidp/appuntamenti-officina-dp';

const LINK_NOLEGGIO =
  'https://calendly.com/contabilita-trasportidp/noleggio-dp';

// memoria temporanea conversazioni
const sessions = {};

function detectIntent(text) {
  const msg = (text || '').toLowerCase();

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
    msg.includes('auto a noleggio')
  ) {
    return 'noleggio';
  }

  if (
    msg.includes('vendita') ||
    msg.includes('auto usata') ||
    msg.includes('comprare auto')
  ) {
    return 'vendita';
  }

  if (
    msg.includes('trasporto') ||
    msg.includes('bisarca')
  ) {
    return 'trasporto';
  }

  return 'generico';
}

function getRecipientsByIntent(intent) {
  if (intent === 'officina') {
    return OFFICINA_NUMBERS;
  }
  return GENERAL_NUMBERS;
}

function getRepartoName(intent) {
  if (intent === 'officina') return 'OFFICINA';
  if (intent === 'noleggio') return 'NOLEGGIO';
  if (intent === 'vendita') return 'VENDITA';
  if (intent === 'trasporto') return 'TRASPORTO';
  return 'GENERICO';
}

function getInfoRequestByIntent(intent) {
  if (intent === 'officina') {
    return (
      'Ciao 👋 grazie per aver contattato Trasporti DP.\n\n' +
      'Per l’officina, inviaci gentilmente in un solo messaggio:\n' +
      '• Nome e cognome\n' +
      '• Modello auto\n' +
      '• Targa\n' +
      '• Problema o intervento richiesto\n' +
      '• Giorno preferito\n' +
      '• Numero di telefono\n\n' +
      `Per prenotare direttamente puoi usare anche questo link:\n${LINK_OFFICINA}`
    );
  }

  if (intent === 'noleggio') {
    return (
      'Ciao 👋 grazie per aver contattato Trasporti DP.\n\n' +
      'Per il noleggio, inviaci gentilmente in un solo messaggio:\n' +
      '• Nome e cognome\n' +
      '• Mezzo richiesto\n' +
      '• Data inizio\n' +
      '• Data fine\n' +
      '• Numero di telefono\n\n' +
      `Per prenotare direttamente puoi usare anche questo link:\n${LINK_NOLEGGIO}`
    );
  }

  if (intent === 'vendita') {
    return (
      'Ciao 👋 grazie per aver contattato Trasporti DP.\n\n' +
      'Per la vendita auto, inviaci gentilmente in un solo messaggio:\n' +
      '• Nome e cognome\n' +
      '• Tipo di auto desiderata\n' +
      '• Budget indicativo\n' +
      '• Eventuale permuta\n' +
      '• Numero di telefono'
    );
  }

  if (intent === 'trasporto') {
    return (
      'Ciao 👋 grazie per aver contattato Trasporti DP.\n\n' +
      'Per il trasporto auto, inviaci gentilmente in un solo messaggio:\n' +
      '• Nome e cognome\n' +
      '• Tipo veicolo\n' +
      '• Luogo di ritiro\n' +
      '• Luogo di consegna\n' +
      '• Tempistiche richieste\n' +
      '• Numero di telefono'
    );
  }

  return (
    'Ciao 👋 grazie per aver contattato Trasporti DP.\n\n' +
    'Per aiutarti più velocemente, scrivici in un solo messaggio:\n' +
    '• Servizio richiesto (Officina / Noleggio / Vendita / Trasporto)\n' +
    '• Nome e cognome\n' +
    '• Numero di telefono\n' +
    '• Dettagli della richiesta'
  );
}

async function createConfirmationReply({ intent }) {
  let instruction = '';

  if (intent === 'officina') {
    instruction =
      'Conferma in modo professionale che i dati sono stati ricevuti e inoltrati al reparto officina. Tono cordiale, breve e chiaro.';
  } else if (intent === 'noleggio') {
    instruction =
      'Conferma in modo professionale che i dati sono stati ricevuti e inoltrati al reparto noleggio. Tono cordiale, breve e chiaro.';
  } else if (intent === 'vendita') {
    instruction =
      'Conferma in modo professionale che i dati sono stati ricevuti e inoltrati al reparto vendita. Tono cordiale, breve e chiaro.';
  } else if (intent === 'trasporto') {
    instruction =
      'Conferma in modo professionale che i dati sono stati ricevuti e inoltrati al reparto trasporto. Tono cordiale, breve e chiaro.';
  } else {
    instruction =
      'Conferma in modo professionale che i dati sono stati ricevuti e verranno verificati dal team. Tono cordiale, breve e chiaro.';
  }

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content:
            'Sei l’assistente WhatsApp di Trasporti DP. Rispondi sempre in italiano, in modo cordiale, professionale, breve e chiaro.'
        },
        {
          role: 'user',
          content: instruction
        }
      ]
    });

    return (
      completion.choices?.[0]?.message?.content?.trim() ||
      'Grazie 👍 abbiamo ricevuto i tuoi dati e li abbiamo inoltrati al reparto competente. Ti ricontatteremo al più presto.'
    );
  } catch (error) {
    return 'Grazie 👍 abbiamo ricevuto i tuoi dati e li abbiamo inoltrati al reparto competente. Ti ricontatteremo al più presto.';
  }
}

async function sendInternalNotification(numbers, text) {
  for (const to of numbers) {
    if (to === TWILIO_WHATSAPP_NUMBER) {
      console.log('Saltato invio al numero del bot:', to);
      continue;
    }

    try {
      const result = await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: to,
        body: text
      });
      console.log(`Notifica inviata a ${to}: ${result.sid}`);
    } catch (error) {
      console.error(`Errore invio notifica a ${to}:`, error.message);
    }
  }
}

app.post('/whatsapp', async (req, res) => {
  const incomingText = (req.body.Body || '').trim();
  const incomingFrom = req.body.From || '';
  const profileName = req.body.ProfileName || 'Cliente';
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    if (!incomingText) {
      twiml.message('Ciao 👋 scrivici pure la tua richiesta e ti aiuteremo il prima possibile.');
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (!sessions[incomingFrom]) {
      const intent = detectIntent(incomingText);

      sessions[incomingFrom] = {
        step: 'waiting_details',
        intent: intent,
        firstMessage: incomingText,
        customerName: profileName,
        createdAt: Date.now()
      };

      const infoRequest = getInfoRequestByIntent(intent);

      twiml.message(infoRequest);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    const session = sessions[incomingFrom];
    const intent = session.intent;
    const reparto = getRepartoName(intent);
    const internalRecipients = getRecipientsByIntent(intent);

    const internalText =
      `🔔 NUOVA RICHIESTA ${reparto}\n\n` +
      `👤 Cliente: ${profileName}\n` +
      `📞 Numero: ${incomingFrom}\n\n` +
      `💬 Primo messaggio:\n${session.firstMessage}\n\n` +
      `📝 Dati inviati dal cliente:\n${incomingText}`;

    await sendInternalNotification(internalRecipients, internalText);

    const confirmationReply = await createConfirmationReply({ intent });

    twiml.message(confirmationReply);

    delete sessions[incomingFrom];

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  } catch (error) {
    console.error('Errore generale:', error.message);
    twiml.message('Ciao 👋 abbiamo ricevuto il tuo messaggio. Ti ricontatteremo al più presto.');
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
