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

// 📲 NUMERI
const OFFICINA_NUMBER = "whatsapp:+393287377675";

const GENERIC_NUMBERS = [
  "whatsapp:+393472733226",
  "whatsapp:+393494040073"
];

// 📲 NUMERO TWILIO (IMPORTANTE METTILO GIUSTO)
const FROM_NUMBER = "whatsapp:+390744817108";

// 🔍 NORMALIZZA
function normalize(text) {
  return (text || "").toLowerCase().trim();
}

// 🔍 RICONOSCIMENTO
function detectIntent(message) {
  if (
    message.includes("bisarca") ||
    message.includes("trasporto")
  ) return "trasporto";

  if (
    message.includes("noleggio") ||
    message.includes("furgone")
  ) return "noleggio";

  if (
    message.includes("officina") ||
    message.includes("tagliando") ||
    message.includes("meccanico")
  ) return "officina";

  if (
    message.includes("vendita") ||
    message.includes("vendere")
  ) return "vendita";

  if (
    message.includes("parlare") ||
    message.includes("titolare")
  ) return "contatto";

  return "altro";
}

// 💬 RISPOSTE
function getFixedReply(intent) {
  switch (intent) {
    case "trasporto":
      return `Perfetto 🚛

Per il trasporto auto scrivici:
- luogo ritiro
- destinazione
- tipo veicolo`;

    case "noleggio":
      return `Perfetto 🚗

Prenota qui:
https://calendly.com/contabilita-trasportidp/noleggio-dp`;

    case "officina":
      return `Perfetto 🔧

Prenota qui:
https://calendly.com/contabilita-trasportidp/appuntamenti-officina-dp`;

    case "vendita":
      return `Perfetto 🚗

Scrivici modello e budget 👍`;

    case "contatto":
      return `Perfetto 👍

Lascia il tuo numero e ti richiamiamo`;

    default:
      return null;
  }
}

// 📲 INVIO NOTIFICHE INTELLIGENTE
async function sendNotification(from, message, intent) {
  const text = `NUOVO CLIENTE 🚨

Numero: ${from}
Messaggio: ${message}
Servizio: ${intent}`;

  // 🔧 OFFICINA → solo 1 numero
  if (intent === "officina") {
    await client.messages.create({
      from: FROM_NUMBER,
      to: OFFICINA_NUMBER,
      body: text
    });
  } else {
    // 🚗 TUTTO IL RESTO → 2 numeri
    for (const number of GENERIC_NUMBERS) {
      await client.messages.create({
        from: FROM_NUMBER,
        to: number,
        body: text
      });
    }
  }
}

app.post("/whatsapp", async (req, res) => {
  const rawMessage = req.body.Body || "";
  const from = req.body.From || "";
  const message = normalize(rawMessage);

  const intent = detectIntent(message);
  let reply = getFixedReply(intent);

  try {
    // 🤖 CHATGPT SOLO SE NON SERVIZIO
    if (!reply) {
      const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `Cliente scrive: ${rawMessage}. Rispondi breve e professionale.`
      });

      reply = response.output_text || "Come possiamo aiutarti?";
    }

    // 📲 NOTIFICA
    await sendNotification(from, rawMessage, intent);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);

    res.type("text/xml");
    res.send(twiml.toString());

  } catch (error) {
    console.error(error);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Errore temporaneo");

    res.type("text/xml");
    res.send(twiml.toString());
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server attivo");
});
