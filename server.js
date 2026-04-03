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

// ⚠️ METTI IL TUO NUMERO TWILIO WHATSAPP
const TWILIO_WHATSAPP_NUMBER = 'whatsapp:+14155238886';

// 🔧 OFFICINA
const OFFICINA = ['whatsapp:+393287377675'];

// 🚐🚗🚛 TUTTO IL RESTO
const GENERALE = [
  'whatsapp:+393472733226',
  'whatsapp:+393494040073'
];

// INVIO NOTIFICA INTERNA
async function notifica(numeri, testo) {
  for (const numero of numeri) {
    try {
      await client.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: numero,
        body: testo
      });
    } catch (e) {
      console.error('Errore invio:', e.message);
    }
  }
}

app.post('/whatsapp', async (req, res) => {
  const msg = (req.body.Body || '').trim();
  const msgLower = msg.toLowerCase();
  const from = req.body.From;
  const nome = req.body.ProfileName || 'Cliente';

  const twiml = new twilio.twiml.MessagingResponse();

  let risposta = 
    "Ciao 👋 benvenuto in DP!\n\n" +
    "Scrivi il servizio:\n\n" +
    "🔧 Officina\n" +
    "🚐 Noleggio\n" +
    "🚗 Vendita\n" +
    "🚛 Trasporto";

  try {

    // 🔧 OFFICINA
    if (msgLower.includes('officina')) {

      risposta =
        "🔧 OFFICINA DP\n\n" +
        "Richiesta ricevuta ✅\n" +
        "Un nostro operatore ti contatterà a breve.\n\n" +
        "Puoi anche prenotare qui:\n" +
        "👉 https://calendly.com/contabilita-trasportidp/appuntamenti-officina-dp";

      await notifica(
        OFFICINA,
        `🔔 OFFICINA\n\n👤 ${nome}\n📞 ${from}\n💬 ${msg}`
      );
    }

    // 🚐 NOLEGGIO
    else if (msgLower.includes('noleggio')) {

      risposta =
        "🚐 NOLEGGIO DP\n\n" +
        "Richiesta ricevuta ✅\n" +
        "Ti contatteremo a breve.\n\n" +
        "Prenota subito:\n" +
        "👉 https://calendly.com/contabilita-trasportidp/noleggio-dp";

      await notifica(
        GENERALE,
        `🔔 NOLEGGIO\n\n👤 ${nome}\n📞 ${from}\n💬 ${msg}`
      );
    }

    // 🚗 VENDITA
    else if (msgLower.includes('vendita')) {

      risposta =
        "🚗 VENDITA AUTO\n\n" +
        "Richiesta ricevuta ✅\n" +
        "Ti contatteremo a breve.";

      await notifica(
        GENERALE,
        `🔔 VENDITA\n\n👤 ${nome}\n📞 ${from}\n💬 ${msg}`
      );
    }

    // 🚛 TRASPORTO
    else if (msgLower.includes('trasporto') || msgLower.includes('bisarca')) {

      risposta =
        "🚛 TRASPORTO AUTO\n\n" +
        "Richiesta ricevuta ✅\n" +
        "Ti contatteremo a breve.";

      await notifica(
        GENERALE,
        `🔔 TRASPORTO\n\n👤 ${nome}\n📞 ${from}\n💬 ${msg}`
      );
    }

    // 🔁 QUALSIASI ALTRO
    else {

      risposta =
        "Messaggio ricevuto ✅\n" +
        "Ti ricontatteremo a breve.\n\n" +
        "Puoi scrivere:\n" +
        "🔧 Officina\n🚐 Noleggio\n🚗 Vendita\n🚛 Trasporto";

      await notifica(
        GENERALE,
        `🔔 GENERICO\n\n👤 ${nome}\n📞 ${from}\n💬 ${msg}`
      );
    }

    twiml.message(risposta);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());

  } catch (err) {
    console.error(err);

    twiml.message("Messaggio ricevuto. Ti contatteremo a breve.");
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server attivo su porta ' + PORT);
});
