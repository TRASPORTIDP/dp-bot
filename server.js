const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

function normalize(text) {
  return (text || "").toLowerCase().trim();
}

app.post("/whatsapp", (req, res) => {
  const message = normalize(req.body.Body || "");
  console.log("Messaggio ricevuto:", message);

  let reply = "Dimmi pure 👍 ti serve officina, noleggio, trasporto o vendita?";

  if (
    message.includes("bisarca") ||
    message.includes("trasporto") ||
    message.includes("spedizione") ||
    message.includes("ritiro auto") ||
    message.includes("consegna auto")
  ) {
    reply = `Perfetto 🚛

Per il trasporto auto scrivici:
- luogo ritiro
- destinazione
- tipo veicolo

Ti facciamo subito un preventivo 👍`;
  } else if (
    message.includes("noleggio") ||
    message.includes("furgone") ||
    message.includes("affitto")
  ) {
    reply = `Perfetto 🚗

Puoi inviare la tua richiesta qui:
https://calendly.com/contabilita-trasportidp/noleggio-dp

Inserisci date e tipo veicolo e ti confermiamo la disponibilità 👍`;
  } else if (
    message.includes("officina") ||
    message.includes("tagliando") ||
    message.includes("meccanico") ||
    message.includes("riparazione")
  ) {
    reply = `Perfetto 🔧

Puoi prenotare il tuo appuntamento qui:
https://calendly.com/contabilita-trasportidp/appuntamenti-officina-dp

Se vuoi puoi scriverci anche targa e tipo di intervento 👍`;
  } else if (
    message.includes("vendita") ||
    message.includes("vendere") ||
    message.includes("vendo auto") ||
    message.includes("auto usata") ||
    message.includes("comprare auto")
  ) {
    reply = `Perfetto 🚗

Per la vendita auto scrivici:
- modello di interesse
- budget
- numero di telefono

Ti ricontattiamo al più presto 👍`;
  } else if (
    message.includes("titolare") ||
    message.includes("operatore") ||
    message.includes("richiamare") ||
    message.includes("appuntamento")
  ) {
    reply = `Perfetto 👍

Scrivici qui la tua richiesta oppure lascia il tuo numero e ti ricontattiamo al più presto.`;
  }

  console.log("RISPOSTA BOT:", reply);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  res.type("text/xml");
  res.send(twiml.toString());
});

app.get("/", (req, res) => {
  res.send("Bot Trasporti DP attivo");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
