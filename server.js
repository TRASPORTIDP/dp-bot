require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.urlencoded({ extended: false }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

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
    message.includes("appuntamento") ||
    message.includes("parlare") ||
    message.includes("qualcuno") ||
    message.includes("contatto") ||
    message.includes("telefono")
  ) return "contatto";

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

async function sendNotificationEmail({ from, rawMessage, intent, reply }) {
  const recipients = (process.env.NOTIFY_EMAILS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (!recipients.length) return;

  const subject = `Nuovo messaggio WhatsApp - ${intent.toUpperCase()}`;

  const text = `
Nuovo messaggio ricevuto dal bot WhatsApp

Numero cliente: ${from}
Servizio rilevato: ${intent}

Messaggio cliente:
${rawMessage}

Risposta bot:
${reply}
`;

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: recipients.join(", "),
    subject,
    text
  });
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
      await sendNotificationEmail({
        from,
        rawMessage,
        intent,
        reply
      });
      console.log("Notifica email inviata");
    } catch (mailError) {
      console.error("ERRORE EMAIL:", mailError);
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
