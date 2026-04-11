require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues: true
});

const TWILIO_WHATSAPP_NUMBER = 'whatsapp:+390744817108';

const OFFICINA_NUMBERS = ['whatsapp:+393287377675'];

const GENERAL_NUMBERS = [
  'whatsapp:+393472733226',
  'whatsapp:+393494040073'
];

const LINK_OFFICINA =
  'https://calendly.com/contabilita-trasportidp/appuntamenti-officina-dp';

const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');

// =========================
// SESSIONI SU FILE
// =========================
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

function loadSessionsFromFile() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return {};
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.error('Errore caricamento sessions.json:', error.message);
    return {};
  }
}

function saveSessionsToFile() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (error) {
    console.error('Errore salvataggio sessions.json:', error.message);
  }
}

const sessions = loadSessionsFromFile();

// =========================
// NEXI
// =========================
const NEXI_ENV = (process.env.NEXI_ENV || 'prod').toLowerCase();
const NEXI_API_KEY_ALIAS = process.env.NEXI_ALIAS || '';
const NEXI_MAC_KEY = process.env.NEXI_MAC_KEY || '';
const NEXI_TIMEOUT_HOURS = parseInt(process.env.NEXI_TIMEOUT_HOURS || '4', 10);

const NEXI_BASE_URL =
  NEXI_ENV === 'test'
    ? 'https://int-ecommerce.nexi.it'
    : 'https://ecommerce.nexi.it';

const NEXI_PAYMAIL_ENDPOINT = `${NEXI_BASE_URL}/ecomm/api/bo/richiestaPayMail`;

function canUseNexi() {
  return Boolean(NEXI_API_KEY_ALIAS && NEXI_MAC_KEY);
}

function generateNexiRequestMac({ apiKey, codiceTransazione, importo, timeStamp }) {
  const source =
    `apiKey=${apiKey}` +
    `codiceTransazione=${codiceTransazione}` +
    `importo=${importo}` +
    `timeStamp=${timeStamp}` +
    NEXI_MAC_KEY;

  return crypto.createHash('sha1').update(source).digest('hex');
}

function generateNexiResponseMac({ esito, idOperazione, timeStamp }) {
  const source =
    `esito=${esito}` +
    `idOperazione=${idOperazione}` +
    `timeStamp=${timeStamp}` +
    NEXI_MAC_KEY;

  return crypto.createHash('sha1').update(source).digest('hex');
}

async function createNexiPayMailLink({ amountCents, description, customerWhatsapp }) {
  const codiceTransazione = buildShortOrderId('DP');
  const timeStamp = Date.now().toString();

  const payload = {
    apiKey: NEXI_API_KEY_ALIAS,
    codiceTransazione,
    importo: String(amountCents),
    timeStamp,
    mac: generateNexiRequestMac({
      apiKey: NEXI_API_KEY_ALIAS,
      codiceTransazione,
      importo: String(amountCents),
      timeStamp
    }),
    timeout: String(NEXI_TIMEOUT_HOURS),
    url: `${APP_BASE_URL}/nexi/result`,
    parametriAggiuntivi: {
      source: 'whatsapp_bot',
      description: description || '',
      customer_whatsapp: customerWhatsapp || ''
    }
  };

  const response = await fetch(NEXI_PAYMAIL_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) throw new Error(`Errore HTTP Nexi: ${response.status}`);
  if (!data || !data.esito) throw new Error('Risposta Nexi non valida');

  if (data.esito !== 'OK') {
    const detail =
      data?.errore?.messaggio ||
      data?.errore?.description ||
      data?.errore?.codice ||
      'Operazione Nexi non riuscita';
    throw new Error(detail);
  }

  if (!data.payMailUrl) throw new Error('Link pagamento Nexi non restituito');

  if (data.idOperazione && data.timeStamp && data.mac) {
    const expectedMac = generateNexiResponseMac({
      esito: data.esito,
      idOperazione: data.idOperazione,
      timeStamp: data.timeStamp
    });

    if (expectedMac !== data.mac) {
      throw new Error('MAC risposta Nexi non valido');
    }
  }

  return {
    codiceTransazione,
    payMailUrl: data.payMailUrl,
    idOperazione: data.idOperazione || ''
  };
}

// =========================
// GESTIONALE CAR RENTAL
// =========================
const CARRENTAL_UID = process.env.CARRENTAL_UID || '';
const CARRENTAL_API_KEY = process.env.CARRENTAL_API_KEY || '';
const CARRENTAL_PING_URL =
  process.env.CARRENTAL_PING_URL || 'https://carrentalsoftware.myappy.it/web/ota/';
const CARRENTAL_AVAIL_URL =
  process.env.CARRENTAL_AVAIL_URL || 'https://crsbrk00.myappy.it/web/ota/';
const CARRENTAL_LOCATION_CODE =
  process.env.CARRENTAL_LOCATION_CODE || '57529906';

function canUseCarRental() {
  return Boolean(
    CARRENTAL_UID &&
      CARRENTAL_API_KEY &&
      CARRENTAL_PING_URL &&
      CARRENTAL_AVAIL_URL &&
      CARRENTAL_LOCATION_CODE
  );
}

function buildSoapAuthBlock() {
  return `
    <POS>
      <Source>
        <RequestorID Type="29" ID="${CARRENTAL_UID}" MessagePassword="${CARRENTAL_API_KEY}"/>
      </Source>
    </POS>
  `;
}

function toIsoDateTimeLocalStart(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}T09:00:00`;
}

function toIsoDateTimeLocalEnd(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}T18:00:00`;
}

function safeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function findFirstByKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;

  for (const key of Object.keys(obj)) {
    if (keys.includes(key)) return obj[key];
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      const found = findFirstByKeys(val, keys);
      if (found) return found;
    }
  }

  return null;
}

function normalizeVehicleLabel(item) {
  const vehAvailCore = item?.VehAvailCore || item?.['ns1:VehAvailCore'] || {};
  const vehRentalCore = item?.VehRentalCore || item?.['ns1:VehRentalCore'] || {};
  const vehicle = item?.Vehicle || item?.['ns1:Vehicle'] || {};
  const vehMakeModel = item?.VehMakeModel || item?.['ns1:VehMakeModel'] || {};
  const vehClass = item?.VehClass || item?.['ns1:VehClass'] || {};
  const vehType = item?.VehType || item?.['ns1:VehType'] || {};

  const code =
    vehMakeModel?.['@_Code'] ||
    vehicle?.['@_Code'] ||
    vehClass?.['@_Code'] ||
    vehType?.['@_Code'] ||
    '';

  const name =
    vehMakeModel?.['@_Name'] ||
    vehicle?.['@_Name'] ||
    vehClass?.['@_Name'] ||
    vehType?.['@_VehicleCategory'] ||
    code ||
    'Veicolo disponibile';

  const totalCharge =
    vehAvailCore?.TotalCharge ||
    vehRentalCore?.TotalCharge ||
    item?.TotalCharge ||
    findFirstByKeys(item, ['TotalCharge', 'ns1:TotalCharge']) ||
    {};

  const estimatedTotalAmount =
    totalCharge?.['@_EstimatedTotalAmount'] ||
    totalCharge?.['@_RateTotalAmount'] ||
    totalCharge?.EstimatedTotalAmount ||
    totalCharge?.RateTotalAmount ||
    null;

  return {
    code: String(code || '').trim(),
    name: String(name || 'Veicolo disponibile').trim(),
    estimatedTotalAmount: estimatedTotalAmount ? Number(estimatedTotalAmount) : null,
    raw: item
  };
}

function getRequestedVehicleCodes(userText) {
  const q = normalize(userText);

  if (!q) return [];

  if (q.includes('pulmino') || q.includes('9 posti') || q.includes('8 posti')) {
    return ['P2-9P'];
  }

  if (q.includes('furgone') || q.includes('van')) {
    return ['F1-VAN', 'F2-PC'];
  }

  if (q.includes('auto') || q.includes('macchina') || q.includes('vettura')) {
    return ['A1', 'A2', 'A3'];
  }

  return [];
}

function matchVehicleAgainstUserText(vehicle, userText) {
  const requestedCodes = getRequestedVehicleCodes(userText);
  const codeUpper = String(vehicle.code || '').toUpperCase();

  if (requestedCodes.length > 0) {
    return requestedCodes.some((c) => codeUpper.startsWith(c));
  }

  return true;
}

async function getCarRentalAvailability({ vehicleText, startDate, endDate }) {
  if (!canUseCarRental()) {
    throw new Error('Gestionale non configurato');
  }

  const pickUpDateTime = toIsoDateTimeLocalStart(startDate);
  const returnDateTime = toIsoDateTimeLocalEnd(endDate);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.opentravel.org/OTA/2003/05">
  <SOAP-ENV:Body>
    <ns1:OTA_VehAvailRateRQ>
      ${buildSoapAuthBlock()}
      <VehAvailRQCore PickUpDateTime="${pickUpDateTime}" ReturnDateTime="${returnDateTime}">
        <PickUpLocation LocationCode="${CARRENTAL_LOCATION_CODE}"/>
        <ReturnLocation LocationCode="${CARRENTAL_LOCATION_CODE}"/>
      </VehAvailRQCore>
    </ns1:OTA_VehAvailRateRQ>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

  const response = await fetch(CARRENTAL_AVAIL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8'
    },
    body: xml
  });

  const xmlText = await response.text();

  if (!response.ok) {
    throw new Error(`Errore HTTP gestionale: ${response.status}`);
  }

  const parsed = xmlParser.parse(xmlText);

  const body =
    parsed?.['SOAP-ENV:Envelope']?.['SOAP-ENV:Body'] ||
    parsed?.Envelope?.Body ||
    parsed?.['soap:Envelope']?.['soap:Body'] ||
    parsed?.['soapenv:Envelope']?.['soapenv:Body'];

  if (!body) {
    throw new Error('Risposta SOAP non valida');
  }

  const availRs =
    body?.['ns1:OTA_VehAvailRateRS'] ||
    body?.OTA_VehAvailRateRS ||
    body?.['OTA_VehAvailRateRS'];

  if (!availRs) {
    const errBlock =
      findFirstByKeys(body, ['Errors', 'ns1:Errors']) ||
      findFirstByKeys(body, ['Error', 'ns1:Error']);

    if (errBlock) {
      throw new Error(JSON.stringify(errBlock));
    }

    throw new Error('Risposta disponibilità non riconosciuta');
  }

  const errors = availRs?.Errors || availRs?.['ns1:Errors'];
  if (errors) {
    throw new Error(JSON.stringify(errors));
  }

  const vehAvailsRaw =
    findFirstByKeys(availRs, ['VehAvail', 'ns1:VehAvail']) || [];

  const vehicles = safeArray(vehAvailsRaw).map(normalizeVehicleLabel);
  const filtered = vehicles.filter((v) => matchVehicleAgainstUserText(v, vehicleText));
  const usable = (filtered.length ? filtered : vehicles).filter(
    (v) => v.estimatedTotalAmount !== null
  );

  usable.sort((a, b) => {
    if (a.estimatedTotalAmount === null && b.estimatedTotalAmount === null) return 0;
    if (a.estimatedTotalAmount === null) return 1;
    if (b.estimatedTotalAmount === null) return -1;
    return a.estimatedTotalAmount - b.estimatedTotalAmount;
  });

  return {
    rawXml: xmlText,
    vehicles: usable
  };
}

// =========================
// PREZZI FALLBACK
// =========================
const IVA_RATE = 0.22;
const SOSTA_PRICE_PER_DAY_CENTS = parseInt(process.env.SOSTA_PRICE_PER_DAY_CENTS || '2000', 10);
const SOSTA_CORRENTE_EXTRA_CENTS = parseInt(process.env.SOSTA_CORRENTE_EXTRA_CENTS || '500', 10);
const SOSTA_ACQUA_EXTRA_CENTS = parseInt(process.env.SOSTA_ACQUA_EXTRA_CENTS || '300', 10);

const NOLEGGIO_PRICE_PER_DAY_EUR = parseFloat(process.env.NOLEGGIO_PRICE_PER_DAY_EUR || '70');
const NOLEGGIO_KM_INCLUDED_PER_DAY = parseInt(process.env.NOLEGGIO_KM_INCLUDED_PER_DAY || '150', 10);
const NOLEGGIO_EXTRA_KM_EUR = parseFloat(process.env.NOLEGGIO_EXTRA_KM_EUR || '0.15');
const NOLEGGIO_DEPOSIT_CENTS = parseInt(process.env.NOLEGGIO_DEPOSIT_CENTS || '50000', 10);

// =========================
// UTILITY
// =========================
function cleanText(text) {
  return (text || '').trim();
}

function normalize(text) {
  return cleanText(text).toLowerCase();
}

function formatCustomerName(profileName) {
  const name = cleanText(profileName);
  return name || 'Cliente';
}

function formatWhatsappNumber(number) {
  return cleanText(number) || '-';
}

function eurosFromCents(cents) {
  return (Number(cents || 0) / 100).toFixed(2).replace('.', ',');
}

function formatEuroNumber(value) {
  return Number(value || 0).toFixed(2).replace('.', ',');
}

function euroToCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function yesNoLabel(value) {
  const msg = normalize(value);
  if (['si', 'sì', 'yes', 'y', 'ok', 'certo'].includes(msg)) return 'SÌ';
  if (['no', 'n'].includes(msg)) return 'NO';
  return cleanText(value) || '-';
}

function isYes(value) {
  return yesNoLabel(value) === 'SÌ';
}

function buildShortOrderId(prefix = 'DP') {
  const ts = Date.now().toString().slice(-10);
  const rnd = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${prefix}${ts}${rnd}`.slice(0, 18);
}

function formatDateIT(dateObj) {
  const day = String(dateObj.getDate()).padStart(2, '0');
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const year = dateObj.getFullYear();
  return `${day}/${month}/${year}`;
}

function toLocalMidday(dateObj) {
  return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), 12, 0, 0, 0);
}

function diffDaysInclusive(startDate, endDate) {
  const ms = toLocalMidday(endDate) - toLocalMidday(startDate);
  const days = Math.round(ms / (1000 * 60 * 60 * 24)) + 1;
  return days > 0 ? days : null;
}

function parseItalianDate(dayStr, monthStr, yearStr) {
  const day = parseInt(dayStr, 10);
  const month = parseInt(monthStr, 10);
  let year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();

  if (String(year).length === 2) year += 2000;
  if (!day || !month || !year) return null;

  const d = new Date(year, month - 1, day, 12, 0, 0, 0);

  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }

  return d;
}

function normalizeDateRangeText(text) {
  return normalize(text)
    .replace(/\s+/g, ' ')
    .replace(/\bdal\b/g, '')
    .replace(/\balla\b/g, '')
    .replace(/\bal\b/g, '-')
    .replace(/\ba\b/g, '-')
    .replace(/\bto\b/g, '-')
    .replace(/\s*-\s*/g, '-')
    .trim();
}

function extractDateRange(text) {
  const raw = normalizeDateRangeText(text);

  const regex =
    /(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\s*-\s*(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/;

  const match = raw.match(regex);
  if (!match) return null;

  const start = parseItalianDate(match[1], match[2], match[3]);
  let end = parseItalianDate(match[4], match[5], match[6]);

  if (!start || !end) return null;

  if (!match[6] && end < start) {
    end = parseItalianDate(match[4], match[5], String(start.getFullYear() + 1));
  }

  if (!end || end < start) return null;

  const days = diffDaysInclusive(start, end);
  if (!days) return null;

  return {
    startDate: start,
    endDate: end,
    startLabel: formatDateIT(start),
    endLabel: formatDateIT(end),
    days
  };
}

function computeSostaAmountCents(answers) {
  const dateRange = extractDateRange(answers[1]);
  const giorni = dateRange?.days || 1;
  const corrente = isYes(answers[2]);
  const acqua = isYes(answers[3]);

  let total = giorni * SOSTA_PRICE_PER_DAY_CENTS;
  if (corrente) total += SOSTA_CORRENTE_EXTRA_CENTS;
  if (acqua) total += SOSTA_ACQUA_EXTRA_CENTS;

  return {
    giorni,
    corrente,
    acqua,
    totalCents: total,
    startLabel: dateRange?.startLabel || '',
    endLabel: dateRange?.endLabel || ''
  };
}

function computeNoleggioFallback(answers) {
  const dateRange = extractDateRange(answers[1]);
  if (!dateRange) return null;

  const giorni = dateRange.days;
  const baseTotalExVat = NOLEGGIO_PRICE_PER_DAY_EUR * giorni;
  const baseTotalIncVat = baseTotalExVat * (1 + IVA_RATE);
  const kmIncluded = NOLEGGIO_KM_INCLUDED_PER_DAY * giorni;
  const extraKmExVat = NOLEGGIO_EXTRA_KM_EUR;

  return {
    giorni,
    startLabel: dateRange.startLabel,
    endLabel: dateRange.endLabel,
    baseTotalExVat,
    baseTotalIncVat,
    kmIncluded,
    extraKmExVat
  };
}

// =========================
// INTENT
// =========================
function detectIntent(text) {
  const msg = normalize(text);

  if (
    msg.includes('titolare') ||
    msg.includes('responsabile') ||
    msg.includes('operatore') ||
    msg.includes('contatto diretto') ||
    msg.includes('parlare con qualcuno') ||
    msg.includes('parlare con una persona') ||
    msg.includes('parlare con il titolare') ||
    msg.includes('parlare con un responsabile') ||
    msg.includes('parlare con un operatore') ||
    msg.includes('essere ricontattato') ||
    msg.includes('farmi chiamare') ||
    msg.includes('mi richiama') ||
    msg.includes('richiamare') ||
    msg.includes('richiesta particolare') ||
    msg.includes('vorrei parlare con') ||
    msg.includes('voglio parlare con')
  ) {
    return 'contatto_diretto';
  }

  if (
    msg.includes('officina') ||
    msg.includes('tagliando') ||
    msg.includes('riparazione') ||
    msg.includes('guasto') ||
    msg.includes('meccanico') ||
    msg.includes('diagnosi') ||
    msg.includes('revisione') ||
    msg.includes('problema auto')
  ) {
    return 'officina';
  }

  if (
    msg.includes('noleggio') ||
    msg.includes('noleggiare') ||
    msg.includes('furgone') ||
    msg.includes('furgoni') ||
    msg.includes('auto a noleggio') ||
    msg.includes('rent') ||
    msg.includes('pulmino')
  ) {
    return 'noleggio';
  }

  if (
    msg.includes('vendita') ||
    msg.includes('auto usata') ||
    msg.includes('comprare auto') ||
    msg.includes('acquisto') ||
    msg.includes('cerco auto') ||
    msg.includes('vorrei comprare')
  ) {
    return 'vendita';
  }

  if (
    msg.includes('trasporto') ||
    msg.includes('bisarca') ||
    msg.includes('ritiro veicolo') ||
    msg.includes('consegna veicolo') ||
    msg.includes('spostare auto') ||
    msg.includes('trasportare auto')
  ) {
    return 'trasporto';
  }

  if (
    msg.includes('parcheggio') ||
    msg.includes('sosta') ||
    msg.includes('posto camper') ||
    msg.includes('posto auto') ||
    msg.includes('area sosta') ||
    msg.includes('camper stop') ||
    msg.includes('sosta camper')
  ) {
    return 'parcheggio_sosta';
  }

  return 'generico';
}

function intentFromMenuChoice(text) {
  const msg = normalize(text);

  if (msg === '1') return 'officina';
  if (msg === '2') return 'noleggio';
  if (msg === '3') return 'vendita';
  if (msg === '4') return 'trasporto';
  if (msg === '5') return 'contatto_diretto';
  if (msg === '6') return 'parcheggio_sosta';

  const detected = detectIntent(msg);
  return detected !== 'generico' ? detected : null;
}

function detectServiceSwitch(text, currentIntent) {
  const msg = normalize(text);

  if (msg === 'menu' || msg === 'reset') return 'menu';

  const menuChoice = intentFromMenuChoice(msg);
  if (menuChoice && menuChoice !== currentIntent) return menuChoice;

  if (
    msg.includes('ho sbagliato') ||
    msg.includes('servizio sbagliato') ||
    msg.includes('cambiare servizio') ||
    msg.includes('mi serve il noleggio') ||
    msg.includes('mi serve officina') ||
    msg.includes('mi serve trasporto') ||
    msg.includes('mi serve parcheggio') ||
    msg.includes('mi serve sosta') ||
    msg.includes('non officina') ||
    msg.includes('non noleggio') ||
    msg.includes('non trasporto') ||
    msg.includes('non vendita')
  ) {
    const detected = detectIntent(msg);
    if (detected !== 'generico' && detected !== currentIntent) {
      return detected;
    }
  }

  return null;
}

function getRecipients(intent) {
  if (intent === 'officina') return OFFICINA_NUMBERS;
  return GENERAL_NUMBERS;
}

// =========================
// TESTI
// =========================
function buildWelcomeMenu(profileName) {
  const customerName = formatCustomerName(profileName);

  return (
    `TEST NUOVO BOT 🚀 ${customerName}\n` +
    'Benvenuto in *Trasporti DP*.\n\n' +
    'Per poterla assistere al meglio, selezioni il servizio di suo interesse rispondendo con il numero corrispondente:\n\n' +
    '1️⃣ *Officina* 🔧\n' +
    '2️⃣ *Noleggio* 🚐\n' +
    '3️⃣ *Vendita auto* 🚗\n' +
    '4️⃣ *Trasporto veicoli* 🚛\n' +
    '5️⃣ *Contatto diretto / Responsabile* 📞\n' +
    '6️⃣ *Parcheggio / Sosta* 🅿️'
  );
}
function buildStartMessageByIntent(intent, profileName) {
  const customerName = formatCustomerName(profileName);

  if (intent === 'officina') {
    return `Salve ${customerName} 👋\n\nLa sua richiesta è stata indirizzata al reparto *Officina* 🔧.\n\nLe chiediamo gentilmente alcune informazioni per gestirla al meglio.`;
  }

  if (intent === 'noleggio') {
    return `Salve ${customerName} 👋\n\nLa sua richiesta è stata indirizzata al reparto *Noleggio* 🚐.\n\nLe chiediamo gentilmente alcune informazioni per procedere.`;
  }

  if (intent === 'vendita') {
    return `Salve ${customerName} 👋\n\nLa sua richiesta è stata indirizzata al reparto *Vendita auto* 🚗.\n\nLe chiediamo gentilmente alcune informazioni per aiutarla al meglio.`;
  }

  if (intent === 'trasporto') {
    return `Salve ${customerName} 👋\n\nLa sua richiesta è stata indirizzata al reparto *Trasporto veicoli* 🚛.\n\nLe chiediamo gentilmente alcune informazioni per organizzarla.`;
  }

  if (intent === 'contatto_diretto') {
    return `Salve ${customerName} 👋\n\nLa sua richiesta è stata indirizzata a un *responsabile* 📞.\n\nLe chiediamo gentilmente alcune informazioni per poterla ricontattare al più presto.`;
  }

  if (intent === 'parcheggio_sosta') {
    return `Salve ${customerName} 👋\n\nLa sua richiesta è stata indirizzata al servizio *Parcheggio / Sosta* 🅿️.\n\nLe chiediamo gentilmente alcune informazioni per verificare disponibilità, servizi e importo.`;
  }

  return `Salve ${customerName} 👋`;
}

function buildQuestions(intent) {
  if (intent === 'officina') {
    return [
      'Qual è il *modello del veicolo*?',
      'Può indicarci la *targa*?',
      'Qual è il *problema* oppure quale *intervento* desidera effettuare?',
      'Ha un *giorno preferito* per l’appuntamento?'
    ];
  }

  if (intent === 'noleggio') {
    return [
      'Che *mezzo* le occorre? (es. *pulmino*, *furgone*, *auto*)',
      'Può indicarci le *date del noleggio* in questo formato?\n\nEsempio: *10/05 - 15/05*'
    ];
  }

  if (intent === 'vendita') {
    return [
      'Che tipo di *auto* sta cercando?',
      'Qual è il suo *budget indicativo*?',
      'Ha una *permuta*? Se sì, ci indichi modello e anno.'
    ];
  }

  if (intent === 'trasporto') {
    return [
      'Qual è il *veicolo da trasportare*?',
      'Qual è il *luogo di ritiro*?',
      'Qual è il *luogo di consegna*?',
      'Entro quando sarebbe necessario il *trasporto*?'
    ];
  }

  if (intent === 'contatto_diretto') {
    return ['Può indicarci brevemente il *motivo della richiesta*?'];
  }

  if (intent === 'parcheggio_sosta') {
    return [
      'Qual è il *tipo di mezzo*? (es. auto, furgone, camper, carrello, altro)',
      'Può indicarci le *date della sosta* in questo formato?\n\nEsempio: *10/05 - 15/05*',
      'Ha bisogno di *corrente*? (sì / no)',
      'Ha bisogno di *acqua*? (sì / no)'
    ];
  }

  return [];
}

function buildInvalidChoiceMessage() {
  return (
    'Scelta non riconosciuta.\n\n' +
    'Per favore risponda con:\n' +
    '1️⃣ per *Officina* 🔧\n' +
    '2️⃣ per *Noleggio* 🚐\n' +
    '3️⃣ per *Vendita auto* 🚗\n' +
    '4️⃣ per *Trasporto veicoli* 🚛\n' +
    '5️⃣ per *Contatto diretto / Responsabile* 📞\n' +
    '6️⃣ per *Parcheggio / Sosta* 🅿️'
  );
}

function buildServiceChangedMessage(intent, profileName) {
  return (
    'Perfetto, aggiorniamo subito il servizio richiesto.\n\n' +
    buildStartMessageByIntent(intent, profileName) +
    '\n\n' +
    buildQuestions(intent)[0]
  );
}

function buildVehicleChoiceMessage(profileName, requestedVehicle, dateRange, vehicles) {
  const customerName = formatCustomerName(profileName);
  const lines = vehicles.slice(0, 3).map((v, i) => {
    return `${i + 1}️⃣ *${v.name}* (${v.code || '-'})\n💰 € ${formatEuroNumber(v.estimatedTotalAmount)}`;
  });

  return (
    `Perfetto ${customerName} 👌\n\n` +
    `Abbiamo trovato queste disponibilità per *${requestedVehicle}* ` +
    `dal *${dateRange.startLabel}* al *${dateRange.endLabel}*:\n\n` +
    `${lines.join('\n\n')}\n\n` +
    'Risponda con il numero del mezzo che vuole prenotare:\n*1*, *2* oppure *3*.'
  );
}

function buildCustomerConfirmation(intent, profileName, extra = {}) {
  const customerName = formatCustomerName(profileName);

  if (intent === 'officina') {
    return (
      `La ringraziamo ${customerName} ✅\n\n` +
      'La sua richiesta per il reparto *Officina* è stata registrata correttamente e inoltrata al nostro staff.\n' +
      'Sarà ricontattato al più presto *sul numero WhatsApp da cui ci sta scrivendo*.\n\n' +
      `Per prenotare direttamente può usare anche questo link:\n${LINK_OFFICINA}`
    );
  }

  if (intent === 'noleggio') {
    if (extra.unavailable) {
      return (
        `La ringraziamo ${customerName}.\n\n` +
        `Al momento non risultano disponibilità dal gestionale per *${extra.requestedVehicle}* dal *${extra.startLabel}* al *${extra.endLabel}*.\n\n` +
        'La sua richiesta è stata comunque inoltrata al nostro staff, che la ricontatterà sul numero WhatsApp da cui ci sta scrivendo.'
      );
    }

    if (extra.fromCarRental) {
      return (
        `La ringraziamo ${customerName} ✅\n\n` +
        'La sua richiesta per il reparto *Noleggio* è stata registrata correttamente e inoltrata al nostro staff.\n\n' +
        `🚐 *Mezzo scelto:* ${extra.vehicleName}\n` +
        `📅 *Periodo richiesto:* dal ${extra.startLabel} al ${extra.endLabel} (${extra.days} giorni)\n` +
        `💰 *Prezzo noleggio:* € ${formatEuroNumber(extra.estimatedTotalAmount)}\n\n` +
        `Può effettuare il pagamento del *solo costo del noleggio* qui:\n${extra.paymentLink || 'Link non disponibile'}\n\n` +
        `La *caparra di € ${eurosFromCents(NOLEGGIO_DEPOSIT_CENTS)}* verrà gestita separatamente dal nostro staff.\n\n` +
        'Sarà ricontattato al più presto *sul numero WhatsApp da cui ci sta scrivendo*.'
      );
    }

    const datesPart =
      extra.startLabel && extra.endLabel
        ? `\nPeriodo richiesto: *dal ${extra.startLabel} al ${extra.endLabel}* (${extra.days} giorni).`
        : '';

    const pricePart =
      extra.baseTotalExVat !== undefined
        ? `\n\n💰 *Costo noleggio:* € ${formatEuroNumber(extra.baseTotalExVat)} + IVA 22%` +
          `\n💰 *Totale noleggio con IVA:* € ${formatEuroNumber(extra.baseTotalIncVat)}` +
          `\n🚗 *Km inclusi:* ${extra.kmIncluded} km` +
          `\n📍 *Extra km:* € ${formatEuroNumber(extra.extraKmExVat)} + IVA 22% / km`
        : '';

    const paymentPart =
      extra.paymentLink
        ? `\n\nPuò effettuare il pagamento del *solo costo del noleggio* qui:\n${extra.paymentLink}` +
          `\n\nLa *caparra di € ${eurosFromCents(NOLEGGIO_DEPOSIT_CENTS)}* verrà gestita separatamente dal nostro staff.`
        : `\n\nLa *caparra di € ${eurosFromCents(NOLEGGIO_DEPOSIT_CENTS)}* verrà gestita separatamente dal nostro staff.`;

    return (
      `La ringraziamo ${customerName} ✅\n\n` +
      'La sua richiesta per il reparto *Noleggio* è stata registrata correttamente e inoltrata al nostro staff.' +
      datesPart +
      pricePart +
      '\n\nSarà ricontattato al più presto *sul numero WhatsApp da cui ci sta scrivendo*.' +
      paymentPart
    );
  }

  if (intent === 'vendita') {
    return (
      `La ringraziamo ${customerName} ✅\n\n` +
      'La sua richiesta per il reparto *Vendita auto* è stata registrata correttamente e inoltrata al nostro staff.\n' +
      'Sarà ricontattato al più presto *sul numero WhatsApp da cui ci sta scrivendo*.'
    );
  }

  if (intent === 'trasporto') {
    return (
      `La ringraziamo ${customerName} ✅\n\n` +
      'La sua richiesta per il reparto *Trasporto veicoli* è stata registrata correttamente e inoltrata al nostro staff.\n' +
      'Sarà ricontattato al più presto *sul numero WhatsApp da cui ci sta scrivendo*.'
    );
  }

  if (intent === 'contatto_diretto') {
    return (
      `La ringraziamo ${customerName} ✅\n\n` +
      'La sua richiesta è stata inoltrata a un nostro *responsabile*.\n' +
      'Sarà ricontattato al più presto *sul numero WhatsApp da cui ci sta scrivendo*.'
    );
  }

  if (intent === 'parcheggio_sosta') {
    const amountLabel = extra.amountCents
      ? `\n\n*Importo calcolato:* € ${eurosFromCents(extra.amountCents)}`
      : '';

    const periodLabel =
      extra.startLabel && extra.endLabel
        ? `\n*Periodo richiesto:* dal ${extra.startLabel} al ${extra.endLabel} (${extra.days} giorni)`
        : '';

    const paymentPart = extra.paymentLink
      ? `\n\nPer confermare in autonomia può effettuare il pagamento qui:\n${extra.paymentLink}`
      : '\n\nIl nostro staff le invierà conferma e modalità di pagamento al più presto.';

    return (
      `La ringraziamo ${customerName} ✅\n\n` +
      'La sua richiesta per il servizio *Parcheggio / Sosta* è stata registrata correttamente.' +
      periodLabel +
      amountLabel +
      paymentPart +
      '\n\nSarà ricontattato al bisogno *sul numero WhatsApp da cui ci sta scrivendo*.'
    );
  }

  return (
      `La ringraziamo ${customerName} ✅\n\n` +
      'La sua richiesta è stata ricevuta correttamente.\n' +
      'Sarà ricontattato dal nostro staff al più presto.'
    );
}

function buildInternalMessage(session, incomingFrom, profileName, extra = {}) {
  const a = session.answers;
  const customerName = formatCustomerName(profileName);
  const whatsappNumber = formatWhatsappNumber(incomingFrom);

  if (session.intent === 'noleggio' && extra.fromCarRental) {
    return (
      `🔔 NUOVA RICHIESTA NOLEGGIO DAL GESTIONALE\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero WhatsApp cliente: ${whatsappNumber}\n\n` +
      `Richiesta mezzo: ${a[0] || '-'}\n` +
      `Periodo: dal ${extra.startLabel} al ${extra.endLabel} (${extra.days} giorni)\n` +
      `Mezzo scelto: ${extra.vehicleName || '-'}\n` +
      `Codice mezzo: ${extra.vehicleCode || '-'}\n` +
      `Prezzo stimato gestionale: € ${formatEuroNumber(extra.estimatedTotalAmount)}\n` +
      `Caparra separata: € ${eurosFromCents(NOLEGGIO_DEPOSIT_CENTS)}\n` +
      (extra.paymentLink ? `Link Nexi noleggio: ${extra.paymentLink}\n` : '')
    );
  }

  if (session.intent === 'noleggio' && extra.unavailable) {
    return (
      `🔔 RICHIESTA NOLEGGIO SENZA DISPONIBILITÀ\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero WhatsApp cliente: ${whatsappNumber}\n\n` +
      `Richiesta mezzo: ${extra.requestedVehicle || a[0] || '-'}\n` +
      `Periodo: dal ${extra.startLabel || '-'} al ${extra.endLabel || '-'}\n`
    );
  }

  if (session.intent === 'officina') {
    return (
      `🔔 NUOVA RICHIESTA OFFICINA\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero WhatsApp cliente: ${whatsappNumber}\n\n` +
      `Modello veicolo: ${a[0] || '-'}\n` +
      `Targa: ${a[1] || '-'}\n` +
      `Problema / intervento: ${a[2] || '-'}\n` +
      `Giorno preferito: ${a[3] || '-'}`
    );
  }

  if (session.intent === 'noleggio') {
    const dateRange = extractDateRange(a[1]);
    const periodLine = dateRange
      ? `Periodo richiesto: dal ${dateRange.startLabel} al ${dateRange.endLabel} (${dateRange.days} giorni)\n`
      : `Date richieste: ${a[1] || '-'}\n`;

    return (
      `🔔 NUOVA RICHIESTA NOLEGGIO\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero WhatsApp cliente: ${whatsappNumber}\n\n` +
      `Mezzo richiesto: ${a[0] || '-'}\n` +
      periodLine +
      (extra.baseTotalExVat !== undefined
        ? `Costo noleggio: € ${formatEuroNumber(extra.baseTotalExVat)} + IVA 22%\n` +
          `Totale noleggio con IVA: € ${formatEuroNumber(extra.baseTotalIncVat)}\n` +
          `Km inclusi: ${extra.kmIncluded} km\n` +
          `Extra km: € ${formatEuroNumber(extra.extraKmExVat)} + IVA 22% / km\n`
        : '') +
      `Caparra da gestire a parte: € ${eurosFromCents(NOLEGGIO_DEPOSIT_CENTS)}\n` +
      (extra.paymentLink ? `Link pagamento costo noleggio Nexi: ${extra.paymentLink}\n` : '')
    );
  }

  if (session.intent === 'vendita') {
    return (
      `🔔 NUOVA RICHIESTA VENDITA\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero WhatsApp cliente: ${whatsappNumber}\n\n` +
      `Auto cercata: ${a[0] || '-'}\n` +
      `Budget indicativo: ${a[1] || '-'}\n` +
      `Permuta: ${a[2] || '-'}`
    );
  }

  if (session.intent === 'trasporto') {
    return (
      `🔔 NUOVA RICHIESTA TRASPORTO\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero WhatsApp cliente: ${whatsappNumber}\n\n` +
      `Veicolo da trasportare: ${a[0] || '-'}\n` +
      `Luogo ritiro: ${a[1] || '-'}\n` +
      `Luogo consegna: ${a[2] || '-'}\n` +
      `Quando serve: ${a[3] || '-'}`
    );
  }

  if (session.intent === 'contatto_diretto') {
    return (
      `🔔 NUOVA RICHIESTA CONTATTO DIRETTO\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero WhatsApp cliente: ${whatsappNumber}\n\n` +
      `Motivo richiesta: ${a[0] || '-'}`
    );
  }

  if (session.intent === 'parcheggio_sosta') {
    const dateRange = extractDateRange(a[1]);
    const periodLine = dateRange
      ? `Periodo richiesto: dal ${dateRange.startLabel} al ${dateRange.endLabel} (${dateRange.days} giorni)\n`
      : `Date richieste: ${a[1] || '-'}\n`;

    return (
      `🔔 NUOVA RICHIESTA PARCHEGGIO / SOSTA\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero WhatsApp cliente: ${whatsappNumber}\n\n` +
      `Tipo di mezzo: ${a[0] || '-'}\n` +
      periodLine +
      `Corrente richiesta: ${yesNoLabel(a[2])}\n` +
      `Acqua richiesta: ${yesNoLabel(a[3])}\n` +
      (extra.amountCents ? `Importo calcolato: € ${eurosFromCents(extra.amountCents)}\n` : '') +
      (extra.paymentLink ? `Link pagamento Nexi: ${extra.paymentLink}\n` : '')
    );
  }

  return (
    `🔔 NUOVA RICHIESTA GENERICA\n\n` +
    `👤 Nome WhatsApp: ${customerName}\n` +
    `📞 Numero WhatsApp cliente: ${whatsappNumber}`
  );
}

// =========================
// SESSIONI
// =========================
function createSession(phone, profileName) {
  sessions[phone] = {
    profileName,
    state: 'idle',
    intent: null,
    questionIndex: 0,
    questions: [],
    answers: [],
    createdAt: Date.now(),
    pendingOptions: null
  };
  saveSessionsToFile();
  return sessions[phone];
}

function resetSession(phone, profileName = 'Cliente') {
  sessions[phone] = {
    profileName,
    state: 'idle',
    intent: null,
    questionIndex: 0,
    questions: [],
    answers: [],
    createdAt: Date.now(),
    pendingOptions: null
  };
  saveSessionsToFile();
  return sessions[phone];
}

function clearSession(phone) {
  delete sessions[phone];
  saveSessionsToFile();
}

function setSessionIntent(session, intent) {
  session.intent = intent;
  session.questions = buildQuestions(intent);
  session.state = 'questions';
  session.questionIndex = 0;
  session.answers = [];
  session.pendingOptions = null;
  session.createdAt = Date.now();
  saveSessionsToFile();
}

function isExpired(session) {
  const THIRTY_MINUTES = 30 * 60 * 1000;
  return Date.now() - session.createdAt > THIRTY_MINUTES;
}

// =========================
// VALIDAZIONI
// =========================
function validateAnswer(session, answer) {
  const intent = session.intent;
  const idx = session.questionIndex;
  const text = cleanText(answer);

  if (session.state === 'vehicle_choice') {
    if (!['1', '2', '3'].includes(normalize(text))) {
      return {
        valid: false,
        message: 'Per favore risponda con *1*, *2* oppure *3*.'
      };
    }
  }

  if (intent === 'noleggio' && session.state === 'questions') {
    if (idx === 0) {
      const range = extractDateRange(text);
      if (range) {
        return {
          valid: false,
          message:
            'Ci scusi, prima ci indichi il *mezzo richiesto*.\n\nEsempio: *pulmino*, *furgone*, *auto*.'
        };
      }
    }

    if (idx === 1) {
      const range = extractDateRange(text);
      if (!range) {
        return {
          valid: false,
          message:
            'Formato date non riconosciuto.\n\nPer favore scriva così:\n*10/05 - 15/05*'
        };
      }
    }
  }

  if (intent === 'parcheggio_sosta' && session.state === 'questions') {
    if (idx === 0) {
      const range = extractDateRange(text);
      if (range) {
        return {
          valid: false,
          message:
            'Ci scusi, prima ci indichi il *tipo di mezzo*.\n\nEsempio: *Auto*, *Furgone*, *Camper*.'
        };
      }
    }

    if (idx === 1) {
      const range = extractDateRange(text);
      if (!range) {
        return {
          valid: false,
          message:
            'Formato date non riconosciuto.\n\nPer favore scriva così:\n*10/05 - 15/05*'
        };
      }
    }

    if (idx === 2 || idx === 3) {
      const yn = yesNoLabel(text);
      if (yn !== 'SÌ' && yn !== 'NO') {
        return {
          valid: false,
          message: 'Per favore risponda solo con *sì* oppure *no*.'
        };
      }
    }
  }

  return { valid: true };
}

// =========================
// INVIO INTERNO
// =========================
async function sendInternalNotification(numbers, text) {
  for (const to of numbers) {
    if (to === TWILIO_WHATSAPP_NUMBER) continue;

    try {
      await client.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to,
        body: text
      });
    } catch (error) {
      console.error(`❌ Errore invio notifica a ${to}`);
      console.error('message:', error.message);
    }
  }
}

// =========================
// ROUTE
// =========================
app.get('/', (req, res) => {
  res.send('Server WhatsApp DP attivo ✅');
});

app.get('/nexi/result', (req, res) => {
  res.send(`
    <html>
      <head><meta charset="utf-8" /><title>Pagamento completato</title></head>
      <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
        <h1>Pagamento completato ✅</h1>
        <p>Grazie. Il pagamento risulta concluso.</p>
        <p>Riceverà conferma dal nostro staff nel più breve tempo possibile.</p>
      </body>
    </html>
  `);
});

app.get('/nexi/cancel', (req, res) => {
  res.send(`
    <html>
      <head><meta charset="utf-8" /><title>Pagamento annullato</title></head>
      <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
        <h1>Pagamento annullato</h1>
        <p>Il pagamento non è stato completato.</p>
      </body>
    </html>
  `);
});

app.get('/test-carrental-avail', async (req, res) => {
  try {
    const vehicleText = req.query.mezzo || 'pulmino';
    const startDate = parseItalianDate('10', '04', '2026');
    const endDate = parseItalianDate('12', '04', '2026');

    const result = await getCarRentalAvailability({
      vehicleText,
      startDate,
      endDate
    });

    res.status(200).json({
      requestedVehicle: vehicleText,
      count: result.vehicles.length,
      vehicles: result.vehicles.slice(0, 10).map((v) => ({
        code: v.code,
        name: v.name,
        estimatedTotalAmount: v.estimatedTotalAmount
      }))
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// =========================
// WHATSAPP WEBHOOK
// =========================
app.post('/whatsapp', async (req, res) => {
  const incomingText = cleanText(req.body.Body);
  const incomingFrom = req.body.From || '';
  const profileName = req.body.ProfileName || 'Cliente';
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    if (!incomingFrom) {
      twiml.message('Si è verificato un errore nella ricezione del messaggio.');
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    let session = sessions[incomingFrom];

    if (session && isExpired(session)) {
      clearSession(incomingFrom);
      session = null;
    }

    if (normalize(incomingText) === 'reset') {
      session = resetSession(incomingFrom, profileName);
      twiml.message(
        'Sessione resettata ✅\n\n' +
        buildWelcomeMenu(profileName)
      );
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (normalize(incomingText) === 'menu') {
      session = resetSession(incomingFrom, profileName);
      twiml.message(buildWelcomeMenu(profileName));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (!session) {
      session = createSession(incomingFrom, profileName);
    }

    if (session.state === 'idle') {
      const directIntent = intentFromMenuChoice(incomingText) || detectIntent(incomingText);

      if (directIntent && directIntent !== 'generico') {
        setSessionIntent(session, directIntent);
        twiml.message(
          buildStartMessageByIntent(directIntent, profileName) +
          '\n\n' +
          session.questions[0]
        );
      } else {
        session.state = 'menu';
        saveSessionsToFile();
        twiml.message(buildWelcomeMenu(profileName));
      }

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'menu') {
      const chosenIntent = intentFromMenuChoice(incomingText);

      if (!chosenIntent) {
        twiml.message(buildInvalidChoiceMessage());
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      setSessionIntent(session, chosenIntent);
      twiml.message(
        buildStartMessageByIntent(chosenIntent, profileName) +
        '\n\n' +
        session.questions[0]
      );

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'vehicle_choice') {
      const validation = validateAnswer(session, incomingText);
      if (!validation.valid) {
        twiml.message(validation.message);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      const idx = parseInt(normalize(incomingText), 10) - 1;
      const options = session.pendingOptions?.vehicles || [];
      const selected = options[idx];

      if (!selected) {
        twiml.message('Scelta non valida. Risponda con *1*, *2* oppure *3*.');
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      let internalExtra = {
        fromCarRental: true,
        requestedVehicle: session.pendingOptions.requestedVehicle,
        vehicleName: selected.name,
        vehicleCode: selected.code,
        startLabel: session.pendingOptions.startLabel,
        endLabel: session.pendingOptions.endLabel,
        days: session.pendingOptions.days,
        estimatedTotalAmount: selected.estimatedTotalAmount
      };

      if (canUseNexi() && selected.estimatedTotalAmount !== null) {
        try {
          const payment = await createNexiPayMailLink({
            amountCents: euroToCents(selected.estimatedTotalAmount),
            description: `Pagamento noleggio ${selected.name} - ${session.pendingOptions.days} giorni`,
            customerWhatsapp: formatWhatsappNumber(incomingFrom)
          });
          internalExtra.paymentLink = payment.payMailUrl;
        } catch (error) {
          console.error('Errore Nexi scelta mezzo:', error.message);
        }
      }

      const confirmationMessage = buildCustomerConfirmation(
        session.intent,
        profileName,
        internalExtra
      );

      const internalMessage = buildInternalMessage(
        session,
        incomingFrom,
        profileName,
        internalExtra
      );

      const recipients = getRecipients(session.intent);
      await sendInternalNotification(recipients, internalMessage);

      twiml.message(confirmationMessage);
      clearSession(incomingFrom);

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'questions') {
      const switchedIntent = detectServiceSwitch(incomingText, session.intent);

      if (switchedIntent === 'menu') {
        session = resetSession(incomingFrom, profileName);
        twiml.message(buildWelcomeMenu(profileName));
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      if (switchedIntent && switchedIntent !== session.intent) {
        setSessionIntent(session, switchedIntent);
        twiml.message(buildServiceChangedMessage(switchedIntent, profileName));
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      const validation = validateAnswer(session, incomingText);
      if (!validation.valid) {
        twiml.message(validation.message);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      session.answers.push(incomingText);
      session.questionIndex += 1;
      session.createdAt = Date.now();
      saveSessionsToFile();

      if (session.questionIndex < session.questions.length) {
        twiml.message(session.questions[session.questionIndex]);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      let internalExtra = {};
      let confirmationMessage = '';

      if (session.intent === 'parcheggio_sosta') {
        const quote = computeSostaAmountCents(session.answers);

        internalExtra = {
          amountCents: quote.totalCents,
          startLabel: quote.startLabel,
          endLabel: quote.endLabel,
          days: quote.giorni
        };

        if (canUseNexi()) {
          try {
            const payment = await createNexiPayMailLink({
              amountCents: quote.totalCents,
              description: `Parcheggio/Sosta ${session.answers[0] || ''} - ${quote.giorni} giorni`,
              customerWhatsapp: formatWhatsappNumber(incomingFrom)
            });
            internalExtra.paymentLink = payment.payMailUrl;
          } catch (error) {
            console.error('Errore Nexi sosta:', error.message);
          }
        }

        confirmationMessage = buildCustomerConfirmation(session.intent, profileName, internalExtra);
      } else if (session.intent === 'noleggio') {
        const requestedVehicle = session.answers[0];
        const dateRange = extractDateRange(session.answers[1]);

        if (dateRange && canUseCarRental()) {
          try {
            const avail = await getCarRentalAvailability({
              vehicleText: requestedVehicle,
              startDate: dateRange.startDate,
              endDate: dateRange.endDate
            });

            if (avail.vehicles.length > 0) {
              const topVehicles = avail.vehicles.slice(0, 3);

              session.state = 'vehicle_choice';
              session.pendingOptions = {
                requestedVehicle,
                startLabel: dateRange.startLabel,
                endLabel: dateRange.endLabel,
                days: dateRange.days,
                vehicles: topVehicles
              };
              session.createdAt = Date.now();
              saveSessionsToFile();

              twiml.message(
                buildVehicleChoiceMessage(profileName, requestedVehicle, dateRange, topVehicles)
              );
              res.writeHead(200, { 'Content-Type': 'text/xml' });
              return res.end(twiml.toString());
            }

            internalExtra = {
              unavailable: true,
              requestedVehicle,
              startLabel: dateRange.startLabel,
              endLabel: dateRange.endLabel
            };

            confirmationMessage = buildCustomerConfirmation(
              session.intent,
              profileName,
              internalExtra
            );
          } catch (error) {
            console.error('Errore disponibilità gestionale:', error.message);

            const fallback = computeNoleggioFallback(session.answers);

            if (fallback) {
              internalExtra = {
                startLabel: fallback.startLabel,
                endLabel: fallback.endLabel,
                days: fallback.giorni,
                baseTotalExVat: fallback.baseTotalExVat,
                baseTotalIncVat: fallback.baseTotalIncVat,
                kmIncluded: fallback.kmIncluded,
                extraKmExVat: fallback.extraKmExVat
              };

              if (canUseNexi()) {
                try {
                  const payment = await createNexiPayMailLink({
                    amountCents: euroToCents(fallback.baseTotalIncVat),
                    description: `Pagamento noleggio ${requestedVehicle} - ${fallback.giorni} giorni`,
                    customerWhatsapp: formatWhatsappNumber(incomingFrom)
                  });
                  internalExtra.paymentLink = payment.payMailUrl;
                } catch (nexiErr) {
                  console.error('Errore Nexi noleggio fallback:', nexiErr.message);
                }
              }
            }

            confirmationMessage = buildCustomerConfirmation(
              session.intent,
              profileName,
              internalExtra
            );
          }
        } else {
          const fallback = computeNoleggioFallback(session.answers);

          if (fallback) {
            internalExtra = {
              startLabel: fallback.startLabel,
              endLabel: fallback.endLabel,
              days: fallback.giorni,
              baseTotalExVat: fallback.baseTotalExVat,
              baseTotalIncVat: fallback.baseTotalIncVat,
              kmIncluded: fallback.kmIncluded,
              extraKmExVat: fallback.extraKmExVat
            };

            if (canUseNexi()) {
              try {
                const payment = await createNexiPayMailLink({
                  amountCents: euroToCents(fallback.baseTotalIncVat),
                  description: `Pagamento noleggio ${requestedVehicle} - ${fallback.giorni} giorni`,
                  customerWhatsapp: formatWhatsappNumber(incomingFrom)
                });
                internalExtra.paymentLink = payment.payMailUrl;
              } catch (error) {
                console.error('Errore Nexi noleggio fallback:', error.message);
              }
            }
          }

          confirmationMessage = buildCustomerConfirmation(
            session.intent,
            profileName,
            internalExtra
          );
        }
      } else {
        confirmationMessage = buildCustomerConfirmation(session.intent, profileName);
      }

      const internalMessage = buildInternalMessage(
        session,
        incomingFrom,
        profileName,
        internalExtra
      );

      const recipients = getRecipients(session.intent);
      await sendInternalNotification(recipients, internalMessage);

      twiml.message(confirmationMessage);
      clearSession(incomingFrom);

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    session = resetSession(incomingFrom, profileName);
    twiml.message(buildWelcomeMenu(profileName));
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  } catch (error) {
    console.error('Errore generale:', error);
    twiml.message(
      'La ringraziamo per il messaggio. Al momento si è verificato un problema tecnico. La invitiamo a riprovare tra poco.'
    );
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
