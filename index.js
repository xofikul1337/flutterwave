const express = require("express");
const axios = require("axios");

const app = express();

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "Orders";

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const APP_BASE_URL = process.env.APP_BASE_URL || "https://flutterwave-sbhw.onrender.com";
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || "NGN";

// ---------- HOME ----------
app.get("/", (req, res) => {
  res.send("Server running ✅");
});

// ---------- /pay ----------
app.get("/pay", async (req, res) => {
  try {
    const { order_id } = req.query;

    if (!order_id) {
      return res.status(400).send("<h2>Invalid payment link ❌</h2>");
    }

    // 🔍 Airtable query
    const formula = `{order_id}="${order_id}"`;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
      AIRTABLE_TABLE_NAME
    )}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

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

    // 🔥 Field mapping (DB অনুযায়ী)
    const name = order.CustomerName;
    const email = order.email;
    const amount = order.amount;
    const description = order.description || "Order Payment";

    // ❌ validation
    if (!name || !email || !amount) {
      return res.status(400).send("<h2>Order data incomplete ❌</h2>");
    }

    // 🔥 Flutterwave create payment
    const flwRes = await axios.post(
      "https://api.flutterwave.com/v3/payments",
      {
        tx_ref: order_id,
        amount: Number(amount),
        currency: DEFAULT_CURRENCY,
        redirect_url: `${APP_BASE_URL}/success`,
        customer: {
          email: email,
          name: name,
        },
        customizations: {
          title: "Order Payment",
          description: description,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${FLW_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const paymentLink = flwRes.data?.data?.link;

    if (!paymentLink) {
      return res.status(500).send("<h2>Payment link error ❌</h2>");
    }

    // 🔁 Redirect to Flutterwave hosted page
    return res.redirect(paymentLink);

  } catch (err) {
    console.error("ERROR:", err.response?.data || err.message);

    return res.status(500).send(`
      <h2>Something went wrong ❌</h2>
      <pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>
    `);
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
