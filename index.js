const express = require("express");
const axios = require("axios");

const app = express();

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "Orders";

// ---------- BASIC CHECK ----------
if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.log("❌ Missing Airtable ENV");
}

// ---------- HOME ----------
app.get("/", (req, res) => {
  res.send("Server running ✅");
});

// ---------- PAYMENT DISPLAY ROUTE ----------
app.get("/pay", async (req, res) => {
  try {
    const { order_id } = req.query;

    if (!order_id) {
      return res.status(400).send("<h2>Invalid payment link ❌</h2>");
    }

    // 🔥 Airtable query
    const formula = `{order_id}="${order_id}"`;

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
      AIRTABLE_TABLE_NAME
    )}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

    console.log("🔍 Airtable URL:", url);

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      },
    });

    const records = response.data.records;

    // ❌ not found
    if (!records || records.length === 0) {
      return res.status(404).send("<h2>Invalid payment link ❌</h2>");
    }

    const order = records[0].fields;

    console.log("✅ Order found:", order);

    const { name, email, phone, address, amount, description } = order;

    if (!name || !email || !amount) {
      return res.status(400).send("<h2>Order data incomplete ❌</h2>");
    }

    // ✅ Display HTML
    return res.send(`
      <html>
        <head>
          <title>Order Preview</title>
          <style>
            body {
              font-family: Arial;
              background: #f5f5f5;
              padding: 40px;
            }
            .card {
              background: white;
              padding: 25px;
              border-radius: 10px;
              max-width: 500px;
              margin: auto;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            h2 {
              margin-top: 0;
            }
            p {
              margin: 8px 0;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Order Details</h2>
            <p><b>Order ID:</b> ${order_id}</p>
            <p><b>Name:</b> ${name}</p>
            <p><b>Email:</b> ${email}</p>
            <p><b>Phone:</b> ${phone || "-"}</p>
            <p><b>Address:</b> ${address || "-"}</p>
            <p><b>Description:</b> ${description || "-"}</p>
            <p><b>Amount:</b> ₦${amount}</p>
          </div>
        </body>
      </html>
    `);

  } catch (err) {
    console.error("🔥 ERROR:", err.response?.data || err.message);

    return res.status(500).send(`
      <h2>Something went wrong ❌</h2>
      <pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>
    `);
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
