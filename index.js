const express = require("express");
const axios = require("axios");

const app = express();

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "Orders";

const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || "NGN";

// ---------- Airtable ----------
const baseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
  AIRTABLE_TABLE_NAME
)}`;

const headers = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
};

// 🔍 Get order by order_id
async function getOrder(order_id) {
  const formula = `{order_id}="${order_id}"`;

  const url = `${baseUrl}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

  const res = await axios.get(url, { headers });

  const records = res.data.records;

  if (!records || records.length === 0) return null;

  return records[0].fields;
}

// ---------- ROUTES ----------

// Health check
app.get("/", (req, res) => {
  res.send("Server running ✅");
});

// 🔥 PAYMENT ROUTE
app.get("/pay", async (req, res) => {
  try {
    const { order_id } = req.query;

    // ❌ Missing param
    if (!order_id) {
      return res.status(400).send("Invalid payment link ❌");
    }

    // 🔍 Fetch from Airtable
    const order = await getOrder(order_id);

    // ❌ Not found
    if (!order) {
      return res.status(404).send("Invalid payment link ❌");
    }

    const { name, email, amount, description } = order;

    // ❌ Required fields check
    if (!name || !email || !amount) {
      return res.status(400).send("Order data incomplete ❌");
    }

    // 🔥 Create Flutterwave payment
    const response = await axios.post(
      "https://api.flutterwave.com/v3/payments",
      {
        tx_ref: order_id,
        amount: Number(amount),
        currency: DEFAULT_CURRENCY,
        redirect_url: "https://yourdomain.com/success",
        customer: {
          email: email,
          name: name,
        },
        customizations: {
          title: "Order Payment",
          description: description || "Order Payment",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${FLW_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const paymentLink = response.data?.data?.link;

    if (!paymentLink) {
      return res.status(500).send("Payment link error ❌");
    }

    // 🔥 Redirect to Flutterwave page
    return res.redirect(paymentLink);

  } catch (err) {
    console.error(err.response?.data || err.message);
    return res.status(500).send("Something went wrong ❌");
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
