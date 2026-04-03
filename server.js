require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();
app.use(express.urlencoded({ extended: false }));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// NUMERO WHATSAPP TWILIO
// Se sei ancora in sandbox lascia questo:
const FROM_NUMBER = "whatsapp:+14155238886";

// Se hai un sender WhatsApp tuo su Twilio, sostituiscilo sopra.

// NOTIFICHE
const OFFICINA_NUMBER = "whatsapp:+393287377675";

const GENERIC_NUMBERS = [
  "whatsapp:+393472733226",
  "whatsapp:+393494040073"
];

function normalize(text) {
  return (text || "").toLowerCase().trim();
}

function detectIntent(message) {
  if (
    message.includes("bisarca") ||
    message.includes("trasporto") ||
    message.includes("spedizione") ||
    message.includes("ritiro auto") ||
    message.includes("consegna auto")
  ) {
    return "trasporto";
  }

  if (
    message.includes("noleggio") ||
    message.includes("furgone") ||
    message.includes("affitto")
  ) {
    return "noleggio";
  }

  if (
    message.includes("officina") ||
    message.includes("tagliando") ||
    message.includes("meccanico") ||
    message.includes("riparazione")
  ) {
    return "officina";
  }

  if (
    message.includes("vendita") ||
    message.includes("vendere") ||
    message.includes("vendo auto") ||
    message.includes("auto usata") ||
    message.includes("comprare auto")
  ) {
    return "vendita";
  }

  if (
    message.includes("titolare") ||
    message.includes("operatore") ||
    message.includes("richiamare") ||
    message.includes("appuntamento") ||
    message.includes("parlare") ||
    message.includes("qualcuno") ||
    message.includes("contatto") ||
    message.includes("telefono")
  ) {
    return "contatto";
  }

  return "altro";
}

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

Puoi:
📞 lasciarci il tuo numero
oppure
📝 scriverci qui la tua richiesta

Ti ricontattiamo al più presto.`;

    default:
      return null;
  }
}

async function sendNotification(from, rawMessage, intent) {
  const text = `NUOVO CLIENTE 🚨

Numero: ${from}
Messaggio: ${rawMessage}
Servizio: ${intent}`;

  if (intent === "officina") {
    await client.messages.create({
      from: FROM_NUMBER,
      to: OFFICINA_NUMBER,
      body: text
    });
    return;
  }

  for (const number of GENERIC_NUMBERS) {
    await client.messages.create({
      from: FROM_NUMBER,
      to: number,
      body: text
    });
  }
}

app.post("/whatsapp", async (req, res) => {
  const rawMessage = req.body.Body || "";
  const from = req.body.From || "";
  const message = normalize(rawMessage);

  console.log("Messaggio ricevuto:", message);

  const intent = detectIntent(message);
  let reply = getFixedReply(intent);

  try {
    if (!reply) {
      const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: `Sei l'assistente WhatsApp di Trasporti DP.

Rispondi sempre in italiano.
Tono: naturale, breve, professionale e utile.

I servizi dell'azienda sono solo:
- officina
- noleggio auto e furgoni
- trasporto auto
- vendita auto

Regole:
- non inventare servizi
- non inventare disponibilità
- se il cliente saluta, rispondi con un messaggio di benvenuto
- se il cliente scrive un messaggio generico, guidalo
- se non è chiaro, chiedi se gli serve officina, noleggio, trasporto o vendita

Se il cliente scrive cose come:
"ciao"
"salve"
"buongiorno"
"mi aiutate?"
"vorrei informazioni"
"ho bisogno di aiuto"

puoi rispondere così:

"Ciao 👋 Benvenuto in Trasporti DP.

Possiamo aiutarti con:
- officina
- noleggio
- trasporto auto
- vendita auto

Scrivici pure di cosa hai bisogno 👍"`
          },
          {
            role: "user",
            content: rawMessage
          }
        ]
      });

      reply =
        response.output_text ||
        `Ciao 👋 Benvenuto in Trasporti DP.

Possiamo aiutarti con:
- officina
- noleggio
- trasporto auto
- vendita auto

Scrivici pure di cosa hai bisogno 👍`;
    }

    console.log("RISPOSTA BOT:", reply);

    try {
      await sendNotification(from, rawMessage, intent);
      console.log("Notifica inviata");
    } catch (notifyError) {
      console.error("ERRORE NOTIFICA:", notifyError);
    }

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    console.error("ERRORE:", error);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(
      "Ciao 👋 Al momento c'è un problema temporaneo. Scrivici se ti serve officina, noleggio, trasporto o vendita."
    );

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
