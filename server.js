const intent = detectIntent(incomingText);

if (intent === 'officina') {
  twiml.message(startFlow(session, 'officina'));
} else if (intent === 'noleggio') {
  twiml.message(startFlow(session, 'noleggio'));
} else if (intent === 'vendita') {
  twiml.message(startFlow(session, 'vendita'));
} else if (intent === 'trasporto') {
  twiml.message(startFlow(session, 'trasporto'));
} else {
  twiml.message(
    "Scusami, non ho capito bene 😊\n\n" +
    "Scrivi uno di questi servizi:\n" +
    "🔧 Officina\n" +
    "🚐 Noleggio\n" +
    "🚗 Vendita\n" +
    "🚛 Trasporto\n\n" +
    "Oppure scrivi MENU per ricominciare."
  );
}
