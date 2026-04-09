require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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
// NEXI CLASSICO (ALIAS + MAC)
// =========================
const NEXI_ENV = (process.env.NEXI_ENV || 'test').toLowerCase();
const NEXI_API_KEY_ALIAS = process.env.NEXI_ALIAS || '';
const NEXI_MAC_KEY = process.env.NEXI_MAC_KEY || '';
const NEXI_TIMEOUT_HOURS = parseInt(process.env.NEXI_TIMEOUT_HOURS || '4', 10);

const NEXI_BASE_URL =
  NEXI_ENV === 'prod'
    ? 'https://ecommerce.nexi.it'
    : 'https://int-ecommerce.nexi.it';

const NEXI_PAYMAIL_ENDPOINT = `${NEXI_BASE_URL}/ecomm/api/bo/richiestaPayMail`;

// =========================
// PREZZI
// =========================
const IVA_RATE = 0.22;

// parcheggio / sosta
const SOSTA_PRICE_PER_DAY_CENTS = parseInt(process.env.SOSTA_PRICE_PER_DAY_CENTS || '2000', 10);
const SOSTA_CORRENTE_EXTRA_CENTS = parseInt(process.env.SOSTA_CORRENTE_EXTRA_CENTS || '500', 10);
const SOSTA_ACQUA_EXTRA_CENTS = parseInt(process.env.SOSTA_ACQUA_EXTRA_CENTS || '300', 10);

// noleggio
const NOLEGGIO_PRICE_PER_DAY_EUR = parseFloat(process.env.NOLEGGIO_PRICE_PER_DAY_EUR || '70');
const NOLEGGIO_KM_INCLUDED_PER_DAY = parseInt(process.env.NOLEGGIO_KM_INCLUDED_PER_DAY || '150', 10);
const NOLEGGIO_EXTRA_KM_EUR = parseFloat(process.env.NOLEGGIO_EXTRA_KM_EUR || '0.15');

// caparra noleggio
const NOLEGGIO_DEPOSIT_ENABLED =
  (process.env.NOLEGGIO_DEPOSIT_ENABLED || 'true').toLowerCase() === 'true';
const NOLEGGIO_DEPOSIT_CENTS = parseInt(process.env.NOLEGGIO_DEPOSIT_CENTS || '50000', 10);

// =========================
// FUNZIONI BASE
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

  if (String(year).length === 2) {
    year += 2000;
  }

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

  if (msg === 'menu' || msg === 'reset') {
    return 'menu';
  }

  const menuChoice = intentFromMenuChoice(msg);
  if (menuChoice && menuChoice !== currentIntent) {
    return menuChoice;
  }

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
    `Salve ${customerName} 👋\n` +
    'Benvenuto in *Trasporti DP*.\n\n' +
    'Per poterla assistere al meglio, selezioni il servizio di suo interesse rispondendo con il numero corrispondente:\n\n' +
    '1️⃣ *Officina* 🔧\n' +
    '2️⃣ *Noleggio* 🚐\n' +
    '3️⃣ *Vendita auto* 🚗\n' +
    '4️⃣ *Trasporto veicoli* 🚛\n' +
    '5️⃣ *Contatto diretto / Responsabile* 📞\n' +
    '6️⃣ *Parcheggio / Sosta* 🅿️\n\n' +
    'In alternativa, può anche scrivere direttamente la sua richiesta.'
  );
}

function buildStartMessageByIntent(intent, profileName) {
  const customerName = formatCustomerName(profileName);

  if (intent === 'officina') {
    return (
      `Salve ${customerName} 👋\n\n` +
      'La sua richiesta è stata indirizzata al reparto *Officina* 🔧.\n\n' +
      'Le chiediamo gentilmente alcune informazioni per gestirla al meglio.'
    );
  }

  if (intent === 'noleggio') {
    return (
      `Salve ${customerName} 👋\n\n` +
      'La sua richiesta è stata indirizzata al reparto *Noleggio* 🚐.\n\n' +
      'Le chiediamo gentilmente alcune informazioni per procedere.'
    );
  }

  if (intent === 'vendita') {
    return (
      `Salve ${customerName} 👋\n\n` +
      'La sua richiesta è stata indirizzata al reparto *Vendita auto* 🚗.\n\n' +
      'Le chiediamo gentilmente alcune informazioni per aiutarla al meglio.'
    );
  }

  if (intent === 'trasporto') {
    return (
      `Salve ${customerName} 👋\n\n` +
      'La sua richiesta è stata indirizzata al reparto *Trasporto veicoli* 🚛.\n\n' +
      'Le chiediamo gentilmente alcune informazioni per organizzarla.'
    );
  }

  if (intent === 'contatto_diretto') {
    return (
      `Salve ${customerName} 👋\n\n` +
      'La sua richiesta è stata indirizzata a un *responsabile* 📞.\n\n' +
      'Le chiediamo gentilmente alcune informazioni per poterla ricontattare al più presto.'
    );
  }

  if (intent === 'parcheggio_sosta') {
    return (
      `Salve ${customerName} 👋\n\n` +
      'La sua richiesta è stata indirizzata al servizio *Parcheggio / Sosta* 🅿️.\n\n' +
      'Le chiediamo gentilmente alcune informazioni per verificare disponibilità, servizi e importo.'
    );
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
      'Che *mezzo* le occorre?',
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
    return [
      'Può indicarci brevemente il *motivo della richiesta*?'
    ];
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
    const datesPart =
      extra.startLabel && extra.endLabel
        ? `\nPeriodo richiesto: *dal ${extra.startLabel} al ${extra.endLabel}* (${extra.days} giorni).`
        : '';

    const pricePart =
      extra.baseTotalExVat !== undefined
        ? `\n\n💰 *Noleggio:* € ${formatEuroNumber(extra.baseTotalExVat)} + IVA 22%` +
          `\n💰 *Totale con IVA:* € ${formatEuroNumber(extra.baseTotalIncVat)}` +
          `\n🚗 *Km inclusi:* ${extra.kmIncluded} km` +
          `\n📍 *Extra km:* € ${formatEuroNumber(extra.extraKmExVat)} + IVA 22% / km`
        : '';

    const depositPart =
      extra.paymentLink && extra.depositCents
        ? `\n\nPer confermare la prenotazione è richiesta una *caparra di € ${eurosFromCents(extra.depositCents)}*.\nPuò versarla qui:\n${extra.paymentLink}`
        : `\n\nPer confermare la prenotazione è richiesta una *caparra di € ${eurosFromCents(extra.depositCents || NOLEGGIO_DEPOSIT_CENTS)}*.`;

    return (
      `La ringraziamo ${customerName} ✅\n\n` +
      'La sua richiesta per il reparto *Noleggio* è stata registrata correttamente e inoltrata al nostro staff.' +
      datesPart +
      pricePart +
      '\n\nSarà ricontattato al più presto *sul numero WhatsApp da cui ci sta scrivendo*.' +
      depositPart
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

// =========================
// CALCOLI
// =========================
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

function computeNoleggio(answers) {
  const dateRange = extractDateRange(answers[1]);
  if (!dateRange) return null;

  const giorni = dateRange.days;
  const baseTotalExVat = NOLEGGIO_PRICE_PER_DAY_EUR * giorni;
  const baseTotalIncVat = baseTotalExVat * (1 + IVA_RATE);
  const kmIncluded = NOLEGGIO_KM_INCLUDED_PER_DAY * giorni;
  const extraKmExVat = NOLEGGIO_EXTRA_KM_EUR;
  const extraKmIncVat = extraKmExVat * (1 + IVA_RATE);

  return {
    giorni,
    startLabel: dateRange.startLabel,
    endLabel: dateRange.endLabel,
    baseTotalExVat,
    baseTotalIncVat,
    kmIncluded,
    extraKmExVat,
    extraKmIncVat
  };
}

// =========================
// NEXI PAY-BY-LINK POST JSON
// =========================
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

async function createNexiPayMailLink({
  amountCents,
  description,
  customerWhatsapp
}) {
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

  if (!response.ok) {
    throw new Error(`Errore HTTP Nexi: ${response.status}`);
  }

  if (!data || !data.esito) {
    throw new Error('Risposta Nexi non valida');
  }

  if (data.esito !== 'OK') {
    const detail =
      data?.errore?.messaggio ||
      data?.errore?.description ||
      data?.errore?.codice ||
      'Operazione Nexi non riuscita';
    throw new Error(detail);
  }

  if (!data.payMailUrl) {
    throw new Error('Link pagamento Nexi non restituito');
  }

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
// MESSAGGI INTERNI
// =========================
function buildInternalMessage(session, incomingFrom, profileName, extra = {}) {
  const a = session.answers;
  const customerName = formatCustomerName(profileName);
  const whatsappNumber = formatWhatsappNumber(incomingFrom);

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
        ? `Noleggio: € ${formatEuroNumber(extra.baseTotalExVat)} + IVA 22%\n` +
          `Totale con IVA: € ${formatEuroNumber(extra.baseTotalIncVat)}\n` +
          `Km inclusi: ${extra.kmIncluded} km\n` +
          `Extra km: € ${formatEuroNumber(extra.extraKmExVat)} + IVA 22% / km\n`
        : '') +
      (extra.depositCents ? `Caparra richiesta: € ${eurosFromCents(extra.depositCents)}\n` : '') +
      (extra.paymentLink ? `Link pagamento Nexi: ${extra.paymentLink}\n` : '')
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
// INVIO INTERNO
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

      console.log(`✅ Notifica inviata a ${to}`);
      console.log(`SID: ${result.sid}`);
      console.log(`Status iniziale: ${result.status}`);
    } catch (error) {
      console.error(`❌ Errore invio notifica a ${to}`);
      console.error('message:', error.message);
      console.error('code:', error.code);
      console.error('status:', error.status);
      console.error('moreInfo:', error.moreInfo);
    }
  }
}

// =========================
// SESSIONI
// =========================
function resetSession(phone) {
  delete sessions[phone];
  saveSessionsToFile();
}

function createSession(phone, profileName) {
  sessions[phone] = {
    profileName,
    state: 'menu',
    intent: null,
    questionIndex: 0,
    questions: [],
    answers: [],
    createdAt: Date.now()
  };
  saveSessionsToFile();
  return sessions[phone];
}

function setSessionIntent(session, intent) {
  session.intent = intent;
  session.questions = buildQuestions(intent);
  session.state = 'questions';
  session.questionIndex = 0;
  session.answers = [];
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

  if (intent === 'noleggio' && idx === 1) {
    const range = extractDateRange(text);
    if (!range) {
      return {
        valid: false,
        message:
          'Formato date non riconosciuto.\n\nPer favore scriva così:\n*10/05 - 15/05*'
      };
    }
  }

  if (intent === 'parcheggio_sosta') {
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
// ROUTE INFO
// =========================
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

// =========================
// WEBHOOK WHATSAPP
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
      resetSession(incomingFrom);
      session = null;
    }

    if (normalize(incomingText) === 'reset' || normalize(incomingText) === 'menu') {
      resetSession(incomingFrom);
      twiml.message(buildWelcomeMenu(profileName));
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    if (!session) {
      session = createSession(incomingFrom, profileName);

      const detectedIntent = detectIntent(incomingText);

      if (detectedIntent !== 'generico') {
        setSessionIntent(session, detectedIntent);

        twiml.message(
          buildStartMessageByIntent(detectedIntent, profileName) +
            '\n\n' +
            session.questions[0]
        );
      } else {
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

    if (session.state === 'questions') {
      const switchedIntent = detectServiceSwitch(incomingText, session.intent);

      if (switchedIntent === 'menu') {
        resetSession(incomingFrom);
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
            internalExtra.paymentLink = `ERRORE NEXI: ${error.message}`;
          }
        }

        confirmationMessage = buildCustomerConfirmation(
          session.intent,
          profileName,
          internalExtra
        );
      } else if (session.intent === 'noleggio') {
        const quote = computeNoleggio(session.answers);

        if (quote) {
          internalExtra = {
            startLabel: quote.startLabel,
            endLabel: quote.endLabel,
            days: quote.giorni,
            baseTotalExVat: quote.baseTotalExVat,
            baseTotalIncVat: quote.baseTotalIncVat,
            kmIncluded: quote.kmIncluded,
            extraKmExVat: quote.extraKmExVat,
            extraKmIncVat: quote.extraKmIncVat,
            depositCents: NOLEGGIO_DEPOSIT_CENTS
          };
        }

        if (NOLEGGIO_DEPOSIT_ENABLED && canUseNexi()) {
          try {
            const payment = await createNexiPayMailLink({
              amountCents: NOLEGGIO_DEPOSIT_CENTS,
              description: `Caparra noleggio ${session.answers[0] || ''}`,
              customerWhatsapp: formatWhatsappNumber(incomingFrom)
            });
            internalExtra.paymentLink = payment.payMailUrl;
          } catch (error) {
            console.error('Errore Nexi noleggio:', error.message);
            internalExtra.paymentLink = `ERRORE NEXI: ${error.message}`;
          }
        }

        confirmationMessage = buildCustomerConfirmation(
          session.intent,
          profileName,
          internalExtra
        );
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
      resetSession(incomingFrom);

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    resetSession(incomingFrom);
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

app.get('/', (req, res) => {
  res.send('Server WhatsApp DP attivo ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
