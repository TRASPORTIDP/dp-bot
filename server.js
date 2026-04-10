async function testCarRentalAPI() {
  try {
    const xml = `
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                      xmlns:ns1="http://www.opentravel.org/OTA/2003/05">
      <soapenv:Body>
        <ns1:OTA_PingRQ>
          <POS>
            <Source>
              <RequestorID Type="29" ID="${process.env.CARRENTAL_UID}" MessagePassword="${process.env.CARRENTAL_API_KEY}"/>
            </Source>
          </POS>
          <EchoData>TEST_DP</EchoData>
        </ns1:OTA_PingRQ>
      </soapenv:Body>
    </soapenv:Envelope>
    `;

    const res = await fetch(process.env.CARRENTAL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml"
      },
      body: xml
    });

    const text = await res.text();
    console.log("RISPOSTA API:", text);

  } catch (err) {
    console.error("ERRORE API:", err);
  }
}
