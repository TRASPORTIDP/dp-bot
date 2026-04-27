require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use((req, res, next) => {
  console.log('[REQ]', new Date().toISOString(), req.method, req.originalUrl);
  next();
});

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

const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+390744817108';
const OFFICINA_NUMBERS = parseWhatsappList(process.env.INTERNAL_OFFICINA_NUMBERS || '+393287377675');
const GENERAL_NUMBERS = parseWhatsappList(process.env.INTERNAL_GENERAL_NUMBERS || '+393472733226,+393494040073');
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const LINK_OFFICINA = process.env.LINK_OFFICINA || 'https://calendly.com/contabilita-trasportidp/appuntamenti-officina-dp';

const IVA_RATE = 0.22;
const NOLEGGIO_PRICE_PER_DAY_EUR = Number(process.env.NOLEGGIO_PRICE_PER_DAY_EUR || '70');
const NOLEGGIO_KM_INCLUDED_PER_DAY = Number(process.env.NOLEGGIO_KM_INCLUDED_PER_DAY || '150');
const NOLEGGIO_EXTRA_KM_EUR = Number(process.env.NOLEGGIO_EXTRA_KM_EUR || '0.15');
const NOLEGGIO_DEPOSIT_CENTS = Number(process.env.NOLEGGIO_DEPOSIT_CENTS || '50000');

const NEXI_ENV = (process.env.NEXI_ENV || 'prod').toLowerCase();
const NEXI_ALIAS = process.env.NEXI_ALIAS || process.env.NEXI_API_KEY_ALIAS || '';
const NEXI_MAC_KEY = process.env.NEXI_MAC_KEY || '';
const NEXI_TIMEOUT_HOURS = Number(process.env.NEXI_TIMEOUT_HOURS || '4');
const NEXI_BASE_URL = NEXI_ENV === 'test' ? 'https://int-ecommerce.nexi.it' : 'https://ecommerce.nexi.it';
const NEXI_PAYMAIL_ENDPOINT = `${NEXI_BASE_URL}/ecomm/api/bo/richiestaPayMail`;

const CARRENTAL_UID = process.env.CARRENTAL_UID || '';
const CARRENTAL_API_KEY = process.env.CARRENTAL_API_KEY || '';
const CARRENTAL_AVAIL_URL = process.env.CARRENTAL_AVAIL_URL || 'https://crsbrk00.myappy.it/web/ota/';
const CARRENTAL_LOCATION_CODE = process.env.CARRENTAL_LOCATION_CODE || '57529906';

const sessions = {};
const processedSids = new Map();
const transactions = {};

function parseWhatsappList(value) {
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (x.startsWith('whatsapp:') ? x : `whatsapp:${x}`));
}

function cleanText(value) {
  return String(value || '').trim();
}

function normalize(value) {
  return cleanText(value).toLowerCase();
}

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatCustomerName(name) {
  return cleanText(name) || 'Cliente';
}

function euros(value) {
  return Number(value || 0).toFixed(2).replace('.', ',');
}

function eurosFromCents(cents) {
  return (Number(cents || 0) / 100).toFixed(2).replace('.', ',');
}

function euroToCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function buildCode(prefix = 'DP') {
  return `${prefix}${Date.now().toString().slice(-10)}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`.slice(0, 18);
}

function formatDateIT(date) {
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

function parseItalianDate(dayStr, monthStr, yearStr) {
  const day = Number(dayStr);
  const month = Number(monthStr);
  let year = yearStr ? Number(yearStr) : new Date().getFullYear();
  if (String(year).length === 2) year += 2000;
  const d = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function extractDateRange(text) {
  const raw = normalize(text)
    .replace(/\s+/g, ' ')
    .replace(/\bdal\b/g, '')
    .replace(/\balla\b/g, '')
    .replace(/\bal\b/g, '-')
    .replace(/\ba\b/g, '-')
    .replace(/\s*-\s*/g, '-')
    .trim();

  const m = raw.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\s*-\s*(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
  if (!m) return null;

  const start = parseItalianDate(m[1], m[2], m[3]);
  let end = parseItalianDate(m[4], m[5], m[6]);
  if (!start || !end) return null;
  if (!m[6] && end < start) end = parseItalianDate(m[4], m[5], String(start.getFullYear() + 1));
  if (!end || end < start) return null;

  const days = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
  if (days <= 0) return null;

  return { startDate: start, endDate: end, startLabel: formatDateIT(start), endLabel: formatDateIT(end), days };
}

function extractKm(text) {
  const m = normalize(text).replace(/\./g, '').match(/(\d{1,6})/);
  if (!m) return null;
  return Number(m[1]);
}

function toOtaDateTime(date, hour) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}T${String(hour).padStart(2, '0')}:00:00`;
}

function computeFallbackQuote({ days, requestedKm }) {
  const included = days * NOLEGGIO_KM_INCLUDED_PER_DAY;
  const extraKm = Math.max(0, Number(requestedKm || 0) - included);
  const imponibile = days * NOLEGGIO_PRICE_PER_DAY_EUR + extraKm * NOLEGGIO_EXTRA_KM_EUR;
  return Math.round(imponibile * (1 + IVA_RATE) * 100) / 100;
}

function findFirstByKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of Object.keys(obj)) if (keys.includes(key)) return obj[key];
  for (const key of Object.keys(obj)) {
    const found = findFirstByKeys(obj[key], keys);
    if (found) return found;
  }
  return null;
}

function safeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function findAmount(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = ['@_EstimatedTotalAmount', '@_RateTotalAmount', '@_Amount', 'EstimatedTotalAmount', 'RateTotalAmount', 'Amount'];
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== '') {
      const n = Number(String(obj[k]).replace(',', '.'));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  for (const key of Object.keys(obj)) {
    const found = findAmount(obj[key]);
    if (found) return found;
  }
  return null;
}

function vehicleNameFromCode(code) {
  const c = String(code || '').toUpperCase().trim();
  if (c.includes('F1')) return 'Gruppo F1 - Furgone';
  if (c.includes('F2')) return 'Gruppo F2 - P. Corto';
  if (c.includes('F3')) return 'Gruppo F3 - P. Lungo';
  if (c.includes('P2')) return 'Gruppo P2 - 9 Posti';
  if (c.includes('P1')) return 'Gruppo P1 - 8 Posti';
  if (c.includes('A1')) return 'Gruppo A1 - Compact Eco';
  if (c.includes('A2')) return 'Gruppo A2 - Compact';
  if (c.includes('A3')) return 'Gruppo A3 - Compact Elite';
  return c || 'Mezzo disponibile';
}

function normalizeVehicle(item) {
  const core = item?.VehAvailCore || item?.['ns1:VehAvailCore'] || {};
  const vehicle = item?.Vehicle || item?.['ns1:Vehicle'] || core?.Vehicle || {};
  const makeModel = item?.VehMakeModel || item?.['ns1:VehMakeModel'] || vehicle?.VehMakeModel || {};
  const vehClass = item?.VehClass || item?.['ns1:VehClass'] || vehicle?.VehClass || {};
  const vehType = item?.VehType || item?.['ns1:VehType'] || vehicle?.VehType || {};
  const code = String(vehicle?.['@_Code'] || makeModel?.['@_Code'] || vehClass?.['@_Code'] || vehType?.['@_Code'] || '').trim();
  const name = vehicle?.['@_Description'] || vehicle?.['@_Name'] || makeModel?.['@_Name'] || vehClass?.['@_Name'] || vehicleNameFromCode(code);
  return { code, name: String(name || vehicleNameFromCode(code)).trim(), amount: findAmount(item), raw: item };
}

function vehicleMatches(vehicle, text) {
  const q = normalize(text);
  const c = String(vehicle.code || '').toUpperCase();
  const n = normalize(vehicle.name);
  if (q.includes('furgone') || q.includes('van')) return c.startsWith('F') || n.includes('furgone') || n.includes('van');
  if (q.includes('pulmino') || q.includes('posti')) return c.startsWith('P') || n.includes('posti');
  if (q.includes('auto') || q.includes('macchina') || q.includes('vettura')) return c.startsWith('A') || n.includes('compact') || n.includes('auto');
  return true;
}

function canUseCarRental() {
  return Boolean(CARRENTAL_UID && CARRENTAL_API_KEY && CARRENTAL_AVAIL_URL && CARRENTAL_LOCATION_CODE);
}

function buildSoapAuthBlock() {
  return `
    <POS>
      <Source>
        <RequestorID Type="29" ID="${xmlEscape(CARRENTAL_UID)}" MessagePassword="${xmlEscape(CARRENTAL_API_KEY)}"/>
      </Source>
    </POS>`;
}

async function getAvailability({ vehicleText, startDate, endDate }) {
  if (!canUseCarRental()) throw new Error('Car Rental non configurato');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.opentravel.org/OTA/2003/05">
  <SOAP-ENV:Body>
    <ns1:OTA_VehAvailRateRQ>
      ${buildSoapAuthBlock()}
      <VehAvailRQCore>
        <VehRentalCore PickUpDateTime="${toOtaDateTime(startDate, 9)}" ReturnDateTime="${toOtaDateTime(endDate, 18)}">
          <PickUpLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/>
          <ReturnLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/>
        </VehRentalCore>
      </VehAvailRQCore>
    </ns1:OTA_VehAvailRateRQ>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

  console.log('[CARRENTAL] XML DISPONIBILITA INVIATO');
  console.log(xml);

  const response = await fetch(CARRENTAL_AVAIL_URL, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xml });
  const xmlText = await response.text();

  console.log('[CARRENTAL] RISPOSTA DISPONIBILITA');
  console.log(xmlText);

  if (!response.ok) throw new Error(`HTTP gestionale ${response.status}`);

  const parsed = xmlParser.parse(xmlText);
  const body = parsed?.['SOAP-ENV:Envelope']?.['SOAP-ENV:Body'] || parsed?.Envelope?.Body || parsed?.['soap:Envelope']?.['soap:Body'] || parsed?.['soapenv:Envelope']?.['soapenv:Body'];
  const rs = body?.['ns1:OTA_VehAvailRateRS'] || body?.OTA_VehAvailRateRS || body?.['OTA_VehAvailRateRS'];
  if (!rs) throw new Error('Risposta disponibilità non riconosciuta');
  const error = findFirstByKeys(rs, ['Error', 'ns1:Error']);
  if (error) throw new Error(JSON.stringify(error));
  const rawVehicles = findFirstByKeys(rs, ['VehAvail', 'ns1:VehAvail']) || [];
  const vehicles = safeArray(rawVehicles).map(normalizeVehicle);
  const filtered = vehicles.filter((v) => vehicleMatches(v, vehicleText));
  return filtered.length ? filtered : vehicles;
}

function canUseNexi() {
  return Boolean(NEXI_ALIAS && NEXI_MAC_KEY && APP_BASE_URL);
}

function nexiMac({ apiKey, codiceTransazione, importo, timeStamp }) {
  const source = `apiKey=${apiKey}` + `codiceTransazione=${codiceTransazione}` + `importo=${importo}` + `timeStamp=${timeStamp}` + NEXI_MAC_KEY;
  return crypto.createHash('sha1').update(source).digest('hex');
}

async function createNexiPayMailLink({ amountCents, description, customerWhatsapp }) {
  if (!canUseNexi()) throw new Error('Nexi non configurato');
  const codiceTransazione = buildCode('DP');
  const timeStamp = Date.now().toString();
  const importo = String(amountCents);
  const payload = {
    apiKey: NEXI_ALIAS,
    codiceTransazione,
    importo,
    timeStamp,
    mac: nexiMac({ apiKey: NEXI_ALIAS, codiceTransazione, importo, timeStamp }),
    timeout: String(NEXI_TIMEOUT_HOURS),
    url: `${APP_BASE_URL}/nexi/result`,
    urlBack: `${APP_BASE_URL}/nexi/cancel`,
    urlpost: `${APP_BASE_URL}/nexi/notify`,
    parametriAggiuntivi: { source: 'dp_whatsapp_bot', description: description || '', customer_whatsapp: customerWhatsapp || '' }
  };

  console.log('[NEXI] PAYMAIL REQUEST');
  console.log(JSON.stringify(payload, null, 2));

  const response = await fetch(NEXI_PAYMAIL_ENDPOINT, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));

  console.log('[NEXI] PAYMAIL RESPONSE');
  console.log(JSON.stringify(data, null, 2));

  if (!response.ok) throw new Error(`HTTP Nexi ${response.status}`);
  if (String(data.esito || '').toUpperCase() !== 'OK') throw new Error(data?.errore?.messaggio || data?.errore?.description || data?.messaggio || 'Nexi KO');
  const payMailUrl = data.payMailUrl || data.url || data.paymentUrl || '';
  if (!payMailUrl) throw new Error('Nexi non ha restituito link pagamento');
  return { codiceTransazione, payMailUrl };
}

async function sendInternalNotification(numbers, text) {
  for (const to of numbers) {
    if (!to || to === TWILIO_WHATSAPP_NUMBER) continue;
    try {
      const result = await client.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to, body: text });
      console.log('[TWILIO] Notifica inviata', to, result.sid);
    } catch (error) {
      console.error('[TWILIO] Errore notifica', to, error.message, error.code, error.moreInfo);
    }
  }
}

function twimlReply(res, text) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(text);
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  return res.end(twiml.toString());
}

function menu(profileName) {
  return `Ciao ${formatCustomerName(profileName)} 👋\n\nScegli il servizio:\n\n1️⃣ Officina\n2️⃣ Noleggio\n3️⃣ Vendita auto\n4️⃣ Trasporto veicoli\n5️⃣ Contatto diretto\n\nScrivi solo il numero.`;
}

function createSession(from, profileName) {
  sessions[from] = { state: 'menu', profileName, data: {}, createdAt: Date.now() };
  return sessions[from];
}

function resetSession(from, profileName) {
  delete sessions[from];
  return createSession(from, profileName);
}

async function finalizeContract({ session, from, profileName, res }) {
  const data = session.data;
  const rental = data.rental;
  let paymentLink = '';
  let nexiError = '';

  if (canUseNexi()) {
    try {
      const payment = await createNexiPayMailLink({ amountCents: euroToCents(rental.amount), description: `Noleggio ${rental.vehicleName} ${rental.requestCode}`, customerWhatsapp: from });
      paymentLink = payment.payMailUrl;
      transactions[payment.codiceTransazione] = { customerName: `${data.nome} ${data.cognome}`, customerWhatsapp: from, amount: rental.amount, vehicleName: rental.vehicleName, requestCode: rental.requestCode };
    } catch (error) {
      nexiError = error.message;
      console.error('[NEXI] Errore creazione link', error.message);
    }
  } else {
    nexiError = 'Nexi non configurato';
  }

  const internal =
    `📄 CONTRATTO NOLEGGIO DA COMPLETARE\n\n` +
    `Codice DP: ${rental.requestCode}\n` +
    `Cliente WhatsApp: ${profileName}\n` +
    `Numero: ${from}\n\n` +
    `NOME: ${data.nome}\n` +
    `COGNOME: ${data.cognome}\n` +
    `CF: ${data.cf}\n` +
    `DOCUMENTO: ${data.documento}\n` +
    `SCADENZA DOC: ${data.scadenzaDoc}\n` +
    `RILASCIO DOC: ${data.rilascioDoc}\n` +
    `EMAIL: ${data.email}\n` +
    `INDIRIZZO: ${data.indirizzo}\n\n` +
    `MEZZO: ${rental.vehicleName} (${rental.vehicleCode || '-'})\n` +
    `PERIODO: ${rental.startLabel} - ${rental.endLabel}\n` +
    `KM: ${rental.km}\n` +
    `IMPORTO: € ${euros(rental.amount)}\n` +
    (paymentLink ? `LINK NEXI: ${paymentLink}\n` : `ERRORE NEXI: ${nexiError}\n`);

  await sendInternalNotification(GENERAL_NUMBERS, internal);
  delete sessions[from];

  return twimlReply(
    res,
    `Dati ricevuti correttamente ✅\n\nCodice richiesta: *${rental.requestCode}*\nMezzo: ${rental.vehicleName}\nPeriodo: ${rental.startLabel} - ${rental.endLabel}\nImporto noleggio: € ${euros(rental.amount)}\n\n` +
      (paymentLink ? `Per confermare paga qui:\n${paymentLink}\n\n` : `Il link pagamento non è disponibile ora. Ti contatteremo noi.\n\n`) +
      `Caparra € ${eurosFromCents(NOLEGGIO_DEPOSIT_CENTS)} gestita separatamente.`
  );
}

app.get('/', (req, res) => {
  console.log('[TEST] Homepage aperta');
  res.send('Server WhatsApp DP attivo ✅');
});

app.get('/test', (req, res) => {
  console.log('[TEST] Route /test chiamata correttamente');
  res.send('TEST OK - Render riceve le chiamate ✅');
});

app.get('/whatsapp', (req, res) => {
  res.send('Webhook WhatsApp attivo. Twilio deve chiamare questa route in POST.');
});

app.post('/webhook', (req, res, next) => {
  req.url = '/whatsapp';
  return app.handle(req, res, next);
});

app.post('/whatsapp', async (req, res) => {
  const incomingText = cleanText(req.body.Body);
  const incomingFrom = cleanText(req.body.From).toLowerCase();
  const profileName = req.body.ProfileName || 'Cliente';
  const sid = req.body.MessageSid || '';

  console.log('[WHATSAPP] BODY:', JSON.stringify(req.body, null, 2));

  try {
    if (!incomingFrom) return twimlReply(res, 'Errore ricezione numero WhatsApp.');

    if (sid && processedSids.has(sid)) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end('<Response></Response>');
    }
    if (sid) processedSids.set(sid, Date.now());

    const text = normalize(incomingText);
    let session = sessions[incomingFrom];

    if (['menu', 'reset', 'inizio', 'riavvia'].includes(text)) {
      session = resetSession(incomingFrom, profileName);
      return twimlReply(res, menu(profileName));
    }

    if (!session) {
      session = createSession(incomingFrom, profileName);
      if (!['1', '2', '3', '4', '5'].includes(text)) return twimlReply(res, menu(profileName));
    }

    if (session.state === 'menu') {
      if (text === '1' || text.includes('officina')) { session.state = 'officina_vehicle'; return twimlReply(res, 'Che veicolo hai?'); }
      if (text === '2' || text.includes('noleggio')) { session.state = 'rental_vehicle'; return twimlReply(res, 'Che mezzo ti serve? Esempio: furgone, auto, pulmino.'); }
      if (text === '3' || text.includes('vendita')) { session.state = 'vendita_auto'; return twimlReply(res, 'Che tipo di auto stai cercando?'); }
      if (text === '4' || text.includes('trasporto')) { session.state = 'trasporto_vehicle'; return twimlReply(res, 'Quale veicolo devi trasportare?'); }
      if (text === '5' || text.includes('contatto')) { session.state = 'contatto_reason'; return twimlReply(res, 'Scrivi brevemente il motivo della richiesta.'); }
      return twimlReply(res, menu(profileName));
    }

    if (session.state === 'officina_vehicle') { session.data.vehicle = incomingText; session.state = 'officina_plate'; return twimlReply(res, 'Puoi indicarmi la targa?'); }
    if (session.state === 'officina_plate') { session.data.plate = incomingText; session.state = 'officina_problem'; return twimlReply(res, 'Che problema ha il veicolo o quale intervento vuoi fare?'); }
    if (session.state === 'officina_problem') {
      session.data.problem = incomingText;
      await sendInternalNotification(OFFICINA_NUMBERS, `🔧 RICHIESTA OFFICINA\n\nCliente: ${profileName}\nNumero: ${incomingFrom}\nVeicolo: ${session.data.vehicle}\nTarga: ${session.data.plate}\nProblema: ${session.data.problem}`);
      delete sessions[incomingFrom];
      return twimlReply(res, `Richiesta officina inviata ✅\n\nSe preferisci puoi prenotare qui:\n${LINK_OFFICINA}`);
    }

    if (session.state === 'vendita_auto') { session.data.auto = incomingText; session.state = 'vendita_budget'; return twimlReply(res, 'Budget indicativo?'); }
    if (session.state === 'vendita_budget') {
      session.data.budget = incomingText;
      await sendInternalNotification(GENERAL_NUMBERS, `🚗 RICHIESTA VENDITA\n\nCliente: ${profileName}\nNumero: ${incomingFrom}\nAuto: ${session.data.auto}\nBudget: ${session.data.budget}`);
      delete sessions[incomingFrom];
      return twimlReply(res, 'Richiesta vendita inviata ✅ Ti ricontatteremo presto.');
    }

    if (session.state === 'trasporto_vehicle') { session.data.vehicle = incomingText; session.state = 'trasporto_from'; return twimlReply(res, 'Da dove va ritirato?'); }
    if (session.state === 'trasporto_from') { session.data.from = incomingText; session.state = 'trasporto_to'; return twimlReply(res, 'Dove va consegnato?'); }
    if (session.state === 'trasporto_to') {
      session.data.to = incomingText;
      await sendInternalNotification(GENERAL_NUMBERS, `🚛 RICHIESTA TRASPORTO\n\nCliente: ${profileName}\nNumero: ${incomingFrom}\nVeicolo: ${session.data.vehicle}\nRitiro: ${session.data.from}\nConsegna: ${session.data.to}`);
      delete sessions[incomingFrom];
      return twimlReply(res, 'Richiesta trasporto inviata ✅ Ti ricontatteremo presto.');
    }

    if (session.state === 'contatto_reason') {
      await sendInternalNotification(GENERAL_NUMBERS, `📞 CONTATTO DIRETTO\n\nCliente: ${profileName}\nNumero: ${incomingFrom}\nMotivo: ${incomingText}`);
      delete sessions[incomingFrom];
      return twimlReply(res, 'Richiesta inviata ✅ Ti ricontatteremo presto.');
    }

    if (session.state === 'rental_vehicle') { session.data.vehicleRequest = incomingText; session.state = 'rental_dates'; return twimlReply(res, 'Indica le date del noleggio.\n\nEsempio: 10/05 - 15/05'); }
    if (session.state === 'rental_dates') {
      const range = extractDateRange(incomingText);
      if (!range) return twimlReply(res, 'Non riesco a leggere le date. Scrivile così:\n10/05 - 15/05');
      session.data.range = range;
      session.state = 'rental_km';
      return twimlReply(res, 'Quanti km prevedi di fare in totale?\n\nEsempio: 300');
    }

    if (session.state === 'rental_km') {
      const km = extractKm(incomingText);
      if (km === null) return twimlReply(res, 'Scrivi solo il numero dei km. Esempio: 300');
      session.data.km = km;
      const range = session.data.range;
      let vehicles = [];
      try {
        vehicles = await getAvailability({ vehicleText: session.data.vehicleRequest, startDate: range.startDate, endDate: range.endDate });
      } catch (error) {
        console.error('[CARRENTAL] Errore disponibilità:', error.message);
      }
      if (!vehicles.length) vehicles = [{ code: 'MANUALE', name: `${session.data.vehicleRequest} - verifica manuale`, amount: computeFallbackQuote({ days: range.days, requestedKm: km }) }];
      session.data.options = vehicles.slice(0, 3).map((v) => ({ ...v, amount: Number(v.amount || computeFallbackQuote({ days: range.days, requestedKm: km })) }));
      session.state = 'rental_choice';
      const lines = session.data.options.map((v, i) => `${i + 1}️⃣ ${v.name}${v.code ? ` (${v.code})` : ''}\n💰 € ${euros(v.amount)}`).join('\n\n');
      await sendInternalNotification(GENERAL_NUMBERS, `🔍 PREVENTIVO NOLEGGIO VISUALIZZATO\n\nCliente: ${profileName}\nNumero: ${incomingFrom}\nMezzo: ${session.data.vehicleRequest}\nPeriodo: ${range.startLabel} - ${range.endLabel}\nKm: ${km}\n\n${lines}`);
      return twimlReply(res, `Ho trovato queste opzioni:\n\n${lines}\n\nScrivi 1, 2 oppure 3 per scegliere.`);
    }

    if (session.state === 'rental_choice') {
      const index = Number(text) - 1;
      const selected = session.data.options?.[index];
      if (!selected) return twimlReply(res, 'Scelta non valida. Scrivi 1, 2 oppure 3.');
      const range = session.data.range;
      session.data.rental = { requestCode: buildCode('DP'), vehicleName: selected.name, vehicleCode: selected.code, startLabel: range.startLabel, endLabel: range.endLabel, days: range.days, km: session.data.km, amount: Number(selected.amount || 0) };
      session.state = 'contract_nome';
      return twimlReply(res, `Riepilogo noleggio ✅\n\nCodice: ${session.data.rental.requestCode}\nMezzo: ${session.data.rental.vehicleName}\nPeriodo: ${range.startLabel} - ${range.endLabel}\nKm: ${session.data.km}\nImporto: € ${euros(session.data.rental.amount)}\n\nOra raccolgo i dati per contratto.\n\nScrivi il NOME.`);
    }

    if (session.state === 'contract_nome') { session.data.nome = incomingText; session.state = 'contract_cognome'; return twimlReply(res, 'Scrivi il COGNOME.'); }
    if (session.state === 'contract_cognome') { session.data.cognome = incomingText; session.state = 'contract_cf'; return twimlReply(res, 'Scrivi il CODICE FISCALE.'); }
    if (session.state === 'contract_cf') { session.data.cf = incomingText.toUpperCase(); session.state = 'contract_documento'; return twimlReply(res, 'Scrivi tipo e numero documento.\nEsempio: Carta identità CA12345AB'); }
    if (session.state === 'contract_documento') { session.data.documento = incomingText; session.state = 'contract_scadenza_doc'; return twimlReply(res, 'Scrivi scadenza documento.\nEsempio: 31/12/2030'); }
    if (session.state === 'contract_scadenza_doc') { session.data.scadenzaDoc = incomingText; session.state = 'contract_rilascio_doc'; return twimlReply(res, 'Scrivi ente rilascio documento.\nEsempio: Comune di Narni'); }
    if (session.state === 'contract_rilascio_doc') { session.data.rilascioDoc = incomingText; session.state = 'contract_email'; return twimlReply(res, 'Scrivi la tua email.'); }
    if (session.state === 'contract_email') { session.data.email = incomingText; session.state = 'contract_indirizzo'; return twimlReply(res, 'Scrivi indirizzo completo di residenza.'); }
    if (session.state === 'contract_indirizzo') { session.data.indirizzo = incomingText; return await finalizeContract({ session, from: incomingFrom, profileName, res }); }

    delete sessions[incomingFrom];
    return twimlReply(res, menu(profileName));
  } catch (error) {
    console.error('[ERRORE GENERALE]', error);
    return twimlReply(res, `Errore tecnico: ${error.message}`);
  }
});

app.get('/nexi/result', (req, res) => res.send('Pagamento completato ✅'));
app.get('/nexi/cancel', (req, res) => res.send('Pagamento annullato'));
app.post('/nexi/notify', async (req, res) => {
  console.log('[NEXI NOTIFY]', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
