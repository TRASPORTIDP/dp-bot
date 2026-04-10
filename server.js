require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const sessions = {};

// CONFIG
const SEDE_UID = "57529906";

// API CALL
async function getAvailability(type, start, end) {
  try {
    const res = await axios.get(`https://carrentalsoftware.myappy.it/api/availability`, {
      params: {
        sede_uid: SEDE_UID,
        tipo: type,
        dal: start,
        al: end
      }
    });

    return res.data || [];
  } catch (e) {
    console.log("API ERROR:", e.message);
    return [];
  }
}

// NORMALIZZAZIONE
function normalize(text) {
  return text.toLowerCase();
}

// ROUTE TEST
app.get('/', (req, res) => {
  res.send('Server WhatsApp DP attivo ✅');
});

// WEBHOOK
app.post('/whatsapp', async (req, res) => {
  const msg = normalize(req.body.Body || '');
  const from = req.body.From;

  if (!sessions[from]) {
    sessions[from] = { state: 'start' };
  }

  const session = sessions[from];
  const twiml = new twilio.twiml.MessagingResponse();

  // RESET
  if (msg === 'reset') {
    sessions[from] = { state: 'start' };
    twiml.message("Sessione resettata. Scrivi 2 per noleggio.");
    return res.send(twiml.toString());
  }

  // STEP 1
  if (session.state === 'start') {
    twiml.message(
`Ciao 👋
Seleziona servizio:

1️⃣ Officina
2️⃣ Noleggio`
    );
    session.state = 'menu';
    return res.send(twiml.toString());
  }

  // MENU
  if (session.state === 'menu') {
    if (msg === '2') {
      session.state = 'vehicle';
      twiml.message("Che mezzo ti serve? (auto, furgone, pulmino)");
      return res.send(twiml.toString());
    }
  }

  // SCELTA MEZZO
  if (session.state === 'vehicle') {
    session.vehicle = msg;
    session.state = 'date';
    twiml.message("Inserisci date: es. 12/05 - 15/05");
    return res.send(twiml.toString());
  }

  // DATE
  if (session.state === 'date') {
    const parts = msg.split('-');

    if (parts.length !== 2) {
      twiml.message("Formato errato. Usa 10/05 - 15/05");
      return res.send(twiml.toString());
    }

    const start = parts[0].trim();
    const end = parts[1].trim();

    session.start = start;
    session.end = end;

    const results = await getAvailability(session.vehicle, start, end);

    if (!results || results.length === 0) {
      twiml.message(
`❌ Nessuna disponibilità trovata.

La richiesta è stata inoltrata allo staff.`
      );
      session.state = 'start';
      return res.send(twiml.toString());
    }

    session.results = results;
    session.state = 'vehicle_choice';

    let text = "Abbiamo trovato queste disponibilità:\n\n";

    results.slice(0, 3).forEach((v, i) => {
      text += `${i + 1}️⃣ ${v.nome || 'Mezzo'} - € ${v.prezzo || '---'}\n`;
    });

    text += "\nRispondi con il numero del mezzo (1-2-3)";

    twiml.message(text);
    return res.send(twiml.toString());
  }

  // SCELTA MEZZO FINALE
  if (session.state === 'vehicle_choice') {
    const index = parseInt(msg) - 1;
    const v = session.results[index];

    if (!v) {
      twiml.message("Selezione non valida.");
      return res.send(twiml.toString());
    }

    twiml.message(
`✅ Prenotazione registrata

${v.nome}
Periodo: ${session.start} - ${session.end}

Verrai ricontattato dal nostro staff.`
    );

    session.state = 'start';
    return res.send(twiml.toString());
  }

  res.send(twiml.toString());
});

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server avviato su porta', PORT);
});
