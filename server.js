function detectIntent(message) {

  if (
    message.includes("bisarca") ||
    message.includes("trasporto") ||
    message.includes("ritiro auto") ||
    message.includes("consegna")
  ) return "trasporto";

  if (
    message.includes("noleggio") ||
    message.includes("furgone") ||
    message.includes("auto a noleggio") ||
    message.includes("affitto") ||
    message.includes("mezzo")
  ) return "noleggio";

  if (
    message.includes("officina") ||
    message.includes("tagliando") ||
    message.includes("meccanico") ||
    message.includes("riparazione")
  ) return "officina";

  if (
    message.includes("vendita") ||
    message.includes("vendere") ||
    message.includes("comprare")
  ) return "vendita";

  if (
    message.includes("titolare") ||
    message.includes("parlare") ||
    message.includes("richiamare")
  ) return "contatto";

  return "altro";
}
