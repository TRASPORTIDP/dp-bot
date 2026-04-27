require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const crypto = require("crypto");
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const parser = new XMLParser();
const PORT = process.env.PORT || 3000;

// ===== MEMORY =====
const sessions = {};
const requests = {};

// ===== UTILS =====
function dpCode() {
  return "DP" + Math.floor(100000 + Math.random() * 900000);
}

function twiml(msg) {
  const r = new twilio.twiml.MessagingResponse();
  r.message(msg);
  return r.toString();
}

async function sendInternal(msg) {
  const numbers = process.env.INTERNAL_GENERAL_NUMBERS.split(",");
  for (let n of numbers) {
    try {
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: "whatsapp:" + n,
        body: msg
      });
    } catch (e) {
      console.log("Errore invio interno:", e.message);
    }
  }
}

// ===== NEXI =====
function createNexiLink(code, amount) {
  if (!process.env.NEXI_ALIAS) return null;

  const importo = Math.round(amount * 100);

  const macString =
    `codTrans=${code}` +
    `divisa=EUR` +
    `importo=${importo}` +
    process.env.NEXI_MAC_KEY;

  const mac = crypto.createHash("sha1").update(macString).digest("hex");

  return `https://int-ecommerce.nexi.it/ecomm/ecomm/DispatcherServlet?alias=${process.env.NEXI_ALIAS}&importo=${importo}&divisa=EUR&codTrans=${code}&url=${process.env.APP_BASE_URL}/nexi/result&url_back=${process.env.APP_BASE_URL}/nexi/back&mac=${mac}`;
}

// ===== SOAP =====
async function createReservation(data) {
  try {
    const xml = `
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.opentravel.org/OTA/2003/05">
<SOAP-ENV:Body>
<ns1:OTA_VehResRQ>
<POS>
<Source>
<RequestorID Type="29" ID="${process.env.CARRENTAL_UID}" MessagePassword="${process.env.CARRENTAL_API_KEY}"/>
</Source>
</POS>

<VehResRQCore>
<VehRentalCore PickUpDateTime="${data.pickup}" ReturnDateTime="${data.return}">
<PickUpLocation LocationCode="${process.env.CARRENTAL_LOCATION_CODE}"/>
<ReturnLocation LocationCode="${process.env.CARRENTAL_LOCATION_CODE}"/>
</VehRentalCore>

<VehPref>
<VehMakeModel Code="${data.vehicleCode}"/>
</VehPref>

<Customer>
<Primary>
<PersonName>
<GivenName>${data.name}</GivenName>
<Surname>${data.surname}</Surname>
</PersonName>

<Document DocType="5" DocID="${data.docNumber}" DocIssueAuthority="${data.docAuthority}" ExpireDate="${data.docExpire}"/>

<Telephone PhoneNumber="${data.phone}"/>
<Email>${data.email}</Email>

<Address>
<AddressLine>${data.address}</AddressLine>
<CityName>IT</CityName>
<CountryName>IT</CountryName>
</Address>

</Primary>
</Customer>

<TotalCharge CurrencyCode="EUR" EstimatedTotalAmount="${data.amount}"/>
</VehResRQCore>

<VehResRQInfo ResStatus="Book"/>
</ns1:OTA_VehResRQ>
</SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

    const res = await axios.post(process.env.CARRENTAL_RES_URL, xml, {
      headers: { "Content-Type": "text/xml" },
      timeout: 15000
    });

    const parsed = parser.parse(res.data);

    const status =
      parsed["SOAP-ENV:Envelope"]?.["SOAP-ENV:Body"]?.["ns1:OTA_VehResRS"]?.["ns1:VehResRSCore"]?.["VehReservation"]?.["@_ReservationStatus"];

    return status || "ERROR";
  } catch (err) {
    console.log("SOAP ERROR:", err.message);
    return "ERROR";
  }
}

// ===== BOT =====
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;
  const text = (req.body.Body || "").trim();
  const msg = text.toLowerCase();

  if (!sessions[from]) {
    sessions[from] = { step: "menu", data: {} };
  }

  const s = sessions[from];

  // RESET
  if (msg === "menu" || msg === "reset") {
    sessions[from] = { step: "menu", data: {} };
    return res.send(twiml("Menu:\n1 Officina\n2 Noleggio\n3 Vendita\n4 Trasporto"));
  }

  // ===== MENU =====
  if (s.step === "menu") {
    if (msg === "2") {
      s.step = "vehicle";
      return res.send(twiml("Mezzo:\n1 Auto\n2 Furgone\n3 9 posti"));
    }
    return res.send(twiml("Scrivi 2 per noleggio"));
  }

  // ===== MEZZO =====
  if (s.step === "vehicle") {
    s.data.vehicleCode =
      msg === "2"
        ? process.env.CARRENTAL_CODE_FURGONE
        : process.env.CARRENTAL_CODE_AUTO;

    s.step = "pickup";
    return res.send(twiml("Data ritiro (YYYY-MM-DD HH:mm)"));
  }

  if (s.step === "pickup") {
    s.data.pickup = new Date(text).toISOString();
    s.step = "return";
    return res.send(twiml("Data riconsegna"));
  }

  if (s.step === "return") {
    s.data.return = new Date(text).toISOString();
    s.step = "km";
    return res.send(twiml("Km previsti"));
  }

  if (s.step === "km") {
    s.data.km = text;

    const days = Math.ceil(
      (new Date(s.data.return) - new Date(s.data.pickup)) / (1000 * 60 * 60 * 24)
    );

    s.data.amount = days * 70;
    s.data.code = dpCode();

    s.step = "confirm";

    return res.send(twiml(
`Importo €${s.data.amount}
Codice ${s.data.code}

Scrivi CONFERMO`
    ));
  }

  // ===== CONFERMA =====
  if (s.step === "confirm" && msg === "confermo") {
    s.step = "name";
    return res.send(twiml("Nome"));
  }

  // ===== DATI =====
  if (s.step === "name") {
    s.data.name = text;
    s.step = "surname";
    return res.send(twiml("Cognome"));
  }

  if (s.step === "surname") {
    s.data.surname = text;
    s.step = "email";
    return res.send(twiml("Email"));
  }

  if (s.step === "email") {
    s.data.email = text;
    s.step = "address";
    return res.send(twiml("Indirizzo"));
  }

  if (s.step === "address") {
    s.data.address = text;
    s.step = "doc";
    return res.send(twiml("Numero documento"));
  }

  if (s.step === "doc") {
    s.data.docNumber = text;
    s.step = "docExpire";
    return res.send(twiml("Scadenza documento (YYYY-MM-DD)"));
  }

  if (s.step === "docExpire") {
    s.data.docExpire = text;
    s.step = "docAuth";
    return res.send(twiml("Ente rilascio"));
  }

  if (s.step === "docAuth") {
    s.data.docAuthority = text;
    s.data.phone = from.replace("whatsapp:", "");

    // ===== CREA CONTRATTO =====
    const status = await createReservation(s.data);

    await sendInternal(`NUOVO CONTRATTO
Codice ${s.data.code}
Stato API: ${status}
Cliente: ${s.data.name} ${s.data.surname}
Importo: €${s.data.amount}`);

    const payLink = createNexiLink(s.data.code, s.data.amount);

    sessions[from] = null;

    if (status !== "Reserved") {
      return res.send(twiml("Errore creazione contratto. Ti contattiamo."));
    }

    return res.send(twiml(
`Contratto creato ✔
Importo €${s.data.amount}

Paga qui:
${payLink}`
    ));
  }

  return res.send(twiml("Scrivi MENU"));
});

// ===== NEXI =====
app.get("/nexi/result", (req, res) => {
  res.send("Pagamento completato");
});

app.get("/nexi/back", (req, res) => {
  res.send("Pagamento annullato");
});

app.listen(PORT, () => console.log("DP BOT ATTIVO"));
