const express = require("express");
const axios = require("axios");

const app = express();

// ENV
const PORT = process.env.PORT || 3000;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "Orders";

// Airtable base
const baseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
  AIRTABLE_TABLE_NAME
)}`;

const headers = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
};

// 🔎 get order by order_id
async function getOrder(order_id) {
  const formula = `{order_id}="${order_id}"`;
  const url = `${baseUrl}?filterByFormula=${encodeURIComponent(
    formula
  )}&maxRecords=1`;

  const res = await axios.get(url, { headers });
  const records = res.data.records || [];
  if (!records.length) return null;

  return records[0].fields;
}

// Home
app.get("/", (req, res) => {
  res.send("Server running ✅");
});

// 🧪 DISPLAY ROUTE (no payment yet)
app.get("/pay", async (req, res) => {
  try {
    const { order_id } = req.query;

    // ❌ missing
    if (!order_id) {
      return res.status(400).send("<h2>Invalid payment link ❌</h2>");
    }

    const order = await getOrder(order_id);

    // ❌ not found
    if (!order) {
      return res.status(404).send("<h2>Invalid payment link ❌</h2>");
    }

    const { name, email, phone, address, amount, description } = order;

    // ❌ incomplete
    if (!name || !email || !amount) {
      return res.status(400).send("<h2>Order data incomplete ❌</h2>");
    }

    // ✅ show simple page
    return res.send(`
      <html>
        <head>
          <title>Order Preview</title>
          <style>
            body { font-family: Arial; padding: 30px; background:#f6f6f6;}
            .card { background:#fff; padding:20px; border-radius:10px; max-width:500px; margin:auto; box-shadow:0 2px 8px rgba(0,0,0,0.1);}
            h2 { margin-top:0; }
            p { margin:8px 0; }
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
    console.error(err.response?.data || err.message);
    return res.status(500).send("<h2>Something went wrong ❌</h2>");
  }
});

// start
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
