require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();
app.use(express.urlencoded({ extended: false }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function normalize(text) {
  return (text || "").toLowerCase().trim();
}

// 🔥 LOGICA SERVIZI (NON SBAGLIA)
function detectIntent(message) {
  if (
    message.includes("bisarca") ||
    message.includes("trasporto") ||
    message.includes("spedizione") ||
    message.includes("ritiro auto") ||
    message.includes("consegna auto")
  ) return "trasporto";

  if (
    message.includes("noleggio") ||
    message.includes("furgone") ||
    message.includes("affitto")
  ) return "noleggio";

  if (
    message.includes("officina") ||
    message.includes("tagliando") ||
    message.includes("meccanico") ||
    message.includes("riparazione")
  ) return "officina";

  if (
    message.includes("vendita") ||
    message.includes("vendere") ||
    message.includes("vendo auto") ||
    message.includes("auto usata") ||
    message.includes("comprare auto")
  ) return "vendita";

  if (
    message.includes("titolare") ||
    message.includes("operatore") ||
    message.includes("richiamare") ||
    message.includes("appuntamento")
  ) return "contatto";

  return "altro";
}

// 🔥 RISPOSTE PROFESSIONALI
function getFixedReply(intent) {
  switch (intent) {
    case "trasporto":
      return `Perfetto 🚛

Per il trasporto auto scrivici:
- luogo di ritiro
- destinazione
- tipo di veicolo

Ti facciamo subito un preventivo 👍`;

    case "noleggio":
      return `Perfetto 🚗

Puoi inviare la tua richiesta qui:
https://calendly.com/contabilita-trasportidp/noleggio-dp

Inserisci date e tipo veicolo e ti confermiamo la disponibilità 👍`;

    case "officina":
      return `Perfetto 🔧

Puoi prenotare il tuo appuntamento qui:
https://calendly.com/contabilita-trasportidp/appuntamenti-officina-dp

Se vuoi puoi scriverci anche targa e tipo di intervento 👍`;

    case "vendita":
      return `Perfetto 🚗

Per la vendita auto scrivici:
- modello di interesse
- budget
- numero di telefono

Ti ricontattiamo al più presto 👍`;

    case "contatto":
      return `Perfetto 👍

Scrivici qui la tua richiesta oppure lascia il tuo numero e ti ricontattiamo al più presto.`;

    default:
      return null;
  }
}

app.post("/whatsapp", async (req, res) => {
  const rawMessage = req.body.Body || "";
  const message = normalize(rawMessage);

  console.log("Messaggio ricevuto:", message);

  const intent = detectIntent(message);
  let reply = getFixedReply(intent);

  try {
    // 🔥 CHATGPT SOLO SE NON È UN SERVIZIO
    if (!reply) {
      const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: `Sei l'assistente WhatsApp di Trasporti DP.

Rispondi in italiano, breve e professionale.

Se il cliente non è chiaro, guidalo verso:
officina, noleggio, trasporto o vendita.

Non inventare servizi.`
          },
          {
            role: "user",
            content: rawMessage
          }
        ]
      });

      reply =
        response.output_text ||
        "Ciao 👋 Benvenuto in Trasporti DP. Scrivici pure di cosa hai bisogno 👍";
    }

    console.log("RISPOSTA BOT:", reply);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    console.error("ERRORE:", error);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("C'è un problema temporaneo, riprova tra poco.");

    res.type("text/xml");
    res.send(twiml.toString());
  }
});

app.get("/", (req, res) => {
  res.send("Bot Trasporti DP attivo");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
