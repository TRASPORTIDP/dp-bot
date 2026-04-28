require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseAttributeValue: false, trimValues: true });

// =========================
// CONFIG
// =========================
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+390744817108';
const OFFICINA_NUMBERS = ['whatsapp:+393287377675'];
const GENERAL_NUMBERS = ['whatsapp:+393472733226', 'whatsapp:+393494040073'];
const LINK_OFFICINA = 'https://calendly.com/contabilita-trasportidp/appuntamenti-officina-dp';
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const MAX_NOLEGGIO_DAYS = parseInt(process.env.MAX_NOLEGGIO_DAYS || '30', 10);
const NOLEGGIO_DEPOSIT_CENTS = parseInt(process.env.NOLEGGIO_DEPOSIT_CENTS || '50000', 10);

const SOSTA_PRICE_PER_DAY_CENTS = parseInt(process.env.SOSTA_PRICE_PER_DAY_CENTS || '2000', 10);
const SOSTA_CORRENTE_EXTRA_CENTS = parseInt(process.env.SOSTA_CORRENTE_EXTRA_CENTS || '500', 10);
const SOSTA_ACQUA_EXTRA_CENTS = parseInt(process.env.SOSTA_ACQUA_EXTRA_CENTS || '300', 10);

// Nexi
const NEXI_ENV = (process.env.NEXI_ENV || 'prod').toLowerCase();
const NEXI_API_KEY_ALIAS = process.env.NEXI_ALIAS || '';
const NEXI_MAC_KEY = process.env.NEXI_MAC_KEY || '';
const NEXI_TIMEOUT_HOURS = parseInt(process.env.NEXI_TIMEOUT_HOURS || '4', 10);
const NEXI_BASE_URL = NEXI_ENV === 'test' ? 'https://int-ecommerce.nexi.it' : 'https://ecommerce.nexi.it';
const NEXI_PAYMAIL_ENDPOINT = `${NEXI_BASE_URL}/ecomm/api/bo/richiestaPayMail`;

// Gestionale OTA
const CARRENTAL_UID = process.env.CARRENTAL_UID || '';
const CARRENTAL_API_KEY = process.env.CARRENTAL_API_KEY || '';
const CARRENTAL_AVAIL_URL = process.env.CARRENTAL_AVAIL_URL || 'https://crsbrk00.myappy.it/web/ota/';
const CARRENTAL_RES_URL = process.env.CARRENTAL_RES_URL || 'https://carrentalsoftware.myappy.it/web/ota/';
const CARRENTAL_LOCATION_CODE = process.env.CARRENTAL_LOCATION_CODE || '57529906';

// =========================
// MEMORIA
// =========================
const sessions = {};
const processedMessageSids = new Map();
const processedMessageFingerprints = new Map();
const transactions = {};

// =========================
// UTILITY
// =========================
function cleanText(text) { return String(text || '').trim(); }
function normalize(text) { return cleanText(text).toLowerCase(); }
function formatCustomerName(profileName) { return cleanText(profileName) || 'Cliente'; }
function formatWhatsappNumber(number) { return cleanText(number) || '-'; }
function eurosFromCents(cents) { return (Number(cents || 0) / 100).toFixed(2).replace('.', ','); }
function formatEuroNumber(value) { return Number(value || 0).toFixed(2).replace('.', ','); }
function euroToCents(value) { return Math.round(Number(value || 0) * 100); }
function yesNoLabel(value) {
  const msg = normalize(value);
  if (['si', 'sì', 'yes', 'y', 'ok', 'certo'].includes(msg)) return 'SÌ';
  if (['no', 'n'].includes(msg)) return 'NO';
  return cleanText(value) || '-';
}
function isYes(value) { return yesNoLabel(value) === 'SÌ'; }
function xmlEscape(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function splitName(fullName) {
  const parts = String(fullName || 'Cliente WhatsApp').trim().split(/\s+/);
  return { name: parts[0] || 'Cliente', surname: parts.slice(1).join(' ') || 'WhatsApp' };
}
function buildShortOrderId(prefix = 'DP') {
  const ts = Date.now().toString().slice(-10);
  const rnd = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${prefix}${ts}${rnd}`.slice(0, 18);
}
function formatDateIT(dateObj) {
  const d = String(dateObj.getDate()).padStart(2, '0');
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${dateObj.getFullYear()}`;
}
function toLocalMidday(dateObj) { return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), 12); }
function diffDaysInclusive(startDate, endDate) {
  const ms = toLocalMidday(endDate) - toLocalMidday(startDate);
  const days = Math.round(ms / 86400000) + 1;
  return days > 0 ? days : null;
}
function parseItalianDate(dayStr, monthStr, yearStr) {
  const day = parseInt(dayStr, 10);
  const month = parseInt(monthStr, 10);
  let year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
  if (String(year).length === 2) year += 2000;
  if (!day || !month || !year) return null;
  const d = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}
function normalizeDateRangeText(text) {
  return normalize(text).replace(/\s+/g, ' ').replace(/\bdal\b/g, '').replace(/\balla\b/g, '').replace(/\bal\b/g, '-').replace(/\ba\b/g, '-').replace(/\bto\b/g, '-').replace(/\s*-\s*/g, '-').trim();
}
function extractDateRange(text) {
  const raw = normalizeDateRangeText(text);
  const regex = /(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\s*-\s*(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/;
  const match = raw.match(regex);
  if (!match) return null;
  const start = parseItalianDate(match[1], match[2], match[3]);
  let end = parseItalianDate(match[4], match[5], match[6]);
  if (!start || !end) return null;
  if (!match[6] && end < start) end = parseItalianDate(match[4], match[5], String(start.getFullYear() + 1));
  if (!end || end < start) return null;
  const days = diffDaysInclusive(start, end);
  if (!days || days > MAX_NOLEGGIO_DAYS) return null;
  return { startDate: start, endDate: end, startLabel: formatDateIT(start), endLabel: formatDateIT(end), days };
}
function extractKilometers(text) {
  const raw = normalize(text).replace(/\./g, '').replace(/,/g, '.');
  const match = raw.match(/(\d{1,6})/);
  if (!match) return null;
  const km = parseInt(match[1], 10);
  return Number.isFinite(km) && km >= 0 ? km : null;
}
function isSameDay(a, b) { return a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear(); }
function getNowDecimalHour() { const n = new Date(); return n.getHours() + n.getMinutes() / 60; }
function isAfterEveningCutoff(startDate) { return startDate && isSameDay(new Date(), startDate) && getNowDecimalHour() > 18.5; }
function toIsoDateTimeLocalStart(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  let hour = 9;
  const now = new Date();
  if (isSameDay(now, dateObj)) {
    hour = now.getHours() >= 17 ? 18 : Math.max(9, now.getHours() + (now.getMinutes() > 0 ? 1 : 0));
    if (hour > 18) hour = 18;
  }
  return `${y}-${m}-${d}T${String(hour).padStart(2, '0')}:00:00`;
}
function toIsoDateTimeLocalEnd(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}T18:00:00`;
}
function safeArray(value) { if (!value) return []; return Array.isArray(value) ? value : [value]; }
function moneyNumber(value) {
  const n = parseFloat(String(value || '0').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
function findFirstByKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of Object.keys(obj)) if (keys.includes(key)) return obj[key];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      const found = findFirstByKeys(val, keys);
      if (found) return found;
    }
  }
  return null;
}
function findAllByKey(obj, keyNames, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (keyNames.includes(key)) out.push(val);
    if (val && typeof val === 'object') findAllByKey(val, keyNames, out);
  }
  return out;
}
function sanitizeVehicleCode(code) { return String(code || '').replace(/\s+/g, ' ').trim(); }
function prettifyVehicleCode(code) {
  const c = String(code || '').toUpperCase().trim();
  if (c === 'F1-VAN') return 'Gruppo F1 - Furgone';
  if (c === 'F2-PC') return 'Gruppo F2 - P. Corto';
  if (c === 'F3-PL') return 'Gruppo F3 - P. Lungo';
  if (c === 'P2-9P') return 'Gruppo P2 - 9 Posti';
  if (c === 'P1-8P') return 'Gruppo P1 - 8 Posti';
  if (c.startsWith('A1')) return 'Gruppo A1 - Compact Eco';
  if (c.startsWith('A2')) return 'Gruppo A2 - Compact';
  if (c.startsWith('A3')) return 'Gruppo A3 - Compact Elite';
  return c || 'Veicolo disponibile';
}
function humanizeVehicleName(name, code) {
  const cleaned = String(name || '').replace(/\s+/g, ' ').trim();
  const upperCode = String(code || '').toUpperCase().trim();
  if (!cleaned) return prettifyVehicleCode(upperCode);
  if (cleaned.toLowerCase().includes('gruppo')) return cleaned;
  return prettifyVehicleCode(upperCode) !== upperCode ? prettifyVehicleCode(upperCode) : cleaned;
}
function matchVehicleAgainstUserText(vehicle, userText) {
  // Mostra sempre tutti i mezzi disponibili restituiti dal gestionale.
  return true;
}
function normalizeVehicleFromVehAvail(item) {
  const vehAvailCore = item?.VehAvailCore || item?.['ns1:VehAvailCore'] || {};
  const vehicle = vehAvailCore?.Vehicle || item?.Vehicle || item?.['ns1:Vehicle'] || {};
  const makeModel = vehicle?.VehMakeModel || item?.VehMakeModel || {};
  const totalCharge = vehAvailCore?.TotalCharge || item?.TotalCharge || {};
  const rentalRate = vehAvailCore?.RentalRate || item?.RentalRate || {};
  const vehicleChargesBlock = rentalRate?.VehicleCharges || vehAvailCore?.VehicleCharges || {};
  const vehicleCharge = safeArray(vehicleChargesBlock?.VehicleCharge || vehicleChargesBlock?.['ns1:VehicleCharge'])[0] || {};
  const taxBlock = vehicleCharge?.TaxAmounts || vehicleCharge?.['ns1:TaxAmounts'] || {};
  const taxAmount = safeArray(taxBlock?.TaxAmount || taxBlock?.['ns1:TaxAmount'])[0] || {};

  const rawCode = vehicle?.['@_Code'] || makeModel?.['@_Code'] || '';
  const code = sanitizeVehicleCode(rawCode);
  const rawName = vehicle?.['@_Description'] || vehicle?.['@_Name'] || makeModel?.['@_Name'] || '';
  const name = humanizeVehicleName(rawName, code);
  const rateTotalAmount = moneyNumber(totalCharge?.['@_RateTotalAmount']);
  const estimatedTotalAmount = moneyNumber(totalCharge?.['@_EstimatedTotalAmount']);
  const vehicleChargeAmount = moneyNumber(vehicleCharge?.['@_Amount'] || rateTotalAmount);
  const taxTotal = moneyNumber(taxAmount?.['@_Total']);

  return {
    code,
    name,
    estimatedTotalAmount,
    rateTotalAmount,
    vehicleChargeAmount,
    taxTotal,
    currencyCode: totalCharge?.['@_CurrencyCode'] || vehicleCharge?.['@_CurrencyCode'] || 'EUR',
    chargeDescription: vehicleCharge?.['@_Description'] || '',
    raw: item
  };
}
function computeSostaAmountCents(answers) {
  const dateRange = extractDateRange(answers[1]);
  const giorni = dateRange?.days || 1;
  let total = giorni * SOSTA_PRICE_PER_DAY_CENTS;
  if (isYes(answers[2])) total += SOSTA_CORRENTE_EXTRA_CENTS;
  if (isYes(answers[3])) total += SOSTA_ACQUA_EXTRA_CENTS;
  return { giorni, totalCents: total, startLabel: dateRange?.startLabel || '', endLabel: dateRange?.endLabel || '' };
}

// =========================
// DEDUPLICA
// =========================
function rememberProcessedMessage(messageSid) {
  if (!messageSid) return;
  processedMessageSids.set(messageSid, Date.now());
  const now = Date.now();
  for (const [sid, ts] of processedMessageSids.entries()) if (now - ts > 15 * 60 * 1000) processedMessageSids.delete(sid);
}
function alreadyProcessedMessage(messageSid) { return messageSid ? processedMessageSids.has(messageSid) : false; }
function buildMessageFingerprint(from, body) { return `${String(from || '').trim().toLowerCase()}|${String(body || '').trim().toLowerCase()}`; }
function rememberProcessedFingerprint(from, body) {
  const key = buildMessageFingerprint(from, body);
  processedMessageFingerprints.set(key, Date.now());
  const now = Date.now();
  for (const [fp, ts] of processedMessageFingerprints.entries()) if (now - ts > 8000) processedMessageFingerprints.delete(fp);
}
function alreadyProcessedFingerprint(from, body) { return processedMessageFingerprints.has(buildMessageFingerprint(from, body)); }

// =========================
// SESSIONI
// =========================
function createSession(phone, profileName) {
  sessions[phone] = { profileName, state: 'idle', intent: null, questionIndex: 0, questions: [], answers: [], createdAt: Date.now(), pendingOptions: null };
  return sessions[phone];
}
function resetSession(phone, profileName = 'Cliente') { return createSession(phone, profileName); }
function clearSession(phone) { delete sessions[phone]; }
function setSessionIntent(session, intent) {
  session.intent = intent;
  session.questions = buildQuestions(intent);
  session.state = 'questions';
  session.questionIndex = 0;
  session.answers = [];
  session.pendingOptions = null;
  session.createdAt = Date.now();
}
function isExpired(session) { return Date.now() - session.createdAt > 30 * 60 * 1000; }

// =========================
// NEXI
// =========================
function canUseNexi() { return Boolean(NEXI_API_KEY_ALIAS && NEXI_MAC_KEY && APP_BASE_URL); }
function generateNexiRequestMac({ apiKey, codiceTransazione, importo, timeStamp }) {
  const source = `apiKey=${apiKey}` + `codiceTransazione=${codiceTransazione}` + `importo=${importo}` + `timeStamp=${timeStamp}` + NEXI_MAC_KEY;
  return crypto.createHash('sha1').update(source).digest('hex');
}
function generateNexiResponseMac({ esito, idOperazione, timeStamp }) {
  const source = `esito=${esito}` + `idOperazione=${idOperazione}` + `timeStamp=${timeStamp}` + NEXI_MAC_KEY;
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
    mac: generateNexiRequestMac({ apiKey: NEXI_API_KEY_ALIAS, codiceTransazione, importo: String(amountCents), timeStamp }),
    timeout: String(NEXI_TIMEOUT_HOURS),
    url: `${APP_BASE_URL}/nexi/result`,
    parametriAggiuntivi: { source: 'whatsapp_bot', description: description || '', customer_whatsapp: customerWhatsapp || '' }
  };
  const response = await fetch(NEXI_PAYMAIL_ENDPOINT, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Errore HTTP Nexi: ${response.status}`);
  if (!data || data.esito !== 'OK') throw new Error(data?.errore?.messaggio || data?.errore?.description || data?.errore?.codice || 'Operazione Nexi non riuscita');
  if (!data.payMailUrl) throw new Error('Link pagamento Nexi non restituito');
  if (data.idOperazione && data.timeStamp && data.mac) {
    const expectedMac = generateNexiResponseMac({ esito: data.esito, idOperazione: data.idOperazione, timeStamp: data.timeStamp });
    if (expectedMac !== data.mac) throw new Error('MAC risposta Nexi non valido');
  }
  return { codiceTransazione, payMailUrl: data.payMailUrl, idOperazione: data.idOperazione || '' };
}

// =========================
// GESTIONALE SOAP
// =========================
function canUseCarRental() { return Boolean(CARRENTAL_UID && CARRENTAL_API_KEY && CARRENTAL_AVAIL_URL && CARRENTAL_LOCATION_CODE); }
function buildSoapAuthBlock() { return `<POS><Source><RequestorID Type="29" ID="${xmlEscape(CARRENTAL_UID)}" MessagePassword="${xmlEscape(CARRENTAL_API_KEY)}"/></Source></POS>`; }
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
  const response = await fetch(CARRENTAL_AVAIL_URL, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xml });
  const xmlText = await response.text();
  if (!response.ok) throw new Error(`Errore HTTP gestionale disponibilità: ${response.status} - ${xmlText}`);
  const parsed = xmlParser.parse(xmlText);
  const body = parsed?.['SOAP-ENV:Envelope']?.['SOAP-ENV:Body'] || parsed?.Envelope?.Body || parsed?.['soap:Envelope']?.['soap:Body'] || parsed?.['soapenv:Envelope']?.['soapenv:Body'];
  if (!body) throw new Error('Risposta SOAP disponibilità non valida');
  const availRs = body?.['ns1:OTA_VehAvailRateRS'] || body?.OTA_VehAvailRateRS || body?.['OTA_VehAvailRateRS'];
  if (!availRs) {
    const errBlock = findFirstByKeys(body, ['Errors', 'ns1:Errors']) || findFirstByKeys(body, ['Error', 'ns1:Error']);
    throw new Error(errBlock ? JSON.stringify(errBlock) : 'Risposta disponibilità non riconosciuta');
  }
  const errors = findFirstByKeys(availRs, ['Errors', 'ns1:Errors', 'Error', 'ns1:Error']);
  if (errors) throw new Error(JSON.stringify(errors));
  const vehAvailsRaw = findAllByKey(availRs, ['VehAvail', 'ns1:VehAvail']).flatMap(safeArray);
  const vehicles = vehAvailsRaw.map(normalizeVehicleFromVehAvail).filter(v => v.code && v.estimatedTotalAmount > 0);
  const filtered = vehicles.filter(v => matchVehicleAgainstUserText(v, vehicleText));
  return { rawXml: xmlText, vehicles: filtered.length ? filtered : vehicles };
}
async function createCarRentalReservation({ customerName, customerWhatsapp, selectedVehicle, startDate, endDate, contractData = null }) {
  if (!canUseCarRental()) throw new Error('Gestionale non configurato');
  const person = contractData ? { name: contractData.first_name, surname: contractData.name } : splitName(customerName);
  const phone = contractData?.phone || String(customerWhatsapp || '').replace('whatsapp:', '').replace(/\s+/g, '');
  const email = contractData?.email || 'cliente@trasportidp.com';
  const birthAttr = contractData?.date_of_birth ? ` BirthDate="${xmlEscape(String(contractData.date_of_birth).slice(0, 10))}"` : '';
  const addressXml = contractData ? `<Address><AddressLine>${xmlEscape(contractData.address)}</AddressLine><CityName>${xmlEscape(contractData.city)}</CityName><CountryName>IT</CountryName><PostalCode>${xmlEscape(contractData.zip_code)}</PostalCode><StateProv>${xmlEscape(contractData.province)}</StateProv></Address>` : '';
  const docXml = contractData?.id_number ? `<Document DocType="5" DocID="${xmlEscape(contractData.id_number)}" DocIssueAuthority="${xmlEscape(contractData.id_issuer)}" EffectiveDate="${xmlEscape(String(contractData.id_issue_date).slice(0, 10))}" ExpireDate="${xmlEscape(String(contractData.id_expiry_date).slice(0, 10))}"/>` : '';
  const additionalDriverXml = contractData?.hasSecondDriver
    ? `<Additional><PersonName><GivenName>${xmlEscape(splitName(contractData.secondDriverName).name)}</GivenName><Surname>${xmlEscape(splitName(contractData.secondDriverName).surname)}</Surname></PersonName><Telephone PhoneNumber="${xmlEscape(phone)}"/></Additional>`
    : '';
  const pickUpDateTime = toIsoDateTimeLocalStart(startDate);
  const returnDateTime = toIsoDateTimeLocalEnd(endDate);
  const rateTotalAmount = Number(selectedVehicle.rateTotalAmount || 0);
  const estimatedTotalAmount = Number(selectedVehicle.estimatedTotalAmount || 0);
  const vehicleChargeAmount = Number(selectedVehicle.vehicleChargeAmount || rateTotalAmount || 0);
  const taxTotal = Number(selectedVehicle.taxTotal || Math.max(0, estimatedTotalAmount - rateTotalAmount));
  const currency = selectedVehicle.currencyCode || 'EUR';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.opentravel.org/OTA/2003/05">
  <SOAP-ENV:Body>
    <ns1:OTA_VehResRQ>
      ${buildSoapAuthBlock()}
      <VehResRQCore>
        <VehRentalCore PickUpDateTime="${pickUpDateTime}" ReturnDateTime="${returnDateTime}">
          <PickUpLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/>
          <ReturnLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/>
        </VehRentalCore>
        <VehPref><VehMakeModel Code="${xmlEscape(selectedVehicle.code)}" Name=""/></VehPref>
        <Customer>
          <Primary>
            <PersonName><GivenName>${xmlEscape(person.name)}</GivenName><Surname>${xmlEscape(person.surname)}</Surname></PersonName>
            <Telephone PhoneNumber="${xmlEscape(phone)}"/>
            <Email>cliente@trasportidp.com</Email>
          </Primary>
        </Customer>
        <VehicleCharges>
          <VehicleCharge Purpose="1" TaxInclusive="false" IncludedInEstTotalInd="true" IncludedInRate="true" Description="${xmlEscape(selectedVehicle.chargeDescription || '')}" Amount="${vehicleChargeAmount.toFixed(2)}" CurrencyCode="${xmlEscape(currency)}">
            <TaxAmounts><TaxAmount CurrencyCode="${xmlEscape(currency)}" Percentage="22" Total="${taxTotal.toFixed(2)}"/></TaxAmounts>
          </VehicleCharge>
        </VehicleCharges>
        <TotalCharge CurrencyCode="${xmlEscape(currency)}" RateTotalAmount="${rateTotalAmount.toFixed(2)}" EstimatedTotalAmount="${estimatedTotalAmount.toFixed(2)}"/>
      </VehResRQCore>
      <VehResRQInfo ResStatus="Book"/>
    </ns1:OTA_VehResRQ>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
  console.log('📤 OTA_VehResRQ:', xml);
  const response = await fetch(CARRENTAL_RES_URL, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xml });
  const xmlText = await response.text();
  console.log('📥 OTA_VehResRS:', xmlText);
  if (!response.ok) throw new Error(`Errore HTTP contratto gestionale: ${response.status} - ${xmlText}`);
  const parsed = xmlParser.parse(xmlText);
  const errors = findFirstByKeys(parsed, ['Errors', 'ns1:Errors', 'Error', 'ns1:Error']);
  if (errors) throw new Error(JSON.stringify(errors));
  const reservation = findFirstByKeys(parsed, ['VehReservation', 'ns1:VehReservation']) || {};
  const reservationStatus = reservation?.['@_ReservationStatus'] || reservation?.ReservationStatus || '';
  const confIds = findAllByKey(parsed, ['ConfID', 'ns1:ConfID']).flatMap(safeArray);
  const conf = confIds.find(c => c?.['@_ID']) || confIds[0] || {};
  const uniqueId = findFirstByKeys(parsed, ['UniqueID', 'ns1:UniqueID']);
  return { rawXml: xmlText, parsed, reservationStatus, confirmationId: conf?.['@_ID'] || uniqueId?.['@_ID'] || uniqueId?.ID || '' };
}

// =========================
// MENU / TESTI
// =========================
function isMenuCommand(text) { const msg = normalize(text); return msg === 'menu' || msg === 'menù' || msg === 'inizio'; }
function isResetCommand(text) { const msg = normalize(text); return msg === 'reset' || msg === 'riavvia' || msg === 'ricomincia'; }
function isBackCommand(text) { return ['indietro', 'torna', 'torna indietro', 'annulla'].includes(normalize(text)); }
function isAnotherDateCommand(text) { return ['altra data', 'altre date', 'cambio data', 'cambiare data'].includes(normalize(text)); }
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
function detectServiceSwitch(text, currentIntent) {
  const msg = normalize(text);
  if (isMenuCommand(msg) || isResetCommand(msg)) return 'menu';
  const menuChoice = intentFromMenuChoice(msg);
  if (menuChoice && menuChoice !== currentIntent) return menuChoice;
  return null;
}
function getRecipients(intent) { return intent === 'officina' ? OFFICINA_NUMBERS : GENERAL_NUMBERS; }
function buildWelcomeMenu(profileName) {
  return `Ciao ${formatCustomerName(profileName)} 👋\n\nScegli il servizio:\n\n1️⃣ Officina\n2️⃣ Noleggio\n3️⃣ Vendita auto\n4️⃣ Trasporto veicoli\n5️⃣ Contatto diretto\n6️⃣ Parcheggio / Sosta\n\nScrivi solo il numero.\nEsempio: *2*`;
}
function buildStartMessageByIntent(intent, profileName) {
  const name = formatCustomerName(profileName);
  if (intent === 'officina') return `Perfetto ${name} 👌\n\nTi passo sul reparto Officina.`;
  if (intent === 'noleggio') return `Perfetto ${name} 👌\n\nTi aiuto con il Noleggio.`;
  if (intent === 'vendita') return `Perfetto ${name} 👌\n\nTi aiuto per la Vendita auto.`;
  if (intent === 'trasporto') return `Perfetto ${name} 👌\n\nTi aiuto con il Trasporto veicoli.`;
  if (intent === 'contatto_diretto') return `Perfetto ${name} 👌\n\nTi metto in contatto con un responsabile.`;
  if (intent === 'parcheggio_sosta') return `Perfetto ${name} 👌\n\nTi aiuto con Parcheggio / Sosta.`;
  return `Ciao ${name} 👋`;
}
function buildQuestions(intent) {
  if (intent === 'officina') return ['Che veicolo hai?', 'Puoi indicarmi la targa?', 'Che problema ha il veicolo oppure quale intervento vuoi fare?', 'Hai un giorno preferito per l’appuntamento?'];
  if (intent === 'noleggio') return ['Che mezzo ti serve? (es. pulmino, furgone, auto)', `Puoi indicarmi le date del noleggio in questo formato?\n\nEsempio: 10/05 - 15/05\n\nPer periodi oltre ${MAX_NOLEGGIO_DAYS} giorni ti contatterà lo staff.`, 'Quanti km prevedi di fare in totale?\n\nEsempio: 300'];
  if (intent === 'vendita') return ['Che tipo di auto stai cercando?', 'Qual è il tuo budget indicativo?', 'Hai una permuta? Se sì, scrivimi modello e anno.'];
  if (intent === 'trasporto') return ['Qual è il veicolo da trasportare?', 'Da dove va ritirato?', 'Dove va consegnato?', 'Per quando ti servirebbe il trasporto?'];
  if (intent === 'contatto_diretto') return ['Scrivimi brevemente il motivo della richiesta.'];
  if (intent === 'parcheggio_sosta') return ['Che tipo di mezzo devi lasciare? (es. auto, furgone, camper, carrello)', 'Puoi indicarmi le date della sosta in questo formato?\n\nEsempio: 10/05 - 15/05', 'Hai bisogno di corrente? (sì / no)', 'Hai bisogno di acqua? (sì / no)'];
  return [];
}

function buildContractQuestions() {
  return [
    'Per preparare il contratto, scrivi nome e cognome del conducente principale.',
    'Data di nascita? Esempio: 04/06/1992',
    'Luogo di nascita?',
    'Codice fiscale?',
    'Email?',
    'Telefono?',
    'Indirizzo completo?',
    'Città?',
    'Provincia?',
    'CAP?',
    'Numero documento / carta identità?',
    'Ente rilascio documento? Esempio: Comune di Palermo',
    'Data rilascio documento? Esempio: 16/01/2020',
    'Scadenza documento? Esempio: 15/01/2025',
    'Numero patente?',
    'Ente rilascio patente? Esempio: Motorizzazione',
    'Data rilascio patente? Esempio: 22/01/2015',
    'Scadenza patente? Esempio: 01/01/2025',
    'C’è un secondo autista? Rispondi SÌ oppure NO.'
  ];
}

function itDateToIsoDateTime(value) {
  const txt = String(value || '').trim();
  const m = txt.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (!m) return txt;
  const d = String(m[1]).padStart(2, '0');
  const mo = String(m[2]).padStart(2, '0');
  let y = String(m[3]);
  if (y.length === 2) y = '20' + y;
  return `${y}-${mo}-${d} 23:00:00`;
}

function parseContractAnswers(answers, profileName, incomingFrom) {
  const split = splitName(answers[0] || profileName);
  const city = answers[7] || '';
  return {
    first_name: split.name,
    name: split.surname,
    date_of_birth: itDateToIsoDateTime(answers[1]),
    place_of_birth: answers[2] || '',
    tax_number: answers[3] || '',
    email: answers[4] || 'cliente@trasportidp.com',
    phone: answers[5] || String(incomingFrom || '').replace('whatsapp:', ''),
    address: answers[6] || '',
    city,
    province: answers[8] || '',
    zip_code: answers[9] || '',
    country_id: '111',
    nationality: 'IT',
    id_type: 'id',
    id_number: answers[10] || '',
    id_issuer: answers[11] || '',
    id_issuer_locality: city,
    id_issue_date: itDateToIsoDateTime(answers[12]),
    id_expiry_date: itDateToIsoDateTime(answers[13]),
    license_number: answers[14] || '',
    license_issuer: answers[15] || '',
    license_issuer_locality: city,
    license_issue_date: itDateToIsoDateTime(answers[16]),
    license_expiry_date: itDateToIsoDateTime(answers[17]),
    hasSecondDriver: yesNoLabel(answers[18]) === 'SÌ',
    secondDriverName: answers[19] || ''
  };
}

function contractSummary(c) {
  let text =
    `👤 Conducente: ${c.first_name || '-'} ${c.name || '-'}\n` +
    `🎂 Nato il: ${c.date_of_birth || '-'} a ${c.place_of_birth || '-'}\n` +
    `🧾 CF: ${c.tax_number || '-'}\n` +
    `📧 Email: ${c.email || '-'}\n` +
    `📞 Tel: ${c.phone || '-'}\n` +
    `🏠 Indirizzo: ${c.address || '-'}, ${c.city || '-'} (${c.province || '-'}) ${c.zip_code || '-'}\n` +
    `🪪 Documento: ${c.id_number || '-'} - scad. ${c.id_expiry_date || '-'}\n` +
    `🚗 Patente: ${c.license_number || '-'} - scad. ${c.license_expiry_date || '-'}`;
  if (c.hasSecondDriver) text += `\n👥 Secondo autista: ${c.secondDriverName || '-'}`;
  return text;
}

function buildInvalidChoiceMessage() { return 'Scelta non valida.\n\nScrivi:\n1 per Officina\n2 per Noleggio\n3 per Vendita auto\n4 per Trasporto veicoli\n5 per Contatto diretto\n6 per Parcheggio / Sosta'; }
function buildServiceChangedMessage(intent, profileName) { return 'Va bene 👍\n\n' + buildStartMessageByIntent(intent, profileName) + '\n\n' + buildQuestions(intent)[0]; }
function buildVehicleChoiceMessage(profileName, requestedVehicle, dateRange, requestedKm, vehicles) {
  const lines = vehicles.slice(0, 3).map((v, i) => {
    let label = v.name || 'Veicolo disponibile';
    if (v.code && !label.toLowerCase().includes(v.code.toLowerCase())) label += ` (${v.code})`;
    return `${i + 1}️⃣ ${label}\n💰 Preventivo gestionale: € ${formatEuroNumber(v.estimatedTotalAmount)}`;
  });
  return `Perfetto ${formatCustomerName(profileName)} 👌\n\nHo trovato queste disponibilità per ${requestedVehicle} dal ${dateRange.startLabel} al ${dateRange.endLabel}:\n🚗 Km richiesti: ${requestedKm} km\n\n${lines.join('\n\n')}\n\nScrivimi 1, 2 oppure 3.\nSe vuoi cambiare, scrivi indietro oppure altra data.`;
}
function buildCustomerConfirmation(intent, profileName, extra = {}) {
  const name = formatCustomerName(profileName);
  if (intent === 'officina') return `Grazie ${name} ✅\n\nHo inoltrato la tua richiesta al reparto Officina.\nTi ricontatteremo presto su questo numero.\n\nSe preferisci, puoi prenotare anche qui:\n${LINK_OFFICINA}`;
  if (intent === 'noleggio') {
    if (extra.afterEveningCutoff) return `Grazie ${name} 🙏\n\nPer il ritiro di oggi il sistema automatico è disponibile solo fino alle 18:30.\n\nScrivimi una data da domani in poi.\nEsempio: 15/04 - 18/04`;
    if (extra.unavailable) return `Grazie ${name} 🙏\n\nAl momento non risultano disponibilità immediate per ${extra.requestedVehicle} dal ${extra.startLabel} al ${extra.endLabel}.\n\nPuoi provare con un’altra data.\nEsempio: 18/04 - 21/04`;
    const contractLine = extra.reservationId ? `\n🧾 Prenotazione gestionale: ${extra.reservationId}` : '';
    const statusLine = extra.reservationStatus ? `\n📌 Stato gestionale: ${extra.reservationStatus}` : '';
    return `Grazie ${name} ✅\n\n🚐 Mezzo scelto: ${extra.vehicleName}\n📅 Periodo: dal ${extra.startLabel} al ${extra.endLabel} (${extra.days} giorni)\n🚗 Km richiesti: ${extra.requestedKm || 0} km\n💰 Preventivo gestionale: € ${formatEuroNumber(extra.estimatedTotalAmount)}${contractLine}${statusLine}\n\n${extra.paymentLink ? `Puoi pagare il solo costo del noleggio qui:\n${extra.paymentLink}\n\n` : `Pagamento online momentaneamente non disponibile. Ti invieremo il link appena pronto.\n\n`}La caparra di € ${eurosFromCents(NOLEGGIO_DEPOSIT_CENTS)} verrà gestita separatamente dal nostro staff.`;
  }
  if (intent === 'vendita') return `Grazie ${name} ✅\n\nHo inoltrato correttamente la tua richiesta al reparto Vendita auto.\nTi ricontatteremo presto su questo numero.`;
  if (intent === 'trasporto') return `Grazie ${name} ✅\n\nHo inoltrato correttamente la tua richiesta al reparto Trasporto veicoli.\nTi ricontatteremo presto su questo numero.`;
  if (intent === 'contatto_diretto') return `Grazie ${name} ✅\n\nHo inoltrato la tua richiesta a un nostro responsabile.\nTi ricontatteremo il prima possibile.`;
  if (intent === 'parcheggio_sosta') {
    const amountLabel = extra.amountCents ? `\n\n💰 Importo calcolato: € ${eurosFromCents(extra.amountCents)}` : '';
    const periodLabel = extra.startLabel && extra.endLabel ? `\n📅 Periodo: dal ${extra.startLabel} al ${extra.endLabel} (${extra.days} giorni)` : '';
    const paymentPart = extra.paymentLink ? `\n\nPer confermare puoi pagare qui:\n${extra.paymentLink}` : '\n\nTi invieremo conferma e modalità di pagamento al più presto.';
    return `Grazie ${name} ✅\n\nLa tua richiesta per Parcheggio / Sosta è stata registrata correttamente.${periodLabel}${amountLabel}${paymentPart}`;
  }
  return `Grazie ${name} ✅\n\nHo ricevuto correttamente la tua richiesta.\nTi ricontatteremo al più presto.`;
}
function buildInternalMessage(session, incomingFrom, profileName, extra = {}) {
  const a = session.answers;
  const customerName = formatCustomerName(profileName);
  const whatsappNumber = formatWhatsappNumber(incomingFrom);
  if (session.intent === 'officina') return `🔔 NUOVA RICHIESTA OFFICINA\n\n👤 Nome WhatsApp: ${customerName}\n📞 Numero cliente: ${whatsappNumber}\n\nVeicolo: ${a[0] || '-'}\nTarga: ${a[1] || '-'}\nProblema / intervento: ${a[2] || '-'}\nGiorno preferito: ${a[3] || '-'}`;
  if (session.intent === 'vendita') return `🔔 NUOVA RICHIESTA VENDITA\n\n👤 Nome WhatsApp: ${customerName}\n📞 Numero cliente: ${whatsappNumber}\n\nAuto cercata: ${a[0] || '-'}\nBudget: ${a[1] || '-'}\nPermuta: ${a[2] || '-'}`;
  if (session.intent === 'trasporto') return `🔔 NUOVA RICHIESTA TRASPORTO\n\n👤 Nome WhatsApp: ${customerName}\n📞 Numero cliente: ${whatsappNumber}\n\nVeicolo: ${a[0] || '-'}\nRitiro: ${a[1] || '-'}\nConsegna: ${a[2] || '-'}\nQuando serve: ${a[3] || '-'}`;
  if (session.intent === 'contatto_diretto') return `🔔 NUOVA RICHIESTA CONTATTO DIRETTO\n\n👤 Nome WhatsApp: ${customerName}\n📞 Numero cliente: ${whatsappNumber}\n\nMotivo: ${a[0] || '-'}`;
  if (session.intent === 'parcheggio_sosta') {
    const dateRange = extractDateRange(a[1]);
    return `🔔 NUOVA RICHIESTA PARCHEGGIO / SOSTA\n\n👤 Nome WhatsApp: ${customerName}\n📞 Numero cliente: ${whatsappNumber}\n\nTipo mezzo: ${a[0] || '-'}\n${dateRange ? `Periodo: dal ${dateRange.startLabel} al ${dateRange.endLabel} (${dateRange.days} giorni)` : `Date richieste: ${a[1] || '-'}`}\nCorrente: ${yesNoLabel(a[2])}\nAcqua: ${yesNoLabel(a[3])}\n${extra.amountCents ? `Importo: € ${eurosFromCents(extra.amountCents)}\n` : ''}${extra.paymentLink ? `Link Nexi: ${extra.paymentLink}\n` : ''}`;
  }
  return `🔔 NUOVA RICHIESTA GENERICA\n\n👤 Nome WhatsApp: ${customerName}\n📞 Numero cliente: ${whatsappNumber}`;
}

// =========================
// NOTIFICHE
// =========================
async function sendInternalNotification(numbers, text) {
  for (const to of numbers) {
    if (to === TWILIO_WHATSAPP_NUMBER) continue;
    try {
      const result = await client.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to, body: text });
      console.log('✅ NOTIFICA INVIATA:', to, result.sid);
    } catch (error) {
      console.error('❌ ERRORE INVIO NOTIFICA', to, error.message, error.code, error.moreInfo);
    }
  }
}
async function notifyPrices(profileName, incomingFrom, data) {
  let text = `🔍 RICHIESTA NOLEGGIO - PREVENTIVO GESTIONALE VISUALIZZATO\n\n👤 ${profileName}\n📞 ${incomingFrom}\n\n🚐 Mezzo richiesto: ${data.requestedVehicle}\n📅 Periodo: ${data.startLabel} - ${data.endLabel}\n🚗 Km richiesti: ${data.requestedKm} km\n\n`;
  data.vehicles.forEach((v, i) => { text += `${i + 1}) ${v.name}${v.code ? ` (${v.code})` : ''} - € ${formatEuroNumber(v.estimatedTotalAmount)}\n`; });
  await sendInternalNotification(GENERAL_NUMBERS, text);
}
async function notifyPaymentSuccess(data) {
  const text = `✅ PAGAMENTO RICEVUTO\n\n👤 ${data.customerName}\n📞 ${data.customerWhatsapp}\n\n🚐 ${data.vehicleName}\n📅 ${data.startLabel} - ${data.endLabel}\n🚗 Km richiesti: ${data.requestedKm || 0} km\n💰 € ${formatEuroNumber(data.amount)}\n🧾 ${data.codiceTransazione}`;
  await sendInternalNotification(GENERAL_NUMBERS, text);
  try {
    await client.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to: data.customerWhatsapp, body: `Ciao ${data.customerName} 👋\n\nAbbiamo ricevuto correttamente il tuo pagamento ✅\n\n🚐 Mezzo: ${data.vehicleName}\n📅 Periodo: ${data.startLabel} - ${data.endLabel}\n🚗 Km richiesti: ${data.requestedKm || 0} km\n💰 Importo: € ${formatEuroNumber(data.amount)}\n\nGrazie da Trasporti DP.` });
  } catch (error) { console.error('Errore invio conferma pagamento al cliente:', error.message); }
}

// =========================
// VALIDAZIONE
// =========================
function validateAnswer(session, answer) {
  const intent = session.intent;
  const idx = session.questionIndex;
  const text = cleanText(answer);
  if (session.state === 'vehicle_choice') {
    if (['1', '2', '3'].includes(normalize(text)) || isBackCommand(text) || isAnotherDateCommand(text) || isMenuCommand(text)) return { valid: true };
    return { valid: false, message: 'Se vuoi scegliere un mezzo scrivimi 1, 2 oppure 3.\nSe vuoi cambiare, scrivi indietro oppure altra data.' };
  }
  if (intent === 'noleggio' && session.state === 'questions') {
    if (idx === 0 && extractDateRange(text)) return { valid: false, message: 'Prima indicami il mezzo richiesto.\n\nEsempio: pulmino, furgone, auto.' };
    if (idx === 1 && !extractDateRange(text)) return { valid: false, message: `Non riesco a leggere bene le date oppure il periodo supera ${MAX_NOLEGGIO_DAYS} giorni.\n\nScrivile così:\n10/05 - 15/05` };
    if (idx === 2 && extractKilometers(text) === null) return { valid: false, message: 'Indicami solo i km previsti in numero.\n\nEsempio: 300' };
  }
  if (intent === 'parcheggio_sosta' && session.state === 'questions') {
    if (idx === 0 && extractDateRange(text)) return { valid: false, message: 'Prima indicami il tipo di mezzo.\n\nEsempio: Auto, Furgone, Camper.' };
    if (idx === 1 && !extractDateRange(text)) return { valid: false, message: 'Non riesco a leggere bene le date.\n\nScrivile così:\n10/05 - 15/05' };
    if ((idx === 2 || idx === 3) && !['SÌ', 'NO'].includes(yesNoLabel(text))) return { valid: false, message: 'Rispondimi solo con sì oppure no.' };
  }
  return { valid: true };
}

// =========================
// ROUTE BASE
// =========================
app.get('/', (req, res) => res.send('Server WhatsApp DP attivo ✅'));
app.get('/nexi/result', async (req, res) => {
  try {
    const codiceTransazione = req.query.codiceTransazione || req.query.codTrans || req.query.orderId || '';
    if (codiceTransazione && transactions[codiceTransazione]) {
      const tx = transactions[codiceTransazione];
      if (!tx.notifiedSuccessPage) { tx.notifiedSuccessPage = true; await notifyPaymentSuccess(tx); }
    }
  } catch (error) { console.error('Errore pagina success Nexi:', error.message); }
  res.send('<html><head><meta charset="utf-8" /><title>Pagamento completato</title></head><body style="font-family:Arial;padding:40px;text-align:center"><h1>Pagamento completato ✅</h1><p>Grazie. Il pagamento risulta concluso.</p><p>Riceverà conferma dal nostro staff nel più breve tempo possibile.</p></body></html>');
});
app.get('/nexi/cancel', (req, res) => res.send('<html><head><meta charset="utf-8" /><title>Pagamento annullato</title></head><body style="font-family:Arial;padding:40px;text-align:center"><h1>Pagamento annullato</h1><p>Il pagamento non è stato completato.</p></body></html>'));
app.post('/nexi/notify', async (req, res) => {
  try {
    const body = req.body || {};
    const codiceTransazione = body.codiceTransazione || body.orderId || body.codTrans || body.codice || body.transactionId || '';
    const esito = body.esito || body.outcome || body.status || body.result || '';
    if (String(esito).toUpperCase() === 'OK' && transactions[codiceTransazione]) {
      const tx = transactions[codiceTransazione];
      if (!tx.notifiedServerCallback) { tx.notifiedServerCallback = true; await notifyPaymentSuccess(tx); }
    }
    res.sendStatus(200);
  } catch (error) { console.error('Errore Nexi notify:', error); res.sendStatus(500); }
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
    console.log('NUMERO:', incomingFrom, 'MESSAGGIO:', incomingText, 'SID:', messageSid);
    if (!incomingFrom) { twiml.message('Si è verificato un errore nella ricezione del messaggio.'); res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString()); }
    if (alreadyProcessedMessage(messageSid) || alreadyProcessedFingerprint(incomingFrom, incomingText)) { res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(new twilio.twiml.MessagingResponse().toString()); }
    rememberProcessedMessage(messageSid);
    rememberProcessedFingerprint(incomingFrom, incomingText);

    let session = sessions[incomingFrom];
    if (session && isExpired(session)) { clearSession(incomingFrom); session = null; }

    if (!session) {
      session = createSession(incomingFrom, profileName);
      const directIntent = intentFromMenuChoice(incomingText) || detectIntent(incomingText);
      if (directIntent && directIntent !== 'generico') {
        setSessionIntent(session, directIntent);
        twiml.message(buildStartMessageByIntent(directIntent, profileName) + '\n\n' + session.questions[0]);
        res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
      }
      session.state = 'menu';
      twiml.message(buildWelcomeMenu(profileName));
      res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
    }

    if (isResetCommand(incomingText) || isMenuCommand(incomingText)) {
      resetSession(incomingFrom, profileName).state = 'menu';
      twiml.message(buildWelcomeMenu(profileName));
      res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
    }

    if (session.state === 'menu') {
      const chosenIntent = intentFromMenuChoice(incomingText) || detectIntent(incomingText);
      if (!chosenIntent || chosenIntent === 'generico') { twiml.message(buildInvalidChoiceMessage()); res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString()); }
      setSessionIntent(session, chosenIntent);
      twiml.message(buildStartMessageByIntent(chosenIntent, profileName) + '\n\n' + session.questions[0]);
      res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
    }

    if (session.state === 'vehicle_choice') {
      if (isBackCommand(incomingText) || isAnotherDateCommand(incomingText)) {
        session.state = 'questions'; session.questionIndex = 1; session.answers = [session.pendingOptions?.requestedVehicle || session.answers[0]]; session.pendingOptions = null; session.createdAt = Date.now();
        twiml.message(`Va bene.\n\nMandami pure le date del noleggio.\n\n${session.questions[1]}`);
        res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
      }
      const validation = validateAnswer(session, incomingText);
      if (!validation.valid) { twiml.message(validation.message); res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString()); }
      const idx = parseInt(normalize(incomingText), 10) - 1;
      const options = session.pendingOptions?.vehicles || [];
      const selected = options[idx];
      if (!selected) { twiml.message('Scelta non valida.\n\nScrivimi 1, 2 oppure 3.\nSe vuoi cambiare, scrivi indietro oppure altra data.'); res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString()); }
      const prezzoFinale = Number(selected.estimatedTotalAmount || 0);
      session.state = 'confirm_noleggio';
      session.pendingOptions.selectedVehicle = selected;
      session.pendingOptions.prezzoFinale = prezzoFinale;
      session.createdAt = Date.now();
      twiml.message(`Perfetto ${profileName} ✅\n\nHai scelto:\n🚐 ${selected.name}${selected.code ? ` (${selected.code})` : ''}\n📅 Dal ${session.pendingOptions.startLabel} al ${session.pendingOptions.endLabel}\n🚗 Km richiesti: ${session.pendingOptions.requestedKm} km\n💰 Preventivo gestionale: € ${formatEuroNumber(prezzoFinale)}\n\nConfermi la prenotazione?\nRispondi *SI* per confermare oppure *NO* per annullare.`);
      res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
    }

    if (session.state === 'contract_data') {
      const answers = session.pendingOptions.contractAnswers || [];
      const idx = session.pendingOptions.contractQuestionIndex || 0;
      const questions = session.pendingOptions.contractQuestions || buildContractQuestions();

      if (idx === 18 && !['SÌ', 'NO'].includes(yesNoLabel(incomingText))) {
        twiml.message('Rispondimi solo con SÌ oppure NO.');
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      answers.push(incomingText);
      session.pendingOptions.contractAnswers = answers;

      if (idx === 18 && yesNoLabel(incomingText) === 'SÌ') {
        session.pendingOptions.contractQuestions.push('Nome e cognome del secondo autista.');
      }

      session.pendingOptions.contractQuestionIndex = idx + 1;
      session.createdAt = Date.now();

      if (session.pendingOptions.contractQuestionIndex < session.pendingOptions.contractQuestions.length) {
        twiml.message(session.pendingOptions.contractQuestions[session.pendingOptions.contractQuestionIndex]);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      const contractData = parseContractAnswers(session.pendingOptions.contractAnswers, profileName, incomingFrom);
      session.pendingOptions.contractData = contractData;
      session.state = 'confirm_noleggio';

      const selected = session.pendingOptions.selectedVehicle;
      const prezzoFinale = session.pendingOptions.prezzoFinale;

      twiml.message(
        `Controlla i dati contratto:\n\n` +
        `${contractSummary(contractData)}\n\n` +
        `🚐 Mezzo: ${selected.name}${selected.code ? ` (${selected.code})` : ''}\n` +
        `📅 ${session.pendingOptions.startLabel} - ${session.pendingOptions.endLabel}\n` +
        `💰 € ${formatEuroNumber(prezzoFinale)}\n\n` +
        `Confermi la prenotazione e creazione contratto?\n` +
        `Rispondi *SI* per confermare oppure *NO* per annullare.`
      );

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'confirm_noleggio') {
      const risposta = normalize(incomingText);
      if (risposta === 'no' || risposta === 'annulla') {
        clearSession(incomingFrom);
        twiml.message('Va bene, prenotazione annullata. Scrivi *menu* per ricominciare.');
        res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
      }
      if (!['si', 'sì', 'ok', 'confermo'].includes(risposta)) {
        twiml.message('Rispondimi solo *SI* per confermare oppure *NO* per annullare.');
        res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
      }
      const selected = session.pendingOptions.selectedVehicle;
      const prezzoFinale = Number(session.pendingOptions.prezzoFinale || selected.estimatedTotalAmount || 0);
      let reservation = null;
      try {
        reservation = await createCarRentalReservation({ customerName: profileName, customerWhatsapp: incomingFrom, selectedVehicle: selected, startDate: session.pendingOptions.startDate, endDate: session.pendingOptions.endDate });
        console.log('✅ PRENOTAZIONE GESTIONALE OK:', reservation.reservationStatus, reservation.confirmationId);
      } catch (e) {
        console.error('❌ ERRORE PRENOTAZIONE GESTIONALE:', e.message);
        await sendInternalNotification(
          GENERAL_NUMBERS,
          `⚠️ ERRORE CREAZIONE PRENOTAZIONE GESTIONALE

` +
          `👤 ${profileName}
` +
          `📞 ${incomingFrom}
` +
          `🚐 ${selected.name}${selected.code ? ` (${selected.code})` : ''}
` +
          `📅 ${session.pendingOptions.startLabel} - ${session.pendingOptions.endLabel}
` +
          `💰 € ${formatEuroNumber(prezzoFinale)}

` +
          `Errore: ${e.message}`
        );

        try {
          const retryMessage = await retryVehicleAvailabilityAfterReservationError({
            session,
            profileName,
            incomingFrom,
            selectedCode: selected.code,
            errorMessage: e.message
          });

          twiml.message(retryMessage);
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end(twiml.toString());
        } catch (retryError) {
          console.error('❌ ERRORE NUOVA RICERCA DOPO FALLIMENTO:', retryError.message);
          session.state = 'questions';
          session.questionIndex = 1;
          session.answers = [session.pendingOptions?.requestedVehicle || session.answers?.[0] || ''];
          session.pendingOptions = null;
          session.createdAt = Date.now();

          twiml.message(
            `⚠️ Il mezzo selezionato non è più disponibile.

` +
            `Mandami un’altra data e rifaccio subito la ricerca.
` +
            `Esempio: 18/05 - 20/05`
          );
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end(twiml.toString());
        }
      }
      const internalExtra = { requestedVehicle: session.pendingOptions.requestedVehicle, vehicleName: selected.code ? `${selected.name} (${selected.code})` : selected.name, vehicleCode: selected.code, startLabel: session.pendingOptions.startLabel, endLabel: session.pendingOptions.endLabel, days: session.pendingOptions.days, requestedKm: session.pendingOptions.requestedKm || 0, estimatedTotalAmount: prezzoFinale, reservationStatus: reservation?.reservationStatus || '', reservationId: reservation?.confirmationId || '' };
      if (canUseNexi() && prezzoFinale > 0) {
        try {
          const payment = await createNexiPayMailLink({ amountCents: euroToCents(prezzoFinale), description: `Pagamento noleggio ${selected.name} - ${session.pendingOptions.days} giorni`, customerWhatsapp: formatWhatsappNumber(incomingFrom) });
          internalExtra.paymentLink = payment.payMailUrl;
          transactions[payment.codiceTransazione] = { codiceTransazione: payment.codiceTransazione, customerName: profileName, customerWhatsapp: incomingFrom, vehicleName: internalExtra.vehicleName, startLabel: internalExtra.startLabel, endLabel: internalExtra.endLabel, requestedKm: internalExtra.requestedKm, amount: prezzoFinale };
        } catch (error) { console.error('Errore Nexi dopo prenotazione:', error.message); }
      }
      await sendInternalNotification(GENERAL_NUMBERS, `✅ PRENOTAZIONE NOLEGGIO CONFERMATA\n\n👤 ${profileName}\n📞 ${incomingFrom}\n🚐 ${internalExtra.vehicleName}\n📅 ${internalExtra.startLabel} - ${internalExtra.endLabel} (${internalExtra.days} giorni)\n🚗 Km: ${internalExtra.requestedKm}\n💰 € ${formatEuroNumber(prezzoFinale)}\n📌 Stato gestionale: ${internalExtra.reservationStatus || '-'}\n🧾 ID gestionale: ${internalExtra.reservationId || '-'}\n${internalExtra.paymentLink ? `\nLink Nexi: ${internalExtra.paymentLink}` : ''}`);
      twiml.message(buildCustomerConfirmation('noleggio', profileName, internalExtra));
      clearSession(incomingFrom);
      res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
    }

    if (session.state === 'questions') {
      if (isBackCommand(incomingText)) {
        if (session.questionIndex > 0) {
          session.questionIndex -= 1;
          session.answers = session.answers.slice(0, session.questionIndex);
          session.createdAt = Date.now();
          twiml.message(`Torniamo alla domanda precedente:\n\n${session.questions[session.questionIndex]}`);
          res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
        }
        session.state = 'menu'; session.intent = null; session.questions = []; session.answers = []; session.questionIndex = 0; session.pendingOptions = null; session.createdAt = Date.now();
        twiml.message(buildWelcomeMenu(profileName));
        res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
      }
      const switchedIntent = detectServiceSwitch(incomingText, session.intent);
      if (switchedIntent === 'menu') { resetSession(incomingFrom, profileName).state = 'menu'; twiml.message(buildWelcomeMenu(profileName)); res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString()); }
      if (switchedIntent && switchedIntent !== session.intent) { setSessionIntent(session, switchedIntent); twiml.message(buildServiceChangedMessage(switchedIntent, profileName)); res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString()); }
      const validation = validateAnswer(session, incomingText);
      if (!validation.valid) { twiml.message(validation.message); res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString()); }
      session.answers.push(incomingText); session.questionIndex += 1; session.createdAt = Date.now();
      if (session.questionIndex < session.questions.length) { twiml.message(session.questions[session.questionIndex]); res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString()); }

      if (['officina', 'vendita', 'trasporto', 'contatto_diretto'].includes(session.intent)) {
        const internalMessage = buildInternalMessage(session, incomingFrom, profileName);
        await sendInternalNotification(getRecipients(session.intent), internalMessage);
        twiml.message(buildCustomerConfirmation(session.intent, profileName));
        clearSession(incomingFrom);
        res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
      }
      if (session.intent === 'parcheggio_sosta') {
        const quote = computeSostaAmountCents(session.answers);
        const internalExtra = { amountCents: quote.totalCents, startLabel: quote.startLabel, endLabel: quote.endLabel, days: quote.giorni };
        if (canUseNexi()) {
          try {
            const payment = await createNexiPayMailLink({ amountCents: quote.totalCents, description: `Parcheggio/Sosta ${session.answers[0] || ''} - ${quote.giorni} giorni`, customerWhatsapp: formatWhatsappNumber(incomingFrom) });
            internalExtra.paymentLink = payment.payMailUrl;
          } catch (error) { console.error('Errore Nexi sosta:', error.message); }
        }
        const internalMessage = buildInternalMessage(session, incomingFrom, profileName, internalExtra);
        await sendInternalNotification(getRecipients(session.intent), internalMessage);
        twiml.message(buildCustomerConfirmation(session.intent, profileName, internalExtra));
        clearSession(incomingFrom);
        res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
      }
      if (session.intent === 'noleggio') {
        const requestedVehicle = session.answers[0];
        const dateRange = extractDateRange(session.answers[1]);
        const requestedKm = extractKilometers(session.answers[2]);
        if (!dateRange || requestedKm === null) {
          session.state = 'questions'; session.questionIndex = 1; session.answers = [requestedVehicle]; session.createdAt = Date.now();
          twiml.message(`Non riesco a leggere bene i dati del noleggio.\n\nRiproviamo dalle date.\n\n${session.questions[1]}`);
          res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
        }
        if (isAfterEveningCutoff(dateRange.startDate)) {
          session.state = 'questions'; session.questionIndex = 1; session.answers = [requestedVehicle]; session.createdAt = Date.now();
          twiml.message(buildCustomerConfirmation('noleggio', profileName, { afterEveningCutoff: true }));
          res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
        }
        try {
          let vehicles = [];
          if (canUseCarRental()) {
            const avail = await getCarRentalAvailability({ vehicleText: requestedVehicle, startDate: dateRange.startDate, endDate: dateRange.endDate });
            vehicles = avail.vehicles || [];
          }
          if (!vehicles.length) {
            session.state = 'questions'; session.questionIndex = 1; session.answers = [requestedVehicle]; session.createdAt = Date.now();
            twiml.message(buildCustomerConfirmation('noleggio', profileName, { unavailable: true, requestedVehicle, startLabel: dateRange.startLabel, endLabel: dateRange.endLabel }));
            res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
          }
          const pricedVehicles = vehicles.slice(0, 3);
          await notifyPrices(profileName, incomingFrom, { requestedVehicle, startLabel: dateRange.startLabel, endLabel: dateRange.endLabel, requestedKm, vehicles: pricedVehicles });
          session.state = 'vehicle_choice';
          session.pendingOptions = { requestedVehicle, startLabel: dateRange.startLabel, endLabel: dateRange.endLabel, startDate: dateRange.startDate, endDate: dateRange.endDate, days: dateRange.days, requestedKm, vehicles: pricedVehicles };
          session.createdAt = Date.now();
          twiml.message(buildVehicleChoiceMessage(profileName, requestedVehicle, dateRange, requestedKm, pricedVehicles));
          res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
        } catch (error) {
          console.error('Errore disponibilità gestionale:', error.message);
          session.state = 'questions'; session.questionIndex = 1; session.answers = [requestedVehicle]; session.createdAt = Date.now();
          twiml.message(buildCustomerConfirmation('noleggio', profileName, { unavailable: true, requestedVehicle, startLabel: dateRange.startLabel, endLabel: dateRange.endLabel }));
          res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
        }
      }
    }

    resetSession(incomingFrom, profileName).state = 'menu';
    twiml.message(buildWelcomeMenu(profileName));
    res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
  } catch (error) {
    console.error('Errore generale:', error);
    twiml.message('Scusaci, al momento si è verificato un problema tecnico. Riprova tra poco oppure scrivici di nuovo.');
    res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server avviato sulla porta ${PORT}`));
