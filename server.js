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

const VEHICLE_CATALOG = [
  {
    "uid": "94970631",
    "code": "F2-PC",
    "description": "Furgone-Merci-Manuale-Diesel | Iveco Daily o similare",
    "model": "IVECO DAILY"
  },
  {
    "uid": "58724774",
    "code": "A2 - Compact",
    "description": "Gruppo Auto - Compact | VW Golf o similare",
    "model": "VOLKSWAGEN GOLF  VI 1.6 TDI ADVANCE"
  },
  {
    "uid": "24630557",
    "code": "X-ESC",
    "description": "Escavatore Volvo/Toucan",
    "model": "VOLVO EC13"
  },
  {
    "uid": "19232792",
    "code": "P2-9P",
    "description": "Furgone-Persone-Manuale-Diesel | Ford Transit o similare",
    "model": "Ford Transit"
  },
  {
    "uid": "96753956",
    "code": "F1-VAN",
    "description": "Cargo | Fiat Scudo o similare",
    "model": "FIAT FIORINO"
  },
  {
    "uid": "45826265",
    "code": "A1 - Compact Eco",
    "description": "Gruppo Auto - Compact Eco | Dacia Sandero o similare",
    "model": "DACIA DACIA SANDERO"
  },
  {
    "uid": "68030919",
    "code": "A3-Compact Elite",
    "description": "Gruppo Auto - Compact Elite | Ford Kuga o similare",
    "model": "NISSAN NV200 EVALIA"
  },
  {
    "uid": "34793575",
    "code": "P1-8P",
    "description": "Furgone-Persone-Manuale-Diesel | Ford Tourneo 8px o similare",
    "model": "Ford Tourneo"
  },
  {
    "uid": "88605344",
    "code": "F3-PL",
    "description": "Furgone-Merci-Manuale-Diesel | Iveco Daily o similare",
    "model": "Iveco Daily"
  }
];

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

function isIsoDateStrict(value) {
  const s = isoDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parts = s.split('-').map(Number);
  const dt = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
  return dt.getFullYear() === parts[0] && dt.getMonth() === parts[1] - 1 && dt.getDate() === parts[2];
}

function cleanProvince(value) {
  return String(value || '').trim().toUpperCase().slice(0, 2);
}

function extractOnlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
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


function normVehicleCode(v) {
  return String(v || '').toUpperCase().replace(/\s+/g, '').replace(/[–—]/g, '-').trim();
}

function catalogByCode(code) {
  const n = normVehicleCode(code);
  return VEHICLE_CATALOG.find(v => normVehicleCode(v.code) === n) || null;
}

function vehicleMatchesRequest(vehicle, requestText) {
  const q = normalize(requestText);
  const code = normVehicleCode(vehicle.code);
  const name = normalize(`${vehicle.name || ''} ${vehicle.description || ''}`);
  if (q.includes('auto') || q.includes('macchina') || q.includes('vettura')) return code.startsWith('A') || name.includes('auto') || name.includes('compact');
  if (q.includes('furgone') || q.includes('van') || q.includes('merci') || q.includes('cargo')) return code.startsWith('F') || name.includes('furgone') || name.includes('cargo') || name.includes('merci');
  if (q.includes('pulmino') || q.includes('persone') || q.includes('posti') || q.includes('9') || q.includes('8')) return code.startsWith('P') || name.includes('persone') || name.includes('posti') || name.includes('tourneo');
  return true;
}

function filterVehiclesByRequest(vehicles, requestText) {
  const filtered = vehicles.filter(v => vehicleMatchesRequest(v, requestText));
  return filtered.length ? filtered : vehicles;
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


function safeWhatsAppText(text) {
  return String(text || '')
    .normalize('NFC')
    .replace(/[\uFFFD]/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

const EMO = {
  hi: '\u{1F44B}',
  ok: '\u2705',
  car: '\u{1F697}',
  van: '\u{1F690}',
  truck: '\u{1F69A}',
  money: '\u{1F4B0}',
  card: '\u{1F4B3}',
  cal: '\u{1F4C5}',
  doc: '\u{1F9FE}',
  pin: '\u{1F4CC}',
  user: '\u{1F464}',
  phone: '\u{1F4DE}',
  mail: '\u{1F4E7}',
  home: '\u{1F3E0}',
  warn: '\u26A0\uFE0F',
  wrench: '\u{1F527}',
  park: '\u{1F17F}\uFE0F',
  pen: '\u270D\uFE0F',
  search: '\u{1F50E}',
  road: '\u{1F6E3}\uFE0F'
};

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
  return `${EMO.hi} *Ciao ${name || 'Cliente'}*

Scegli il servizio:

1) ${EMO.wrench} Officina
2) ${EMO.car} Noleggio
3) ${EMO.money} Vendita auto
4) ${EMO.truck} Trasporto veicoli
5) ${EMO.phone} Contatto diretto
6) ${EMO.park} Parcheggio / Sosta

${EMO.pen} Scrivi solo il numero.
Esempio: *2*`;
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
  if (intent === 'sosta') return ['Che mezzo devi lasciare?', 'Date sosta? Esempio: 10/05 - 15/05', 'Hai bisogno di corrente? sì/no', 'Hai bisogno di acqua? sì/no'];
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
    officina: 'Perfetto  Ti aiuto con lOfficina.',
    noleggio: 'Perfetto. Ti aiuto con il Noleggio.',
    vendita: 'Perfetto. Ti aiuto con la Vendita auto.',
    trasporto: 'Perfetto. Ti aiuto con il Trasporto veicoli.',
    contatto: 'Perfetto. Ti metto in contatto con un responsabile.',
    sosta: 'Perfetto. Ti aiuto con Parcheggio / Sosta.'
  }[intent] || 'Perfetto ';

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
    'Codice fiscale conducente?',
    'Email?',
    'Telefono?',
    'Indirizzo completo?',
    'Città?',
    'Provincia? Esempio: TR',
    'CAP?',
    'Numero documento / carta identità?',
    'Ente rilascio documento? Esempio: Comune di Terni',
    'Data rilascio documento? Esempio: 16/01/2020',
    'Scadenza documento? Esempio: 15/01/2028',
    'Numero patente?',
    'Ente rilascio patente? Esempio: Motorizzazione',
    'Data rilascio patente? Esempio: 22/01/2015',
    'Scadenza patente? Esempio: 01/01/2028',
    'Fatturazione PRIVATO o AZIENDA?',
    'C’è un secondo autista? Rispondi SÌ oppure NO.'
  ];
}

function parseContractAnswers(a, profileName, from) {
  const n = splitName(a[0] || profileName);
  const billingRaw = normalize(a[18] || 'privato');
  const isCompany = billingRaw.includes('azienda') || billingRaw.includes('societa') || billingRaw.includes('ditta');
  const off = isCompany ? 10 : 0;

  const c = {
    first_name: n.first,
    name: n.last,
    full_name: `${n.first} ${n.last}`,
    date_of_birth: isoDate(a[1]),
    place_of_birth: a[2] || '',
    tax_number: String(a[3] || '').toUpperCase(),
    email: a[4] || '',
    phone: extractOnlyDigits(a[5] || String(from || '').replace('whatsapp:', '')),
    address: a[6] || '',
    city: a[7] || '',
    province: cleanProvince(a[8] || ''),
    zip_code: extractOnlyDigits(a[9] || ''),
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
    billing_type: isCompany ? 'company' : 'private',
    type: isCompany ? 'company' : 'private',
    company_name: '',
    vat_number: '',
    company_tax_number: '',
    pec: '',
    sdi_code: '',
    contact_person: `${n.first} ${n.last}`,
    billing_address: a[6] || '',
    billing_city: a[7] || '',
    billing_province: cleanProvince(a[8] || ''),
    billing_zip_code: extractOnlyDigits(a[9] || '')
  };

  if (isCompany) {
    c.company_name = a[19] || '';
    c.vat_number = String(a[20] || '').replace(/\s+/g, '').toUpperCase();
    c.company_tax_number = String(a[21] || '').replace(/\s+/g, '').toUpperCase();
    c.pec = a[22] || '';
    c.sdi_code = String(a[23] || '').replace(/\s+/g, '').toUpperCase();
    c.contact_person = a[24] || c.full_name;
    c.billing_address = a[25] || c.address;
    c.billing_city = a[26] || c.city;
    c.billing_province = cleanProvince(a[27] || c.province);
    c.billing_zip_code = extractOnlyDigits(a[28] || c.zip_code);
  }

  c.hasSecondDriver = yesNo(a[19 + off]) === 'SI';
  c.secondDriverName = a[20 + off] || '';

  return c;
}

function contractSummary(c) {
  const billing = c.billing_type === 'company'
    ? `\n${EMO.doc} *Fatturazione azienda*\nRagione sociale: ${c.company_name}\nP.IVA: ${c.vat_number}\nCF azienda: ${c.company_tax_number || '-'}\nPEC: ${c.pec || '-'}\nSDI: ${c.sdi_code || '-'}\nReferente: ${c.contact_person || '-'}\nSede: ${c.billing_address}, ${c.billing_city} (${c.billing_province}) ${c.billing_zip_code}`
    : `\n${EMO.doc} *Fatturazione privato*`;

  return `${EMO.user} *${c.first_name} ${c.name}*
${EMO.cal} ${c.date_of_birth} - ${c.place_of_birth}
${EMO.doc} CF: ${c.tax_number}
${EMO.mail} ${c.email}
${EMO.phone} ${c.phone}
${EMO.home} ${c.address}, ${c.city} (${c.province}) ${c.zip_code}
${EMO.doc} Documento: ${c.id_number} - scad. ${c.id_expiry_date}
${EMO.car} Patente: ${c.license_number} - scad. ${c.license_expiry_date}${billing}${c.hasSecondDriver ? `\n${EMO.user} Secondo autista: ${c.secondDriverName}` : ''}`;
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
<tr><td>Importo pagato</td><td>EUR ${htmlEscape(euro(tx.amount))}</td></tr>
<tr><td>Caparra</td><td>EUR ${htmlEscape(centsToEuro(NOLEGGIO_DEPOSIT_CENTS))} gestita separatamente</td></tr>
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
  const rateTotalAmount = Number(total?.['@_RateTotalAmount'] || 0);
  const estimatedTotalAmount = Number(total?.['@_EstimatedTotalAmount'] || rateTotalAmount || 0);
  const cat = catalogByCode(code);
  return {
    uid: cat?.uid || '',
    code,
    name: cat?.description ? `${cat.description} (${code})` : name,
    description: cat?.description || '',
    rateTotalAmount,
    estimatedTotalAmount,
    raw: item
  };
}

async function getAvailability(startDate, endDate) {
  if (!canUseCarRental()) throw new Error('Gestionale non configurato');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.opentravel.org/OTA/2003/05">
<SOAP-ENV:Body><ns1:OTA_VehAvailRateRQ>${soapAuth()}
<VehAvailRQCore><VehRentalCore PickUpDateTime="${toOtaStart(startDate)}" ReturnDateTime="${toOtaEnd(endDate)}">
<PickUpLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/><ReturnLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/>
</VehRentalCore></VehAvailRQCore></ns1:OTA_VehAvailRateRQ></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

  console.log('📤 OTA_VehAvailRateRQ:', xml);
  const r = await fetch(CARRENTAL_AVAIL_URL, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xml });
  const text = await r.text();
  console.log('📥 OTA_VehAvailRateRS:', text);

  if (!r.ok) throw new Error(`HTTP disponibilità ${r.status}`);
  const parsed = xmlParser.parse(text);
  const err = findFirst(parsed, ['Errors', 'Error', 'ns1:Errors', 'ns1:Error']);
  if (err) throw new Error(JSON.stringify(err));
  return arrayify(findFirst(parsed, ['VehAvail', 'ns1:VehAvail'])).map(vehicleFromAvail).filter(v => v.code || v.name);
}

async function createReservation(session, from) {
  const p = session.pending;
  const c = p.contractData || {};
  const selected = p.selectedVehicle || {};
  const amount = Number(p.prezzoFinale || selected.estimatedTotalAmount || 0);
  const net = Number(selected.rateTotalAmount || (amount / (1 + IVA_RATE)));
  const tax = Math.max(0, amount - net);
  const phone = String(c.phone || from || '').replace('whatsapp:', '').replace(/\s+/g, '');
  const email = c.email || 'cliente@trasportidp.com';

  // IMPORTANTE:
  // OTA_VehResRQ resta volutamente MINIMA.
  // MyAppy restituisce HTTP 500 con "complex type / array given" se mettiamo qui
  // documento, indirizzo completo o secondo autista.
  // Quei dati vengono inviati DOPO con:
  // POST /api/v1/client_reservation/{id}/client_reservation_update
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.opentravel.org/OTA/2003/05">
  <SOAP-ENV:Body>
    <ns1:OTA_VehResRQ>
      ${soapAuth()}
      <VehResRQCore>
        <VehRentalCore PickUpDateTime="${toOtaStart(p.startDate)}" ReturnDateTime="${toOtaEnd(p.endDate)}">
          <PickUpLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/>
          <ReturnLocation LocationCode="${xmlEscape(CARRENTAL_LOCATION_CODE)}"/>
        </VehRentalCore>
        <VehPref>
          <VehMakeModel Code="${xmlEscape(selected.code || '')}" Name=""/>
        </VehPref>
        <Customer>
          <Primary${c.date_of_birth ? ` BirthDate="${xmlEscape(c.date_of_birth)}"` : ""}>
            <PersonName>
              <GivenName>${xmlEscape(c.first_name || 'Cliente')}</GivenName>
              <Surname>${xmlEscape(c.name || 'WhatsApp')}</Surname>
            </PersonName>
            <Telephone PhoneNumber="${xmlEscape(phone)}"/>
            <Email>${xmlEscape(email)}</Email>
          </Primary>
        </Customer>
        <VehicleCharges>
          <VehicleCharge Purpose="1" TaxInclusive="false" IncludedInEstTotalInd="true" IncludedInRate="true" Description="Tariffa Indie Rent" Amount="${net.toFixed(2)}" CurrencyCode="EUR">
            <TaxAmounts>
              <TaxAmount CurrencyCode="EUR" Percentage="22" Total="${tax.toFixed(2)}"/>
            </TaxAmounts>
          </VehicleCharge>
        </VehicleCharges>
        <TotalCharge CurrencyCode="EUR" RateTotalAmount="${net.toFixed(2)}" EstimatedTotalAmount="${amount.toFixed(2)}"/>
      </VehResRQCore>
      <VehResRQInfo ResStatus="Book"/>
    </ns1:OTA_VehResRQ>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

  console.log('OTA_VehResRQ_MINIMA:', xml);
  const r = await fetch(CARRENTAL_RES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body: xml
  });

  const text = await r.text();
  console.log('OTA_VehResRS:', text);

  if (!r.ok) {
    const m = text.match(/<faultstring>([\s\S]*?)<\/faultstring>/i);
    throw new Error(`HTTP prenotazione ${r.status}${m ? ' - ' + m[1] : ''}`);
  }

  const parsed = xmlParser.parse(text);
  const fault = findFirst(parsed, ['Fault', 'SOAP-ENV:Fault', 'soap:Fault']);
  if (fault) throw new Error(JSON.stringify(fault));

  const err = findFirst(parsed, ['Errors', 'Error', 'ns1:Errors', 'ns1:Error']);
  if (err) throw new Error(JSON.stringify(err));

  const reservation = findFirst(parsed, ['VehReservation', 'ns1:VehReservation']) || {};
  const confs = arrayify(findFirst(parsed, ['ConfID', 'ns1:ConfID']));
  const reservationId =
    (confs.find(x => String(x?.['@_Type'] || '') === '16') || confs[0] || {})?.['@_ID'] ||
    findFirst(parsed, ['UniqueID', 'ns1:UniqueID'])?.['@_ID'] ||
    '';

  if (!reservationId) {
    console.log('ATTENZIONE: prenotazione creata ma ID non trovato nella risposta');
  }

  return {
    status: reservation?.['@_ReservationStatus'] || 'Reserved',
    id: reservationId
  };
}


function buildCrsUpdatePayload(c) {
  const client = {
    type: c.billing_type === 'company' ? 'company' : 'private',
    first_name: c.billing_type === 'company' ? (c.contact_person || c.first_name || '') : (c.first_name || ''),
    name: c.billing_type === 'company' ? (c.company_name || c.name || '') : (c.name || ''),
    contact_person: c.contact_person || `${c.first_name || ''} ${c.name || ''}`.trim(),
    vat_number: c.billing_type === 'company' ? (c.vat_number || '') : null,
    tax_number: c.billing_type === 'company' ? (c.company_tax_number || c.vat_number || '') : (c.tax_number || ''),
    pec: c.billing_type === 'company' ? (c.pec || null) : null,
    sdi_code: c.billing_type === 'company' ? (c.sdi_code || null) : null,
    email: c.email || '',
    phone: c.phone || '',
    address: c.billing_type === 'company' ? (c.billing_address || c.address || '') : (c.address || ''),
    city: c.billing_type === 'company' ? (c.billing_city || c.city || '') : (c.city || ''),
    province: c.billing_type === 'company' ? (c.billing_province || c.province || '') : (c.province || ''),
    zip_code: c.billing_type === 'company' ? (c.billing_zip_code || c.zip_code || '') : (c.zip_code || ''),
    country_id: c.country_id || '111',
    date_of_birth: c.billing_type === 'company' ? null : (c.date_of_birth || ''),
    place_of_birth: c.billing_type === 'company' ? null : (c.place_of_birth || '')
  };

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

  const payload = { client, client_driver: { "0": driver0 } };

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
      phone: c.phone || '',
      email: c.email || ''
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

  console.log('📤 CRS UPDATE URL:', url);
  console.log('📤 CRS UPDATE BODY:', JSON.stringify(payload, null, 2));

  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  console.log('📥 CRS UPDATE RISPOSTA:', JSON.stringify(data, null, 2));

  if (!r.ok) throw new Error(`HTTP CRS ${r.status}: ${text}`);
  if (data.success === false) throw new Error(data.error || data.message || 'Update anagrafica fallito');
  return data;
}

// =========================
// NEXI
// =========================
function publicBaseUrl(req) {
  const proto = req?.headers?.['x-forwarded-proto'] || 'https';
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || '';
  return APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || (host ? `${proto}://${host}` : '');
}

function canUseNexi() {
  return Boolean(NEXI_ALIAS && NEXI_MAC_KEY);
}
function nexiMac({ apiKey, codiceTransazione, importo, timeStamp }) {
  const source = `apiKey=${apiKey}` + `codiceTransazione=${codiceTransazione}` + `importo=${importo}` + `timeStamp=${timeStamp}` + NEXI_MAC_KEY;
  return crypto.createHash('sha1').update(source).digest('hex');
}
async function createNexiLink(amount, description, from, baseUrl) {
  const codiceTransazione = buildOrderId('DP');
  const timeStamp = Date.now().toString();
  const importo = String(euroToCents(amount));
  const callbackBase = (baseUrl || APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  const payload = {
    apiKey: NEXI_ALIAS,
    codiceTransazione,
    importo,
    timeStamp,
    mac: nexiMac({ apiKey: NEXI_ALIAS, codiceTransazione, importo, timeStamp }),
    timeout: String(NEXI_TIMEOUT_HOURS),
    url: `${callbackBase}/nexi/result`,
    urlpost: `${callbackBase}/nexi/notify`,
    parametriAggiuntivi: { source: 'dp_whatsapp', description, from }
  };

  console.log('📤 NEXI:', { endpoint: NEXI_PAYMAIL_ENDPOINT, codiceTransazione, importo, env: NEXI_ENV });
  const r = await fetch(NEXI_PAYMAIL_ENDPOINT, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await r.json().catch(() => ({}));
  console.log('📥 NEXI:', data);

  if (!r.ok) throw new Error(`HTTP Nexi ${r.status}`);
  if (data.esito !== 'OK') throw new Error(data?.errore?.messaggio || data?.errore?.description || data?.errore?.codice || 'Errore Nexi');
  const payUrl = data.payMailUrl || data.paymailUrl || data.url || data.urlPayMail || data.link || data.paymentUrl;
  if (!payUrl) throw new Error('Nexi non ha restituito il link pagamento: ' + JSON.stringify(data).slice(0, 500));
  return { codiceTransazione, payMailUrl: payUrl };
}

// =========================
// NOTIFICHE
// =========================
async function sendInternal(numbers, body) {
  for (const to of numbers) {
    try {
      const msg = await client.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to, body });
      console.log(' NOTIFICA INVIATA:', to, msg.sid);
    } catch (e) {
      console.error(' ERRORE NOTIFICA:', to, e.message, e.code || '');
    }
  }
}

async function notifyPayment(tx) {
  const contractUrl = APP_BASE_URL ? `${APP_BASE_URL}/contratto/${encodeURIComponent(tx.codiceTransazione)}` : '';
  await sendInternal(INTERNAL_GENERAL_NUMBERS, ` PAGAMENTO RICEVUTO\n\n ${tx.customerName}\n ${tx.customerWhatsapp}\n ${tx.vehicleName}\n ${tx.startLabel} - ${tx.endLabel}\n EUR ${euro(tx.amount)}\n ${tx.codiceTransazione}${contractUrl ? `\n Contratto: ${contractUrl}` : ''}`);

  try {
    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: tx.customerWhatsapp,
      body: ` Pagamento ricevuto!\n\n ${tx.vehicleName}\n ${tx.startLabel} - ${tx.endLabel}\n EUR ${euro(tx.amount)}\n\n${contractUrl ? ` Contratto:\n${contractUrl}\n\n` : ''}Grazie da Trasporti DP.`
    });
  } catch (e) {
    console.error('Errore invio pagamento cliente:', e.message);
  }
}

// =========================
// ROUTES
// =========================
app.get('/', (req, res) => res.send('Server DP Rent attivo '));
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
  res.send(`<html><head><meta charset="utf-8"></head><body style="font-family:Arial;text-align:center;padding:40px"><h1>Pagamento completato </h1>${contractUrl ? `<p><a href="${contractUrl}" style="font-size:22px">Apri contratto</a></p>` : ''}<p>Grazie da Trasporti DP.</p></body></html>`);
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
      twiml.message(safeWhatsAppText('Errore ricezione messaggio.'));
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      return res.end(twiml.toString());
    }

    if (isDuplicateSid(sid)) {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      return res.end(new twilio.twiml.MessagingResponse().toString());
    }

    let session = getSession(from, profileName);

    if (['menu', 'inizio', 'reset', 'ricomincia'].includes(normalize(body))) {
      session = resetSession(from, profileName);
      twiml.message(safeWhatsAppText(menuText(profileName)));
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      return res.end(twiml.toString());
    }

    // MENU SOLO quando stato e menu. NON intercetta "Auto/Furgone" durante domande.
    if (session.state === 'menu') {
      const intent = detectIntent(body);
      if (!intent) {
        twiml.message(safeWhatsAppText(menuText(profileName)));
      } else {
        twiml.message(safeWhatsAppText(startIntent(session, intent)));
      }
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      return res.end(twiml.toString());
    }

    if (session.state === 'questions') {
      const qs = questionsFor(session.intent);

      if (session.intent === 'noleggio') {
        if (session.questionIndex === 1 && !extractDateRange(body)) {
          twiml.message(safeWhatsAppText('Non riesco a leggere le date. Scrivile cosi: 10/05 - 15/05'));
          res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
          return res.end(twiml.toString());
        }
        if (session.questionIndex === 2 && extractKm(body) === null) {
          twiml.message(safeWhatsAppText('Indicami solo i km previsti. Esempio: 400'));
          res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
          return res.end(twiml.toString());
        }
      }

      session.answers.push(body);
      session.questionIndex += 1;
      touch(session);

      if (session.questionIndex < qs.length) {
        twiml.message(safeWhatsAppText(qs[session.questionIndex]));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      if (session.intent === 'noleggio') {
        const range = extractDateRange(session.answers[1]);
        const km = extractKm(session.answers[2]);

        let vehicles = [];
        try {
          vehicles = filterVehiclesByRequest(await getAvailability(range.startDate, range.endDate), session.answers[0]);
        } catch (e) {
          console.error('Errore disponibilità:', e.message);
          session.questionIndex = 1;
          session.answers = [session.answers[0]];
          twiml.message(safeWhatsAppText('Non riesco a leggere disponibilità dal gestionale. Mandami un’altra data oppure riprova tra poco.'));
          res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
          return res.end(twiml.toString());
        }

        if (!vehicles.length) {
          session.questionIndex = 1;
          session.answers = [session.answers[0]];
          twiml.message(safeWhatsAppText('Non trovo disponibilità per queste date. Mandami un’altra data. Esempio: 18/05 - 20/05'));
          res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
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

        await sendInternal(INTERNAL_GENERAL_NUMBERS, ` PREVENTIVO NOLEGGIO\n\n ${profileName}\n ${from}\n Richiesta: ${session.pending.requestedVehicle}\n ${session.pending.startLabel} - ${session.pending.endLabel}\n Km: ${km}\n\n${session.pending.vehicles.map((v,i)=>`${i+1}) ${v.name} - EUR ${euro(v.estimatedTotalAmount)}`).join('\n')}`);

        twiml.message(safeWhatsAppText(`Ho trovato questi mezzi disponibili:\n\n${session.pending.vehicles.map((v,i)=>`${i+1}️⃣ ${v.name}\n EUR ${euro(v.estimatedTotalAmount)}`).join('\n\n')}\n\nScrivi 1, 2 oppure 3.`));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      await sendInternal(session.intent === 'officina' ? INTERNAL_OFFICINA_NUMBERS : INTERNAL_GENERAL_NUMBERS, ` NUOVA RICHIESTA ${session.intent.toUpperCase()}\n\n ${profileName}\n ${from}\n\n${session.answers.map((a,i)=>`${i+1}) ${a}`).join('\n')}`);
      twiml.message(safeWhatsAppText(session.intent === 'officina' ? `Grazie  Richiesta inviata allofficina.\nPuoi anche prenotare qui:\n${LINK_OFFICINA}` : 'Grazie  Richiesta inviata allo staff. Ti ricontatteremo presto.'));
      clearSession(from);
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      return res.end(twiml.toString());
    }

    if (session.state === 'vehicle_choice') {
      const idx = Number(normalize(body)) - 1;
      const selected = session.pending.vehicles?.[idx];

      if (!selected) {
        twiml.message(safeWhatsAppText('Scelta non valida. Scrivi 1, 2 oppure 3.'));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      session.pending.selectedVehicle = selected;
      session.pending.prezzoFinale = Number(selected.estimatedTotalAmount || 0);
      session.state = 'contract_data';
      session.pending.contractQuestions = contractQuestions();
      session.pending.contractAnswers = [];
      session.pending.contractQuestionIndex = 0;
      touch(session);

      twiml.message(safeWhatsAppText(`Perfetto ${profileName} \n\nHai scelto:\n ${selected.name}\n ${session.pending.startLabel} - ${session.pending.endLabel}\n Km richiesti: ${session.pending.requestedKm} km\n Preventivo gestionale: EUR ${euro(session.pending.prezzoFinale)}\n\n Ora inseriamo i dati per il contratto.\n\n${session.pending.contractQuestions[0]}`));
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      return res.end(twiml.toString());
    }

    if (session.state === 'contract_data') {
      const idx = session.pending.contractQuestionIndex || 0;
      const qs = session.pending.contractQuestions || contractQuestions();

      if (idx === 18 && !yesNo(body)) {
        twiml.message(safeWhatsAppText('Rispondimi solo SI oppure NO.'));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      if (idx === 4 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body)) {
        twiml.message(safeWhatsAppText('Email non valida. Scrivila cosi: nome@email.it'));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      // Validazioni forti: MyAppy rifiuta con E05504 se date/email sono sporche.
      if ([1, 12, 13, 16, 17].includes(idx) && !isIsoDateStrict(body)) {
        twiml.message(safeWhatsAppText('Data non valida. Scrivila cosi: 22/04/1982'));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      if (idx === 4 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body)) {
        twiml.message(safeWhatsAppText('Email non valida. Scrivila cosi: nome@email.it'));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      if (idx === 5 && extractOnlyDigits(body).length < 8) {
        twiml.message(safeWhatsAppText('Telefono non valido. Scrivi solo il numero, esempio: 3287377675'));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      if (idx === 8 && cleanProvince(body).length < 2) {
        twiml.message(safeWhatsAppText('Provincia non valida. Esempio: TR'));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      if (idx === 9 && !/^\d{5}$/.test(extractOnlyDigits(body))) {
        twiml.message(safeWhatsAppText('CAP non valido. Esempio: 05100'));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      if (idx === 18) {
        const bt = normalize(body);
        if (!(bt.includes('privato') || bt.includes('azienda') || bt.includes('societa') || bt.includes('ditta'))) {
          twiml.message(safeWhatsAppText('Rispondi PRIVATO oppure AZIENDA.'));
          res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
          return res.end(twiml.toString());
        }
      }

      if ((idx === 19 || idx === 29) && !yesNo(body)) {
        twiml.message(safeWhatsAppText('Rispondimi solo SI oppure NO.'));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      session.pending.contractAnswers.push(body);

      if (idx === 18) {
        const bt = normalize(body);
        if (bt.includes('azienda') || bt.includes('societa') || bt.includes('ditta')) {
          session.pending.contractQuestions.splice(19, 0,
            'Ragione sociale azienda?',
            'Partita IVA?',
            'Codice fiscale azienda? Se uguale alla P.IVA riscrivi la P.IVA.',
            'PEC azienda? Se non presente scrivi NO.',
            'Codice SDI? Se non presente scrivi NO.',
            'Referente aziendale?',
            'Indirizzo fatturazione azienda?',
            'Città fatturazione?',
            'Provincia fatturazione? Esempio: TR',
            'CAP fatturazione?'
          );
        }
      }

      if ((idx === 19 || idx === 29) && yesNo(body) === 'SI') {
        session.pending.contractQuestions.push('Nome e cognome del secondo autista.');
      }

      session.pending.contractQuestionIndex += 1;
      touch(session);

      if (session.pending.contractQuestionIndex < session.pending.contractQuestions.length) {
        twiml.message(safeWhatsAppText(session.pending.contractQuestions[session.pending.contractQuestionIndex]));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      session.pending.contractData = parseContractAnswers(session.pending.contractAnswers, profileName, from);
      session.state = 'confirm_noleggio';
      touch(session);

      twiml.message(safeWhatsAppText(`${EMO.search} *Controlla i dati contratto*\n\n${contractSummary(session.pending.contractData)}\n\n Mezzo: ${session.pending.selectedVehicle.name}\n ${session.pending.startLabel} - ${session.pending.endLabel}\n EUR ${euro(session.pending.prezzoFinale)}\n\nConfermi prenotazione e contratto?\nRispondi SI oppure NO.`));
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      return res.end(twiml.toString());
    }

    if (session.state === 'confirm_noleggio') {
      const answer = yesNo(body);

      if (answer === 'NO') {
        clearSession(from);
        twiml.message(safeWhatsAppText('Prenotazione annullata. Scrivi menu per ricominciare.'));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      if (answer !== 'SI') {
        twiml.message(safeWhatsAppText('Rispondimi SI per confermare oppure NO per annullare.'));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      // FIX: non faccio più un secondo controllo disponibilità con confronto codice.
      // MyAppy può restituire codici/nomi diversi tra availability e booking e causare falsi "non disponibile".
      // Provo direttamente a prenotare il mezzo scelto dall'utente.
      let reservation;
      try {
        reservation = await createReservation(session, from);
      } catch (e) {
        console.error('ERRORE PRENOTAZIONE GESTIONALE:', e.message);
        await sendInternal(
          INTERNAL_GENERAL_NUMBERS,
          `ERRORE PRENOTAZIONE GESTIONALE

` +
          `Cliente: ${profileName}
` +
          `Telefono: ${from}
` +
          `Mezzo: ${session.pending.selectedVehicle?.name || '-'}
` +
          `Codice mezzo: ${session.pending.selectedVehicle?.code || '-'}
` +
          `UID mezzo csv: ${session.pending.selectedVehicle?.uid || '-'}
` +
          `Periodo: ${session.pending.startLabel} - ${session.pending.endLabel}
` +
          `Errore reale gestionale: ${String(e.message).slice(0, 180)}`
        );
        twiml.message(safeWhatsAppText(`Il gestionale ha rifiutato la prenotazione.

Errore reale gestionale: ${String(e.message).slice(0, 180)}

Ho inviato tutto allo staff con codice mezzo e UID. Scrivi menu per riprovare.`));
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        return res.end(twiml.toString());
      }

      let updateId = '';
      try {
        const upd = await updateReservationData(reservation.id, session.pending.contractData);
        updateId = upd?.result?.client_reservation_update?.uid || upd?.client_reservation_update?.uid || '';
      } catch (e) {
        console.error(' ERRORE UPDATE ANAGRAFICA:', e.message);
        await sendInternal(INTERNAL_GENERAL_NUMBERS, ` ERRORE UPDATE ANAGRAFICA\n\n ${profileName}\n ${from}\n Prenotazione: ${reservation.id || '-'}\nErrore: ${e.message}`);
      }

      let paymentLink = '';
      let codiceTransazione = '';
      if (canUseNexi()) {
        try {
          const payment = await createNexiLink(session.pending.prezzoFinale, `Noleggio ${session.pending.selectedVehicle.name}`, from, publicBaseUrl(req));
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
          console.error('ERRORE NEXI:', e.message); await sendInternal(INTERNAL_GENERAL_NUMBERS, `ERRORE NEXI\nPrenotazione: ${reservation.id || '-'}\nErrore: ${e.message}`);
        }
      }

      await sendInternal(INTERNAL_GENERAL_NUMBERS, ` PRENOTAZIONE NOLEGGIO CONFERMATA\n\n ${profileName}\n ${from}\n ${session.pending.selectedVehicle.name}\n ${session.pending.startLabel} - ${session.pending.endLabel}\n EUR ${euro(session.pending.prezzoFinale)}\n Prenotazione: ${reservation.id || '-'}\n Update anagrafica: ${updateId || '-'}\n\n${contractSummary(session.pending.contractData)}${paymentLink ? `\n\nLink Nexi: ${paymentLink}` : ''}`);

      twiml.message(safeWhatsAppText(`${EMO.ok} *PRENOTAZIONE CONFERMATA*

Grazie *${profileName}*

${EMO.van} *Mezzo scelto*
${session.pending.selectedVehicle.name}

${EMO.cal} *Periodo*
Dal ${session.pending.startLabel} al ${session.pending.endLabel} (${session.pending.days} giorni)

${EMO.road} *Km richiesti:* ${session.pending.requestedKm} km
${EMO.money} *Totale noleggio:* € ${euro(session.pending.prezzoFinale)}

${EMO.doc} *Prenotazione gestionale:* ${reservation.id || '-'}
${EMO.pin} *Stato:* ${reservation.status || '-'}

${paymentLink ? `${EMO.card} *Pagamento online*\n${paymentLink}` : `${EMO.warn} Link pagamento non generato. Ti invieremo il link appena pronto.`}

${EMO.money} Caparra € ${centsToEuro(NOLEGGIO_DEPOSIT_CENTS)} gestita separatamente dal nostro staff.

*DP RENT*`));

      clearSession(from);
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      return res.end(twiml.toString());
    }

    session = resetSession(from, profileName);
    twiml.message(safeWhatsAppText(menuText(profileName)));
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    return res.end(twiml.toString());

  } catch (e) {
    console.error(' ERRORE GENERALE:', e);
    twiml.message(safeWhatsAppText('Scusaci, si e verificato un problema tecnico. Scrivi menu e riprova.'));
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    return res.end(twiml.toString());
  }
}

app.post('/whatsapp', handleWhatsApp);
app.post('/webhook', handleWhatsApp);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server DP Rent AZIENDA PATENTE NEXI avviato sulla porta ${PORT}`));
