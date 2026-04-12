require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const crypto = require('crypto');
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
// SESSIONI IN MEMORIA
// =========================
const sessions = {};
const processedMessageSids = new Map();
const transactions = {};

function rememberProcessedMessage(messageSid) {
  if (!messageSid) return;
  processedMessageSids.set(messageSid, Date.now());

  const now = Date.now();
  for (const [sid, ts] of processedMessageSids.entries()) {
    if (now - ts > 15 * 60 * 1000) {
      processedMessageSids.delete(sid);
    }
  }
}

function alreadyProcessedMessage(messageSid) {
  if (!messageSid) return false;
  return processedMessageSids.has(messageSid);
}

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

function prettifyVehicleCode(code) {
  const c = String(code || '').toUpperCase().trim();

  if (c === 'F1-VAN') return 'Gruppo F1 - Furgone';
  if (c === 'F2-PC') return 'Gruppo F2 - Furgone commerciale';
  if (c === 'P2-9P') return 'Gruppo P2 - 9 Posti';
  if (c === 'P1-8P') return 'Gruppo P1 - 8 Posti';
  if (c === 'A1' || c === 'A1-COMPACT ECO') return 'Gruppo A1 - Compact Eco';
  if (c === 'A2' || c === 'A2-COMPACT') return 'Gruppo A2 - Compact';
  if (c === 'A3' || c === 'A3-COMPACT ELITE') return 'Gruppo A3 - Compact Elite';
  if (c === 'X-ESC') return 'Gruppo X - Mezzo speciale';

  return c || '';
}

function humanizeVehicleName(name, code) {
  const cleaned = String(name || '').replace(/\s+/g, ' ').trim();
  const upperCode = String(code || '').toUpperCase().trim();

  if (!cleaned) return prettifyVehicleCode(upperCode) || 'Veicolo disponibile';

  const lower = cleaned.toLowerCase();

  if (lower.includes('gruppo')) return cleaned;
  if (upperCode === 'P2-9P') return 'Gruppo P2 - 9 Posti';
  if (upperCode === 'P1-8P') return 'Gruppo P1 - 8 Posti';
  if (upperCode === 'F1-VAN') return 'Gruppo F1 - Furgone';
  if (upperCode === 'F2-PC') return 'Gruppo F2 - Furgone commerciale';
  if (upperCode.startsWith('A1')) return 'Gruppo A1 - Compact Eco';
  if (upperCode.startsWith('A2')) return 'Gruppo A2 - Compact';
  if (upperCode.startsWith('A3')) return 'Gruppo A3 - Compact Elite';

  return cleaned;
}

function normalizeVehicleLabel(item) {
  const vehAvailCore = item?.VehAvailCore || item?.['ns1:VehAvailCore'] || {};
  const vehicle =
    item?.Vehicle ||
    item?.['ns1:Vehicle'] ||
    vehAvailCore?.Vehicle ||
    {};
  const makeModel =
    item?.VehMakeModel ||
    item?.['ns1:VehMakeModel'] ||
    vehicle?.VehMakeModel ||
    {};
  const vehClass = item?.VehClass || item?.['ns1:VehClass'] || {};
  const vehType = item?.VehType || item?.['ns1:VehType'] || {};

  const code =
    vehicle?.['@_Code'] ||
    makeModel?.['@_Code'] ||
    vehClass?.['@_Code'] ||
    vehType?.['@_Code'] ||
    '';

  let name =
    vehicle?.['@_Description'] ||
    vehicle?.['@_Name'] ||
    makeModel?.['@_Name'] ||
    vehClass?.['@_Name'] ||
    vehType?.['@_VehicleCategory'] ||
    '';

  if (!name) {
    name = prettifyVehicleCode(code) || 'Veicolo disponibile';
  }

  name = humanizeVehicleName(name, code);

  const totalCharge =
    item?.TotalCharge ||
    item?.['ns1:TotalCharge'] ||
    vehAvailCore?.TotalCharge ||
    findFirstByKeys(item, ['TotalCharge', 'ns1:TotalCharge']) ||
    {};

  const estimatedTotalAmount =
    totalCharge?.['@_EstimatedTotalAmount'] ||
    totalCharge?.EstimatedTotalAmount ||
    totalCharge?.['@_RateTotalAmount'] ||
    totalCharge?.RateTotalAmount ||
    null;

  return {
    code: String(code || '').trim(),
    name: String(name || '').trim(),
    estimatedTotalAmount: estimatedTotalAmount !== null ? Number(estimatedTotalAmount) : null,
    raw: item
  };
}

function getRequestedVehicleCodes(userText) {
  const q = normalize(userText);

  if (!q) return [];

  if (q.includes('pulmino') || q.includes('9 posti')) {
    return ['P2-9P', 'P1-8P'];
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
  const nameLower = String(vehicle.name || '').toLowerCase();
  const q = normalize(userText);

  if (!requestedCodes.length) return true;
  if (requestedCodes.some((c) => codeUpper.includes(c))) return true;

  if (q.includes('furgone')) {
    return nameLower.includes('furgone') || nameLower.includes('van');
  }

  if (q.includes('pulmino') || q.includes('9 posti')) {
    return (
      nameLower.includes('pulmino') ||
      nameLower.includes('posti') ||
      nameLower.includes('9 posti') ||
      nameLower.includes('8 posti')
    );
  }

  if (q.includes('auto') || q.includes('macchina') || q.includes('vettura')) {
    return (
      nameLower.includes('auto') ||
      nameLower.includes('compact') ||
      nameLower.includes('compatta') ||
      nameLower.includes('eco') ||
      nameLower.includes('elite')
    );
  }

  return false;
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
      <VehAvailRQCore>
        <VehRentalCore PickUpDateTime="${pickUpDateTime}" ReturnDateTime="${returnDateTime}">
          <PickUpLocation LocationCode="${CARRENTAL_LOCATION_CODE}"/>
          <ReturnLocation LocationCode="${CARRENTAL_LOCATION_CODE}"/>
        </VehRentalCore>
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
  const usable = (filtered.length > 0 ? filtered : vehicles).filter(
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

function extractKilometers(text) {
  const raw = normalize(text).replace(/\./g, '').replace(/,/g, '.');
  const match = raw.match(/(\d{1,6})/);
  if (!match) return null;

  const km = parseInt(match[1], 10);
  if (!km || km < 0) return null;
  return km;
}

function computeNoleggioFallbackWithKm(answers) {
  const dateRange = extractDateRange(answers[1]);
  if (!dateRange) return null;

  const requestedKm = extractKilometers(answers[2]) || 0;
  const giorni = dateRange.days;
  const kmIncluded = NOLEGGIO_KM_INCLUDED_PER_DAY * giorni;
  const extraKm = Math.max(0, requestedKm - kmIncluded);

  const baseTotalExVat = NOLEGGIO_PRICE_PER_DAY_EUR * giorni;
  const extraKmTotalExVat = extraKm * NOLEGGIO_EXTRA_KM_EUR;
  const totalExVat = baseTotalExVat + extraKmTotalExVat;
  const totalIncVat = totalExVat * (1 + IVA_RATE);

  return {
    giorni,
    startLabel: dateRange.startLabel,
    endLabel: dateRange.endLabel,
    requestedKm,
    kmIncluded,
    extraKm,
    extraKmExVat: NOLEGGIO_EXTRA_KM_EUR,
    extraKmTotalExVat,
    baseTotalExVat,
    totalExVat,
    totalIncVat
  };
}
// =========================
// COMANDI GLOBALI
// =========================
function isMenuCommand(text) {
  const msg = normalize(text);
  return msg === 'menu' || msg === 'menù' || msg === 'inizio';
}

function isResetCommand(text) {
  const msg = normalize(text);
  return msg === 'reset' || msg === 'riavvia' || msg === 'ricomincia';
}

function isBackCommand(text) {
  const msg = normalize(text);
  return [
    'indietro',
    'torna',
    'torna indietro',
    'voglio tornare',
    'ho sbagliato',
    'scusa ho sbagliato',
    'a scusa ho sbagliato',
    'annulla'
  ].includes(msg);
}

function isAnotherDateCommand(text) {
  const msg = normalize(text);
  return [
    'altra data',
    'altre date',
    'cambio data',
    'cambiare data',
    'se ti do altra data',
    'provo altra data'
  ].includes(msg);
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
    msg === '2' ||
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
    msg === '3' ||
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
    msg === '4' ||
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
    msg === '6' ||
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

  if (msg === '1' || msg === 'officina') return 'officina';
  if (msg === '2' || msg === 'noleggio') return 'noleggio';
  if (msg === '3' || msg === 'vendita') return 'vendita';
  if (msg === '4' || msg === 'trasporto') return 'trasporto';
  if (msg === '5' || msg === 'responsabile' || msg === 'contatto diretto') return 'contatto_diretto';
  if (msg === '6' || msg === 'parcheggio' || msg === 'sosta') return 'parcheggio_sosta';

  return null;
}

function detectServiceSwitch(text, currentIntent) {
  const msg = normalize(text);

  if (isMenuCommand(msg) || isResetCommand(msg)) return 'menu';

  const menuChoice = intentFromMenuChoice(msg);
  if (menuChoice && menuChoice !== currentIntent) return menuChoice;

  if (
    msg.includes('ho sbagliato servizio') ||
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
    `Ciao ${customerName} 👋\n\n` +
    'Benvenuto in *Trasporti DP*.\n' +
    'Dimmi pure di cosa hai bisogno scegliendo il servizio:\n\n' +
    '1️⃣ *Officina* 🔧\n' +
    '2️⃣ *Noleggio* 🚐\n' +
    '3️⃣ *Vendita auto* 🚗\n' +
    '4️⃣ *Trasporto veicoli* 🚛\n' +
    '5️⃣ *Contatto diretto / Responsabile* 📞\n' +
    '6️⃣ *Parcheggio / Sosta* 🅿️\n\n' +
    'Puoi rispondere sia con il *numero* sia con la *parola*.'
  );
}

function buildStartMessageByIntent(intent, profileName) {
  const customerName = formatCustomerName(profileName);

  if (intent === 'officina') {
    return `Perfetto ${customerName} 👌\n\nTi passo sul reparto *Officina*.\nTi chiedo qualche informazione rapida e poi ci pensiamo noi.`;
  }

  if (intent === 'noleggio') {
    return `Perfetto ${customerName} 👌\n\nTi aiuto con il *Noleggio*.\nDimmi solo il mezzo e le date, così controllo subito disponibilità e prezzo.`;
  }

  if (intent === 'vendita') {
    return `Perfetto ${customerName} 👌\n\nTi aiuto per la *Vendita auto*.\nTi faccio qualche domanda veloce così il nostro staff ti risponde meglio.`;
  }

  if (intent === 'trasporto') {
    return `Perfetto ${customerName} 👌\n\nTi aiuto con il *Trasporto veicoli*.\nMi servono alcuni dettagli per organizzare tutto al meglio.`;
  }

  if (intent === 'contatto_diretto') {
    return `Perfetto ${customerName} 👌\n\nTi metto in contatto con un *responsabile*.\nScrivimi brevemente il motivo della richiesta.`;
  }

  if (intent === 'parcheggio_sosta') {
    return `Perfetto ${customerName} 👌\n\nTi aiuto con *Parcheggio / Sosta*.\nMi servono alcune informazioni per verificare disponibilità e importo.`;
  }

  return `Ciao ${customerName} 👋`;
}

function buildQuestions(intent) {
  if (intent === 'officina') {
    return [
      'Che *veicolo* hai?',
      'Puoi indicarmi la *targa*?',
      'Che *problema* ha il veicolo oppure quale *intervento* vuoi fare?',
      'Hai un *giorno preferito* per l’appuntamento?'
    ];
  }

  if (intent === 'noleggio') {
    return [
      'Che *mezzo* ti serve? (es. *pulmino*, *furgone*, *auto*)',
      'Puoi indicarmi le *date del noleggio* in questo formato?\n\nEsempio: *10/05 - 15/05*',
      'Quanti *km* prevedi di fare in totale?\n\nEsempio: *300*'
    ];
  }

  if (intent === 'vendita') {
    return [
      'Che tipo di *auto* stai cercando?',
      'Qual è il tuo *budget indicativo*?',
      'Hai una *permuta*? Se sì, scrivimi modello e anno.'
    ];
  }

  if (intent === 'trasporto') {
    return [
      'Qual è il *veicolo da trasportare*?',
      'Da dove va *ritirato*?',
      'Dove va *consegnato*?',
      'Per quando ti servirebbe il *trasporto*?'
    ];
  }

  if (intent === 'contatto_diretto') {
    return ['Scrivimi brevemente il *motivo della richiesta*.'];
  }

  if (intent === 'parcheggio_sosta') {
    return [
      'Che *tipo di mezzo* devi lasciare? (es. auto, furgone, camper, carrello)',
      'Puoi indicarmi le *date della sosta* in questo formato?\n\nEsempio: *10/05 - 15/05*',
      'Hai bisogno di *corrente*? (sì / no)',
      'Hai bisogno di *acqua*? (sì / no)'
    ];
  }

  return [];
}
function buildInvalidChoiceMessage() {
  return (
    'Non ho capito la scelta 😊\n\n' +
    'Puoi rispondermi con:\n' +
    '1️⃣ Officina\n' +
    '2️⃣ Noleggio\n' +
    '3️⃣ Vendita auto\n' +
    '4️⃣ Trasporto veicoli\n' +
    '5️⃣ Contatto diretto / Responsabile\n' +
    '6️⃣ Parcheggio / Sosta'
  );
}

function buildServiceChangedMessage(intent, profileName) {
  return (
    'Nessun problema, cambiamo subito servizio 👍\n\n' +
    buildStartMessageByIntent(intent, profileName) +
    '\n\n' +
    buildQuestions(intent)[0]
  );
}

function buildVehicleChoiceMessage(profileName, requestedVehicle, dateRange, requestedKm, vehicles) {
  const customerName = formatCustomerName(profileName);

  const lines = vehicles.slice(0, 3).map((v, i) => {
    const label = v.code ? `${v.name} (${v.code})` : v.name;
    return `${i + 1}️⃣ *${label}*\n💰 € ${formatEuroNumber(v.estimatedTotalAmount)}`;
  });

  return (
    `Perfetto ${customerName} 👌\n\n` +
    `Ho trovato queste disponibilità per *${requestedVehicle}* dal *${dateRange.startLabel}* al *${dateRange.endLabel}*:\n` +
    `🚗 *Km richiesti:* ${requestedKm} km\n\n` +
    `${lines.join('\n\n')}\n\n` +
    'Scrivimi *1*, *2* oppure *3* per scegliere il mezzo che preferisci.\n' +
    'Se hai sbagliato, puoi scrivere anche *indietro*, *menu* oppure *altra data*.'
  );
}
function buildCustomerConfirmation(intent, profileName, extra = {}) {
  const customerName = formatCustomerName(profileName);

  if (intent === 'officina') {
    return (
      `Grazie ${customerName} ✅\n\n` +
      'Ho inoltrato correttamente la tua richiesta al reparto *Officina*.\n' +
      'Ti ricontatteremo il prima possibile su questo numero WhatsApp.\n\n' +
      `Se preferisci, puoi prenotare direttamente anche da qui:\n${LINK_OFFICINA}`
    );
  }

 if (intent === 'noleggio') {
  if (extra.unavailableBecauseStationClosed) {
    return (
      `Grazie ${customerName} 🙏\n\n` +
      `Per il periodo *${extra.startLabel} - ${extra.endLabel}* il ritiro automatico non risulta disponibile dalla stazione selezionata.\n\n` +
      'Se vuoi, puoi provare subito con un’altra data scrivendomi direttamente il nuovo periodo.\n' +
      'Esempio: *18/04 - 21/04*'
    );
  }

  if (extra.unavailable) {
    return (
      `Grazie ${customerName} 🙏\n\n` +
      `Al momento non risultano disponibilità immediate per *${extra.requestedVehicle}* dal *${extra.startLabel}* al *${extra.endLabel}*.\n\n` +
      'Se vuoi, puoi provare subito con un’altra data scrivendomi direttamente il nuovo periodo.\n' +
      'Esempio: *18/04 - 21/04*'
    );
  }

  if (extra.fromCarRental) {
    return (
      `Grazie ${customerName} ✅\n\n` +
      'La tua richiesta per il reparto *Noleggio* è stata registrata correttamente.\n\n' +
      `🚐 *Mezzo scelto:* ${extra.vehicleName}\n` +
      `📅 *Periodo:* dal ${extra.startLabel} al ${extra.endLabel} (${extra.days} giorni)\n` +
      `🚗 *Km richiesti:* ${extra.requestedKm || 0} km\n` +
      `💰 *Prezzo noleggio:* € ${formatEuroNumber(extra.estimatedTotalAmount)}\n\n` +
      `Puoi effettuare il pagamento del *solo costo del noleggio* da qui:\n${extra.paymentLink || 'Link non disponibile'}\n\n` +
      `La *caparra di € ${eurosFromCents(NOLEGGIO_DEPOSIT_CENTS)}* verrà gestita separatamente dal nostro staff.`
    );
  }

  const datesPart =
    extra.startLabel && extra.endLabel
      ? `\n📅 *Periodo:* dal ${extra.startLabel} al ${extra.endLabel} (${extra.days} giorni)`
      : '';

  const kmPart =
    extra.requestedKm !== undefined
      ? `\n🚗 *Km richiesti:* ${extra.requestedKm} km` +
        `\n🚙 *Km inclusi:* ${extra.kmIncluded} km` +
        `\n📍 *Extra km:* ${extra.extraKm} km`
      : '';

  const pricePart =
    extra.totalExVat !== undefined
      ? `\n\n💰 *Costo noleggio base:* € ${formatEuroNumber(extra.baseTotalExVat)} + IVA 22%` +
        `\n💰 *Costo extra km:* € ${formatEuroNumber(extra.extraKmTotalExVat || 0)} + IVA 22%` +
        `\n💰 *Totale imponibile:* € ${formatEuroNumber(extra.totalExVat)}` +
        `\n💰 *Totale con IVA:* € ${formatEuroNumber(extra.totalIncVat)}` +
        `\n📍 *Tariffa extra km:* € ${formatEuroNumber(extra.extraKmExVat)} + IVA 22% / km`
      : '';

  const paymentPart =
    extra.paymentLink
      ? `\n\nPuoi effettuare il pagamento del *solo costo del noleggio* da qui:\n${extra.paymentLink}` +
        `\n\nLa *caparra di € ${eurosFromCents(NOLEGGIO_DEPOSIT_CENTS)}* verrà gestita separatamente dal nostro staff.`
      : `\n\nLa *caparra di € ${eurosFromCents(NOLEGGIO_DEPOSIT_CENTS)}* verrà gestita separatamente dal nostro staff.`;

  return (
    `Grazie ${customerName} ✅\n\n` +
    'La tua richiesta per il reparto *Noleggio* è stata registrata correttamente.' +
    datesPart +
    kmPart +
    pricePart +
    paymentPart
  );
}
  if (intent === 'vendita') {
    return (
      `Grazie ${customerName} ✅\n\n` +
      'Ho inoltrato correttamente la tua richiesta al reparto *Vendita auto*.\n' +
      'Ti ricontatteremo al più presto su questo numero WhatsApp.'
    );
  }

  if (intent === 'trasporto') {
    return (
      `Grazie ${customerName} ✅\n\n` +
      'Ho inoltrato correttamente la tua richiesta al reparto *Trasporto veicoli*.\n' +
      'Ti ricontatteremo al più presto su questo numero WhatsApp.'
    );
  }

  if (intent === 'contatto_diretto') {
    return (
      `Grazie ${customerName} ✅\n\n` +
      'Ho inoltrato la tua richiesta a un nostro *responsabile*.\n' +
      'Ti ricontatteremo il prima possibile su questo numero WhatsApp.'
    );
  }

  if (intent === 'parcheggio_sosta') {
    const amountLabel = extra.amountCents
      ? `\n\n💰 *Importo calcolato:* € ${eurosFromCents(extra.amountCents)}`
      : '';

    const periodLabel =
      extra.startLabel && extra.endLabel
        ? `\n📅 *Periodo:* dal ${extra.startLabel} al ${extra.endLabel} (${extra.days} giorni)`
        : '';

    const paymentPart = extra.paymentLink
      ? `\n\nPer confermare puoi effettuare il pagamento qui:\n${extra.paymentLink}`
      : '\n\nTi invieremo conferma e modalità di pagamento al più presto.';

    return (
      `Grazie ${customerName} ✅\n\n` +
      'La tua richiesta per *Parcheggio / Sosta* è stata registrata correttamente.' +
      periodLabel +
      amountLabel +
      paymentPart
    );
  }

  return (
    `Grazie ${customerName} ✅\n\n` +
    'Ho ricevuto correttamente la tua richiesta.\n' +
    'Ti ricontatteremo al più presto.'
  );
}

function buildInternalMessage(session, incomingFrom, profileName, extra = {}) {
  const a = session.answers;
  const customerName = formatCustomerName(profileName);
  const whatsappNumber = formatWhatsappNumber(incomingFrom);

  if (session.intent === 'officina') {
    return (
      `🔔 NUOVA RICHIESTA OFFICINA\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero cliente: ${whatsappNumber}\n\n` +
      `Veicolo: ${a[0] || '-'}\n` +
      `Targa: ${a[1] || '-'}\n` +
      `Problema / intervento: ${a[2] || '-'}\n` +
      `Giorno preferito: ${a[3] || '-'}`
    );
  }

  if (session.intent === 'vendita') {
    return (
      `🔔 NUOVA RICHIESTA VENDITA\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero cliente: ${whatsappNumber}\n\n` +
      `Auto cercata: ${a[0] || '-'}\n` +
      `Budget: ${a[1] || '-'}\n` +
      `Permuta: ${a[2] || '-'}`
    );
  }

  if (session.intent === 'trasporto') {
    return (
      `🔔 NUOVA RICHIESTA TRASPORTO\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero cliente: ${whatsappNumber}\n\n` +
      `Veicolo: ${a[0] || '-'}\n` +
      `Ritiro: ${a[1] || '-'}\n` +
      `Consegna: ${a[2] || '-'}\n` +
      `Quando serve: ${a[3] || '-'}`
    );
  }

  if (session.intent === 'contatto_diretto') {
    return (
      `🔔 NUOVA RICHIESTA CONTATTO DIRETTO\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero cliente: ${whatsappNumber}\n\n` +
      `Motivo: ${a[0] || '-'}`
    );
  }

  if (session.intent === 'parcheggio_sosta') {
    const dateRange = extractDateRange(a[1]);
    const periodLine = dateRange
      ? `Periodo: dal ${dateRange.startLabel} al ${dateRange.endLabel} (${dateRange.days} giorni)\n`
      : `Date richieste: ${a[1] || '-'}\n`;

    return (
      `🔔 NUOVA RICHIESTA PARCHEGGIO / SOSTA\n\n` +
      `👤 Nome WhatsApp: ${customerName}\n` +
      `📞 Numero cliente: ${whatsappNumber}\n\n` +
      `Tipo mezzo: ${a[0] || '-'}\n` +
      periodLine +
      `Corrente: ${yesNoLabel(a[2])}\n` +
      `Acqua: ${yesNoLabel(a[3])}\n` +
      (extra.amountCents ? `Importo: € ${eurosFromCents(extra.amountCents)}\n` : '') +
      (extra.paymentLink ? `Link Nexi: ${extra.paymentLink}\n` : '')
    );
  }

  return (
    `🔔 NUOVA RICHIESTA GENERICA\n\n` +
    `👤 Nome WhatsApp: ${customerName}\n` +
    `📞 Numero cliente: ${whatsappNumber}`
  );
}

// =========================
// NOTIFICHE NOLEGGIO
// =========================
async function notifyPrices(profileName, incomingFrom, data) {
  let text =
    `🔍 RICHIESTA NOLEGGIO - PREZZI VISUALIZZATI\n\n` +
    `👤 ${profileName}\n` +
    `📞 ${incomingFrom}\n\n` +
    `🚐 Mezzo richiesto: ${data.requestedVehicle}\n` +
    `📅 Periodo: ${data.startLabel} - ${data.endLabel}\n` +
    `🚗 Km richiesti: ${data.requestedKm} km\n\n`;

  data.vehicles.forEach((v, i) => {
    text += `${i + 1}) ${v.name}${v.code ? ` (${v.code})` : ''} - € ${formatEuroNumber(v.estimatedTotalAmount)}\n`;
  });

  await sendInternalNotification(GENERAL_NUMBERS, text);
}
async function notifyPaymentSuccess(data) {
  const text =
    `✅ PAGAMENTO RICEVUTO\n\n` +
    `👤 ${data.customerName}\n` +
    `📞 ${data.customerWhatsapp}\n\n` +
    `🚐 ${data.vehicleName}\n` +
    `📅 ${data.startLabel} - ${data.endLabel}\n` +
    `💰 € ${formatEuroNumber(data.amount)}\n` +
    `🧾 ${data.codiceTransazione}`;

  await sendInternalNotification(GENERAL_NUMBERS, text);
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
    pendingOptions: null,
    lastDateRange: null,
    lastRequestedVehicle: null
  };
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
    pendingOptions: null,
    lastDateRange: null,
    lastRequestedVehicle: null
  };
  return sessions[phone];
}

function clearSession(phone) {
  delete sessions[phone];
}

function setSessionIntent(session, intent) {
  session.intent = intent;
  session.questions = buildQuestions(intent);
  session.state = 'questions';
  session.questionIndex = 0;
  session.answers = [];
  session.pendingOptions = null;
  session.createdAt = Date.now();
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
    if (
      ['1', '2', '3'].includes(normalize(text)) ||
      isMenuCommand(text) ||
      isResetCommand(text) ||
      isBackCommand(text) ||
      isAnotherDateCommand(text)
    ) {
      return { valid: true };
    }

    return {
      valid: false,
      message:
        'Se vuoi scegliere un mezzo scrivimi *1*, *2* oppure *3*.\n' +
        'Se invece vuoi cambiare, puoi scrivere *indietro*, *menu* oppure *altra data*.'
    };
  }

if (intent === 'noleggio' && session.state === 'questions') {
  if (idx === 0) {
    const range = extractDateRange(text);
    if (range) {
      return {
        valid: false,
        message:
          'Prima indicami il *mezzo richiesto* 😊\n\nEsempio: *pulmino*, *furgone*, *auto*.'
      };
    }
  }

  if (idx === 1) {
    const range = extractDateRange(text);
    if (!range) {
      return {
        valid: false,
        message:
          'Non riesco a leggere bene le date.\n\nScrivile così:\n*10/05 - 15/05*'
      };
    }
  }

  if (idx === 2) {
    const km = extractKilometers(text);
    if (km === null) {
      return {
        valid: false,
        message:
          'Indicami solo i *km previsti* in numero.\n\nEsempio: *300*'
      };
    }
  }
}
    if (idx === 1) {
      const range = extractDateRange(text);
      if (!range) {
        return {
          valid: false,
          message:
            'Non riesco a leggere bene le date.\n\nScrivile così:\n*10/05 - 15/05*'
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
            'Prima indicami il *tipo di mezzo* 😊\n\nEsempio: *Auto*, *Furgone*, *Camper*.'
        };
      }
    }

    if (idx === 1) {
      const range = extractDateRange(text);
      if (!range) {
        return {
          valid: false,
          message:
            'Non riesco a leggere bene le date.\n\nScrivile così:\n*10/05 - 15/05*'
        };
      }
    }

    if (idx === 2 || idx === 3) {
      const yn = yesNoLabel(text);
      if (yn !== 'SÌ' && yn !== 'NO') {
        return {
          valid: false,
          message: 'Rispondimi solo con *sì* oppure *no*.'
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

app.post('/nexi/notify', async (req, res) => {
  try {
    const body = req.body || {};

    console.log('NEXI NOTIFY BODY:', JSON.stringify(body, null, 2));

    const codiceTransazione =
      body.codiceTransazione ||
      body.codTrans ||
      body.codice ||
      '';

    const esito =
      body.esito ||
      body.outcome ||
      body.status ||
      '';

    if (String(esito).toUpperCase() === 'OK' && transactions[codiceTransazione]) {
      await notifyPaymentSuccess(transactions[codiceTransazione]);
      delete transactions[codiceTransazione];
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Errore Nexi notify:', error);
    res.sendStatus(500);
  }
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
  const incomingFrom = (req.body.From || '').toLowerCase().trim();
  const profileName = req.body.ProfileName || 'Cliente';
  const messageSid = req.body.MessageSid || '';
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    console.log('NUMERO:', incomingFrom);
    console.log('MESSAGGIO:', incomingText);
    console.log('SID:', messageSid);

    if (!incomingFrom) {
      twiml.message('Si è verificato un errore nella ricezione del messaggio.');
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (alreadyProcessedMessage(messageSid)) {
      console.log('Messaggio duplicato ignorato:', messageSid);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(new twilio.twiml.MessagingResponse().toString());
    }

    rememberProcessedMessage(messageSid);

    let session = sessions[incomingFrom];

    if (session && isExpired(session)) {
      clearSession(incomingFrom);
      session = null;
    }

    if (isResetCommand(incomingText)) {
      resetSession(incomingFrom, profileName);
      twiml.message('Conversazione resettata ✅\n\n' + buildWelcomeMenu(profileName));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (isMenuCommand(incomingText)) {
      resetSession(incomingFrom, profileName);
      const s = sessions[incomingFrom];
      s.state = 'menu';
      twiml.message(buildWelcomeMenu(profileName));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (!session) {
      session = createSession(incomingFrom, profileName);
    }

    if (session.state === 'vehicle_choice') {
      if (isBackCommand(incomingText)) {
        session.state = 'questions';
        session.questionIndex = 1;
        session.pendingOptions = null;
        session.createdAt = Date.now();

        twiml.message(
          'Nessun problema 👍\n\n' +
          'Torniamo indietro alle date del noleggio.\n\n' +
          session.questions[1]
        );
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      if (isAnotherDateCommand(incomingText)) {
        session.state = 'questions';
        session.questionIndex = 1;
        session.pendingOptions = null;
        session.createdAt = Date.now();

        twiml.message(
          'Va bene 👍\n\n' +
          'Mandami pure le nuove date del noleggio.\n\n' +
          session.questions[1]
        );
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }
    }

    if (session.state === 'questions' && isBackCommand(incomingText)) {
      if (session.questionIndex > 0) {
        session.questionIndex -= 1;
        session.answers = session.answers.slice(0, session.questionIndex);
        session.createdAt = Date.now();

        twiml.message(
          'Nessun problema 👍\n\n' +
          'Torniamo alla domanda precedente:\n\n' +
          session.questions[session.questionIndex]
        );
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      session.state = 'menu';
      session.intent = null;
      session.questions = [];
      session.answers = [];
      session.questionIndex = 0;
      session.pendingOptions = null;
      session.createdAt = Date.now();

      twiml.message(
        'Va bene, torniamo al menu principale 👌\n\n' +
        buildWelcomeMenu(profileName)
      );
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'idle') {
      const directIntent =
        intentFromMenuChoice(incomingText) ||
        detectIntent(incomingText);

      if (directIntent && directIntent !== 'generico') {
        setSessionIntent(session, directIntent);
        twiml.message(
          buildStartMessageByIntent(directIntent, profileName) +
          '\n\n' +
          session.questions[0]
        );
      } else {
        session.state = 'menu';
        twiml.message(buildWelcomeMenu(profileName));
      }

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'menu') {
      const chosenIntent =
        intentFromMenuChoice(incomingText) ||
        detectIntent(incomingText);

      if (!chosenIntent || chosenIntent === 'generico') {
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
        twiml.message(
          'Scelta non valida 😊\n\n' +
          'Scrivimi *1*, *2* oppure *3*.\n' +
          'Se vuoi cambiare, puoi scrivere anche *indietro*, *menu* oppure *altra data*.'
        );
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      let internalExtra = {
  fromCarRental: true,
  requestedVehicle: session.pendingOptions.requestedVehicle,
  vehicleName: selected.code
    ? `${selected.name} (${selected.code})`
    : selected.name,
  vehicleCode: selected.code,
  startLabel: session.pendingOptions.startLabel,
  endLabel: session.pendingOptions.endLabel,
  days: session.pendingOptions.days,
  requestedKm: session.pendingOptions.requestedKm || 0,
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

          transactions[payment.codiceTransazione] = {
            codiceTransazione: payment.codiceTransazione,
            requestedKm: session.pendingOptions.requestedKm || 0,            customerName: profileName,
            customerWhatsapp: incomingFrom,
            vehicleName: selected.code
              ? `${selected.name} (${selected.code})`
              : selected.name,
            startLabel: session.pendingOptions.startLabel,
            endLabel: session.pendingOptions.endLabel,
            amount: selected.estimatedTotalAmount
          };
        } catch (error) {
          console.error('Errore Nexi scelta mezzo:', error.message);
        }
      }

      const confirmationMessage = buildCustomerConfirmation(
        session.intent,
        profileName,
        internalExtra
      );

      twiml.message(confirmationMessage);
      clearSession(incomingFrom);

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'questions') {
      const switchedIntent = detectServiceSwitch(incomingText, session.intent);

      if (switchedIntent === 'menu') {
        resetSession(incomingFrom, profileName);
        sessions[incomingFrom].state = 'menu';
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

      if (
        session.intent === 'noleggio' &&
        session.questionIndex === 1 &&
        extractDateRange(incomingText)
      ) {
        // continua nella gestione normale
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

        const internalMessage = buildInternalMessage(
          session,
          incomingFrom,
          profileName,
          internalExtra
        );
        await sendInternalNotification(getRecipients(session.intent), internalMessage);
      } else if (session.intent === 'noleggio') {
  const requestedVehicle = session.answers[0];
  const dateRange = extractDateRange(session.answers[1]);
  const requestedKm = extractKilometers(session.answers[2]) || 0;

  session.lastRequestedVehicle = requestedVehicle;
  session.lastDateRange = dateRange;

  if (dateRange && canUseCarRental()) {
    try {
      const avail = await getCarRentalAvailability({
        vehicleText: requestedVehicle,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate
      });

      console.log(
        'VEICOLI TROVATI:',
        JSON.stringify(
          avail.vehicles.map((v) => ({
            code: v.code,
            name: v.name,
            estimatedTotalAmount: v.estimatedTotalAmount
          })),
          null,
          2
        )
      );

      if (avail.vehicles.length > 0) {
        const topVehicles = avail.vehicles.slice(0, 3);

        await notifyPrices(profileName, incomingFrom, {
          requestedVehicle,
          startLabel: dateRange.startLabel,
          endLabel: dateRange.endLabel,
          requestedKm,
          vehicles: topVehicles
        });

        session.state = 'vehicle_choice';
        session.pendingOptions = {
          requestedVehicle,
          startLabel: dateRange.startLabel,
          endLabel: dateRange.endLabel,
          days: dateRange.days,
          requestedKm,
          vehicles: topVehicles
        };

        twiml.message(
          buildVehicleChoiceMessage(
            profileName,
            requestedVehicle,
            dateRange,
            requestedKm,
            topVehicles
          )
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

      session.state = 'questions';
      session.questionIndex = 1;
      session.answers = [requestedVehicle];
      session.createdAt = Date.now();

      twiml.message(confirmationMessage);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    } catch (error) {
      console.error('Errore disponibilità gestionale:', error.message);

      const errMsg = String(error.message || '').toLowerCase();

      if (
        errMsg.includes('stazione scelta non risulta aperta') ||
        errMsg.includes('ritiro della macchina')
      ) {
        internalExtra = {
          unavailableBecauseStationClosed: true,
          requestedVehicle,
          startLabel: dateRange.startLabel,
          endLabel: dateRange.endLabel
        };

        confirmationMessage = buildCustomerConfirmation(
          session.intent,
          profileName,
          internalExtra
        );

        session.state = 'questions';
        session.questionIndex = 1;
        session.answers = [requestedVehicle];
        session.createdAt = Date.now();

        twiml.message(confirmationMessage);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      const fallback = computeNoleggioFallbackWithKm(session.answers);

      if (fallback) {
        internalExtra = {
          startLabel: fallback.startLabel,
          endLabel: fallback.endLabel,
          days: fallback.giorni,
          requestedKm: fallback.requestedKm,
          kmIncluded: fallback.kmIncluded,
          extraKm: fallback.extraKm,
          extraKmExVat: fallback.extraKmExVat,
          extraKmTotalExVat: fallback.extraKmTotalExVat,
          baseTotalExVat: fallback.baseTotalExVat,
          totalExVat: fallback.totalExVat,
          totalIncVat: fallback.totalIncVat
        };

        if (canUseNexi()) {
          try {
            const payment = await createNexiPayMailLink({
              amountCents: euroToCents(fallback.totalIncVat),
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
    const fallback = computeNoleggioFallbackWithKm(session.answers);

    if (fallback) {
      internalExtra = {
        startLabel: fallback.startLabel,
        endLabel: fallback.endLabel,
        days: fallback.giorni,
        requestedKm: fallback.requestedKm,
        kmIncluded: fallback.kmIncluded,
        extraKm: fallback.extraKm,
        extraKmExVat: fallback.extraKmExVat,
        extraKmTotalExVat: fallback.extraKmTotalExVat,
        baseTotalExVat: fallback.baseTotalExVat,
        totalExVat: fallback.totalExVat,
        totalIncVat: fallback.totalIncVat
      };

      if (canUseNexi()) {
        try {
          const payment = await createNexiPayMailLink({
            amountCents: euroToCents(fallback.totalIncVat),
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
            session.state = 'questions';
            session.questionIndex = 1;
            session.answers = [requestedVehicle];
            session.createdAt = Date.now();

            twiml.message(confirmationMessage);
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            return res.end(twiml.toString());
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

        const internalMessage = buildInternalMessage(
          session,
          incomingFrom,
          profileName,
          internalExtra
        );
        await sendInternalNotification(getRecipients(session.intent), internalMessage);
      }

      twiml.message(confirmationMessage);
      clearSession(incomingFrom);

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    resetSession(incomingFrom, profileName);
    sessions[incomingFrom].state = 'menu';
    twiml.message(buildWelcomeMenu(profileName));
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  } catch (error) {
    console.error('Errore generale:', error);
    twiml.message(
      'Scusaci, al momento si è verificato un problema tecnico. Riprova tra poco oppure scrivici di nuovo.'
    );
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
