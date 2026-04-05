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

// NUMERO WHATSAPP TWILIO CHE RICEVE I MESSAGGI CLIENTI
// Mettilo in formato whatsapp:+39...
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

// MODELLO OPENAI
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// NUMERI INTERNI
const OFFICINA_NUMBERS = ['whatsapp:+393287377675'];

const GENERAL_NUMBERS = [
  'whatsapp:+393472733226',
  'whatsapp:+393494040073'
];

// LINK
const LINK_OFFICINA =
  'https://calendly.com/contabilita-trasportidp/appuntamenti-officina-dp';

const LINK_NOLEGGIO =
  'https://calendly.com/contabilita-trasportidp/noleggio-dp';

// PAROLE CHIAVE MENU
function detectIntent(text) {
  const msg = (text || '').toLowerCase();

  if (msg.includes('officina') || msg.includes('tagliando') || msg.includes('riparazione') || msg.includes('meccanico')) {
    return 'officina';
  }

  if (msg.includes('noleggio') || msg.includes('affitto auto') || msg.includes('affitto furgone') || msg.includes('noleggiare')) {
    return 'noleggio';
  }

  if (msg.includes('vendita') || msg.includes('comprare auto') || msg.includes('acquisto auto') || msg.includes('auto usata')) {
    return 'vendita';
  }

  if (msg.includes('trasporto') || msg.includes('bisarca') || msg.includes('trasportare auto') || msg.includes('ritiro auto')) {
    return 'trasporto';
  }

  if (
    msg.includes('prenot') ||
    msg.includes('appuntamento') ||
    msg.includes('quando posso') ||
    msg.includes('disponibil')
  ) {
    return 'prenotazione_generica';
  }

  return 'generico';
}

// CREA RISPOSTA CON OPENAI
async function createAiReply({ customerName, incomingText, intent }) {
  let extraInstruction = '';

  if (intent === 'officina') {
    extraInstruction =
      `Il cliente sta chiedendo OFFICINA.
Rispondi in modo professionale, breve e cordiale.
Digli che la richiesta è stata ricevuta e che sarà ricontattato a breve.
Invitalo anche a prenotare qui: ${LINK_OFFICINA}
Non inserire numeri di telefono interni.`;
  } else if (intent === 'noleggio') {
    extraInstruction =
      `Il cliente sta chiedendo NOLEGGIO.
Rispondi in modo professionale, breve e cordiale.
Digli che la richiesta è stata ricevuta e che sarà ricontattato a breve.
Invitalo anche a prenotare qui: ${LINK_NOLEGGIO}
Non inserire numeri di telefono interni.`;
  } else if (intent === 'vendita') {
    extraInstruction =
      `Il cliente sta chiedendo VENDITA AUTO.
Rispondi in modo professionale, breve e cordiale.
Digli che la richiesta è stata ricevuta e che sarà ricontattato a breve.
Non inserire numeri di telefono interni.`;
  } else if (intent === 'trasporto') {
    extraInstruction =
      `Il cliente sta chiedendo TRASPORTO AUTO.
Rispondi in modo professionale, breve e cordiale.
Digli che la richiesta è stata ricevuta e che sarà ricontattato a breve.
Non inserire numeri di telefono interni.`;
  } else if (intent === 'prenotazione_generica') {
    extraInstruction =
      `Il cliente sembra voler prenotare ma non ha specificato bene il servizio.
Rispondi in modo professionale, breve e cordiale.
Chiedi di indicare se si tratta di: Officina, Noleggio, Vendita o Trasporto.
Non inserire numeri di telefono interni.`;
  } else {
    extraInstruction =
      `Il cliente ha inviato un messaggio generico.
Rispondi in modo professionale, breve e cordiale.
Invitalo a specificare il servizio: Officina, Noleggio, Vendita o Trasporto.
Non inserire numeri di telefono interni.`;
  }

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.5,
    messages: [
      {
        role: 'system',
        content:
          `Sei l'assistente WhatsApp di DP Rent / Trasporti DP.
Rispondi sempre in italiano.
Tono: professionale, cordiale, chiaro, commerciale ma non aggressivo.
Messaggi brevi, leggibili su WhatsApp.
Non inventare prezzi, disponibilità o promesse specifiche.
Non mostrare mai numeri interni o dettagli tecnici.
Usa al massimo 5-7 righe.`
      },
      {
        role: 'user',
        content:
          `Nome cliente: ${customerName || 'Cliente'}
Messaggio cliente: ${incomingText}

Istruzioni:
${extraInstruction}`
      }
    ]
  });

  return completion.choices?.[0]?.message?.content?.trim() ||
    "Ciao 👋 abbiamo ricevuto la tua richiesta. Ti ricontatteremo a breve.";
}

// INVIO NOTIFICHE INTERNE
async function sendInternalNotification(numbers, text) {
  for (const to of numbers) {
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

app.post('/whatsapp', async (req, res) => {
  const incomingText = (req.body.Body || '').trim();
  const incomingFrom = req.body.From || '';
  const profileName = req.body.ProfileName || 'Cliente';
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    if (!process.env.TWILIO_ACCOUNT_SID) {
      throw new Error('TWILIO_ACCOUNT_SID mancante');
    }
    if (!process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('TWILIO_AUTH_TOKEN mancante');
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY mancante');
    }
    if (!TWILIO_WHATSAPP_NUMBER) {
      throw new Error('TWILIO_WHATSAPP_NUMBER mancante');
    }

    const intent = detectIntent(incomingText);

    const aiReply = await createAiReply({
      customerName: profileName,
      incomingText,
      intent
    });

    let internalRecipients = GENERAL_NUMBERS;
    let reparto = 'GENERICO';

    if (intent === 'officina') {
      internalRecipients = OFFICINA_NUMBERS;
      reparto = 'OFFICINA';
    } else if (intent === 'noleggio') {
      internalRecipients = GENERAL_NUMBERS;
      reparto = 'NOLEGGIO';
    } else if (intent === 'vendita') {
      internalRecipients = GENERAL_NUMBERS;
      reparto = 'VENDITA';
    } else if (intent === 'trasporto') {
      internalRecipients = GENERAL_NUMBERS;
      reparto = 'TRASPORTO';
    } else if (intent === 'prenotazione_generica') {
      internalRecipients = GENERAL_NUMBERS;
      reparto = 'PRENOTAZIONE GENERICA';
    }

    const internalText =
      `🔔 NUOVA RICHIESTA ${reparto}\n\n` +
      `👤 Cliente: ${profileName}\n` +
      `📞 Numero: ${incomingFrom}\n` +
      `💬 Messaggio: ${incomingText}`;

    await sendInternalNotification(internalRecipients, internalText);

    twiml.message(aiReply);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  } catch (error) {
    console.error('Errore generale:', error.message);

    twiml.message(
      "Ciao 👋 abbiamo ricevuto il tuo messaggio. Ti ricontatteremo al più presto."
    );
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
