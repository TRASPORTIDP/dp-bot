require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

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

// =========================
// CONFIG
// =========================
const TWILIO_WHATSAPP_NUMBER =
  process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+390744817108';

const OFFICINA_NUMBERS = parseWhatsappList(
  process.env.INTERNAL_OFFICINA_NUMBERS || '+393287377675'
);

const GENERAL_NUMBERS = parseWhatsappList(
  process.env.INTERNAL_GENERAL_NUMBERS || '+393472733226,+393494040073'
);

const LINK_OFFICINA =
  process.env.LINK_OFFICINA ||
  'https://calendly.com/contabilita-trasportidp/appuntamenti-officina-dp';

const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');

const IVA_RATE = 0.22;
const EXTRA_SERA_EUR = Number(process.env.EXTRA_SERA_EUR || '30');

const NOLEGGIO_PRICE_PER_DAY_EUR = parseFloat(
  process.env.NOLEGGIO_PRICE_PER_DAY_EUR || '70'
);
const NOLEGGIO_KM_INCLUDED_PER_DAY = parseInt(
  process.env.NOLEGGIO_KM_INCLUDED_PER_DAY || '150',
  10
);
const NOLEGGIO_EXTRA_KM_EUR = parseFloat(
  process.env.NOLEGGIO_EXTRA_KM_EUR || '0.15'
);
const NOLEGGIO_DEPOSIT_CENTS = parseInt(
  process.env.NOLEGGIO_DEPOSIT_CENTS || '50000',
  10
);

const SOSTA_PRICE_PER_DAY_CENTS = parseInt(
  process.env.SOSTA_PRICE_PER_DAY_CENTS || '2000',
  10
);
const SOSTA_CORRENTE_EXTRA_CENTS = parseInt(
  process.env.SOSTA_CORRENTE_EXTRA_CENTS || '500',
  10
);
const SOSTA_ACQUA_EXTRA_CENTS = parseInt(
  process.env.SOSTA_ACQUA_EXTRA_CENTS || '300',
  10
);

// =========================
// NEXI
// =========================
const NEXI_ENV = (process.env.NEXI_ENV || 'prod').toLowerCase();
const NEXI_API_KEY_ALIAS =
  process.env.NEXI_ALIAS || process.env.NEXI_API_KEY_ALIAS || '';
const NEXI_MAC_KEY = process.env.NEXI_MAC_KEY || '';
const NEXI_TIMEOUT_HOURS = parseInt(process.env.NEXI_TIMEOUT_HOURS || '4', 10);

const NEXI_BASE_URL =
  NEXI_ENV === 'test'
    ? 'https://int-ecommerce.nexi.it'
    : 'https://ecommerce.nexi.it';

const NEXI_PAYMAIL_ENDPOINT = `${NEXI_BASE_URL}/ecomm/api/bo/richiestaPayMail`;

// =========================
// CAR RENTAL SOFTWARE OTA SOAP
// =========================
const CARRENTAL_UID = process.env.CARRENTAL_UID || '';
const CARRENTAL_API_KEY = process.env.CARRENTAL_API_KEY || '';
const CARRENTAL_AVAIL_URL =
  process.env.CARRENTAL_AVAIL_URL || 'https://crsbrk00.myappy.it/web/ota/';
const CARRENTAL_RES_URL =
  process.env.CARRENTAL_RES_URL || CARRENTAL_AVAIL_URL;
const CARRENTAL_LOCATION_CODE =
  process.env.CARRENTAL_LOCATION_CODE || '57529906';

// =========================
// MEMORY
// =========================
const sessions = {};
const requestsByCode = {};
const transactions = {};
const processedMessageSids = new Map();
const processedMessageFingerprints = new Map();

// =========================
// BASIC UTILS
// =========================
function parseWhatsappList(value) {
  return String(value || '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => (n.startsWith('whatsapp:') ? n : `whatsapp:${n}`));
}

function cleanText(text) {
  return String(text || '').trim();
}

function normalize(text) {
  return cleanText(text).toLowerCase();
}

function formatCustomerName(profileName) {
  return cleanText(profileName) || 'Cliente';
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

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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

function toLocalMidday(dateObj) {
  return new Date(
    dateObj.getFullYear(),
    dateObj.getMonth(),
    dateObj.getDate(),
    12,
    0,
    0,
    0
  );
}

function diffDaysInclusive(startDate, endDate) {
  const ms = toLocalMidday(endDate) - toLocalMidday(startDate);
  const days = Math.round(ms / (1000 * 60 * 60 * 24)) + 1;
  return days > 0 ? days : null;
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

function extractKilometers(text) {
  const raw = normalize(text).replace(/\./g, '').replace(/,/g, '.');
  const match = raw.match(/(\d{1,6})/);
  if (!match) return null;

  const km = parseInt(match[1], 10);
  if (!Number.isFinite(km) || km < 0) return null;
  return km;
}

function isSameDay(a, b) {
  return (
    a.getDate() === b.getDate() &&
    a.getMonth() === b.getMonth() &&
    a.getFullYear() === b.getFullYear()
  );
}

function getNowDecimalHour() {
  const now = new Date();
  return now.getHours() + now.getMinutes() / 60;
}

function isRitiroSeraleWindow(startDate) {
  if (!startDate) return false;
  const now = new Date();
  if (!isSameDay(now, startDate)) return false;
  const t = getNowDecimalHour();
  return t >= 17 && t <= 18.5;
}

function isAfterEveningCutoff(startDate) {
  if (!startDate) return false;
  const now = new Date();
  if (!isSameDay(now, startDate)) return false;
  return getNowDecimalHour() > 18.5;
}

function computeNoleggioQuote({ startDate, endDate, requestedKm }) {
  const giorni = diffDaysInclusive(startDate, endDate);
  if (!giorni) return null;

  const kmIncluded = NOLEGGIO_KM_INCLUDED_PER_DAY * giorni;
  const extraKm = Math.max(0, Number(requestedKm || 0) - kmIncluded);

  const baseTotalExVat = NOLEGGIO_PRICE_PER_DAY_EUR * giorni;
  const extraKmTotalExVat = extraKm * NOLEGGIO_EXTRA_KM_EUR;
  const totalExVat = baseTotalExVat + extraKmTotalExVat;
  const totalIncVat = totalExVat * (1 + IVA_RATE);

  const extraSera = isRitiroSeraleWindow(startDate);
  const totalFinal = totalIncVat + (extraSera ? EXTRA_SERA_EUR : 0);

  return {
    giorni,
    startLabel: formatDateIT(startDate),
    endLabel: formatDateIT(endDate),
    startDate,
    endDate,
    requestedKm: Number(requestedKm || 0),
    kmIncluded,
    extraKm,
    extraKmExVat: NOLEGGIO_EXTRA_KM_EUR,
    extraKmTotalExVat,
    baseTotalExVat,
    totalExVat,
    totalIncVat,
    extraSera,
    totalFinal
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

// =========================
// DEDUPLICA
// =========================
function rememberProcessedMessage(messageSid) {
  if (!messageSid) return;
  processedMessageSids.set(messageSid, Date.now());

  const now = Date.now();
  for (const [sid, ts] of processedMessageSids.entries()) {
    if (now - ts > 15 * 60 * 1000) processedMessageSids.delete(sid);
  }
}

function alreadyProcessedMessage(messageSid) {
  if (!messageSid) return false;
  return processedMessageSids.has(messageSid);
}

function buildMessageFingerprint(from, body) {
  return `${String(from || '').trim().toLowerCase()}|${String(body || '')
    .trim()
    .toLowerCase()}`;
}

function rememberProcessedFingerprint(from, body) {
  const key = buildMessageFingerprint(from, body);
  processedMessageFingerprints.set(key, Date.now());

  const now = Date.now();
  for (const [fp, ts] of processedMessageFingerprints.entries()) {
    if (now - ts > 8000) processedMessageFingerprints.delete(fp);
  }
}

function alreadyProcessedFingerprint(from, body) {
  const key = buildMessageFingerprint(from, body);
  return processedMessageFingerprints.has(key);
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
    selectedRental: null,
    contractData: {}
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
    selectedRental: null,
    contractData: {}
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
  session.selectedRental = null;
  session.contractData = {};
  session.createdAt = Date.now();
}

function isExpired(session) {
  return Date.now() - session.createdAt > 30 * 60 * 1000;
}

// =========================
// NEXI
// =========================
function canUseNexi() {
  return Boolean(NEXI_API_KEY_ALIAS && NEXI_MAC_KEY && APP_BASE_URL);
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
    urlBack: `${APP_BASE_URL}/nexi/cancel`,
    urlpost: `${APP_BASE_URL}/nexi/notify`,
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

  if (String(data.esito).toUpperCase() !== 'OK') {
    const detail =
      data?.errore?.messaggio ||
      data?.errore?.description ||
      data?.errore?.codice ||
      data?.messaggio ||
      'Operazione Nexi non riuscita';
    throw new Error(detail);
  }

  const payMailUrl = data.payMailUrl || data.url || data.paymentUrl || '';
  if (!payMailUrl) throw new Error('Link pagamento Nexi non restituito');

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
    payMailUrl,
    idOperazione: data.idOperazione || ''
  };
}

// =========================
// GESTIONALE SOAP
// =========================
function canUseCarRental() {
  return Boolean(CARRENTAL_UID && CARRENTAL_API_KEY && CARRENTAL_AVAIL_URL && CARRENTAL_LOCATION_CODE);
}

function canUseCarRentalReservation() {
  return Boolean(CARRENTAL_UID && CARRENTAL_API_KEY && CARRENTAL_RES_URL && CARRENTAL_LOCATION_CODE);
}

function buildSoapAuthBlock() {
  return `
    <POS>
      <Source>
        <RequestorID Type="29" ID="${xmlEscape(CARRENTAL_UID)}" MessagePassword="${xmlEscape(CARRENTAL_API_KEY)}"/>
      </Source>
    </POS>
  `;
}

function toIsoDateTimeLocalStart(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');

  const now = new Date();
  let hour = 9;

  if (isSameDay(now, dateObj)) {
    const currentHour = now.getHours();
    const currentMinutes = now.getMinutes();

    if (currentHour >= 17) {
      hour = 18;
    } else {
      hour = Math.max(9, currentHour + (currentMinutes > 0 ? 1 : 0));
      if (hour > 18) hour = 18;
    }
  }

  return `${y}-${m}-${d}T${String(hour).padStart(2, '0')}:00:00`;
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

function sanitizeVehicleCode(code) {
  return String(code || '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .trim();
}

function prettifyVehicleCode(code) {
  const c = String(code || '').toUpperCase().trim();

  if (c === 'F1-VAN') return 'Gruppo F1 - Furgone';
  if (c === 'F2-PC') return 'Gruppo F2 - P. Corto';
  if (c === 'F3-PL') return 'Gruppo F3 - P. Lungo';
  if (c === 'P2-9P') return 'Gruppo P2 - 9 Posti';
  if (c === 'P1-8P') return 'Gruppo P1 - 8 Posti';
  if (c === 'A1' || c === 'A1-COMPACT ECO' || c === 'A1 - COMPACT ECO') return 'Gruppo A1 - Compact Eco';
  if (c === 'A2' || c === 'A2-COMPACT' || c === 'A2 - COMPACT') return 'Gruppo A2 - Compact';
  if (c === 'A3' || c === 'A3-COMPACT ELITE' || c === 'A3 - COMPACT ELITE') return 'Gruppo A3 - Compact Elite';

  return c || 'Veicolo disponibile';
}

function humanizeVehicleName(name, code) {
  const cleaned = String(name || '').replace(/\s+/g, ' ').trim();
  const upperCode = String(code || '').toUpperCase().trim();

  if (!cleaned) return prettifyVehicleCode(upperCode);

  const lower = cleaned.toLowerCase();

  if (lower.includes('gruppo')) return cleaned;
  if (upperCode.includes('P2-9P')) return 'Gruppo P2 - 9 Posti';
  if (upperCode.includes('P1-8P')) return 'Gruppo P1 - 8 Posti';
  if (upperCode.includes('F1-VAN')) return 'Gruppo F1 - Furgone';
  if (upperCode.includes('F2-PC')) return 'Gruppo F2 - P. Corto';
  if (upperCode.includes('F3-PL')) return 'Gruppo F3 - P. Lungo';
  if (upperCode.startsWith('A1')) return 'Gruppo A1 - Compact Eco';
  if (upperCode.startsWith('A2')) return 'Gruppo A2 - Compact';
  if (upperCode.startsWith('A3')) return 'Gruppo A3 - Compact Elite';

  return cleaned;
}

function findAmountInObject(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const possibleKeys = [
    '@_EstimatedTotalAmount',
    '@_RateTotalAmount',
    '@_Amount',
    'EstimatedTotalAmount',
    'RateTotalAmount',
    'Amount'
  ];

  for (const key of possibleKeys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      const value = Number(String(obj[key]).replace(',', '.'));
      if (Number.isFinite(value) && value > 0) return value;
    }
  }

  for (const key of Object.keys(obj)) {
    const found = findAmountInObject(obj[key]);
    if (found) return found;
  }

  return null;
}

function normalizeVehicleLabel(item) {
  const vehAvailCore = item?.VehAvailCore || item?.['ns1:VehAvailCore'] || {};
  const vehAvailInfo = item?.VehAvailInfo || item?.['ns1:VehAvailInfo'] || {};
  const vehicle = item?.Vehicle || item?.['ns1:Vehicle'] || vehAvailCore?.Vehicle || {};
  const makeModel = item?.VehMakeModel || item?.['ns1:VehMakeModel'] || vehicle?.VehMakeModel || {};
  const vehClass = item?.VehClass || item?.['ns1:VehClass'] || vehicle?.VehClass || {};
  const vehType = item?.VehType || item?.['ns1:VehType'] || vehicle?.VehType || {};

  const totalCharge =
    item?.TotalCharge ||
    item?.['ns1:TotalCharge'] ||
    vehAvailCore?.TotalCharge ||
    vehAvailCore?.['ns1:TotalCharge'] ||
    vehAvailInfo?.TotalCharge ||
    vehAvailInfo?.['ns1:TotalCharge'] ||
    null;

  const rawCode =
    vehicle?.['@_Code'] ||
    makeModel?.['@_Code'] ||
    vehClass?.['@_Code'] ||
    vehType?.['@_Code'] ||
    '';

  const code = sanitizeVehicleCode(rawCode);

  let name =
    vehicle?.['@_Description'] ||
    vehicle?.['@_Name'] ||
    makeModel?.['@_Name'] ||
    vehClass?.['@_Name'] ||
    vehType?.['@_VehicleCategory'] ||
    '';

  name = humanizeVehicleName(name, code);

  const estimatedTotalAmount = findAmountInObject(totalCharge) || findAmountInObject(item);

  return {
    code: String(code || '').trim(),
    name: String(name || '').trim(),
    estimatedTotalAmount,
    raw: item
  };
}

function matchVehicleAgainstUserText(vehicle, userText) {
  const codeUpper = String(vehicle.code || '').toUpperCase();
  const nameLower = String(vehicle.name || '').toLowerCase();
  const q = normalize(userText);

  if (q.includes('furgone') || q.includes('van')) {
    return (
      codeUpper.startsWith('F') ||
      nameLower.includes('furgone') ||
      nameLower.includes('van') ||
      nameLower.includes('pc') ||
      nameLower.includes('corto') ||
      nameLower.includes('lungo') ||
      nameLower.includes('cargo')
    );
  }

  if (q.includes('pulmino') || q.includes('posti')) {
    return codeUpper.startsWith('P') || nameLower.includes('posti') || nameLower.includes('pulmino');
  }

  if (q.includes('auto') || q.includes('macchina') || q.includes('vettura')) {
    return codeUpper.startsWith('A') || nameLower.includes('auto') || nameLower.includes('compact') || nameLower.includes('eco') || nameLower.includes('elite');
  }

  return true;
}

async function getCarRentalAvailability({ vehicleText, startDate, endDate }) {
  if (!canUseCarRental()) throw new Error('Gestionale non configurato');

  const pickUpDateTime = toIsoDateTimeLocalStart(startDate);
  const returnDateTime = toIsoDateTimeLocalEnd(endDate);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.opentravel.org/OTA/2003/05">
  <SOAP-ENV:Body>
    <ns1:OTA_VehAvailRateRQ>
      ${buildSoapAuthBlock()}
      <VehAvailRQCore>
        <VehRentalCore PickUpDateTime="${pickUpDateTime}" ReturnDateTime="${returnDateTime}">
          <PickUpLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/>
          <ReturnLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/>
        </VehRentalCore>
      </VehAvailRQCore>
    </ns1:OTA_VehAvailRateRQ>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

  const response = await fetch(CARRENTAL_AVAIL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body: xml
  });

  const xmlText = await response.text();
  if (!response.ok) throw new Error(`Errore HTTP gestionale: ${response.status}`);

  const parsed = xmlParser.parse(xmlText);

  const body =
    parsed?.['SOAP-ENV:Envelope']?.['SOAP-ENV:Body'] ||
    parsed?.Envelope?.Body ||
    parsed?.['soap:Envelope']?.['soap:Body'] ||
    parsed?.['soapenv:Envelope']?.['soapenv:Body'];

  if (!body) throw new Error('Risposta SOAP non valida');

  const availRs =
    body?.['ns1:OTA_VehAvailRateRS'] ||
    body?.OTA_VehAvailRateRS ||
    body?.['OTA_VehAvailRateRS'];

  if (!availRs) {
    const errBlock =
      findFirstByKeys(body, ['Errors', 'ns1:Errors']) ||
      findFirstByKeys(body, ['Error', 'ns1:Error']);
    if (errBlock) throw new Error(JSON.stringify(errBlock));
    throw new Error('Risposta disponibilità non riconosciuta');
  }

  const errors = availRs?.Errors || availRs?.['ns1:Errors'];
  if (errors) throw new Error(JSON.stringify(errors));

  const vehAvailsRaw = findFirstByKeys(availRs, ['VehAvail', 'ns1:VehAvail']) || [];
  const vehicles = safeArray(vehAvailsRaw).map(normalizeVehicleLabel);
  const filtered = vehicles.filter((v) => matchVehicleAgainstUserText(v, vehicleText));

  return {
    rawXml: xmlText,
    vehicles: filtered.length ? filtered : vehicles
  };
}

function extractReservationStatus(parsed) {
  const body =
    parsed?.['SOAP-ENV:Envelope']?.['SOAP-ENV:Body'] ||
    parsed?.Envelope?.Body ||
    parsed?.['soap:Envelope']?.['soap:Body'] ||
    parsed?.['soapenv:Envelope']?.['soapenv:Body'];

  const resRs =
    body?.['ns1:OTA_VehResRS'] ||
    body?.OTA_VehResRS ||
    body?.['OTA_VehResRS'];

  const reservation =
    resRs?.['ns1:VehResRSCore']?.VehReservation ||
    resRs?.VehResRSCore?.VehReservation ||
    findFirstByKeys(resRs, ['VehReservation', 'ns1:VehReservation']);

  return reservation?.['@_ReservationStatus'] || reservation?.ReservationStatus || '';
}

async function createCarRentalReservation({ selectedRental, contractData, incomingFrom }) {
  if (!canUseCarRentalReservation()) {
    throw new Error('Creazione contratto gestionale non configurata');
  }

  const pickup = toIsoDateTimeLocalStart(selectedRental.startDate);
  const dropoff = toIsoDateTimeLocalEnd(selectedRental.endDate);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.opentravel.org/OTA/2003/05">
  <SOAP-ENV:Body>
    <ns1:OTA_VehResRQ>
      ${buildSoapAuthBlock()}
      <VehResRQCore>
        <VehRentalCore PickUpDateTime="${pickup}" ReturnDateTime="${dropoff}">
          <PickUpLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/>
          <ReturnLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/>
        </VehRentalCore>
        <VehPref>
          <VehMakeModel Code="${xmlEscape(selectedRental.vehicleCode)}" Name="${xmlEscape(selectedRental.vehicleName)}"/>
        </VehPref>
        <Customer>
          <Primary>
            <PersonName>
              <GivenName>${xmlEscape(contractData.name)}</GivenName>
              <Surname>${xmlEscape(contractData.surname)}</Surname>
            </PersonName>
            <Document DocType="5" DocID="${xmlEscape(contractData.document)}" DocIssueAuthority="${xmlEscape(contractData.documentAuthority || 'Comune')}" ExpireDate="${xmlEscape(contractData.documentExpire || '')}"/>
            <Telephone PhoneNumber="${xmlEscape(incomingFrom.replace('whatsapp:', ''))}"/>
            <Email>${xmlEscape(contractData.email || '')}</Email>
            <Address>
              <AddressLine>${xmlEscape(contractData.address)}</AddressLine>
              <CityName>${xmlEscape(contractData.city || 'IT')}</CityName>
              <CountryName>IT</CountryName>
              <PostalCode>${xmlEscape(contractData.postalCode || '')}</PostalCode>
              <StateProv>${xmlEscape(contractData.province || '')}</StateProv>
            </Address>
          </Primary>
        </Customer>
        <TotalCharge CurrencyCode="EUR" EstimatedTotalAmount="${Number(selectedRental.amount || 0).toFixed(2)}"/>
      </VehResRQCore>
      <VehResRQInfo ResStatus="Book">
        <RentalPaymentPref>
          <PaymentAmount Amount="${Number(selectedRental.amount || 0).toFixed(2)}" CurrencyCode="EUR"/>
          <Voucher Identifier="${xmlEscape(selectedRental.requestCode)}"/>
        </RentalPaymentPref>
      </VehResRQInfo>
    </ns1:OTA_VehResRQ>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

  const response = await fetch(CARRENTAL_RES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body: xml
  });

  const xmlText = await response.text();
  if (!response.ok) throw new Error(`Errore HTTP creazione contratto: ${response.status}`);

  const parsed = xmlParser.parse(xmlText);
  const status = extractReservationStatus(parsed);

  if (status !== 'Reserved') {
    const errBlock =
      findFirstByKeys(parsed, ['Errors', 'ns1:Errors']) ||
      findFirstByKeys(parsed, ['Error', 'ns1:Error']);
    throw new Error(`Contratto non creato. Stato: ${status || 'sconosciuto'} ${errBlock ? JSON.stringify(errBlock) : ''}`);
  }

  return { status, rawXml: xmlText };
}

// =========================
// INTENT / MENU
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
  return ['indietro', 'torna', 'torna indietro', 'annulla'].includes(msg);
}

function isAnotherDateCommand(text) {
  const msg = normalize(text);
  return ['altra data', 'altre date', 'cambio data', 'cambiare data'].includes(msg);
}

function isConfirmCommand(text) {
  const msg = normalize(text);
  return ['confermo', 'ok', 'si', 'sì', 'procedi', 'conferma'].includes(msg);
}

function isCancelCommand(text) {
  const msg = normalize(text);
  return ['annulla', 'no', 'stop'].includes(msg);
}

function detectIntent(text) {
  const msg = normalize(text);

  if (msg.includes('officina') || msg.includes('tagliando') || msg.includes('riparazione') || msg.includes('guasto') || msg.includes('meccanico') || msg.includes('diagnosi')) return 'officina';
  if (msg === '2' || msg === 'noleggio' || msg.includes('noleggiare')) return 'noleggio';
  if (msg === '3' || msg.includes('vendita') || msg.includes('auto usata') || msg.includes('comprare auto')) return 'vendita';
  if (msg === '4' || msg.includes('trasporto') || msg.includes('bisarca') || msg.includes('ritiro veicolo') || msg.includes('consegna veicolo')) return 'trasporto';
  if (msg === '5' || msg.includes('contatto diretto') || msg.includes('responsabile') || msg.includes('parlare')) return 'contatto_diretto';
  if (msg === '6' || msg.includes('parcheggio') || msg.includes('sosta') || msg.includes('camper')) return 'parcheggio_sosta';

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
  return null;
}

function detectServiceSwitch(text, currentIntent) {
  const msg = normalize(text);
  if (isMenuCommand(msg) || isResetCommand(msg)) return 'menu';
  const menuChoice = intentFromMenuChoice(msg);
  if (menuChoice && menuChoice !== currentIntent) return menuChoice;
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
    `Scegli il servizio:\n\n` +
    `1️⃣ Officina\n` +
    `2️⃣ Noleggio\n` +
    `3️⃣ Vendita auto\n` +
    `4️⃣ Trasporto veicoli\n` +
    `5️⃣ Contatto diretto\n` +
    `6️⃣ Parcheggio / Sosta\n\n` +
    `Scrivi solo il numero.\n` +
    `Esempio: *2*`
  );
}

function buildStartMessageByIntent(intent, profileName) {
  const customerName = formatCustomerName(profileName);

  if (intent === 'officina') return `Perfetto ${customerName} 👌\n\nTi passo sul reparto Officina.`;
  if (intent === 'noleggio') return `Perfetto ${customerName} 👌\n\nTi aiuto con il Noleggio.`;
  if (intent === 'vendita') return `Perfetto ${customerName} 👌\n\nTi aiuto per la Vendita auto.`;
  if (intent === 'trasporto') return `Perfetto ${customerName} 👌\n\nTi aiuto con il Trasporto veicoli.`;
  if (intent === 'contatto_diretto') return `Perfetto ${customerName} 👌\n\nTi metto in contatto con un responsabile.`;
  if (intent === 'parcheggio_sosta') return `Perfetto ${customerName} 👌\n\nTi aiuto con Parcheggio / Sosta.`;

  return `Ciao ${customerName} 👋`;
}

function buildQuestions(intent) {
  if (intent === 'officina') {
    return [
      'Che veicolo hai?',
      'Puoi indicarmi la targa?',
      'Che problema ha il veicolo oppure quale intervento vuoi fare?',
      'Hai un giorno preferito per l’appuntamento?'
    ];
  }

  if (intent === 'noleggio') {
    return [
      'Che mezzo ti serve? (es. pulmino, furgone, auto)',
      'Puoi indicarmi le date del noleggio in questo formato?\n\nEsempio: 10/05 - 15/05',
      'Quanti km prevedi di fare in totale?\n\nEsempio: 300'
    ];
  }

  if (intent === 'vendita') {
    return [
      'Che tipo di auto stai cercando?',
      'Qual è il tuo budget indicativo?',
      'Hai una permuta? Se sì, scrivimi modello e anno.'
    ];
  }

  if (intent === 'trasporto') {
    return [
      'Qual è il veicolo da trasportare?',
      'Da dove va ritirato?',
      'Dove va consegnato?',
      'Per quando ti servirebbe il trasporto?'
    ];
  }

  if (intent === 'contatto_diretto') return ['Scrivimi brevemente il motivo della richiesta.'];

  if (intent === 'parcheggio_sosta') {
    return [
      'Che tipo di mezzo devi lasciare? (es. auto, furgone, camper, carrello)',
      'Puoi indicarmi le date della sosta in questo formato?\n\nEsempio: 10/05 - 15/05',
      'Hai bisogno di corrente? (sì / no)',
      'Hai bisogno di acqua? (sì / no)'
    ];
  }

  return [];
}

function buildInvalidChoiceMessage() {
  return (
    'Scelta non valida.\n\n' +
    'Scrivi:\n' +
    '1 per Officina\n' +
    '2 per Noleggio\n' +
    '3 per Vendita auto\n' +
    '4 per Trasporto veicoli\n' +
    '5 per Contatto diretto\n' +
    '6 per Parcheggio / Sosta'
  );
}

function buildServiceChangedMessage(intent, profileName) {
  return 'Va bene 👍\n\n' + buildStartMessageByIntent(intent, profileName) + '\n\n' + buildQuestions(intent)[0];
}

function buildVehicleChoiceMessage(profileName, requestedVehicle, dateRange, requestedKm, vehicles, extraSera = false) {
  const customerName = formatCustomerName(profileName);

  const lines = vehicles.slice(0, 3).map((v, i) => {
    let label = v.name || 'Veicolo disponibile';
    if (v.code && !label.toLowerCase().includes(v.code.toLowerCase())) label += ` (${v.code})`;
    return `${i + 1}️⃣ ${label}\n💰 € ${formatEuroNumber(v.estimatedTotalAmount)}`;
  });

  const extraText = extraSera ? '\n🌙 Ritiro serale oggi: +30€ già compresi nei prezzi.' : '';

  return (
    `Perfetto ${customerName} 👌\n\n` +
    `Ho trovato queste disponibilità per ${requestedVehicle} dal ${dateRange.startLabel} al ${dateRange.endLabel}:\n` +
    `🚗 Km richiesti: ${requestedKm} km${extraText}\n\n` +
    `${lines.join('\n\n')}\n\n` +
    `Scrivimi 1, 2 oppure 3.\n` +
    `Se vuoi cambiare, scrivi indietro oppure altra data.`
  );
}

function buildRentalConfirmMessage(profileName, selectedRental) {
  return (
    `Perfetto ${formatCustomerName(profileName)} 👌\n\n` +
    `Riepilogo noleggio:\n` +
    `🧾 Codice richiesta: ${selectedRental.requestCode}\n` +
    `🚐 Mezzo: ${selectedRental.vehicleName}\n` +
    `📅 Periodo: ${selectedRental.startLabel} - ${selectedRental.endLabel}\n` +
    `🚗 Km richiesti: ${selectedRental.requestedKm} km\n` +
    `💰 Totale noleggio: € ${formatEuroNumber(selectedRental.amount)}\n\n` +
    `Vuoi confermare e generare il contratto?\n\n` +
    `Scrivi *CONFERMO* per procedere.\n` +
    `Scrivi *ANNULLA* per annullare.`
  );
}

function buildCustomerConfirmation(intent, profileName, extra = {}) {
  const customerName = formatCustomerName(profileName);

  if (intent === 'officina') {
    return (
      `Grazie ${customerName} ✅\n\n` +
      `Ho inoltrato la tua richiesta al reparto Officina.\n` +
      `Ti ricontatteremo presto su questo numero.\n\n` +
      `Se preferisci, puoi prenotare anche qui:\n${LINK_OFFICINA}`
    );
  }

  if (intent === 'noleggio') {
    if (extra.afterEveningCutoff) {
      return (
        `Grazie ${customerName} 🙏\n\n` +
        `Per il ritiro di oggi il sistema automatico è disponibile solo fino alle 18:30.\n\n` +
        `Scrivimi una data da domani in poi.\n` +
        `Esempio: 15/04 - 18/04`
      );
    }

    if (extra.unavailable) {
      return (
        `Grazie ${customerName} 🙏\n\n` +
        `Al momento non risultano disponibilità immediate per ${extra.requestedVehicle} dal ${extra.startLabel} al ${extra.endLabel}.\n\n` +
        `Puoi provare con un’altra data.\n` +
        `Esempio: 18/04 - 21/04`
      );
    }

    if (extra.contractCreated) {
      const payText = extra.paymentLink
        ? `Puoi pagare il solo costo del noleggio qui:\n${extra.paymentLink}`
        : `Il contratto è stato creato. Il link pagamento non è disponibile, ti ricontatteremo noi.`;

      return (
        `Contratto creato correttamente ✅\n\n` +
        `🧾 Codice richiesta: ${extra.requestCode}\n` +
        `🚐 Mezzo: ${extra.vehicleName}\n` +
        `📅 Periodo: ${extra.startLabel} - ${extra.endLabel}\n` +
        `🚗 Km richiesti: ${extra.requestedKm || 0} km\n` +
        `💰 Importo noleggio: € ${formatEuroNumber(extra.amount)}\n\n` +
        `${payText}\n\n` +
        `La caparra di € ${eurosFromCents(NOLEGGIO_DEPOSIT_CENTS)} verrà gestita separatamente dal nostro staff.`
      );
    }

    return `Grazie ${customerName} ✅\n\nLa tua richiesta per il reparto Noleggio è stata registrata correttamente.`;
  }

  if (intent === 'vendita') return `Grazie ${customerName} ✅\n\nHo inoltrato correttamente la tua richiesta al reparto Vendita auto.\nTi ricontatteremo presto su questo numero.`;
  if (intent === 'trasporto') return `Grazie ${customerName} ✅\n\nHo inoltrato correttamente la tua richiesta al reparto Trasporto veicoli.\nTi ricontatteremo presto su questo numero.`;
  if (intent === 'contatto_diretto') return `Grazie ${customerName} ✅\n\nHo inoltrato la tua richiesta a un nostro responsabile.\nTi ricontatteremo il prima possibile.`;

  if (intent === 'parcheggio_sosta') {
    const amountLabel = extra.amountCents ? `\n\n💰 Importo calcolato: € ${eurosFromCents(extra.amountCents)}` : '';
    const periodLabel = extra.startLabel && extra.endLabel ? `\n📅 Periodo: dal ${extra.startLabel} al ${extra.endLabel} (${extra.days} giorni)` : '';
    const paymentPart = extra.paymentLink ? `\n\nPer confermare puoi pagare qui:\n${extra.paymentLink}` : '\n\nTi invieremo conferma e modalità di pagamento al più presto.';

    return `Grazie ${customerName} ✅\n\nLa tua richiesta per Parcheggio / Sosta è stata registrata correttamente.` + periodLabel + amountLabel + paymentPart;
  }

  return `Grazie ${customerName} ✅\n\nHo ricevuto correttamente la tua richiesta.\nTi ricontatteremo al più presto.`;
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
    const periodLine = dateRange ? `Periodo: dal ${dateRange.startLabel} al ${dateRange.endLabel} (${dateRange.days} giorni)\n` : `Date richieste: ${a[1] || '-'}\n`;

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

  return `🔔 NUOVA RICHIESTA GENERICA\n\n👤 Nome WhatsApp: ${customerName}\n📞 Numero cliente: ${whatsappNumber}`;
}

function buildInternalRentalContractMessage(session, incomingFrom, profileName, extra = {}) {
  const r = session.selectedRental || {};
  const c = session.contractData || {};

  return (
    `🧾 CONTRATTO NOLEGGIO CREATO\n\n` +
    `Codice richiesta: ${r.requestCode || '-'}\n` +
    `Stato gestionale: ${extra.status || '-'}\n\n` +
    `👤 Cliente WhatsApp: ${formatCustomerName(profileName)}\n` +
    `📞 Numero: ${formatWhatsappNumber(incomingFrom)}\n\n` +
    `Cliente contratto: ${c.name || '-'} ${c.surname || '-'}\n` +
    `CF: ${c.cf || '-'}\n` +
    `Documento: ${c.document || '-'}\n` +
    `Scadenza documento: ${c.documentExpire || '-'}\n` +
    `Ente rilascio: ${c.documentAuthority || '-'}\n` +
    `Email: ${c.email || '-'}\n` +
    `Indirizzo: ${c.address || '-'}\n\n` +
    `🚐 Mezzo: ${r.vehicleName || '-'} (${r.vehicleCode || '-'})\n` +
    `📅 Periodo: ${r.startLabel || '-'} - ${r.endLabel || '-'}\n` +
    `🚗 Km: ${r.requestedKm || 0}\n` +
    `💰 Importo: € ${formatEuroNumber(r.amount || 0)}\n` +
    (extra.paymentLink ? `\nLink Nexi: ${extra.paymentLink}\n` : '')
  );
}

// =========================
// NOTIFICHE
// =========================
async function sendInternalNotification(numbers, text) {
  for (const to of numbers) {
    if (to === TWILIO_WHATSAPP_NUMBER) continue;

    try {
      const result = await client.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to,
        body: text
      });
      console.log('✅ NOTIFICA INVIATA', to, result.sid, result.status);
    } catch (error) {
      console.error('❌ ERRORE INVIO NOTIFICA', to, error.message, error.code, error.moreInfo);
    }
  }
}

async function notifyPrices(profileName, incomingFrom, data) {
  let text =
    `🔍 RICHIESTA NOLEGGIO - PREZZI VISUALIZZATI\n\n` +
    `👤 ${profileName}\n` +
    `📞 ${incomingFrom}\n\n` +
    `🚐 Mezzo richiesto: ${data.requestedVehicle}\n` +
    `📅 Periodo: ${data.startLabel} - ${data.endLabel}\n` +
    `🚗 Km richiesti: ${data.requestedKm} km\n`;

  if (data.extraSera) text += `🌙 Ritiro serale oggi: +30€ già compresi nei prezzi\n`;
  text += '\n';

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
    `🚗 Km richiesti: ${data.requestedKm || 0} km\n` +
    `💰 € ${formatEuroNumber(data.amount)}\n` +
    `🧾 ${data.codiceTransazione}\n` +
    (data.requestCode ? `Codice DP: ${data.requestCode}` : '');

  await sendInternalNotification(GENERAL_NUMBERS, text);

  try {
    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: data.customerWhatsapp,
      body:
        `Ciao ${data.customerName} 👋\n\n` +
        `Abbiamo ricevuto correttamente il tuo pagamento ✅\n\n` +
        `🚐 Mezzo: ${data.vehicleName}\n` +
        `📅 Periodo: ${data.startLabel} - ${data.endLabel}\n` +
        `🚗 Km richiesti: ${data.requestedKm || 0} km\n` +
        `💰 Importo: € ${formatEuroNumber(data.amount)}\n\n` +
        `Grazie da Trasporti DP.`
    });
  } catch (error) {
    console.error('Errore invio conferma pagamento al cliente:', error.message);
  }
}

// =========================
// VALIDAZIONI
// =========================
function validateAnswer(session, answer) {
  const intent = session.intent;
  const idx = session.questionIndex;
  const text = cleanText(answer);

  if (session.state === 'vehicle_choice') {
    if (['1', '2', '3'].includes(normalize(text)) || isBackCommand(text) || isAnotherDateCommand(text) || isMenuCommand(text)) {
      return { valid: true };
    }

    return {
      valid: false,
      message: `Se vuoi scegliere un mezzo scrivimi 1, 2 oppure 3.\nSe vuoi cambiare, scrivi indietro oppure altra data.`
    };
  }

  if (intent === 'noleggio' && session.state === 'questions') {
    if (idx === 0 && extractDateRange(text)) {
      return { valid: false, message: `Prima indicami il mezzo richiesto.\n\nEsempio: pulmino, furgone, auto.` };
    }

    if (idx === 1 && !extractDateRange(text)) {
      return { valid: false, message: `Non riesco a leggere bene le date.\n\nScrivile così:\n10/05 - 15/05` };
    }

    if (idx === 2 && extractKilometers(text) === null) {
      return { valid: false, message: `Indicami solo i km previsti in numero.\n\nEsempio: 300` };
    }
  }

  if (intent === 'parcheggio_sosta' && session.state === 'questions') {
    if (idx === 0 && extractDateRange(text)) {
      return { valid: false, message: `Prima indicami il tipo di mezzo.\n\nEsempio: Auto, Furgone, Camper.` };
    }

    if (idx === 1 && !extractDateRange(text)) {
      return { valid: false, message: `Non riesco a leggere bene le date.\n\nScrivile così:\n10/05 - 15/05` };
    }

    if ((idx === 2 || idx === 3) && !['SÌ', 'NO'].includes(yesNoLabel(text))) {
      return { valid: false, message: 'Rispondimi solo con sì oppure no.' };
    }
  }

  return { valid: true };
}

function getContractQuestion(step) {
  const questions = {
    contract_name: 'Per generare il contratto scrivi il tuo NOME.',
    contract_surname: 'Scrivi il COGNOME.',
    contract_cf: 'Scrivi il CODICE FISCALE.',
    contract_document: 'Scrivi tipo e numero documento.\n\nEsempio: Carta identità CA12345AB',
    contract_document_expire: 'Scrivi la scadenza documento.\n\nEsempio: 31/12/2030',
    contract_document_authority: 'Scrivi ente rilascio documento.\n\nEsempio: Comune di Narni',
    contract_email: 'Scrivi la tua email.',
    contract_address: 'Scrivi indirizzo completo di residenza.'
  };

  return questions[step] || '';
}

async function finalizeRentalContract({ session, incomingFrom, profileName, twiml, res }) {
  const selectedRental = session.selectedRental;

  if (!selectedRental) {
    twiml.message('Sessione noleggio non trovata. Scrivi MENU per ricominciare.');
    clearSession(incomingFrom);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  }

  let reservationResult;
  let paymentLink = '';

  try {
    reservationResult = await createCarRentalReservation({
      selectedRental,
      contractData: session.contractData,
      incomingFrom
    });
  } catch (error) {
    console.error('Errore creazione contratto gestionale:', error.message);

    await sendInternalNotification(
      GENERAL_NUMBERS,
      `⚠️ ERRORE CREAZIONE CONTRATTO NOLEGGIO\n\n` +
        `Codice DP: ${selectedRental.requestCode}\n` +
        `Cliente: ${profileName}\n` +
        `Numero: ${incomingFrom}\n` +
        `Errore: ${error.message}\n\n` +
        `Dati raccolti:\n${JSON.stringify(session.contractData, null, 2)}`
    );

    twiml.message(
      `Ho ricevuto i dati, ma al momento non riesco a generare automaticamente il contratto.\n\n` +
        `Codice richiesta: ${selectedRental.requestCode}\n` +
        `Ti contatteremo manualmente per completare la procedura.`
    );

    clearSession(incomingFrom);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  }

  if (canUseNexi() && selectedRental.amount > 0) {
    try {
      const payment = await createNexiPayMailLink({
        amountCents: euroToCents(selectedRental.amount),
        description: `Pagamento noleggio ${selectedRental.vehicleName} - ${selectedRental.days} giorni - ${selectedRental.requestCode}`,
        customerWhatsapp: formatWhatsappNumber(incomingFrom)
      });

      paymentLink = payment.payMailUrl;

      transactions[payment.codiceTransazione] = {
        codiceTransazione: payment.codiceTransazione,
        requestCode: selectedRental.requestCode,
        customerName: `${session.contractData.name} ${session.contractData.surname}`.trim() || profileName,
        customerWhatsapp: incomingFrom,
        vehicleName: selectedRental.vehicleName,
        startLabel: selectedRental.startLabel,
        endLabel: selectedRental.endLabel,
        requestedKm: selectedRental.requestedKm || 0,
        amount: selectedRental.amount
      };
    } catch (error) {
      console.error('Errore Nexi dopo contratto:', error.message);
    }
  }

  await sendInternalNotification(
    GENERAL_NUMBERS,
    buildInternalRentalContractMessage(session, incomingFrom, profileName, {
      status: reservationResult.status,
      paymentLink
    })
  );

  twiml.message(
    buildCustomerConfirmation('noleggio', profileName, {
      contractCreated: true,
      requestCode: selectedRental.requestCode,
      vehicleName: selectedRental.vehicleName,
      startLabel: selectedRental.startLabel,
      endLabel: selectedRental.endLabel,
      requestedKm: selectedRental.requestedKm,
      amount: selectedRental.amount,
      paymentLink
    })
  );

  clearSession(incomingFrom);
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  return res.end(twiml.toString());
}

// =========================
// ROUTE BASE
// =========================
app.get('/', (req, res) => {
  res.send('Server WhatsApp DP attivo ✅');
});

app.get('/nexi/result', async (req, res) => {
  try {
    const codiceTransazione = req.query.codiceTransazione || req.query.codTrans || req.query.orderId || '';

    if (codiceTransazione && transactions[codiceTransazione]) {
      const tx = transactions[codiceTransazione];
      if (!tx.notifiedSuccessPage) {
        tx.notifiedSuccessPage = true;
        await notifyPaymentSuccess(tx);
      }
    }
  } catch (error) {
    console.error('Errore pagina success Nexi:', error.message);
  }

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
      body.orderId ||
      body.codTrans ||
      body.codice ||
      body.transactionId ||
      '';

    const esito = body.esito || body.outcome || body.status || body.result || '';

    if (String(esito).toUpperCase() === 'OK' && transactions[codiceTransazione]) {
      const tx = transactions[codiceTransazione];
      if (!tx.notifiedServerCallback) {
        tx.notifiedServerCallback = true;
        await notifyPaymentSuccess(tx);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Errore Nexi notify:', error);
    res.sendStatus(500);
  }
});

// =========================
// WEBHOOK WHATSAPP
// =========================
app.post('/whatsapp', async (req, res) => {
  const incomingText = cleanText(req.body.Body);
  const incomingFrom = cleanText(req.body.From).toLowerCase();
  const profileName = req.body.ProfileName || 'Cliente';
  const messageSid = cleanText(req.body.MessageSid);
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
      console.log('Messaggio duplicato ignorato da SID:', messageSid);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(new twilio.twiml.MessagingResponse().toString());
    }

    if (alreadyProcessedFingerprint(incomingFrom, incomingText)) {
      console.log('Messaggio duplicato ignorato da fingerprint:', incomingFrom, incomingText);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(new twilio.twiml.MessagingResponse().toString());
    }

    rememberProcessedMessage(messageSid);
    rememberProcessedFingerprint(incomingFrom, incomingText);

    let session = sessions[incomingFrom];
    if (session && isExpired(session)) {
      clearSession(incomingFrom);
      session = null;
    }

    if (!session) {
      session = createSession(incomingFrom, profileName);

      const directIntent = intentFromMenuChoice(incomingText) || detectIntent(incomingText);

      if (directIntent && directIntent !== 'generico') {
        setSessionIntent(session, directIntent);
        twiml.message(buildStartMessageByIntent(directIntent, profileName) + '\n\n' + session.questions[0]);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      session.state = 'menu';
      twiml.message(buildWelcomeMenu(profileName));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (isResetCommand(incomingText) || isMenuCommand(incomingText)) {
      resetSession(incomingFrom, profileName);
      sessions[incomingFrom].state = 'menu';
      twiml.message(buildWelcomeMenu(profileName));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'menu') {
      const chosenIntent = intentFromMenuChoice(incomingText) || detectIntent(incomingText);

      if (!chosenIntent || chosenIntent === 'generico') {
        twiml.message(buildInvalidChoiceMessage());
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      setSessionIntent(session, chosenIntent);
      twiml.message(buildStartMessageByIntent(chosenIntent, profileName) + '\n\n' + session.questions[0]);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    // =========================
    // SCELTA MEZZO NOLEGGIO
    // =========================
    if (session.state === 'vehicle_choice') {
      if (isBackCommand(incomingText) || isAnotherDateCommand(incomingText)) {
        session.state = 'questions';
        session.questionIndex = 1;
        session.answers = [session.pendingOptions?.requestedVehicle || session.answers[0]];
        session.pendingOptions = null;
        session.createdAt = Date.now();

        twiml.message(`Va bene.\n\nMandami pure le date del noleggio.\n\n${session.questions[1]}`);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

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
        twiml.message(`Scelta non valida.\n\nScrivimi 1, 2 oppure 3.\nSe vuoi cambiare, scrivi indietro oppure altra data.`);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      const quote = session.pendingOptions?.quote;
      const prezzoFinale = Math.round(Number(selected.estimatedTotalAmount || quote?.totalFinal || 0) * 100) / 100;
      const amountExVat = Math.round(Number(quote?.totalExVat || prezzoFinale / (1 + IVA_RATE)) * 100) / 100;
      const vatAmount = Math.round((prezzoFinale - amountExVat) * 100) / 100;
      const extraSera = Boolean(quote?.extraSera);
      const requestCode = buildShortOrderId('DP');

      session.selectedRental = {
        requestCode,
        requestedVehicle: session.pendingOptions.requestedVehicle,
        vehicleName: selected.code ? `${selected.name} (${selected.code})` : selected.name,
        vehicleCode: selected.code,
        startLabel: session.pendingOptions.startLabel,
        endLabel: session.pendingOptions.endLabel,
        startDate: session.pendingOptions.startDate,
        endDate: session.pendingOptions.endDate,
        days: session.pendingOptions.days,
        requestedKm: session.pendingOptions.requestedKm || 0,
        amount: prezzoFinale,
        amountExVat,
        vatAmount,
        extraSera
      };

      requestsByCode[requestCode] = {
        incomingFrom,
        profileName,
        selectedRental: session.selectedRental,
        createdAt: Date.now()
      };

      session.state = 'rental_confirm';
      session.createdAt = Date.now();

      await sendInternalNotification(
        GENERAL_NUMBERS,
        `✅ MEZZO SELEZIONATO - ATTESA CONFERMA CONTRATTO\n\n` +
          `Codice DP: ${requestCode}\n` +
          `👤 ${profileName}\n` +
          `📞 ${incomingFrom}\n\n` +
          `🚐 ${session.selectedRental.vehicleName}\n` +
          `📅 ${session.selectedRental.startLabel} - ${session.selectedRental.endLabel}\n` +
          `🚗 Km: ${session.selectedRental.requestedKm}\n` +
          `💰 € ${formatEuroNumber(session.selectedRental.amount)}`
      );

      twiml.message(buildRentalConfirmMessage(profileName, session.selectedRental));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    // =========================
    // CONFERMA PRIMA DEL CONTRATTO
    // =========================
    if (session.state === 'rental_confirm') {
      if (isCancelCommand(incomingText)) {
        twiml.message('Va bene, richiesta annullata. Scrivi MENU se vuoi ricominciare.');
        clearSession(incomingFrom);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      const okDpMatch = normalize(incomingText).startsWith('ok dp');
      if (!isConfirmCommand(incomingText) && !okDpMatch) {
        twiml.message('Per procedere scrivi *CONFERMO*. Per annullare scrivi *ANNULLA*.');
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      session.state = 'contract_name';
      session.contractData = {};
      session.createdAt = Date.now();

      twiml.message(getContractQuestion('contract_name'));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    // =========================
    // RACCOLTA DATI CONTRATTO
    // =========================
    if (session.state === 'contract_name') {
      session.contractData.name = incomingText;
      session.state = 'contract_surname';
      session.createdAt = Date.now();
      twiml.message(getContractQuestion(session.state));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'contract_surname') {
      session.contractData.surname = incomingText;
      session.state = 'contract_cf';
      session.createdAt = Date.now();
      twiml.message(getContractQuestion(session.state));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'contract_cf') {
      session.contractData.cf = incomingText.toUpperCase();
      session.state = 'contract_document';
      session.createdAt = Date.now();
      twiml.message(getContractQuestion(session.state));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'contract_document') {
      session.contractData.document = incomingText;
      session.state = 'contract_document_expire';
      session.createdAt = Date.now();
      twiml.message(getContractQuestion(session.state));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'contract_document_expire') {
      session.contractData.documentExpire = incomingText;
      session.state = 'contract_document_authority';
      session.createdAt = Date.now();
      twiml.message(getContractQuestion(session.state));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'contract_document_authority') {
      session.contractData.documentAuthority = incomingText;
      session.state = 'contract_email';
      session.createdAt = Date.now();
      twiml.message(getContractQuestion(session.state));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'contract_email') {
      session.contractData.email = incomingText;
      session.state = 'contract_address';
      session.createdAt = Date.now();
      twiml.message(getContractQuestion(session.state));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'contract_address') {
      session.contractData.address = incomingText;
      session.createdAt = Date.now();
      return await finalizeRentalContract({ session, incomingFrom, profileName, twiml, res });
    }

    // =========================
    // FLUSSI DOMANDE STANDARD
    // =========================
    if (session.state === 'questions') {
      if (isBackCommand(incomingText)) {
        if (session.questionIndex > 0) {
          session.questionIndex -= 1;
          session.answers = session.answers.slice(0, session.questionIndex);
          session.createdAt = Date.now();

          twiml.message(`Torniamo alla domanda precedente:\n\n${session.questions[session.questionIndex]}`);
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

        twiml.message(buildWelcomeMenu(profileName));
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

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

      if (['officina', 'vendita', 'trasporto', 'contatto_diretto'].includes(session.intent)) {
        const internalMessage = buildInternalMessage(session, incomingFrom, profileName);
        await sendInternalNotification(getRecipients(session.intent), internalMessage);

        twiml.message(buildCustomerConfirmation(session.intent, profileName));
        clearSession(incomingFrom);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      if (session.intent === 'parcheggio_sosta') {
        const quote = computeSostaAmountCents(session.answers);

        const internalExtra = {
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

        const internalMessage = buildInternalMessage(session, incomingFrom, profileName, internalExtra);
        await sendInternalNotification(getRecipients(session.intent), internalMessage);

        twiml.message(buildCustomerConfirmation(session.intent, profileName, internalExtra));
        clearSession(incomingFrom);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      if (session.intent === 'noleggio') {
        const requestedVehicle = session.answers[0];
        const dateRange = extractDateRange(session.answers[1]);
        const requestedKm = extractKilometers(session.answers[2]);

        if (!dateRange || requestedKm === null) {
          session.state = 'questions';
          session.questionIndex = 1;
          session.answers = [requestedVehicle];
          session.createdAt = Date.now();

          twiml.message(`Non riesco a leggere bene i dati del noleggio.\n\nRiproviamo dalle date.\n\n${session.questions[1]}`);
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end(twiml.toString());
        }

        if (isAfterEveningCutoff(dateRange.startDate)) {
          session.state = 'questions';
          session.questionIndex = 1;
          session.answers = [requestedVehicle];
          session.createdAt = Date.now();

          twiml.message(buildCustomerConfirmation('noleggio', profileName, { afterEveningCutoff: true }));
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end(twiml.toString());
        }

        try {
          let vehicles = [];

          if (canUseCarRental()) {
            const avail = await getCarRentalAvailability({
              vehicleText: requestedVehicle,
              startDate: dateRange.startDate,
              endDate: dateRange.endDate
            });
            vehicles = avail.vehicles || [];
          }

          const quote = computeNoleggioQuote({
            startDate: dateRange.startDate,
            endDate: dateRange.endDate,
            requestedKm
          });

          if (!quote) {
            session.state = 'questions';
            session.questionIndex = 1;
            session.answers = [requestedVehicle];
            session.createdAt = Date.now();

            twiml.message(`Non riesco a calcolare il preventivo. Riprova con un’altra data.\n\nEsempio: 18/04 - 21/04`);
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            return res.end(twiml.toString());
          }

          if (!vehicles.length) {
            session.state = 'questions';
            session.questionIndex = 1;
            session.answers = [requestedVehicle];
            session.createdAt = Date.now();

            twiml.message(buildCustomerConfirmation('noleggio', profileName, {
              unavailable: true,
              requestedVehicle,
              startLabel: dateRange.startLabel,
              endLabel: dateRange.endLabel
            }));
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            return res.end(twiml.toString());
          }

          const pricedVehicles = vehicles.slice(0, 3).map((v) => ({
            ...v,
            estimatedTotalAmount: Number(v.estimatedTotalAmount || quote.totalFinal)
          }));

          await notifyPrices(profileName, incomingFrom, {
            requestedVehicle,
            startLabel: dateRange.startLabel,
            endLabel: dateRange.endLabel,
            requestedKm,
            vehicles: pricedVehicles,
            extraSera: quote.extraSera
          });

          session.state = 'vehicle_choice';
          session.pendingOptions = {
            requestedVehicle,
            startLabel: dateRange.startLabel,
            endLabel: dateRange.endLabel,
            startDate: dateRange.startDate,
            endDate: dateRange.endDate,
            days: dateRange.days,
            requestedKm,
            quote,
            vehicles: pricedVehicles
          };
          session.createdAt = Date.now();

          twiml.message(buildVehicleChoiceMessage(profileName, requestedVehicle, dateRange, requestedKm, pricedVehicles, quote.extraSera));
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end(twiml.toString());
        } catch (error) {
          console.error('Errore disponibilità gestionale:', error.message);

          session.state = 'questions';
          session.questionIndex = 1;
          session.answers = [requestedVehicle];
          session.createdAt = Date.now();

          twiml.message(buildCustomerConfirmation('noleggio', profileName, {
            unavailable: true,
            requestedVehicle,
            startLabel: dateRange.startLabel,
            endLabel: dateRange.endLabel
          }));
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end(twiml.toString());
        }
      }
    }

    resetSession(incomingFrom, profileName);
    sessions[incomingFrom].state = 'menu';
    twiml.message(buildWelcomeMenu(profileName));
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  } catch (error) {
    console.error('Errore generale:', error);
    twiml.message('Scusaci, al momento si è verificato un problema tecnico. Riprova tra poco oppure scrivici di nuovo.');
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  }
});

app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
