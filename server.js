require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json({ limit: '25mb' }));

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues: true
});

// =========================
// CONFIG
// =========================
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+390744817108';
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');

const INTERNAL_OFFICINA_NUMBERS = parseNumbers(process.env.INTERNAL_OFFICINA_NUMBERS, ['whatsapp:+393287377675']);
const INTERNAL_GENERAL_NUMBERS = parseNumbers(process.env.INTERNAL_GENERAL_NUMBERS, ['whatsapp:+393472733226', 'whatsapp:+393494040073']);

const LINK_OFFICINA = process.env.LINK_OFFICINA || 'https://calendly.com/contabilita-trasportidp/appuntamenti-officina-dp';

const IVA_RATE = 0.22;
const NOLEGGIO_DEPOSIT_CENTS = Number(process.env.NOLEGGIO_DEPOSIT_CENTS || 50000);
const MAX_NOLEGGIO_DAYS = Number(process.env.MAX_NOLEGGIO_DAYS || 30);

// Gestionale OTA
const CARRENTAL_UID = process.env.CARRENTAL_UID || '';
const CARRENTAL_API_KEY = process.env.CARRENTAL_API_KEY || '';
const CARRENTAL_LOCATION_CODE = process.env.CARRENTAL_LOCATION_CODE || '57529906';
const CARRENTAL_AVAIL_URL = process.env.CARRENTAL_AVAIL_URL || 'https://crsbrk00.myappy.it/web/ota/';
const CARRENTAL_RES_URL = process.env.CARRENTAL_RES_URL || 'https://carrentalsoftware.myappy.it/web/ota/';

// REST MyAppy / CRS Booker API
const CRS_API_BASE_URL = (process.env.CRS_API_BASE_URL || 'https://carrentalsoftware.myappy.it/api/v1').replace(/\/+$/, '');
const CRS_API_KEY = process.env.CRS_API_KEY || process.env.CARRENTAL_API_KEY || '';
const CRS_BROKER_ID = process.env.CRS_BROKER_ID || process.env.CARRENTAL_UID || '';

// Nexi
const NEXI_ENV = (process.env.NEXI_ENV || 'prod').toLowerCase();
const NEXI_ALIAS = process.env.NEXI_ALIAS || process.env.NEXI_API_KEY_ALIAS || '';
const NEXI_MAC_KEY = process.env.NEXI_MAC_KEY || '';
const NEXI_TIMEOUT_HOURS = Number(process.env.NEXI_TIMEOUT_HOURS || 4);
const NEXI_BASE_URL = NEXI_ENV === 'test' ? 'https://int-ecommerce.nexi.it' : 'https://ecommerce.nexi.it';
const NEXI_PAYMAIL_ENDPOINT = `${NEXI_BASE_URL}/ecomm/api/bo/richiestaPayMail`;

// =========================
// MEMORIA
// =========================
const sessions = {};
const processedSids = new Map();
const transactions = {};

// =========================
// UTILITY
// =========================
function parseNumbers(value, fallback) {
  if (!value) return fallback;
  return String(value)
    .split(/[,\n;]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(n => n.startsWith('whatsapp:') ? n : `whatsapp:${n}`);
}

function cleanText(v) { return String(v || '').trim(); }
function normalize(v) {
  return cleanText(v)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}
function xmlEscape(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
function htmlEscape(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
function euro(value) { return Number(value || 0).toFixed(2).replace('.', ','); }
function centsToEuro(cents) { return (Number(cents || 0) / 100).toFixed(2).replace('.', ','); }
function euroToCents(value) { return Math.round(Number(value || 0) * 100); }

function splitName(fullName) {
  const parts = cleanText(fullName || 'Cliente WhatsApp').split(/\s+/).filter(Boolean);
  return {
    first: parts[0] || 'Cliente',
    last: parts.slice(1).join(' ') || 'WhatsApp'
  };
}

function yesNo(value) {
  const v = normalize(value);
  if (['si', 's', 'ok', 'yes', 'confermo', 'certo'].includes(v)) return 'SI';
  if (['no', 'n', 'annulla'].includes(v)) return 'NO';
  return '';
}

function parseItalianDate(d, m, y) {
  let year = y ? Number(y) : new Date().getFullYear();
  if (String(year).length === 2) year += 2000;
  const date = new Date(year, Number(m) - 1, Number(d), 12, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return null;
  return date;
}

function formatDateIT(date) {
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

function isoDate(value) {
  const txt = cleanText(value);
  if (!txt) return '';
  const iso = txt.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const it = txt.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (it) {
    let year = it[3];
    if (year.length === 2) year = '20' + year;
    return `${year}-${String(it[2]).padStart(2, '0')}-${String(it[1]).padStart(2, '0')}`;
  }
  return txt;
}

function extractDateRange(text) {
  const raw = normalize(text)
    .replace(/\bdal\b/g, '')
    .replace(/\balla\b/g, '')
    .replace(/\bal\b/g, '-')
    .replace(/\ba\b/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .trim();

  const m = raw.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\s*-\s*(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
  if (!m) return null;

  const start = parseItalianDate(m[1], m[2], m[3]);
  let end = parseItalianDate(m[4], m[5], m[6] || m[3]);

  if (start && end && !m[3] && !m[6] && end < start) {
    end = parseItalianDate(m[4], m[5], String(start.getFullYear() + 1));
  }

  if (!start || !end || end < start) return null;

  const days = Math.round((new Date(end.getFullYear(), end.getMonth(), end.getDate(), 12) - new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12)) / 86400000) + 1;
  if (!days || days > MAX_NOLEGGIO_DAYS) return null;

  return { startDate: start, endDate: end, days, startLabel: formatDateIT(start), endLabel: formatDateIT(end) };
}

function extractKm(text) {
  const m = normalize(text).replace(/\./g, '').match(/(\d{1,6})/);
  if (!m) return null;
  return Number(m[1]);
}

function toOtaStart(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T09:00:00Z`;
}
function toOtaEnd(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T18:00:00Z`;
}

function arrayify(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function findFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) if (keys.includes(k)) return obj[k];
  for (const k of Object.keys(obj)) {
    const f = findFirst(obj[k], keys);
    if (f) return f;
  }
  return null;
}

function buildOrderId(prefix = 'DP') {
  return `${prefix}${Date.now().toString().slice(-10)}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`.slice(0, 18);
}

function isDuplicateSid(sid) {
  if (!sid) return false;
  if (processedSids.has(sid)) return true;
  processedSids.set(sid, Date.now());
  const now = Date.now();
  for (const [k, ts] of processedSids.entries()) if (now - ts > 15 * 60 * 1000) processedSids.delete(k);
  return false;
}

// =========================
// SESSIONI STABILI
// =========================
function createSession(profileName) {
  return {
    profileName: profileName || 'Cliente',
    state: 'menu',
    intent: null,
    answers: [],
    questionIndex: 0,
    pending: {},
    createdAt: Date.now()
  };
}
function getSession(from, profileName) {
  if (!sessions[from] || Date.now() - sessions[from].createdAt > 60 * 60 * 1000) {
    sessions[from] = createSession(profileName);
  }
  return sessions[from];
}
function resetSession(from, profileName) {
  sessions[from] = createSession(profileName);
  return sessions[from];
}
function clearSession(from) { delete sessions[from]; }
function touch(session) { session.createdAt = Date.now(); }

// =========================
// MENU
// =========================
function menuText(name) {
  return `Ciao ${name || 'Cliente'} ðŸ‘‹\n\nScegli il servizio:\n\n1ï¸âƒ£ Officina\n2ï¸âƒ£ Noleggio\n3ï¸âƒ£ Vendita auto\n4ï¸âƒ£ Trasporto veicoli\n5ï¸âƒ£ Contatto diretto\n6ï¸âƒ£ Parcheggio / Sosta\n\nScrivi solo il numero.\nEsempio: 2`;
}

function detectIntent(text) {
  const t = normalize(text);
  if (t === '1' || t.includes('officina')) return 'officina';
  if (t === '2' || t.includes('noleggio')) return 'noleggio';
  if (t === '3' || t.includes('vendita')) return 'vendita';
  if (t === '4' || t.includes('trasporto') || t.includes('bisarca')) return 'trasporto';
  if (t === '5' || t.includes('contatto')) return 'contatto';
  if (t === '6' || t.includes('sosta') || t.includes('parcheggio')) return 'sosta';
  return null;
}

function questionsFor(intent) {
  if (intent === 'officina') return ['Che veicolo hai?', 'Targa?', 'Che problema/intervento serve?', 'Giorno preferito?'];
  if (intent === 'noleggio') return ['Che mezzo ti serve? (es. pulmino, furgone, auto)', 'Date noleggio? Esempio: 10/05 - 15/05', 'Quanti km prevedi di fare? Esempio: 400'];
  if (intent === 'vendita') return ['Che tipo di auto cerchi?', 'Budget indicativo?', 'Hai permuta?'];
  if (intent === 'trasporto') return ['Che veicolo devi trasportare?', 'Da dove ritirare?', 'Dove consegnare?', 'Quando ti serve?'];
  if (intent === 'contatto') return ['Scrivimi brevemente il motivo della richiesta.'];
  if (intent === 'sosta') return ['Che mezzo devi lasciare?', 'Date sosta? Esempio: 10/05 - 15/05', 'Hai bisogno di corrente? sÃ¬/no', 'Hai bisogno di acqua? sÃ¬/no'];
  return [];
}

function startIntent(session, intent) {
  session.intent = intent;
  session.state = 'questions';
  session.answers = [];
  session.questionIndex = 0;
  session.pending = {};
  touch(session);

  const intro = {
    officina: 'Perfetto ðŸ‘Œ Ti aiuto con lâ€™Officina.',
    noleggio: 'Perfetto ðŸ‘Œ Ti aiuto con il Noleggio.',
    vendita: 'Perfetto ðŸ‘Œ Ti aiuto con la Vendita auto.',
    trasporto: 'Perfetto ðŸ‘Œ Ti aiuto con il Trasporto veicoli.',
    contatto: 'Perfetto ðŸ‘Œ Ti metto in contatto con un responsabile.',
    sosta: 'Perfetto ðŸ‘Œ Ti aiuto con Parcheggio / Sosta.'
  }[intent] || 'Perfetto ðŸ‘Œ';

  return `${intro}\n\n${questionsFor(intent)[0]}`;
}

// =========================
// CONTRATTO / ANAGRAFICA
// =========================
function contractQuestions() {
  return [
    'Nome e cognome conducente principale?',
    'Data di nascita? Esempio: 22/04/1982',
    'Luogo di nascita?',
    'Codice fiscale?',
    'Email?',
    'Telefono?',
    'Indirizzo completo?',
    'CittÃ ?',
    'Provincia? Esempio: TR',
    'CAP?',
    'Numero documento / carta identitÃ ?',
    'Ente rilascio documento? Esempio: Comune di Terni',
    'Data rilascio documento? Esempio: 16/01/2020',
    'Scadenza documento? Esempio: 15/01/2028',
    'Numero patente?',
    'Ente rilascio patente? Esempio: Motorizzazione',
    'Data rilascio patente? Esempio: 22/01/2015',
    'Scadenza patente? Esempio: 01/01/2028',
    'Câ€™Ã¨ un secondo autista? Rispondi SÃŒ oppure NO.'
  ];
}

function parseContractAnswers(a, profileName, from) {
  const n = splitName(a[0] || profileName);
  return {
    first_name: n.first,
    name: n.last,
    date_of_birth: isoDate(a[1]),
    place_of_birth: a[2] || '',
    tax_number: a[3] || '',
    email: a[4] || '',
    phone: a[5] || String(from || '').replace('whatsapp:', ''),
    address: a[6] || '',
    city: a[7] || '',
    province: a[8] || '',
    zip_code: a[9] || '',
    country_id: '111',
    nationality: 'IT',
    id_type: 'id',
    id_number: a[10] || '',
    id_issuer: a[11] || '',
    id_issuer_locality: a[7] || '',
    id_issue_date: isoDate(a[12]),
    id_expiry_date: isoDate(a[13]),
    license_number: a[14] || '',
    license_issuer: a[15] || '',
    license_issuer_locality: a[7] || '',
    license_issue_date: isoDate(a[16]),
    license_expiry_date: isoDate(a[17]),
    hasSecondDriver: yesNo(a[18]) === 'SI',
    secondDriverName: a[19] || ''
  };
}

function contractSummary(c) {
  return `ðŸ‘¤ ${c.first_name} ${c.name}\nðŸŽ‚ ${c.date_of_birth} - ${c.place_of_birth}\nðŸ§¾ CF: ${c.tax_number}\nðŸ“§ ${c.email}\nðŸ“ž ${c.phone}\nðŸ  ${c.address}, ${c.city} (${c.province}) ${c.zip_code}\nðŸªª Documento: ${c.id_number} - scad. ${c.id_expiry_date}\nðŸš— Patente: ${c.license_number} - scad. ${c.license_expiry_date}${c.hasSecondDriver ? `\nðŸ‘¥ Secondo autista: ${c.secondDriverName}` : ''}`;
}

function buildContractHtml(tx) {
  const c = tx.contractData || {};
  return `<!doctype html><html><head><meta charset="utf-8"><title>Contratto ${htmlEscape(tx.reservationId || tx.codiceTransazione)}</title>
<style>body{font-family:Arial;margin:35px;color:#111}h1{border-bottom:3px solid #111;padding-bottom:12px}h2{border-bottom:1px solid #ddd;padding-bottom:6px;margin-top:28px}table{width:100%;border-collapse:collapse}td{border:1px solid #ddd;padding:9px}.sign{display:flex;gap:60px;margin-top:60px}.box{flex:1;border-top:1px solid #111;text-align:center;padding-top:8px}@media print{button{display:none}}</style></head>
<body><button onclick="window.print()" style="padding:12px 20px">Stampa / Salva PDF</button>
<h1>Contratto di noleggio - Trasporti DP S.r.l.</h1>
<p><strong>Prenotazione gestionale:</strong> ${htmlEscape(tx.reservationId || '')}<br><strong>Transazione:</strong> ${htmlEscape(tx.codiceTransazione || '')}</p>
<h2>Cliente / conducente</h2>
<table>
<tr><td>Nome</td><td>${htmlEscape(c.first_name)} ${htmlEscape(c.name)}</td></tr>
<tr><td>Nascita</td><td>${htmlEscape(c.date_of_birth)} - ${htmlEscape(c.place_of_birth)}</td></tr>
<tr><td>Codice fiscale</td><td>${htmlEscape(c.tax_number)}</td></tr>
<tr><td>Email / telefono</td><td>${htmlEscape(c.email)} - ${htmlEscape(c.phone)}</td></tr>
<tr><td>Indirizzo</td><td>${htmlEscape(c.address)}, ${htmlEscape(c.city)} (${htmlEscape(c.province)}) ${htmlEscape(c.zip_code)}</td></tr>
<tr><td>Documento</td><td>${htmlEscape(c.id_number)} - ${htmlEscape(c.id_issuer)} - scad. ${htmlEscape(c.id_expiry_date)}</td></tr>
<tr><td>Patente</td><td>${htmlEscape(c.license_number)} - ${htmlEscape(c.license_issuer)} - scad. ${htmlEscape(c.license_expiry_date)}</td></tr>
<tr><td>Secondo autista</td><td>${c.hasSecondDriver ? htmlEscape(c.secondDriverName) : 'NO'}</td></tr>
</table>
<h2>Noleggio</h2>
<table>
<tr><td>Mezzo</td><td>${htmlEscape(tx.vehicleName)}</td></tr>
<tr><td>Periodo</td><td>${htmlEscape(tx.startLabel)} - ${htmlEscape(tx.endLabel)}</td></tr>
<tr><td>Km richiesti</td><td>${htmlEscape(tx.requestedKm)} km</td></tr>
<tr><td>Importo pagato</td><td>â‚¬ ${htmlEscape(euro(tx.amount))}</td></tr>
<tr><td>Caparra</td><td>â‚¬ ${htmlEscape(centsToEuro(NOLEGGIO_DEPOSIT_CENTS))} gestita separatamente</td></tr>
</table>
<h2>Condizioni</h2><p>Il cliente dichiara di aver fornito dati corretti e di accettare condizioni di noleggio, franchigie, danni, multe, pedaggi e costi extra non inclusi.</p>
<div class="sign"><div class="box">Firma cliente</div><div class="box">Trasporti DP S.r.l.</div></div>
</body></html>`;
}

// =========================
// OTA / MYAPPY
// =========================
function canUseCarRental() {
  return Boolean(CARRENTAL_UID && CARRENTAL_API_KEY && CARRENTAL_LOCATION_CODE);
}
function soapAuth() {
  return `<POS><Source><RequestorID Type="29" ID="${xmlEscape(CARRENTAL_UID)}" MessagePassword="${xmlEscape(CARRENTAL_API_KEY)}"/></Source></POS>`;
}

function vehicleFromAvail(item) {
  const core = item?.VehAvailCore || item?.['ns1:VehAvailCore'] || item || {};
  const vehicle = core?.Vehicle || item?.Vehicle || {};
  const mm = vehicle?.VehMakeModel || core?.VehMakeModel || {};
  const code = cleanText(vehicle?.['@_Code'] || mm?.['@_Code'] || '');
  let name = cleanText(vehicle?.['@_Description'] || vehicle?.['@_Name'] || mm?.['@_Name'] || code || 'Veicolo disponibile');
  if (code && !name.toLowerCase().includes(code.toLowerCase())) name = `${name} (${code})`;
  const total = core?.TotalCharge || item?.TotalCharge || {};
  const amount = Number(total?.['@_EstimatedTotalAmount'] || total?.['@_RateTotalAmount'] || 0);
  return { code, name, estimatedTotalAmount: amount, raw: item };
}

async function getAvailability(startDate, endDate) {
  if (!canUseCarRental()) throw new Error('Gestionale non configurato');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.opentravel.org/OTA/2003/05">
<SOAP-ENV:Body><ns1:OTA_VehAvailRateRQ>${soapAuth()}
<VehAvailRQCore><VehRentalCore PickUpDateTime="${toOtaStart(startDate)}" ReturnDateTime="${toOtaEnd(endDate)}">
<PickUpLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/><ReturnLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/>
</VehRentalCore></VehAvailRQCore></ns1:OTA_VehAvailRateRQ></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

  console.log('ðŸ“¤ OTA_VehAvailRateRQ:', xml);
  const r = await fetch(CARRENTAL_AVAIL_URL, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xml });
  const text = await r.text();
  console.log('ðŸ“¥ OTA_VehAvailRateRS:', text);

  if (!r.ok) throw new Error(`HTTP disponibilitÃ  ${r.status}`);
  const parsed = xmlParser.parse(text);
  const err = findFirst(parsed, ['Errors', 'Error', 'ns1:Errors', 'ns1:Error']);
  if (err) throw new Error(JSON.stringify(err));
  return arrayify(findFirst(parsed, ['VehAvail', 'ns1:VehAvail'])).map(vehicleFromAvail).filter(v => v.code || v.name);
}

async function createReservation(session, from) {
  const p = session.pending;
  const c = p.contractData || {};
  const selected = p.selectedVehicle;
  const amount = Number(p.prezzoFinale || selected.estimatedTotalAmount || 0);
  const net = amount / (1 + IVA_RATE);
  const tax = amount - net;
  const phone = c.phone || String(from).replace('whatsapp:', '');
  const email = c.email || 'cliente@trasportidp.com';

  const secondXml = c.hasSecondDriver && c.secondDriverName
    ? `<Additional><PersonName><GivenName>${xmlEscape(splitName(c.secondDriverName).first)}</GivenName><Surname>${xmlEscape(splitName(c.secondDriverName).last)}</Surname></PersonName><Telephone PhoneNumber="${xmlEscape(phone)}"/></Additional>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.opentravel.org/OTA/2003/05">
<SOAP-ENV:Body><ns1:OTA_VehResRQ>${soapAuth()}
<VehResRQCore>
<VehRentalCore PickUpDateTime="${toOtaStart(p.startDate)}" ReturnDateTime="${toOtaEnd(p.endDate)}">
<PickUpLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/><ReturnLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/>
</VehRentalCore>
<VehPref><VehMakeModel Code="${xmlEscape(selected.code)}" Name=""/></VehPref>
<Customer>
<Primary BirthDate="${xmlEscape(c.date_of_birth || '')}">
<PersonName><GivenName>${xmlEscape(c.first_name || '')}</GivenName><Surname>${xmlEscape(c.name || '')}</Surname></PersonName>
<Document DocType="5" DocID="${xmlEscape(c.id_number || '')}" DocIssueAuthority="${xmlEscape(c.id_issuer || '')}" EffectiveDate="${xmlEscape(c.id_issue_date || '')}" ExpireDate="${xmlEscape(c.id_expiry_date || '')}"/>
<Telephone PhoneNumber="${xmlEscape(phone)}"/>
<Email>${xmlEscape(email)}</Email>
<Address><AddressLine>${xmlEscape(c.address || '')}</AddressLine><CityName>${xmlEscape(c.city || '')}</CityName><CountryName>IT</CountryName><PostalCode>${xmlEscape(c.zip_code || '')}</PostalCode><StateProv>${xmlEscape(c.province || '')}</StateProv></Address>
</Primary>
${secondXml}
</Customer>
<VehicleCharges><VehicleCharge Purpose="1" TaxInclusive="false" IncludedInEstTotalInd="true" IncludedInRate="true" Description="Tariffa Indie Rent" Amount="${net.toFixed(2)}" CurrencyCode="EUR"><TaxAmounts><TaxAmount CurrencyCode="EUR" Percentage="22" Total="${tax.toFixed(2)}"/></TaxAmounts></VehicleCharge></VehicleCharges>
<TotalCharge CurrencyCode="EUR" RateTotalAmount="${net.toFixed(2)}" EstimatedTotalAmount="${amount.toFixed(2)}"/>
</VehResRQCore><VehResRQInfo ResStatus="Book"/></ns1:OTA_VehResRQ></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

  console.log('ðŸ“¤ OTA_VehResRQ:', xml);
  const r = await fetch(CARRENTAL_RES_URL, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xml });
  const text = await r.text();
  console.log('ðŸ“¥ OTA_VehResRS:', text);

  if (!r.ok) throw new Error(`HTTP prenotazione ${r.status}`);
  const parsed = xmlParser.parse(text);
  const err = findFirst(parsed, ['Errors', 'Error', 'ns1:Errors', 'ns1:Error']);
  if (err) throw new Error(JSON.stringify(err));

  const reservation = findFirst(parsed, ['VehReservation', 'ns1:VehReservation']) || {};
  const confs = arrayify(findFirst(parsed, ['ConfID', 'ns1:ConfID']));
  const reservationId = (confs.find(x => x?.['@_Type'] === '16') || confs[0] || {})?.['@_ID'] || '';
  return { status: reservation?.['@_ReservationStatus'] || 'Reserved', id: reservationId };
}

function buildCrsUpdatePayload(c) {
  const driver0 = {
    first_name: c.first_name || '',
    name: c.name || '',
    address: c.address || '',
    city: c.city || '',
    province: c.province || '',
    zip_code: c.zip_code || '',
    country_id: c.country_id || '111',
    nationality: c.nationality || 'IT',
    phone: c.phone || '',
    email: c.email || '',
    place_of_birth: c.place_of_birth || '',
    date_of_birth: c.date_of_birth || '',
    tax_number: c.tax_number || '',
    id_type: c.id_type || 'id',
    id_number: c.id_number || '',
    id_issuer: c.id_issuer || '',
    id_issuer_locality: c.id_issuer_locality || c.city || '',
    id_issue_date: c.id_issue_date || '',
    id_expiry_date: c.id_expiry_date || '',
    license_number: c.license_number || '',
    license_issuer: c.license_issuer || '',
    license_issuer_locality: c.license_issuer_locality || c.city || '',
    license_issue_date: c.license_issue_date || '',
    license_expiry_date: c.license_expiry_date || ''
  };

  const payload = { client_driver: { "0": driver0 } };

  if (c.hasSecondDriver && c.secondDriverName) {
    const s = splitName(c.secondDriverName);
    payload.client_driver["1"] = {
      first_name: s.first,
      name: s.last,
      address: c.address || '',
      city: c.city || '',
      province: c.province || '',
      zip_code: c.zip_code || '',
      country_id: c.country_id || '111',
      nationality: c.nationality || 'IT',
      phone: c.phone || ''
    };
  }

  return payload;
}

async function updateReservationData(reservationId, contractData) {
  if (!reservationId) throw new Error('ID prenotazione mancante per update');
  const url = `${CRS_API_BASE_URL}/client_reservation/${encodeURIComponent(reservationId)}/client_reservation_update`;
  const payload = buildCrsUpdatePayload(contractData);

  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (CRS_API_KEY) {
    headers.Authorization = `Bearer ${CRS_API_KEY}`;
    headers['X-API-Key'] = CRS_API_KEY;
    headers.apiKey = CRS_API_KEY;
  }
  if (CRS_BROKER_ID) {
    headers['X-Broker-ID'] = CRS_BROKER_ID;
    headers.broker_id = CRS_BROKER_ID;
  }

  console.log('ðŸ“¤ CRS UPDATE URL:', url);
  console.log('ðŸ“¤ CRS UPDATE BODY:', JSON.stringify(payload, null, 2));

  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  console.log('ðŸ“¥ CRS UPDATE RISPOSTA:', JSON.stringify(data, null, 2));

  if (!r.ok) throw new Error(`HTTP CRS ${r.status}: ${text}`);
  if (data.success === false) throw new Error(data.error || data.message || 'Update anagrafica fallito');
  return data;
}

// =========================
// NEXI
// =========================
function canUseNexi() {
  return Boolean(NEXI_ALIAS && NEXI_MAC_KEY && APP_BASE_URL);
}
function nexiMac({ apiKey, codiceTransazione, importo, timeStamp }) {
  const source = `apiKey=${apiKey}` + `codiceTransazione=${codiceTransazione}` + `importo=${importo}` + `timeStamp=${timeStamp}` + NEXI_MAC_KEY;
  return crypto.createHash('sha1').update(source).digest('hex');
}
async function createNexiLink(amount, description, from) {
  const codiceTransazione = buildOrderId('DP');
  const timeStamp = Date.now().toString();
  const importo = String(euroToCents(amount));
  const payload = {
    apiKey: NEXI_ALIAS,
    codiceTransazione,
    importo,
    timeStamp,
    mac: nexiMac({ apiKey: NEXI_ALIAS, codiceTransazione, importo, timeStamp }),
    timeout: String(NEXI_TIMEOUT_HOURS),
    url: `${APP_BASE_URL}/nexi/result`,
    url_back: `${APP_BASE_URL}/nexi/cancel`,
    urlpost: `${APP_BASE_URL}/nexi/notify`,
    parametriAggiuntivi: { source: 'dp_whatsapp', description, from }
  };

  console.log('ðŸ“¤ NEXI:', { endpoint: NEXI_PAYMAIL_ENDPOINT, codiceTransazione, importo, env: NEXI_ENV });
  const r = await fetch(NEXI_PAYMAIL_ENDPOINT, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await r.json().catch(() => ({}));
  console.log('ðŸ“¥ NEXI:', data);

  if (!r.ok) throw new Error(`HTTP Nexi ${r.status}`);
  if (data.esito !== 'OK') throw new Error(data?.errore?.messaggio || data?.errore?.description || data?.errore?.codice || 'Errore Nexi');
  if (!data.payMailUrl) throw new Error('Nexi non ha restituito payMailUrl');
  return { codiceTransazione, payMailUrl: data.payMailUrl };
}

// =========================
// NOTIFICHE
// =========================
async function sendInternal(numbers, body) {
  for (const to of numbers) {
    try {
      const msg = await client.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to, body });
      console.log('âœ… NOTIFICA INVIATA:', to, msg.sid);
    } catch (e) {
      console.error('âŒ ERRORE NOTIFICA:', to, e.message, e.code || '');
    }
  }
}

async function notifyPayment(tx) {
  const contractUrl = APP_BASE_URL ? `${APP_BASE_URL}/contratto/${encodeURIComponent(tx.codiceTransazione)}` : '';
  await sendInternal(INTERNAL_GENERAL_NUMBERS, `âœ… PAGAMENTO RICEVUTO\n\nðŸ‘¤ ${tx.customerName}\nðŸ“ž ${tx.customerWhatsapp}\nðŸš ${tx.vehicleName}\nðŸ“… ${tx.startLabel} - ${tx.endLabel}\nðŸ’° â‚¬ ${euro(tx.amount)}\nðŸ§¾ ${tx.codiceTransazione}${contractUrl ? `\nðŸ“„ Contratto: ${contractUrl}` : ''}`);

  try {
    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: tx.customerWhatsapp,
      body: `âœ… Pagamento ricevuto!\n\nðŸš ${tx.vehicleName}\nðŸ“… ${tx.startLabel} - ${tx.endLabel}\nðŸ’° â‚¬ ${euro(tx.amount)}\n\n${contractUrl ? `ðŸ“„ Contratto:\n${contractUrl}\n\n` : ''}Grazie da Trasporti DP.`
    });
  } catch (e) {
    console.error('Errore invio pagamento cliente:', e.message);
  }
}

// =========================
// ROUTES
// =========================
app.get('/', (req, res) => res.send('Server DP Rent attivo âœ…'));
app.get('/health', (req, res) => res.json({ ok: true, service: 'dp-rent', time: new Date().toISOString() }));

app.get('/contratto/:codice', (req, res) => {
  const tx = transactions[req.params.codice];
  if (!tx) return res.status(404).send('<h1>Contratto non trovato</h1><p>Il server potrebbe essersi riavviato. Contatta Trasporti DP.</p>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildContractHtml(tx));
});

app.get('/nexi/result', async (req, res) => {
  const codice = req.query.codiceTransazione || req.query.codTrans || req.query.orderId || '';
  try {
    if (codice && transactions[codice] && !transactions[codice].notifiedResult) {
      transactions[codice].notifiedResult = true;
      await notifyPayment(transactions[codice]);
    }
  } catch (e) {
    console.error('Errore Nexi result:', e.message);
  }
  const contractUrl = codice && APP_BASE_URL ? `${APP_BASE_URL}/contratto/${encodeURIComponent(codice)}` : '';
  res.send(`<html><head><meta charset="utf-8"></head><body style="font-family:Arial;text-align:center;padding:40px"><h1>Pagamento completato âœ…</h1>${contractUrl ? `<p><a href="${contractUrl}" style="font-size:22px">Apri contratto</a></p>` : ''}<p>Grazie da Trasporti DP.</p></body></html>`);
});


app.get('/debug/availability', async (req, res) => {
  try {
    const range = extractDateRange(`${req.query.start || ''}-${req.query.end || ''}`);
    if (!range) return res.status(400).json({ ok: false, error: 'Usa ?start=22/05&end=22/05' });
    const vehicles = await getAvailability(range.startDate, range.endDate);
    res.json({ ok: true, start: range.startLabel, end: range.endLabel, vehicles });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/nexi/notify', async (req, res) => {
  try {
    const codice = req.body.codiceTransazione || req.body.codTrans || req.body.orderId || '';
    const esito = String(req.body.esito || 'OK').toUpperCase();
    if (codice && transactions[codice] && (esito === 'OK' || esito === 'SUCCESS')) {
      if (!transactions[codice].notifiedPost) {
        transactions[codice].notifiedPost = true;
        await notifyPayment(transactions[codice]);
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Errore Nexi notify:', e.message);
    res.sendStatus(500);
  }
});

app.get('/nexi/cancel', (req, res) => res.send('<h1>Pagamento annullato</h1>'));

// =========================
// WEBHOOK WHATSAPP
// =========================
async function handleWhatsApp(req, res) {
  const twiml = new twilio.twiml.MessagingResponse();
  const from = cleanText(req.body.From).toLowerCase();
  const body = cleanText(req.body.Body);
  const profileName = req.body.ProfileName || 'Cliente';
  const sid = cleanText(req.body.MessageSid);

  try {
    console.log('NUMERO:', from, 'STATO:', sessions[from]?.state || '-', 'INTENT:', sessions[from]?.intent || '-', 'MSG:', body, 'SID:', sid);

    if (!from) {
      twiml.message('Errore ricezione messaggio.');
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (isDuplicateSid(sid)) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(new twilio.twiml.MessagingResponse().toString());
    }

    let session = getSession(from, profileName);

    if (['menu', 'inizio', 'reset', 'ricomincia'].includes(normalize(body))) {
      session = resetSession(from, profileName);
      twiml.message(menuText(profileName));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    // MENU SOLO quando stato Ã¨ menu. NON intercetta "Auto/Furgone" durante domande.
    if (session.state === 'menu') {
      const intent = detectIntent(body);
      if (!intent) {
        twiml.message(menuText(profileName));
      } else {
        twiml.message(startIntent(session, intent));
      }
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'questions') {
      const qs = questionsFor(session.intent);

      if (session.intent === 'noleggio') {
        if (session.questionIndex === 1 && !extractDateRange(body)) {
          twiml.message('Non riesco a leggere le date. Scrivile cosÃ¬: 10/05 - 15/05');
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end(twiml.toString());
        }
        if (session.questionIndex === 2 && extractKm(body) === null) {
          twiml.message('Indicami solo i km previsti. Esempio: 400');
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end(twiml.toString());
        }
      }

      session.answers.push(body);
      session.questionIndex += 1;
      touch(session);

      if (session.questionIndex < qs.length) {
        twiml.message(qs[session.questionIndex]);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      if (session.intent === 'noleggio') {
        const range = extractDateRange(session.answers[1]);
        const km = extractKm(session.answers[2]);

        let vehicles = [];
        try {
          vehicles = await getAvailability(range.startDate, range.endDate);
        } catch (e) {
          console.error('Errore disponibilitÃ :', e.message);
          session.questionIndex = 1;
          session.answers = [session.answers[0]];
          twiml.message('Non riesco a leggere disponibilitÃ  dal gestionale. Mandami unâ€™altra data oppure riprova tra poco.');
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end(twiml.toString());
        }

        if (!vehicles.length) {
          session.questionIndex = 1;
          session.answers = [session.answers[0]];
          twiml.message('Non trovo disponibilitÃ  per queste date. Mandami unâ€™altra data. Esempio: 18/05 - 20/05');
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end(twiml.toString());
        }

        session.state = 'vehicle_choice';
        session.pending = {
          requestedVehicle: session.answers[0],
          startDate: range.startDate,
          endDate: range.endDate,
          startLabel: range.startLabel,
          endLabel: range.endLabel,
          days: range.days,
          requestedKm: km,
          vehicles: vehicles.slice(0, 3)
        };

        await sendInternal(INTERNAL_GENERAL_NUMBERS, `ðŸ” PREVENTIVO NOLEGGIO\n\nðŸ‘¤ ${profileName}\nðŸ“ž ${from}\nðŸš Richiesta: ${session.pending.requestedVehicle}\nðŸ“… ${session.pending.startLabel} - ${session.pending.endLabel}\nðŸš— Km: ${km}\n\n${session.pending.vehicles.map((v,i)=>`${i+1}) ${v.name} - â‚¬ ${euro(v.estimatedTotalAmount)}`).join('\n')}`);

        twiml.message(`Ho trovato questi mezzi disponibili:\n\n${session.pending.vehicles.map((v,i)=>`${i+1}ï¸âƒ£ ${v.name}\nðŸ’° â‚¬ ${euro(v.estimatedTotalAmount)}`).join('\n\n')}\n\nScrivi 1, 2 oppure 3.`);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      await sendInternal(session.intent === 'officina' ? INTERNAL_OFFICINA_NUMBERS : INTERNAL_GENERAL_NUMBERS, `ðŸ”” NUOVA RICHIESTA ${session.intent.toUpperCase()}\n\nðŸ‘¤ ${profileName}\nðŸ“ž ${from}\n\n${session.answers.map((a,i)=>`${i+1}) ${a}`).join('\n')}`);
      twiml.message(session.intent === 'officina' ? `Grazie âœ… Richiesta inviata allâ€™officina.\nPuoi anche prenotare qui:\n${LINK_OFFICINA}` : 'Grazie âœ… Richiesta inviata allo staff. Ti ricontatteremo presto.');
      clearSession(from);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'vehicle_choice') {
      const idx = Number(normalize(body)) - 1;
      const selected = session.pending.vehicles?.[idx];

      if (!selected) {
        twiml.message('Scelta non valida. Scrivi 1, 2 oppure 3.');
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      session.pending.selectedVehicle = selected;
      session.pending.prezzoFinale = Number(selected.estimatedTotalAmount || 0);
      session.state = 'contract_data';
      session.pending.contractQuestions = contractQuestions();
      session.pending.contractAnswers = [];
      session.pending.contractQuestionIndex = 0;
      touch(session);

      twiml.message(`Perfetto ${profileName} âœ…\n\nHai scelto:\nðŸš ${selected.name}\nðŸ“… ${session.pending.startLabel} - ${session.pending.endLabel}\nðŸš— Km richiesti: ${session.pending.requestedKm} km\nðŸ’° Preventivo gestionale: â‚¬ ${euro(session.pending.prezzoFinale)}\n\nâœï¸ Ora inseriamo i dati per il contratto.\n\n${session.pending.contractQuestions[0]}`);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'contract_data') {
      const idx = session.pending.contractQuestionIndex || 0;
      const qs = session.pending.contractQuestions || contractQuestions();

      if (idx === 18 && !yesNo(body)) {
        twiml.message('Rispondimi solo SÃŒ oppure NO.');
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      if (idx === 4 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body)) {
        twiml.message('Email non valida. Scrivila cosÃ¬: nome@email.it');
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      session.pending.contractAnswers.push(body);

      if (idx === 18 && yesNo(body) === 'SI') {
        session.pending.contractQuestions.push('Nome e cognome del secondo autista.');
      }

      session.pending.contractQuestionIndex += 1;
      touch(session);

      if (session.pending.contractQuestionIndex < session.pending.contractQuestions.length) {
        twiml.message(session.pending.contractQuestions[session.pending.contractQuestionIndex]);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      session.pending.contractData = parseContractAnswers(session.pending.contractAnswers, profileName, from);
      session.state = 'confirm_noleggio';
      touch(session);

      twiml.message(`Controlla i dati contratto:\n\n${contractSummary(session.pending.contractData)}\n\nðŸš Mezzo: ${session.pending.selectedVehicle.name}\nðŸ“… ${session.pending.startLabel} - ${session.pending.endLabel}\nðŸ’° â‚¬ ${euro(session.pending.prezzoFinale)}\n\nConfermi prenotazione e contratto?\nRispondi SI oppure NO.`);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (session.state === 'confirm_noleggio') {
      const answer = yesNo(body);

      if (answer === 'NO') {
        clearSession(from);
        twiml.message('Prenotazione annullata. Scrivi menu per ricominciare.');
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      if (answer !== 'SI') {
        twiml.message('Rispondimi SI per confermare oppure NO per annullare.');
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      // FIX: non faccio piÃ¹ un secondo controllo disponibilitÃ  con confronto codice.
      // MyAppy puÃ² restituire codici/nomi diversi tra availability e booking e causare falsi "non disponibile".
      // Provo direttamente a prenotare il mezzo scelto dall'utente.
      let reservation;
      try {
        reservation = await createReservation(session, from);
      } catch (e) {
        console.error('âŒ ERRORE PRENOTAZIONE:', e.message);
        try {
          const fresh = await getAvailability(session.pending.startDate, session.pending.endDate);
          session.pending.vehicles = fresh.filter(v => v.code !== session.pending.selectedVehicle.code).slice(0, 3);
          session.state = 'vehicle_choice';
          if (session.pending.vehicles.length) {
            twiml.message(`âš ï¸ Il mezzo scelto non Ã¨ piÃ¹ disponibile.\n\nTi mostro alternative aggiornate:\n\n${session.pending.vehicles.map((v,i)=>`${i+1}ï¸âƒ£ ${v.name}\nðŸ’° â‚¬ ${euro(v.estimatedTotalAmount)}`).join('\n\n')}\n\nScrivi 1, 2 oppure 3.`);
          } else {
            session.state = 'questions';
            session.questionIndex = 1;
            session.answers = [session.pending.requestedVehicle];
            twiml.message('âš ï¸ Il mezzo non Ã¨ piÃ¹ disponibile e non trovo alternative. Mandami unâ€™altra data.');
          }
        } catch (_) {
          session.state = 'questions';
          session.questionIndex = 1;
          session.answers = [session.pending.requestedVehicle];
          twiml.message('âš ï¸ Il mezzo non Ã¨ piÃ¹ disponibile. Mandami unâ€™altra data e riprovo.');
        }
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      let updateId = '';
      try {
        const upd = await updateReservationData(reservation.id, session.pending.contractData);
        updateId = upd?.result?.client_reservation_update?.uid || upd?.client_reservation_update?.uid || '';
      } catch (e) {
        console.error('âš ï¸ ERRORE UPDATE ANAGRAFICA:', e.message);
        await sendInternal(INTERNAL_GENERAL_NUMBERS, `âš ï¸ ERRORE UPDATE ANAGRAFICA\n\nðŸ‘¤ ${profileName}\nðŸ“ž ${from}\nðŸ§¾ Prenotazione: ${reservation.id || '-'}\nErrore: ${e.message}`);
      }

      let paymentLink = '';
      let codiceTransazione = '';
      if (canUseNexi()) {
        try {
          const payment = await createNexiLink(session.pending.prezzoFinale, `Noleggio ${session.pending.selectedVehicle.name}`, from);
          paymentLink = payment.payMailUrl;
          codiceTransazione = payment.codiceTransazione;

          transactions[codiceTransazione] = {
            codiceTransazione,
            customerName: profileName,
            customerWhatsapp: from,
            vehicleName: session.pending.selectedVehicle.name,
            startLabel: session.pending.startLabel,
            endLabel: session.pending.endLabel,
            requestedKm: session.pending.requestedKm,
            amount: session.pending.prezzoFinale,
            reservationId: reservation.id || '',
            reservationStatus: reservation.status || '',
            clientReservationUpdateId: updateId || '',
            contractData: session.pending.contractData
          };
        } catch (e) {
          console.error('âŒ ERRORE NEXI:', e.message);
        }
      }

      await sendInternal(INTERNAL_GENERAL_NUMBERS, `âœ… PRENOTAZIONE NOLEGGIO CONFERMATA\n\nðŸ‘¤ ${profileName}\nðŸ“ž ${from}\nðŸš ${session.pending.selectedVehicle.name}\nðŸ“… ${session.pending.startLabel} - ${session.pending.endLabel}\nðŸ’° â‚¬ ${euro(session.pending.prezzoFinale)}\nðŸ§¾ Prenotazione: ${reservation.id || '-'}\nðŸ“ Update anagrafica: ${updateId || '-'}\n\n${contractSummary(session.pending.contractData)}${paymentLink ? `\n\nLink Nexi: ${paymentLink}` : ''}`);

      twiml.message(`Grazie ${profileName} âœ…\n\nðŸš Mezzo scelto: ${session.pending.selectedVehicle.name}\nðŸ“… Periodo: dal ${session.pending.startLabel} al ${session.pending.endLabel} (${session.pending.days} giorni)\nðŸš— Km richiesti: ${session.pending.requestedKm} km\nðŸ’° Preventivo gestionale: â‚¬ ${euro(session.pending.prezzoFinale)}\nðŸ§¾ Prenotazione gestionale: ${reservation.id || '-'}\nðŸ“Œ Stato gestionale: ${reservation.status || '-'}\n\nPuoi pagare il solo costo del noleggio qui:\n${paymentLink || 'Ti invieremo il link pagamento appena pronto.'}\n\nLa caparra di â‚¬ ${centsToEuro(NOLEGGIO_DEPOSIT_CENTS)} verrÃ  gestita separatamente dal nostro staff.`);

      clearSession(from);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    session = resetSession(from, profileName);
    twiml.message(menuText(profileName));
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());

  } catch (e) {
    console.error('âŒ ERRORE GENERALE:', e);
    twiml.message('Scusaci, si Ã¨ verificato un problema tecnico. Scrivi menu e riprova.');
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  }
}

app.post('/whatsapp', handleWhatsApp);
app.post('/webhook', handleWhatsApp);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server DP Rent FIX BOOKING avviato sulla porta ${PORT}`));
