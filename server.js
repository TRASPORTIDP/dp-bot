require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
app.use(express.urlencoded({ extended: true }));

// memoria semplice sessione
let sessioni = {};

function getSession(numero) {
    if (!sessioni[numero]) {
        sessioni[numero] = {
            step: "start",
            mezzo: null,
            dataInizio: null,
            dataFine: null,
            risultati: []
        };
    }
    return sessioni[numero];
}

// funzione AI semplice (più naturale)
function rispostaNaturale(testo) {
    return testo
        .replace("Le chiediamo gentilmente", "")
        .replace("La sua richiesta è stata", "")
        .replace("Per poterla assistere al meglio,", "")
        .replace("Può indicarci", "Scrivimi")
        .replace("Risponda con", "Scrivi");
}

// format date
function parseDate(input) {
    const parts = input.split("-");
    if (parts.length !== 2) return null;

    const start = parts[0].trim().split("/");
    const end = parts[1].trim().split("/");

    return {
        start: `2026-${start[1].padStart(2,'0')}-${start[0].padStart(2,'0')}T10:00:00`,
        end: `2026-${end[1].padStart(2,'0')}-${end[0].padStart(2,'0')}T10:00:00`
    };
}

// chiamata API
async function cercaDisponibilita(start, end) {
    try {
        const xml = `
<OTA_VehAvailRateRQ>
  <VehAvailRQCore>
    <VehRentalCore PickUpDateTime="${start}" ReturnDateTime="${end}">
      <PickUpLocation LocationCode="${process.env.CARRENTAL_LOCATION_CODE}"/>
      <ReturnLocation LocationCode="${process.env.CARRENTAL_LOCATION_CODE}"/>
    </VehRentalCore>
  </VehAvailRQCore>
</OTA_VehAvailRateRQ>`;

        const response = await axios.post(
            process.env.CARRENTAL_AVAIL_URL,
            xml,
            {
                headers: {
                    "Content-Type": "text/xml",
                    "Authorization": process.env.CARRENTAL_API_KEY
                }
            }
        );

        return response.data;
    } catch (err) {
        console.log("Errore API:", err.response?.data || err.message);
        return null;
    }
}

// parsing migliorato
function estraiVeicoli(xml) {
    const matches = [...xml.matchAll(/<Vehicle[^>]*Description="([^"]*)"[\s\S]*?RateTotalAmount="([^"]*)"/g)];

    return matches.slice(0,3).map((m, i) => ({
        nome: m[1] || "Veicolo",
        prezzo: parseFloat(m[2]).toFixed(2)
    }));
}

app.post('/whatsapp', async (req, res) => {
    const msg = (req.body.Body || "").trim().toLowerCase();
    const numero = req.body.From;

    const twiml = new MessagingResponse();
    const sessione = getSession(numero);

    console.log("NUMERO:", numero);
    console.log("MESSAGGIO:", msg);
    console.log("STEP:", sessione.step);

    // RESET
    if (msg === "reset") {
        sessioni[numero] = null;
        twiml.message("Sessione resettata ✅\nScrivimi cosa ti serve 👍");
        return res.send(twiml.toString());
    }

    // START
    if (sessione.step === "start") {
        sessione.step = "mezzo";

        twiml.message(`Ciao 👋 sono DP Rent

Dimmi che mezzo ti serve:
🚐 Furgone
🚗 Auto
🚛 Trasporto

Scrivilo direttamente 👍`);

        return res.send(twiml.toString());
    }

    // SCELTA MEZZO
    if (sessione.step === "mezzo") {
        sessione.mezzo = msg;
        sessione.step = "date";

        twiml.message(`Perfetto 👍

Indicami le date così:
👉 10/05-15/05`);

        return res.send(twiml.toString());
    }

    // DATE
    if (sessione.step === "date") {
        const parsed = parseDate(msg);

        if (!parsed) {
            twiml.message("Formato non corretto 😅\nScrivi tipo: 10/05-15/05");
            return res.send(twiml.toString());
        }

        sessione.dataInizio = parsed.start;
        sessione.dataFine = parsed.end;

        const xml = await cercaDisponibilita(parsed.start, parsed.end);

        if (!xml) {
            twiml.message("Errore collegamento gestionale ❌");
            return res.send(twiml.toString());
        }

        const veicoli = estraiVeicoli(xml);

        if (veicoli.length === 0) {
            twiml.message(`Al momento non vedo disponibilità 😔  
Ti ricontattiamo noi a breve 👍`);
            return res.send(twiml.toString());
        }

        sessione.risultati = veicoli;
        sessione.step = "scelta";

        let risposta = `Perfetto 👌\n\nHo trovato queste opzioni:\n\n`;

        veicoli.forEach((v, i) => {
            risposta += `${i+1}. ${v.nome}\n💰 € ${v.prezzo}\n\n`;
        });

        risposta += "Scrivi 1, 2 o 3 👇";

        twiml.message(risposta);
        return res.send(twiml.toString());
    }

    // SCELTA
    if (sessione.step === "scelta") {
        const scelta = parseInt(msg);

        if (!scelta || !sessione.risultati[scelta-1]) {
            twiml.message("Scrivi 1, 2 o 3 👍");
            return res.send(twiml.toString());
        }

        const v = sessione.risultati[scelta-1];

        sessione.step = "fine";

        twiml.message(`Perfetto Daniele 👌

Hai scelto:
🚐 ${v.nome}

💰 Totale: € ${v.prezzo}

Procedi qui con il pagamento 👇
https://ecommerce.nexi.it/

Ti scriviamo a breve 👍`);

        return res.send(twiml.toString());
    }

    twiml.message("Scrivi reset per ricominciare 👍");
    res.send(twiml.toString());
});

app.listen(10000, () => {
    console.log("Server avviato sulla porta 10000");
});