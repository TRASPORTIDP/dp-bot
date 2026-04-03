require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.post('/whatsapp', (req, res) => {
    const incomingMsg = (req.body.Body || '').toLowerCase();
    const twiml = new twilio.twiml.MessagingResponse();

    let risposta = "Ciao 👋 benvenuto in DP!\n\n" +
                   "Seleziona il servizio:\n\n" +
                   "🔧 OFFICINA\n" +
                   "🚐 NOLEGGIO\n" +
                   "🚗 VENDITA\n" +
                   "🚛 TRASPORTO\n\n" +
                   "Scrivi il servizio che ti interessa.";

    // SMISTAMENTO OFFICINA
    if (incomingMsg.includes('officina')) {
        risposta = "🔧 OFFICINA DP\n\n" +
                   "Scrivici direttamente qui:\n" +
                   "📲 +393287377675\n\n" +
                   "Oppure prenota online:\n" +
                   "👉 https://calendly.com/contabilita-trasportidp/appuntamenti-officina-dp";
    }

    // SMISTAMENTO NOLEGGIO
    else if (incomingMsg.includes('noleggio')) {
        risposta = "🚐 NOLEGGIO DP\n\n" +
                   "Prenota subito qui:\n" +
                   "👉 https://calendly.com/contabilita-trasportidp/noleggio-dp\n\n" +
                   "Oppure scrivici:\n" +
                   "📲 +393472733226\n📲 +393494040073";
    }

    // ALTRI SERVIZI
    else if (incomingMsg.includes('trasporto') || incomingMsg.includes('vendita')) {
        risposta = "🚛🚗 TRASPORTO / VENDITA\n\n" +
                   "Contattaci direttamente:\n" +
                   "📲 +393472733226\n📲 +393494040073";
    }

    twiml.message(risposta);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server avviato sulla porta ${PORT}`);
});
