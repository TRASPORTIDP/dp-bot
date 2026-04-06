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

function detectIntent(text) {
  const msg = (text || '').toLowerCase();

  if (msg.includes('officina') || msg.includes('tagliando') || msg.includes('riparazione')) {
    return 'officina';
  }
  if (msg.includes('noleggio') || msg.includes('furgone') || msg.includes('auto a noleggio')) {
    return 'noleggio';
  }
  if (msg.includes('vendita') || msg.includes('auto usata') || msg.includes('comprare auto')) {
    return 'vendita';
  }
  if (msg.includes('trasporto') || msg.includes('bisarca')) {
    return 'trasporto';
  }

  return 'generico';
}

async function createAiReply({ customerName, incomingText, intent }) {
  let extra = '';

  if (intent === 'officina') {
    extra = `Il cliente chiede officina. Rispondi in modo professionale e breve. Inserisci anche questo link: ${LINK_OFFICINA}`;
  } else if (intent === 'noleggio') {
    extra = `Il cliente chiede noleggio. Rispondi in modo professionale e breve. Inserisci anche questo link: ${LINK_NOLEGGIO}`;
  } else if (intent === 'vendita') {
    extra = `Il cliente chiede vendita auto. Rispondi in modo professionale e breve.`;
  } else if (intent === 'trasporto') {
    extra = `Il cliente chiede trasporto auto. Rispondi in modo professionale e breve.`;
  } else {
    extra = `Il cliente ha scritto un messaggio generico. Chiedi gentilmente di specificare: Officina, Noleggio, Vendita o Trasporto.`;
  }

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.5,
    messages: [
      {
        role: 'system',
        content:
          'Sei l’assistente WhatsApp di Trasporti DP. Rispondi sempre in italiano, in modo cordiale, professionale, breve e chiaro. Non mostrare mai numeri interni.'
      },
      {
        role: 'user',
        content: `Cliente: ${customerName}\nMessaggio: ${incomingText}\nIstruzioni: ${extra}`
      }
    ]
  });

  return completion.choices?.[0]?.message?.content?.trim()
    || 'Ciao 👋 abbiamo ricevuto la tua richiesta. Ti ricontatteremo a breve.';
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
    twiml.message('Ciao 👋 abbiamo ricevuto il tuo messaggio. Ti ricontatteremo al più presto.');
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
